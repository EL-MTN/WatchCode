import { useState, useCallback, useRef } from "react";
import type { WatchEvent } from "./types";
import {
  connectSession,
  sendMessage,
  sendControl,
  disconnectSession,
  subscribeToEvents,
} from "./api";
import { SessionList } from "./components/SessionList";
import { EventFeed } from "./components/EventFeed";
import { MessageInput } from "./components/MessageInput";
import "./styles.css";

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export function App() {
  const [sessionId, setSessionId] = useState("");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [state, setState] = useState<ConnectionState>("disconnected");
  const [events, setEvents] = useState<WatchEvent[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [provider, setProvider] = useState<string | undefined>();
  const eventSourceRef = useRef<EventSource | null>(null);

  const addEvent = useCallback((event: WatchEvent) => {
    setEvents((prev) => [...prev, event]);
  }, []);

  const connect = useCallback(
    async (id?: string, prov?: string) => {
      const sid = id || inputValue.trim();
      if (!sid) return;

      // Extract session ID from URL if pasted
      const parsed = sid.includes("claude.ai/code/")
        ? sid.split("claude.ai/code/")[1].split("?")[0]
        : sid;

      setSessionId(parsed);
      setProvider(prov);
      setState("connecting");

      try {
        const connId = await connectSession(parsed, prov);
        setConnectionId(connId);

        const es = subscribeToEvents(parsed, connId);
        eventSourceRef.current = es;

        es.onmessage = (e) => {
          const event: WatchEvent = JSON.parse(e.data);
          addEvent(event);
        };
        es.onerror = () => setState("error");

        setState("connected");
        window.location.hash = parsed;
      } catch (err: any) {
        setState("error");
        addEvent({
          type: "error",
          content: err.message,
          timestamp: new Date().toISOString(),
        });
      }
    },
    [inputValue, addEvent]
  );

  const disconnect = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (connectionId) disconnectSession(connectionId);
    setConnectionId(null);
    setProvider(undefined);
    setState("disconnected");
  }, [connectionId]);

  const handleSend = useCallback(
    async (content: string) => {
      if (!sessionId || !connectionId) return;
      addEvent({ type: "user", content, timestamp: new Date().toISOString() });
      try {
        await sendMessage(sessionId, content, connectionId);
      } catch (err: any) {
        addEvent({
          type: "error",
          content: `Send failed: ${err.message}`,
          timestamp: new Date().toISOString(),
        });
      }
    },
    [sessionId, connectionId, addEvent]
  );

  const handleInterrupt = useCallback(async () => {
    if (!sessionId || !connectionId) return;
    await sendControl(sessionId, "interrupt", connectionId);
  }, [sessionId, connectionId]);

  const connected = state === "connected";

  return (
    <>
      <header>
        <div
          className={`status-dot ${state === "connected" ? "connected" : state === "error" ? "error" : ""}`}
        />
        <h1>WatchCode Relay</h1>
        <span className="status-text">
          {state === "connected"
            ? `Connected: ${sessionId}`
            : state === "connecting"
              ? "Connecting..."
              : state === "error"
                ? "Connection error"
                : "Disconnected"}
        </span>
      </header>

      <div className="connect-bar">
        <input
          type="text"
          placeholder="Session ID or paste URL..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (connected ? disconnect() : connect())}
          disabled={connected}
        />
        {connected ? (
          <button className="danger" onClick={disconnect}>
            Disconnect
          </button>
        ) : (
          <button
            className="primary"
            onClick={() => connect()}
            disabled={state === "connecting"}
          >
            {state === "connecting" ? "Connecting..." : "Connect"}
          </button>
        )}
      </div>

      {!connected && <SessionList onSelect={(id, prov) => connect(id, prov)} />}

      <EventFeed events={events} provider={provider} />

      <MessageInput
        disabled={!connected}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        showInterrupt={connected}
      />
    </>
  );
}
