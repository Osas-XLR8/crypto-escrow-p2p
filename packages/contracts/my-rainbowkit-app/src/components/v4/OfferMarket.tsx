// src/components/v4/OfferMarket.tsx — the order book, read from Nostr relays and verified client-side.
//
// Two sides, like any P2P market:
//   • "Buy"  — sell offers: someone sells crypto; you take it, their crypto locks, you pay them fiat.
//   • "Sell" — buy offers: someone wants crypto; you fill it, YOUR crypto locks, they pay you fiat.
// mode="mine" lists the connected wallet's own offers on both sides.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, formatEther } from "viem";
import { usePublicClient } from "wagmi";
import { buildCancelEvent, type OfferSide, type ParsedOffer } from "@escrowx/sdk";
import { useEscrowX } from "@/context/EscrowX";
import { useFirmPanels } from "@/hooks/useFirmPanels";
import { usePendingAction } from "@/hooks/usePendingAction";
import { PendingNotice, pendingLabel } from "@/components/v4/Pending";
import { Reputation, useReputation } from "@/components/v4/Reputation";
import { CHAIN_ID, FIAT_CURRENCIES, RELAYS, V4, arbitratorName } from "@/config/v4";
import { Addr, Button, Card, Chip, Empty, Notice, errorText } from "@/components/ui";
import { fmtDuration } from "@/lib/format";
import { fmtFiat, fmtToken, parseTokenInput, rememberTradeTerms, rememberTradeTx, termsFromOffer } from "@/lib/v4/local";

/** Rejections that mean "someone tried to fake or tamper with an offer" (not just old or for another deployment). */
/** Below this, a "median" is just one person's opinion. */
const MIN_FOR_MEDIAN = 3;
/** How long the offer list must stop changing before anything is concluded from it — see `settled`. */
const EMPTY_GRACE_MS = 1500;

const FORGERY = new Set(["bad_nostr_signature", "malformed_content", "terms_mismatch", "bad_offer_signature", "bad_binding", "binding_mismatch", "tag_mismatch"]);
const SYM = V4.tokenSymbol;

/** What the viewer wants to do → which offers to show. */
type Intent = "buy" | "sell";
const offersFor = (intent: Intent): OfferSide => (intent === "buy" ? "sell" : "buy");

