// src/components/v4/CreateOfferForm.tsx — sign an offer (to sell or to buy) and publish it to Nostr relays.

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWalletClient } from "wagmi";
import { buildOfferEvent, createBuyOffer, createOffer, signOffer, type OfferSide, type OfferTerms, type PublishResult } from "@escrowx/sdk";
import { useEscrowX } from "@/context/EscrowX";
import { usePendingAction } from "@/hooks/usePendingAction";
import { PendingNotice, pendingLabel } from "@/components/v4/Pending";
import { CHAIN_ID, FIAT_CURRENCIES, RELAYS, V4, arbitratorName } from "@/config/v4";
import { Button, Card, Field, Notice, errorText } from "@/components/ui";
import { MessagingGate } from "@/components/v4/MessagingGate";
import { fmtFiat, fmtToken, parseTokenInput } from "@/lib/v4/local";

const METHOD_SUGGESTIONS: Record<string, string[]> = {
  NGN: ["Bank transfer", "Opay", "PalmPay", "Moniepoint", "Kuda"],
  KES: ["M-Pesa", "Bank transfer"],
  GHS: ["MTN MoMo", "Bank transfer"],
  ZAR: ["Bank transfer", "Capitec Pay"],
  BRL: ["PIX"],
  INR: ["UPI", "IMPS"],
};

