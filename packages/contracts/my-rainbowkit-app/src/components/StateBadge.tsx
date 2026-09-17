// src/components/StateBadge.tsx — EscrowCoreV4 trade states.

export const STATE_META: Record<number, { label: string; color: string; bg: string; dot: string }> = {
  0: { label: "NONE",        color: "#64748b", bg: "#1e293b", dot: "#64748b" },
  1: { label: "LOCKED",      color: "#fbbf24", bg: "#3d2e00", dot: "#f59e0b" },
  2: { label: "PAID",        color: "#60a5fa", bg: "#1e3a5f", dot: "#3b82f6" },
  3: { label: "FEE PENDING", color: "#fb923c", bg: "#3b1d05", dot: "#f97316" },
  4: { label: "DISPUTED",    color: "#f87171", bg: "#3f0f0f", dot: "#ef4444" },
  5: { label: "RELEASED",    color: "#34d399", bg: "#052e16", dot: "#10b981" },
  6: { label: "CANCELLED",   color: "#a78bfa", bg: "#2e1065", dot: "#8b5cf6" },
};

export function StateBadge({ state, compact = false }: { state: number; compact?: boolean }) {
  const m = STATE_META[state] ?? STATE_META[0];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: compact ? "3px 9px" : "4px 12px", borderRadius: 20,
      background: m.bg, color: m.color,
      fontSize: compact ? 10 : 11, fontWeight: 700, letterSpacing: "0.1em",
      border: `1px solid ${m.color}40`, whiteSpace: "nowrap",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: m.dot, boxShadow: `0 0 6px ${m.dot}`, display: "inline-block" }} />
      {m.label}
    </span>
  );
}
