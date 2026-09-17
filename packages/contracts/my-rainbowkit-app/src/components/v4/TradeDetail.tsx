// src/components/v4/TradeDetail.tsx — one trade: authoritative on-chain state, role-aware actions,
// dispute tools, encrypted evidence, and an activity timeline.
//
// Every button maps 1:1 to an EscrowCoreV4 function and is only shown when the contract would accept it
// from this wallet at this time. Nothing here asks EscrowX for permission — there is no EscrowX in the loop.

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatEther, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import {
  TradeState,
  encryptEvidence,
  formatEvidenceUri,
  keyFromHex,
  keyToHex,
  licensedArbitratorAdapterAbi,
  nostrPubkeyFromAdapterKey,
  sealEvidenceKey,
} from "@escrowx/sdk";
import { useEscrowX } from "@/context/EscrowX";
import { arbitratorName } from "@/config/v4";
import { StateBadge } from "@/components/StateBadge";
import { Button, Card, FieldRow, Label, Notice, colors, errorText, mono } from "@/components/ui";
import { MessagingGate } from "@/components/v4/MessagingGate";
import { TradeChatPanel } from "@/components/v4/TradeChatPanel";
import { fmtDuration, fmtTs, shortAddr, shortHash } from "@/lib/format";
import { downloadBytes, fmtToken, loadEvidence, storeEvidence } from "@/lib/v4/local";
import { CANCEL_REASONS, RELEASE_REASONS, type TradeSummary } from "@/lib/v4/tradeIndex";

