// src/hooks/useV4Trades.ts — trade list rebuilt from EscrowCoreV4 events, polled from the chain.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { AbiEvent } from "viem";
import { escrowCoreV4Abi } from "@escrowx/sdk";
import { V4 } from "@/config/v4";
import { buildTradeIndex, type RawLog, type TradeSummary } from "@/lib/v4/tradeIndex";

const POLL_MS = 4000;
const EVENTS = escrowCoreV4Abi.filter(
  (x) =>
    x.type === "event" &&
    ["TradeOpened", "PaymentMarked", "Released", "Cancelled", "DisputeRequested", "ArbitrationFeePaid", "DisputeCreated", "Escalated", "FeesSettled", "Evidence"].includes(x.name)
) as unknown as AbiEvent[];

const blockTimes = new Map<string, number>();

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
      const [logs, latest, arbitrationTimeout] = await Promise.all([
        client.getLogs({ address: V4.escrow, events: EVENTS, fromBlock: V4.deployBlock, toBlock: "latest" }),
        client.getBlock(),
        client.readContract({ address: V4.escrow, abi: escrowCoreV4Abi as never, functionName: "ARBITRATION_TIMEOUT" as never }) as Promise<bigint>,
      ]);
      const missing = [...new Set(logs.map((l) => l.blockHash?.toLowerCase()).filter((h): h is `0x${string}` => !!h && !blockTimes.has(h)))];
      await Promise.all(
        missing.map(async (blockHash) => blockTimes.set(blockHash, Number((await client.getBlock({ blockHash })).timestamp)))
      );
      return {
        trades: buildTradeIndex(logs as unknown as RawLog[], blockTimes),
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
