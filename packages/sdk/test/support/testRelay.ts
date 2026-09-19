// test/support/testRelay.ts — minimal NIP-01 relay for tests (in-process, random port).
// Implements EVENT / REQ / CLOSE / EOSE / OK, signature verification, filter matching and
// replaceable + addressable event semantics. Not for production use.

import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { Event } from "nostr-tools/pure";
import { verifyEventStrict } from "../../src/offerEvents.js";
import { matchFilters, type Filter } from "nostr-tools/filter";

export interface TestRelay {
  url: string;
  events: Event[];
  /** Reject everything published from now on (simulates a relay outage/censorship). */
  setRejectAll(reject: boolean): void;
  close(): Promise<void>;
}

const isReplaceable = (k: number) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
const isAddressable = (k: number) => k >= 30000 && k < 40000;
const dTag = (e: Event) => e.tags.find((t) => t[0] === "d")?.[1] ?? "";

export async function startTestRelay(): Promise<TestRelay> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const { port } = wss.address() as AddressInfo;

  const events: Event[] = [];
  const subs = new Map<WebSocket, Map<string, Filter[]>>();
  let rejectAll = false;

  const send = (ws: WebSocket, msg: unknown[]) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  function store(e: Event): void {
    if (isReplaceable(e.kind) || isAddressable(e.kind)) {
      const sameSlot = (x: Event) =>
        x.pubkey === e.pubkey && x.kind === e.kind && (!isAddressable(e.kind) || dTag(x) === dTag(e));
      const idx = events.findIndex(sameSlot);
      if (idx >= 0) {
        if (events[idx]!.created_at > e.created_at) return; // keep newer
        events.splice(idx, 1);
      }
    }
    events.push(e);
  }

  wss.on("connection", (ws) => {
    subs.set(ws, new Map());
    ws.on("close", () => subs.delete(ws));
    ws.on("message", (raw) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, ["NOTICE", "invalid json"]);
      }
      const [type, ...rest] = msg;

      if (type === "EVENT") {
        const e = rest[0] as Event;
        if (rejectAll) return send(ws, ["OK", e?.id, false, "blocked: relay rejecting writes"]);
        if (!e || !verifyEventStrict(e)) return send(ws, ["OK", e?.id, false, "invalid: bad signature"]);
        if (!events.some((x) => x.id === e.id)) store(e);
        send(ws, ["OK", e.id, true, ""]);
        for (const [client, clientSubs] of subs) {
          for (const [subId, filters] of clientSubs) if (matchFilters(filters, e)) send(client, ["EVENT", subId, e]);
        }
        return;
      }

      if (type === "REQ") {
        const [subId, ...filters] = rest as [string, ...Filter[]];
        // Like real relays (NIP-01): only single-letter tag filters are indexed. Refuse anything else loudly,
        // so a client query that would silently match nothing in production fails in tests too.
        const unindexed = filters.flatMap((f) => Object.keys(f)).find((k) => k.startsWith("#") && k.length !== 2);
        if (unindexed) {
          send(ws, ["CLOSED", subId, `unsupported: unindexed tag filter ${unindexed}`]);
          return;
        }
        subs.get(ws)!.set(subId, filters);
        const limit = Math.min(...filters.map((f) => f.limit ?? Infinity));
        const matched = events
          .filter((e) => matchFilters(filters, e))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, Number.isFinite(limit) ? limit : undefined);
        for (const e of matched) send(ws, ["EVENT", subId, e]);
        return send(ws, ["EOSE", subId]);
      }

      if (type === "CLOSE") subs.get(ws)!.delete(rest[0] as string);
    });
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    events,
    setRejectAll: (reject) => {
      rejectAll = reject;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}
