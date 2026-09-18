// src/components/v4/OfferMarket.tsx — the order book, read from Nostr relays and verified client-side.
// mode="market": everyone's offers in one currency. mode="mine": the connected seller's offers, any currency.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildCancelEvent, type ParsedOffer } from "@escrowx/sdk";
import { useEscrowX } from "@/context/EscrowX";
import { CHAIN_ID, FIAT_CURRENCIES, RELAYS, V4, arbitratorName } from "@/config/v4";
import { Addr, Button, Card, Chip, Empty, Notice, errorText } from "@/components/ui";
import { fmtFiat, fmtToken, parseTokenInput, rememberPeerKey, rememberTradeTerms } from "@/lib/v4/local";

/** Rejections that mean "someone tried to fake or tamper with an offer" (not just old or for another deployment). */
const FORGERY = new Set(["bad_nostr_signature", "malformed_content", "terms_mismatch", "bad_offer_signature", "bad_binding", "binding_mismatch", "tag_mismatch"]);

export function OfferMarket({ mode = "market", onTradeOpened, onCreateOffer }: {
  mode?: "market" | "mine";
  onTradeOpened?: (tradeId: bigint) => void;
  onCreateOffer?: () => void;
}) {
  const { address, client, book } = useEscrowX();
  const [currency, setCurrency] = useState<string>("NGN");
  const [offers, setOffers] = useState<ParsedOffer[]>([]);
  const [forged, setForged] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);

  const query = useMemo(
    () => (mode === "mine" ? { chainId: CHAIN_ID, seller: address } : { chainId: CHAIN_ID, fiatCurrency: currency }),
    [mode, address, currency]
  );

  const load = useCallback(async () => {
    if (!book || (mode === "mine" && !address)) return;
    setLoading(true);
    setRelayError(null);
    try {
      const res = await book.fetch(query);
      setOffers(res.offers.sort((a, b) => Number(a.terms.price) - Number(b.terms.price)));
      setForged(res.rejected.filter((r) => FORGERY.has(r.reason)).length);
    } catch (e) {
      setRelayError(errorText(e));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [book, query, mode, address]);

  useEffect(() => {
    setLoaded(false);
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

  // Hide offers that can't be taken any more (fully sold, cancelled on-chain, or expired).
  const now = Math.floor(Date.now() / 1000);
  const live = offers.filter((o) => {
    const r = remaining.data?.[o.offerHash];
    return Number(o.offer.expiry) > now && (r === undefined || r >= o.offer.minAmount);
  });
  const shown = mode === "mine" ? offers : live;

  const content = (
      <>
        {(relayError || forged > 0) && (
          <div className="stack-sm" style={{ padding: "14px 18px 0" }}>
            {relayError && <Notice tone="error">Couldn&apos;t reach the relays: {relayError}</Notice>}
            {forged > 0 && <Notice tone="warn">{forged} offer{forged === 1 ? "" : "s"} failed signature checks and {forged === 1 ? "was" : "were"} hidden.</Notice>}
          </div>
        )}
        {!loaded && (
          <div className="stack-sm" style={{ padding: 18 }}>
            <div className="skeleton" style={{ width: "40%" }} />
            <div className="skeleton" style={{ width: "75%" }} />
            <div className="skeleton" style={{ width: "60%" }} />
          </div>
        )}
        {loaded && shown.length === 0 && !relayError && (
          mode === "mine" ? (
            <Empty title="No offers yet">Publish one below and it appears in the market for buyers.</Empty>
          ) : (
            <Empty title={`No ${currency} offers right now`} action={onCreateOffer && <Button size="sm" onClick={onCreateOffer}>Create the first offer</Button>}>
              Offers show up here the moment a seller publishes one.
            </Empty>
          )
        )}
        <div>
          {shown.map((o, i) => (
            <OfferRow
              key={o.offerHash}
              offer={o}
              best={mode === "market" && i === 0 && shown.length > 1}
              remaining={remaining.data?.[o.offerHash]}
              isMine={!!address && o.offer.seller.toLowerCase() === address.toLowerCase()}
              onTaken={(id) => {
                rememberPeerKey(id, o.event.pubkey); // seller's verified messaging key
                rememberTradeTerms(id, { price: o.terms.price, fiatCurrency: o.terms.fiatCurrency, paymentMethods: o.terms.paymentMethods });
                onTradeOpened?.(id);
              }}
              onChanged={() => {
                void remaining.refetch();
                void load();
              }}
            />
          ))}
        </div>
      </>
  );

  return (
    mode === "mine" ? (
      <Card title="Your offers" sub="Cancelling blocks the offer on-chain and removes it from relays." flush right={
        <Button size="sm" variant="ghost" onClick={() => void load()} busy={loading}>Refresh</Button>
      }>
        {content}
      </Card>
    ) : (
      <Card
        flush
        title={<>Market <span className="chip">{currency} → {V4.tokenSymbol}</span></>}
        sub={<>Sell offers from {RELAYS.length} public relay{RELAYS.length === 1 ? "" : "s"}, each signature checked in your browser. EscrowX runs no order book.</>}
        right={
          <div className="row">
            <div className="segmented" role="group" aria-label="Currency">
              {FIAT_CURRENCIES.map((c) => (
                <button key={c} aria-pressed={currency === c} onClick={() => setCurrency(c)}>{c}</button>
              ))}
            </div>
            <Button size="sm" variant="ghost" onClick={() => void load()} busy={loading} title="Reload from relays">↻</Button>
          </div>
        }
      >
        {content}
      </Card>
    )
  );
}

function OfferRow({ offer, best, remaining, isMine, onTaken, onChanged }: {
  offer: ParsedOffer;
  best: boolean;
  remaining?: bigint;
  isMine: boolean;
  onTaken: (tradeId: bigint) => void;
  onChanged: () => void;
}) {
  const { address, client, book, identity, unlockMessaging } = useEscrowX();
  const { offer: o, terms } = offer;
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseTokenInput(amount);
  const maxTakeable = remaining === undefined ? o.maxAmount : remaining < o.maxAmount ? remaining : o.maxAmount;
  const amountOk = !!parsed && parsed >= o.minAmount && parsed <= maxTakeable;
  const expiresIn = Number(o.expiry) - Math.floor(Date.now() / 1000);
  const soldPct = remaining === undefined || o.totalAmount === 0n ? 0 : Number(((o.totalAmount - remaining) * 1000n) / o.totalAmount) / 10;
  const payMinutes = Number(o.paymentWindow) / 60;

  async function take() {
    if (!client || !parsed) return;
    setError(null);
    try {
      if (!identity) {
        // Needed to receive the seller's payment details; do it first so the buyer isn't stuck mid-trade.
        setBusy("unlock");
        if (!(await unlockMessaging())) return;
      }
      setBusy("take");
      const tradeId = await client.takeOffer(o, offer.signature, parsed);
      onTaken(tradeId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (!client) return;
    setBusy("cancel");
    setError(null);
    try {
      await client.cancelOffer(o); // the hard guarantee: can never be taken again
      if (book && identity) await book.publish(buildCancelEvent(offer, identity)); // hide it from order books
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="offer">
      <div className="offer-main">
        <div className="offer-price">
          <span className="eyebrow">Price {best && <span className="accent">· best</span>}</span>
          <div className="big-num">{Number(terms.price).toLocaleString("en-US")}</div>
          <span className="tiny faint mono">{terms.fiatCurrency} per {terms.tokenSymbol}</span>
        </div>

        <div className="offer-meta">
          <div className="row" style={{ gap: 6 }}>
            <Addr address={o.seller} you={isMine} />
            <Chip tone="accent" title="Seller's wallet signed this offer and its terms">✓ signed</Chip>
            {expiresIn <= 0 && <Chip tone="danger">expired</Chip>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            {terms.paymentMethods.map((m) => <Chip key={m}>{m}</Chip>)}
          </div>
          <div className="small faint">
            Pay within {payMinutes} min · Disputes: {arbitratorName(o.arbitrator)} · {expiresIn > 0 ? `expires in ${Math.max(1, Math.round(expiresIn / 3600))}h` : "expired"}
          </div>
          {terms.conditions && <p className="offer-terms">{terms.conditions}</p>}
        </div>

        <div className="stack-sm">
          <div className="stack-xs">
            <div className="row-between small">
              <span className="faint">Available</span>
              <span className="mono strong">{remaining === undefined ? "…" : fmtToken(remaining)} {terms.tokenSymbol}</span>
            </div>
            <div className="meter" aria-hidden><span style={{ width: `${100 - soldPct}%` }} /></div>
            <div className="row-between tiny faint">
              <span>Per trade</span>
              <span className="mono">{fmtToken(o.minAmount)} – {fmtToken(maxTakeable)}</span>
            </div>
          </div>

          {isMine ? (
            <Button variant="danger" size="sm" onClick={() => void cancel()} busy={busy === "cancel"} disabled={!client}>Cancel offer</Button>
          ) : (
            <>
              <div className="input-affix">
                <input className="input mono" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`${fmtToken(o.minAmount)} – ${fmtToken(maxTakeable)}`} inputMode="decimal" aria-label={`Amount of ${terms.tokenSymbol} to buy`} />
                <span className="affix">{terms.tokenSymbol}</span>
              </div>
              <Button variant="accent" block onClick={() => void take()} disabled={!address || !amountOk || !client || expiresIn <= 0} busy={!!busy}>
                {!address ? "Connect a wallet to buy" : busy === "unlock" ? "Unlock messaging in wallet…" : busy === "take" ? "Locking seller's crypto…" : amountOk ? `Buy ${amount} ${terms.tokenSymbol}` : "Buy"}
              </Button>
            </>
          )}
        </div>
      </div>

      {!isMine && amountOk && parsed && (
        <div className="buy-summary">
          <div><span className="faint">You pay the seller</span><span className="mono strong">{fmtFiat(parsed, terms.price, terms.fiatCurrency)}</span></div>
          <div><span className="faint">You receive</span><span className="mono">{fmtToken(parsed)} {terms.tokenSymbol}</span></div>
          <div className="faint tiny" style={{ justifyContent: "flex-start" }}>
            Buying locks the seller&apos;s crypto in escrow. You then get their payment details privately, have {payMinutes} min to pay, and the seller releases once the money arrives.
          </div>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </article>
  );
}
