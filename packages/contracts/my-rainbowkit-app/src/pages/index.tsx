import Head from "next/head";
import { useMemo, useState, useCallback, useEffect } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  useAccount,
  useChainId,
  useReadContract,
  useSignMessage,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { formatUnits } from "viem";
import { ESCROW_ABI, ESCROW_ADDRESS } from "@/config/escrow";
import { resolveAuthMessage } from "@/lib/resolveAuth";
import CreateTrade from "@/components/CreateTrade";

// ─── USDT Approve ABI ────────────────────────────────────────────────────────

const USDT_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount",  type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const USDT_ADDRESS =
  (process.env.NEXT_PUBLIC_USDT_ADDRESS as `0x${string}`) ??
  "0x5FbDB2315678afecb367f032d93F642f64180aa3";

// ─── State Machine ────────────────────────────────────────────────────────────

enum State {
  NONE = 0, CREATED = 1, LOCKED = 2,
  RELEASED = 3, REFUNDED = 4, DISPUTE = 5,
}

const STATE_META: Record<number, { label: string; color: string; bg: string; dot: string }> = {
  0: { label: "NONE",     color: "#64748b", bg: "#1e293b", dot: "#64748b" },
  1: { label: "CREATED",  color: "#60a5fa", bg: "#1e3a5f", dot: "#3b82f6" },
  2: { label: "LOCKED",   color: "#fbbf24", bg: "#3d2e00", dot: "#f59e0b" },
  3: { label: "RELEASED", color: "#34d399", bg: "#052e16", dot: "#10b981" },
  4: { label: "REFUNDED", color: "#a78bfa", bg: "#2e1065", dot: "#8b5cf6" },
  5: { label: "DISPUTE",  color: "#f87171", bg: "#3f0f0f", dot: "#ef4444" },
};

type TradeData = readonly [string, string, bigint, bigint, bigint, number];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isBytes32Hex(s: string) { return /^0x[0-9a-fA-F]{64}$/.test(s.trim()); }
function isHex(s: string)        { return /^0x[0-9a-fA-F]+$/.test(s.trim()); }

function fmtUSDT(raw: bigint) {
  return parseFloat(formatUnits(raw, 6)).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 6,
  });
}
function fmtTs(ts: bigint) {
  if (!ts || ts === 0n) return "—";
  return new Date(Number(ts) * 1000).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
function shortAddr(addr: string) {
  if (!addr || addr === "0x0000000000000000000000000000000000000000") return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ─── Shared style tokens ──────────────────────────────────────────────────────

const inp: React.CSSProperties = {
  width: "100%", padding: "10px 12px", fontSize: 13,
  borderRadius: 8, border: "1px solid #1e293b",
  background: "#0f172a", color: "#e2e8f0",
  outline: "none", boxSizing: "border-box",
};
const lbl: React.CSSProperties = {
  display: "block", fontSize: 11, fontWeight: 600,
  color: "#64748b", letterSpacing: "0.06em", marginBottom: 6,
};

// ─── StateBadge ───────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: number }) {
  const m = STATE_META[state] ?? STATE_META[0];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 12px", borderRadius: 20,
      background: m.bg, color: m.color,
      fontSize: 11, fontWeight: 700, letterSpacing: "0.1em",
      border: `1px solid ${m.color}40`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: m.dot, boxShadow: `0 0 6px ${m.dot}`, display: "inline-block" }} />
      {m.label}
    </span>
  );
}

// ─── TxStatus ────────────────────────────────────────────────────────────────

function TxStatus({ hash, isPending, isConfirming, isSuccess, error, label }: {
  hash?: `0x${string}`; isPending: boolean; isConfirming: boolean;
  isSuccess: boolean; error: Error | null; label: string;
}) {
  if (!isPending && !isConfirming && !isSuccess && !error) return null;
  return (
    <div style={{ marginTop: 12, padding: "12px 16px", background: "#060d1a", borderRadius: 10, border: "1px solid #1e293b", fontSize: 13, lineHeight: 1.7 }}>
      {isPending    && <div style={{ color: "#fbbf24" }}>⏳ Waiting for wallet confirmation…</div>}
      {isConfirming && <div style={{ color: "#60a5fa" }}>🔄 {label} — confirming on-chain…</div>}
      {isSuccess    && <div style={{ color: "#34d399" }}>✅ {label} confirmed!</div>}
      {error        && <div style={{ color: "#f87171" }}>❌ {error.message.split("\n")[0].slice(0, 160)}</div>}
      {hash && <div style={{ color: "#334155", fontSize: 11, marginTop: 6 }}>Tx: <code style={{ color: "#64748b", wordBreak: "break-all" }}>{hash}</code></div>}
    </div>
  );
}

