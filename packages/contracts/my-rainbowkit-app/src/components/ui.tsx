// src/components/ui.tsx — small shared building blocks matching the app's dark style.

import type { CSSProperties, ReactNode } from "react";

export const colors = {
  page: "#060d1a",
  card: "#0a1628",
  inset: "#060d1a",
  border: "#1e293b",
  faint: "#334155",
  muted: "#475569",
  text: "#e2e8f0",
  strong: "#f1f5f9",
  green: "#10b981",
  greenText: "#34d399",
  blue: "#3b82f6",
  blueText: "#60a5fa",
  amber: "#f59e0b",
  amberText: "#fbbf24",
  red: "#ef4444",
  redText: "#f87171",
} as const;

export const mono = "'IBM Plex Mono', monospace";
export const sans = "'IBM Plex Sans', sans-serif";

export const inputStyle: CSSProperties = {
  width: "100%", padding: "10px 12px", fontSize: 13, borderRadius: 8,
  border: `1px solid ${colors.border}`, background: "#0f172a", color: colors.text,
  outline: "none", boxSizing: "border-box", fontFamily: sans,
};

export function Card({ title, right, children, style }: { title?: ReactNode; right?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <section style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 20, ...style }}>
      {(title || right) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          {title && <h2 style={{ fontSize: 11, color: colors.faint, letterSpacing: "0.12em", fontWeight: 600, margin: 0 }}>{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <span style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#64748b", letterSpacing: "0.06em", marginBottom: 6 }}>
      {children}
      {hint && <span style={{ color: colors.faint, fontWeight: 400, marginLeft: 6 }}>{hint}</span>}
    </span>
  );
}

export function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #0f172a", gap: 16, flexWrap: "wrap" }}>
      <span style={{ color: colors.muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em" }}>{label}</span>
      <span style={{ color: colors.text, fontSize: 13, textAlign: "right", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

type Variant = "primary" | "danger" | "warning" | "ghost" | "blue";
const palette: Record<Variant, string> = { primary: colors.green, danger: colors.red, warning: colors.amber, ghost: colors.muted, blue: colors.blue };

export function Button({ children, onClick, disabled, variant = "ghost", title, type = "button", solid = false }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; variant?: Variant; title?: string; type?: "button" | "submit"; solid?: boolean;
}) {
  const c = palette[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: "9px 16px", borderRadius: 10, fontSize: 13, fontWeight: 600, fontFamily: sans,
        background: disabled ? "#0f172a" : solid ? c : `${c}18`,
        border: `1.5px solid ${disabled ? colors.border : c}`,
        color: disabled ? "#2d3f55" : solid ? "#fff" : c,
        cursor: disabled ? "not-allowed" : "pointer", whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  const t = {
    info: { bg: "#0f1f3a", border: "#1e3a5f", color: "#93c5fd" },
    warn: { bg: "#3d2e00", border: "#f59e0b60", color: colors.amberText },
    error: { bg: "#1a0808", border: "#3f0f0f", color: colors.redText },
    ok: { bg: "#052e16", border: "#10b98160", color: colors.greenText },
  }[tone];
  return (
    <div style={{ padding: "11px 14px", borderRadius: 10, background: t.bg, border: `1px solid ${t.border}`, color: t.color, fontSize: 13, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

/** Turns viem / contract errors into one readable line. */
export function errorText(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; cause?: { reason?: string } };
  const reason = err?.cause?.reason;
  const text = reason ? `Contract rejected: ${reason}` : err?.shortMessage ?? err?.message ?? String(e);
  return text.split("\n")[0]!.slice(0, 220);
}
