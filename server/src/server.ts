import express from "express";
import { execSync } from "child_process";
import type { Connection } from "./types.js";
import type { Provider, ProviderName } from "./provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { CodexProvider } from "./codex.js";

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

// --- Provider registry ---
const providers = new Map<ProviderName, Provider>();

function initProviders() {
  // Anthropic provider
  const anthropicToken = loadAnthropicToken();
  const anthropicOrgUuid = loadAnthropicOrgUuid();
  if (anthropicToken) {
    providers.set("anthropic", new AnthropicProvider(anthropicToken, anthropicOrgUuid));
    console.log("[providers] Anthropic provider initialized");
  } else {
    console.log("[providers] Anthropic provider disabled (no token)");
  }

  // Codex provider
  const codexUrl = process.env.CODEX_APP_SERVER_URL;
  if (codexUrl) {
    providers.set("codex", new CodexProvider(codexUrl));
    console.log(`[providers] Codex provider initialized (${codexUrl})`);
  } else {
    console.log("[providers] Codex provider disabled (CODEX_APP_SERVER_URL not set)");
  }
}

// --- Anthropic credential loading ---

function loadAnthropicToken(): string | null {
  const envToken = process.env.ANTHROPIC_TOKEN;
  if (envToken) {
    console.log("[auth] Token loaded from ANTHROPIC_TOKEN env var");
    return envToken;
  }

  // Fall back to macOS Keychain for local dev
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: "utf-8" }
    ).trim();
    const creds = JSON.parse(raw);
    const token = creds.claudeAiOauth?.accessToken || null;
    if (token) console.log("[auth] OAuth token loaded from Keychain");
    return token;
  } catch {
    console.log("[auth] Could not read Keychain — set ANTHROPIC_TOKEN to enable Anthropic provider");
    return null;
  }
}

function loadAnthropicOrgUuid(): string {
  const envUuid = process.env.ANTHROPIC_ORG_UUID;
  if (envUuid) {
    console.log(`[auth] Org UUID from env: ${envUuid}`);
    return envUuid;
  }

  try {
    const status = JSON.parse(
      execSync("claude auth status 2>/dev/null", { encoding: "utf-8" }).trim()
    );
    const orgId = status.orgId || "";
    if (orgId) console.log(`[auth] Org UUID: ${orgId}`);
    return orgId;
  } catch {
    return "";
  }
}

// --- Routes ---

// List available sessions (from all providers)
app.get("/api/sessions", async (_req, res) => {
  if (providers.size === 0) {
    res.status(503).json({ error: "No providers configured" });
    return;
  }

  try {
    const allSessions = await Promise.all(
      [...providers.values()].map((p) => p.listSessions().catch(() => []))
    );
    const sessions = allSessions.flat();

    // Sort: running/active first, then idle, then archived
    const priority: Record<string, number> = { running: 0, active: 0, idle: 1, archived: 2 };
    sessions.sort((a, b) => {
      const pa = priority[a.status] ?? 2;
      const pb = priority[b.status] ?? 2;
      if (pa !== pb) return pa - pb;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    res.json({ sessions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Connect to a session
app.post("/api/connect", async (req, res) => {
  const { sessionId, provider: providerName } = req.body;

  if (!sessionId) {
    res.status(400).json({ error: "sessionId required" });
    return;
  }

  const provider = providerName
    ? providers.get(providerName)
    : providers.values().next().value;

  if (!provider) {
    res.status(400).json({ error: providerName ? `Provider "${providerName}" not available` : "No providers configured" });
    return;
  }

  // Close any existing connections to this session so we get a fresh history replay
  for (const [id, existing] of connections) {
    if (existing.sessionId === sessionId) {
      const existingProvider = providers.get(existing.provider);
      existingProvider?.disconnect(existing.providerConn);
      for (const client of existing.sseClients) client.end();
      connections.delete(id);
      console.log(`[ws] Closed stale connection ${id.slice(0, 8)} for reconnect`);
    }
  }

  const connectionId = crypto.randomUUID();

  const conn: Connection = {
    id: connectionId,
    sessionId,
    provider: provider.name,
    providerConn: null as any,
    sseClients: new Set(),
    lastEvent: Date.now(),
    eventBuffer: [],
  };

  const providerConn = provider.connectToSession(
    sessionId,
    (event) => {
      conn.lastEvent = Date.now();
      const data = `data: ${JSON.stringify(event)}\n\n`;
      if (conn.sseClients.size === 0) {
        conn.eventBuffer.push(data);
      } else {
        for (const client of conn.sseClients) {
          client.write(data);
        }
      }
    },
    () => {
      for (const client of conn.sseClients) {
        client.write(`data: ${JSON.stringify({ type: "status", content: "Session disconnected", timestamp: new Date().toISOString() })}\n\n`);
        client.end();
      }
      connections.delete(connectionId);
      console.log(`[ws] Connection ${connectionId.slice(0, 8)} closed`);
    }
  );

  conn.providerConn = providerConn;

  // Fetch history and prepend to buffer (before any live events)
  try {
    const history = await provider.fetchSessionEvents(sessionId);
    if (history.length > 0) {
      const historyData = history.map((e) => `data: ${JSON.stringify(e)}\n\n`);
      conn.eventBuffer = [...historyData, ...conn.eventBuffer];
      console.log(`[history] Fetched ${history.length} events for session ${sessionId}`);
    }
  } catch (err: any) {
    console.log(`[history] Failed to fetch: ${err.message}`);
  }

  connections.set(connectionId, conn);
  console.log(`[ws] Connection ${connectionId.slice(0, 8)} opened for session ${sessionId} (${provider.name})`);

  res.json({ connectionId, status: "connected", provider: provider.name });
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

  // Flush any buffered events
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

  const provider = providers.get(conn.provider);
  if (!provider) {
    res.status(500).json({ error: `Provider "${conn.provider}" not available` });
    return;
  }

  try {
    const result = await provider.sendMessage(sessionId, content, conn.providerConn);
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

  const provider = providers.get(conn.provider);
  if (!provider) {
    res.status(500).json({ error: `Provider "${conn.provider}" not available` });
    return;
  }

  try {
    const result = await provider.sendControl(sessionId, controlType, conn.providerConn);
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

  const provider = providers.get(conn.provider);
  provider?.disconnect(conn.providerConn);
  for (const client of conn.sseClients) client.end();
  connections.delete(req.params.connectionId);

  res.json({ status: "disconnected" });
});

// Status
app.get("/api/status", (_req, res) => {
  const active = [...connections.values()].map((c) => ({
    connectionId: c.id,
    sessionId: c.sessionId,
    provider: c.provider,
    sseClients: c.sseClients.size,
    wsState: c.providerConn?.readyState ?? -1,
    lastEvent: new Date(c.lastEvent).toISOString(),
  }));
  res.json({
    providers: [...providers.keys()],
    connections: active,
  });
});

// --- Start ---
initProviders();
app.listen(PORT, () => {
  console.log(`\n[relay] WatchCode relay server running on http://localhost:${PORT}`);
  console.log(`[relay] Active providers: ${[...providers.keys()].join(", ") || "none"}\n`);
});
