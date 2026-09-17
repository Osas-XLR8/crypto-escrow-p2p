// src/components/v4/OfferMarket.tsx — the order book, read from Nostr relays and verified client-side.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildCancelEvent, type ParsedOffer } from "@escrowx/sdk";
import { useEscrowX } from "@/context/EscrowX";
import { CHAIN_ID, FIAT_CURRENCIES, RELAYS, V4, arbitratorName } from "@/config/v4";
import { Button, Card, Label, Notice, colors, errorText, inputStyle, mono } from "@/components/ui";
import { shortAddr } from "@/lib/format";
import { fmtFiat, fmtToken, parseTokenInput, rememberPeerKey } from "@/lib/v4/local";

export function OfferMarket({ onTradeOpened }: { onTradeOpened: (tradeId: bigint) => void }) {
  const { address, client, book, identity } = useEscrowX();
  const [currency, setCurrency] = useState<string>("NGN");
  const [offers, setOffers] = useState<ParsedOffer[]>([]);
  const [rejected, setRejected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!book) return;
    setLoading(true);
    setRelayError(null);
    try {
      const res = await book.fetch({ chainId: CHAIN_ID, fiatCurrency: currency });
      setOffers(res.offers.sort((a, b) => Number(a.terms.price) - Number(b.terms.price)));
      setRejected(res.rejected.length);
    } catch (e) {
      setRelayError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [book, currency]);

  useEffect(() => {
    void load();
    if (!book) return;
    // Live updates: new or replaced offers re-run the verified fetch (handles cancellations too).
    return book.subscribe({ chainId: CHAIN_ID, fiatCurrency: currency }, () => void load());
  }, [book, currency, load]);

  const hashes = offers.map((o) => o.offerHash).join(",");
  const remaining = useQuery({
    queryKey: ["remaining", hashes],
    enabled: !!client && offers.length > 0,
    refetchInterval: 6000,
    queryFn: async () => Object.fromEntries(await Promise.all(offers.map(async (o) => [o.offerHash, await client!.remaining(o.offer)] as const))),
  });

  return (
    <Card
      title="MARKET · SELL OFFERS"
      right={
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ ...inputStyle, width: 90, padding: "6px 8px" }}>
            {FIAT_CURRENCIES.map((c) => <option key={c}>{c}</option>)}
          </select>
          <Button onClick={() => void load()} disabled={loading || !book}>{loading ? "Loading…" : "Refresh"}</Button>
        </div>
      }
    >
      <p style={{ color: "#64748b", fontSize: 12, margin: "0 0 12px", lineHeight: 1.5 }}>
        Offers come straight from {RELAYS.length} Nostr relay{RELAYS.length === 1 ? "" : "s"}. Your browser checks every
        seller signature and terms commitment itself — EscrowX runs no order book.
        {rejected > 0 && <span style={{ color: colors.amberText }}> {rejected} invalid or forged offer{rejected === 1 ? " was" : "s were"} hidden.</span>}
      </p>

      {relayError && <Notice tone="error">Couldn&apos;t reach relays: {relayError}</Notice>}
      {!loading && offers.length === 0 && !relayError && <Notice tone="info">No {currency} offers yet.</Notice>}

      <div style={{ display: "grid", gap: 10 }}>
        {offers.map((o) => (
          <OfferRow
            key={o.offerHash}
            offer={o}
            remaining={remaining.data?.[o.offerHash]}
            isMine={!!address && o.offer.seller.toLowerCase() === address.toLowerCase()}
            canTransact={!!client && !!address}
            messagingUnlocked={!!identity}
            onTaken={(id) => {
              rememberPeerKey(id, o.event.pubkey); // seller's verified messaging key
              onTradeOpened(id);
            }}
            onChanged={() => {
              void remaining.refetch();
              void load();
            }}
          />
        ))}
      </div>
    </Card>
  );
}