export function OfferMarket({ mode = "market", onTradeOpened, onCreateOffer }: {
  mode?: "market" | "mine";
  onTradeOpened?: (tradeId: bigint) => void;
  onCreateOffer?: (side: OfferSide) => void;
}) {
  const { address, client, book } = useEscrowX();
  const publicClient = usePublicClient();
  const [intent, setIntent] = useState<Intent>("buy");
  const [currency, setCurrency] = useState<string>("NGN");
  const [offers, setOffers] = useState<ParsedOffer[]>([]);
  const [forged, setForged] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);

  const side = offersFor(intent);
  const query = useMemo(
    () => (mode === "mine" ? { chainId: CHAIN_ID, maker: address } : { chainId: CHAIN_ID, fiatCurrency: currency, side }),
    [mode, address, currency, side]
  );

  const load = useCallback(async () => {
    if (!book || (mode === "mine" && !address)) return;
    setLoading(true);
    setRelayError(null);
    try {
      const res = await book.fetch(query);
      // Best price first: lowest ask when buying, highest bid when selling.
      const sorted = res.offers.sort((a, b) => Number(a.terms.price) - Number(b.terms.price));
      setOffers(mode === "market" && side === "buy" ? sorted.reverse() : sorted);
      setForged(res.rejected.filter((r) => FORGERY.has(r.reason)).length);
    } catch (e) {
      setRelayError(errorText(e));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [book, query, mode, address, side]);

  useEffect(() => {
    setLoaded(false);
    setOffers([]);
    void load();
    if (!book) return;
    // Live updates: new or replaced offers re-run the verified fetch (handles cancellations too).
    return book.subscribe(query, () => void load());
  }, [book, query, load]);

  const hashes = offers.map((o) => o.offerHash).join(",");
  const remaining = useQuery({
    queryKey: ["remaining", hashes],
    enabled: !!client && offers.length > 0,
    refetchInterval: 8000,
    queryFn: async () => Object.fromEntries(await Promise.all(offers.map(async (o) => [o.offerHash, await client!.remaining(o.offer)] as const))),
  });

  // What the viewer could sell into a buy offer: their free vault balance plus their wallet balance.
  const funds = useQuery({
    queryKey: ["sellerFunds", address],
    enabled: !!address && !!client && !!publicClient && mode === "market" && side === "buy",
    refetchInterval: 10_000,
    queryFn: async () => {
      const [vault, wallet] = await Promise.all([
        client!.freeBalance(address!, V4.usdt),
        publicClient!.readContract({ address: V4.usdt, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
      ]);
      return { vault, wallet };
    },
  });

  // Hide offers that can't be taken any more (fully filled, cancelled on-chain, or expired).
  const now = Math.floor(Date.now() / 1000);
  const live = offers.filter((o) => {
    const r = remaining.data?.[o.offerHash];
    return Number(o.offer.expiry) > now && (r === undefined || r >= o.offer.minAmount);
  });
  const shown = mode === "mine" ? offers : live;

  // A price means nothing on its own: 1,592 NGN is a bargain or a rip-off depending on what everyone else is
  // asking. The median of the live offers on this side is the most honest reference available without
  // trusting a price feed — it's the same data on screen, and it can't be moved by one outlier.
  // Has the list stopped moving? Every claim this component makes about the market — that it is empty, that
  // there are too few offers to take a median — is a claim about all the offers, and book.fetch() only
  // resolves for the relays it reached. A straggler can still deliver over the subscription a moment later,
  // so anything read off a still-growing list is liable to be wrong and then correct itself on screen.
  const [settled, setSettled] = useState(false);
  // A new market starts unsettled; nothing carries over from the last one.
  useEffect(() => setSettled(false), [query]);
  useEffect(() => {
    if (!loaded || settled) return;
    // Restarts whenever another offer lands, so the list has to stop growing before anything is read off it.
    // Deliberately not keyed on `loading`: the relay subscription re-runs the fetch on every event it sees,
    // so a chatty relay would keep flipping that flag and the bar would hold its skeleton forever.
    const t = setTimeout(() => setSettled(true), EMPTY_GRACE_MS);
    return () => clearTimeout(t);
  }, [loaded, settled, shown.length, query]);

  const prices = shown.map((o) => Number(o.terms.price)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const median = prices.length >= MIN_FOR_MEDIAN
    ? prices.length % 2 ? prices[(prices.length - 1) / 2]! : (prices[prices.length / 2 - 1]! + prices[prices.length / 2]!) / 2
    : undefined;

  const content = (
    <>
      {(relayError || forged > 0) && (
        <div className="stack-sm" style={{ padding: "14px 18px 0" }}>
          {relayError && <Notice tone="error">Couldn&apos;t reach the relays: {relayError}</Notice>}
          {forged > 0 && <Notice tone="warn">{forged} offer{forged === 1 ? "" : "s"} failed signature checks and {forged === 1 ? "was" : "were"} hidden.</Notice>}
        </div>
      )}
      {(!loaded || (shown.length === 0 && !settled && !relayError)) && (
        <div className="stack-sm" style={{ padding: 18 }}>
          <div className="skeleton" style={{ width: "40%" }} />
          <div className="skeleton" style={{ width: "75%" }} />
          <div className="skeleton" style={{ width: "60%" }} />
        </div>
      )}
      {loaded && settled && shown.length === 0 && !relayError && (
        mode === "mine" ? (
          <Empty title="No offers yet">Post one below — to sell crypto, or to buy it.</Empty>
        ) : (
          <Empty
            title={intent === "buy" ? `Nobody is selling ${SYM} for ${currency} right now` : `Nobody wants to buy ${SYM} for ${currency} right now`}
            action={onCreateOffer && <Button size="sm" onClick={() => onCreateOffer(intent)}>{intent === "buy" ? "Post a buy offer" : "Post a sell offer"}</Button>}
          >
            Post your own offer and it appears here the moment it&apos;s signed.
          </Empty>
        )
      )}
      {mode === "market" && median !== undefined && (
        <div className="row-between small" style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <span className="faint">
            Market median · {intent === "buy" ? "asks" : "bids"} on {SYM}/{currency}
          </span>
          <span className="mono strong" title={`Middle price of the ${prices.length} live offers listed here. Not a price feed — it's this market, right now.`}>
            {median.toLocaleString("en-US")} {currency} <span className="faint">· {prices.length} offers</span>
          </span>
        </div>
      )}
      {/* Say why the bar is missing. Seeing a median on one tab and nothing on the other reads as a bug,
          when it is the threshold doing its job: a "median" of two offers is just somebody's price. */}
      {mode === "market" && median === undefined && prices.length > 0 && !settled && (
        <div className="row-between small" style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <span className="faint">
            Market median · {intent === "buy" ? "asks" : "bids"} on {SYM}/{currency}
          </span>
          <span className="skeleton" style={{ width: 130, height: 14, display: "inline-block" }} aria-label="Reading the market median" />
        </div>
      )}
      {mode === "market" && median === undefined && prices.length > 0 && settled && (
        <div className="row-between small" style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <span className="faint">
            Market median · {intent === "buy" ? "asks" : "bids"} on {SYM}/{currency}
          </span>
          <span className="faint" title={`A median needs at least ${MIN_FOR_MEDIAN} live offers to mean anything. With ${prices.length}, it would just be one trader's price wearing a statistic's clothes.`}>
            too few offers · {prices.length} of {MIN_FOR_MEDIAN}
          </span>
        </div>
      )}
      <div>
        {shown.map((o, i) => (
          <OfferRow
            key={o.offerHash}
            offer={o}
            reference={median}
            intent={intent}
            best={mode === "market" && i === 0 && shown.length > 1}
            remaining={remaining.data?.[o.offerHash]}
            funds={funds.data}
            isMine={!!address && o.maker.toLowerCase() === address.toLowerCase()}
            onTaken={(id) => {
              rememberTradeTerms(id, termsFromOffer(o)); // price, side and the maker's verified chat key
              onTradeOpened?.(id);
            }}
            onChanged={() => {
              void remaining.refetch();
              void funds.refetch();
              void load();
            }}
          />
        ))}
      </div>
    </>
  );

  return mode === "mine" ? (
    <Card title="Your offers" sub="Cancelling blocks the offer on-chain and removes it from relays." flush right={
      <Button size="sm" variant="ghost" onClick={() => void load()} busy={loading}>Refresh</Button>
    }>
      {content}
    </Card>
  ) : (
    <Card
      flush
      title={
        <div className="segmented segmented-lg" role="tablist" aria-label="What do you want to do?">
          <button role="tab" aria-pressed={intent === "buy"} onClick={() => setIntent("buy")}>Buy {SYM}</button>
          <button role="tab" aria-pressed={intent === "sell"} onClick={() => setIntent("sell")}>Sell {SYM}</button>
        </div>
      }
      sub={
        intent === "buy"
          ? <>People selling {SYM} for {currency}. Their crypto locks in escrow when you buy; you pay them directly.</>
          : <>People who want to buy {SYM} with {currency}. Your crypto locks in escrow when you sell; they pay you directly.</>
      }
      right={
        <div className="row">
          <div className="segmented" role="group" aria-label="Currency">
            {FIAT_CURRENCIES.map((c) => (
              <button key={c} aria-pressed={currency === c} onClick={() => setCurrency(c)}>{c}</button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => void load()} busy={loading} title={`Reload from ${RELAYS.length} relay${RELAYS.length === 1 ? "" : "s"}`}>↻</Button>
        </div>
      }
    >
      {content}
    </Card>
  );
}

function OfferRow({ offer, best, reference, intent, remaining, funds, isMine, onTaken, onChanged }: {
  offer: ParsedOffer;
  best: boolean;
  /** Median price of the offers listed beside this one, when there are enough to mean anything. */
  reference?: number;
  intent?: Intent;
  remaining?: bigint;
  funds?: { vault: bigint; wallet: bigint };
  isMine: boolean;
  onTaken: (tradeId: bigint) => void;
  onChanged: () => void;
}) {
  const { address, client, book, identity, unlockMessaging } = useEscrowX();
  const { status: panelStatus } = useFirmPanels();
  const reputationOf = useReputation();
  const { offer: o, terms, side } = offer;
  const firm = panelStatus(o.arbitrator);
  const [amount, setAmount] = useState("");
  const pending = usePendingAction();
  const busy = pending.busy;

  const isBuyOffer = side === "buy";
  const parsed = parseTokenInput(amount);
  const cap = remaining === undefined ? o.maxAmount : remaining < o.maxAmount ? remaining : o.maxAmount;
  const available = funds ? funds.vault + funds.wallet : undefined;
  const sellerCanFund = !isBuyOffer || !parsed || available === undefined || parsed <= available;
  const amountOk = !!parsed && parsed >= o.minAmount && parsed <= cap && sellerCanFund;
  // A button that greys out without saying why is a dead end. The amount box is the one field a person can
  // get wrong here, and every limit it can break is already on screen — so quote it back at them. Stays
  // quiet while the box is empty: nobody needs to be told off for not having typed yet.
  const amountProblem = !amount.trim() || amountOk
    ? null
    : !parsed
      // parseTokenInput rejects anything that isn't a positive decimal, so "-10" and "abc" arrive here
      // together. They are different mistakes and deserve different answers.
      ? Number(amount) <= 0 && Number.isFinite(Number(amount))
        ? "Amount must be greater than 0"
        : "Enter an amount in numbers"
      : parsed < o.minAmount
        ? `Minimum is ${fmtToken(o.minAmount)} ${terms.tokenSymbol} per trade`
        : parsed > cap
          ? remaining !== undefined && remaining < o.maxAmount
            ? `Only ${fmtToken(cap)} ${terms.tokenSymbol} left on this offer`
            : `Maximum is ${fmtToken(cap)} ${terms.tokenSymbol} per trade`
          : !sellerCanFund && available !== undefined
            ? `You have ${fmtToken(available)} ${SYM} — lower the amount or top up`
            : null;
  const expiresIn = Number(o.expiry) - Math.floor(Date.now() / 1000);
  const filledPct = remaining === undefined || o.totalAmount === 0n ? 0 : Number(((o.totalAmount - remaining) * 1000n) / o.totalAmount) / 10;
  const payMinutes = Number(o.paymentWindow) / 60;
  const fromWallet = isBuyOffer && parsed && funds && parsed > funds.vault ? parsed - funds.vault : 0n;

  // Cheaper is better when you're buying, dearer when you're selling; 0.5% either way is just noise.
  const vsMarket = (() => {
    if (!reference || !intent) return null;
    const diff = (Number(terms.price) - reference) / reference;
    if (Math.abs(diff) < 0.005) return { text: "at market", good: false, bad: false };
    const favourable = intent === "buy" ? diff < 0 : diff > 0;
    return {
      text: `${diff > 0 ? "+" : ""}${(diff * 100).toFixed(1)}% vs market`,
      good: favourable,
      bad: !favourable && Math.abs(diff) >= 0.03,
    };
  })();

  // Everything the wallet will ask for, in order, so nobody is surprised by a second or third prompt.
  const plan = [
    ...(identity ? [] : ["Sign to unlock private messaging (free)"]),
    ...(fromWallet > 0n ? [`Approve ${fmtToken(fromWallet)} ${SYM}`] : []),
    isBuyOffer ? "Lock your crypto in escrow" : "Lock the seller's crypto in escrow",
  ];

  async function take() {
    if (!client || !parsed) return;
    const before = identity ? 0 : 1;
    const total = plan.length;
    await pending.run("take", async (ctx) => {
      // Hold on to the transaction that opens the trade: the trade list is built from logs, which lag the
      // transaction by a few blocks, and during that gap this hash is the only thing that can be shown.
      let openedBy: string | undefined;
      const stopWatching = client.onActivity((a) => {
        if (a.functionName === "takeOffer" && "hash" in a) openedBy = a.hash;
      });
      try {
      if (!identity) {
        // Needed for the private chat (payment details); do it first so nobody is stuck mid-trade.
        ctx.step({ index: 1, total, label: plan[0]! });
        ctx.phase("signing");
        const unlocked = await unlockMessaging();
        if (!unlocked) throw new Error("Messaging wasn't unlocked, so the trade wasn't opened.");
      }
      const tradeId = await client.takeOffer(o, offer.signature, parsed, {
        onStep: (step) => ctx.step({ index: before + step.index, total, label: step.label }),
      });
      if (openedBy) rememberTradeTx(tradeId, openedBy);
      onTaken(tradeId);
      } finally {
        stopWatching();
      }
    });
  }

  async function cancel() {
    if (!client) return;
    await pending.run(
      "cancel",
      async () => {
        await client.cancelOffer(o); // the hard guarantee: can never be taken again
        if (book && identity) await book.publish(buildCancelEvent(offer, identity)); // hide it from order books
      },
      { success: "Offer cancelled on-chain and withdrawn from the relays.", onDone: onChanged }
    );
  }

  const actionLabel = isBuyOffer ? "Sell" : "Buy";
  return (
    <article className="offer">
      <div className="offer-main">
        <div className="offer-price">
          <span className="eyebrow">{isBuyOffer ? "Pays" : "Price"} {best && <span className="accent">· best</span>}</span>
          <div className="big-num">{Number(terms.price).toLocaleString("en-US")}</div>
          <span className="tiny faint mono">{terms.fiatCurrency} per {terms.tokenSymbol}</span>
          {vsMarket && (
            <span className={`tiny mono ${vsMarket.good ? "accent" : vsMarket.bad ? "warn" : "faint"}`} title={`Median of the live offers here: ${reference!.toLocaleString("en-US")} ${terms.fiatCurrency}`}>
              {vsMarket.text}
            </span>
          )}
        </div>

        <div className="offer-meta">
          <div className="row" style={{ gap: 6 }}>
            <span className={`chip ${isBuyOffer ? "chip-info" : "chip-accent"}`}>{isBuyOffer ? "Buying" : "Selling"}</span>
            <Addr address={offer.maker} you={isMine} />
            <Chip tone="accent" title={`The ${isBuyOffer ? "buyer" : "seller"}'s wallet signed this offer and its terms`}>✓ signed</Chip>
            {expiresIn <= 0 && <Chip tone="danger">expired</Chip>}
          </div>
          <Reputation stats={reputationOf(offer.maker)} />
          <div className="row" style={{ gap: 6 }}>
            <span className="tiny faint">{isBuyOffer ? "Pays with" : "Accepts"}</span>
            {terms.paymentMethods.map((m) => <Chip key={m}>{m}</Chip>)}
          </div>
          <div className="small faint">
            {isBuyOffer ? `Buyer pays within ${payMinutes} min` : `Pay within ${payMinutes} min`} · No EscrowX fee · Disputes: {arbitratorName(o.arbitrator)}
            {!firm.staffed && (
              <> <Chip tone="warn" title="This firm has no panelists registered, so it cannot assign a dispute to anyone. A dispute here would only end on the escrow's timeout.">no panel yet</Chip></>
            )}
            {" · "}{expiresIn > 0 ? `expires in ${fmtDuration(expiresIn)}` : "expired"}
          </div>
          {terms.conditions && <p className="offer-terms">{terms.conditions}</p>}
        </div>

        <div className="stack-sm">
          <div className="stack-xs">
            <div className="row-between small">
              <span className="faint">{isBuyOffer ? "Still wants" : "Available"}</span>
              {remaining === undefined
                ? <span className="skeleton" style={{ width: 72, height: 14, display: "inline-block" }} aria-label={`Reading how much ${terms.tokenSymbol} is left`} />
                : <span className="mono strong">{fmtToken(remaining)} {terms.tokenSymbol}</span>}
            </div>
            <div className="meter" aria-hidden><span style={{ width: `${100 - filledPct}%` }} /></div>
            <div className="row-between tiny faint">
              <span>Per trade</span>
              <span className="mono">{fmtToken(o.minAmount)} – {fmtToken(cap)}</span>
            </div>
          </div>

          {isMine ? (
            <Button variant="danger" size="sm" onClick={() => void cancel()} busy={busy === "cancel"} disabled={!client}>Cancel offer</Button>
          ) : (
            <>
              <div className="input-affix">
                <input className="input mono" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`${fmtToken(o.minAmount)} – ${fmtToken(cap)}`} inputMode="decimal" aria-label={`Amount of ${terms.tokenSymbol} to ${actionLabel.toLowerCase()}`} />
                <span className="affix">{terms.tokenSymbol}</span>
              </div>
              {amountProblem && <div className="tiny" role="alert" style={{ color: "var(--danger)" }}>{amountProblem}</div>}
              {isBuyOffer && address && available !== undefined && (
                <div className="tiny faint">You have {fmtToken(available)} {SYM} <span className="mono">(vault {fmtToken(funds!.vault)} · wallet {fmtToken(funds!.wallet)})</span></div>
              )}
              <Button variant="accent" block onClick={() => void take()} disabled={!address || !amountOk || !client || expiresIn <= 0} busy={!!busy}>
                {!address
                  ? `Connect a wallet to ${actionLabel.toLowerCase()}`
                  : busy
                    ? pendingLabel(pending, "")
                    : parsed && !sellerCanFund
                      ? `Not enough ${SYM}`
                      : amountOk
                        ? `${actionLabel} ${amount} ${terms.tokenSymbol}`
                        : actionLabel}
              </Button>
            </>
          )}
        </div>
      </div>

      {!isMine && amountOk && parsed && (
        <div className="buy-summary">
          <div>
            <span className="faint">EscrowX fee</span>
            <span className="mono strong">none · 0%</span>
          </div>
          <div className="faint tiny">
            <span>
              The escrow takes no cut of this trade. You pay the network&apos;s gas for your own transactions, and
              nothing else unless it goes to dispute — then each side puts up{" "}
              <span className="mono">{firm.fee === undefined ? "the firm's fee" : `${formatEther(firm.fee)} ETH`}</span>{" "}
              for {arbitratorName(o.arbitrator)}, refunded to whoever wins.
            </span>
          </div>
          {plan.length > 1 && (
            <div className="faint tiny">
              <span>Your wallet will ask {plan.length} times: {plan.map((step, i) => `${i + 1}. ${step}`).join(" · ")}.</span>
            </div>
          )}
          {isBuyOffer ? (
            <>
              <div><span className="faint">The buyer pays you</span><span className="mono strong">{fmtFiat(parsed, terms.price, terms.fiatCurrency)}</span></div>
              <div><span className="faint">You lock in escrow</span><span className="mono">{fmtToken(parsed)} {terms.tokenSymbol}</span></div>
              <div className="faint tiny" style={{ justifyContent: "flex-start" }}>
                Your crypto stays locked until you confirm the money arrived in your account{fromWallet > 0n ? ` — ${fmtToken(fromWallet)} ${SYM} comes from your wallet, so your wallet first asks you to approve exactly that` : ""}.
                You then share your payment details in the private chat.
              </div>
            </>
          ) : (
            <>
              <div><span className="faint">You pay the seller</span><span className="mono strong">{fmtFiat(parsed, terms.price, terms.fiatCurrency)}</span></div>
              <div><span className="faint">You receive</span><span className="mono">{fmtToken(parsed)} {terms.tokenSymbol}</span></div>
              <div className="faint tiny" style={{ justifyContent: "flex-start" }}>
                Buying locks the seller&apos;s crypto in escrow. Their payment details reach you in the private chat, you have {payMinutes} min to pay, and the seller releases once the money arrives.
              </div>
            </>
          )}
        </div>
      )}
      <PendingNotice pending={pending} />
    </article>
  );
}
