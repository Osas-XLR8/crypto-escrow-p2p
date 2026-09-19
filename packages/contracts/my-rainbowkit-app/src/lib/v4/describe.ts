// src/lib/v4/describe.ts — plain-English lines for on-chain trade events (timeline + chat).

import { formatEther, zeroHash } from "viem";
import { V4, arbitratorName } from "@/config/v4";
import { shortAddr, shortHash } from "@/lib/format";
import { fmtToken } from "@/lib/v4/local";
import { CANCEL_REASONS, RELEASE_REASONS, type TradeEvent } from "@/lib/v4/tradeIndex";

const SYM = V4.tokenSymbol;

export function describeEvent(e: Pick<TradeEvent, "name" | "args">): string {
  const a = e.args;
  switch (e.name) {
    case "TradeOpened":
      return `Trade opened · ${fmtToken(a.amount as bigint)} ${SYM} locked in escrow`;
    case "PaymentMarked":
      return (a.evidenceCommitment as string) === zeroHash
        ? "Buyer marked the payment as sent"
        : `Buyer marked the payment as sent · receipt fingerprint ${shortHash(a.evidenceCommitment as string)}`;
    case "DisputeRequested":
      return `Dispute opened by ${shortAddr(a.opener as string)} (fee ${formatEther(a.feePaid as bigint)} ETH)`;
    case "ArbitrationFeePaid":
      return `${shortAddr(a.party as string)} matched the arbitration fee`;
    case "DisputeCreated":
      return `Case #${a.disputeId} created with ${arbitratorName(a.arbitrator as string)}`;
    case "Escalated":
      return `Escalated to ${arbitratorName(a.fallbackArbitrator as string)}`;
    case "Evidence":
      return `${shortAddr(a.party as string)} submitted sealed evidence`;
    case "FeesSettled":
      return `Dispute fees settled (buyer ${formatEther(a.toBuyer as bigint)} ETH, seller ${formatEther(a.toSeller as bigint)} ETH)`;
    case "Released":
      return `${fmtToken(a.amount as bigint)} ${SYM} released to the buyer · ${RELEASE_REASONS[Number(a.reason)] ?? ""}`;
    case "Cancelled":
      return `Crypto returned to the seller · ${CANCEL_REASONS[Number(a.reason)] ?? ""}`;
    default:
      return e.name;
  }
}

/** Events worth showing inside the chat (the milestones both sides care about). */
export const CHAT_MILESTONES = new Set(["TradeOpened", "PaymentMarked", "DisputeRequested", "DisputeCreated", "Escalated", "Released", "Cancelled"]);
