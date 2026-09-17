// src/chat.ts — end-to-end encrypted trade messages over Nostr (NIP-17 gift-wrapped DMs).
//
// Payment details (bank account, mobile money number) travel ONLY between buyer and seller.
// Gift wrapping (NIP-59) also hides who is talking to whom and when from relays.
// EscrowX servers are never in this path.

import { wrapEvent, unwrapEvent } from "nostr-tools/nip17";
import type { Event } from "nostr-tools";
import type { SimplePool } from "nostr-tools/pool";
import type { Address } from "viem";
import { sameAddress, verifyBinding } from "./identity.js";
import type { NostrIdentity, WalletBinding } from "./types.js";

const GIFT_WRAP_KIND = 1059;
const CHAT_MESSAGE_KIND = 14;
const MAX_WRAP_BYTES = 64 * 1024;

export type TradeMessage =
  /** First message from each side: proves which wallet this Nostr key speaks for. */
  | { type: "hello"; tradeId: string; binding: WalletBinding }
  /** Seller → buyer. Never published anywhere else. */
  | { type: "payment_details"; tradeId: string; method: string; instructions: string; payeeName?: string }
  | { type: "text"; tradeId: string; text: string };

export interface ReceivedMessage {
  from: string; // sender Nostr pubkey (authenticated by the seal signature)
  createdAt: number;
  message: TradeMessage;
}

export function tradeIdKey(tradeId: bigint | number | string): string {
  return BigInt(tradeId).toString();
}

function isTradeMessage(v: unknown): v is TradeMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  if (typeof m.tradeId !== "string" || !/^\d{1,78}$/.test(m.tradeId)) return false;
  switch (m.type) {
    case "hello":
      return !!m.binding && typeof m.binding === "object";
    case "payment_details":
      return typeof m.method === "string" && typeof m.instructions === "string" && m.instructions.length <= 2000;
    case "text":
      return typeof m.text === "string" && m.text.length <= 4000;
    default:
      return false;
  }
}

/** Builds the gift wrap for one recipient (no network). */
export function wrapTradeMessage(sender: NostrIdentity, recipientPubkey: string, message: TradeMessage): Event {
  if (!isTradeMessage(message)) throw new Error("invalid trade message");
  return wrapEvent(sender.secretKey, { publicKey: recipientPubkey }, JSON.stringify({ escrowx: 1, ...message }), `escrowx-trade-${message.tradeId}`);
}

/** Opens a gift wrap addressed to `recipient`. Returns null for anything that isn't a valid trade message. */
export function unwrapTradeMessage(recipient: NostrIdentity, wrap: Event): ReceivedMessage | null {
  if (wrap.kind !== GIFT_WRAP_KIND || wrap.content.length > MAX_WRAP_BYTES) return null;
  try {
    const rumor = unwrapEvent(wrap, recipient.secretKey);
    if (rumor.kind !== CHAT_MESSAGE_KIND) return null;
    const body = JSON.parse(rumor.content) as Record<string, unknown>;
    if (body.escrowx !== 1) return null;
    const { escrowx: _v, ...message } = body;
    if (!isTradeMessage(message)) return null;
    return { from: rumor.pubkey, createdAt: rumor.created_at, message };
  } catch {
    return null; // not for us, or tampered
  }
}

/**
 * Checks a "hello" really comes from the on-chain counterparty: the binding must be valid, bound to
 * the expected wallet (e.g. trade.buyer read from the contract), and to the key that sent the message.
 */
export async function verifyHello(received: ReceivedMessage, expectedWallet: Address): Promise<boolean> {
  if (received.message.type !== "hello") return false;
  const { binding } = received.message;
  return (
    sameAddress(binding.address, expectedWallet) &&
    binding.nostrPubkey === received.from &&
    (await verifyBinding(binding))
  );
}

export class TradeChat {
  constructor(
    private readonly pool: SimplePool,
    private readonly relays: string[],
    private readonly me: NostrIdentity
  ) {}

  async send(recipientPubkey: string, message: TradeMessage): Promise<number> {
    const wrap = wrapTradeMessage(this.me, recipientPubkey, message);
    const results = await Promise.allSettled(this.pool.publish(this.relays, wrap));
    const delivered = results.filter((r) => r.status === "fulfilled").length;
    if (delivered === 0) throw new Error("message was not accepted by any relay");
    return delivered;
  }

  /** Reads my inbox for a trade. Gift wraps use randomized timestamps, so no `since` filter is used. */
  async inbox(tradeId: bigint | number | string, maxWaitMs = 3000): Promise<ReceivedMessage[]> {
    const id = tradeIdKey(tradeId);
    const wraps = await this.pool.querySync(this.relays, { kinds: [GIFT_WRAP_KIND], "#p": [this.me.publicKey] }, { maxWait: maxWaitMs });
    const seen = new Set<string>();
    return wraps
      .filter((w) => (seen.has(w.id) ? false : (seen.add(w.id), true)))
      .map((w) => unwrapTradeMessage(this.me, w))
      .filter((m): m is ReceivedMessage => m !== null && m.message.tradeId === id)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
}
