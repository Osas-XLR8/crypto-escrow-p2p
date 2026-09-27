// src/ratings.ts — "how did that trade go?", as a Nostr event anyone can check.
//
// The problem with every P2P rating system is that ratings are cheap to manufacture: nothing stops a
// merchant rating themselves from a hundred wallets. Here a rating is only counted when all of this holds,
// and parseRatingEvent checks every one:
//
//   1. the Nostr event signature is valid
//   2. a wallet-signed binding says this Nostr key speaks for the rater (the same binding offers use)
//   3. the rater and the subject are the two parties of that trade, read from the escrow contract
//   4. the trade actually finished — you rate a trade that happened, not one you opened
//   5. one rating per rater per trade (addressable by d = chain:escrow:tradeId:rater, so a later
//      event from the same rater replaces their earlier one rather than adding to it)
//
// Point 3 is what makes this expensive to fake: manufacturing a rating means manufacturing a trade, which
// means locking real crypto in the escrow with a counterparty and paying gas. A rating is a receipt for
// something that cost something.
//
// What this does NOT do: prove the trade went well. Someone can lie about a counterparty they genuinely
// traded with. It bounds who may speak, not what they say — which is the honest limit of any rating.

import { finalizeEvent, type Event, type VerifiedEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import type { Filter } from "nostr-tools";
import type { Address, Hex, PublicClient } from "viem";
import { sameAddress, verifyBinding } from "./identity.js";
import { LAYER_TAG, PROTOCOL_TAG, network, verifyEventStrict } from "./offerEvents.js";
import { RELAY_PUBLISH_TIMEOUT_MS, settleWithin } from "./relayTimeout.js";
import type { PublishResult } from "./offerBook.js";
import { escrowCoreV4Abi } from "./abi/escrowCoreV4.js";
import type { NostrIdentity, WalletBinding } from "./types.js";

/** Addressable, like offers: a rater replaces their own rating rather than stacking them. */
export const RATING_EVENT_KIND = 38384;

/** Short, fixed reasons. Free text invites abuse and needs moderation nobody here can provide. */
export const RATING_TAGS = [
  "fast release",
  "slow release",
  "paid promptly",
  "slow to pay",
  "clear communication",
  "no response",
] as const;
export type RatingTag = (typeof RATING_TAGS)[number];

export interface Rating {
  /** +1 or -1. Deliberately not a five-star scale: a star average says less than it appears to. */
  score: 1 | -1;
  tag?: RatingTag;
  tradeId: bigint;
  chainId: number;
  escrow: Address;
  /** Who is being rated. */
  subject: Address;
  /** Who is rating them. */
  rater: Address;
}

export interface ParsedRating extends Rating {
  event: Event;
  binding: WalletBinding;
}

export type RatingRejection =
  | "bad_nostr_signature"
  | "wrong_kind"
  | "malformed_content"
  | "wrong_network"
  | "bad_binding"
  | "binding_mismatch"
  | "tag_mismatch"
  | "not_a_party"
  | "trade_unfinished"
  | "unreadable_trade";

export class RatingEventError extends Error {
  constructor(readonly reason: RatingRejection, message: string) {
    super(message);
  }
}

/** d tag: one slot per rater per trade, so re-rating replaces. */
export function ratingAddress(chainId: number, escrow: Address, tradeId: bigint, rater: Address): string {
  return `${chainId}:${escrow.toLowerCase()}:${tradeId}:${rater.toLowerCase()}`;
}

export function buildRatingEvent(args: {
  rating: Rating;
  binding: WalletBinding;
  identity: NostrIdentity;
  createdAt?: number;
}): VerifiedEvent {
  const { rating, binding, identity } = args;
  if (rating.score !== 1 && rating.score !== -1) throw new Error("score must be 1 or -1");
  if (rating.tag && !RATING_TAGS.includes(rating.tag)) throw new Error("unknown rating tag");
  if (!sameAddress(binding.address, rating.rater)) throw new Error("binding is for a different wallet");
  if (binding.nostrPubkey !== identity.publicKey) throw new Error("binding is for a different Nostr key");

  return finalizeEvent(
    {
      kind: RATING_EVENT_KIND,
      created_at: args.createdAt ?? Math.floor(Date.now() / 1000),
      tags: [
        ["d", ratingAddress(rating.chainId, rating.escrow, rating.tradeId, rating.rater)],
        // Single-letter tags are the only ones relays index (NIP-01), so the subject needs one for
        // "ratings about this address" to be a query rather than a full scan. It cannot be "p": that tag
        // is reserved for a 32-byte Nostr pubkey and relays reject a 20-byte Ethereum address in it
        // outright ("unexpected size for fixed-size tag: p"). "s" carries the subject instead, the same
        // way offers use "d", "k" and "f" for values of their own shapes.
        ["s", rating.subject.toLowerCase()],
        ["y", PROTOCOL_TAG],
        ["trade", rating.tradeId.toString()],
        ["score", String(rating.score)],
        ["network", network(rating.chainId)],
        ["layer", LAYER_TAG],
      ],
      content: JSON.stringify({
        v: 1,
        score: rating.score,
        tag: rating.tag,
        tradeId: rating.tradeId.toString(),
        chainId: rating.chainId,
        escrow: rating.escrow,
        subject: rating.subject,
        rater: rating.rater,
        binding,
      }),
    },
    identity.secretKey
  );
}

export interface ParseRatingOptions {
  chainId?: number;
  escrow?: Address;
  /** Required: without it, points 3 and 4 cannot be checked and the rating means nothing. */
  publicClient?: PublicClient;
}

/** States in which a trade is over. Mirrors EscrowCoreV4.State. */
const FINISHED = new Set([5, 6]); // RELEASED, CANCELLED

export async function parseRatingEvent(event: Event, opts: ParseRatingOptions = {}): Promise<ParsedRating> {
  const fail = (reason: RatingRejection, message: string): never => {
    throw new RatingEventError(reason, message);
  };

  if (event.kind !== RATING_EVENT_KIND) fail("wrong_kind", `expected kind ${RATING_EVENT_KIND}`);
  // verifyEventStrict, not verifyEvent: nostr-tools marks an event object as verified once and object
  // spread carries that marker onto a copy, so `{...event, content: "anything"}` passes a plain check.
  // Rebuilding the fields into a clean object is what makes the signature actually cover the content.
  if (!verifyEventStrict(event)) fail("bad_nostr_signature", "Nostr event signature is invalid");

  let body: Record<string, unknown>;
  let rating!: Rating;
  let binding!: WalletBinding;
  try {
    body = JSON.parse(event.content) as Record<string, unknown>;
    if (body.v !== 1) throw new Error("unsupported version");
    const score = Number(body.score);
    if (score !== 1 && score !== -1) throw new Error("score must be 1 or -1");
    if (body.tag !== undefined && !RATING_TAGS.includes(body.tag as RatingTag)) throw new Error("unknown tag");
    rating = {
      score: score as 1 | -1,
      tag: body.tag as RatingTag | undefined,
      tradeId: BigInt(String(body.tradeId)),
      chainId: Number(body.chainId),
      escrow: body.escrow as Address,
      subject: body.subject as Address,
      rater: body.rater as Address,
    };
    binding = body.binding as WalletBinding;
  } catch (e) {
    return fail("malformed_content", `malformed rating: ${(e as Error).message}`);
  }

  if (opts.chainId !== undefined && rating.chainId !== opts.chainId) fail("wrong_network", `rating is for chain ${rating.chainId}`);
  if (opts.escrow && !sameAddress(rating.escrow, opts.escrow)) fail("wrong_network", "rating is for a different escrow");

  if (tag(event, "d") !== ratingAddress(rating.chainId, rating.escrow, rating.tradeId, rating.rater)) {
    fail("tag_mismatch", "d tag must identify this rater and trade");
  }
  if (tag(event, "s") !== rating.subject.toLowerCase()) fail("tag_mismatch", "s tag must be the subject");
  if (tag(event, "trade") !== rating.tradeId.toString()) fail("tag_mismatch", "trade tag mismatch");
  if (tag(event, "score") !== String(rating.score)) fail("tag_mismatch", "score tag mismatch");
  if (tag(event, "network") !== network(rating.chainId)) fail("tag_mismatch", "network tag mismatch");

  if (!(await verifyBinding(binding, opts.publicClient))) fail("bad_binding", "wallet binding signature is invalid");
  if (!sameAddress(binding.address, rating.rater) || binding.nostrPubkey !== event.pubkey) {
    fail("binding_mismatch", "this Nostr key is not bound to the rater");
  }
  if (sameAddress(rating.rater, rating.subject)) fail("not_a_party", "a wallet cannot rate itself");

  // The expensive part to fake, and the only reason any of this counts for anything.
  const client = opts.publicClient;
  if (!client) return fail("unreadable_trade", "a chain client is required to check the trade");
  let trade: { seller: Address; buyer: Address; state: number };
  try {
    trade = (await client.readContract({
      address: rating.escrow,
      abi: escrowCoreV4Abi,
      functionName: "getTrade",
      args: [rating.tradeId],
    })) as unknown as { seller: Address; buyer: Address; state: number };
  } catch (e) {
    return fail("unreadable_trade", `could not read trade ${rating.tradeId}: ${(e as Error).message}`);
  }

  const parties = [trade.seller, trade.buyer];
  const raterIsParty = parties.some((p) => sameAddress(p, rating.rater));
  const subjectIsParty = parties.some((p) => sameAddress(p, rating.subject));
  if (!raterIsParty || !subjectIsParty) fail("not_a_party", "rater and subject must be the two parties of this trade");
  if (!FINISHED.has(Number(trade.state))) fail("trade_unfinished", "the trade has not finished yet");

  return { ...rating, event, binding };
}

function tag(event: Event, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

export interface RatingSummary {
  /** Verified ratings about this address. */
  total: number;
  positive: number;
  /** Share positive, or undefined until there is anything to divide. */
  rate?: number;
  /** Most-used tags, commonest first. */
  tags: { tag: RatingTag; count: number }[];
}

/** One rating per rater per trade; the newest event from a rater for a trade wins. */
export function summariseRatings(ratings: ParsedRating[], subject: Address): RatingSummary {
  const latest = new Map<string, ParsedRating>();
  for (const r of ratings) {
    if (!sameAddress(r.subject, subject)) continue;
    const key = ratingAddress(r.chainId, r.escrow, r.tradeId, r.rater);
    const prev = latest.get(key);
    if (!prev || r.event.created_at > prev.event.created_at) latest.set(key, r);
  }
  const all = [...latest.values()];
  const positive = all.filter((r) => r.score === 1).length;
  const counts = new Map<RatingTag, number>();
  for (const r of all) if (r.tag) counts.set(r.tag, (counts.get(r.tag) ?? 0) + 1);
  return {
    total: all.length,
    positive,
    rate: all.length > 0 ? positive / all.length : undefined,
    tags: [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count),
  };
}

// ─── Relays ───────────────────────────────────────────────────────────────────

/**
 * Discover and publish ratings, across the same relays offers travel over.
 *
 * Nothing here is a service: no ratings database, no moderation queue, no appeal. A rating is a signed
 * statement sitting on public relays, and this reads them and checks each one against the chain.
 *
 * The tradeoff of putting them on relays rather than on-chain: relays may drop old events, so a merchant's
 * history is only as durable as the relays keeping it, and a merchant with a bad record has an incentive to
 * find relays that have forgotten it. Reading from several relays is what makes that hard rather than
 * impossible. On-chain ratings would be permanent, and would cost gas and a contract change.
 */
export class RatingBook {
  readonly pool: SimplePool;

  constructor(
    readonly relays: string[],
    private readonly parseOptions: ParseRatingOptions = {},
    pool?: SimplePool
  ) {
    if (relays.length === 0) throw new Error("at least one relay is required");
    this.pool = pool ?? new SimplePool();
  }

  filter(subject?: Address): Filter {
    const f: Filter = { kinds: [RATING_EVENT_KIND], "#y": [PROTOCOL_TAG] };
    if (subject) f["#s"] = [subject.toLowerCase()];
    return f;
  }

  /** Every verified rating about `subject`. Unverifiable ones are reported, never silently counted. */
  async fetch(subject: Address, maxWaitMs = 3000): Promise<{ ratings: ParsedRating[]; rejected: { eventId: string; reason: string }[] }> {
    const events = await this.pool.querySync(this.relays, this.filter(subject), { maxWait: maxWaitMs });
    const rejected: { eventId: string; reason: string }[] = [];
    // Each rating costs a chain read to check the trade, so they go together rather than one at a time.
    const parsed = await Promise.all(
      events.map(async (event) => {
        try {
          return { ok: true as const, rating: await parseRatingEvent(event, this.parseOptions) };
        } catch (e) {
          return { ok: false as const, eventId: event.id, error: e };
        }
      })
    );
    const ratings: ParsedRating[] = [];
    for (const r of parsed) {
      if (r.ok) ratings.push(r.rating);
      else {
        const e = r.error;
        if (e instanceof RatingEventError && e.reason === "wrong_network") continue;
        rejected.push({ eventId: r.eventId, reason: e instanceof RatingEventError ? e.reason : String(e) });
      }
    }
    return { ratings, rejected };
  }

  async publish(event: VerifiedEvent): Promise<PublishResult[]> {
    const results = await settleWithin(this.pool.publish(this.relays, event), RELAY_PUBLISH_TIMEOUT_MS);
    return results.map((r, i) => ({
      relay: this.relays[i]!,
      ok: r.status === "fulfilled",
      message: r.status === "fulfilled" ? String(r.value) : String((r.reason as Error)?.message ?? r.reason),
    }));
  }

  close(): void {
    this.pool.close(this.relays);
  }
}
