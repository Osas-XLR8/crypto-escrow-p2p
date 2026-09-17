// src/pages/index.tsx — EscrowX v4 web app.
// Market (offers from Nostr relays) · Sell (vault + publish offers) · Trades (on-chain trades, chat, disputes).

import Head from "next/head";
import { useEffect, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId } from "wagmi";
import { useEscrowX } from "@/context/EscrowX";
import { CHAIN_ID, RELAYS, V4 } from "@/config/v4";
import { Notice, colors, mono, sans } from "@/components/ui";
import { OfferMarket } from "@/components/v4/OfferMarket";
import { CreateOfferForm } from "@/components/v4/CreateOfferForm";
import { VaultPanel } from "@/components/v4/VaultPanel";
import { TradesPanel } from "@/components/v4/TradesPanel";
import { TradeDetail } from "@/components/v4/TradeDetail";
import { useV4Trades } from "@/hooks/useV4Trades";
import { shortAddr } from "@/lib/format";
import { nextStep } from "@/lib/v4/tradeIndex";

type Tab = "market" | "sell" | "trades";

export default function Home() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { identity, unlockMessaging, unlocking } = useEscrowX();
  const [tab, setTab] = useState<Tab>("market");
  const [selected, setSelected] = useState<bigint | undefined>();
  const trades = useV4Trades();

  // Trades where it's this wallet's move (same rule as the "Needs my action" filter).
  const myActionCount = trades.trades.filter(
    (t) => nextStep(t, { address, chainNow: trades.chainNow, arbitrationTimeout: trades.arbitrationTimeout }).mine
  ).length;

  // Deep link: /?trade=12
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("trade");
    if (t && /^\d+$/.test(t)) {
      setSelected(BigInt(t));
      setTab("trades");
    }
  }, []);

  const selectTrade = (id: bigint) => {
    setSelected(id);
    setTab("trades");
    window.history.replaceState(null, "", `?trade=${id}`);
  };

  const selectedSummary = trades.trades.find((t) => t.tradeId === selected);

  return (
    <>
      <Head>
        <title>EscrowX · P2P</title>
        <meta name="description" content="Non-custodial P2P crypto escrow: offers on Nostr, funds in a contract only the parties control." />
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <style>{`
          *, *::before, *::after { box-sizing: border-box; }
          html, body { margin: 0; background: ${colors.page} !important; }
          input:focus, select:focus { border-color: ${colors.blue} !important; outline: none; }
          input::placeholder { color: #2d3f55; }
        `}</style>
      </Head>

      <div style={{ fontFamily: sans, background: colors.page, minHeight: "100vh", color: colors.text }}>
        <header style={{ background: colors.card, borderBottom: `1px solid ${colors.border}`, position: "sticky", top: 0, zIndex: 100 }}>
          <div style={{ maxWidth: 920, margin: "0 auto", padding: "0 16px", minHeight: 60, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: "linear-gradient(135deg, #3b82f6 0%, #10b981 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⇄</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: colors.strong, lineHeight: 1 }}>EscrowX</div>
                <div style={{ fontSize: 9, color: colors.faint, letterSpacing: "0.12em", marginTop: 3 }}>NON-CUSTODIAL P2P · V4</div>
              </div>
            </div>
            <ConnectButton showBalance={false} />
          </div>
          {isConnected && (
            <nav style={{ maxWidth: 920, margin: "0 auto", padding: "0 16px", display: "flex", gap: 4 }}>
              {([["market", "Market"], ["sell", "Sell"], ["trades", `Trades${myActionCount ? ` (${myActionCount})` : ""}`]] as const).map(([key, label]) => (
                <button key={key} onClick={() => setTab(key)} style={{
                  padding: "10px 14px", background: "none", border: "none", cursor: "pointer", fontFamily: sans, fontSize: 14, fontWeight: 600,
                  color: tab === key ? colors.strong : "#64748b", borderBottom: `2px solid ${tab === key ? colors.blue : "transparent"}`,
                }}>{label}</button>
              ))}
            </nav>
          )}
        </header>

        <main style={{ maxWidth: 920, margin: "0 auto", padding: "20px 16px 80px", display: "grid", gap: 14 }}>
          {!isConnected ? (
            <section style={{ padding: "48px 24px", background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 12, textAlign: "center" }}>
              <h1 style={{ fontSize: 22, color: colors.strong, margin: "0 0 10px" }}>Buy and sell USDT for local currency, peer to peer</h1>
              <p style={{ color: "#94a3b8", maxWidth: 560, margin: "0 auto", lineHeight: 1.6, fontSize: 14 }}>
                Sellers lock crypto in a smart contract only they and independent arbitrators can move. Buyers pay sellers directly.
                Offers live on public Nostr relays and payment details travel end-to-end encrypted. EscrowX never holds your funds or your fiat.
              </p>
              <p style={{ color: colors.faint, fontSize: 13, marginTop: 20 }}>Connect a wallet to start.</p>
            </section>
          ) : (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", background: colors.card, border: `1px solid ${colors.border}`, borderRadius: 10, overflow: "hidden" }}>
                {[
                  { k: "WALLET", v: shortAddr(address ?? "") },
                  { k: "NETWORK", v: chainId === CHAIN_ID ? `chain ${chainId}` : `⚠ wrong chain ${chainId}` },
                  { k: "ESCROW", v: shortAddr(V4.escrow) },
                  { k: "RELAYS", v: String(RELAYS.length) },
                ].map((item) => (
                  <div key={item.k} style={{ flex: "1 1 120px", padding: "9px 14px", borderRight: `1px solid ${colors.border}` }}>
                    <div style={{ fontSize: 9, color: colors.faint, letterSpacing: "0.12em", marginBottom: 3 }}>{item.k}</div>
                    <code style={{ fontFamily: mono, fontSize: 12, color: item.v.startsWith("⚠") ? colors.amberText : "#94a3b8" }}>{item.v}</code>
                  </div>
                ))}
                <div style={{ flex: "1 1 160px", padding: "9px 14px" }}>
                  <div style={{ fontSize: 9, color: colors.faint, letterSpacing: "0.12em", marginBottom: 3 }}>MESSAGING</div>
                  {identity ? (
                    <span style={{ fontSize: 12, color: colors.greenText }}>● Unlocked</span>
                  ) : (
                    <button onClick={() => void unlockMessaging()} disabled={unlocking} style={{ background: "none", border: "none", padding: 0, color: colors.blueText, cursor: "pointer", fontSize: 12, fontFamily: sans }}>
                      {unlocking ? "Waiting for wallet…" : "Unlock →"}
                    </button>
                  )}
                </div>
              </div>

              {chainId !== CHAIN_ID && <Notice tone="warn">Your wallet is on chain {chainId}. Switch to chain {CHAIN_ID} to trade.</Notice>}

              {tab === "market" && <OfferMarket onTradeOpened={selectTrade} />}

              {tab === "sell" && (
                <>
                  <VaultPanel />
                  <CreateOfferForm />
                </>
              )}

              {tab === "trades" && (
                <>
                  <TradesPanel
                    trades={trades.trades}
                    address={address}
                    chainNow={trades.chainNow}
                    arbitrationTimeout={trades.arbitrationTimeout}
                    selectedId={selected}
                    onSelect={selectTrade}
                    error={trades.error}
                  />
                  {selected !== undefined && !selectedSummary && !trades.isLoading && (
                    <Notice tone="info">Trade #{selected.toString()} isn&apos;t indexed yet — it will appear once its transaction is mined.</Notice>
                  )}
                  {selectedSummary && (
                    <TradeDetail key={selectedSummary.tradeId.toString()} summary={selectedSummary} chainNow={trades.chainNow} arbitrationTimeout={trades.arbitrationTimeout} onChanged={trades.refetch} />
                  )}
                </>
              )}
            </>
          )}
        </main>

        <footer style={{ borderTop: `1px solid ${colors.border}`, padding: "16px 24px", textAlign: "center", fontSize: 11, color: colors.faint, lineHeight: 1.6 }}>
          EscrowX cannot move, freeze or recover funds held in the escrow contract. Stablecoin issuers can freeze their own tokens.
          <br />Pre-audit software on a test network — do not use with real funds.
        </footer>
      </div>
    </>
  );
}
