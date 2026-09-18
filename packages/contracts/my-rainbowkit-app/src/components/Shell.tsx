// src/components/Shell.tsx — page frame shared by the app and the arbitration desk:
// test-network banner, sticky header (brand, page nav, theme, wallet), wrong-network notice, footer.

import Link from "next/link";
import type { ReactNode } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { CHAIN, CHAIN_ID, IS_LOCAL, IS_TESTNET, V4, explorerAddress } from "@/config/v4";
import { useTheme } from "@/context/Theme";
import { Button, Notice } from "@/components/ui";

export function Shell({ nav, onBrand, children }: { nav?: ReactNode; onBrand?: () => void; children: ReactNode }) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: switching } = useSwitchChain();
  const wrongChain = isConnected && chainId !== CHAIN_ID;

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
                <span>Your wallet is on another network. EscrowX runs on <strong>{CHAIN.name}</strong>.</span>
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
            <Link href="/arbitrate" className="mono">arbitration desk →</Link>
            {explorerAddress(V4.escrow) ? (
              <a href={explorerAddress(V4.escrow)!} target="_blank" rel="noreferrer" className="mono">contract ↗</a>
            ) : (
              <code title={V4.escrow}>{V4.escrow.slice(0, 10)}…</code>
            )}
            <a href="https://github.com/Osas-XLR8/crypto-escrow-p2p" target="_blank" rel="noreferrer" className="mono">source ↗</a>
          </span>
        </div>
      </footer>
    </div>
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
