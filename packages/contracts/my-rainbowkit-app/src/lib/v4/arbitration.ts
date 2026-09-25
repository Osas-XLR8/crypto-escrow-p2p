// src/lib/v4/arbitration.ts — reads and writes for a LicensedArbitratorAdapter (a firm's on-chain desk).
// Everything comes from the adapter and escrow contracts; there is no arbitration backend.

import type { AbiEvent, Address, Hex, PublicClient, WalletClient } from "viem";
import { escrowCoreV4Abi, licensedArbitratorAdapterAbi } from "@escrowx/sdk";
import { V4 } from "@/config/v4";
import { scanLogs } from "@/lib/v4/logs";

export const RULING_BUYER = 1n;
export const RULING_SELLER = 2n;

export interface FirmInfo {
  address: Address;
  admin: Address;
  pendingAdmin: Address;
  treasury: Address;
  fee: bigint;
  accruedFees: bigint;
  reviewPeriod: number;
  caseCount: number;
}

export interface CaseInfo {
  disputeId: bigint;
  tradeId: bigint;
  arbitrable: Address;
  assignee: Address;
  proposedRuling: bigint;
  proposedAt: number;
  hasProposal: boolean;
  executed: boolean;
  /** From the escrow: when this arbitrator's dispute started, and whether the case was escalated away. */
  startedAt: number;
  escalated: boolean;
  /** Party that opened the dispute (zero address if the escrow has no record). */
  opener: Address;
}

const adapter = (address: Address) => ({ address, abi: licensedArbitratorAdapterAbi }) as const;

export async function readFirm(client: PublicClient, address: Address): Promise<FirmInfo> {
  const a = adapter(address);
  const [admin, pendingAdmin, treasury, fee, accruedFees, reviewPeriod, caseCount] = await Promise.all([
    client.readContract({ ...a, functionName: "firmAdmin" }),
    client.readContract({ ...a, functionName: "pendingFirmAdmin" }),
    client.readContract({ ...a, functionName: "treasury" }),
    client.readContract({ ...a, functionName: "fee" }),
    client.readContract({ ...a, functionName: "accruedFees" }),
    client.readContract({ ...a, functionName: "REVIEW_PERIOD" }),
    client.readContract({ ...a, functionName: "caseCount" }),
  ]);
  return { address, admin, pendingAdmin, treasury, fee, accruedFees, reviewPeriod: Number(reviewPeriod), caseCount: Number(caseCount) };
}

/** Every case the firm has received, newest first, with the escrow trade it belongs to. */
export async function readCases(client: PublicClient, firm: FirmInfo): Promise<CaseInfo[]> {
  const ids = Array.from({ length: firm.caseCount }, (_, i) => BigInt(firm.caseCount - i));
  return Promise.all(
    ids.map(async (disputeId) => {
      const c = await client.readContract({ ...adapter(firm.address), functionName: "getCase", args: [disputeId] });
      const ours = c.arbitrable.toLowerCase() === V4.escrow.toLowerCase();
      const tradeId = ours
        ? await client.readContract({ address: V4.escrow, abi: escrowCoreV4Abi, functionName: "disputeToTrade", args: [firm.address, disputeId] })
        : 0n;
      const dispute =
        tradeId > 0n
          ? await client.readContract({ address: V4.escrow, abi: escrowCoreV4Abi, functionName: "getDispute", args: [tradeId] })
          : null;
      return {
        disputeId,
        tradeId,
        arbitrable: c.arbitrable,
        assignee: c.assignee,
        proposedRuling: c.proposedRuling,
        proposedAt: Number(c.proposedAt),
        hasProposal: c.hasProposal,
        executed: c.executed,
        startedAt: Number(dispute?.startedAt ?? 0n),
        escalated: dispute?.escalated ?? false,
        opener: (dispute?.opener ?? "0x0000000000000000000000000000000000000000") as Address,
      };
    })
  );
}

const PANELIST_UPDATED = licensedArbitratorAdapterAbi.find((x) => x.type === "event" && x.name === "PanelistUpdated") as unknown as AbiEvent;
const panelCache = new Map<string, { scannedTo: bigint; latest: Map<string, { panelist: Address; active: boolean; key: Hex }> }>();

/** Current panel, rebuilt from PanelistUpdated events (scanned incrementally in fixed block ranges). */
export async function readPanel(client: PublicClient, firm: Address): Promise<{ panelist: Address; key: Hex }[]> {
  const cache = panelCache.get(firm) ?? { scannedTo: V4.deployBlock - 1n, latest: new Map() };
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const from = cache.scannedTo + 1n;
  if (from <= head) {
    const logs = await scanLogs<{ args: { panelist: Address; active: boolean; encryptionKey: Hex } }>(client, {
      address: firm,
      event: PANELIST_UPDATED,
      fromBlock: from,
      toBlock: head,
    });
    for (const l of logs) {
      cache.latest.set(l.args.panelist.toLowerCase(), { panelist: l.args.panelist, active: l.args.active, key: l.args.encryptionKey });
    }
    cache.scannedTo = head;
  }
  panelCache.set(firm, cache);
  return [...cache.latest.values()].filter((v) => v.active).map((v) => ({ panelist: v.panelist, key: v.key }));
}

/** Simulates, sends and waits — so a revert reason surfaces before anything is signed. */
export async function writeFirm(
  client: PublicClient,
  wallet: WalletClient,
  firm: Address,
  functionName:
    | "setPanelist"
    | "assign"
    | "proposeRuling"
    | "vetoProposal"
    | "executeRuling"
    | "withdrawFees"
    | "setFee"
    | "setTreasury"
    | "transferFirmAdmin"
    | "acceptFirmAdmin",
  args: readonly unknown[],
  /** Lets the desk say which wait it is in: the wallet's, or the network's. */
  report?: (phase: "checking" | "signing" | "sent", hash?: Hex) => void
): Promise<void> {
  if (!wallet.account) throw new Error("Connect a wallet first");
  report?.("checking");
  const { request } = await client.simulateContract({
    address: firm,
    abi: licensedArbitratorAdapterAbi,
    functionName: functionName as never,
    args: args as never,
    account: wallet.account,
  });
  report?.("signing");
  const hash = await wallet.writeContract(request as never);
  report?.("sent", hash);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction reverted");
}

/**
 * How long this firm still has to rule before either party can move the case to the escrow's fallback
 * arbitrator. Returns null when the case is closed or the escrow has no start time for it.
 */
export function escalationDeadline(c: CaseInfo, arbitrationTimeout: number): number | null {
  if (c.executed || c.escalated || !c.startedAt || !arbitrationTimeout) return null;
  return c.startedAt + arbitrationTimeout;
}
