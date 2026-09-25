// src/components/v4/CreateOfferForm.tsx — sign an offer (to sell or to buy) and publish it to Nostr relays.

import { useEffect, useState } from "react";
import { useWalletClient } from "wagmi";
import { buildOfferEvent, createBuyOffer, createOffer, signOffer, type OfferSide, type OfferTerms, type PublishResult } from "@escrowx/sdk";
import { useEscrowX } from "@/context/EscrowX";
import { usePendingAction } from "@/hooks/usePendingAction";
import { PendingNotice, pendingLabel } from "@/components/v4/Pending";
import { CHAIN_ID, FIAT_CURRENCIES, RELAYS, V4, arbitratorName } from "@/config/v4";
import { Button, Card, Field, Notice, errorText } from "@/components/ui";
import { MessagingGate } from "@/components/v4/MessagingGate";
import { fmtFiat, parseTokenInput } from "@/lib/v4/local";

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
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const min = parseTokenInput(f.min);
  const max = parseTokenInput(f.max);
  const total = parseTokenInput(f.total);
  const priceOk = /^\d+(\.\d+)?$/.test(f.price.trim()) && Number(f.price) > 0;
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
              <select className="input" value={f.fiatCurrency} onChange={set("fiatCurrency")}>
                {FIAT_CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Price" hint={`${f.fiatCurrency} per ${V4.tokenSymbol}`}>
              <input className="input mono" value={f.price} onChange={set("price")} inputMode="decimal" aria-invalid={!priceOk} />
            </Field>
          </div>

          <div className="fields">
            <Field label="Min per trade" hint={V4.tokenSymbol}>
              <input className="input mono" value={f.min} onChange={set("min")} inputMode="decimal" />
            </Field>
            <Field label="Max per trade" hint={V4.tokenSymbol}>
              <input className="input mono" value={f.max} onChange={set("max")} inputMode="decimal" />
            </Field>
            <Field label={selling ? "Total to sell" : "Total to buy"} hint={V4.tokenSymbol}>
              <input className="input mono" value={f.total} onChange={set("total")} inputMode="decimal" />
            </Field>
          </div>
          {!limitsOk && <p className="help warn-text">Limits must satisfy min ≤ max ≤ total.</p>}

          <Field label="Payment methods" hint={selling ? "how buyers can pay you" : "how you can pay sellers"}>
            <input className="input" value={f.paymentMethods} onChange={set("paymentMethods")} />
          </Field>
          <div className="row" style={{ gap: 6, marginTop: -8 }}>
            {(METHOD_SUGGESTIONS[f.fiatCurrency] ?? []).map((m) => (
              <button key={m} type="button" className={`chip${methods.includes(m) ? " chip-accent" : ""}`} style={{ cursor: "pointer" }} onClick={() => toggleMethod(m)}>
                {methods.includes(m) ? "✓ " : "+ "}{m}
              </button>
            ))}
          </div>

          <Field label="Conditions" hint="public — never put account numbers here">
            <input className="input" value={f.conditions} onChange={set("conditions")} />
          </Field>

          <details className="inset" style={{ padding: "10px 14px" }}>
            <summary className="small strong" style={{ cursor: "pointer" }}>
              Timing <span className="faint" style={{ fontWeight: 400 }}>· payment within {f.paymentMinutes} min · release within {f.releaseMinutes} min · expires in {f.expiryHours} h</span>
            </summary>
            <div className="fields" style={{ marginTop: 12 }}>
              <Field label={selling ? "Buyer pays within" : "You pay within"} hint="10–180 min"><input className="input mono" value={f.paymentMinutes} onChange={set("paymentMinutes")} inputMode="numeric" /></Field>
              <Field label={selling ? "You release within" : "Seller releases within"} hint="30–1440 min"><input className="input mono" value={f.releaseMinutes} onChange={set("releaseMinutes")} inputMode="numeric" /></Field>
              <Field label="Offer expires in" hint="hours"><input className="input mono" value={f.expiryHours} onChange={set("expiryHours")} inputMode="numeric" /></Field>
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

          <PendingNotice pending={pending} />
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
