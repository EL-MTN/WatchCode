import { useEffect, useRef } from "react";
import type { WatchEvent } from "../types";

interface Props {
  events: WatchEvent[];
  provider?: string;
}

export function EventFeed({ events, provider }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  const assistantLabel = provider === "codex" ? "CODEX" : "CLAUDE";

  const labels: Record<string, string> = {
    user: "YOU",
    assistant: assistantLabel,
    tool_use: "TOOL",
    tool_result: "RESULT",
    status: "STATUS",
    error: "ERROR",
    raw: "RAW",
  };

  if (events.length === 0) {
    return (
      <div className="empty-state">
        <p>
          Select a session above or start a coding agent.
        </p>
      </div>
    );
  }

  return (
    <div className="events">
      {events.map((event, i) => (
        <div key={i} className={`event ${event.type}`}>
          <span className="time">
            {new Date(event.timestamp).toLocaleTimeString()}
          </span>
          <span className="label">{labels[event.type] || event.type}</span>
          {event.content}
          {event.detail && <span className="detail">{event.detail}</span>}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
