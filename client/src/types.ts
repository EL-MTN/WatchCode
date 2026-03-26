export interface SessionInfo {
  id: string;
  title: string;
  status: string;
  model: string;
  environmentId: string;
  createdAt: string;
  updatedAt: string;
  provider?: "anthropic" | "codex";
}

export interface WatchEvent {
  type: "user" | "assistant" | "tool_use" | "tool_result" | "status" | "error" | "raw";
  content: string;
  detail?: string;
  timestamp: string;
}
