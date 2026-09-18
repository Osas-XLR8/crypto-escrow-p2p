// src/lib/v4/local.ts — per-device storage and small protocol helpers.
// Nothing here is sent to any server. Everything is optional: if storage is blocked, flows still work
// (the user just re-enters or re-derives what's missing).

import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { parseOfferEvent, type OfferBook } from "@escrowx/sdk";
import { CHAIN_ID, V4 } from "@/config/v4";

const scope = `${CHAIN_ID}:${V4.escrow.toLowerCase()}`;

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function set(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// ─── Counterparty messaging keys ──────────────────────────────────────────────

export function rememberPeerKey(tradeId: bigint, pubkey: string) {
  set(`escrowx:peer:${scope}:${tradeId}`, pubkey);
}

export function recallPeerKey(tradeId: bigint): string | null {
  const v = get(`escrowx:peer:${scope}:${tradeId}`);
  return v && /^[0-9a-f]{64}$/.test(v) ? v : null;
}

/** Finds the seller's wallet-bound Nostr key from any of their verified offer events on the relays. */
export async function findSellerKey(book: OfferBook, seller: Address): Promise<string | null> {
  const events = await book.pool.querySync(book.relays, book.filter({ chainId: CHAIN_ID }), { maxWait: 3000 });
  for (const event of events) {
    try {
      const parsed = await parseOfferEvent(event, { chainId: CHAIN_ID, escrow: V4.escrow, now: null });
      if (parsed.offer.seller.toLowerCase() === seller.toLowerCase()) return event.pubkey;
    } catch {
      /* ignore invalid events */
    }
  }
  return null;
}

// ─── Offer terms behind a trade (price + currency live off-chain, in the signed offer) ──

export interface TradeTerms {
  price: string;
  fiatCurrency: string;
  paymentMethods: string[];
}

export function rememberTradeTerms(tradeId: bigint, terms: TradeTerms) {
  set(`escrowx:terms:${scope}:${tradeId}`, JSON.stringify(terms));
}

export function recallTradeTerms(tradeId: bigint): TradeTerms | null {
  try {
    const t = JSON.parse(get(`escrowx:terms:${scope}:${tradeId}`) ?? "null") as TradeTerms | null;
    return t && /^\d+(\.\d+)?$/.test(t.price) && typeof t.fiatCurrency === "string" ? t : null;
  } catch {
    return null;
  }
}

/** Finds the terms of the seller's signed offer a trade was opened from (matched by offer hash). */
export async function findTradeTerms(book: OfferBook, seller: Address, offerHash: string): Promise<TradeTerms | null> {
  const events = await book.pool.querySync(book.relays, book.filter({ chainId: CHAIN_ID }), { maxWait: 3000 });
  for (const event of events) {
    try {
      const parsed = await parseOfferEvent(event, { chainId: CHAIN_ID, escrow: V4.escrow, now: null });
      if (parsed.offerHash.toLowerCase() === offerHash.toLowerCase() && parsed.offer.seller.toLowerCase() === seller.toLowerCase()) {
        return { price: parsed.terms.price, fiatCurrency: parsed.terms.fiatCurrency, paymentMethods: parsed.terms.paymentMethods };
      }
    } catch {
      /* ignore invalid events */
    }
  }
  return null;
}

// ─── Buyer's encrypted payment evidence (kept on this device) ─────────────────

export interface StoredEvidence {
  commitment: Hex;
  keyHex: Hex;
  ciphertextB64: string;
  fileName: string;
  mimeType: string;
}

const MAX_STORED_BYTES = 2 * 1024 * 1024;

export function storeEvidence(tradeId: bigint, ev: { commitment: Hex; keyHex: Hex; ciphertext: Uint8Array; fileName: string; mimeType: string }): boolean {
  if (ev.ciphertext.length > MAX_STORED_BYTES) return false;
  let binary = "";
  for (const b of ev.ciphertext) binary += String.fromCharCode(b);
  const record: StoredEvidence = { commitment: ev.commitment, keyHex: ev.keyHex, ciphertextB64: btoa(binary), fileName: ev.fileName, mimeType: ev.mimeType };
  return set(`escrowx:evidence:${scope}:${tradeId}`, JSON.stringify(record));
}

export function loadEvidence(tradeId: bigint): (StoredEvidence & { ciphertext: Uint8Array }) | null {
  const raw = get(`escrowx:evidence:${scope}:${tradeId}`);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as StoredEvidence;
    const bin = atob(r.ciphertextB64);
    const ciphertext = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) ciphertext[i] = bin.charCodeAt(i);
    return { ...r, ciphertext };
  } catch {
    return null;
  }
}

export function downloadBytes(bytes: Uint8Array, fileName: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Amounts ──────────────────────────────────────────────────────────────────

export function parseTokenInput(value: string): bigint | null {
  if (!/^\d+(\.\d{0,6})?$/.test(value.trim())) return null;
  try {
    const v = parseUnits(value.trim(), V4.tokenDecimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export function fmtToken(raw: bigint): string {
  return Number(formatUnits(raw, V4.tokenDecimals)).toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/** Fiat owed for `raw` token units at a decimal `price`, formatted for display. */
export function fmtFiat(raw: bigint, price: string, currency: string): string {
  const value = Number(formatUnits(raw, V4.tokenDecimals)) * Number(price);
  try {
    return value.toLocaleString("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: 0, maximumFractionDigits: 2 });
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}
