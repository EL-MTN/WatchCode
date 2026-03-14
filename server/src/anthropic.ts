import WebSocket from "ws";
import type { WatchEvent } from "./types.js";

const API_BASE = "https://api.anthropic.com";
const HEADERS = {
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "ccr-byoc-2025-07-29",
};

export interface SessionInfo {
  id: string;
  title: string;
  status: string;
  model: string;
  environmentId: string;
  createdAt: string;
  updatedAt: string;
}

export async function listSessions(
  token: string,
  orgUuid: string
): Promise<SessionInfo[]> {
  const params = new URLSearchParams();
  if (orgUuid) params.set("organization_uuid", orgUuid);

  const url = `${API_BASE}/v1/sessions${params.toString() ? `?${params}` : ""}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...HEADERS,
      ...(orgUuid ? { "x-organization-uuid": orgUuid } : {}),
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to list sessions: ${res.status}`);
  }

  const data = await res.json();
  const sessions: SessionInfo[] = (data.data || []).map((s: any) => ({
    id: s.id,
    title: s.title || "Untitled",
    status: s.session_status,
    model: s.session_context?.model || "unknown",
    environmentId: s.environment_id || "",
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  }));

  // Sort: running first, then idle, then archived. Within each group, most recent first.
  const priority: Record<string, number> = { running: 0, active: 0, idle: 1, archived: 2 };
  sessions.sort((a, b) => {
    const pa = priority[a.status] ?? 2;
    const pb = priority[b.status] ?? 2;
    if (pa !== pb) return pa - pb;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return sessions;
}

export function connectToSession(
  sessionId: string,
  token: string,
  orgUuid: string,
  onEvent: (event: WatchEvent) => void,
  onClose: () => void
): WebSocket {
  const params = orgUuid ? `?organization_uuid=${orgUuid}` : "";
  const url = `wss://api.anthropic.com/v1/sessions/ws/${sessionId}/subscribe${params}`;

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...HEADERS,
    },
  });

  ws.on("open", () => {
    onEvent({
      type: "status",
      content: "Connected to Remote Control session",
      timestamp: new Date().toISOString(),
    });
  });

  ws.on("message", (data) => {
    try {
      const raw = JSON.parse(data.toString());
      const events = transformEvent(raw);
      for (const event of events) {
        onEvent(event);
      }
    } catch {
      onEvent({
        type: "raw",
        content: data.toString().slice(0, 500),
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

  ws.on("close", (code, reason) => {
    onEvent({
      type: "status",
      content: `Disconnected (code: ${code})`,
      detail: reason.toString() || undefined,
      timestamp: new Date().toISOString(),
    });
    onClose();
  });

  return ws;
}

export async function sendMessage(
  sessionId: string,
  content: string,
  token: string,
  orgUuid: string
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${API_BASE}/v1/sessions/${sessionId}/events`;
  const eventId = crypto.randomUUID();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...HEADERS,
      ...(orgUuid ? { "x-organization-uuid": orgUuid } : {}),
    },
    body: JSON.stringify({
      events: [
        {
          uuid: eventId,
          session_id: sessionId,
          type: "user",
          parent_tool_use_id: null,
          message: { role: "user", content },
        },
      ],
    }),
  });

  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

export async function sendControl(
  sessionId: string,
  controlType: string,
  token: string,
  orgUuid: string
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${API_BASE}/v1/sessions/${sessionId}/events`;
  const eventId = crypto.randomUUID();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...HEADERS,
      ...(orgUuid ? { "x-organization-uuid": orgUuid } : {}),
    },
    body: JSON.stringify({
      events: [
        {
          uuid: eventId,
          session_id: sessionId,
          type: "control",
          data: { type: controlType },
        },
      ],
    }),
  });

  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

export async function fetchSessionEvents(
  sessionId: string,
  token: string,
  orgUuid: string
): Promise<WatchEvent[]> {
  const url = `${API_BASE}/v1/sessions/${sessionId}/events`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...HEADERS,
      ...(orgUuid ? { "x-organization-uuid": orgUuid } : {}),
    },
  });

  if (!res.ok) return [];

  const data = await res.json();
  const rawEvents = Array.isArray(data) ? data : data.data || [];
  const events: WatchEvent[] = [];
  for (const raw of rawEvents) {
    events.push(...transformEvent(raw));
  }
  return events;
}

