// src/lib/tradeIndex.ts
// Rebuilds every trade's current state and history purely from escrow events.
// No React / network code here so it can be reasoned about (and tested) in isolation.

export type Hex = `0x${string}`;

export enum TradeState {
  NONE = 0,
  CREATED = 1,
  LOCKED = 2,
  RELEASED = 3,
  REFUNDED = 4,
  DISPUTE = 5,
}

export type EscrowEventName =
  | "TradeCreated"
  | "CryptoDeposited"
  | "Released"
  | "Refunded"
  | "DisputeOpened"
  | "DisputeResolved"
  | "DisputeTimedOut";

/** Shape of a decoded viem log we rely on. */
export interface RawEscrowLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  logIndex: number | null;
  transactionHash: Hex | null;
}

export interface TradeEvent {
  name: EscrowEventName;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
  timestamp?: number;
  /** Who acted (seller for deposit, opener for dispute, claimer for timeout, recipient for payouts). */
  actor?: Hex;
  amount?: bigint;
  releasedToBuyer?: boolean;
}

export interface TradeSummary {
  tradeId: Hex;
  seller: Hex;
  buyer: Hex;
  amount: bigint;
  lockDeadline: number;
  fiatDeadline: number;
  state: TradeState;
  createdAt?: number;
  disputeOpenedAt?: number;
  lastBlock: bigint;
  events: TradeEvent[];
}

const TRANSITIONS: Partial<Record<EscrowEventName, TradeState>> = {
  CryptoDeposited: TradeState.LOCKED,
  DisputeOpened: TradeState.DISPUTE,
  Released: TradeState.RELEASED,
  Refunded: TradeState.REFUNDED,
};

const lc = (a?: string) => (a ?? "").toLowerCase();

/**
 * @param logs        decoded escrow logs (any order)
 * @param timestamps  blockHash (lowercase) → unix seconds
 * @returns trades sorted by most recent activity first
 */
export function buildTradeIndex(logs: RawEscrowLog[], timestamps: Map<string, number>): TradeSummary[] {
  const ordered = logs
    .filter((l) => l.blockNumber !== null && l.logIndex !== null)
    .sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex! - b.logIndex! : a.blockNumber! < b.blockNumber! ? -1 : 1
    );

  const trades = new Map<string, TradeSummary>();

  for (const log of ordered) {
    const name = log.eventName as EscrowEventName;
    const args = log.args;
    const tradeId = args.tradeId as Hex | undefined;
    if (!tradeId) continue;

    const key = lc(tradeId);
    const timestamp = log.blockHash ? timestamps.get(lc(log.blockHash)) : undefined;

    const event: TradeEvent = {
      name,
      blockNumber: log.blockNumber!,
      logIndex: log.logIndex!,
      txHash: (log.transactionHash ?? "0x") as Hex,
      timestamp,
    };

    if (name === "TradeCreated") {
      if (trades.has(key)) continue; // contract forbids duplicates; ignore defensively
      event.amount = args.amount as bigint;
      trades.set(key, {
        tradeId,
        seller: args.seller as Hex,
        buyer: args.buyer as Hex,
        amount: args.amount as bigint,
        lockDeadline: Number(args.lockDeadline),
        fiatDeadline: Number(args.fiatDeadline),
        state: TradeState.CREATED,
        createdAt: timestamp,
        lastBlock: log.blockNumber!,
        events: [event],
      });
      continue;
    }

    const trade = trades.get(key);
    if (!trade) continue; // created before the indexed range

    switch (name) {
      case "CryptoDeposited":
        event.actor = args.seller as Hex;
        event.amount = args.amount as bigint;
        break;
      case "DisputeOpened":
        event.actor = args.openedBy as Hex;
        trade.disputeOpenedAt = timestamp;
        break;
      case "Released":
        event.actor = args.buyer as Hex;
        event.amount = args.amount as bigint;
        break;
      case "Refunded":
        event.actor = args.seller as Hex;
        event.amount = args.amount as bigint;
        break;
      case "DisputeResolved":
        event.releasedToBuyer = args.releasedToBuyer as boolean;
        break;
      case "DisputeTimedOut":
        event.actor = args.claimedBy as Hex;
        break;
      default:
        continue;
    }

    const next = TRANSITIONS[name];
    if (next !== undefined) trade.state = next;
    trade.lastBlock = log.blockNumber!;
    trade.events.push(event);
  }

  return [...trades.values()].sort((a, b) => (a.lastBlock === b.lastBlock ? 0 : a.lastBlock > b.lastBlock ? -1 : 1));
}

// ─── What should happen next, from the viewer's point of view ────────────────

export interface Viewer {
  address?: string;
  operator?: string;
  chainNow: number;
  disputeTimeout: number;
}

export type ActionTone = "action" | "waiting" | "done";

export interface NextAction {
  label: string;
  tone: ActionTone;
  /** True when the connected wallet is the one expected to act. */
  mine: boolean;
}

export function viewerRoles(t: TradeSummary, v: Viewer) {
  return {
    isSeller: !!v.address && lc(v.address) === lc(t.seller),
    isBuyer: !!v.address && lc(v.address) === lc(t.buyer),
    isOperator: !!v.address && lc(v.address) === lc(v.operator),
  };
}

export function nextAction(t: TradeSummary, v: Viewer): NextAction {
  const { isSeller, isBuyer, isOperator } = viewerRoles(t, v);
  const now = v.chainNow;

  switch (t.state) {
    case TradeState.CREATED:
      if (now > t.lockDeadline) return { label: "Deposit window missed · close trade", tone: "action", mine: isSeller || isOperator };
      if (isSeller) return { label: "Deposit USDT", tone: "action", mine: true };
      return { label: "Waiting for seller deposit", tone: "waiting", mine: false };

    case TradeState.LOCKED:
      if (now > t.fiatDeadline) return { label: "Refund available to seller", tone: "action", mine: isSeller };
      if (isBuyer) return { label: "Send fiat · dispute if needed", tone: "action", mine: true };
      return { label: "Waiting for fiat payment", tone: "waiting", mine: false };

    case TradeState.DISPUTE: {
      const unlocks = (t.disputeOpenedAt ?? 0) + v.disputeTimeout;
      if (t.disputeOpenedAt && v.disputeTimeout > 0 && now > unlocks) {
        return { label: "Timeout refund claimable", tone: "action", mine: isSeller || isBuyer || isOperator };
      }
      if (isOperator) return { label: "Resolve dispute", tone: "action", mine: true };
      return { label: "Under review by operator", tone: "waiting", mine: false };
    }

    case TradeState.RELEASED:
      return { label: "Released to buyer", tone: "done", mine: false };
    case TradeState.REFUNDED: {
      const refund = [...t.events].reverse().find((e) => e.name === "Refunded");
      const neverFunded = refund?.amount === 0n;
      return { label: neverFunded ? "Closed · never funded" : "Refunded to seller", tone: "done", mine: false };
    }
    default:
      return { label: "Unknown", tone: "waiting", mine: false };
  }
}
