import type { Response } from "express";
import type { ProviderName, ProviderConnection } from "./provider.js";

export interface Connection {
  id: string;
  sessionId: string;
  provider: ProviderName;
  providerConn: ProviderConnection;
  sseClients: Set<Response>;
  lastEvent: number;
  eventBuffer: string[];
}

export interface WatchEvent {
  type: "user" | "assistant" | "tool_use" | "tool_result" | "status" | "error" | "raw";
  content: string;
  summary?: string;
  detail?: string;
  timestamp: string;
}

export interface SendMessageBody {
  content: string;
  connectionId: string;
}

export interface ConnectBody {
  sessionId: string;
  provider?: ProviderName;
}
