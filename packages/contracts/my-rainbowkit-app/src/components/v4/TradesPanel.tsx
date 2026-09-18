// src/components/v4/TradesPanel.tsx — the user's trades, rebuilt from on-chain events.

import { useMemo, useState } from "react";
import { StateBadge } from "@/components/StateBadge";
import { Card, Empty, Notice } from "@/components/ui";
import { V4 } from "@/config/v4";
import { fmtAgo, shortAddr } from "@/lib/format";
import { fmtToken } from "@/lib/v4/local";
import { V4State, nextStep, roles, type TradeSummary } from "@/lib/v4/tradeIndex";

type Filter = "action" | "mine" | "open" | "all";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "action", label: "To do" },
  { key: "mine", label: "Mine" },
  { key: "open", label: "Open" },
  { key: "all", label: "All" },
];

const isOpen = (t: TradeSummary) => t.state !== V4State.RELEASED && t.state !== V4State.CANCELLED;

export function TradesPanel({ trades, address, chainNow, arbitrationTimeout, selectedId, onSelect, error, isLoading, onBrowse }: {
  trades: TradeSummary[];
  address?: string;
  chainNow: number;
  arbitrationTimeout: number;
  selectedId?: bigint;
  onSelect: (id: bigint) => void;
  error: Error | null;
  isLoading: boolean;
  onBrowse: () => void;
}) {
  const rows = useMemo(
    () => trades.map((t) => ({ t, step: nextStep(t, { address, chainNow, arbitrationTimeout }), r: roles(t, address) })),
    [trades, address, chainNow, arbitrationTimeout]
  );
  const counts: Record<Filter, number> = {
    action: rows.filter((x) => x.step.mine).length,
    mine: rows.filter((x) => x.r.isBuyer || x.r.isSeller).length,
    open: rows.filter((x) => isOpen(x.t)).length,
    all: rows.length,
  };
  const [filter, setFilter] = useState<Filter | null>(null);
  // Default to "To do" when there is something to do, otherwise "Mine".
  const active: Filter = filter ?? (counts.action > 0 ? "action" : "mine");
  const visible = rows.filter(({ t, step, r }) =>
    active === "mine" ? r.isBuyer || r.isSeller : active === "action" ? step.mine : active === "open" ? isOpen(t) : true
  );

  return (
    <Card
      flush
      title={
        <>
          Trades
          <span className={`chip ${error ? "chip-danger" : "chip-accent"}`} title={error ? error.message : "Reading the escrow contract directly"}>
            <span className="dot dot-live" aria-hidden />
            {error ? "offline" : "live"}
          </span>
        </>
      }
      right={
        <div className="segmented" role="group" aria-label="Filter trades">
          {FILTERS.map(({ key, label }) => (
            <button key={key} aria-pressed={active === key} onClick={() => setFilter(key)}>
              {label}
              <span className={`count${key === "action" && counts.action > 0 ? " count-hot" : ""}`}>{counts[key]}</span>
            </button>
          ))}
        </div>
      }
    >
      {error && <div style={{ padding: "14px 16px 0" }}><Notice tone="error">Can&apos;t reach the network right now. Retrying…</Notice></div>}
      {isLoading && (
        <div className="stack-sm" style={{ padding: 16 }}>
          <div className="skeleton" style={{ width: "70%" }} />
          <div className="skeleton" style={{ width: "50%" }} />
        </div>
      )}
      {!isLoading && visible.length === 0 && (
        active === "action" ? (
          <Empty title="Nothing waiting on you">You&apos;re all caught up.</Empty>
        ) : (
          <Empty title="No trades yet" action={<button className="btn btn-sm" onClick={onBrowse}>Browse the market</button>}>
            Trades appear here as soon as you buy from an offer or someone buys from yours.
          </Empty>
        )
      )}
      <div className="trade-list">
        {visible.map(({ t, step, r }) => (
          <button key={t.tradeId.toString()} className="trade-row" aria-current={selectedId === t.tradeId} onClick={() => onSelect(t.tradeId)}>
            <div className="stack-xs" style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="mono strong">#{t.tradeId.toString()}</span>
                <StateBadge state={t.state} />
                {(r.isBuyer || r.isSeller) && <span className="chip">{r.isBuyer ? "buying" : "selling"}</span>}
              </div>
              <span className="tiny faint mono">
                {r.isBuyer ? `from ${shortAddr(t.seller)}` : r.isSeller ? `to ${shortAddr(t.buyer)}` : `${shortAddr(t.seller)} → ${shortAddr(t.buyer)}`}
                {t.openedAt ? ` · ${fmtAgo(t.openedAt, chainNow)}` : ""}
              </span>
            </div>
            <div style={{ textAlign: "right" }}>
              <span className="mono strong">{fmtToken(t.amount)}</span> <span className="tiny faint">{V4.tokenSymbol}</span>
            </div>
            <div className={`next${step.mine ? " mine" : ""}`}>
              {step.mine ? "→" : step.tone === "done" ? "✓" : "…"} {step.label}
            </div>
          </button>
        ))}
      </div>
    </Card>
  );
}
