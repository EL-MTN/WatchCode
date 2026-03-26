import type { WatchEvent } from "./types.js";

export type ProviderName = "anthropic" | "codex";

export interface SessionInfo {
  id: string;
  title: string;
  status: string;
  model: string;
  environmentId: string;
  createdAt: string;
  updatedAt: string;
  provider: ProviderName;
}

export interface ProviderConnection {
  handle: any;
  get readyState(): number;
}

export interface ApiResult {
  ok: boolean;
  status: number;
  body: string;
}

export interface Provider {
  readonly name: ProviderName;

  listSessions(): Promise<SessionInfo[]>;

  connectToSession(
    sessionId: string,
    onEvent: (event: WatchEvent) => void,
    onClose: () => void
  ): ProviderConnection;

  sendMessage(
    sessionId: string,
    content: string,
    conn: ProviderConnection
  ): Promise<ApiResult>;

  sendControl(
    sessionId: string,
    controlType: string,
    conn: ProviderConnection
  ): Promise<ApiResult>;

  fetchSessionEvents(sessionId: string): Promise<WatchEvent[]>;

  disconnect(conn: ProviderConnection): void;
}
