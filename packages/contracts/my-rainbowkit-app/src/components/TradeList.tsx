// src/components/TradeList.tsx
// Live list of every trade on the escrow, rebuilt from on-chain events.

import { useMemo, useState } from "react";
import { StateBadge } from "@/components/StateBadge";
import { fmtAgo, fmtUSDT, shortAddr } from "@/lib/format";
import {
  nextAction,
  TradeState,
  viewerRoles,
  type NextAction,
  type TradeSummary,
  type Viewer,
} from "@/lib/tradeIndex";

type Filter = "all" | "mine" | "action" | "settled";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "mine", label: "Mine" },
  { key: "action", label: "Needs my action" },
  { key: "settled", label: "Settled" },
];

const TONE: Record<NextAction["tone"], string> = {
  action: "#fbbf24",
  waiting: "#64748b",
  done: "#334155",
};

const isSettled = (t: TradeSummary) => t.state === TradeState.RELEASED || t.state === TradeState.REFUNDED;

export default function TradeList({ trades, viewer, isLoading, error, selectedId, onSelect }: {
  trades: TradeSummary[];
  viewer: Viewer;
  isLoading: boolean;
  error: Error | null;
  selectedId?: string;
  onSelect: (tradeId: `0x${string}`) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo(
    () => trades.map((t) => ({ t, action: nextAction(t, viewer), roles: viewerRoles(t, viewer) })),
    [trades, viewer]
  );

  const counts: Record<Filter, number> = {
    all: rows.length,
    mine: rows.filter((r) => r.roles.isSeller || r.roles.isBuyer).length,
    action: rows.filter((r) => r.action.mine).length,
    settled: rows.filter((r) => isSettled(r.t)).length,
  };

  const visible = rows.filter(({ t, action, roles }) =>
    filter === "mine" ? roles.isSeller || roles.isBuyer :
    filter === "action" ? action.mine :
    filter === "settled" ? isSettled(t) :
    true
  );

  return (
    <div style={{ background: "#0a1628", border: "1px solid #1e293b", borderRadius: 12, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 11, color: "#334155", letterSpacing: "0.12em" }}>TRADES</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: error ? "#f87171" : "#34d399", letterSpacing: "0.08em" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: error ? "#ef4444" : "#10b981", boxShadow: error ? "none" : "0 0 6px #10b981" }} />
            {error ? "OFFLINE" : "LIVE"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {FILTERS.map(({ key, label }) => {
            const active = filter === key;
            const urgent = key === "action" && counts.action > 0;
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                style={{
                  padding: "5px 11px", borderRadius: 16, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  fontFamily: "'IBM Plex Sans', sans-serif",
                  background: active ? "#1e3a5f" : "transparent",
                  color: active ? "#93c5fd" : "#64748b",
                  border: `1px solid ${active ? "#3b82f6" : "#1e293b"}`,
                  display: "inline-flex", alignItems: "center", gap: 6,
                }}
              >
                {label}
                <span style={{
                  minWidth: 18, padding: "0 5px", borderRadius: 9, fontSize: 10, lineHeight: "16px",
                  background: urgent ? "#f59e0b" : "#0f172a", color: urgent ? "#0f172a" : "#475569",
                }}>{counts[key]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div style={{ padding: 14, borderRadius: 10, background: "#1a0808", border: "1px solid #3f0f0f", color: "#f87171", fontSize: 13 }}>
          ⚠ Could not read escrow events. Is Anvil running and the escrow address current?
        </div>
      )}

      {!error && isLoading && (
        <div style={{ color: "#334155", textAlign: "center", padding: "24px 0", fontSize: 13 }}>Scanning escrow events…</div>
      )}

      {!error && !isLoading && visible.length === 0 && (
        <div style={{ color: "#334155", textAlign: "center", padding: "24px 0", fontSize: 13 }}>
          {rows.length === 0 ? "No trades on this escrow yet — create one above." :
           filter === "action" ? "Nothing needs your action right now. ✨" :
           "No trades match this filter."}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {visible.map(({ t, action, roles }) => {
          const selected = !!selectedId && selectedId.toLowerCase() === t.tradeId.toLowerCase();
          const you = roles.isSeller ? "SELLER" : roles.isBuyer ? "BUYER" : null;
          return (
            <button
              key={t.tradeId}
              onClick={() => onSelect(t.tradeId)}
              style={{
                display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
                width: "100%", textAlign: "left", cursor: "pointer",
                padding: "12px 14px", borderRadius: 10,
                background: selected ? "#0f1f3a" : "#060d1a",
                border: `1px solid ${selected ? "#3b82f6" : action.mine ? "#f59e0b50" : "#0f172a"}`,
                color: "#e2e8f0", fontFamily: "'IBM Plex Sans', sans-serif",
              }}
            >
              <div style={{ width: 92, flexShrink: 0 }}><StateBadge state={t.state} compact /></div>

              <div style={{ flex: "1 1 180px", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <code style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#94a3b8" }}>
                    {t.tradeId.slice(0, 10)}…{t.tradeId.slice(-4)}
                  </code>
                  {you && (
                    <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 8, background: "#1e3a5f", color: "#60a5fa", letterSpacing: "0.08em" }}>
                      YOU · {you}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "#475569", marginTop: 3 }}>
                  {shortAddr(t.seller)} → {shortAddr(t.buyer)}
                  {t.createdAt ? ` · ${fmtAgo(t.createdAt, viewer.chainNow)}` : ""}
                </div>
              </div>

              <div style={{ flex: "0 0 auto", textAlign: "right", minWidth: 90 }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>{fmtUSDT(t.amount)}</span>
                <span style={{ fontSize: 11, color: "#475569", marginLeft: 4 }}>USDT</span>
              </div>

              <div style={{ flex: "1 1 170px", textAlign: "right", fontSize: 12, fontWeight: action.mine ? 700 : 500, color: action.mine ? TONE.action : TONE[action.tone] }}>
                {action.mine ? "● " : ""}{action.label}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