// ─── Field ────────────────────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 0", borderBottom: "1px solid #0f172a", gap: 16, flexWrap: "wrap" }}>
      <span style={{ color: "#475569", fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", flexShrink: 0 }}>{label}</span>
      <span style={{ color: "#e2e8f0", fontSize: 13, textAlign: "right", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

// ─── ActionBtn ────────────────────────────────────────────────────────────────

function ActionBtn({ label, sublabel, enabled, reason, onClick, variant = "ghost", active }: {
  label: string; sublabel?: string; enabled: boolean; reason?: string;
  onClick: () => void; variant?: "primary" | "danger" | "warning" | "ghost"; active?: boolean;
}) {
  const palette = { primary: "#10b981", danger: "#ef4444", warning: "#f59e0b", ghost: "#475569" } as const;
  const c = palette[variant];
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        disabled={!enabled} onClick={onClick} title={reason}
        style={{
          padding: "10px 18px", borderRadius: 10,
          background: !enabled ? "#0f172a" : active ? c : `${c}18`,
          border: `1.5px solid ${!enabled ? "#1e293b" : c}`,
          color: !enabled ? "#2d3f55" : active ? (variant === "warning" ? "#0f172a" : "#fff") : c,
          cursor: !enabled ? "not-allowed" : "pointer",
          fontSize: 13, fontWeight: 600, fontFamily: "'IBM Plex Sans', sans-serif",
          transition: "all 0.15s", display: "flex", flexDirection: "column",
          alignItems: "center", gap: 2, minWidth: 140,
        }}
      >
        {label}
        {sublabel && <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.65 }}>{sublabel}</span>}
      </button>
      {!enabled && reason && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)",
          background: "#1e293b", color: "#94a3b8", fontSize: 11, padding: "6px 12px",
          borderRadius: 8, whiteSpace: "nowrap", pointerEvents: "none", zIndex: 30,
          border: "1px solid #334155",
        }}>{reason}</div>
      )}
    </div>
  );
}

// ─── SigPanel (manual fallback for Release) ───────────────────────────────────

