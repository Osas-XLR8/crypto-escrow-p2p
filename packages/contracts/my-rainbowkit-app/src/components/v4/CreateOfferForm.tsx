// src/components/v4/CreateOfferForm.tsx — sign an offer with the wallet and publish it to Nostr relays.

import { useState } from "react";
import { useWalletClient } from "wagmi";
import { buildOfferEvent, createOffer, signOffer, type OfferTerms, type PublishResult } from "@escrowx/sdk";
import { useEscrowX } from "@/context/EscrowX";
import { CHAIN_ID, FIAT_CURRENCIES, RELAYS, V4, arbitratorName } from "@/config/v4";
import { Button, Card, Label, Notice, errorText, inputStyle } from "@/components/ui";
import { MessagingGate } from "@/components/v4/MessagingGate";
import { fmtFiat, parseTokenInput } from "@/lib/v4/local";

export function CreateOfferForm({ onPublished }: { onPublished?: () => void }) {
  const { address, client, book, identity, binding } = useEscrowX();
  const { data: walletClient } = useWalletClient();

  const [f, setF] = useState({
    fiatCurrency: "NGN",
    price: "1600",
    paymentMethods: "bank-transfer, opay",
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
        paymentMethods: f.paymentMethods.split(",").map((m) => m.trim()).filter(Boolean),
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
          `Offer published to ${accepted}/${RELAYS.length} relay${RELAYS.length === 1 ? "" : "s"}.` +
          (free < min ? ` Buyers can't take it yet: deposit at least ${f.min} ${V4.tokenSymbol} into your vault.` : ""),
      });
      onPublished?.();
    } catch (e) {
      setResult({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 } as const;

  return (
    <Card title="CREATE OFFER">
      <MessagingGate reason="publish offers and receive buyers' messages">
        <div style={{ display: "grid", gap: 14 }}>
          <div style={grid}>
            <label>
              <Label>CURRENCY</Label>
              <select value={f.fiatCurrency} onChange={set("fiatCurrency")} style={inputStyle}>
                {FIAT_CURRENCIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label>
              <Label hint={`${f.fiatCurrency} per ${V4.tokenSymbol}`}>PRICE</Label>
              <input value={f.price} onChange={set("price")} inputMode="decimal" style={inputStyle} />
            </label>
            <label>
              <Label hint="comma separated">PAYMENT METHODS</Label>
              <input value={f.paymentMethods} onChange={set("paymentMethods")} style={inputStyle} />
            </label>
          </div>

          <div style={grid}>
            <label><Label hint={V4.tokenSymbol}>MIN PER TRADE</Label><input value={f.min} onChange={set("min")} inputMode="decimal" style={inputStyle} /></label>
            <label><Label hint={V4.tokenSymbol}>MAX PER TRADE</Label><input value={f.max} onChange={set("max")} inputMode="decimal" style={inputStyle} /></label>
            <label><Label hint={V4.tokenSymbol}>TOTAL OFFER</Label><input value={f.total} onChange={set("total")} inputMode="decimal" style={inputStyle} /></label>
          </div>

          <div style={grid}>
            <label><Label hint="10–180 min">PAYMENT WINDOW</Label><input value={f.paymentMinutes} onChange={set("paymentMinutes")} inputMode="numeric" style={inputStyle} /></label>
            <label><Label hint="30–1440 min">RELEASE WINDOW</Label><input value={f.releaseMinutes} onChange={set("releaseMinutes")} inputMode="numeric" style={inputStyle} /></label>
            <label><Label hint="hours">OFFER EXPIRES IN</Label><input value={f.expiryHours} onChange={set("expiryHours")} inputMode="numeric" style={inputStyle} /></label>
          </div>

          <label>
            <Label hint="public — never put bank details here">CONDITIONS</Label>
            <input value={f.conditions} onChange={set("conditions")} style={inputStyle} />
          </label>

          <Notice tone="info">
            Disputes go to <strong>{arbitratorName(V4.primaryArbitrator)}</strong>, with <strong>{arbitratorName(V4.fallbackArbitrator)}</strong> as fallback.
            Your bank details are never published — you send them privately to a buyer after they lock a trade.
            {max && ` A max-size trade is worth about ${fmtFiat(max, f.price || "0", f.fiatCurrency)}.`}
          </Notice>

          {result && <Notice tone={result.tone}>{result.text}</Notice>}

          <div>
            <Button variant="primary" solid onClick={() => void publish()} disabled={busy || !walletClient || !min || !max || !total}>
              {busy ? "Sign in your wallet…" : "Sign & publish offer"}
            </Button>
          </div>
        </div>
      </MessagingGate>
    </Card>
  );
}
