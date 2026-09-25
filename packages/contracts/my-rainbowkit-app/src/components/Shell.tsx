// src/components/Shell.tsx — page frame shared by the app and the arbitration desk:
// test-network banner, sticky header (brand, page nav, theme, wallet), wrong-network notice, footer.

import Link from "next/link";
import type { ReactNode } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useSwitchChain } from "wagmi";
import { useKeepConnected } from "@/hooks/useKeepConnected";
import { CHAIN, CHAIN_ID, IS_LOCAL, IS_TESTNET, V4, explorerAddress } from "@/config/v4";
import { useTheme } from "@/context/Theme";
import { useEscrowX } from "@/context/EscrowX";
import { Button, Notice } from "@/components/ui";

export function Shell({ nav, onBrand, children }: { nav?: ReactNode; onBrand?: () => void; children: ReactNode }) {
  // `chain` is undefined when the wallet sits on a network this app doesn't know — the case a plain chain-id
  // comparison misses, and the one that silently makes every read look like "nothing here".
  const { isConnected, chain } = useAccount();
  const { switchChain, isPending: switching } = useSwitchChain();
  useKeepConnected();
  const wrongChain = isConnected && chain?.id !== CHAIN_ID;

  return (
    <div className="shell">
      {IS_TESTNET && (
        <div style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
          <div className="container row small" style={{ justifyContent: "center", minHeight: 32, gap: 8 }}>
            <span className="chip chip-warn"><span className="dot" aria-hidden />{IS_LOCAL ? "Local chain" : "Testnet"}</span>
            <span className="faint">{CHAIN.name} · test tokens only, no real money · pre-audit software</span>
          </div>
        </div>
      )}

      <header className="header">
        <div className="container header-inner">
          <Link className="brand" href="/" onClick={(e) => { if (onBrand) { e.preventDefault(); onBrand(); } }}>
            <span className="brand-mark" aria-hidden>⇄</span>
            <span className="brand-name">escrow<span>x</span></span>
          </Link>
          {nav}
          <div className="header-right">
            <MessagingLock />
            <ThemeToggle />
            <ConnectButton showBalance={false} chainStatus="icon" accountStatus={{ smallScreen: "avatar", largeScreen: "address" }} />
          </div>
        </div>
      </header>

      <main className="main">
        <div className="container stack">
          {wrongChain && (
            <Notice tone="warn">
              <div className="row-between">
                <span>
                  Your wallet is on {chain?.name ?? "an unsupported network"}. EscrowX runs on <strong>{CHAIN.name}</strong> —
                  switch to see your trades and act on them.
                </span>
                <Button size="sm" variant="primary" busy={switching} onClick={() => switchChain({ chainId: CHAIN_ID })}>Switch to {CHAIN.name}</Button>
              </div>
            </Notice>
          )}
          {children}
        </div>
      </main>

      <footer className="footer">
        <div className="container row-between">
          <span>
            EscrowX can&apos;t move, freeze or recover funds in the escrow contract. Token issuers can freeze their own tokens.
            Pre-audit software — don&apos;t use with real funds.
          </span>
          <span className="row" style={{ gap: 14 }}>
            <Link href="/arbitrate/" className="mono">arbitration desk →</Link>
            {explorerAddress(V4.escrow) ? (
              <a href={explorerAddress(V4.escrow)!} target="_blank" rel="noreferrer" className="mono">contract ↗</a>
            ) : (
              <code title={V4.escrow}>{V4.escrow.slice(0, 10)}…</code>
            )}
            <a href="https://github.com/Osas-XLR8/crypto-escrow-p2p/blob/main/docs/case-records.md" target="_blank" rel="noreferrer" className="mono" title="Every dispute path run end to end on this network, with the transactions">case records ↗</a>
            <a href="https://github.com/Osas-XLR8/crypto-escrow-p2p" target="_blank" rel="noreferrer" className="mono">source ↗</a>
          </span>
        </div>
      </footer>
    </div>
  );
}

/** Shown once messaging is unlocked, so the key is never held without a way to drop it. */
function MessagingLock() {
  const { identity, lockMessaging, keptOnDevice } = useEscrowX();
  if (!identity) return null;
  return (
    <button
      className="btn btn-ghost btn-icon"
      onClick={lockMessaging}
      aria-label="Lock messaging"
      title={`Messaging unlocked${keptOnDevice ? " and kept on this device for 7 days" : " for this browser"} — click to forget the key`}
    >
      🔓
    </button>
  );
}

export function ThemeToggle() {
  const { resolved, cycle } = useTheme();
  return (
    <button className="btn btn-ghost btn-icon" onClick={cycle} title={`Switch to ${resolved === "dark" ? "light" : "dark"} mode`} aria-label="Toggle colour theme">
      {resolved === "dark" ? "☀" : "☾"}
    </button>
  );
}

export function ConnectPrompt({ what }: { what: string }) {
  return (
    <div className="card">
      <div className="empty">
        <div className="empty-title">Connect a wallet to {what}</div>
        <div>Any browser wallet works. Nothing is signed or sent until you confirm it in your wallet.</div>
        <ConnectButton />
      </div>
    </div>
  );
}
