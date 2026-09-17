#!/usr/bin/env node
// Minimal local Nostr relay (NIP-01) for development — in-memory, no persistence, no auth.
// Usage: node scripts/dev-relay.mjs [--port 7777]
// For anything beyond local dev, use real relays (strfry, nostr-rs-relay, …), ideally several.

import { WebSocketServer } from "ws";
import { verifyEvent } from "nostr-tools/pure";
import { matchFilters } from "nostr-tools/filter";

const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : Number(process.env.RELAY_PORT ?? 7777);
const MAX_EVENTS = 50_000;
const MAX_MESSAGE_BYTES = 128 * 1024;

const events = [];
const subs = new Map(); // ws -> Map<subId, filters>

const isReplaceable = (k) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
const isAddressable = (k) => k >= 30000 && k < 40000;
const dTag = (e) => e.tags.find((t) => t[0] === "d")?.[1] ?? "";

// Rebuild from NIP-01 fields so a cached "verified" flag on the object can never skip the check.
const verifyStrict = (e) =>
  !!e && Array.isArray(e.tags) &&
  verifyEvent({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content, sig: e.sig });

function store(e) {
  if (isReplaceable(e.kind) || isAddressable(e.kind)) {
    const idx = events.findIndex((x) => x.pubkey === e.pubkey && x.kind === e.kind && (!isAddressable(e.kind) || dTag(x) === dTag(e)));
    if (idx >= 0) {
      if (events[idx].created_at > e.created_at) return false;
      events.splice(idx, 1);
    }
  }
  events.push(e);
  if (events.length > MAX_EVENTS) events.shift();
  return true;
}

const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

const wss = new WebSocketServer({ port, host: "127.0.0.1", maxPayload: MAX_MESSAGE_BYTES });
wss.on("connection", (ws) => {
  subs.set(ws, new Map());
  ws.on("close", () => subs.delete(ws));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, ["NOTICE", "invalid json"]);
    }
    const [type, ...rest] = msg;
    if (type === "EVENT") {
      const e = rest[0];
      if (!verifyStrict(e)) return send(ws, ["OK", e?.id, false, "invalid: bad signature"]);
      if (!events.some((x) => x.id === e.id)) store(e);
      send(ws, ["OK", e.id, true, ""]);
      for (const [client, clientSubs] of subs) for (const [id, filters] of clientSubs) if (matchFilters(filters, e)) send(client, ["EVENT", id, e]);
    } else if (type === "REQ") {
      const [subId, ...filters] = rest;
      subs.get(ws).set(subId, filters);
      const limit = Math.min(...filters.map((f) => f.limit ?? Infinity));
      const matched = events.filter((e) => matchFilters(filters, e)).sort((a, b) => b.created_at - a.created_at);
      for (const e of Number.isFinite(limit) ? matched.slice(0, limit) : matched) send(ws, ["EVENT", subId, e]);
      send(ws, ["EOSE", subId]);
    } else if (type === "CLOSE") {
      subs.get(ws).delete(rest[0]);
    }
  });
});

wss.on("listening", () => console.log(`EscrowX dev relay listening on ws://127.0.0.1:${port}`));
