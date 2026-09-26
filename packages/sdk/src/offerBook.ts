// src/offerBook.ts — discover and publish offers across any set of Nostr relays.
// No company-run matching engine: any relay works, anyone can run one, clients verify everything.

import { SimplePool } from "nostr-tools/pool";
import type { Event, Filter } from "nostr-tools";
import { OFFER_EVENT_KIND, OfferEventError, PROTOCOL_TAG, parseOfferEvent, type ParseOptions, type ParsedOffer } from "./offerEvents.js";
import { RELAY_PUBLISH_TIMEOUT_MS, settleWithin } from "./relayTimeout.js";
import type { OfferSide } from "./types.js";

export interface OfferQuery {
  chainId: number;
  fiatCurrency?: string;
  /** "sell" offers are what buyers browse; "buy" offers are what sellers browse. Both when omitted. */
  side?: OfferSide;
  /** Wallet address of the offer's maker, filtered after verification. */
  maker?: string;
  /** @deprecated use `maker` */
  seller?: string;
  limit?: number;
}

export interface OfferQueryResult {
  offers: ParsedOffer[];
  rejected: { eventId: string; reason: string }[];
}

export interface PublishResult {
  relay: string;
  ok: boolean;
  message: string;
}

export class OfferBook {
  readonly pool: SimplePool;
  /** eventId → the verdict we already reached for it. Bounded; oldest entries drop first. */
  private readonly verified = new Map<string, { offer: ParsedOffer } | { error: unknown }>();
  private static readonly MAX_VERIFIED = 500;

  constructor(
    readonly relays: string[],
    private readonly parseOptions: Omit<ParseOptions, "chainId"> = {},
    pool?: SimplePool
  ) {
    if (relays.length === 0) throw new Error("at least one relay is required");
    this.pool = pool ?? new SimplePool();
  }

  /**
   * Relay query. Relays only index single-letter tags (NIP-01), so the network is NOT part of the filter —
   * a `#network` filter matches nothing on real relays. The chain and escrow are checked per event instead.
   */
  filter(q: OfferQuery): Filter {
    const f: Filter = { kinds: [OFFER_EVENT_KIND], "#y": [PROTOCOL_TAG] };
    if (q.side) f["#k"] = [q.side];
    if (q.fiatCurrency) f["#f"] = [q.fiatCurrency];
    if (q.limit) f.limit = q.limit;
    return f;
  }

  async publish(event: Event, timeoutMs = RELAY_PUBLISH_TIMEOUT_MS): Promise<PublishResult[]> {
    const results = await settleWithin(this.pool.publish(this.relays, event), timeoutMs);
    return results.map((r, i) => ({
      relay: this.relays[i]!,
      ok: r.status === "fulfilled",
      message: r.status === "fulfilled" ? String(r.value) : String((r.reason as Error)?.message ?? r.reason),
    }));
  }

  /**
   * Fetches, verifies and de-duplicates offers. Invalid or forged events are returned in `rejected`
   * (never silently trusted). Only the newest version of each offer is kept, and canceled offers are dropped.
   */
  async fetch(q: OfferQuery, maxWaitMs = 3000): Promise<OfferQueryResult> {
    const events = await this.pool.querySync(this.relays, this.filter(q), { maxWait: maxWaitMs });
    return this.verify(events, q);
  }

  async verify(events: Event[], q: OfferQuery): Promise<OfferQueryResult> {
    const latest = new Map<string, ParsedOffer>();
    const rejected: OfferQueryResult["rejected"] = [];

    // Verifying every offer before showing any is unavoidable — an unverified offer is not an offer. Doing
    // it one at a time was not: each event costs two chain round trips (the maker's signature and their
    // wallet binding, both of which may be contract wallets), so a serial loop turned a market of twenty
    // offers into forty sequential requests and several seconds of skeletons. They do not depend on each
    // other, so they all go at once and the wait becomes one round trip rather than 2N.
    const parsed = await Promise.all(
      events.map(async (event) => {
        // A Nostr event is immutable and content-addressed by its id, so whether it verifies is a fact
        // about the event, not about when we asked. Re-checking one we have already seen costs the same
        // two chain round trips and can only produce the same answer — so switching currency and back, or
        // a relay resending what another already sent, is free after the first time.
        const seen = this.verified.get(event.id);
        if (seen) return "error" in seen ? { event, error: seen.error } : { event, offer: seen.offer };
        try {
          const offer = await parseOfferEvent(event, { ...this.parseOptions, chainId: q.chainId });
          this.remember(event.id, { offer });
          return { event, offer };
        } catch (e) {
          // Only cache a verdict about the event itself. "Expired" is a verdict about the clock, and
          // "wrong_network" about the query, and both can differ on the next call with the same event.
          if (e instanceof OfferEventError && e.reason !== "expired" && e.reason !== "wrong_network") {
            this.remember(event.id, { error: e });
          }
          return { event, error: e };
        }
      })
    );

    // Second pass, in the relays' order, so dedupe and rejection order stay deterministic.
    for (const r of parsed) {
      if ("error" in r) {
        const e = r.error;
        // Offers for another chain or escrow deployment share the protocol tag; they're not ours, not forged.
        if (e instanceof OfferEventError && e.reason === "wrong_network") continue;
        rejected.push({ eventId: r.event.id, reason: e instanceof OfferEventError ? e.reason : String((e as Error).message) });
        continue;
      }
      const offer = r.offer;
      const maker = q.maker ?? q.seller;
      if (maker && offer.maker.toLowerCase() !== maker.toLowerCase()) continue;
      if (q.side && offer.side !== q.side) continue;
      // Addressable-event semantics: newest event per (author, offer hash) wins.
      const key = `${r.event.pubkey}:${offer.offerHash}`;
      const prev = latest.get(key);
      if (!prev || r.event.created_at > prev.event.created_at) latest.set(key, offer);
    }

    const offers = [...latest.values()].filter((o) => o.status === "pending");
    return { offers, rejected };
  }

  /** Live updates. Returns a function that closes the subscription. */
  subscribe(q: OfferQuery, onOffer: (offer: ParsedOffer) => void, onRejected?: (eventId: string, reason: string) => void): () => void {
    const sub = this.pool.subscribeMany(this.relays, this.filter(q), {
      onevent: (event) => {
        parseOfferEvent(event, { ...this.parseOptions, chainId: q.chainId })
          .then((parsed) => {
            const maker = q.maker ?? q.seller;
            if (maker && parsed.maker.toLowerCase() !== maker.toLowerCase()) return;
            if (q.side && parsed.side !== q.side) return;
            onOffer(parsed);
          })
          .catch((e) => {
            if (e instanceof OfferEventError && e.reason === "wrong_network") return;
            onRejected?.(event.id, e instanceof OfferEventError ? e.reason : String(e));
          });
      },
    });
    return () => sub.close();
  }

  private remember(id: string, verdict: { offer: ParsedOffer } | { error: unknown }) {
    if (this.verified.size >= OfferBook.MAX_VERIFIED) {
      const oldest = this.verified.keys().next().value;
      if (oldest !== undefined) this.verified.delete(oldest);
    }
    this.verified.set(id, verdict);
  }

  close(): void {
    this.pool.close(this.relays);
  }
}
