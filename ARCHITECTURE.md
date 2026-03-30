# WatchCode Architecture

## Overview

WatchCode connects an Apple Watch to a running Claude Code terminal session via the Remote Control protocol. Users speak into their Watch to send prompts and see live session activity — using their existing Claude subscription with zero additional API cost.

The system has two main components: a **Node.js relay server** that bridges Anthropic's WebSocket protocol to HTTP/SSE for watchOS compatibility, and a **SwiftUI Watch app** that handles voice input and event display. A **React web client** is included for testing and monitoring.

---

## System Architecture

```
┌──────────────────┐          ┌──────────────────────┐          ┌────────────────────┐          ┌───────────────┐
│   Claude Code    │───WS───> │   api.anthropic.com  │ <───WS───│   Relay Server     │ <──HTTP──│  Apple Watch  │
│   (user terminal)│          │   (Anthropic relay)   │          │   (Node.js, hosted)│───SSE──> │  (SwiftUI)    │
│                  │ <──WS─── │                       │ ───WS──> │                    │          │               │
└──────────────────┘          └──────────────────────┘          └────────────────────┘          └───────────────┘
```

---

## Component 1: Relay Server (Node.js)

### Purpose

Protocol bridge between Anthropic's WebSocket-based Remote Control API and the Apple Watch's HTTP/SSE capabilities. watchOS restricts WebSocket APIs to audio streaming apps, so the relay translates to standard HTTP which watchOS fully supports.

### Tech Stack

- **Runtime:** Node.js
- **Framework:** Express 5
- **WebSocket client:** `ws` package (connecting to Anthropic)
- **SSE:** Native HTTP response streaming
- **Hosting:** Any Node.js host (Railway, Fly.io, Render, VPS)

### Authentication

The relay server manages Anthropic OAuth credentials server-side. In production, set `ANTHROPIC_REFRESH_TOKEN` and the server will automatically refresh access tokens before they expire. Alternatively, `ANTHROPIC_TOKEN` can be set directly but expires in ~10 hours. For local development, the server falls back to reading credentials from the macOS Keychain. Clients authenticate to the relay using a shared secret (`x-watchcode-secret` header or `?secret=` query param for SSE).

### API Surface

**`GET /api/sessions`** — List available Remote Control sessions from Anthropic.

**`POST /api/connect`** — Connect to a session. Opens a WebSocket to Anthropic, fetches event history via REST, and returns a `connectionId`.
- Request body: `{ "sessionId": "<id>" }`
- Response: `{ "connectionId": "<uuid>", "status": "connected" }`

**`GET /api/sessions/:sessionId/events`** — SSE stream of session events. Flushes buffered history, then streams live events.
- Query params: `connectionId=<uuid>`
- Response: `text/event-stream`

**`POST /api/sessions/:sessionId/message`** — Send a user message to the session.
- Request body: `{ "content": "<text>", "connectionId": "<uuid>" }`

**`POST /api/sessions/:sessionId/control`** — Send control commands (interrupt, etc.).
- Request body: `{ "type": "interrupt", "connectionId": "<uuid>" }`

**`DELETE /api/connections/:connectionId`** — Disconnect and clean up.

**`GET /api/status`** — Active connections and their state.

### Internal Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Relay Server                                            │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌───────────┐  │
│  │ HTTP Router   │───>│ Connection   │───>│ WS Client │──── wss://api.anthropic.com
│  │ (Express)     │    │ Store        │    │           │  │
│  │               │<───│ (in-memory)  │<───│           │<─── (session events)
│  └──────┬───────┘    └──────────────┘    └───────────┘  │
│         │                                                │
│  ┌──────▼───────┐    ┌──────────────┐                   │
│  │ SSE Writer    │───>│ Event        │                   │
│  │               │    │ Transformer  │                   │
│  └──────────────┘    └──────────────┘                   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Connection Store:** In-memory map of `connectionId → { ws, sessionId, sseClients[], eventBuffer[] }`. When connecting, any existing connection to the same session is closed first to get a fresh history replay.

**Event Transformer:** Converts raw Anthropic session events into simplified payloads for the Watch. Strips markdown, summarizes verbose tool outputs (file contents, bash output), and provides human-readable tool input descriptions.

