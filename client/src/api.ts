import type { SessionInfo } from "./types";

const API_BASE = 'https://watchcode-production.up.railway.app';
const SECRET = import.meta.env.VITE_WATCHCODE_SECRET ?? '';

const authHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  ...(SECRET ? { 'x-watchcode-secret': SECRET } : {}),
};

export async function fetchSessions(): Promise<SessionInfo[]> {
  const res = await fetch(`${API_BASE}/api/sessions`, { headers: authHeaders });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.sessions;
}

export async function connectSession(sessionId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/connect`, {
    method: "POST",
    headers: authHeaders,
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
    headers: authHeaders,
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
    headers: authHeaders,
    body: JSON.stringify({ type: controlType, connectionId }),
  });
}

export async function disconnectSession(connectionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/connections/${connectionId}`, { method: "DELETE", headers: authHeaders }).catch(() => {});
}

export function subscribeToEvents(
  sessionId: string,
  connectionId: string
): EventSource {
  const params = new URLSearchParams({ connectionId });
  if (SECRET) params.set('secret', SECRET);
  return new EventSource(
    `${API_BASE}/api/sessions/${sessionId}/events?${params}`
  );
}
