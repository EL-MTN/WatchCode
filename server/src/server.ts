import express from "express";
import { execSync } from "child_process";
import type { Response } from "express";
import type { Connection } from "./types.js";
import { connectToSession, sendMessage, sendControl, listSessions, fetchSessionEvents } from "./anthropic.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3847");
const WATCHCODE_SECRET = process.env.WATCHCODE_SECRET || "";

app.use(express.json());
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-organization-uuid, x-watchcode-secret");
  if (_req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// --- Auth middleware ---
app.use("/api", (req, res, next) => {
  if (!WATCHCODE_SECRET) return next(); // no secret configured = open (local dev)
  if (req.headers["x-watchcode-secret"] === WATCHCODE_SECRET) return next();
  res.status(401).json({ error: "Unauthorized" });
});

// --- In-memory connection store ---
const connections = new Map<string, Connection>();

// --- Credentials: env vars (production) or Keychain (local dev) ---
let localToken: string | null = process.env.ANTHROPIC_TOKEN || null;
let localOrgUuid: string | null = process.env.ANTHROPIC_ORG_UUID || null;

function loadLocalCredentials() {
  // If env vars are set, skip Keychain entirely
  if (localToken) {
    console.log("[auth] Token loaded from ANTHROPIC_TOKEN env var");
    if (localOrgUuid) console.log(`[auth] Org UUID from env: ${localOrgUuid}`);
    return;
  }

  // Fall back to macOS Keychain for local dev
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: "utf-8" }
    ).trim();
    const creds = JSON.parse(raw);
    localToken = creds.claudeAiOauth?.accessToken || null;
    if (localToken) console.log("[auth] OAuth token loaded from Keychain");
  } catch {
    console.log("[auth] Could not read Keychain — use Authorization header or set ANTHROPIC_TOKEN");
  }

  try {
    const status = JSON.parse(
      execSync("claude auth status 2>/dev/null", { encoding: "utf-8" }).trim()
    );
    localOrgUuid = status.orgId || null;
    if (localOrgUuid) console.log(`[auth] Org UUID: ${localOrgUuid}`);
  } catch {
    // Not critical
  }
}

function getToken(req: express.Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return localToken;
}

function getOrgUuid(req: express.Request): string {
  return (req.headers["x-organization-uuid"] as string) || localOrgUuid || "";
}

// --- Routes ---

