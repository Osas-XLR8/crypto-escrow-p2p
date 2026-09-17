// src/components/v4/TradesPanel.tsx — the user's trades, rebuilt from on-chain events.

import { useMemo, useState } from "react";
import { StateBadge } from "@/components/StateBadge";
import { Card, colors, mono } from "@/components/ui";
import { fmtAgo, shortAddr } from "@/lib/format";
import { fmtToken } from "@/lib/v4/local";
import { V4State, nextStep, roles, type TradeSummary } from "@/lib/v4/tradeIndex";

type Filter = "mine" | "action" | "open" | "all";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "mine", label: "Mine" },
  { key: "action", label: "Needs my action" },
  { key: "open", label: "Open" },
  { key: "all", label: "All" },
];

const isOpen = (t: TradeSummary) => t.state !== V4State.RELEASED && t.state !== V4State.CANCELLED;

export function TradesPanel({ trades, address, chainNow, arbitrationTimeout, selectedId, onSelect, error }: {
  trades: TradeSummary[];
  address?: string;
  chainNow: number;
  arbitrationTimeout: number;
  selectedId?: bigint;
  onSelect: (id: bigint) => void;
  error: Error | null;
}) {
  const [filter, setFilter] = useState<Filter>("mine");
  const rows = useMemo(
    () => trades.map((t) => ({ t, step: nextStep(t, { address, chainNow, arbitrationTimeout }), r: roles(t, address) })),
    [trades, address, chainNow, arbitrationTimeout]
  );
  const counts: Record<Filter, number> = {
    mine: rows.filter((x) => x.r.isBuyer || x.r.isSeller).length,
    action: rows.filter((x) => x.step.mine).length,
    open: rows.filter((x) => isOpen(x.t)).length,
    all: rows.length,
  };
  const visible = rows.filter(({ t, step, r }) =>
    filter === "mine" ? r.isBuyer || r.isSeller : filter === "action" ? step.mine : filter === "open" ? isOpen(t) : true
  );

  return (
    <Card
      title={<>TRADES <span style={{ color: error ? colors.redText : colors.greenText, marginLeft: 8 }}>● {error ? "OFFLINE" : "LIVE"}</span></>}
      right={
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {FILTERS.map(({ key, label }) => {
            const active = filter === key;
            const urgent = key === "action" && counts.action > 0;
            return (
              <button key={key} onClick={() => setFilter(key)} style={{
                padding: "5px 11px", borderRadius: 16, fontSize: 12, fontWeight: 600, cursor: "pointer",
                background: active ? "#1e3a5f" : "transparent", color: active ? "#93c5fd" : "#64748b",
                border: `1px solid ${active ? colors.blue : colors.border}`, display: "inline-flex", gap: 6, alignItems: "center",
              }}>
                {label}
                <span style={{ minWidth: 18, padding: "0 5px", borderRadius: 9, fontSize: 10, lineHeight: "16px", background: urgent ? colors.amber : "#0f172a", color: urgent ? "#0f172a" : colors.muted }}>{counts[key]}</span>
              </button>
            );
          })}
        </div>
      }
    >
      {visible.length === 0 && (
        <div style={{ color: colors.faint, textAlign: "center", padding: "20px 0", fontSize: 13 }}>
          {filter === "action" ? "Nothing needs your action right now." : "No trades here yet."}
        </div>
      )}
      <div style={{ display: "grid", gap: 6 }}>
        {visible.map(({ t, step, r }) => {
          const selected = selectedId === t.tradeId;
          return (
            <button key={t.tradeId.toString()} onClick={() => onSelect(t.tradeId)} style={{
              display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", width: "100%", textAlign: "left", cursor: "pointer",
              padding: "11px 14px", borderRadius: 10, color: colors.text,
              background: selected ? "#0f1f3a" : "#060d1a",
              border: `1px solid ${selected ? colors.blue : step.mine ? "#f59e0b50" : "#0f172a"}`,
            }}>
              <div style={{ width: 104, flexShrink: 0 }}><StateBadge state={t.state} compact /></div>
              <div style={{ flex: "1 1 170px", minWidth: 0 }}>
                <div style={{ fontFamily: mono, fontSize: 12, color: "#94a3b8" }}>
                  Trade #{t.tradeId.toString()}
                  {(r.isBuyer || r.isSeller) && <span style={{ marginLeft: 8, fontSize: 9, padding: "1px 6px", borderRadius: 8, background: "#1e3a5f", color: colors.blueText }}>YOU · {r.isBuyer ? "BUYER" : "SELLER"}</span>}
                </div>
                <div style={{ fontSize: 11, color: colors.muted, marginTop: 3 }}>
                  {shortAddr(t.seller)} → {shortAddr(t.buyer)}{t.openedAt ? ` · ${fmtAgo(t.openedAt, chainNow)}` : ""}
                </div>
              </div>
              <div style={{ minWidth: 90, textAlign: "right" }}>
                <strong style={{ fontSize: 15 }}>{fmtToken(t.amount)}</strong> <span style={{ fontSize: 11, color: colors.muted }}>USDT</span>
              </div>
              <div style={{ flex: "1 1 170px", textAlign: "right", fontSize: 12, fontWeight: step.mine ? 700 : 500, color: step.mine ? colors.amberText : step.tone === "done" ? colors.faint : "#64748b" }}>
                {step.mine ? "● " : ""}{step.label}
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