function OfferRow({ offer, remaining, isMine, canTransact, messagingUnlocked, onTaken, onChanged }: {
  offer: ParsedOffer;
  remaining?: bigint;
  isMine: boolean;
  canTransact: boolean;
  messagingUnlocked: boolean;
  onTaken: (tradeId: bigint) => void;
  onChanged: () => void;
}) {
  const { client, book, identity } = useEscrowX();
  const { offer: o, terms } = offer;
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseTokenInput(amount);
  const maxTakeable = remaining === undefined ? o.maxAmount : remaining < o.maxAmount ? remaining : o.maxAmount;
  const amountOk = !!parsed && parsed >= o.minAmount && parsed <= maxTakeable;
  const expiresIn = Number(o.expiry) - Math.floor(Date.now() / 1000);

  const fiatRange = useMemo(() => `${fmtFiat(o.minAmount, terms.price, terms.fiatCurrency)} – ${fmtFiat(maxTakeable, terms.price, terms.fiatCurrency)}`, [o.minAmount, maxTakeable, terms]);

  async function take() {
    if (!client || !parsed) return;
    setBusy("take");
    setError(null);
    try {
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
    <div style={{ padding: 14, borderRadius: 10, background: "#060d1a", border: `1px solid ${isMine ? "#1e3a5f" : "#0f172a"}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
        <div>
          <span style={{ fontSize: 20, fontWeight: 700, color: colors.strong }}>{Number(terms.price).toLocaleString("en-US")}</span>
          <span style={{ color: colors.muted, fontSize: 12, marginLeft: 6 }}>{terms.fiatCurrency} / {terms.tokenSymbol}</span>
          {isMine && <span style={{ marginLeft: 8, fontSize: 9, padding: "2px 6px", borderRadius: 8, background: "#1e3a5f", color: colors.blueText, letterSpacing: "0.08em" }}>YOUR OFFER</span>}
        </div>
        <div style={{ textAlign: "right", fontSize: 12, color: "#94a3b8" }}>
          <div>Available: <strong style={{ color: colors.greenText }}>{remaining === undefined ? "…" : fmtToken(remaining)} {terms.tokenSymbol}</strong></div>
          <div style={{ color: colors.muted }}>Per trade: {fmtToken(o.minAmount)}–{fmtToken(o.maxAmount)} · {fiatRange}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: colors.muted, marginTop: 8 }}>
        <span>Seller <code style={{ fontFamily: mono, color: "#94a3b8" }}>{shortAddr(o.seller)}</code> <span style={{ color: colors.greenText }}>✓ signed</span></span>
        <span>Pays via {terms.paymentMethods.join(", ")}</span>
        <span>Pay within {Number(o.paymentWindow) / 60} min</span>
        <span>Arbitrator: {arbitratorName(o.arbitrator)}</span>
        <span>{expiresIn > 0 ? `Expires in ${Math.max(1, Math.round(expiresIn / 3600))}h` : "Expired"}</span>
      </div>
      {terms.conditions && <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>“{terms.conditions}”</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "end" }}>
        {isMine ? (
          <Button variant="danger" onClick={() => void cancel()} disabled={!!busy || !canTransact}>
            {busy === "cancel" ? "Cancelling…" : "Cancel offer"}
          </Button>
        ) : (
          <>
            <label style={{ flex: "1 1 160px" }}>
              <Label hint={parsed && amountOk ? `≈ ${fmtFiat(parsed, terms.price, terms.fiatCurrency)}` : undefined}>BUY {terms.tokenSymbol}</Label>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`${fmtToken(o.minAmount)}–${fmtToken(maxTakeable)}`} inputMode="decimal" style={inputStyle} />
            </label>
            <Button variant="primary" solid onClick={() => void take()} disabled={!amountOk || !!busy || !canTransact}
              title={!messagingUnlocked ? "Tip: unlock messaging first so you can receive the seller's payment details" : undefined}>
              {busy === "take" ? "Locking seller's funds…" : "Buy"}
            </Button>
          </>
        )}
      </div>
      {!isMine && !messagingUnlocked && canTransact && (
        <div style={{ fontSize: 11, color: colors.muted, marginTop: 6 }}>You&apos;ll need to unlock messaging after buying to receive payment details.</div>
      )}
      {error && <div style={{ marginTop: 10 }}><Notice tone="error">{error}</Notice></div>}
    </div>
  );
}
