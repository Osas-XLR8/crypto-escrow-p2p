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
  /**
   * Seconds between the buyer marking a trade paid and this seller releasing it, for trades they released
   * themselves. Arbitrated releases are left out: how long a firm took to rule is not the seller's speed.
   * This is the number a buyer actually waits on, and the one thing no P2P interface seems to publish.
   */
  releaseSeconds: number[];
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
  releaseSeconds: [],
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
        const paidAt = t.events.find((e) => e.name === "PaymentMarked")?.timestamp;
        const releasedAt = t.events.find((e) => e.name === "Released")?.timestamp;
        // >= not >: a release in the same second as the payment is a real measurement — the fastest one
        // there is — and on a fast chain it is common. Requiring a strictly later timestamp silently threw
        // away every prompt seller, which is precisely the behaviour this number exists to reward.
        if (paidAt !== undefined && releasedAt !== undefined && releasedAt >= paidAt) {
          seller.releaseSeconds.push(releasedAt - paidAt);
        }
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

/**
 * Typical time this seller took to release, in seconds, with how many trades it is drawn from.
 *
 * Median rather than mean: one seller who went to bed mid-trade should not define their reputation, and a
 * mean is exactly the statistic that lets them. Undefined until there is at least one completed release.
 */
export function releaseTime(s: PartyStats): { seconds: number; from: number } | undefined {
  const xs = [...s.releaseSeconds].sort((a, b) => a - b);
  if (xs.length === 0) return undefined;
  const mid = xs.length % 2 ? xs[(xs.length - 1) / 2]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2;
  return { seconds: Math.round(mid), from: xs.length };
}

/** A rate is only as good as what it was measured on. */
export type Confidence = "none" | "thin" | "fair" | "strong";

export const DAY = 86_400;

/**
 * How much weight a rate deserves, from the three things that are expensive to fake together.
 *
 * A completion rate on its own is the easiest number in P2P to manufacture: open two wallets, trade with
 * yourself, and 100% costs an afternoon. What that does not buy is *history* — settled trades take a
 * counterparty, volume takes capital that sits at risk, and age cannot be bought at all. So the weakest of
 * the three caps the result, and a wallet a day old with one large trade stays "thin" no matter how clean
 * its record looks.
 *
 * This is a presentation aid, not a score. Nothing here is stored, ranked or sold, and the underlying counts
 * stay on screen next to it so anyone can disagree with the judgement.
 */
export function confidence(s: PartyStats, now: number): Confidence {
  const done = settled(s);
  if (done === 0) return "none";
  const ageDays = s.firstSeen === undefined ? 0 : Math.max(0, (now - s.firstSeen) / DAY);
  const byTrades: Confidence = done >= 20 ? "strong" : done >= 5 ? "fair" : "thin";
  const byAge: Confidence = ageDays >= 30 ? "strong" : ageDays >= 7 ? "fair" : "thin";
  // Volume is in token units (6 decimals): 10,000 and 1,000 of the token.
  const byVolume: Confidence = s.volume >= 10_000_000_000n ? "strong" : s.volume >= 1_000_000_000n ? "fair" : "thin";
  const rank: Confidence[] = ["none", "thin", "fair", "strong"];
  return rank[Math.min(rank.indexOf(byTrades), rank.indexOf(byAge), rank.indexOf(byVolume))]!;
}

/** Below this many finished trades, a dispute rate is noise and saying anything about it would mislead. */
export const MIN_FOR_DISPUTE_ALARM = 4;
/** Above this share of trades ending in dispute, a counterparty deserves more than a small grey tag. */
export const HIGH_DISPUTE_RATE = 0.25;
export const SEVERE_DISPUTE_RATE = 0.5;

/**
 * Whether this counterparty's dispute record should interrupt someone about to trade with them.
 *
 * The review found a seller with 50% completion and 38% disputed sitting in the market behind a small tag.
 * A tag is the right weight for a statistic; it is the wrong weight for a warning.
 */
export function disputeAlarm(s: PartyStats): { level: "none" | "warn" | "severe"; rate: number; of: number } {
  const of = settled(s);
  const rate = disputeRate(s) ?? 0;
  if (of < MIN_FOR_DISPUTE_ALARM || rate < HIGH_DISPUTE_RATE) return { level: "none", rate, of };
  return { level: rate >= SEVERE_DISPUTE_RATE ? "severe" : "warn", rate, of };
}
