// src/offers.ts — EIP-712 offers compatible with EscrowCoreV4, and canonical terms hashing.

import {
  hashTypedData,
  keccak256,
  toBytes,
  toHex,
  verifyTypedData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { Offer, OfferTerms, TypedDataSigner } from "./types.js";

export const OFFER_TYPES = {
  Offer: [
    { name: "seller", type: "address" },
    { name: "token", type: "address" },
    { name: "minAmount", type: "uint256" },
    { name: "maxAmount", type: "uint256" },
    { name: "totalAmount", type: "uint256" },
    { name: "paymentWindow", type: "uint64" },
    { name: "releaseWindow", type: "uint64" },
    { name: "arbitrator", type: "address" },
    { name: "fallbackArbitrator", type: "address" },
    { name: "termsHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

/** Bounds enforced by EscrowCoreV4; checked client-side so invalid offers are never published. */
export const WINDOW_BOUNDS = {
  paymentWindow: { min: 10n * 60n, max: 3n * 3600n },
  releaseWindow: { min: 30n * 60n, max: 24n * 3600n },
} as const;

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export function offerDomain(chainId: number, escrow: Address) {
  return { name: "EscrowX", version: "4", chainId, verifyingContract: escrow } as const;
}

/** Same digest as EscrowCoreV4.hashOffer(offer). Also used as the offer's public id. */
export function hashOffer(offer: Offer, chainId: number, escrow: Address): Hex {
  return hashTypedData({ domain: offerDomain(chainId, escrow), types: OFFER_TYPES, primaryType: "Offer", message: offer });
}

// ─── Terms ────────────────────────────────────────────────────────────────────

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashTerms(terms: OfferTerms): Hex {
  return keccak256(toBytes(canonicalJson(terms)));
}

export function validateTerms(terms: OfferTerms): void {
  if (!/^[A-Z]{3}$/.test(terms.fiatCurrency)) throw new Error("fiatCurrency must be an ISO 4217 code");
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(terms.price) || /^0+(\.0+)?$/.test(terms.price)) {
    throw new Error("price must be a positive decimal string with up to 6 decimals");
  }
  if (terms.paymentMethods.length === 0) throw new Error("at least one payment method is required");
  if (!Number.isInteger(terms.tokenDecimals) || terms.tokenDecimals < 0 || terms.tokenDecimals > 36) {
    throw new Error("tokenDecimals out of range");
  }
}

// ─── Building & signing ───────────────────────────────────────────────────────

export interface CreateOfferParams {
  seller: Address;
  token: Address;
  minAmount: bigint;
  maxAmount: bigint;
  totalAmount: bigint;
  paymentWindow: bigint;
  releaseWindow: bigint;
  arbitrator: Address;
  fallbackArbitrator: Address;
  nonce: bigint;
  /** Unix seconds */
  expiry: bigint;
  terms: OfferTerms;
  salt?: Hex;
}

/** Builds an offer that satisfies every static check EscrowCoreV4.takeOffer performs. */
export function createOffer(p: CreateOfferParams): Offer {
  validateTerms(p.terms);
  if (p.minAmount <= 0n || p.minAmount > p.maxAmount) throw new Error("require 0 < minAmount <= maxAmount");
  if (p.maxAmount > p.totalAmount) throw new Error("maxAmount must not exceed totalAmount");
  for (const key of ["paymentWindow", "releaseWindow"] as const) {
    const { min, max } = WINDOW_BOUNDS[key];
    if (p[key] < min || p[key] > max) throw new Error(`${key} must be between ${min} and ${max} seconds`);
  }
  if (p.arbitrator.toLowerCase() === p.fallbackArbitrator.toLowerCase()) {
    throw new Error("fallback arbitrator must differ from the primary");
  }

  const salt = p.salt ?? toHex(crypto.getRandomValues(new Uint8Array(32)));
  return {
    seller: p.seller,
    token: p.token,
    minAmount: p.minAmount,
    maxAmount: p.maxAmount,
    totalAmount: p.totalAmount,
    paymentWindow: p.paymentWindow,
    releaseWindow: p.releaseWindow,
    arbitrator: p.arbitrator,
    fallbackArbitrator: p.fallbackArbitrator,
    termsHash: hashTerms(p.terms),
    nonce: p.nonce,
    expiry: p.expiry,
    salt,
  };
}

export async function signOffer(signer: TypedDataSigner, offer: Offer, chainId: number, escrow: Address): Promise<Hex> {
  return signer.signTypedData({
    domain: offerDomain(chainId, escrow),
    types: OFFER_TYPES,
    primaryType: "Offer",
    message: offer as unknown as Record<string, unknown>,
  });
}

/**
 * Verifies the seller's signature the way the contract will.
 * - Without a client: EOA signatures only.
 * - With a client: also ERC-1271 smart-contract wallets.
 * High-s signatures are rejected because EscrowCoreV4 rejects them.
 */
export async function verifyOfferSignature(
  offer: Offer,
  signature: Hex,
  chainId: number,
  escrow: Address,
  publicClient?: PublicClient
): Promise<boolean> {
  if (signature.length === 132) {
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    if (s > SECP256K1_HALF_N) return false;
  }
  const args = {
    address: offer.seller,
    domain: offerDomain(chainId, escrow),
    types: OFFER_TYPES,
    primaryType: "Offer" as const,
    message: offer,
    signature,
  };
  try {
    // Cast: the client overload set (block-tag variants) does not narrow from this literal.
    return publicClient ? await publicClient.verifyTypedData(args as never) : await verifyTypedData(args);
  } catch {
    return false;
  }
}

// ─── JSON transport (bigint-safe) ─────────────────────────────────────────────

export type SerializedOffer = { [K in keyof Offer]: string };

const BIGINT_FIELDS = ["minAmount", "maxAmount", "totalAmount", "paymentWindow", "releaseWindow", "nonce", "expiry"] as const;

export function serializeOffer(offer: Offer): SerializedOffer {
  const out = {} as SerializedOffer;
  for (const [k, v] of Object.entries(offer)) (out as Record<string, string>)[k] = typeof v === "bigint" ? v.toString() : String(v);
  return out;
}

export function deserializeOffer(raw: unknown): Offer {
  if (!raw || typeof raw !== "object") throw new Error("offer must be an object");
  const r = raw as Record<string, unknown>;
  const addr = (k: string): Address => {
    const v = r[k];
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`offer.${k} must be an address`);
    return v as Address;
  };
  const b32 = (k: string): Hex => {
    const v = r[k];
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`offer.${k} must be bytes32`);
    return v as Hex;
  };
  const uint = (k: (typeof BIGINT_FIELDS)[number]): bigint => {
    const v = r[k];
    if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) throw new Error(`offer.${k} must be a decimal integer string`);
    return BigInt(v);
  };
  return {
    seller: addr("seller"),
    token: addr("token"),
    minAmount: uint("minAmount"),
    maxAmount: uint("maxAmount"),
    totalAmount: uint("totalAmount"),
    paymentWindow: uint("paymentWindow"),
    releaseWindow: uint("releaseWindow"),
    arbitrator: addr("arbitrator"),
    fallbackArbitrator: addr("fallbackArbitrator"),
    termsHash: b32("termsHash"),
    nonce: uint("nonce"),
    expiry: uint("expiry"),
    salt: b32("salt"),
  };
}
