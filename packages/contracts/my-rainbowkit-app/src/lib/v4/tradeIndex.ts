// src/lib/v4/tradeIndex.ts
// Rebuilds EscrowCoreV4 trade state + history from events, and works out what each viewer should do next.
// Pure: no React, no network — so it can be tested in isolation.

export type Hex = `0x${string}`;

/** Mirrors EscrowCoreV4.State */
export enum V4State {
  NONE = 0,
  LOCKED = 1,
  PAID = 2,
  FEE_PENDING = 3,
  DISPUTED = 4,
  RELEASED = 5,
  CANCELLED = 6,
}

/** Mirrors EscrowCoreV4.ReleaseReason / CancelReason */
export const RELEASE_REASONS = ["Seller released", "Arbitrator ruled for buyer", "Seller didn't pay dispute fee"] as const;
export const CANCEL_REASONS = [
  "Buyer cancelled",
  "Payment window missed",
  "Arbitrator ruled for seller",
  "Arbitrator declined to rule",
  "Arbitration timed out",
  "Buyer didn't pay dispute fee",
] as const;

export type V4EventName =
  | "TradeOpened"
  | "PaymentMarked"
  | "Released"
  | "Cancelled"
  | "DisputeRequested"
  | "ArbitrationFeePaid"
  | "DisputeCreated"
  | "Escalated"
  | "FeesSettled"
  | "Evidence";

export interface RawLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  logIndex: number | null;
  transactionHash: Hex | null;
}

export interface TradeEvent {
  name: V4EventName;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
  timestamp?: number;
  args: Record<string, unknown>;
}

export interface TradeSummary {
  tradeId: bigint;
  seller: Hex;
  buyer: Hex;
  amount: bigint;
  arbitrator: Hex;
  termsHash: Hex;
  state: V4State;
  openedAt?: number;
  paymentDeadline: number;
  releaseDeadline?: number;
  feeDeadline?: number;
  disputeOpener?: Hex;
  disputeStartedAt?: number;
  escalated: boolean;
  outcome?: string;
  lastBlock: bigint;
  events: TradeEvent[];
}

const TRADE_ID_ARG: Partial<Record<V4EventName, string>> = { Evidence: "evidenceGroupID" };

const lc = (a?: unknown) => String(a ?? "").toLowerCase();

export function buildTradeIndex(logs: RawLog[], timestamps: Map<string, number>): TradeSummary[] {
  const ordered = logs
    .filter((l) => l.blockNumber !== null && l.logIndex !== null)
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex! - b.logIndex! : a.blockNumber! < b.blockNumber! ? -1 : 1));

  const trades = new Map<bigint, TradeSummary>();

  for (const log of ordered) {
    const name = log.eventName as V4EventName;
    const idArg = log.args[TRADE_ID_ARG[name] ?? "tradeId"];
    if (typeof idArg !== "bigint") continue;
    const ts = log.blockHash ? timestamps.get(lc(log.blockHash)) : undefined;
    const event: TradeEvent = { name, blockNumber: log.blockNumber!, logIndex: log.logIndex!, txHash: (log.transactionHash ?? "0x") as Hex, timestamp: ts, args: log.args };

    if (name === "TradeOpened") {
      if (trades.has(idArg)) continue;
      trades.set(idArg, {
        tradeId: idArg,
        seller: log.args.seller as Hex,
        buyer: log.args.buyer as Hex,
        amount: log.args.amount as bigint,
        arbitrator: log.args.arbitrator as Hex,
        termsHash: log.args.termsHash as Hex,
        state: V4State.LOCKED,
        openedAt: ts,
        paymentDeadline: Number(log.args.paymentDeadline),
        escalated: false,
        lastBlock: log.blockNumber!,
        events: [event],
      });
      continue;
    }

    const t = trades.get(idArg);
    if (!t) continue; // opened before the indexed range

    switch (name) {
      case "PaymentMarked":
        t.state = V4State.PAID;
        t.releaseDeadline = Number(log.args.releaseDeadline);
        break;
      case "DisputeRequested":
        t.state = V4State.FEE_PENDING;
        t.feeDeadline = Number(log.args.feeDeadline);
        t.disputeOpener = log.args.opener as Hex;
        break;
      case "DisputeCreated":
        t.state = V4State.DISPUTED;
        t.disputeStartedAt = ts;
        break;
      case "Escalated":
        t.escalated = true;
        break;
      case "Released":
        t.state = V4State.RELEASED;
        t.outcome = RELEASE_REASONS[Number(log.args.reason)] ?? "Released";
        break;
      case "Cancelled":
        t.state = V4State.CANCELLED;
        t.outcome = CANCEL_REASONS[Number(log.args.reason)] ?? "Cancelled";
        break;
      case "ArbitrationFeePaid":
      case "FeesSettled":
      case "Evidence":
        break;
      default:
        continue;
    }
    t.lastBlock = log.blockNumber!;
    t.events.push(event);
  }

  return [...trades.values()].sort((a, b) => (a.lastBlock === b.lastBlock ? 0 : a.lastBlock > b.lastBlock ? -1 : 1));
}