// List available sessions
app.get("/api/sessions", async (req, res) => {
  const token = getToken(req);
  const orgUuid = getOrgUuid(req);

  if (!token) {
    res.status(401).json({ error: "No OAuth token available" });
    return;
  }

  try {
    const sessions = await listSessions(token, orgUuid);
    res.json({ sessions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Connect to a Remote Control session
app.post("/api/connect", async (req, res) => {
  const { sessionId } = req.body;
  const token = getToken(req);
  const orgUuid = getOrgUuid(req);

  if (!sessionId) {
    res.status(400).json({ error: "sessionId required" });
    return;
  }
  if (!token) {
    res.status(401).json({ error: "No OAuth token available" });
    return;
  }

  // Close any existing connections to this session so we get a fresh history replay
  for (const [id, existing] of connections) {
    if (existing.sessionId === sessionId) {
      existing.ws.close();
      for (const client of existing.sseClients) client.end();
      connections.delete(id);
      console.log(`[ws] Closed stale connection ${id.slice(0, 8)} for reconnect`);
    }
  }

  const connectionId = crypto.randomUUID();

  const conn: Connection = {
    id: connectionId,
    sessionId,
    ws: null as any,
    token,
    orgUuid,
    sseClients: new Set(),
    lastEvent: Date.now(),
    eventBuffer: [],
  };

  const ws = connectToSession(
    sessionId,
    token,
    orgUuid,
    (event) => {
      conn.lastEvent = Date.now();
      const data = `data: ${JSON.stringify(event)}\n\n`;
      if (conn.sseClients.size === 0) {
        // Buffer events until first SSE client connects
        conn.eventBuffer.push(data);
      } else {
        for (const client of conn.sseClients) {
          client.write(data);
        }
      }
    },
    () => {
      // On close, notify SSE clients and clean up
      for (const client of conn.sseClients) {
        client.write(`data: ${JSON.stringify({ type: "status", content: "Session disconnected", timestamp: new Date().toISOString() })}\n\n`);
        client.end();
      }
      connections.delete(connectionId);
      console.log(`[ws] Connection ${connectionId.slice(0, 8)} closed`);
    }
  );

  conn.ws = ws;

  // Fetch history via REST API and prepend to buffer (before any live WS events)
  try {
    const history = await fetchSessionEvents(sessionId, token, orgUuid);
    if (history.length > 0) {
      const historyData = history.map((e) => `data: ${JSON.stringify(e)}\n\n`);
      conn.eventBuffer = [...historyData, ...conn.eventBuffer];
      console.log(`[history] Fetched ${history.length} events for session ${sessionId}`);
    }
  } catch (err: any) {
    console.log(`[history] Failed to fetch: ${err.message}`);
  }

  connections.set(connectionId, conn);
  console.log(`[ws] Connection ${connectionId.slice(0, 8)} opened for session ${sessionId}`);

  res.json({ connectionId, status: "connected" });
});

// SSE event stream
app.get("/api/sessions/:sessionId/events", (req, res) => {
  const { sessionId } = req.params;
  const connectionId = req.query.connectionId as string;

  const conn = connectionId
    ? connections.get(connectionId)
    : [...connections.values()].find((c) => c.sessionId === sessionId);

  if (!conn) {
    res.status(404).json({ error: "No active connection for this session. POST /api/connect first." });
    return;
  }

  // Set up SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  res.write(`data: ${JSON.stringify({ type: "status", content: "SSE stream opened", timestamp: new Date().toISOString() })}\n\n`);

  conn.sseClients.add(res);

  // Flush any buffered events (history that arrived before SSE client connected)
  if (conn.eventBuffer.length > 0) {
    for (const data of conn.eventBuffer) {
      res.write(data);
    }
    console.log(`[sse] Flushed ${conn.eventBuffer.length} buffered events`);
    conn.eventBuffer = [];
  }

  console.log(`[sse] Client connected (${conn.sseClients.size} total)`);

  req.on("close", () => {
    conn.sseClients.delete(res);
    console.log(`[sse] Client disconnected (${conn.sseClients.size} remaining)`);
  });
});

// Send a message to the session
app.post("/api/sessions/:sessionId/message", async (req, res) => {
  const { sessionId } = req.params;
  const { content, connectionId } = req.body;

  if (!content) {
    res.status(400).json({ error: "content required" });
    return;
  }

  const conn = connectionId
    ? connections.get(connectionId)
    : [...connections.values()].find((c) => c.sessionId === sessionId);

  if (!conn) {
    res.status(404).json({ error: "No active connection for this session" });
    return;
  }

  try {
    const result = await sendMessage(sessionId, content, conn.token, conn.orgUuid);
    if (result.ok) {
      res.json({ status: "sent" });
    } else {
      res.status(result.status).json({ error: result.body });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Send a control command (interrupt, etc.)
app.post("/api/sessions/:sessionId/control", async (req, res) => {
  const { sessionId } = req.params;
  const { type: controlType, connectionId } = req.body;

  const conn = connectionId
    ? connections.get(connectionId)
    : [...connections.values()].find((c) => c.sessionId === sessionId);

  if (!conn) {
    res.status(404).json({ error: "No active connection for this session" });
    return;
  }

  try {
    const result = await sendControl(sessionId, controlType, conn.token, conn.orgUuid);
    if (result.ok) {
      res.json({ status: "sent" });
    } else {
      res.status(result.status).json({ error: result.body });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect
app.delete("/api/connections/:connectionId", (req, res) => {
  const conn = connections.get(req.params.connectionId);
  if (!conn) {
    res.status(404).json({ error: "Connection not found" });
    return;
  }

  conn.ws.close();
  for (const client of conn.sseClients) client.end();
  connections.delete(req.params.connectionId);

  res.json({ status: "disconnected" });
});

// Status
app.get("/api/status", (_req, res) => {
  const active = [...connections.values()].map((c) => ({
    connectionId: c.id,
    sessionId: c.sessionId,
    sseClients: c.sseClients.size,
    wsState: c.ws.readyState,
    lastEvent: new Date(c.lastEvent).toISOString(),
  }));
  res.json({ connections: active });
});

// --- Start ---
loadLocalCredentials();
app.listen(PORT, () => {
  console.log(`\n[relay] WatchCode relay server running on http://localhost:${PORT}\n`);
});
