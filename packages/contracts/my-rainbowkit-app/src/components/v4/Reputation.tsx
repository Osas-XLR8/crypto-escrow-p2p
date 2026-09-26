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
import { buildReputation, completionRate, confidence, disputeAlarm, disputeRate, releaseTime, settled, statsFor, type PartyStats } from "@/lib/v4/reputation";
import { Chip, Notice } from "@/components/ui";
import { fmtDuration } from "@/lib/format";

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
  const release = stats && releaseTime(stats);
  // Seconds, not milliseconds: everything in this module works in the units the chain uses.
  const trust = stats ? confidence(stats, Math.floor(Date.now() / 1000)) : "none";
  const alarm = stats && disputeAlarm(stats);

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
        tone={(trust === "fair" || trust === "strong") && rate !== undefined && rate >= 0.9 ? "accent" : undefined}
        title={`${stats.asSeller} as seller, ${stats.asBuyer} as buyer${stats.open ? `, ${stats.open} still running` : ""}`}
      >
        {stats.total} trade{stats.total === 1 ? "" : "s"}
      </Chip>
      {rate !== undefined && (
        <Chip
          tone={rate >= 0.9 && (trust === "fair" || trust === "strong") ? "accent" : rate >= 0.6 ? undefined : "warn"}
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
      {release && (
        <Chip
          tone={release.seconds <= 15 * 60 ? "accent" : release.seconds <= 2 * 3600 ? undefined : "warn"}
          title={`Median time from the buyer marking a trade paid to this seller releasing it, over ${release.from} trade${release.from === 1 ? "" : "s"} they released themselves. Arbitrated releases are excluded.`}
        >
          releases in {release.seconds < 60 ? "under a minute" : fmtDuration(release.seconds)}
        </Chip>
      )}
      {stats.firstSeen && (
        <span className="faint" title={`First trade on this escrow: ${day(stats.firstSeen)}`}>
          since {month(stats.firstSeen)}
          {trust === "thin" && " · thin history"}
        </span>
      )}
      {detailed && activity.data !== undefined && (
        <span className="faint">· {activity.data} transaction{activity.data === 1 ? "" : "s"} on {CHAIN.name}</span>
      )}
    </div>
  );
}

/**
 * A dispute record bad enough to interrupt someone.
 *
 * The chip line above reports a dispute rate the way it reports everything else — a small tag, the same
 * weight as "since Sept 2026". That is right for a statistic and wrong for a warning: the review found a
 * seller at 50% completion and 38% disputed sitting in the market looking much like anybody else. This says
 * it in the register the number deserves, and still shows the counts so the reader can judge for themselves.
 *
 * Renders nothing at all below the threshold, which is most of the time. A warning that appears often is one
 * people learn to look past.
 */
export function DisputeWarning({ stats }: { stats?: PartyStats }) {
  const alarm = stats && disputeAlarm(stats);
  if (!stats || !alarm || alarm.level === "none") return null;
  const share = `${Math.round(alarm.rate * 100)}% of their ${alarm.of} finished trades`;
  return (
    <Notice tone={alarm.level === "severe" ? "error" : "warn"}>
      <span className="small">
        <strong>{alarm.level === "severe" ? "Most of this trader's trades end in dispute." : "This trader disputes often."}</strong>{" "}
        {share} went to arbitration{stats.lost > 0 ? `, and ${stats.lost} ${stats.lost === 1 ? "was" : "were"} ruled against them` : ""}. Nothing is
        stopping you trading — the escrow protects you either way — but expect it to take longer, and keep
        every payment traceable and in your own name.
      </span>
    </Notice>
  );
}
