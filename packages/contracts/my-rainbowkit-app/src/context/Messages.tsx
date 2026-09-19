// src/context/Messages.tsx — the encrypted trade chat for all of this wallet's trades.
//
// One live relay subscription feeds every conversation. For each trade it works out the counterparty's
// messaging key and only ever TRUSTS that key:
//   • from the counterparty's signed offer (maker) — the key is bound to their wallet, checked on parse
//   • or from the counterparty's "hello" — a wallet signature binding the key to the trade's on-chain party
// It introduces this wallet to the counterparty once per trade (hello), tracks unread messages per trade,
// and raises notifications only for messages from the verified counterparty.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TradeChat, verifyHello, type ReceivedMessage, type TradeMessage } from "@escrowx/sdk";
import type { Address } from "viem";
import { useEscrowX } from "@/context/EscrowX";
import { useToasts } from "@/context/Toasts";
import { RELAYS } from "@/config/v4";
import { findTradeOffer, helloSent, lastRead, markHelloSent, markRead as storeRead, recallTradeTerms, rememberTradeTerms, termsFromOffer } from "@/lib/v4/local";
import { V4State, type TradeSummary } from "@/lib/v4/tradeIndex";

type Outgoing = Parameters<TradeChat["send"]>[1];
/** A message to send, minus the trade id (distributes over the message union). */
export type OutgoingMessage = Outgoing extends infer M ? (M extends unknown ? Omit<M, "tradeId"> : never) : never;

interface Peer {
  key: string;
  via: "offer" | "hello";
}

interface MessagesValue {
  /** Messaging is unlocked and the stored messages have loaded. */
  ready: boolean;
  thread: (tradeId: bigint) => ReceivedMessage[];
  peer: (tradeId: bigint) => Peer | null;
  trusted: (tradeId: bigint, from: string) => boolean;
  unread: (tradeId: bigint) => number;
  totalUnread: number;
  markRead: (tradeId: bigint) => void;
  /** Sends to the trade's verified counterparty. */
  send: (tradeId: bigint, message: OutgoingMessage) => Promise<void>;
}

const Ctx = createContext<MessagesValue | null>(null);

const isOpen = (t: TradeSummary) => t.state !== V4State.RELEASED && t.state !== V4State.CANCELLED;

