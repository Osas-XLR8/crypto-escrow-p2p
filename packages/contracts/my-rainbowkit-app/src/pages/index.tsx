// src/pages/index.tsx — EscrowX v4 web app.
// Market (offers from Nostr relays) · Sell (vault + publish offers) · Trades (on-chain trades, chat, disputes).

import Head from "next/head";
import { useEffect, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { CHAIN, CHAIN_ID, IS_LOCAL, IS_TESTNET, V4, explorerAddress } from "@/config/v4";
import { useTheme } from "@/context/Theme";
import { Button, Card, Notice } from "@/components/ui";
import { OfferMarket } from "@/components/v4/OfferMarket";
import { CreateOfferForm } from "@/components/v4/CreateOfferForm";
import { VaultPanel } from "@/components/v4/VaultPanel";
import { TradesPanel } from "@/components/v4/TradesPanel";
import { TradeDetail } from "@/components/v4/TradeDetail";
import { GettingStarted } from "@/components/v4/GettingStarted";
import { useV4Trades } from "@/hooks/useV4Trades";
import { nextStep } from "@/lib/v4/tradeIndex";

type Tab = "market" | "sell" | "trades";

export default function Home() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [tab, setTab] = useState<Tab>("market");
  const [selected, setSelected] = useState<bigint | undefined>();
  const trades = useV4Trades();

  // Trades where it's this wallet's move (same rule as the "To do" filter).
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

  const go = (next: Tab) => {
    setTab(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const selectTrade = (id: bigint) => {
    setSelected(id);
    setTab("trades");
    window.history.replaceState(null, "", `?trade=${id}`);
  };

  const selectedSummary = trades.trades.find((t) => t.tradeId === selected);
  const wrongChain = isConnected && chainId !== CHAIN_ID;

  return (
    <>
      <Head>
        <title>EscrowX — peer-to-peer crypto, non-custodial</title>
        <meta name="description" content="Buy and sell stablecoins for local currency, peer to peer. Funds sit in a contract only the parties and independent arbitrators control." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

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
            <a className="brand" href="#" onClick={(e) => { e.preventDefault(); go("market"); }}>
              <span className="brand-mark" aria-hidden>⇄</span>
              <span className="brand-name">escrow<span>x</span></span>
            </a>
            <nav className="nav" aria-label="Main">
              {([["market", "Market"], ["sell", "Sell"], ["trades", "Trades"]] as const).map(([key, label]) => (
                <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => go(key)}>
                  {label}
                  {key === "trades" && myActionCount > 0 && <span className="count count-hot" title="Waiting on you">{myActionCount}</span>}
                </button>
              ))}
            </nav>
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

            {isConnected && myActionCount > 0 && tab !== "trades" && (
              <Notice tone="warn">
                <div className="row-between">
                  <span><strong>{myActionCount} trade{myActionCount === 1 ? " is" : "s are"} waiting on you.</strong> Deadlines are enforced by the contract.</span>
                  <Button size="sm" onClick={() => go("trades")}>Open trades →</Button>
                </div>
              </Notice>
            )}

            {!isConnected && tab === "market" && <Hero />}
            {isConnected && <GettingStarted />}

            {tab === "market" && <OfferMarket onTradeOpened={selectTrade} onCreateOffer={() => go("sell")} />}

            {tab === "sell" && (isConnected ? (
              <div className="split split-sell">
                <div className="stack sticky">
                  <VaultPanel />
                </div>
                <div className="stack">
                  <OfferMarket mode="mine" />
                  <CreateOfferForm />
                </div>
              </div>
            ) : (
              <ConnectPrompt what="sell" />
            ))}

            {tab === "trades" && (isConnected ? (
              <div className="split split-trades">
                <div className="sticky">
                  <TradesPanel
                    trades={trades.trades}
                    address={address}
                    chainNow={trades.chainNow}
                    arbitrationTimeout={trades.arbitrationTimeout}
                    selectedId={selected}
                    onSelect={selectTrade}
                    error={trades.error}
                    isLoading={trades.isLoading}
                    onBrowse={() => go("market")}
                  />
                </div>
                <div className="stack">
                  {selected !== undefined && !selectedSummary && !trades.isLoading && (
                    <Notice tone="info">Trade #{selected.toString()} isn&apos;t indexed yet — it appears once its transaction is confirmed.</Notice>
                  )}
                  {selectedSummary ? (
                    <TradeDetail key={selectedSummary.tradeId.toString()} summary={selectedSummary} chainNow={trades.chainNow} arbitrationTimeout={trades.arbitrationTimeout} onChanged={trades.refetch} />
                  ) : (
                    selected === undefined && (
                      <Card title="Select a trade">
                        <p className="small muted p0">Pick a trade on the left to see its status, your next step, and the private chat.</p>
                      </Card>
                    )
                  )}
                </div>
              </div>
            ) : (
              <ConnectPrompt what="see your trades" />
            ))}
          </div>
        </main>

        <footer className="footer">
          <div className="container row-between">
            <span>
              EscrowX can&apos;t move, freeze or recover funds in the escrow contract. Token issuers can freeze their own tokens.
              Pre-audit software — don&apos;t use with real funds.
            </span>
            <span className="row" style={{ gap: 14 }}>
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
    </>
  );
}

function ThemeToggle() {
  const { resolved, cycle } = useTheme();
  return (
    <button className="btn btn-ghost btn-icon" onClick={cycle} title={`Switch to ${resolved === "dark" ? "light" : "dark"} mode`} aria-label="Toggle colour theme">
      {resolved === "dark" ? "☀" : "☾"}
    </button>
  );
}

function ConnectPrompt({ what }: { what: string }) {
  return (
    <Card>
      <div className="empty">
        <div className="empty-title">Connect a wallet to {what}</div>
        <div>Any browser wallet works. Nothing is signed or sent until you confirm it in your wallet.</div>
        <ConnectButton />
      </div>
    </Card>
  );
}

function Hero() {
  return (
    <div className="stack">
      <section className="hero">
        <span className="chip"><span className="dot accent" aria-hidden /> non-custodial · open protocol</span>
        <h1>Buy and sell stablecoins for local money, directly with people.</h1>
        <p>
          The seller&apos;s crypto is locked in a smart contract that only the two of you — or an independent arbitrator — can move.
          You pay the seller directly. EscrowX never touches your money.
        </p>
        <div className="row" style={{ justifyContent: "center", marginTop: 24 }}>
          <ConnectButton label="Connect wallet to start" />
        </div>
      </section>
      <div className="features">
        {[
          ["01", "Pick an offer", "Browse sell offers below. Each one is signed by the seller's wallet and checked in your browser."],
          ["02", "Crypto gets locked", "Buying locks the seller's crypto in escrow. Their payment details reach you end-to-end encrypted."],
          ["03", "Pay, then receive", "Pay the seller from your own account. They confirm it arrived and release the crypto to your wallet."],
        ].map(([n, title, body]) => (
          <div key={n} className="card feature">
            <span className="eyebrow">{n}</span>
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
