// src/hooks/useV4Trades.ts — trade list rebuilt from EscrowCoreV4 events, polled from the chain.
//
// Logs are scanned incrementally in fixed-size block ranges (public RPCs cap eth_getLogs ranges) and cached
// for the session, so each poll only asks for blocks it hasn't seen. The last few blocks are re-read every
// time to pick up anything a short reorg replaced.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { AbiEvent, PublicClient } from "viem";
import { escrowCoreV4Abi } from "@escrowx/sdk";
import { LOG_CHUNK, POLL_MS, V4 } from "@/config/v4";
import { buildTradeIndex, type RawLog, type TradeSummary } from "@/lib/v4/tradeIndex";

const REORG_DEPTH = 12n;
const EVENTS = escrowCoreV4Abi.filter(
  (x) =>
    x.type === "event" &&
    ["TradeOpened", "PaymentMarked", "Released", "Cancelled", "DisputeRequested", "ArbitrationFeePaid", "DisputeCreated", "Escalated", "FeesSettled", "Evidence"].includes(x.name)
) as unknown as AbiEvent[];

const blockTimes = new Map<string, number>();
const scan = { logs: new Map<string, RawLog>(), scannedTo: -1n };

async function scanLogs(client: PublicClient, latest: bigint): Promise<RawLog[]> {
  const start = scan.scannedTo < 0n ? V4.deployBlock : scan.scannedTo + 1n - REORG_DEPTH;
  let from = start < V4.deployBlock ? V4.deployBlock : start;
  // Drop what we're about to re-read, so a reorged-out log doesn't linger.
  for (const [k, l] of scan.logs) if (l.blockNumber !== null && (l.blockNumber as bigint) >= from) scan.logs.delete(k);
  while (from <= latest) {
    const to = from + LOG_CHUNK - 1n < latest ? from + LOG_CHUNK - 1n : latest;
    const logs = (await client.getLogs({ address: V4.escrow, events: EVENTS, fromBlock: from, toBlock: to })) as unknown as RawLog[];
    for (const l of logs) scan.logs.set(`${l.transactionHash}:${l.logIndex}`, l);
    scan.scannedTo = to;
    from = to + 1n;
  }
  return [...scan.logs.values()].sort((a, b) =>
    (a.blockNumber as bigint) === (b.blockNumber as bigint) ? Number(a.logIndex) - Number(b.logIndex) : (a.blockNumber as bigint) < (b.blockNumber as bigint) ? -1 : 1
  );
}

export interface V4TradesResult {
  trades: TradeSummary[];
  chainNow: number;
  arbitrationTimeout: number;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useV4Trades(): V4TradesResult {
  const client = usePublicClient();

  const query = useQuery({
    queryKey: ["v4Trades", V4.escrow, client?.chain.id],
    enabled: !!client,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      if (!client) throw new Error("No RPC client");
      const latest = await client.getBlock({ blockTag: "latest" });
      const [logs, arbitrationTimeout] = await Promise.all([
        scanLogs(client as PublicClient, latest.number),
        client.readContract({ address: V4.escrow, abi: escrowCoreV4Abi as never, functionName: "ARBITRATION_TIMEOUT" as never }) as Promise<bigint>,
      ]);
      const missing = [...new Set(logs.map((l) => l.blockHash?.toLowerCase()).filter((h): h is `0x${string}` => !!h && !blockTimes.has(h)))];
      await Promise.all(
        missing.map(async (blockHash) => blockTimes.set(blockHash, Number((await client.getBlock({ blockHash })).timestamp)))
      );
      return {
        trades: buildTradeIndex(logs, blockTimes),
        latestBlockTime: Number(latest.timestamp),
        arbitrationTimeout: Number(arbitrationTimeout),
      };
    },
  });

  const [wallNow, setWallNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setWallNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  return {
    trades: query.data?.trades ?? [],
    // Anvil can be ahead of wall time after time warps; never show a clock behind the chain.
    chainNow: Math.max(wallNow, query.data?.latestBlockTime ?? 0),
    arbitrationTimeout: query.data?.arbitrationTimeout ?? 0,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}
