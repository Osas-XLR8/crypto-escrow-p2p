// src/components/ui.tsx — shared building blocks. Styling lives in src/styles/app.css.

import { useState, type ReactNode } from "react";
import { explorerAddress, explorerTx } from "@/config/v4";

export function Card({ title, sub, right, children, flush = false, className = "" }: {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  /** No inner padding (for lists that draw their own rows). */
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {sub && <p className="card-sub">{sub}</p>}
          </div>
          {right}
        </header>
      )}
      {flush ? children : <div className="card-body">{children}</div>}
    </section>
  );
}

export function Field({ label, hint, children, help }: { label: ReactNode; hint?: ReactNode; children: ReactNode; help?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      {children}
      {help && <p className="help">{help}</p>}
    </label>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv inset">
      {rows.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

type Variant = "default" | "primary" | "accent" | "danger" | "warn" | "ghost";

export function Button({ children, onClick, disabled, variant = "default", title, size, block, busy, type = "button" }: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: Variant;
  title?: string;
  size?: "sm";
  block?: boolean;
  /** Shows a spinner and disables the button. */
  busy?: boolean;
  type?: "button" | "submit";
}) {
  const cls = ["btn", variant !== "default" && `btn-${variant}`, size && `btn-${size}`, block && "btn-block"].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled || busy} title={title} aria-busy={busy || undefined}>
      {busy && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

const NOTICE_ICON = { info: "i", ok: "✓", warn: "!", error: "×" } as const;

export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "error" | "ok"; children: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="notice-icon" aria-hidden>{NOTICE_ICON[tone]}</span>
      <div>{children}</div>
    </div>
  );
}

export function Chip({ children, tone, title }: { children: ReactNode; tone?: "accent" | "warn" | "danger" | "info"; title?: string }) {
  return <span className={`chip${tone ? ` chip-${tone}` : ""}`} title={title}>{children}</span>;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      title={copied ? "Copied" : label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

/** Shortened address with copy + explorer link. */
export function Addr({ address, you, full = false }: { address: string; you?: boolean; full?: boolean }) {
  const href = explorerAddress(address);
  return (
    <span className="addr">
      <span title={address}>{full ? address : `${address.slice(0, 6)}…${address.slice(-4)}`}</span>
      {you && <span className="chip" style={{ marginLeft: 4 }}>you</span>}
      <CopyButton value={address} label="Copy address" />
      {href && <a className="icon-btn" href={href} target="_blank" rel="noreferrer" title="View on explorer" aria-label="View on explorer">↗</a>}
    </span>
  );
}

export function TxLink({ hash }: { hash: string }) {
  const href = explorerTx(hash);
  const short = `${hash.slice(0, 8)}…${hash.slice(-6)}`;
  return href ? (
    <a className="mono" href={href} target="_blank" rel="noreferrer" title={hash}>{short} ↗</a>
  ) : (
    <code title={hash}>{short}</code>
  );
}

/** Turns viem / contract errors into one readable line. */
export function errorText(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; cause?: { reason?: string } };
  const reason = err?.cause?.reason;
  const raw = reason ? `Contract rejected: ${reason}` : err?.shortMessage ?? err?.message ?? String(e);
  const text = raw.split("\n")[0]!;
  if (/user (rejected|denied)/i.test(text)) return "You cancelled the request in your wallet.";
  if (/insufficient funds/i.test(text)) return "Not enough ETH for gas on this network. Get some from a faucet and try again.";
  return text.slice(0, 220);
}
