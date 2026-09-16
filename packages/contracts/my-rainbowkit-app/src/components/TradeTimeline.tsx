// src/components/TradeTimeline.tsx
// On-chain activity history for a single trade.

import { fmtAgo, fmtTs, fmtUSDT, sameAddr, shortAddr, shortHash } from "@/lib/format";
import type { TradeEvent, TradeSummary } from "@/lib/tradeIndex";

function describe(e: TradeEvent, t: TradeSummary, operator?: string): { icon: string; color: string; text: string } {
  const who = (addr?: string) =>
    sameAddr(addr, t.buyer) ? "buyer" : sameAddr(addr, t.seller) ? "seller" : sameAddr(addr, operator) ? "operator" : shortAddr(addr ?? "");
  const amt = e.amount !== undefined ? `${fmtUSDT(e.amount)} USDT` : "";

  switch (e.name) {
    case "TradeCreated":    return { icon: "✦", color: "#60a5fa", text: `Trade created for ${amt}` };
    case "CryptoDeposited": return { icon: "⬇", color: "#fbbf24", text: `Seller locked ${amt} in escrow` };
    case "DisputeOpened":   return { icon: "⚑", color: "#f87171", text: `Dispute opened by ${who(e.actor)}` };
    case "DisputeResolved": return { icon: "⚖", color: "#a78bfa", text: `Dispute resolved in favour of ${e.releasedToBuyer ? "buyer" : "seller"}` };
    case "DisputeTimedOut": return { icon: "⏱", color: "#a78bfa", text: `Dispute timed out · claimed by ${who(e.actor)}` };
    case "Released":        return { icon: "→", color: "#34d399", text: `${amt} released to buyer` };
    case "Refunded":
      return e.amount === 0n
        ? { icon: "✕", color: "#64748b", text: "Trade closed · seller never deposited" }
        : { icon: "↩", color: "#a78bfa", text: `${amt} refunded to seller` };
  }
}

export default function TradeTimeline({ trade, operator, chainNow }: {
  trade: TradeSummary;
  operator?: string;
  chainNow: number;
}) {
  return (
    <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid #1e293b" }}>
      <div style={{ fontSize: 11, color: "#334155", letterSpacing: "0.12em", marginBottom: 14 }}>ACTIVITY</div>
      <ol style={{ listStyle: "none", position: "relative" }}>
        {trade.events.map((e, i) => {
          const d = describe(e, trade, operator);
          const last = i === trade.events.length - 1;
          return (
            <li key={`${e.txHash}-${e.logIndex}`} style={{ display: "flex", gap: 12, position: "relative", paddingBottom: last ? 0 : 16 }}>
              {!last && <span style={{ position: "absolute", left: 11, top: 24, bottom: 0, width: 1, background: "#1e293b" }} />}
              <span style={{
                width: 23, height: 23, borderRadius: "50%", flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, color: d.color, background: `${d.color}18`, border: `1px solid ${d.color}50`,
              }}>{d.icon}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, color: "#e2e8f0" }}>{d.text}</div>
                <div style={{ fontSize: 11, color: "#475569", marginTop: 2, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <span title={fmtTs(e.timestamp)}>{e.timestamp ? fmtAgo(e.timestamp, chainNow) : "—"}</span>
                  <span>block {e.blockNumber.toString()}</span>
                  <code style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#334155" }} title={e.txHash}>tx {shortHash(e.txHash)}</code>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
