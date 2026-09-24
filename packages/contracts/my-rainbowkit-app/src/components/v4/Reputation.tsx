// src/components/v4/Reputation.tsx — the counterparty's record, in the place where you decide to trade.
//
// Every number comes from this escrow's events, so it's the same history anyone can verify on the explorer.
// Nothing here is a score: there's no way to buy a good one, and no ranking to game.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { CHAIN } from "@/config/v4";
import { useV4Trades } from "@/hooks/useV4Trades";
import { buildReputation, completionRate, disputeRate, settled, statsFor, type PartyStats } from "@/lib/v4/reputation";
import { Chip } from "@/components/ui";

/** Shared through react-query's cache with the trades list, so this costs no extra requests. */
export function useReputation() {
  const { trades } = useV4Trades();
  const reputation = useMemo(() => buildReputation(trades), [trades]);
  return (address?: string): PartyStats | undefined => statsFor(reputation, address);
}

/** Transactions this wallet has ever sent on this chain — the cheapest honest answer to "is this new?". */
export function useWalletActivity(address?: Address) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["walletActivity", address, client?.chain.id],
    enabled: !!client && !!address,
    staleTime: 10 * 60_000,
    queryFn: () => client!.getTransactionCount({ address: address! }),
  });
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const month = (ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" });
const day = (ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * One line, because it sits on every offer. `detailed` adds the wallet's own history, which is worth a
 * request on a trade you're actually in but not on fifty offer cards.
 */
export function Reputation({ stats, address, detailed = false }: { stats?: PartyStats; address?: Address; detailed?: boolean }) {
  const activity = useWalletActivity(detailed ? address : undefined);
  const done = stats ? settled(stats) : 0;
  const rate = stats && completionRate(stats);
  const disputes = stats && disputeRate(stats);

  if (!stats || stats.total === 0) {
    return (
      <div className="row tiny" style={{ gap: 6 }}>
        <Chip tone="warn" title="This wallet has never traded on this escrow. That isn't proof of anything — everyone starts here — but there's no history to check, so treat a first trade as a first trade.">
          no trades here yet
        </Chip>
        {detailed && activity.data !== undefined && (
          <span className="faint">
            {activity.data === 0 ? `wallet has never sent a transaction on ${CHAIN.name}` : `${activity.data} transaction${activity.data === 1 ? "" : "s"} on ${CHAIN.name}`}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="row tiny" style={{ gap: 6, flexWrap: "wrap" }}>
      <Chip
        tone={done >= 5 && rate !== undefined && rate >= 0.9 ? "accent" : undefined}
        title={`${stats.asSeller} as seller, ${stats.asBuyer} as buyer${stats.open ? `, ${stats.open} still running` : ""}`}
      >
        {stats.total} trade{stats.total === 1 ? "" : "s"}
      </Chip>
      {rate !== undefined && (
        <Chip
          tone={rate >= 0.9 ? "accent" : rate >= 0.6 ? undefined : "warn"}
          title={`${stats.completed} of ${done} finished trades ended with the seller releasing. ${stats.cancelled} cancelled, ${stats.arbitrated} decided by an arbitrator.`}
        >
          {pct(rate)} completed
        </Chip>
      )}
      {disputes !== undefined && stats.disputed > 0 && (
        <Chip
          tone={stats.lost > 0 ? "danger" : "warn"}
          title={`${stats.disputed} of ${stats.total} trades went to a dispute${stats.lost ? `; ${stats.lost} ruled against them` : ""}.`}
        >
          {pct(disputes)} disputed{stats.lost > 0 ? ` · ${stats.lost} lost` : ""}
        </Chip>
      )}
      {stats.firstSeen && (
        <span className="faint" title={`First trade on this escrow: ${day(stats.firstSeen)}`}>
          since {month(stats.firstSeen)}
        </span>
      )}
      {detailed && activity.data !== undefined && (
        <span className="faint">· {activity.data} transaction{activity.data === 1 ? "" : "s"} on {CHAIN.name}</span>
      )}
    </div>
  );
}
