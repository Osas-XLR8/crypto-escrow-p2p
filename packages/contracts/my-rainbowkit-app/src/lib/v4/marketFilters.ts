// src/lib/v4/marketFilters.ts — asking the market your own question.
//
// The questions people actually arrive with are "can this offer fill ₦50,000?", "does it take Opay?" and
// "is this someone established?". All three are answered from data already on screen — no search service,
// no index, nothing anyone has to run.
//
// Pure: no React, no network. Everything here is tested in marketFilters.test.ts.

import type { ParsedOffer } from "@escrowx/sdk";
import { completionRate, releaseTime, type PartyStats } from "@/lib/v4/reputation";

export type SortKey = "price" | "completion" | "release";

/** "20+ trades only" — named so the threshold is not a bare number buried in a filter. */
export const ESTABLISHED_TRADES = 20;

/** Parses "50,000" or "₦50 000" into a number; null when there is nothing to filter by. */
export function parseFiatAmount(input: string): number | null {
  // A minus sign means the input is not the number it would become once stripped. Reading "-5" as 5 would
  // silently filter the market by something nobody asked for.
  if (input.includes("-")) return null;
  const cleaned = input.replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Can this offer trade that much fiat in a single go?
 *
 * "I want ₦50,000" is a question about this offer's own price, since every offer prices its own crypto.
 * Converts at the offer's price and checks the result against its per-trade limits and what is left.
 */
export function offerFitsAmount(offer: ParsedOffer, fiat: number, tokenDecimals: number, remaining?: bigint): boolean {
  const price = Number(offer.terms.price);
  if (!Number.isFinite(price) || price <= 0) return false;
  const tokens = BigInt(Math.floor((fiat / price) * 10 ** tokenDecimals));
  const cap = remaining !== undefined && remaining < offer.offer.maxAmount ? remaining : offer.offer.maxAmount;
  return tokens >= offer.offer.minAmount && tokens <= cap;
}

export interface FilterState {
  /** Raw text from the amount box; "" means no amount filter. */
  wantFiat: string;
  /** Empty means every method is acceptable. */
  methods: string[];
  establishedOnly: boolean;
}

export function filterOffers(
  offers: ParsedOffer[],
  state: FilterState,
  opts: {
    tokenDecimals: number;
    remainingOf?: (offer: ParsedOffer) => bigint | undefined;
    statsOf: (address: string) => PartyStats | undefined;
  }
): ParsedOffer[] {
  const fiat = parseFiatAmount(state.wantFiat);
  return offers.filter((o) => {
    if (state.methods.length > 0 && !o.terms.paymentMethods.some((m) => state.methods.includes(m))) return false;
    if (state.establishedOnly && (opts.statsOf(o.maker)?.total ?? 0) < ESTABLISHED_TRADES) return false;
    if (fiat !== null && !offerFitsAmount(o, fiat, opts.tokenDecimals, opts.remainingOf?.(o))) return false;
    return true;
  });
}

/**
 * Sorting, with one rule that matters: an offer with no history to sort on goes last, never first.
 *
 * Ranking an unknown merchant above a known one — because an absent completion rate sorted as zero, or an
 * absent release time as instant — would quietly turn the sort into an advert for brand-new wallets, which
 * is the opposite of what someone sorting by reputation is asking for.
 */
export function sortOffers(
  offers: ParsedOffer[],
  by: SortKey,
  /** Which side the viewer is on: buyers want the cheapest ask, sellers the highest bid. */
  bestIsLowest: boolean,
  statsOf: (address: string) => PartyStats | undefined
): ParsedOffer[] {
  const copy = [...offers];
  if (by === "price") {
    copy.sort((a, b) => Number(a.terms.price) - Number(b.terms.price));
    return bestIsLowest ? copy : copy.reverse();
  }
  const score = (o: ParsedOffer): number | undefined => {
    const stats = statsOf(o.maker);
    if (!stats) return undefined;
    return by === "completion" ? completionRate(stats) : releaseTime(stats)?.seconds;
  };
  copy.sort((a, b) => {
    const x = score(a);
    const y = score(b);
    if (x === undefined && y === undefined) return Number(a.terms.price) - Number(b.terms.price);
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    // Higher completion is better; lower release time is better. Price breaks a tie, so an equal-reputation
    // market still reads as a market.
    const primary = by === "completion" ? y - x : x - y;
    return primary !== 0 ? primary : Number(a.terms.price) - Number(b.terms.price);
  });
  return copy;
}