// ─── Helpers for watch-friendly summaries ───────────────────────────

/** Strip markdown syntax to plain text */
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

/** Human-readable summary of tool input */
function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  switch (name) {
    case "Bash":
      return input.command ? `$ ${input.command}`.slice(0, 200) : "";
    case "Read":
      return input.file_path || "";
    case "Write":
      return input.file_path || "";
    case "Edit":
    case "MultiEdit":
      return input.file_path || "";
    case "Glob":
      return input.pattern ? `Pattern: ${input.pattern}` : "";
    case "Grep":
      return input.pattern ? `Search: ${input.pattern}` : "";
    case "WebFetch":
    case "WebSearch":
      return input.url || input.query || "";
    case "Agent":
    case "Subagent":
      return input.prompt?.slice(0, 200) || input.description || "";
    default: {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(input)) {
        if (typeof v === "string" && v.length < 150) parts.push(`${k}: ${v}`);
      }
      return parts.join(", ").slice(0, 200) || JSON.stringify(input).slice(0, 150);
    }
  }
}

/** Short summary of tool result content */
function summarizeResult(content: string): string {
  if (!content || content.length === 0) return "Done";
  if (content.length < 120) return content;
  // Line-numbered file output
  if (/^\s*\d+→/.test(content)) {
    const lineCount = content.split("\n").filter((l) => /^\s*\d+→/.test(l)).length;
    return `${lineCount} lines`;
  }
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length > 3) return `${lines.length} lines of output`;
  return content.slice(0, 120) + "…";
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "…";
}

// ─── Event transformation ───────────────────────────────────────────

function extractTextFromContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
  }
  return JSON.stringify(content || "");
}

function transformEvent(raw: any): WatchEvent[] {
  const ts = raw.created_at || new Date().toISOString();
  const events: WatchEvent[] = [];
  const items = Array.isArray(raw) ? raw : [raw];

  for (const item of items) {
    const type = item.type;

    if (type === "user" || type === "human") {
      if (typeof item.message?.content === "string") {
        events.push({
          type: "user",
          content: item.message.content,
          timestamp: ts,
        });
      } else if (Array.isArray(item.message?.content)) {
        const textParts: string[] = [];
        for (const block of item.message.content) {
          if (block.type === "text" && block.text) {
            textParts.push(block.text);
          } else if (block.type === "tool_result") {
            const resultText = extractTextFromContent(block.content);
            events.push({
              type: "tool_result",
              content: resultText,
              summary: summarizeResult(resultText),
              timestamp: ts,
            });
          }
        }
        if (textParts.length > 0) {
          events.push({ type: "user", content: textParts.join(""), timestamp: ts });
        }
      }
    } else if (type === "assistant") {
      const blocks = item.message?.content || item.content || [];
      for (const block of Array.isArray(blocks) ? blocks : [blocks]) {
        if (block.type === "text" && block.text) {
          events.push({
            type: "assistant",
            content: block.text,
            summary: truncate(stripMarkdown(block.text), 300),
            timestamp: ts,
          });
        } else if (block.type === "tool_use") {
          const toolName = block.name || "unknown tool";
          events.push({
            type: "tool_use",
            content: toolName,
            detail: summarizeToolInput(toolName, block.input),
            timestamp: ts,
          });
        }
      }
    } else if (type === "tool_use") {
      const toolName = item.name || "unknown tool";
      events.push({
        type: "tool_use",
        content: toolName,
        detail: summarizeToolInput(toolName, item.input),
        timestamp: ts,
      });
    } else if (type === "tool_result") {
      const resultText =
        typeof item.content === "string"
          ? item.content
          : extractTextFromContent(item.content);
      events.push({
        type: "tool_result",
        content: resultText,
        summary: summarizeResult(resultText),
        timestamp: ts,
      });
    } else if (type === "error") {
      events.push({
        type: "error",
        content: item.message || item.error || JSON.stringify(item),
        timestamp: ts,
      });
    } else {
      events.push({
        type: "raw",
        content: JSON.stringify(item),
        timestamp: ts,
      });
    }
  }

  return events;
}
