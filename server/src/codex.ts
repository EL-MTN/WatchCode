import WebSocket from "ws";
import type { WatchEvent } from "./types.js";
import type { Provider, ProviderConnection, SessionInfo, ApiResult } from "./provider.js";

// ─── JSON-RPC 2.0 client ────────────────────────────────────────────

class JsonRpcClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();
  private notificationHandler: ((method: string, params: any) => void) | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if ("id" in msg && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        } else if ("method" in msg && !("id" in msg)) {
          // Notification (no id)
          this.notificationHandler?.(msg.method, msg.params);
        }
      } catch {
        // Ignore unparseable messages
      }
    });
  }

  async call(method: string, params?: any, timeoutMs = 10000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC call "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value: any) => { clearTimeout(timer); resolve(value); },
        reject: (err: Error) => { clearTimeout(timer); reject(err); },
      });

      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
    });
  }

  notify(method: string, params?: any): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }));
  }

  onNotification(handler: (method: string, params: any) => void): void {
    this.notificationHandler = handler;
  }
}

// ─── Provider Connection wrapper ─────────────────────────────────────

class CodexConnection implements ProviderConnection {
  constructor(public handle: WebSocket, public rpc: JsonRpcClient) {}
  get readyState(): number {
    return this.handle.readyState;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function openAndInit(url: string): Promise<{ ws: WebSocket; rpc: JsonRpcClient }> {
  return new Promise((resolve, reject) => {
    const ws = createCodexWebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Codex app-server connection timed out"));
    }, 10000);

    ws.on("open", async () => {
      clearTimeout(timeout);
      const rpc = new JsonRpcClient(ws);
      try {
        await rpc.call("initialize", {
          clientInfo: { name: "WatchCode", title: "WatchCode Relay", version: "1.0.0" },
          capabilities: {},
        });
        rpc.notify("initialized");
        resolve({ ws, rpc });
      } catch (err) {
        ws.close();
        reject(err);
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function createCodexWebSocket(url: string): WebSocket {
  const secret = process.env.WATCHCODE_SECRET || "";
  return new WebSocket(url, {
    headers: secret ? { "x-watchcode-secret": secret } : undefined,
  });
}

function stripMarkdown(text: string): string {
  return text
    .replace(/`{3}[\s\S]*?`{3}/g, "[code block]")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "…";
}

function summarizeResult(content: string): string {
  if (!content || content.length === 0) return "Done";
  if (content.length < 120) return content;
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length > 3) return `${lines.length} lines of output`;
  return content.slice(0, 120) + "…";
}

function summarizeCodexToolInput(name: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  switch (name) {
    case "shell":
    case "bash":
      return args.command ? `$ ${args.command}`.slice(0, 200) : "";
    case "write":
    case "create_file":
      return args.path || args.file_path || "";
    case "apply_diff":
    case "apply_patch":
      return args.path || args.file_path || "";
    case "read_file":
      return args.path || args.file_path || "";
    case "list_dir":
      return args.path || ".";
    default: {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === "string" && v.length < 150) parts.push(`${k}: ${v}`);
      }
      return parts.join(", ").slice(0, 200) || JSON.stringify(args).slice(0, 150);
    }
  }
}

// ─── Provider implementation ─────────────────────────────────────────

export class CodexProvider implements Provider {
  readonly name = "codex" as const;
  private appServerUrl: string;

  constructor(appServerUrl: string) {
    this.appServerUrl = appServerUrl;
  }

  async listSessions(): Promise<SessionInfo[]> {
    let ws: WebSocket | null = null;
    try {
      const { ws: conn, rpc } = await openAndInit(this.appServerUrl);
      ws = conn;

      // Fetch both stored threads and loaded (running) threads
      const [threadList, loadedList] = await Promise.all([
        rpc.call("thread/list", { limit: 50 }).catch(() => ({ threads: [] })),
        rpc.call("thread/loaded/list", {}).catch(() => ({ threads: [] })),
      ]);

      const loadedIds = new Set(
        (loadedList.threads || []).map((t: any) => t.id || t.threadId)
      );

      const sessions: SessionInfo[] = (threadList.threads || []).map((t: any) => {
        const threadId = t.id || t.threadId;
        const isLoaded = loadedIds.has(threadId);
        const threadStatus = t.status || "unknown";

        let status: string;
        if (isLoaded && (threadStatus === "active" || threadStatus === "running")) {
          status = "running";
        } else if (isLoaded) {
          status = "idle";
        } else {
          status = "archived";
        }

        return {
          id: threadId,
          title: t.title || t.name || "Untitled Thread",
          status,
          model: t.model || t.modelId || "codex",
          environmentId: t.workingDirectory || "",
          createdAt: t.createdAt || t.created_at || new Date().toISOString(),
          updatedAt: t.updatedAt || t.updated_at || t.createdAt || new Date().toISOString(),
          provider: "codex" as const,
        };
      });

      ws.close();
      return sessions;
    } catch (err: any) {
      ws?.close();
      console.log(`[codex] Failed to list sessions: ${err.message}`);
      return [];
    }
  }

  connectToSession(
    sessionId: string,
    onEvent: (event: WatchEvent) => void,
    onClose: () => void
  ): ProviderConnection {
    const ws = createCodexWebSocket(this.appServerUrl);
    const rpc = new JsonRpcClient(ws);

    // Track streaming deltas per item for accumulation
    const deltaBuffers = new Map<string, string>();

    rpc.onNotification((method, params) => {
      const ts = new Date().toISOString();
      const events = this.transformNotification(method, params, ts, deltaBuffers);
      for (const event of events) {
        onEvent(event);
      }
    });

    ws.on("open", async () => {
      try {
        await rpc.call("initialize", {
          clientInfo: { name: "WatchCode", title: "WatchCode Relay", version: "1.0.0" },
          capabilities: {},
        });
        rpc.notify("initialized");

        onEvent({
          type: "status",
          content: "Connected to Codex session",
          timestamp: new Date().toISOString(),
        });

        await rpc.call("thread/resume", { threadId: sessionId });
      } catch (err: any) {
        onEvent({
          type: "error",
          content: `Codex connection failed: ${err.message}`,
          timestamp: new Date().toISOString(),
        });
      }
    });

    ws.on("error", (err) => {
      onEvent({
        type: "error",
        content: err.message,
        timestamp: new Date().toISOString(),
      });
    });

    ws.on("close", (code) => {
      onEvent({
        type: "status",
        content: `Disconnected (code: ${code})`,
        timestamp: new Date().toISOString(),
      });
      onClose();
    });

    return new CodexConnection(ws, rpc);
  }

  async sendMessage(
    sessionId: string,
    content: string,
    conn: ProviderConnection
  ): Promise<ApiResult> {
    const codexConn = conn as CodexConnection;
    try {
      await codexConn.rpc.call("turn/start", { threadId: sessionId, prompt: content });
      return { ok: true, status: 200, body: "" };
    } catch (err: any) {
      return { ok: false, status: 500, body: err.message };
    }
  }

  async sendControl(
    sessionId: string,
    controlType: string,
    conn: ProviderConnection
  ): Promise<ApiResult> {
    const codexConn = conn as CodexConnection;
    try {
      if (controlType === "interrupt") {
        await codexConn.rpc.call("turn/interrupt", { threadId: sessionId });
      } else {
        // Pass through other control types
        await codexConn.rpc.call(controlType, { threadId: sessionId });
      }
      return { ok: true, status: 200, body: "" };
    } catch (err: any) {
      return { ok: false, status: 500, body: err.message };
    }
  }

  async fetchSessionEvents(sessionId: string): Promise<WatchEvent[]> {
    let ws: WebSocket | null = null;
    try {
      const { ws: conn, rpc } = await openAndInit(this.appServerUrl);
      ws = conn;

      const result = await rpc.call("thread/read", { threadId: sessionId });
      ws.close();

      const events: WatchEvent[] = [];
      const items = result?.items || result?.thread?.items || [];

      for (const item of items) {
        const ts = item.createdAt || item.created_at || new Date().toISOString();

        if (item.type === "message" && item.role === "user") {
          const text = typeof item.content === "string"
            ? item.content
            : item.content?.map?.((c: any) => c.text || "").join("") || "";
          if (text) {
            events.push({ type: "user", content: text, timestamp: ts });
          }
        } else if (item.type === "message" && item.role === "assistant") {
          const text = typeof item.content === "string"
            ? item.content
            : item.content?.map?.((c: any) => c.text || "").join("") || "";
          if (text) {
            events.push({
              type: "assistant",
              content: text,
              summary: truncate(stripMarkdown(text), 300),
              timestamp: ts,
            });
          }
        } else if (item.type === "function_call") {
          events.push({
            type: "tool_use",
            content: item.name || item.function?.name || "unknown tool",
            detail: summarizeCodexToolInput(
              item.name || item.function?.name || "",
              item.arguments || item.function?.arguments || {}
            ),
            timestamp: ts,
          });
        } else if (item.type === "function_call_output") {
          const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output || "");
          events.push({
            type: "tool_result",
            content: output,
            summary: summarizeResult(output),
            timestamp: ts,
          });
        }
      }

      return events;
    } catch (err: any) {
      ws?.close();
      console.log(`[codex] Failed to fetch session events: ${err.message}`);
      return [];
    }
  }

  disconnect(conn: ProviderConnection): void {
    (conn.handle as WebSocket).close();
  }

  // ─── Event transformation for live notifications ──────────────────

  private transformNotification(
    method: string,
    params: any,
    ts: string,
    deltaBuffers: Map<string, string>
  ): WatchEvent[] {
    switch (method) {
      case "item/agentMessage/delta": {
        // Accumulate streaming text deltas — emit on item/completed instead
        const itemId = params?.itemId || params?.id || "unknown";
        const delta = params?.delta || params?.text || "";
        const existing = deltaBuffers.get(itemId) || "";
        deltaBuffers.set(itemId, existing + delta);
        return [];
      }

      case "item/completed": {
        const item = params?.item || params;
        const itemType = item?.type;
        const itemId = item?.id || item?.itemId || "unknown";

        if (itemType === "message" && item?.role === "assistant") {
          // Use accumulated delta buffer if available, otherwise extract from item
          let text = deltaBuffers.get(itemId) || "";
          deltaBuffers.delete(itemId);

          if (!text) {
            text = typeof item.content === "string"
              ? item.content
              : item.content?.map?.((c: any) => c.text || "").join("") || "";
          }

          if (text) {
            return [{
              type: "assistant",
              content: text,
              summary: truncate(stripMarkdown(text), 300),
              timestamp: ts,
            }];
          }
          return [];
        }

        if (itemType === "function_call") {
          const name = item.name || item.function?.name || "unknown tool";
          let args = item.arguments || item.function?.arguments;
          if (typeof args === "string") {
            try { args = JSON.parse(args); } catch { /* keep as string */ }
          }
          return [{
            type: "tool_use",
            content: name,
            detail: summarizeCodexToolInput(name, args),
            timestamp: ts,
          }];
        }

        if (itemType === "function_call_output") {
          const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output || "");
          return [{
            type: "tool_result",
            content: output,
            summary: summarizeResult(output),
            timestamp: ts,
          }];
        }

        return [];
      }

      case "item/commandExecution/outputDelta": {
        const output = params?.delta || params?.output || params?.text || "";
        if (output) {
          return [{
            type: "tool_result",
            content: output,
            summary: summarizeResult(output),
            timestamp: ts,
          }];
        }
        return [];
      }

      case "item/fileChange/outputDelta": {
        const output = params?.delta || params?.output || params?.text || "";
        if (output) {
          return [{
            type: "tool_result",
            content: output,
            summary: summarizeResult(output),
            timestamp: ts,
          }];
        }
        return [];
      }

      case "turn/started":
        return [{ type: "status", content: "Turn started", timestamp: ts }];

      case "turn/completed":
        return [{ type: "status", content: "Turn completed", timestamp: ts }];

      case "thread/status/changed": {
        const newStatus = params?.status || params?.newStatus || "unknown";
        return [{ type: "status", content: `Status: ${newStatus}`, timestamp: ts }];
      }

      case "item/started":
        // Suppress noisy item start notifications
        return [];

      case "turn/diff/updated":
      case "turn/plan/updated":
      case "thread/tokenUsage/updated":
        // Suppress verbose metadata notifications
        return [];

      default:
        return [{
          type: "raw",
          content: JSON.stringify({ method, params }),
          timestamp: ts,
        }];
    }
  }
}
