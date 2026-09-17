// src/offerBook.ts — discover and publish offers across any set of Nostr relays.
// No company-run matching engine: any relay works, anyone can run one, clients verify everything.

import { SimplePool } from "nostr-tools/pool";
import type { Event, Filter } from "nostr-tools";
import { OFFER_EVENT_KIND, OfferEventError, PROTOCOL_TAG, network, parseOfferEvent, type ParseOptions, type ParsedOffer } from "./offerEvents.js";

export interface OfferQuery {
  chainId: number;
  fiatCurrency?: string;
  seller?: string; // wallet address, filtered after verification
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

  constructor(
    readonly relays: string[],
    private readonly parseOptions: Omit<ParseOptions, "chainId"> = {},
    pool?: SimplePool
  ) {
    if (relays.length === 0) throw new Error("at least one relay is required");
    this.pool = pool ?? new SimplePool();
  }

  filter(q: OfferQuery): Filter {
    const f: Filter = { kinds: [OFFER_EVENT_KIND], "#y": [PROTOCOL_TAG], "#network": [network(q.chainId)] };
    if (q.fiatCurrency) f["#f"] = [q.fiatCurrency];
    if (q.limit) f.limit = q.limit;
    return f;
  }

  async publish(event: Event): Promise<PublishResult[]> {
    const results = await Promise.allSettled(this.pool.publish(this.relays, event));
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

    for (const event of events) {
      try {
        const parsed = await parseOfferEvent(event, { ...this.parseOptions, chainId: q.chainId });
        if (q.seller && parsed.offer.seller.toLowerCase() !== q.seller.toLowerCase()) continue;
        // Addressable-event semantics: newest event per (author, offer hash) wins.
        const key = `${event.pubkey}:${parsed.offerHash}`;
        const prev = latest.get(key);
        if (!prev || event.created_at > prev.event.created_at) latest.set(key, parsed);
      } catch (e) {
        rejected.push({ eventId: event.id, reason: e instanceof OfferEventError ? e.reason : String((e as Error).message) });
      }
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
            if (q.seller && parsed.offer.seller.toLowerCase() !== q.seller.toLowerCase()) return;
            onOffer(parsed);
          })
          .catch((e) => onRejected?.(event.id, e instanceof OfferEventError ? e.reason : String(e)));
      },
    });
    return () => sub.close();
  }

  close(): void {
    this.pool.close(this.relays);
  }
}
