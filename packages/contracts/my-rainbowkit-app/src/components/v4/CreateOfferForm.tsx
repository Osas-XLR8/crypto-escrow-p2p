// src/components/v4/CreateOfferForm.tsx — sign an offer with the wallet and publish it to Nostr relays.

import { useState } from "react";
import { useWalletClient } from "wagmi";
import { buildOfferEvent, createOffer, signOffer, type OfferTerms, type PublishResult } from "@escrowx/sdk";
import { useEscrowX } from "@/context/EscrowX";
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

export function CreateOfferForm({ onPublished }: { onPublished?: () => void }) {
  const { address, client, book, identity, binding } = useEscrowX();
  const { data: walletClient } = useWalletClient();

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
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
    setResult(null);
    try {
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
      const offer = createOffer({
        seller: address,
        token: V4.usdt,
        minAmount: min,
        maxAmount: max,
        totalAmount: total,
        paymentWindow: BigInt(Math.round(Number(f.paymentMinutes) * 60)),
        releaseWindow: BigInt(Math.round(Number(f.releaseMinutes) * 60)),
        arbitrator: V4.primaryArbitrator,
        fallbackArbitrator: V4.fallbackArbitrator,
        nonce: await client.sellerNonce(address),
        expiry: nowSec + BigInt(Math.round(Number(f.expiryHours) * 3600)),
        terms,
      });

      const free = await client.freeBalance(address, V4.usdt);
      const signature = await signOffer(walletClient as never, offer, CHAIN_ID, V4.escrow);
      const event = buildOfferEvent({ offer, signature, terms, binding, identity });
      const results: PublishResult[] = await book.publish(event);
      const accepted = results.filter((r) => r.ok).length;
      if (accepted === 0) throw new Error(`No relay accepted the offer (${results.map((r) => r.message).join("; ")})`);

      setResult({
        tone: free < min ? "warn" : "ok",
        text:
          `Live on ${accepted} of ${RELAYS.length} relay${RELAYS.length === 1 ? "" : "s"}.` +
          (free < min ? ` Buyers can't take it yet — deposit at least ${f.min} ${V4.tokenSymbol} into your vault.` : " Buyers can take it now."),
      });
      onPublished?.();
    } catch (e) {
      setResult({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="New sell offer" sub="Signed by your wallet, published to public relays. Your bank details are never published.">
      <MessagingGate reason="publish offers and receive buyers' messages">
        <div className="stack">
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
            <Field label="Total to sell" hint={V4.tokenSymbol}>
              <input className="input mono" value={f.total} onChange={set("total")} inputMode="decimal" />
            </Field>
          </div>
          {!limitsOk && <p className="help warn-text">Limits must satisfy min ≤ max ≤ total.</p>}

          <Field label="Payment methods" hint="how buyers can pay you">
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
              Timing <span className="faint" style={{ fontWeight: 400 }}>· pay within {f.paymentMinutes} min · release within {f.releaseMinutes} min · expires in {f.expiryHours} h</span>
            </summary>
            <div className="fields" style={{ marginTop: 12 }}>
              <Field label="Buyer pays within" hint="10–180 min"><input className="input mono" value={f.paymentMinutes} onChange={set("paymentMinutes")} inputMode="numeric" /></Field>
              <Field label="You release within" hint="30–1440 min"><input className="input mono" value={f.releaseMinutes} onChange={set("releaseMinutes")} inputMode="numeric" /></Field>
              <Field label="Offer expires in" hint="hours"><input className="input mono" value={f.expiryHours} onChange={set("expiryHours")} inputMode="numeric" /></Field>
            </div>
          </details>

          <div className="buy-summary">
            <div><span className="faint">Largest single trade</span><span className="mono">{max && priceOk ? fmtFiat(max, f.price, f.fiatCurrency) : "—"}</span></div>
            <div><span className="faint">If there&apos;s a dispute</span><span>{arbitratorName(V4.primaryArbitrator)} <span className="faint">→ fallback</span> {arbitratorName(V4.fallbackArbitrator)}</span></div>
          </div>

          {result && <Notice tone={result.tone}>{result.text}</Notice>}

          <div>
            <Button variant="primary" onClick={() => void publish()} disabled={!walletClient || !limitsOk || !priceOk || methods.length === 0} busy={busy}>
              {busy ? "Sign in your wallet…" : "Sign & publish offer"}
            </Button>
          </div>
        </div>
      </MessagingGate>
    </Card>
  );
}