export function TradeDetail({ summary, chainNow, arbitrationTimeout, onChanged }: {
  summary: TradeSummary;
  chainNow: number;
  arbitrationTimeout: number;
  onChanged: () => void;
}) {
  const { address, client } = useEscrowX();
  const publicClient = usePublicClient();
  const id = summary.tradeId;

  const chain = useQuery({
    queryKey: ["trade", id.toString(), client?.escrow],
    enabled: !!client,
    refetchInterval: 4000,
    queryFn: async () => {
      const [trade, dispute] = await Promise.all([client!.getTrade(id), client!.getDispute(id)]);
      const primaryFee = await client!.arbitrationCost(trade.arbitrator);
      const fallbackFee = await client!.arbitrationCost(trade.fallbackArbitrator);
      const claimable = address ? await client!.claimableNative(address) : 0n;
      let assignee: Address = zeroAddress;
      let panelistKey: string | null = null;
      if (trade.state === TradeState.DISPUTED && publicClient) {
        const adapter = { address: trade.activeArbitrator, abi: licensedArbitratorAdapterAbi } as const;
        try {
          assignee = (await publicClient.readContract({ ...adapter, functionName: "getCase", args: [dispute.disputeId] })).assignee;
          if (assignee !== zeroAddress) {
            panelistKey = nostrPubkeyFromAdapterKey(await publicClient.readContract({ ...adapter, functionName: "encryptionKey", args: [assignee] }));
          }
        } catch {
          /* arbitrator isn't a licensed-firm adapter (e.g. a Kleros court) — no panel key to read */
        }
      }
      return { trade, dispute, primaryFee, fallbackFee, claimable, assignee, panelistKey };
    },
  });

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmedFiat, setConfirmedFiat] = useState(false);
  const [receipt, setReceipt] = useState<File | null>(null);

  async function run(label: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
      setMessage({ tone: "ok", text: ok });
      await chain.refetch();
      onChanged();
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  if (!chain.data || !client) {
    return <Card title={`TRADE #${id}`}><div style={{ color: colors.faint, fontSize: 13 }}>{chain.error ? errorText(chain.error) : "Loading trade from chain…"}</div></Card>;
  }

  const { trade: t, dispute: d, primaryFee, fallbackFee, claimable, assignee, panelistKey } = chain.data;
  const me = address?.toLowerCase();
  const isSeller = me === t.seller.toLowerCase();
  const isBuyer = me === t.buyer.toLowerCase();
  const isParty = isSeller || isBuyer;
  const now = chainNow;
  const open = t.state === TradeState.LOCKED || t.state === TradeState.PAID || t.state === TradeState.FEE_PENDING || t.state === TradeState.DISPUTED;

  const paymentDeadline = Number(t.paymentDeadline);
  const releaseDeadline = Number(t.releaseDeadline);
  const feeDeadline = Number(d.feeDeadline);
  const startedAt = Number(d.startedAt);
  const escalateAt = startedAt + arbitrationTimeout;
  const terminalAt = startedAt + (d.escalated ? arbitrationTimeout : 2 * arbitrationTimeout);
  const openerIsMe = me === d.opener.toLowerCase();

  const countdown = (deadline: number) => (now <= deadline ? `in ${fmtDuration(deadline - now)}` : `passed ${fmtDuration(now - deadline)} ago`);

  async function markPaid() {
    let commitment: Hex = zeroHash;
    if (receipt) {
      const bytes = new Uint8Array(await receipt.arrayBuffer());
      const ev = await encryptEvidence(bytes);
      if (!storeEvidence(id, { commitment: ev.commitment, keyHex: keyToHex(ev.key), ciphertext: ev.ciphertext, fileName: receipt.name, mimeType: receipt.type || "application/octet-stream" })) {
        downloadBytes(ev.ciphertext, `trade-${id}-receipt.enc`); // too large for this device's storage: keep a copy
      }
      commitment = ev.commitment;
    }
    await client!.markPaid(id, commitment);
  }

  const actions: ReactNode[] = [];

  if (isBuyer && t.state === TradeState.LOCKED && now <= paymentDeadline) {
    actions.push(
      <ActionBox key="paid" title="I've sent the fiat payment">
        <Label hint="optional but strongly recommended">RECEIPT OR BANK STATEMENT</Label>
        <input type="file" accept="image/*,application/pdf" onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} style={{ color: "#94a3b8", fontSize: 12 }} />
        <p style={{ fontSize: 12, color: colors.muted, margin: "6px 0 10px" }}>
          The file is encrypted on this device. Only its fingerprint goes on-chain; nobody can read it unless you later share the key with the dispute arbitrator.
        </p>
        <Button variant="primary" solid disabled={!!busy} onClick={() => run("paid", markPaid, "Marked as paid. The seller now checks their bank and releases.")}>
          {busy === "paid" ? "Confirm in wallet…" : "Mark as paid"}
        </Button>
      </ActionBox>
    );
  }

  if (isSeller && open) {
    actions.push(
      <ActionBox key="release" title={t.state === TradeState.DISPUTED || t.state === TradeState.FEE_PENDING ? "Release now (concedes the dispute)" : "Release crypto to the buyer"}>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: colors.text, marginBottom: 10 }}>
          <input type="checkbox" checked={confirmedFiat} onChange={(e) => setConfirmedFiat(e.target.checked)} style={{ marginTop: 3 }} />
          <span>I checked <strong>my own banking app</strong> and the full amount arrived from an account in the buyer&apos;s name. (Screenshots can be faked.)</span>
        </label>
        <Button variant="primary" solid disabled={!confirmedFiat || !!busy} onClick={() => run("release", () => client.release(id), `Released ${fmtToken(t.amount)} USDT to the buyer.`)}>
          {busy === "release" ? "Confirm in wallet…" : `Release ${fmtToken(t.amount)} USDT`}
        </Button>
      </ActionBox>
    );
  }

  if (t.state === TradeState.PAID && (isSeller || (isBuyer && now > releaseDeadline))) {
    actions.push(
      <ActionBox key="dispute" title={isSeller ? "Payment didn't arrive? Open a dispute" : "Seller hasn't released — open a dispute"}>
        <p style={{ fontSize: 12, color: colors.muted, margin: "0 0 10px" }}>
          Deposit the arbitration fee ({formatEther(primaryFee)} ETH). The other party has to match it or loses by default. The winner gets their fee back.
          Arbitrator: <strong>{arbitratorName(t.arbitrator)}</strong>.
        </p>
        <Button variant="warning" disabled={!!busy} onClick={() => run("dispute", () => client.openDispute(id), "Dispute opened. Waiting for the other party's fee.")}>
          {busy === "dispute" ? "Confirm in wallet…" : "Open dispute"}
        </Button>
      </ActionBox>
    );
  }

  if (t.state === TradeState.FEE_PENDING) {
    if (isParty && !openerIsMe && now <= feeDeadline) {
      actions.push(
        <ActionBox key="fee" title="A dispute was opened against you">
          <p style={{ fontSize: 12, color: colors.muted, margin: "0 0 10px" }}>
            Match the {formatEther(primaryFee)} ETH arbitration fee {countdown(feeDeadline)}, or the other party wins by default. If you win, it&apos;s refunded.
          </p>
          <Button variant="warning" solid disabled={!!busy} onClick={() => run("fee", () => client.payArbitrationFee(id), "Fee matched — the dispute is now with the arbitrator.")}>
            {busy === "fee" ? "Confirm in wallet…" : "Match fee & defend"}
          </Button>
        </ActionBox>
      );
    }
    if (now > feeDeadline) {
      actions.push(
        <ActionBox key="feeTimeout" title="Fee deadline passed">
          <Button variant="primary" disabled={!!busy} onClick={() => run("feeTimeout", () => client.claimFeeTimeout(id), "Dispute settled in the opener's favour.")}>
            {busy === "feeTimeout" ? "Confirm in wallet…" : "Settle by default"}
          </Button>
        </ActionBox>
      );
    }
  }

  if (t.state === TradeState.DISPUTED && isParty && !d.escalated && now > escalateAt) {
    actions.push(
      <ActionBox key="escalate" title="Arbitrator missed its deadline">
        <p style={{ fontSize: 12, color: colors.muted, margin: "0 0 10px" }}>Move the case to <strong>{arbitratorName(t.fallbackArbitrator)}</strong> (fee {formatEther(fallbackFee)} ETH, paid from the held fees where possible).</p>
        <Button variant="warning" disabled={!!busy} onClick={() => run("escalate", () => client.escalateToFallback(id), "Escalated to the fallback arbitrator.")}>
          {busy === "escalate" ? "Confirm in wallet…" : "Escalate"}
        </Button>
      </ActionBox>
    );
  }

  if (t.state === TradeState.DISPUTED && now > terminalAt) {
    actions.push(
      <ActionBox key="terminal" title="Arbitration timed out">
        <p style={{ fontSize: 12, color: colors.muted, margin: "0 0 10px" }}>Nobody ruled in time. Closing returns the crypto to the seller&apos;s vault and splits the held fees.</p>
        <Button disabled={!!busy} onClick={() => run("terminal", () => client.claimArbitrationTimeout(id), "Dispute closed.")}>
          {busy === "terminal" ? "Confirm in wallet…" : "Close dispute"}
        </Button>
      </ActionBox>
    );
  }

  if (t.state === TradeState.LOCKED && now > paymentDeadline) {
    actions.push(
      <ActionBox key="unpaid" title="Payment window missed">
        <Button disabled={!!busy} onClick={() => run("unpaid", () => client.cancelUnpaid(id), "Trade cancelled; crypto is back in the seller's vault.")}>
          {busy === "unpaid" ? "Confirm in wallet…" : "Cancel trade"}
        </Button>
      </ActionBox>
    );
  }

  if (isBuyer && open) {
    actions.push(
      <ActionBox key="cancel" title={t.state === TradeState.DISPUTED || t.state === TradeState.FEE_PENDING ? "Withdraw from the trade (concedes the dispute)" : "Changed your mind?"}>
        <p style={{ fontSize: 12, color: colors.muted, margin: "0 0 10px" }}>Cancelling returns the crypto to the seller. Don&apos;t cancel if you already paid — open a dispute instead.</p>
        <Button variant="danger" disabled={!!busy} onClick={() => run("cancel", () => client.buyerCancel(id), "Trade cancelled.")}>
          {busy === "cancel" ? "Confirm in wallet…" : "Cancel trade"}
        </Button>
      </ActionBox>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Card title={`TRADE #${id}`} right={<StateBadge state={t.state} />}>
        <div style={{ background: colors.inset, borderRadius: 10, padding: "0 14px" }}>
          <FieldRow label="AMOUNT" value={<strong style={{ fontSize: 18, color: colors.greenText }}>{fmtToken(t.amount)} USDT</strong>} />
          <FieldRow label="SELLER" value={<code style={{ fontFamily: mono, fontSize: 11 }}>{t.seller}{isSeller ? " (you)" : ""}</code>} />
          <FieldRow label="BUYER" value={<code style={{ fontFamily: mono, fontSize: 11 }}>{t.buyer}{isBuyer ? " (you)" : ""}</code>} />
          {t.state === TradeState.LOCKED && <FieldRow label="PAYMENT DUE" value={`${fmtTs(paymentDeadline)} · ${countdown(paymentDeadline)}`} />}
          {releaseDeadline > 0 && t.state === TradeState.PAID && <FieldRow label="BUYER MAY DISPUTE" value={`${fmtTs(releaseDeadline)} · ${countdown(releaseDeadline)}`} />}
          {t.state === TradeState.FEE_PENDING && <FieldRow label="FEE MATCH DEADLINE" value={`${fmtTs(feeDeadline)} · ${countdown(feeDeadline)}`} />}
          {t.state === TradeState.DISPUTED && (
            <>
              <FieldRow label="ARBITRATOR" value={`${arbitratorName(t.activeArbitrator)}${d.escalated ? " (fallback)" : ""}`} />
              <FieldRow label="ASSIGNED PANELIST" value={assignee === zeroAddress ? "Not assigned yet" : shortAddr(assignee)} />
              <FieldRow label={d.escalated ? "CAN BE CLOSED" : "CAN ESCALATE"} value={countdown(d.escalated ? terminalAt : escalateAt)} />
            </>
          )}
        </div>
        {claimable > 0n && (
          <div style={{ marginTop: 12 }}>
            <Notice tone="ok">
              You have {formatEther(claimable)} ETH of dispute fees to withdraw.{" "}
              <Button variant="primary" disabled={!!busy} onClick={() => run("refund", () => client.withdrawNative(), "Fees withdrawn.")}>Withdraw</Button>
            </Notice>
          </div>
        )}
        {!isParty && open && <div style={{ marginTop: 12 }}><Notice tone="info">You&apos;re viewing someone else&apos;s trade. Only the time-based closing actions are open to you.</Notice></div>}
        {actions.length > 0 && <div style={{ display: "grid", gap: 10, marginTop: 14 }}>{actions}</div>}
        {message && <div style={{ marginTop: 12 }}><Notice tone={message.tone}>{message.text}</Notice></div>}
      </Card>

      {t.state === TradeState.DISPUTED && isParty && (
        <EvidenceCard tradeId={id} isBuyer={isBuyer} panelistKey={panelistKey} assignee={assignee} onSubmitted={() => void chain.refetch()} />
      )}

      <TradeChatPanel tradeId={id} seller={t.seller} buyer={t.buyer} />

      <Timeline summary={summary} />
    </div>
  );
}

function ActionBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ padding: 14, borderRadius: 10, background: colors.inset, border: `1px solid ${colors.border}` }}>
      <div style={{ fontWeight: 700, color: colors.strong, fontSize: 14, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

// ─── Evidence ─────────────────────────────────────────────────────────────────

function EvidenceCard({ tradeId, isBuyer, panelistKey, assignee, onSubmitted }: {
  tradeId: bigint;
  isBuyer: boolean;
  panelistKey: string | null;
  assignee: Address;
  onSubmitted: () => void;
}) {
  const { client, identity } = useEscrowX();
  const stored = isBuyer ? loadEvidence(tradeId) : null;
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function submit() {
    if (!client || !identity || !panelistKey) return;
    setBusy(true);
    setMessage(null);
    try {
      let ciphertext: Uint8Array;
      let key: Uint8Array;
      let commitment: Hex;
      let name: string;
      if (!file && stored) {
        ({ ciphertext, commitment } = stored);
        key = keyFromHex(stored.keyHex);
        name = stored.fileName;
      } else if (file) {
        const ev = await encryptEvidence(new Uint8Array(await file.arrayBuffer()));
        ({ ciphertext, key, commitment } = ev);
        name = file.name;
      } else {
        throw new Error("Choose a file to submit");
      }
      const sealed = sealEvidenceKey(identity, panelistKey, { tradeId: tradeId.toString(), commitment, key: keyToHex(key), mimeType: file?.type || stored?.mimeType });
      await client.submitEvidence(tradeId, formatEvidenceUri(identity.publicKey, panelistKey, sealed));
      downloadBytes(ciphertext, `trade-${tradeId}-${name}.enc`);
      setMessage({ tone: "ok", text: "Evidence key sealed to the assigned panelist and recorded on-chain. Send the downloaded encrypted file to the arbitration firm through its case channel." });
      onSubmitted();
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="DISPUTE EVIDENCE">
      <MessagingGate reason="seal evidence for the arbitrator">
        {!panelistKey ? (
          <Notice tone="info">
            {assignee === zeroAddress ? "The arbitration firm hasn't assigned a panelist yet." : "The assigned arbitrator hasn't published an encryption key."} You can submit evidence once a panelist with a published key is assigned.
          </Notice>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            <p style={{ fontSize: 12, color: colors.muted, margin: 0 }}>
              Evidence is encrypted on this device and its key is sealed so that <strong>only panelist {shortAddr(assignee)}</strong> can open it. The other party can see that you submitted something, but not what.
            </p>
            {stored && !file && <Notice tone="ok">Using the receipt you attached when marking paid ({stored.fileName}) — its fingerprint {shortHash(stored.commitment)} is already on-chain.</Notice>}
            <label>
              <Label hint={stored ? "or choose a different file" : undefined}>FILE</Label>
              <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ color: "#94a3b8", fontSize: 12 }} />
            </label>
            <div>
              <Button variant="blue" solid disabled={busy || (!file && !stored)} onClick={() => void submit()}>{busy ? "Confirm in wallet…" : "Seal & submit evidence"}</Button>
            </div>
            {message && <Notice tone={message.tone}>{message.text}</Notice>}
          </div>
        )}
      </MessagingGate>
    </Card>
  );
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

function Timeline({ summary }: { summary: TradeSummary }) {
  const describe = (name: string, args: Record<string, unknown>): string => {
    switch (name) {
      case "TradeOpened": return `Buyer locked ${fmtToken(args.amount as bigint)} USDT from the seller's vault`;
      case "PaymentMarked": return (args.evidenceCommitment as string) === zeroHash ? "Buyer marked the fiat as sent" : `Buyer marked the fiat as sent · receipt fingerprint ${shortHash(args.evidenceCommitment as string)}`;
      case "DisputeRequested": return `Dispute opened by ${shortAddr(args.opener as string)} (fee ${formatEther(args.feePaid as bigint)} ETH)`;
      case "ArbitrationFeePaid": return `${shortAddr(args.party as string)} matched the arbitration fee`;
      case "DisputeCreated": return `Case #${args.disputeId} created with ${arbitratorName(args.arbitrator as string)}`;
      case "Escalated": return `Escalated to ${arbitratorName(args.fallbackArbitrator as string)}`;
      case "Evidence": return `${shortAddr(args.party as string)} submitted sealed evidence`;
      case "FeesSettled": return `Dispute fees settled (buyer ${formatEther(args.toBuyer as bigint)} ETH, seller ${formatEther(args.toSeller as bigint)} ETH)`;
      case "Released": return `${fmtToken(args.amount as bigint)} USDT released to buyer · ${RELEASE_REASONS[Number(args.reason)] ?? ""}`;
      case "Cancelled": return `Crypto returned to seller · ${CANCEL_REASONS[Number(args.reason)] ?? ""}`;
      default: return name;
    }
  };
  return (
    <Card title="ON-CHAIN ACTIVITY">
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
        {summary.events.map((e) => (
          <li key={`${e.txHash}-${e.logIndex}`} style={{ display: "flex", gap: 10 }}>
            <span style={{ color: colors.blueText }}>•</span>
            <div>
              <div style={{ fontSize: 13, color: colors.text }}>{describe(e.name, e.args)}</div>
              <div style={{ fontSize: 11, color: colors.muted }}>{e.timestamp ? fmtTs(e.timestamp) : "—"} · block {e.blockNumber.toString()} · <code style={{ fontFamily: mono }}>{shortHash(e.txHash)}</code></div>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
