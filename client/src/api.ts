import type { SessionInfo } from "./types";

const API_BASE = "http://localhost:3847";

export async function fetchSessions(): Promise<SessionInfo[]> {
  const res = await fetch(`${API_BASE}/api/sessions`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.sessions;
}

export async function connectSession(sessionId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.connectionId;
}

export async function sendMessage(
  sessionId: string,
  content: string,
  connectionId: string
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, connectionId }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Send failed: ${res.status}`);
  }
}

export async function sendControl(
  sessionId: string,
  controlType: string,
  connectionId: string
): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${sessionId}/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: controlType, connectionId }),
  });
}

export async function disconnectSession(connectionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/connections/${connectionId}`, { method: "DELETE" }).catch(() => {});
}

export function subscribeToEvents(
  sessionId: string,
  connectionId: string
): EventSource {
  return new EventSource(
    `${API_BASE}/api/sessions/${sessionId}/events?connectionId=${connectionId}`
  );
}