// ─── What should happen next ──────────────────────────────────────────────────

export interface Viewer {
  address?: string;
  chainNow: number;
  arbitrationTimeout: number;
}

export type Tone = "action" | "waiting" | "done";

export interface NextStep {
  label: string;
  tone: Tone;
  /** The connected wallet is the one expected to act. */
  mine: boolean;
}

export function roles(t: Pick<TradeSummary, "seller" | "buyer">, address?: string) {
  const me = lc(address);
  return { isSeller: !!address && me === lc(t.seller), isBuyer: !!address && me === lc(t.buyer) };
}

export function nextStep(t: TradeSummary, v: Viewer): NextStep {
  const { isSeller, isBuyer } = roles(t, v.address);
  const party = isSeller || isBuyer;
  const now = v.chainNow;

  switch (t.state) {
    case V4State.LOCKED:
      if (now > t.paymentDeadline) return { label: "Payment window missed · cancel trade", tone: "action", mine: party };
      if (isBuyer) return { label: "Send fiat, then mark as paid", tone: "action", mine: true };
      return { label: "Waiting for buyer's payment", tone: "waiting", mine: false };

    case V4State.PAID:
      if (isSeller) return { label: "Check your bank app, then release", tone: "action", mine: true };
      if (isBuyer && t.releaseDeadline !== undefined && now > t.releaseDeadline) {
        return { label: "Seller hasn't released · open dispute", tone: "action", mine: true };
      }
      return { label: "Waiting for seller to release", tone: "waiting", mine: false };

    case V4State.FEE_PENDING: {
      const openerIsMe = !!v.address && lc(v.address) === lc(t.disputeOpener);
      if (t.feeDeadline !== undefined && now > t.feeDeadline) {
        return { label: "Dispute fee not matched · claim default win", tone: "action", mine: openerIsMe };
      }
      if (party && !openerIsMe) return { label: "Match the dispute fee or lose by default", tone: "action", mine: true };
      return { label: "Waiting for dispute fee from counterparty", tone: "waiting", mine: false };
    }

    case V4State.DISPUTED: {
      const started = t.disputeStartedAt ?? 0;
      const limit = t.escalated ? v.arbitrationTimeout : 2 * v.arbitrationTimeout;
      if (started && v.arbitrationTimeout > 0 && now > started + limit) {
        return { label: "Arbitration timed out · close dispute", tone: "action", mine: party };
      }
      if (!t.escalated && started && v.arbitrationTimeout > 0 && now > started + v.arbitrationTimeout) {
        return { label: "Arbitrator is late · escalate to fallback", tone: "action", mine: party };
      }
      if (party) return { label: "With arbitrator · submit evidence", tone: "action", mine: true };
      return { label: "With arbitrator", tone: "waiting", mine: false };
    }

    case V4State.RELEASED:
    case V4State.CANCELLED:
      return { label: t.outcome ?? (t.state === V4State.RELEASED ? "Released" : "Cancelled"), tone: "done", mine: false };

    default:
      return { label: "Unknown", tone: "waiting", mine: false };
  }
}
