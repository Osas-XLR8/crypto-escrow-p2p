// src/offerEvents.ts — offers as Nostr events (NIP-69-style addressable "order" events).
//
// An offer event is trustworthy only if ALL of these hold, and parseOfferEvent checks every one:
//   1. the Nostr event signature is valid
//   2. the EIP-712 offer signature is valid for offer.seller (what the contract will check)
//   3. offer.termsHash commits to the published human terms (price, currency, rails)
//   4. a wallet-signed binding says this Nostr key speaks for offer.seller
//      (otherwise anyone could republish a seller's offer and intercept buyers' messages)
//   5. tags agree with the content, and the offer is for the expected chain/escrow

import { finalizeEvent, verifyEvent, type Event, type VerifiedEvent } from "nostr-tools/pure";
import type { Address, Hex, PublicClient } from "viem";
import { deserializeOffer, hashOffer, hashTerms, serializeOffer, validateTerms, verifyOfferSignature } from "./offers.js";
import { sameAddress, verifyBinding } from "./identity.js";
import type { NostrIdentity, Offer, OfferTerms, WalletBinding } from "./types.js";

/** NIP-69 peer-to-peer order event kind (addressable, replaced by pubkey + kind + d). */
export const OFFER_EVENT_KIND = 38383;
export const PROTOCOL_TAG = "escrowx";
export const LAYER_TAG = "escrowx-v4";

export type OfferStatus = "pending" | "canceled";

export interface ParsedOffer {
  event: Event;
  offerHash: Hex;
  offer: Offer;
  signature: Hex;
  terms: OfferTerms;
  binding: WalletBinding;
  status: OfferStatus;
}

export type OfferRejection =
  | "bad_nostr_signature"
  | "wrong_kind"
  | "malformed_content"
  | "wrong_network"
  | "terms_mismatch"
  | "bad_offer_signature"
  | "bad_binding"
  | "binding_mismatch"
  | "tag_mismatch"
  | "expired";

export class OfferEventError extends Error {
  constructor(readonly reason: OfferRejection, message: string) {
    super(message);
  }
}

export function network(chainId: number): string {
  return `eip155:${chainId}`;
}

export function buildOfferEvent(args: {
  offer: Offer;
  signature: Hex;
  terms: OfferTerms;
  binding: WalletBinding;
  identity: NostrIdentity;
  status?: OfferStatus;
  createdAt?: number;
}): VerifiedEvent {
  const { offer, signature, terms, binding, identity } = args;
  validateTerms(terms);
  if (hashTerms(terms) !== offer.termsHash) throw new Error("offer.termsHash does not match terms");
  if (!sameAddress(binding.address, offer.seller)) throw new Error("binding is for a different wallet");
  if (binding.nostrPubkey !== identity.publicKey) throw new Error("binding is for a different Nostr key");

  const offerHash = hashOffer(offer, terms.chainId, terms.escrow);
  return finalizeEvent(
    {
      kind: OFFER_EVENT_KIND,
      created_at: args.createdAt ?? Math.floor(Date.now() / 1000),
      tags: [
        ["d", offerHash],
        ["k", "sell"],
        ["f", terms.fiatCurrency],
        ["s", args.status ?? "pending"],
        ["pm", ...terms.paymentMethods],
        ["price", terms.price],
        ["token", terms.tokenSymbol],
        ["network", network(terms.chainId)],
        ["layer", LAYER_TAG],
        ["expiration", offer.expiry.toString()],
        ["y", PROTOCOL_TAG],
        ["z", "order"],
      ],
      content: JSON.stringify({ v: 1, offer: serializeOffer(offer), signature, terms, binding }),
    },
    identity.secretKey
  );
}

const tag = (event: Event, name: string): string[] | undefined => event.tags.find((t) => t[0] === name);

/**
 * nostr-tools' verifyEvent caches "verified" in a symbol property on the event object, and object
 * spread copies symbol properties — so a tampered clone of a verified event would skip the check.
 * Rebuild a plain object from the NIP-01 fields only, so the id and signature are always recomputed.
 */
