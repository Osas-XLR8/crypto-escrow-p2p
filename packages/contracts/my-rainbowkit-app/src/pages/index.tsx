// src/pages/index.tsx — EscrowX v4 web app.
// Market (buy or sell, offers from Nostr relays) · My offers (vault + post offers on either side) ·
// Trades (on-chain trades, encrypted chat, disputes).

import Head from "next/head";
import { useCallback, useEffect, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import type { OfferSide } from "@escrowx/sdk";
import { V4 } from "@/config/v4";
import { Button, Card, Notice } from "@/components/ui";
import { ConnectPrompt, Shell } from "@/components/Shell";
import { MessagesProvider, useMessages } from "@/context/Messages";
import { OfferMarket } from "@/components/v4/OfferMarket";
import { CreateOfferForm } from "@/components/v4/CreateOfferForm";
import { VaultPanel } from "@/components/v4/VaultPanel";
import { TradesPanel } from "@/components/v4/TradesPanel";
import { TradeDetail } from "@/components/v4/TradeDetail";
import { GettingStarted } from "@/components/v4/GettingStarted";
import { useV4Trades, type V4TradesResult } from "@/hooks/useV4Trades";
import { useTradeAlerts } from "@/hooks/useTradeAlerts";
import { nextStep } from "@/lib/v4/tradeIndex";

type Tab = "market" | "offers" | "trades";
const SYM = V4.tokenSymbol;

export default function Home() {
  const { address } = useAccount();
  const [tab, setTab] = useState<Tab>("market");
  const [selected, setSelected] = useState<bigint | undefined>();
  const trades = useV4Trades();

  const go = useCallback((next: Tab) => {
    setTab(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const selectTrade = useCallback((id: bigint) => {
    setSelected(id);
    setTab("trades");
    window.history.replaceState(null, "", `?trade=${id}`);
  }, []);

  useTradeAlerts(trades.trades, address, selectTrade);

  // Deep links: /?trade=12, /?tab=offers
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("trade");
    const requested = params.get("tab");
    if (t && /^\d+$/.test(t)) {
      setSelected(BigInt(t));
      setTab("trades");
    } else if (requested === "offers" || requested === "sell") {
      setTab("offers");
    } else if (requested === "trades" || requested === "market") {
      setTab(requested);
    }
  }, []);

  return (
    <>
      <Head>
        <title>EscrowX — peer-to-peer crypto, non-custodial</title>
        <meta name="description" content="Buy and sell stablecoins for local currency, peer to peer. Funds sit in a contract only the parties and independent arbitrators control." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <MessagesProvider trades={trades.trades} onOpenTrade={selectTrade}>
        <App tab={tab} go={go} selected={selected} selectTrade={selectTrade} trades={trades} />
      </MessagesProvider>
    </>
  );
}

function App({ tab, go, selected, selectTrade, trades }: {
  tab: Tab;
  go: (t: Tab) => void;
  selected?: bigint;
  selectTrade: (id: bigint) => void;
  trades: V4TradesResult;
}) {
  const { address, isConnected } = useAccount();
  const messages = useMessages();
  const [offerSide, setOfferSide] = useState<OfferSide>("sell");

  // Trades where it's this wallet's move (same rule as the "To do" filter).
  const myActionCount = trades.trades.filter(
    (t) => nextStep(t, { address, chainNow: trades.chainNow, arbitrationTimeout: trades.arbitrationTimeout }).mine
  ).length;
  const badge = myActionCount + messages.totalUnread;
  const selectedSummary = trades.trades.find((t) => t.tradeId === selected);

  return (
    <Shell
      onBrand={() => go("market")}
      nav={
        <nav className="nav" aria-label="Main">
          {([["market", "Market"], ["offers", "My offers"], ["trades", "Trades"]] as const).map(([key, label]) => (
            <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => go(key)}>
              {label}
              {key === "trades" && badge > 0 && (
                <span className="count count-hot" title={`${myActionCount} waiting on you · ${messages.totalUnread} unread messages`}>{badge}</span>
              )}
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

      {tab === "market" && (
        <OfferMarket
          onTradeOpened={selectTrade}
          onCreateOffer={(side) => {
            setOfferSide(side === "buy" ? "buy" : "sell");
            go("offers");
          }}
        />
      )}

      {tab === "offers" && (isConnected ? (
        <div className="split split-sell">
          <div className="stack sticky">
            <VaultPanel />
          </div>
          <div className="stack">
            <CreateOfferForm initialSide={offerSide} />
            <OfferMarket mode="mine" />
          </div>
        </div>
      ) : (
        <ConnectPrompt what="post offers" />
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
  );
}

function Hero() {
  return (
    <div className="stack">
      <section className="hero">
        <span className="chip"><span className="dot accent" aria-hidden /> non-custodial · open protocol</span>
        <h1>Buy and sell stablecoins for local money, directly with people.</h1>
        <p>
          Whoever sells has their crypto locked in a smart contract that only the two of you — or an independent arbitrator — can move.
          The buyer pays the seller directly. EscrowX never touches your money.
        </p>
        <div className="row" style={{ justifyContent: "center", marginTop: 24 }}>
          <ConnectButton label="Connect wallet to start" />
        </div>
      </section>
      <div className="features">
        {[
          ["01", "Buy or sell", `Take someone's offer below, or post your own — to sell ${SYM} or to buy it. Every offer is signed by a wallet and checked in your browser.`],
          ["02", "Crypto gets locked", "When a trade opens, the seller's crypto locks in escrow. You talk privately, end-to-end encrypted, to share payment details."],
          ["03", "Pay, then release", "The buyer pays from their own account and taps “I've paid”. The seller checks their bank and releases. Both sides get notified at each step."],
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
