// src/pages/index.tsx — EscrowX v4 web app.
// Market (offers from Nostr relays) · Sell (vault + publish offers) · Trades (on-chain trades, chat, disputes).

import Head from "next/head";
import { useEffect, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { Button, Card, Notice } from "@/components/ui";
import { ConnectPrompt, Shell } from "@/components/Shell";
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
  const [tab, setTab] = useState<Tab>("market");
  const [selected, setSelected] = useState<bigint | undefined>();
  const trades = useV4Trades();

  // Trades where it's this wallet's move (same rule as the "To do" filter).
  const myActionCount = trades.trades.filter(
    (t) => nextStep(t, { address, chainNow: trades.chainNow, arbitrationTimeout: trades.arbitrationTimeout }).mine
  ).length;

  // Deep link: /?trade=12
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("trade");
    const requested = params.get("tab");
    if (t && /^\d+$/.test(t)) {
      setSelected(BigInt(t));
      setTab("trades");
    } else if (requested === "sell" || requested === "trades" || requested === "market") {
      setTab(requested);
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

  return (
    <>
      <Head>
        <title>EscrowX — peer-to-peer crypto, non-custodial</title>
        <meta name="description" content="Buy and sell stablecoins for local currency, peer to peer. Funds sit in a contract only the parties and independent arbitrators control." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <Shell
        onBrand={() => go("market")}
        nav={
          <nav className="nav" aria-label="Main">
            {([["market", "Market"], ["sell", "Sell"], ["trades", "Trades"]] as const).map(([key, label]) => (
              <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => go(key)}>
                {label}
                {key === "trades" && myActionCount > 0 && <span className="count count-hot" title="Waiting on you">{myActionCount}</span>}
              </button>
            ))}
          </nav>
        }
      >
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
      </Shell>
    </>
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