export function verifyEventStrict(event: Event): boolean {
  if (!event || typeof event !== "object" || !Array.isArray(event.tags)) return false;
  const { id, pubkey, created_at, kind, tags, content, sig } = event;
  return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig });
}

export interface ParseOptions {
  chainId?: number;
  escrow?: Address;
  /** Enables ERC-1271 smart-wallet signature checks. */
  publicClient?: PublicClient;
  /** Unix seconds; defaults to now. Pass null to skip the expiry check. */
  now?: number | null;
}

export async function parseOfferEvent(event: Event, opts: ParseOptions = {}): Promise<ParsedOffer> {
  const fail = (reason: OfferRejection, message: string): never => {
    throw new OfferEventError(reason, message);
  };

  if (event.kind !== OFFER_EVENT_KIND) fail("wrong_kind", `expected kind ${OFFER_EVENT_KIND}`);
  if (!verifyEventStrict(event)) fail("bad_nostr_signature", "Nostr event signature is invalid");

  let body: { v?: unknown; offer?: unknown; signature?: unknown; terms?: unknown; binding?: unknown };
  let offer!: Offer;
  let terms!: OfferTerms;
  try {
    body = JSON.parse(event.content);
    if (body.v !== 1) throw new Error("unsupported version");
    offer = deserializeOffer(body.offer);
    terms = body.terms as OfferTerms;
    validateTerms(terms);
    if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.signature)) throw new Error("bad signature field");
  } catch (e) {
    return fail("malformed_content", `malformed offer content: ${(e as Error).message}`);
  }
  const signature = body!.signature as Hex;
  const binding = body!.binding as WalletBinding;

  if (opts.chainId !== undefined && terms.chainId !== opts.chainId) fail("wrong_network", `offer is for chain ${terms.chainId}`);
  if (opts.escrow && !sameAddress(terms.escrow, opts.escrow)) fail("wrong_network", "offer is for a different escrow contract");

  if (hashTerms(terms) !== offer.termsHash) fail("terms_mismatch", "published terms do not match the signed termsHash");

  const offerHash = hashOffer(offer, terms.chainId, terms.escrow);
  if (!(await verifyOfferSignature(offer, signature, terms.chainId, terms.escrow, opts.publicClient))) {
    fail("bad_offer_signature", "offer is not signed by its seller");
  }

  if (!(await verifyBinding(binding, opts.publicClient))) fail("bad_binding", "wallet binding signature is invalid");
  if (!sameAddress(binding.address, offer.seller) || binding.nostrPubkey !== event.pubkey) {
    fail("binding_mismatch", "this Nostr key is not bound to the offer's seller");
  }

  if (tag(event, "d")?.[1] !== offerHash) fail("tag_mismatch", "d tag must equal the offer hash");
  if (tag(event, "f")?.[1] !== terms.fiatCurrency) fail("tag_mismatch", "f tag must equal the fiat currency");
  if (tag(event, "network")?.[1] !== network(terms.chainId)) fail("tag_mismatch", "network tag mismatch");
  const statusTag = tag(event, "s")?.[1];
  if (statusTag !== "pending" && statusTag !== "canceled") fail("tag_mismatch", "unknown status");

  const now = opts.now === undefined ? Math.floor(Date.now() / 1000) : opts.now;
  if (now !== null && BigInt(now) > offer.expiry) fail("expired", "offer has expired");

  return { event, offerHash, offer, signature, terms, binding, status: statusTag as OfferStatus };
}

/**
 * Replaces a published offer with a "canceled" status. Relays and clients will hide it, but a copy
 * of the signed offer may still exist — for a hard guarantee also call EscrowCoreV4.cancelOffer
 * (or bumpNonce to cancel everything).
 */
export function buildCancelEvent(parsed: ParsedOffer, identity: NostrIdentity): VerifiedEvent {
  return buildOfferEvent({ ...parsed, identity, status: "canceled" });
}
