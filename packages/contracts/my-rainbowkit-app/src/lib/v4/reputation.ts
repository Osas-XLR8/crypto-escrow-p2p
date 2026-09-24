// src/lib/v4/reputation.ts — what an address has actually done on this escrow.
//
// Everything here is derived from the escrow's own events: no scores, no backend, nothing anyone can buy.
// A fresh wallet and a merchant with two hundred settled trades look identical on an offer card otherwise,
// which is exactly the gap a scammer works in.
//
// Pure: no React, no network.

import { CANCEL_REASONS, RELEASE_REASONS, V4State, type TradeSummary } from "@/lib/v4/tradeIndex";

export interface PartyStats {
  address: string;
  /** Trades this address was a party to, in any state. */
  total: number;
  /** Still running. */
  open: number;
  /** Ended with the crypto going to the buyer because the seller released it — the clean path. */
  completed: number;
  /** Ended with the crypto going back to the seller's vault, for any reason. */
  cancelled: number;
  /** Ended by an arbitrator's ruling or a dispute default, either way. */
  arbitrated: number;
  /** Trades that went as far as a dispute (fee pending or beyond). */
  disputed: number;
  /** Disputes an arbitrator (or a fee default) decided against them. */
  lost: number;
  /** Token units across completed trades. */
  volume: bigint;
  /** Unix seconds of their first and latest trade here. */
  firstSeen?: number;
  lastSeen?: number;
  asSeller: number;
  asBuyer: number;
}

const lc = (a: string) => a.toLowerCase();

const empty = (address: string): PartyStats => ({
  address,
  total: 0,
  open: 0,
  completed: 0,
  cancelled: 0,
  arbitrated: 0,
  disputed: 0,
  lost: 0,
  volume: 0n,
  asSeller: 0,
  asBuyer: 0,
});

const SELLER_RELEASED = RELEASE_REASONS[0];
const RULED_FOR_BUYER = RELEASE_REASONS[1];
const SELLER_SKIPPED_FEE = RELEASE_REASONS[2];
const RULED_FOR_SELLER = CANCEL_REASONS[2];
const BUYER_SKIPPED_FEE = CANCEL_REASONS[5];

/** Per-address history, keyed by lower-cased address. One pass over the trades the app already indexes. */
export function buildReputation(trades: TradeSummary[]): Map<string, PartyStats> {
  const out = new Map<string, PartyStats>();
  const get = (address: string) => {
    const key = lc(address);
    let s = out.get(key);
    if (!s) out.set(key, (s = empty(address)));
    return s;
  };

  for (const t of trades) {
    const seller = get(t.seller);
    const buyer = get(t.buyer);
    seller.asSeller++;
    buyer.asBuyer++;

    for (const s of [seller, buyer]) {
      s.total++;
      if (t.openedAt) {
        s.firstSeen = s.firstSeen === undefined ? t.openedAt : Math.min(s.firstSeen, t.openedAt);
        s.lastSeen = s.lastSeen === undefined ? t.openedAt : Math.max(s.lastSeen, t.openedAt);
      }
      if (t.state !== V4State.RELEASED && t.state !== V4State.CANCELLED) s.open++;
      // A dispute that got as far as one party paying the fee is part of the record even if it settled after.
      if (t.state === V4State.FEE_PENDING || t.state === V4State.DISPUTED || t.events.some((e) => e.name === "DisputeRequested")) {
        s.disputed++;
      }
    }

    if (t.state === V4State.RELEASED) {
      seller.volume += t.amount;
      buyer.volume += t.amount;
      if (t.outcome === SELLER_RELEASED) {
        seller.completed++;
        buyer.completed++;
      } else {
        seller.arbitrated++;
        buyer.arbitrated++;
        // The crypto went to the buyer over the seller's objection, or because the seller walked away.
        if (t.outcome === RULED_FOR_BUYER || t.outcome === SELLER_SKIPPED_FEE) seller.lost++;
      }
    } else if (t.state === V4State.CANCELLED) {
      if (t.outcome === RULED_FOR_SELLER || t.outcome === BUYER_SKIPPED_FEE) {
        seller.arbitrated++;
        buyer.arbitrated++;
        buyer.lost++;
      } else {
        seller.cancelled++;
        buyer.cancelled++;
      }
    }
  }

  return out;
}

export function statsFor(reputation: Map<string, PartyStats>, address?: string): PartyStats | undefined {
  return address ? reputation.get(lc(address)) : undefined;
}

/** Finished trades — the only ones a rate can honestly be taken over. */
export function settled(s: PartyStats): number {
  return s.total - s.open;
}

/** Share of finished trades that ended with the seller releasing. Undefined until there's anything to divide. */
export function completionRate(s: PartyStats): number | undefined {
  const done = settled(s);
  return done > 0 ? s.completed / done : undefined;
}

export function disputeRate(s: PartyStats): number | undefined {
  return s.total > 0 ? s.disputed / s.total : undefined;
}