function SigPanel({ title, hint, expiresAt, nonce, sig, onExpiresAt, onNonce, onSig, onSubmit, onCancel, submitLabel, submitVariant, busy }: {
  title: string; hint?: string; expiresAt: string; nonce: string; sig: string;
  onExpiresAt: (v: string) => void; onNonce: (v: string) => void; onSig: (v: string) => void;
  onSubmit: () => void; onCancel: () => void; submitLabel: string;
  submitVariant: "primary" | "danger"; busy: boolean;
}) {
  const submitColor = submitVariant === "primary" ? "#10b981" : "#ef4444";
  return (
    <div style={{ marginTop: 16, padding: 20, background: "#060d1a", borderRadius: 12, border: `1px solid ${submitColor}30` }}>
      <div style={{ fontWeight: 700, color: "#f1f5f9", marginBottom: 4, fontSize: 14 }}>{title}</div>
      {hint && <div style={{ color: "#475569", fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>{hint}</div>}
      <div style={{ display: "grid", gap: 12 }}>
        <div>
          <label style={lbl}>EXPIRES AT <span style={{ color: "#334155", fontWeight: 400 }}>(unix seconds)</span></label>
          <input value={expiresAt} onChange={e => onExpiresAt(e.target.value)} placeholder="e.g. 1771763088" style={inp} />
        </div>
        <div>
          <label style={lbl}>NONCE <span style={{ color: "#334155", fontWeight: 400 }}>(bytes32)</span></label>
          <input value={nonce} onChange={e => onNonce(e.target.value)} placeholder="0x… (64 hex chars)" style={{ ...inp, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }} />
        </div>
        <div>
          <label style={lbl}>BACKEND SIGNATURE</label>
          <input value={sig} onChange={e => onSig(e.target.value)} placeholder="0x…" style={{ ...inp, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }} />
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button disabled={busy} onClick={onSubmit} style={{ padding: "10px 20px", borderRadius: 10, fontWeight: 700, fontSize: 13, background: submitColor, color: "#fff", border: "none", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1, fontFamily: "'IBM Plex Sans', sans-serif" }}>
          {busy ? "Processing…" : submitLabel}
        </button>
        <button onClick={onCancel} style={{ padding: "10px 16px", borderRadius: 10, fontWeight: 600, fontSize: 13, background: "transparent", color: "#475569", border: "1px solid #1e293b", cursor: "pointer", fontFamily: "'IBM Plex Sans', sans-serif" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Home() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();

  const [tradeId, setTradeId]         = useState("");
  const [showCreate, setShowCreate]   = useState(false);
  const [panel, setPanel]             = useState<"release" | null>(null);
  const [expiresAt, setExpiresAt]     = useState("");
  const [nonce, setNonce]             = useState("");
  const [sig, setSig]                 = useState("");
  const [depositStep, setDepositStep] = useState<"idle" | "approving" | "depositing">("idle");
  const [sigBusy, setSigBusy]         = useState(false);
  const [sigError, setSigError]       = useState<string | null>(null);

  const tradeIdOk  = useMemo(() => isBytes32Hex(tradeId), [tradeId]);
  const escrowAddr = ESCROW_ADDRESS as `0x${string}`;

  // ── Read trade ──────────────────────────────────────────────────────────────

  const read = useReadContract({
    abi: ESCROW_ABI, address: escrowAddr,
    functionName: "trades",
    args: tradeIdOk ? [tradeId.trim() as `0x${string}`] : undefined,
    query: { enabled: isConnected && tradeIdOk },
  });

  const t          = read.data as TradeData | undefined;
  const stateNum   = (t?.[5] ?? 0) as number;
  const isCreated  = stateNum === State.CREATED;
  const isLocked   = stateNum === State.LOCKED;
  const isDispute  = stateNum === State.DISPUTE;
  const isTerminal = stateNum === State.RELEASED || stateNum === State.REFUNDED;

  // ── Write hooks ─────────────────────────────────────────────────────────────

  const approveWrite   = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({ hash: approveWrite.data });
  const escrowWrite    = useWriteContract();
  const escrowReceipt  = useWaitForTransactionReceipt({ hash: escrowWrite.data });

  const busy = approveWrite.isPending || approveReceipt.isLoading ||
               escrowWrite.isPending  || escrowReceipt.isLoading  || sigBusy;

  const refetch = useCallback(() => { setTimeout(() => read.refetch(), 1200); }, [read]);

  // ── Auto-deposit: step 2 fires after approve confirms ───────────────────────

  useEffect(() => {
    if (approveReceipt.isSuccess && depositStep === "approving" && tradeIdOk) {
      setDepositStep("depositing");
      escrowWrite.writeContract({
        abi: ESCROW_ABI, address: escrowAddr,
        functionName: "deposit",
        args: [tradeId.trim() as `0x${string}`],
      });
    }
  }, [approveReceipt.isSuccess]); // eslint-disable-line

  useEffect(() => {
    if (escrowReceipt.isSuccess && depositStep === "depositing") {
      setDepositStep("idle");
      refetch();
    }
  }, [escrowReceipt.isSuccess]); // eslint-disable-line

  // ── Action handlers ─────────────────────────────────────────────────────────

  function doDeposit() {
    if (!t) return;
    setDepositStep("approving");
    approveWrite.writeContract({
      abi: USDT_ABI, address: USDT_ADDRESS,
      functionName: "approve", args: [escrowAddr, t[2]],
    });
  }

  function doSimple(fn: string) {
    escrowWrite.writeContract({
      abi: ESCROW_ABI, address: escrowAddr,
      functionName: fn as never,
      args: [tradeId.trim() as `0x${string}`],
    });
    refetch();
  }

  function validateSig(): boolean {
    if (!/^\d+$/.test(expiresAt.trim()))              { alert("expiresAt must be a number."); return false; }
    if (!isBytes32Hex(nonce.trim()))                  { alert("nonce must be 0x + 64 hex chars."); return false; }
    if (!isHex(sig.trim()) || sig.trim().length < 10) { alert("backendSig must be a 0x… hex string."); return false; }
    return true;
  }

  function doSigAction(fn: string) {
    if (!validateSig()) return;
    escrowWrite.writeContract({
      abi: ESCROW_ABI, address: escrowAddr,
      functionName: fn as never,
      args: [tradeId.trim() as `0x${string}`, BigInt(expiresAt.trim()), nonce.trim() as `0x${string}`, sig.trim() as `0x${string}`],
    });
    refetch();
  }

  // ── 1-click dispute resolution ───────────────────────────────────────────────
  // Calls /api/escrow/sign-resolve which computes the EXACT same digest as the contract.

  async function doResolveAuto(buyerWins: boolean) {
    if (!tradeIdOk) return;
    setSigBusy(true);
    setSigError(null);

    try {
      // Prove to the API that the connected wallet is the escrow's backendSigner.
      const issuedAt = Math.floor(Date.now() / 1000);
      const authSig = await signMessageAsync({
        message: resolveAuthMessage({
          tradeId: tradeId.trim(), buyerWins, issuedAt, chainId, escrow: ESCROW_ADDRESS,
        }),
      });

      const res = await fetch("/api/escrow/sign-resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tradeId: tradeId.trim(), buyerWins, issuedAt, authSig }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error ?? "sign-resolve API failed");
      }

      const { expiresAt: exp, nonce: nn, backendSig } = data as {
        expiresAt: number; nonce: string; backendSig: string;
      };

      const fn = buyerWins ? "resolveDisputeRelease" : "resolveDisputeRefund";

      escrowWrite.writeContract({
        abi: ESCROW_ABI, address: escrowAddr,
        functionName: fn as never,
        args: [
          tradeId.trim() as `0x${string}`,
          BigInt(exp),
          nn as `0x${string}`,
          backendSig as `0x${string}`,
        ],
      });

      refetch();
    } catch (e: any) {
      setSigError(e?.message ?? "Unknown error from sign-resolve API");
    } finally {
      setSigBusy(false);
    }
  }

  const depositLabel =
    depositStep === "approving"  ? "Approving USDT…" :
    depositStep === "depositing" ? "Depositing…"     : "Deposit";

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <Head>
        <title>P2P Escrow · Demo</title>
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <style>{`
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          html, body { background: #060d1a !important; }
          input:focus { border-color: #3b82f6 !important; outline: none; }
          input::placeholder { color: #2d3f55; }
          ::-webkit-scrollbar { width: 4px; }
          ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }
        `}</style>
      </Head>

      <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", background: "#060d1a", minHeight: "100vh", color: "#e2e8f0" }}>

        {/* Header */}
        <header style={{ background: "#0a1628", borderBottom: "1px solid #1e293b", position: "sticky", top: 0, zIndex: 100 }}>
          <div style={{ maxWidth: 840, margin: "0 auto", padding: "0 20px", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: "linear-gradient(135deg, #3b82f6 0%, #10b981 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⇄</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.02em", lineHeight: 1 }}>P2P Escrow</div>
                <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.12em", marginTop: 3 }}>DEMO MVP · LOCAL DEV</div>
              </div>
            </div>
            <ConnectButton />
          </div>
        </header>

        <main style={{ maxWidth: 840, margin: "0 auto", padding: "28px 20px 80px", display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Network bar */}
          {isConnected && (
            <div style={{ display: "flex", background: "#0a1628", border: "1px solid #1e293b", borderRadius: 10, overflow: "hidden" }}>
              {[{ k: "WALLET", v: shortAddr(address ?? "") }, { k: "CHAIN", v: String(chainId) }, { k: "CONTRACT", v: shortAddr(ESCROW_ADDRESS) }].map((item, i) => (
                <div key={i} style={{ flex: 1, padding: "10px 16px", borderRight: i < 2 ? "1px solid #1e293b" : "none" }}>
                  <div style={{ fontSize: 9, color: "#334155", letterSpacing: "0.12em", marginBottom: 4 }}>{item.k}</div>
                  <code style={{ fontSize: 12, color: "#64748b" }}>{item.v}</code>
                </div>
              ))}
            </div>
          )}

          {/* Create Trade */}
          <div style={{ background: "#0a1628", border: "1px solid #1e293b", borderRadius: 12 }}>
            <button onClick={() => setShowCreate(v => !v)} style={{ width: "100%", padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", cursor: "pointer", fontFamily: "'IBM Plex Sans', sans-serif", color: "#e2e8f0" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 24, height: 24, borderRadius: 6, background: "#1e3a5f", color: "#60a5fa", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>+</span>
                <span style={{ fontWeight: 700, fontSize: 14, color: "#f1f5f9" }}>Create New Trade</span>
                <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: "#1e3a5f", color: "#60a5fa", letterSpacing: "0.06em" }}>BACKEND ONLY</span>
              </div>
              <span style={{ color: "#334155", fontSize: 12 }}>{showCreate ? "▲" : "▼"}</span>
            </button>
            {showCreate && (
              <div style={{ borderTop: "1px solid #1e293b", padding: "16px 20px 20px" }}>
                <CreateTrade />
              </div>
            )}
          </div>

          {/* Trade Lookup */}
          <div style={{ background: "#0a1628", border: "1px solid #1e293b", borderRadius: 12, padding: 20 }}>
            <div style={{ fontSize: 11, color: "#334155", letterSpacing: "0.12em", marginBottom: 12 }}>TRADE LOOKUP</div>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                value={tradeId}
                onChange={e => { setTradeId(e.target.value); setPanel(null); setSigError(null); }}
                placeholder="Paste tradeId — 0x followed by 64 hex characters"
                style={{ ...inp, flex: 1, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}
              />
              <button
                disabled={!isConnected || !tradeIdOk}
                onClick={() => read.refetch()}
                style={{ padding: "10px 20px", borderRadius: 8, fontWeight: 600, fontSize: 13, background: "#0f172a", color: "#64748b", border: "1px solid #1e293b", cursor: (!isConnected || !tradeIdOk) ? "not-allowed" : "pointer", opacity: (!isConnected || !tradeIdOk) ? 0.4 : 1, fontFamily: "'IBM Plex Sans', sans-serif", whiteSpace: "nowrap" }}
              >
                Refresh
              </button>
            </div>
            {tradeId.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 11, color: tradeIdOk ? "#34d399" : "#f87171" }}>
                {tradeIdOk ? "✓ Valid bytes32" : "✗ Invalid — needs 0x + exactly 64 hex characters"}
              </div>
            )}
          </div>

          {/* Trade Panel */}
          {isConnected && tradeIdOk && (
            <div style={{ background: "#0a1628", border: "1px solid #1e293b", borderRadius: 12, padding: 20 }}>

              {read.isLoading && <div style={{ color: "#334155", textAlign: "center", padding: "32px 0", fontSize: 13 }}>Loading trade data…</div>}
              {read.error    && <div style={{ padding: 16, borderRadius: 10, background: "#1a0808", border: "1px solid #3f0f0f", color: "#f87171", fontSize: 13 }}>⚠ Could not load trade. Make sure Anvil is running and this tradeId was created on-chain.</div>}

              {t && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 8 }}>
                    <div style={{ fontSize: 11, color: "#334155", letterSpacing: "0.12em" }}>TRADE DETAILS</div>
                    <StateBadge state={stateNum} />
                  </div>

                  <div style={{ background: "#060d1a", borderRadius: 10, padding: "0 16px", marginBottom: 4 }}>
                    <Field label="SELLER" value={<code style={{ fontFamily: "'IBM Plex Mono'", fontSize: 11, color: "#94a3b8" }}>{t[0]}</code>} />
                    <Field label="BUYER"  value={<code style={{ fontFamily: "'IBM Plex Mono'", fontSize: 11, color: "#94a3b8" }}>{t[1]}</code>} />
                    <Field label="AMOUNT" value={
                      <span style={{ display: "flex", alignItems: "baseline", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                        <span style={{ fontSize: 20, fontWeight: 700, color: "#34d399", letterSpacing: "-0.02em" }}>{fmtUSDT(t[2])}</span>
                        <span style={{ color: "#475569", fontSize: 12 }}>USDT</span>
                        <span style={{ color: "#1e293b", fontSize: 11 }}>({t[2].toString()})</span>
                      </span>
                    } />
                    <Field label="LOCK DEADLINE" value={<span style={{ color: "#94a3b8" }}>{fmtTs(t[3])}</span>} />
                    <Field label="FIAT DEADLINE" value={<span style={{ color: "#94a3b8" }}>{fmtTs(t[4])}</span>} />
                  </div>

                  {!isTerminal && (
                    <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid #1e293b" }}>
                      <div style={{ fontSize: 11, color: "#334155", letterSpacing: "0.12em", marginBottom: 14 }}>AVAILABLE ACTIONS</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>

                        <ActionBtn
                          label={depositLabel} sublabel="approve + deposit"
                          enabled={isCreated && !busy}
                          reason={!isCreated ? `Requires CREATED state (now: ${STATE_META[stateNum]?.label})` : undefined}
                          onClick={doDeposit} variant="primary"
                        />

                        <ActionBtn
                          label="Release →" sublabel="backend sig required"
                          enabled={isLocked && !isDispute && !busy}
                          reason={!isLocked ? `Requires LOCKED state (now: ${STATE_META[stateNum]?.label})` : undefined}
                          onClick={() => setPanel(panel === "release" ? null : "release")}
                          variant="primary" active={panel === "release"}
                        />

                        <ActionBtn
                          label="Open Dispute" sublabel="freezes funds"
                          enabled={isLocked && !busy}
                          reason={!isLocked ? `Requires LOCKED state (now: ${STATE_META[stateNum]?.label})` : undefined}
                          onClick={() => doSimple("openDispute")} variant="warning"
                        />

                        <ActionBtn
                          label="Refund" sublabel="after deadline"
                          enabled={(isCreated || isLocked) && !isDispute && !busy}
                          reason={isDispute ? "Frozen — trade is in DISPUTE" : (!isCreated && !isLocked) ? "Requires CREATED or LOCKED state" : undefined}
                          onClick={() => doSimple("refund")} variant="ghost"
                        />

                        {isDispute && (
                          <>
                            <ActionBtn
                              label={sigBusy ? "Signing…" : "Resolve → Buyer Wins"}
                              sublabel="1-click auto-sign"
                              enabled={!busy}
                              onClick={() => doResolveAuto(true)}
                              variant="primary"
                            />
                            <ActionBtn
                              label={sigBusy ? "Signing…" : "Resolve → Seller Wins"}
                              sublabel="1-click auto-sign"
                              enabled={!busy}
                              onClick={() => doResolveAuto(false)}
                              variant="danger"
                            />
                          </>
                        )}
                      </div>

                      {/* API error display */}
                      {sigError && (
                        <div style={{ marginTop: 12, padding: "12px 16px", background: "#1a0808", border: "1px solid #3f0f0f", borderRadius: 10, color: "#f87171", fontSize: 13 }}>
                          ❌ Auto-sign failed: {sigError}
                        </div>
                      )}

                      {/* Manual release panel */}
                      {panel === "release" && (
                        <SigPanel
                          title="Release Funds to Buyer"
                          hint="Generate expiresAt, nonce, and backendSig from your CLI script, then paste below."
                          expiresAt={expiresAt} nonce={nonce} sig={sig}
                          onExpiresAt={setExpiresAt} onNonce={setNonce} onSig={setSig}
                          onSubmit={() => doSigAction("release")}
                          onCancel={() => setPanel(null)}
                          submitLabel="Confirm Release →"
                          submitVariant="primary" busy={busy}
                        />
                      )}
                    </div>
                  )}

                  {isTerminal && (
                    <div style={{ marginTop: 16, padding: 16, borderRadius: 10, background: "#060d1a", border: "1px solid #1e293b", display: "flex", alignItems: "center", gap: 10, color: "#475569", fontSize: 13, flexWrap: "wrap" }}>
                      <span>Trade settled —</span>
                      <StateBadge state={stateNum} />
                      <span>No further actions available.</span>
                    </div>
                  )}

                  {/* Tx status */}
                  {depositStep === "approving" && (
                    <TxStatus hash={approveWrite.data} isPending={approveWrite.isPending} isConfirming={approveReceipt.isLoading} isSuccess={false} error={approveWrite.error} label="Step 1 of 2: Approve USDT" />
                  )}
                  <TxStatus
                    hash={escrowWrite.data} isPending={escrowWrite.isPending}
                    isConfirming={escrowReceipt.isLoading} isSuccess={escrowReceipt.isSuccess}
                    error={escrowWrite.error}
                    label={depositStep === "depositing" ? "Step 2 of 2: Deposit" : "Transaction"}
                  />
                </>
              )}
            </div>
          )}

          {!isConnected && (
            <div style={{ textAlign: "center", padding: "56px 24px", background: "#0a1628", border: "1px solid #1e293b", borderRadius: 12, color: "#334155", fontSize: 14 }}>
              Connect your wallet above to get started.
            </div>
          )}
        </main>

        <footer style={{ borderTop: "1px solid #1e293b", padding: "16px 24px", textAlign: "center", fontSize: 10, color: "#1e293b", letterSpacing: "0.1em" }}>
          ⚠ DEMO MVP · NOT AUDITED · DO NOT USE IN PRODUCTION WITH REAL FUNDS
        </footer>
      </div>
    </>
  );
}
