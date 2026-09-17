// src/types.ts — shared SDK types.

import type { Address, Hex } from "viem";

/** Mirrors EscrowCoreV4.Offer exactly (uint64 fields are bigint, as viem encodes them). */
export interface Offer {
  seller: Address;
  token: Address;
  minAmount: bigint;
  maxAmount: bigint;
  totalAmount: bigint;
  paymentWindow: bigint;
  releaseWindow: bigint;
  arbitrator: Address;
  fallbackArbitrator: Address;
  termsHash: Hex;
  nonce: bigint;
  expiry: bigint;
  salt: Hex;
}

/**
 * Human terms the on-chain offer commits to via `termsHash`. Never contains the seller's bank
 * details — those are sent only to a buyer who has locked a trade, over encrypted chat.
 */
export interface OfferTerms {
  chainId: number;
  escrow: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  /** ISO 4217, e.g. "NGN" */
  fiatCurrency: string;
  /** Fiat per 1 whole token, decimal string, e.g. "1600.50" */
  price: string;
  /** Rail names only, e.g. ["bank-transfer", "opay"] */
  paymentMethods: string[];
  /** Optional free-text conditions, e.g. "Payer name must match wallet KYC name" */
  conditions?: string;
}

/** Wallet-signed statement that a Nostr pubkey speaks for a wallet address. */
export interface WalletBinding {
  address: Address;
  nostrPubkey: string; // 32-byte x-only hex, no 0x
  issuedAt: number; // unix seconds
  signature: Hex;
}

/** Anything that can sign EIP-712 data: a viem LocalAccount or a WalletClient with a hoisted account. */
export interface TypedDataSigner {
  signTypedData: (args: {
    domain: Record<string, unknown>;
    types: Record<string, readonly { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<Hex>;
}

/** Anything that can sign an EIP-191 personal message. */
export interface MessageSigner {
  signMessage: (args: { message: string }) => Promise<Hex>;
}

/** Nostr identity derived for a wallet. */
export interface NostrIdentity {
  secretKey: Uint8Array;
  publicKey: string;
}