**Event Buffer:** Events arriving before an SSE client connects are buffered. On first SSE connection, historical events (fetched via REST) and buffered live events are flushed immediately.

### Security

- **Server-side credentials.** OAuth tokens are managed on the relay with automatic refresh, not sent by clients.
- **Shared secret auth.** All `/api` endpoints require the `x-watchcode-secret` header when configured.
- **TLS required in production.** Deploy behind HTTPS to protect the shared secret in transit.
- **Connection scoping.** Each `connectionId` is a UUID tied to a specific session.

---

## Component 2: Apple Watch App (SwiftUI)

### Tech Stack

- **Language:** Swift (SwiftUI)
- **Target:** watchOS 26+
- **Networking:** `URLSession` (HTTP + SSE via `bytes(for:)` async streaming)
- **Voice input:** System dictation via `TextField`
- **Storage:** `UserDefaults` for relay URL and shared secret

### Screens

**Session List** — Fetches available sessions from the relay's `/api/sessions` endpoint. Displays session title, model, and status. Tap to connect.

**Session View** — Main screen during an active connection:
- Live event feed with auto-scrolling
- Tool use/result pairs merged into collapsible rows
- Expandable assistant responses (tap to show full text)
- Bottom toolbar: microphone (dictation), stop (interrupt), disconnect
- Connection error banner with retry

**Settings** — Configure relay URL and shared secret. Includes a "Test Connection" button that hits `/api/sessions` to verify connectivity.

### Networking

The Watch connects to the relay via standard HTTP:
1. `POST /api/connect` with a session ID → receives `connectionId`
2. `GET /api/sessions/:id/events?connectionId=...` → async byte stream parsed as SSE
3. `POST /api/sessions/:id/message` → sends dictated text
4. `POST /api/sessions/:id/control` → sends interrupt

Reconnection is attempted up to 3 times with linear backoff (2s, 4s, 6s).

---

## Data Flow

### Connection Flow

```
1. User opens Watch app, sees list of Remote Control sessions
2. User taps a session
3. Watch sends POST /api/connect { sessionId }
4. Relay opens WebSocket to api.anthropic.com for that session
5. Relay fetches event history via REST, buffers it
6. Relay returns connectionId to Watch
7. Watch opens SSE stream: GET /api/sessions/:id/events?connectionId=...
8. Relay flushes buffered history, then streams live events
```

### Message Flow (Watch → Claude Code)

```
1. User taps microphone on Watch, speaks: "run the tests"
2. watchOS transcribes to text
3. Watch sends POST /api/sessions/:id/message { content: "run the tests" }
4. Relay forwards to Anthropic: POST /v1/sessions/:id/events
5. Anthropic delivers to Claude Code terminal via Remote Control WebSocket
6. Claude Code processes the prompt
7. Events flow back: Claude Code → Anthropic WS → Relay → SSE → Watch
```

### Interrupt Flow

```
1. User taps stop button on Watch
2. Watch sends POST /api/sessions/:id/control { type: "interrupt" }
3. Relay sends control event to Anthropic via REST
4. Claude Code stops current operation
```

---

## Anthropic Remote Control Protocol Reference

These are beta APIs subject to change.

### Headers (all requests)

```
Authorization: Bearer <oauth_token>
Content-Type: application/json
anthropic-version: 2023-06-01
anthropic-beta: ccr-byoc-2025-07-29
x-organization-uuid: <org_uuid>
```

### Endpoints Used by Relay

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/v1/sessions` | List sessions |
| `GET` | `/v1/sessions/{id}/events` | Fetch event history |
| `POST` | `/v1/sessions/{id}/events` | Send user messages / control events |
| `WS` | `/v1/sessions/ws/{id}/subscribe?organization_uuid={uuid}` | Real-time event subscription |

### Event Types (from WebSocket)

| Event Type | Description | Watch Display |
|------------|-------------|---------------|
| `user` | User prompt submitted | "You: run the tests" |
| `assistant` | Claude's text response | Rendered text (markdown stripped) |
| `tool_use` | Tool invocation started | Tool name + summarized input |
| `tool_result` | Tool output | Summarized result |
| `error` | Error occurred | Error banner |