export function MessagesProvider({ trades, onOpenTrade, children }: { trades: TradeSummary[]; onOpenTrade: (id: bigint) => void; children: ReactNode }) {
  const { address, pool, book, identity, binding } = useEscrowX();
  const { notify } = useToasts();
  const chat = useMemo(() => (pool && identity ? new TradeChat(pool, RELAYS, identity) : null), [pool, identity]);

  const [byTrade, setByTrade] = useState<Map<string, ReceivedMessage[]>>(new Map());
  const [ready, setReady] = useState(false);
  const [peers, setPeers] = useState<Map<string, Peer>>(new Map());
  const [readTick, setReadTick] = useState(0);
  const readyRef = useRef(false);
  const lookedUp = useRef(new Map<string, number>()); // tradeId -> last relay lookup (ms), to avoid hammering relays
  const pendingNotify = useRef<ReceivedMessage[]>([]);
  const introducing = useRef(new Set<string>());

  const myTrades = useMemo(
    () => (address ? trades.filter((t) => [t.buyer, t.seller].some((a) => a.toLowerCase() === address.toLowerCase())) : []),
    [trades, address]
  );
  const counterpartyOf = useCallback(
    (tradeId: string): Address | null => {
      const t = myTrades.find((x) => x.tradeId.toString() === tradeId);
      if (!t || !address) return null;
      return (t.buyer.toLowerCase() === address.toLowerCase() ? t.seller : t.buyer) as Address;
    },
    [myTrades, address]
  );

  // ─── Live subscription ──────────────────────────────────────────────────────
  useEffect(() => {
    setByTrade(new Map());
    setPeers(new Map());
    setReady(false);
    readyRef.current = false;
    if (!chat) return;
    const close = chat.subscribe(
      (m) => {
        setByTrade((prev) => {
          const next = new Map(prev);
          const list = [...(next.get(m.message.tradeId) ?? []), m].sort((a, b) => a.createdAt - b.createdAt);
          next.set(m.message.tradeId, list);
          return next;
        });
        if (readyRef.current && !m.mine && m.message.type !== "hello") pendingNotify.current.push(m);
      },
      () => {
        readyRef.current = true;
        setReady(true);
      }
    );
    return close;
  }, [chat]);

  // ─── Resolve each trade's counterparty key (verified only) ──────────────────
  useEffect(() => {
    if (!identity) return;
    let cancelled = false;
    (async () => {
      for (const t of myTrades) {
        const id = t.tradeId.toString();
        if (peers.has(id)) continue;
        const counterparty = counterpartyOf(id);
        if (!counterparty) continue;

        let found: Peer | null = null;
        for (const m of byTrade.get(id) ?? []) {
          if (!m.mine && m.message.type === "hello" && (await verifyHello(m, counterparty))) {
            found = { key: m.from, via: "hello" };
            break;
          }
        }
        if (!found) {
          let terms = recallTradeTerms(t.tradeId);
          const offerHash = t.events.find((e) => e.name === "TradeOpened")?.args.offerHash as string | undefined;
          const last = lookedUp.current.get(id) ?? 0;
          if ((!terms?.makerKey || !terms.maker) && book && offerHash && Date.now() - last > 60_000) {
            lookedUp.current.set(id, Date.now());
            const offer = await findTradeOffer(book, offerHash).catch(() => null);
            if (offer) {
              terms = termsFromOffer(offer);
              rememberTradeTerms(t.tradeId, terms);
            }
          }
          if (terms?.makerKey && terms.maker && terms.maker.toLowerCase() === counterparty.toLowerCase()) found = { key: terms.makerKey, via: "offer" };
        }
        if (found && !cancelled) setPeers((prev) => (prev.has(id) ? prev : new Map(prev).set(id, found!)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity, book, myTrades, byTrade, peers, counterpartyOf]);

  // ─── Introduce myself once per open trade ───────────────────────────────────
  useEffect(() => {
    if (!chat || !binding || !address || !ready) return;
    for (const t of myTrades) {
      const p = peers.get(t.tradeId.toString());
      const key = t.tradeId.toString();
      if (!p || !isOpen(t) || helloSent(t.tradeId, address) || introducing.current.has(key)) continue;
      introducing.current.add(key);
      chat
        .send(p.key, { type: "hello", tradeId: key, binding })
        .then(() => markHelloSent(t.tradeId, address))
        .catch(() => {
          /* not delivered: tried again on the next change */
        })
        .finally(() => introducing.current.delete(key));
    }
  }, [chat, binding, address, ready, myTrades, peers]);

  const trusted = useCallback((tradeId: bigint, from: string) => peers.get(tradeId.toString())?.key === from, [peers]);

  // ─── Notifications for new messages from the verified counterparty ──────────
  useEffect(() => {
    if (!pendingNotify.current.length) return;
    const queue = pendingNotify.current.splice(0);
    for (const m of queue) {
      const id = BigInt(m.message.tradeId);
      if (!trusted(id, m.from)) {
        // Not (yet) verified: keep it queued until the counterparty key resolves, then re-check once.
        if (!peers.has(m.message.tradeId)) pendingNotify.current.push(m);
        continue;
      }
      const who = counterpartyLabel(myTrades, m.message.tradeId, address);
      const open = { actionLabel: "Open", onAction: () => onOpenTrade(id) };
      if (m.message.type === "payment_details") notify({ title: `Payment details received · trade #${id}`, body: `The ${who} sent where to pay.`, tone: "info", ...open });
      // The on-chain markPaid raises its own (authoritative) alert; only surface the reference here.
      else if (m.message.type === "payment_sent" && m.message.reference) notify({ title: `Payment reference from the ${who} · trade #${id}`, body: m.message.reference, ...open });
      else if (m.message.type === "text") notify({ title: `Message from the ${who} · trade #${id}`, body: m.message.text.slice(0, 120), ...open });
    }
  }, [byTrade, peers, trusted, notify, onOpenTrade, myTrades, address]);

  const thread = useCallback((tradeId: bigint) => byTrade.get(tradeId.toString()) ?? [], [byTrade]);
  const peer = useCallback((tradeId: bigint) => peers.get(tradeId.toString()) ?? null, [peers]);

  const unread = useCallback(
    (tradeId: bigint) => {
      if (!address) return 0;
      const since = lastRead(tradeId.toString(), address);
      return (byTrade.get(tradeId.toString()) ?? []).filter((m) => !m.mine && m.message.type !== "hello" && trusted(tradeId, m.from) && m.createdAt > since).length;
    },
    // readTick re-evaluates after markRead
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byTrade, address, trusted, readTick]
  );
  const totalUnread = useMemo(() => myTrades.reduce((n, t) => n + unread(t.tradeId), 0), [myTrades, unread]);

  const markRead = useCallback(
    (tradeId: bigint) => {
      if (!address) return;
      const latest = (byTrade.get(tradeId.toString()) ?? []).reduce((max, m) => Math.max(max, m.createdAt), 0);
      if (latest > lastRead(tradeId.toString(), address)) {
        storeRead(tradeId.toString(), address, latest);
        setReadTick((n) => n + 1);
      }
    },
    [byTrade, address]
  );

  const send = useCallback(
    async (tradeId: bigint, message: OutgoingMessage) => {
      if (!chat || !binding || !address) throw new Error("Unlock messaging first");
      const p = peers.get(tradeId.toString());
      if (!p) throw new Error("The other side's messaging key isn't verified yet");
      if (!helloSent(tradeId, address)) {
        await chat.send(p.key, { type: "hello", tradeId: tradeId.toString(), binding });
        markHelloSent(tradeId, address);
      }
      await chat.send(p.key, { ...message, tradeId: tradeId.toString() } as Outgoing);
    },
    [chat, binding, address, peers]
  );

  const value = useMemo<MessagesValue>(
    () => ({ ready, thread, peer, trusted, unread, totalUnread, markRead, send }),
    [ready, thread, peer, trusted, unread, totalUnread, markRead, send]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function counterpartyLabel(trades: TradeSummary[], tradeId: string, me?: string) {
  const t = trades.find((x) => x.tradeId.toString() === tradeId);
  return t && me && t.buyer.toLowerCase() === me.toLowerCase() ? "seller" : "buyer";
}

export function useMessages(): MessagesValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMessages must be used inside MessagesProvider");
  return v;
}

export type { TradeMessage };
