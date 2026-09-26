// src/lib/v4/local.ts — per-device storage and small protocol helpers.
// Nothing here is sent to any server. Everything is optional: if storage is blocked, flows still work
// (the user just re-enters or re-derives what's missing).

import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { parseOfferEvent, type OfferBook, type OfferSide, type ParsedOffer } from "@escrowx/sdk";
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

// ─── The offer behind a trade ─────────────────────────────────────────────────
//
// Price, currency and the maker's messaging key live in the signed offer on the relays, not on-chain.
// The trade's on-chain offerHash identifies it exactly (it's the event's d tag, which relays index).

export interface TradeTerms {
  price: string;
  fiatCurrency: string;
  paymentMethods: string[];
  /** Side of the offer the trade came from, and who made it. */
  side?: OfferSide;
  maker?: Address;
  /** Maker's wallet-bound messaging key, verified when the offer was parsed. */
  makerKey?: string;
}

export function rememberTradeTerms(tradeId: bigint, terms: TradeTerms) {
  set(`escrowx:terms:${scope}:${tradeId}`, JSON.stringify(terms));
}

/**
 * The transaction that opened a trade.
 *
 * Between `takeOffer` landing and the log index catching up there is a window — around fifteen seconds on
 * Base — where the app knows a trade exists but can read nothing about it. Keeping the hash means that
 * window can show the transaction instead of an apology.
 */
export function rememberTradeTx(tradeId: bigint, hash: string) {
  set(`escrowx:tx:${scope}:${tradeId}`, hash);
}

export function recallTradeTx(tradeId: bigint): string | null {
  const h = get(`escrowx:tx:${scope}:${tradeId}`);
  return h && /^0x[0-9a-fA-F]{64}$/.test(h) ? h : null;
}

export function recallTradeTerms(tradeId: bigint): TradeTerms | null {
  try {
    const t = JSON.parse(get(`escrowx:terms:${scope}:${tradeId}`) ?? "null") as TradeTerms | null;
    return t && /^\d+(\.\d+)?$/.test(t.price) && typeof t.fiatCurrency === "string" ? t : null;
  } catch {
    return null;
  }
}

export function termsFromOffer(o: ParsedOffer): TradeTerms {
  return { price: o.terms.price, fiatCurrency: o.terms.fiatCurrency, paymentMethods: o.terms.paymentMethods, side: o.side, maker: o.maker, makerKey: o.event.pubkey };
}

/** Finds and verifies the offer a trade was opened from (either side), by its on-chain offer hash. */
export async function findTradeOffer(book: OfferBook, offerHash: string): Promise<ParsedOffer | null> {
  const filter = { ...book.filter({ chainId: CHAIN_ID }), "#d": [offerHash.toLowerCase()] };
  const events = await book.pool.querySync(book.relays, filter, { maxWait: 3000 });
  for (const event of events) {
    try {
      const parsed = await parseOfferEvent(event, { chainId: CHAIN_ID, escrow: V4.escrow, now: null });
      if (parsed.offerHash.toLowerCase() === offerHash.toLowerCase()) return parsed;
    } catch {
      /* ignore invalid events */
    }
  }
  return null;
}

// ─── Chat bookkeeping (per device) ────────────────────────────────────────────

/** Whether this wallet already introduced its messaging key for a trade (sent once per trade). */
export function helloSent(tradeId: bigint, me: string): boolean {
  return get(`escrowx:hello:${scope}:${me.toLowerCase()}:${tradeId}`) === "1";
}

export function markHelloSent(tradeId: bigint, me: string) {
  set(`escrowx:hello:${scope}:${me.toLowerCase()}:${tradeId}`, "1");
}

/** Timestamp (message createdAt) up to which a trade's chat has been read on this device. */
export function lastRead(tradeId: string, me: string): number {
  return Number(get(`escrowx:read:${scope}:${me.toLowerCase()}:${tradeId}`) ?? 0);
}

export function markRead(tradeId: string, me: string, at: number) {
  if (at > lastRead(tradeId, me)) set(`escrowx:read:${scope}:${me.toLowerCase()}:${tradeId}`, String(at));
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
