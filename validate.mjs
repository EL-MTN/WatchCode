#!/usr/bin/env node

/**
 * WatchCode Concept Validator
 *
 * Proves that a custom client can connect to a Claude Code
 * Remote Control session via the Anthropic API.
 *
 * Usage:
 *   1. Run /rc in your Claude Code terminal
 *   2. Copy the session ID from the URL (claude.ai/code/<SESSION_ID>)
 *   3. Run: node validate.mjs <SESSION_ID>
 *
 * Credentials are auto-extracted from macOS Keychain and claude auth status.
 * Override with env vars: OAUTH_TOKEN, ORG_UUID
 */

import { WebSocket } from "ws";
import { execSync } from "child_process";
import readline from "readline";

// --- Auto-extract credentials ---
function getCredentials() {
  let token = process.env.OAUTH_TOKEN;
  let orgUuid = process.env.ORG_UUID;

  if (!token) {
    try {
      console.log("[auth] Reading OAuth token from macOS Keychain...");
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: "utf-8" }
      ).trim();
      const creds = JSON.parse(raw);
      token = creds.claudeAiOauth?.accessToken;
      if (token) console.log("[auth] Token extracted from Keychain.");
    } catch {
      console.error("[auth] Could not read from Keychain. Set OAUTH_TOKEN env var instead.");
    }
  }

  if (!orgUuid) {
    try {
      const status = JSON.parse(
        execSync("claude auth status 2>/dev/null", { encoding: "utf-8" }).trim()
      );
      orgUuid = status.orgId || "";
      if (orgUuid) console.log(`[auth] Org UUID: ${orgUuid}`);
    } catch {
      orgUuid = "";
    }
  }

  return { token, orgUuid };
}

// --- Configuration ---
const SESSION_ID = process.argv[2] || process.env.SESSION_ID;
const { token: OAUTH_TOKEN, orgUuid: ORG_UUID } = getCredentials();
const API_BASE = process.env.API_BASE || "https://api.anthropic.com";

if (!SESSION_ID) {
  console.error("\n  Missing session ID.\n");
  console.error("  Usage:");
  console.error("    node validate.mjs <SESSION_ID>\n");
  console.error("  The session ID is in the URL from /rc (claude.ai/code/<SESSION_ID>)\n");
  process.exit(1);
}

if (!OAUTH_TOKEN) {
  console.error("\n  Could not obtain OAuth token.\n");
  console.error("  Set it manually: OAUTH_TOKEN=sk-ant-oat01-xxx node validate.mjs <SESSION_ID>\n");
  process.exit(1);
}

// --- Step 1: Subscribe to session events via WebSocket ---
const wsUrl = `wss://api.anthropic.com/v1/sessions/ws/${SESSION_ID}/subscribe${ORG_UUID ? `?organization_uuid=${ORG_UUID}` : ""}`;

console.log(`\n[1/3] Connecting to Remote Control session...`);
console.log(`      Session: ${SESSION_ID}`);
console.log(`      WebSocket: ${wsUrl}\n`);

const ws = new WebSocket(wsUrl, {
  headers: {
    Authorization: `Bearer ${OAUTH_TOKEN}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "ccr-byoc-2025-07-29",
  },
});

ws.on("open", () => {
  console.log("[2/3] WebSocket connected! Listening for session events...\n");
  console.log("------- Live Events -------\n");
  promptForMessage();
});

ws.on("message", (data) => {
  try {
    const event = JSON.parse(data.toString());
    const timestamp = new Date().toLocaleTimeString();

    // Pretty-print based on event type
    if (event.type === "user") {
      console.log(`  [${timestamp}] USER: ${event.message?.content || JSON.stringify(event)}`);
    } else if (event.type === "assistant") {
      const text =
        event.message?.content
          ?.filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("") || "";
      if (text) {
        console.log(`  [${timestamp}] CLAUDE: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
      }
    } else if (event.type === "tool_use") {
      console.log(`  [${timestamp}] TOOL: ${event.name || "unknown"} - ${JSON.stringify(event.input || "").slice(0, 100)}`);
    } else if (event.type === "tool_result") {
      const content = typeof event.content === "string" ? event.content : JSON.stringify(event.content || "");
      console.log(`  [${timestamp}] RESULT: ${content.slice(0, 150)}${content.length > 150 ? "..." : ""}`);
    } else {
      console.log(`  [${timestamp}] EVENT (${event.type || "unknown"}): ${JSON.stringify(event).slice(0, 150)}`);
    }
  } catch {
    console.log(`  [raw] ${data.toString().slice(0, 200)}`);
  }
});

ws.on("error", (err) => {
  console.error(`\n[ERROR] WebSocket error: ${err.message}`);
  if (err.message.includes("401")) {
    console.error("  -> OAuth token is invalid or expired. Get a fresh token.");
  } else if (err.message.includes("403")) {
    console.error("  -> Access denied. Check your org UUID or session ID.");
  } else if (err.message.includes("404")) {
    console.error("  -> Session not found. Is /rc still active in your terminal?");
  }
  process.exit(1);
});

ws.on("close", (code, reason) => {
  console.log(`\n[CLOSED] WebSocket closed (code: ${code}, reason: ${reason.toString() || "none"})`);
  process.exit(0);
});

// --- Step 2: Send a test message ---
async function sendMessage(content) {
  const url = `${API_BASE}/v1/sessions/${SESSION_ID}/events`;
  const eventId = crypto.randomUUID();

  console.log(`\n  [SENDING] "${content}"`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OAUTH_TOKEN}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "ccr-byoc-2025-07-29",
        ...(ORG_UUID ? { "x-organization-uuid": ORG_UUID } : {}),
      },
      body: JSON.stringify({
        events: [
          {
            uuid: eventId,
            session_id: SESSION_ID,
            type: "user",
            parent_tool_use_id: null,
            message: { role: "user", content },
          },
        ],
      }),
    });

    if (res.ok) {
      console.log(`  [SENT] Message delivered (${res.status}). Watch your Claude Code terminal!\n`);
    } else {
      const body = await res.text();
      console.error(`  [FAILED] ${res.status}: ${body}\n`);
    }
  } catch (err) {
    console.error(`  [FAILED] ${err.message}\n`);
  }
}

// --- Step 3: Interactive prompt ---
function promptForMessage() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  function ask() {
    rl.question("\n[3/3] Type a message to send (or 'quit'): ", async (input) => {
      const trimmed = input.trim();
      if (trimmed.toLowerCase() === "quit") {
        ws.close();
        rl.close();
        return;
      }
      if (trimmed) {
        await sendMessage(trimmed);
      }
      ask();
    });
  }

  ask();
}
