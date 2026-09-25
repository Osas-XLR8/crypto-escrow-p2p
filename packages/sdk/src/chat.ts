// src/chat.ts — end-to-end encrypted trade messages over Nostr (NIP-17 gift-wrapped DMs).
//
// Payment details (bank account, mobile money number) travel ONLY between buyer and seller.
// Gift wrapping (NIP-59) also hides who is talking to whom and when from relays.
// Every message is also sealed to the sender (NIP-17 practice), so your own side of the conversation
// survives reloads and appears on your other devices. EscrowX servers are never in this path.

import { wrapEvent, unwrapEvent } from "nostr-tools/nip17";
import { getPublicKey } from "nostr-tools/pure";
import type { Event } from "nostr-tools";
import type { SimplePool } from "nostr-tools/pool";
import type { Address } from "viem";
import { sameAddress, verifyBinding } from "./identity.js";
import type { NostrIdentity, WalletBinding } from "./types.js";
import { RELAY_PUBLISH_TIMEOUT_MS, settleWithin } from "./relayTimeout.js";

const GIFT_WRAP_KIND = 1059;
const CHAT_MESSAGE_KIND = 14;
const MAX_WRAP_BYTES = 64 * 1024;

export type TradeMessage =
  /** First message from each side: proves which wallet this Nostr key speaks for. */
  | { type: "hello"; tradeId: string; binding: WalletBinding }
  /** Seller → buyer. Never published anywhere else. */
  | { type: "payment_details"; tradeId: string; method: string; instructions: string; payeeName?: string }
  /** Buyer → seller, alongside the on-chain markPaid: an optional transfer reference to look for. */
  | { type: "payment_sent"; tradeId: string; reference?: string }
  | { type: "text"; tradeId: string; text: string };

export interface ReceivedMessage {
  /** Gift-wrap event id (unique per copy; use for de-duplication). */
  id: string;
  from: string; // sender Nostr pubkey (authenticated by the seal signature)
  createdAt: number;
  message: TradeMessage;
  /** Sent by me (my own sealed copy). */
  mine: boolean;
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
    case "payment_sent":
      return m.reference === undefined || (typeof m.reference === "string" && m.reference.length <= 500);
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
    return { id: wrap.id, from: rumor.pubkey, createdAt: rumor.created_at, message, mine: rumor.pubkey === getPublicKey(recipient.secretKey) };
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
    private readonly me: NostrIdentity,
    private readonly publishTimeoutMs = RELAY_PUBLISH_TIMEOUT_MS
  ) {}

  /**
   * Sends to the recipient, plus a copy sealed to myself so the conversation is complete on reload.
   * Returns how many relays accepted the recipient's copy (throws if none did).
   */
  async send(recipientPubkey: string, message: TradeMessage): Promise<number> {
    const wrap = wrapTradeMessage(this.me, recipientPubkey, message);
    const results = await settleWithin(this.pool.publish(this.relays, wrap), this.publishTimeoutMs);
    const delivered = results.filter((r) => r.status === "fulfilled").length;
    if (delivered === 0) throw new Error("no relay accepted the message — check your connection and try again");
    if (recipientPubkey !== this.me.publicKey && message.type !== "hello") {
      const own = wrapTradeMessage(this.me, this.me.publicKey, message);
      await settleWithin(this.pool.publish(this.relays, own), this.publishTimeoutMs); // best effort
    }
    return delivered;
  }

  /** Reads my inbox for a trade. Gift wraps use randomized timestamps, so no `since` filter is used. */
  async inbox(tradeId: bigint | number | string, maxWaitMs = 3000): Promise<ReceivedMessage[]> {
    const id = tradeIdKey(tradeId);
    return (await this.inboxAll(maxWaitMs)).filter((m) => m.message.tradeId === id);
  }

  /** Every trade message addressed to me (including my own copies), oldest first. */
  async inboxAll(maxWaitMs = 3000): Promise<ReceivedMessage[]> {
    const wraps = await this.pool.querySync(this.relays, { kinds: [GIFT_WRAP_KIND], "#p": [this.me.publicKey] }, { maxWait: maxWaitMs });
    const seen = new Set<string>();
    return wraps
      .filter((w) => (seen.has(w.id) ? false : (seen.add(w.id), true)))
      .map((w) => unwrapTradeMessage(this.me, w))
      .filter((m): m is ReceivedMessage => m !== null)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Live inbox: calls `onMessage` for every trade message addressed to me — stored ones first, then new
   * ones as they arrive. `onReady` fires once the relays have sent what they had stored. Returns a closer.
   */
  subscribe(onMessage: (m: ReceivedMessage) => void, onReady?: () => void): () => void {
    const seen = new Set<string>();
    const sub = this.pool.subscribeMany(this.relays, { kinds: [GIFT_WRAP_KIND], "#p": [this.me.publicKey] }, {
      onevent: (wrap) => {
        if (seen.has(wrap.id)) return;
        seen.add(wrap.id);
        const m = unwrapTradeMessage(this.me, wrap);
        if (m) onMessage(m);
      },
      oneose: () => onReady?.(),
    });
    return () => sub.close();
  }
}
