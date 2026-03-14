import { useEffect, useRef } from "react";
import type { WatchEvent } from "../types";

const LABELS: Record<string, string> = {
  user: "YOU",
  assistant: "CLAUDE",
  tool_use: "TOOL",
  tool_result: "RESULT",
  status: "STATUS",
  error: "ERROR",
  raw: "RAW",
};

interface Props {
  events: WatchEvent[];
}

export function EventFeed({ events }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="empty-state">
        <p>
          Select a session above or run <code>/rc</code> in Claude Code.
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
          <span className="label">{LABELS[event.type] || event.type}</span>
          {event.content}
          {event.detail && <span className="detail">{event.detail}</span>}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
