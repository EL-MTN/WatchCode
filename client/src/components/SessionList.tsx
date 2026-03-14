import { useEffect, useState } from "react";
import type { SessionInfo } from "../types";
import { fetchSessions } from "../api";

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
}

function badgeClass(status: string): string {
  if (status === "running" || status === "active") return "running";
  return status;
}

interface Props {
  onSelect: (sessionId: string) => void;
}

export function SessionList({ onSelect }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setSessions(await fetchSessions());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const live = sessions.filter(
    (s) => s.status === "running" || s.status === "active" || s.status === "idle"
  );
  const archived = sessions.filter((s) => s.status === "archived");

  return (
    <>
      <div className="session-list-header">
        <span>Sessions</span>
        <button onClick={load}>Refresh</button>
      </div>
      <div className="session-list">
        {loading && (
          <div style={{ color: "#555", fontSize: 12, padding: 4 }}>Loading sessions...</div>
        )}
        {error && (
          <div style={{ color: "#f87171", fontSize: 12, padding: 4 }}>Failed to load: {error}</div>
        )}
        {!loading && !error && sessions.length === 0 && (
          <div style={{ color: "#555", fontSize: 12, padding: 4 }}>
            No sessions found. Run /rc in Claude Code.
          </div>
        )}

        {live.length > 0 && (
          <>
            <div className="session-divider">Live ({live.length})</div>
            {live.map((s) => (
              <SessionCard key={s.id} session={s} onSelect={onSelect} />
            ))}
          </>
        )}

        {archived.length > 0 && (
          <>
            <div className="session-divider">Recent ({archived.length})</div>
            {archived.slice(0, 10).map((s) => (
              <SessionCard key={s.id} session={s} onSelect={onSelect} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

function SessionCard({
  session: s,
  onSelect,
}: {
  session: SessionInfo;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="session-card" onClick={() => onSelect(s.id)}>
      <div className="title">
        {s.title}
        <span className={`badge ${badgeClass(s.status)}`}>{s.status.toUpperCase()}</span>
      </div>
      <div className="meta">
        <span className="model">{s.model}</span>
        <br />
        {timeAgo(s.updatedAt)}
      </div>
    </div>
  );
}
