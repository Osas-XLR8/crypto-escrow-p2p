// src/hooks/useTradeIndex.ts
// Loads all escrow events once per poll and rebuilds the trade list client-side.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { ESCROW_ADDRESS, ESCROW_DEPLOY_BLOCK, ESCROW_EVENTS } from "@/config/escrow";
import { buildTradeIndex, type RawEscrowLog, type TradeSummary } from "@/lib/tradeIndex";

const POLL_MS = 4000;

// blockHash → timestamp. Keyed by hash (not number) so an Anvil restart can't serve stale times.
const blockTimes = new Map<string, number>();

export interface TradeIndexResult {
  trades: TradeSummary[];
  /** Best estimate of the chain's current time (handles Anvil time warps). */
  chainNow: number;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useTradeIndex(): TradeIndexResult {
  const client = usePublicClient();

  const query = useQuery({
    queryKey: ["tradeIndex", ESCROW_ADDRESS, client?.chain.id],
    enabled: !!client,
    refetchInterval: POLL_MS,
    queryFn: async () => {
      if (!client) throw new Error("No RPC client");

      const [logs, latest] = await Promise.all([
        client.getLogs({
          address: ESCROW_ADDRESS,
          events: ESCROW_EVENTS,
          fromBlock: ESCROW_DEPLOY_BLOCK,
          toBlock: "latest",
        }),
        client.getBlock(),
      ]);

      const missing = [
        ...new Set(logs.map((l) => l.blockHash?.toLowerCase()).filter((h): h is `0x${string}` => !!h && !blockTimes.has(h))),
      ];
      await Promise.all(
        missing.map(async (blockHash) => {
          const block = await client.getBlock({ blockHash });
          blockTimes.set(blockHash, Number(block.timestamp));
        })
      );

      return {
        trades: buildTradeIndex(logs as unknown as RawEscrowLog[], blockTimes),
        latestBlockTime: Number(latest.timestamp),
      };
    },
  });

  // Tick so countdowns and deadline checks stay live between polls.
  const [wallNow, setWallNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setWallNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // Anvil only mines on demand, so the latest block can lag wall time — but after
  // evm_increaseTime it can also be AHEAD of wall time. Take whichever is later.
  const chainNow = Math.max(wallNow, query.data?.latestBlockTime ?? 0);

  return {
    trades: query.data?.trades ?? [],
    chainNow,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}
