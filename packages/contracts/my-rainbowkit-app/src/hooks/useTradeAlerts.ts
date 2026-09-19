// src/hooks/useTradeAlerts.ts — notifies when the OTHER side of one of your trades does something on-chain.
//
// Events already seen on this device are remembered, so reloading never replays old alerts; the very first
// load for a wallet just records what's there.

import { useEffect, useRef } from "react";
import { CHAIN_ID, V4 } from "@/config/v4";
import { useToasts } from "@/context/Toasts";
import { fmtToken, recallTradeTerms } from "@/lib/v4/local";
import type { TradeSummary } from "@/lib/v4/tradeIndex";

const MAX_SEEN = 3000;
const SYM = V4.tokenSymbol;

function storageKey(address: string) {
  return `escrowx:seen:${CHAIN_ID}:${V4.escrow.toLowerCase()}:${address.toLowerCase()}`;
}

export function useTradeAlerts(trades: TradeSummary[], address: string | undefined, onOpen: (id: bigint) => void) {
  const { notify } = useToasts();
  const seen = useRef<{ address: string; keys: Set<string> } | null>(null);

  useEffect(() => {
    if (!address || trades.length === 0) return;
    const me = address.toLowerCase();
    const mine = trades.filter((t) => t.buyer.toLowerCase() === me || t.seller.toLowerCase() === me);
    const items = mine.flatMap((t) => t.events.map((e) => ({ t, e, key: `${e.txHash}:${e.logIndex}` })));

    if (!seen.current || seen.current.address !== me) {
      let stored: string[] | null = null;
      try {
        stored = JSON.parse(localStorage.getItem(storageKey(me)) ?? "null");
      } catch {
        stored = null;
      }
      seen.current = { address: me, keys: new Set(stored ?? items.map((i) => i.key)) };
      if (!stored) return persist(me, seen.current.keys);
    }

    let changed = false;
    for (const { t, e, key } of items) {
      if (seen.current.keys.has(key)) continue;
      seen.current.keys.add(key);
      changed = true;

      const iAmBuyer = t.buyer.toLowerCase() === me;
      const id = t.tradeId;
      const amount = `${fmtToken(t.amount)} ${SYM}`;
      const open = { actionLabel: "Open trade", onAction: () => onOpen(id) };
      const other = (addr: unknown) => typeof addr === "string" && addr.toLowerCase() !== me;

      switch (e.name) {
        case "TradeOpened":
          // Terms saved on this device at take time mean I opened it myself.
          if (recallTradeTerms(id)) break;
          if (iAmBuyer) notify({ title: `A seller filled your buy offer · trade #${id}`, body: `${amount} is locked for you. Their payment details will arrive in the chat — then pay them.`, tone: "ok", ...open });
          else notify({ title: `New trade on your offer · #${id}`, body: `A buyer locked ${amount} of yours in escrow. Share your payment details in the chat.`, tone: "ok", ...open });
          break;
        case "PaymentMarked":
          if (!iAmBuyer) notify({ title: `The buyer says they've paid · trade #${id}`, body: "Check your own banking app for the money, then release.", tone: "warn", ...open });
          break;
        case "Released":
          if (iAmBuyer) notify({ title: `You received ${amount} · trade #${id}`, body: "The crypto is in your wallet.", tone: "ok", ...open });
          else if (Number(e.args.reason) !== 0) notify({ title: `Trade #${id} ruled for the buyer`, body: `${amount} was released to the buyer.`, tone: "warn", ...open });
          break;
        case "Cancelled":
          if (!iAmBuyer) notify({ title: `Trade #${id} cancelled`, body: `${amount} is back in your vault.`, ...open });
          else if (Number(e.args.reason) !== 0) notify({ title: `Trade #${id} cancelled`, body: "The crypto went back to the seller.", tone: "warn", ...open });
          break;
        case "DisputeRequested":
          if (other(e.args.opener)) notify({ title: `Dispute opened on trade #${id}`, body: "Match the arbitration fee in time or you lose by default.", tone: "warn", ...open });
          break;
        case "ArbitrationFeePaid":
          if (other(e.args.party)) notify({ title: `Dispute fee matched · trade #${id}`, body: "The case is going to the arbitrator.", ...open });
          break;
        case "Evidence":
          if (other(e.args.party)) notify({ title: `New evidence on trade #${id}`, body: "The other side sealed evidence for the arbitrator.", ...open });
          break;
      }
    }
    if (changed) persist(me, seen.current.keys);
  }, [trades, address, notify, onOpen]);
}

function persist(address: string, keys: Set<string>) {
  try {
    localStorage.setItem(storageKey(address), JSON.stringify([...keys].slice(-MAX_SEEN)));
  } catch {
    /* storage blocked: alerts may repeat after a reload */
  }
}