export function CreateOfferForm({ initialSide = "sell", onPublished }: { initialSide?: OfferSide; onPublished?: () => void }) {
  const { address, client, book, identity, binding } = useEscrowX();
  const { data: walletClient } = useWalletClient();
  const [side, setSide] = useState<OfferSide>(initialSide);
  useEffect(() => setSide(initialSide), [initialSide]);
  const selling = side === "sell";

  const [f, setF] = useState({
    fiatCurrency: "NGN",
    price: "1600",
    paymentMethods: "Bank transfer, Opay",
    conditions: "Pay only from an account in your own name. No third-party payments.",
    min: "10",
    max: "500",
    total: "1000",
    paymentMinutes: "30",
    releaseMinutes: "60",
    expiryHours: "24",
  });
  const pending = usePendingAction();
  const busy = !!pending.busy;
  const [result, setResult] = useState<{ tone: "ok" | "error" | "warn"; text: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    edited.current.add(k);
    setF((s) => ({ ...s, [k]: e.target.value }));
  };

  // Fields the person has actually typed in. Seeding a sensible default is helpful; overwriting something
  // they chose is not, so anything they touch is theirs from then on.
  const edited = useRef(new Set<string>());

  // What is actually backing this offer, read live. "Total to sell: 1,000" against a vault holding 100 is
  // not something to discover at the moment of publishing — the offer goes out and no buyer can take it.
  const vault = useQuery({
    queryKey: ["offer-form-vault", address, selling],
    enabled: !!client && !!address && selling,
    refetchInterval: 15_000,
    queryFn: () => client!.freeBalance(address!, V4.usdt),
  });

  // The going rate on this side of this market, so a price can be judged as it is typed rather than after
  // the offer is live and nobody takes it. Same data the Market tab shows; not a price feed.
  const marketSide = selling ? "sell" : "buy";
  const reference = useQuery({
    queryKey: ["offer-form-median", f.fiatCurrency, marketSide],
    enabled: !!book,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await book!.fetch({ chainId: CHAIN_ID, fiatCurrency: f.fiatCurrency, side: marketSide });
      const prices = res.offers.map((o) => Number(o.terms.price)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
      if (prices.length < 3) return { median: null as number | null, count: prices.length };
      const mid = prices.length % 2 ? prices[(prices.length - 1) / 2]! : (prices[prices.length / 2 - 1]! + prices[prices.length / 2]!) / 2;
      return { median: mid, count: prices.length };
    },
  });

  const min = parseTokenInput(f.min);
  const max = parseTokenInput(f.max);
  const total = parseTokenInput(f.total);
  const priceOk = /^\d+(\.\d+)?$/.test(f.price.trim()) && Number(f.price) > 0;

  // Seed the total from what is actually in the vault, once, before the person has touched the field.
  useEffect(() => {
    if (!selling || vault.data === undefined || edited.current.has("total")) return;
    setF((s) => ({ ...s, total: fmtToken(vault.data) }));
  }, [selling, vault.data]);

  const overVault = selling && vault.data !== undefined && !!total && total > vault.data;
  const priceGap = reference.data?.median && priceOk
    ? ((Number(f.price) - reference.data.median) / reference.data.median) * 100
    : null;

  const limitsOk = !!min && !!max && !!total && min <= max && max <= total;
  const methods = f.paymentMethods.split(",").map((m) => m.trim()).filter(Boolean);

  function toggleMethod(m: string) {
    const next = methods.includes(m) ? methods.filter((x) => x !== m) : [...methods, m];
    setF((s) => ({ ...s, paymentMethods: next.join(", ") }));
  }

  async function publish() {
    if (!address || !walletClient || !client || !book || !identity || !binding) return;
    setResult(null);
    await pending.run("publish", async (ctx) => {
      if (!min || !max || !total) throw new Error("Enter valid token amounts");
      const terms: OfferTerms = {
        chainId: CHAIN_ID,
        escrow: V4.escrow,
        tokenSymbol: V4.tokenSymbol,
        tokenDecimals: V4.tokenDecimals,
        fiatCurrency: f.fiatCurrency,
        price: f.price.trim(),
        paymentMethods: methods,
        ...(f.conditions.trim() ? { conditions: f.conditions.trim() } : {}),
      };
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const common = {
        token: V4.usdt,
        minAmount: min,
        maxAmount: max,
        totalAmount: total,
        paymentWindow: BigInt(Math.round(Number(f.paymentMinutes) * 60)),
        releaseWindow: BigInt(Math.round(Number(f.releaseMinutes) * 60)),
        arbitrator: V4.primaryArbitrator,
        fallbackArbitrator: V4.fallbackArbitrator,
        nonce: await client.makerNonce(address),
        expiry: nowSec + BigInt(Math.round(Number(f.expiryHours) * 3600)),
        terms,
      };
      const offer = selling ? createOffer({ seller: address, ...common }) : createBuyOffer({ buyer: address, ...common });

      // Sell offers are backed by the vault; a buy offer is funded by whichever seller fills it.
      const free = selling ? await client.freeBalance(address, V4.usdt) : min;
      // One signature, no transaction: say so, so nobody waits for a gas prompt that never comes.
      ctx.step({ index: 1, total: 1, label: "Sign the offer (free, no gas)" });
      ctx.phase("signing");
      const signature = await signOffer(walletClient as never, offer, CHAIN_ID, V4.escrow);
      ctx.phase("checking");
      const event = buildOfferEvent({ offer, signature, terms, binding, identity });
      const results: PublishResult[] = await book.publish(event);
      const accepted = results.filter((r) => r.ok).length;
      if (accepted === 0) throw new Error(`No relay accepted the offer (${results.map((r) => r.message).join("; ")})`);

      setResult({
        tone: free < min ? "warn" : "ok",
        text:
          `Live on ${accepted} of ${RELAYS.length} relay${RELAYS.length === 1 ? "" : "s"}.` +
          (!selling
            ? " Sellers can fill it now — you'll get a notification when one does."
            : free < min
              ? ` Buyers can't take it yet — deposit at least ${f.min} ${V4.tokenSymbol} into your vault.`
              : " Buyers can take it now."),
      });
      onPublished?.();
    });
  }

  return (
    <Card
      title="Post an offer"
      sub="Signed by your wallet, published to public relays. Bank details are never published — they go privately to your counterparty."
    >
      <MessagingGate reason="publish offers and chat privately with whoever takes them">
        <div className="stack">
          <div className="stack-xs">
            <span className="field-label">I want to</span>
            <div className="segmented segmented-lg" role="group" aria-label="Offer side">
              <button aria-pressed={selling} onClick={() => setSide("sell")}>Sell {V4.tokenSymbol}</button>
              <button aria-pressed={!selling} onClick={() => setSide("buy")}>Buy {V4.tokenSymbol}</button>
            </div>
            <p className="help">
              {selling
                ? `Buyers take your offer and your ${V4.tokenSymbol} locks from your vault. They pay you, then you release.`
                : `Sellers fill your offer and lock their own ${V4.tokenSymbol}. You pay them, then they release it to you.`}
            </p>
          </div>
          <div className="fields">
            <Field label="Currency">
              <select className="input" value={f.fiatCurrency} onChange={set("fiatCurrency")} aria-label="Fiat currency">
                {FIAT_CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Price" hint={`${f.fiatCurrency} per ${V4.tokenSymbol}`}>
              <input className="input mono" value={f.price} onChange={set("price")} inputMode="decimal" aria-invalid={!priceOk} aria-label={`Price in ${f.fiatCurrency} per ${V4.tokenSymbol}`} />
              {reference.data?.median ? (
                <p className="help">
                  Market median {reference.data.median.toLocaleString("en-US")} {f.fiatCurrency}
                  {priceGap !== null && (
                    <> · yours is <span className="mono">{priceGap >= 0 ? "+" : ""}{priceGap.toFixed(1)}%</span>{" "}
                      {Math.abs(priceGap) < 0.05 ? "— level with the market" : selling === priceGap > 0 ? "— worse for your counterparty" : "— better for your counterparty"}</>
                  )}
                </p>
              ) : reference.data ? (
                <p className="help">No median yet — only {reference.data.count} live offer{reference.data.count === 1 ? "" : "s"} on this side.</p>
              ) : null}
            </Field>
          </div>

          <div className="fields">
            <Field label="Min per trade" hint={V4.tokenSymbol}>
              <input className="input mono" value={f.min} onChange={set("min")} inputMode="decimal" aria-label={`Smallest single trade, in ${V4.tokenSymbol}`} />
            </Field>
            <Field label="Max per trade" hint={V4.tokenSymbol}>
              <input className="input mono" value={f.max} onChange={set("max")} inputMode="decimal" aria-label={`Largest single trade, in ${V4.tokenSymbol}`} />
            </Field>
            <Field label={selling ? "Total to sell" : "Total to buy"} hint={V4.tokenSymbol}>
              <input className="input mono" value={f.total} onChange={set("total")} inputMode="decimal" aria-label={selling ? `Total ${V4.tokenSymbol} to sell` : `Total ${V4.tokenSymbol} to buy`} aria-invalid={overVault} />
            </Field>
          </div>
          {!limitsOk && <p className="help warn-text">Limits must satisfy min ≤ max ≤ total.</p>}
          {overVault && (
            <p className="help warn-text">
              Your vault holds {fmtToken(vault.data!)} {V4.tokenSymbol}. An offer above that can be taken only up to what is
              there, so the rest of it is advertising you can&apos;t honour — deposit more, or lower the total.
            </p>
          )}

          <Field label="Payment methods" hint={selling ? "how buyers can pay you" : "how you can pay sellers"}>
            <input className="input" value={f.paymentMethods} onChange={set("paymentMethods")} aria-label="Payment methods you accept, comma separated" />
          </Field>
          <div className="row" style={{ gap: 6, marginTop: -8 }}>
            {(METHOD_SUGGESTIONS[f.fiatCurrency] ?? []).map((m) => (
              <button key={m} type="button" className={`chip${methods.includes(m) ? " chip-accent" : ""}`} style={{ cursor: "pointer" }} onClick={() => toggleMethod(m)}>
                {methods.includes(m) ? "✓ " : "+ "}{m}
              </button>
            ))}
          </div>

          <Field label="Conditions" hint="public — never put account numbers here">
            <input className="input" value={f.conditions} onChange={set("conditions")} aria-label="Public conditions shown on your offer" />
          </Field>

          <details className="inset" style={{ padding: "10px 14px" }}>
            <summary className="small strong" style={{ cursor: "pointer" }}>
              Timing <span className="faint" style={{ fontWeight: 400 }}>· payment within {f.paymentMinutes} min · release within {f.releaseMinutes} min · expires in {f.expiryHours} h</span>
            </summary>
            <div className="fields" style={{ marginTop: 12 }}>
              <Field label={selling ? "Buyer pays within" : "You pay within"} hint="10–180 min"><input className="input mono" value={f.paymentMinutes} onChange={set("paymentMinutes")} inputMode="numeric" aria-label="Minutes the buyer has to pay" /></Field>
              <Field label={selling ? "You release within" : "Seller releases within"} hint="30–1440 min"><input className="input mono" value={f.releaseMinutes} onChange={set("releaseMinutes")} inputMode="numeric" aria-label="Minutes the seller has to release" /></Field>
              <Field label="Offer expires in" hint="hours"><input className="input mono" value={f.expiryHours} onChange={set("expiryHours")} inputMode="numeric" aria-label="Hours until this offer expires" /></Field>
            </div>
          </details>

          <div className="buy-summary">
            <div><span className="faint">Largest single trade</span><span className="mono">{max && priceOk ? fmtFiat(max, f.price, f.fiatCurrency) : "—"}</span></div>
            <div><span className="faint">EscrowX fee</span><span className="mono strong">none · 0%</span></div>
            <div><span className="faint">If there&apos;s a dispute</span><span>{arbitratorName(V4.primaryArbitrator)} <span className="faint">→ fallback</span> {arbitratorName(V4.fallbackArbitrator)}</span></div>
            <div className="faint tiny">
              <span>
                Posting is a signature — free, no gas. The escrow takes no cut of a trade; you pay gas on your own
                transactions, and only a dispute costs anything (each side puts up the firm&apos;s fee, refunded to
                whoever wins).
              </span>
            </div>
          </div>

          <PendingNotice pending={pending} shows="your offer" />
          {!pending.busy && result && <Notice tone={result.tone}>{result.text}</Notice>}

          <div>
            <Button variant="primary" onClick={() => void publish()} disabled={!walletClient || !limitsOk || !priceOk || methods.length === 0} busy={busy}>
              {busy ? pendingLabel(pending, "") : selling ? "Sign & publish sell offer" : "Sign & publish buy offer"}
            </Button>
          </div>
        </div>
      </MessagingGate>
    </Card>
  );
}
