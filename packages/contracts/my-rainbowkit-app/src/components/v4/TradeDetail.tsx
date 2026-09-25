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
import { useFirmPanels } from "@/hooks/useFirmPanels";
import { usePendingAction } from "@/hooks/usePendingAction";
import { PendingNotice, pendingLabel } from "@/components/v4/Pending";
import { Reputation, useReputation } from "@/components/v4/Reputation";
import { V4, arbitratorName } from "@/config/v4";
import { StateBadge } from "@/components/StateBadge";
import { Addr, Button, Card, Field, KV, Notice, TxLink, errorText } from "@/components/ui";
import { MessagingGate } from "@/components/v4/MessagingGate";
import { TradeChatPanel } from "@/components/v4/TradeChatPanel";
import { fmtDuration, fmtTs, shortAddr, shortHash } from "@/lib/format";
import { useMessages } from "@/context/Messages";
import { describeEvent } from "@/lib/v4/describe";
import { downloadBytes, findTradeOffer, fmtFiat, fmtToken, loadEvidence, recallTradeTerms, rememberTradeTerms, storeEvidence, termsFromOffer } from "@/lib/v4/local";
import { V4State, progressSteps, type TradeSummary } from "@/lib/v4/tradeIndex";

const SYM = V4.tokenSymbol;

export function TradeDetail({ summary, chainNow, arbitrationTimeout, onChanged }: {
  summary: TradeSummary;
  chainNow: number;
  arbitrationTimeout: number;
  onChanged: () => void;
}) {
  const { address, client, book, identity } = useEscrowX();
  const { status: panelStatus } = useFirmPanels();
  const reputationOf = useReputation();
  const messages = useMessages();
  const publicClient = usePublicClient();
  const id = summary.tradeId;
  const opened = summary.events.find((e) => e.name === "TradeOpened");

  // Price and currency live in the signed offer, not on-chain: remembered when the trade opened, else found on
  // the relays by the trade's on-chain offer hash.
  const terms = useQuery({
    queryKey: ["tradeTerms", id.toString()],
    enabled: !!book && !!opened,
    staleTime: Infinity,
    queryFn: async () => {
      const known = recallTradeTerms(id);
      if (known?.side) return known;
      const offer = await findTradeOffer(book!, opened!.args.offerHash as string);
      if (!offer) return known;
      const found = termsFromOffer(offer);
      rememberTradeTerms(id, found);
      return found;
    },
  });

  const chain = useQuery({
    queryKey: ["trade", id.toString(), client?.escrow],
    enabled: !!client,
    refetchInterval: 5000,
    queryFn: async () => {
      const [trade, dispute] = await Promise.all([client!.getTrade(id), client!.getDispute(id)]);
      const [primaryFee, fallbackFee, claimable] = await Promise.all([
        client!.arbitrationCost(trade.arbitrator),
        client!.arbitrationCost(trade.fallbackArbitrator),
        address ? client!.claimableNative(address) : Promise.resolve(0n),
      ]);
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

  // Every wallet action goes through one pending state: timeouts, hints, cancel and retry all live there.
  const pending = usePendingAction();
  const busy = pending.busy;
  const [confirmedFiat, setConfirmedFiat] = useState(false);
  const [receipt, setReceipt] = useState<File | null>(null);
  const [reference, setReference] = useState("");

  function run(label: string, fn: () => Promise<unknown>, ok: string) {
    void pending.run(label, fn, {
      success: ok,
      onDone: async () => {
        await chain.refetch();
        onChanged();
      },
    });
  }

  if (!chain.data || !client) {
    return (
      <Card title={`Trade #${id}`}>
        {chain.error ? (
          <Notice tone="error">{errorText(chain.error)}</Notice>
        ) : (
          <div className="stack-sm">
            <div className="skeleton" style={{ width: "30%" }} />
            <div className="skeleton" style={{ width: "80%" }} />
          </div>
        )}
      </Card>
    );
  }

  const { trade: t, dispute: d, primaryFee, fallbackFee, claimable, assignee, panelistKey } = chain.data;
  const fallbackPanel = panelStatus(t.fallbackArbitrator);
  const activePanel = panelStatus(t.activeArbitrator !== zeroAddress ? t.activeArbitrator : t.arbitrator);
  const me = address?.toLowerCase();
  const isSeller = me === t.seller.toLowerCase();
  const isBuyer = me === t.buyer.toLowerCase();
  const isParty = isSeller || isBuyer;
  const now = chainNow;
  const open = t.state === TradeState.LOCKED || t.state === TradeState.PAID || t.state === TradeState.FEE_PENDING || t.state === TradeState.DISPUTED;
  const disputed = t.state === TradeState.DISPUTED || t.state === TradeState.FEE_PENDING;

  const paymentDeadline = Number(t.paymentDeadline);
  const releaseDeadline = Number(t.releaseDeadline);
  const feeDeadline = Number(d.feeDeadline);
  const startedAt = Number(d.startedAt);
  const escalateAt = startedAt + arbitrationTimeout;
  const terminalAt = startedAt + (d.escalated ? arbitrationTimeout : 2 * arbitrationTimeout);
  const openerIsMe = me === d.opener.toLowerCase();
  const counterparty = isBuyer ? t.seller : isSeller ? t.buyer : undefined;

  const fiat = terms.data ? fmtFiat(t.amount, terms.data.price, terms.data.fiatCurrency) : null;

  const countdown = (deadline: number) => (now <= deadline ? `in ${fmtDuration(deadline - now)}` : `${fmtDuration(now - deadline)} ago`);

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
    // Tell the seller privately (best effort — the on-chain record is what counts).
    if (messages.peer(id)) {
      await messages.send(id, { type: "payment_sent", ...(reference.trim() ? { reference: reference.trim() } : {}) }).catch(() => {});
    }
  }

  // Ranked, not just collected: the lowest rank is what this trade is actually waiting on, and only that gets
  // to be "your next step". Everything else — early releases, conceding, walking away — hides behind
  // "Other options", so no screen ever proposes giving up as the thing to do next.
  const actions: Act[] = [];
  const act = (rank: number, mine: boolean, node: ReactNode) => actions.push({ rank, mine, node });

  if (isBuyer && t.state === TradeState.LOCKED && now <= paymentDeadline) {
    act(Rank.NOW, true,
      <ActionBox key="paid" title={fiat ? `Send ${fiat} to the seller, then confirm here` : "Pay the seller, then confirm here"} note={`Due ${countdown(paymentDeadline)}. The seller's details are in the private chat below.`}>
        <Field label="Transfer reference" hint="optional · sent privately to the seller"
          help={identity ? "Helps the seller find your payment in their banking app." : "Unlock messaging below to send the seller a reference with it."}>
          <input className="input mono" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. OPY-7731-2026" maxLength={200} disabled={!identity} />
        </Field>
        <Field label="Receipt or bank statement" hint="optional, strongly recommended"
          help="Encrypted on this device. Only its fingerprint goes on-chain; nobody can open it unless you share the key with a dispute arbitrator.">
          <input className="file" type="file" accept="image/*,application/pdf" onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} />
        </Field>
        <div>
          <Button variant="accent" busy={busy === "paid"} disabled={!!busy} onClick={() => run("paid", markPaid, "Marked as paid. The seller now checks their bank and releases.")}>
            {busy === "paid" ? pendingLabel(pending, "") : "I've paid"}
          </Button>
        </div>
      </ActionBox>
    );
  }

  if (isSeller && open) {
    // Releasing is the seller's job once the buyer says they've paid. Before that — and during a dispute,
    // where it concedes the case — it's a choice, not a next step.
    act(t.state === TradeState.PAID ? Rank.NOW : disputed ? Rank.GIVE_UP : Rank.EARLY, true,
      <ActionBox key="release"
        title={disputed ? "Release now (concedes the dispute)" : t.state === TradeState.PAID ? "Buyer says they've paid — check, then release" : "Release to the buyer"}
        note={t.state === TradeState.LOCKED ? "The buyer hasn't marked this as paid yet. Only release once the money is in your account." : undefined}>
        <label className="check">
          <input type="checkbox" checked={confirmedFiat} onChange={(e) => setConfirmedFiat(e.target.checked)} />
          <span>I checked <strong>my own banking app</strong> and the full amount{fiat ? <> (<strong className="mono">{fiat}</strong>)</> : null} arrived from an account in the buyer&apos;s name. <span className="faint">Screenshots can be faked.</span></span>
        </label>
        <div>
          <Button variant="accent" disabled={!confirmedFiat || !!busy} busy={busy === "release"} onClick={() => run("release", () => client.release(id), `Released ${fmtToken(t.amount)} ${SYM} to the buyer.`)}>
            {busy === "release" ? pendingLabel(pending, "") : `Release ${fmtToken(t.amount)} ${SYM}`}
          </Button>
        </div>
      </ActionBox>
    );
  }

  if (t.state === TradeState.PAID && (isSeller || (isBuyer && now > releaseDeadline))) {
    // For a buyer whose seller has gone quiet past the deadline this is the way forward; for the seller it's
    // the escape hatch behind "check your bank first".
    act(isBuyer ? Rank.NOW : Rank.FALLBACK, true,
      <ActionBox key="dispute" title={isSeller ? "Money didn't arrive? Open a dispute" : "Seller hasn't released — open a dispute"}>
        <p className="small muted">
          You deposit the arbitration fee (<span className="mono">{formatEther(primaryFee)} ETH</span>). The other side must match it or loses by default.
          The winner gets their fee back. Decided by <strong>{arbitratorName(t.arbitrator)}</strong>.
        </p>
        <div>
          <Button variant="warn" busy={busy === "dispute"} disabled={!!busy} onClick={() => run("dispute", () => client.openDispute(id), "Dispute opened. Waiting for the other party's fee.")}>
            Open dispute
          </Button>
        </div>
      </ActionBox>
    );
  }

  if (t.state === TradeState.FEE_PENDING) {
    if (isParty && !openerIsMe && now <= feeDeadline) {
      act(Rank.NOW, true,
        <ActionBox key="fee" title="A dispute was opened against you">
          <p className="small muted">
            Match the <span className="mono">{formatEther(primaryFee)} ETH</span> arbitration fee {countdown(feeDeadline)}, or the other side wins by default. If you win, it&apos;s refunded.
          </p>
          <div>
            <Button variant="primary" busy={busy === "fee"} disabled={!!busy} onClick={() => run("fee", () => client.payArbitrationFee(id), "Fee matched — the dispute is now with the arbitrator.")}>
              Match fee &amp; defend
            </Button>
          </div>
        </ActionBox>
      );
    }
    if (now > feeDeadline) {
      act(Rank.NOW, openerIsMe, 
        <ActionBox key="feeTimeout" title="Fee deadline passed">
          <p className="small muted">The other side didn&apos;t match the fee in time. Anyone can now settle it in the opener&apos;s favour.</p>
          <div>
            <Button variant="primary" busy={busy === "feeTimeout"} disabled={!!busy} onClick={() => run("feeTimeout", () => client.claimFeeTimeout(id), "Dispute settled in the opener's favour.")}>
              Settle by default
            </Button>
          </div>
        </ActionBox>
      );
    }
  }

  if (t.state === TradeState.DISPUTED && isParty && !d.escalated && now > escalateAt) {
    act(Rank.DEADLINE, true,
      <ActionBox key="escalate" title="Arbitrator missed its deadline">
        <p className="small muted">Move the case to <strong>{arbitratorName(t.fallbackArbitrator)}</strong> (fee <span className="mono">{formatEther(fallbackFee)} ETH</span>, paid from the held fees where possible).</p>
        {!fallbackPanel.staffed && (
          <Notice tone="warn">
            {arbitratorName(t.fallbackArbitrator)} has no panelists registered right now, so it can&apos;t assign your case
            to anyone. Escalating there would leave the escrow&apos;s timeout as the only way out — waiting for the
            current firm is usually better.
          </Notice>
        )}
        <div>
          <Button variant="warn" busy={busy === "escalate"} disabled={!!busy} onClick={() => run("escalate", () => client.escalateToFallback(id), "Escalated to the fallback arbitrator.")}>
            Escalate
          </Button>
        </div>
      </ActionBox>
    );
  }

  if (t.state === TradeState.DISPUTED && now > terminalAt) {
    act(Rank.DEADLINE, isParty,
      <ActionBox key="terminal" title="Arbitration timed out">
        <p className="small muted">Nobody ruled in time. Closing returns the crypto to the seller&apos;s vault and splits the held fees.</p>
        <div>
          <Button busy={busy === "terminal"} disabled={!!busy} onClick={() => run("terminal", () => client.claimArbitrationTimeout(id), "Dispute closed.")}>
            Close dispute
          </Button>
        </div>
      </ActionBox>
    );
  }

  if (t.state === TradeState.LOCKED && now > paymentDeadline) {
    act(Rank.DEADLINE, isParty,
      <ActionBox key="unpaid" title="Payment window missed" note={`The buyer didn't mark this as paid in time. Anyone can now return the ${SYM} to the seller's vault.`}>
        <div>
          <Button variant="primary" busy={busy === "unpaid"} disabled={!!busy} onClick={() => run("unpaid", () => client.cancelUnpaid(id), "Trade cancelled; crypto is back in the seller's vault.")}>
            Cancel trade
          </Button>
        </div>
      </ActionBox>
    );
  }

  if (isBuyer && open) {
    // Never the headline: before paying it's just an option, and after paying it hands the seller the money.
    act(t.state === TradeState.LOCKED ? Rank.EARLY : Rank.GIVE_UP, true,
      <ActionBox key="cancel" title={disputed ? "Withdraw from the trade (concedes the dispute)" : "Changed your mind?"}>
        <p className="small muted">Cancelling returns the crypto to the seller. <strong>Don&apos;t cancel if you already paid</strong> — open a dispute instead.</p>
        <div>
          <Button variant="danger" size="sm" busy={busy === "cancel"} disabled={!!busy} onClick={() => run("cancel", () => client.buyerCancel(id), "Trade cancelled.")}>
            Cancel trade
          </Button>
        </div>
      </ActionBox>
    );
  }

  const ranked = [...actions].sort((a, b) => a.rank - b.rank);
  // Onlookers can only ever take the time-based actions, so for them the list is just a list.
  const primary = isParty ? ranked.find((a) => a.mine && a.rank <= Rank.FALLBACK) : ranked[0];
  const others = ranked.filter((a) => a !== primary);

  const waitingFor =
    t.state === TradeState.LOCKED ? (isSeller ? "Waiting for the buyer to send the money and mark this as paid." : null)
    : t.state === TradeState.PAID ? (isBuyer ? `Waiting for the seller to check their bank and release. If they don't, you can open a dispute ${countdown(releaseDeadline)}.` : null)
    : t.state === TradeState.FEE_PENDING ? (openerIsMe
        ? `Waiting for the other party to match the arbitration fee — due ${countdown(feeDeadline)}. If they don't, you can settle by default.`
        : "Waiting for the arbitration fee window.")
    : t.state === TradeState.DISPUTED ? (assignee === zeroAddress
        ? `${arbitratorName(t.activeArbitrator !== zeroAddress ? t.activeArbitrator : t.arbitrator)} is assigning a panelist. Add your evidence below while you wait.`
        : "A panelist has the case. Add your evidence below — that's what they rule on.")
    : null;

  // The deadline that matters right now, shown in the header.
  const deadline =
    t.state === TradeState.LOCKED ? { label: "Payment due", at: paymentDeadline }
    : t.state === TradeState.PAID ? { label: "Buyer may dispute", at: releaseDeadline }
    : t.state === TradeState.FEE_PENDING ? { label: "Fee match due", at: feeDeadline }
    : t.state === TradeState.DISPUTED ? { label: d.escalated ? "Can be closed" : "Can escalate", at: d.escalated ? terminalAt : escalateAt }
    : null;

  const fromBuyOffer = terms.data?.side === "buy";
  const roleLine = isBuyer ? <>You&apos;re <strong>buying</strong> from <Addr address={t.seller} />{fromBuyOffer ? " · they filled your buy offer" : ""}</>
    : isSeller ? <>You&apos;re <strong>selling</strong> to <Addr address={t.buyer} />{fromBuyOffer ? " · you filled their buy offer" : ""}</>
    : <><Addr address={t.seller} /> → <Addr address={t.buyer} /></>;

  const kvRows: [ReactNode, ReactNode][] = [
    ["Seller", <Addr key="s" address={t.seller} you={isSeller} />],
    ["Buyer", <Addr key="b" address={t.buyer} you={isBuyer} />],
    [
      "Arbitrator",
      <span key="a">
        {arbitratorName(t.activeArbitrator !== zeroAddress ? t.activeArbitrator : t.arbitrator)}
        {d.escalated ? " (fallback)" : ""}
        {activePanel.panel !== undefined && <span className="faint"> · {activePanel.panel} panelist{activePanel.panel === 1 ? "" : "s"}</span>}
      </span>,
    ],
  ];
  kvRows.push([
    "Fees",
    <span key="f">
      EscrowX takes <strong>nothing</strong> from this trade
      <span className="faint"> · you pay gas on your own transactions; a dispute costs {formatEther(primaryFee)} ETH per side, refunded to the winner</span>
    </span>,
  ]);
  if (t.state === TradeState.DISPUTED) kvRows.push(["Assigned panelist", assignee === zeroAddress ? "Not assigned yet" : shortAddr(assignee)]);
  if (deadline) kvRows.push([deadline.label, <span key="d" className="mono">{fmtTs(deadline.at)}</span>]);

  return (
    <div className="stack">
      <Card
        title={<>Trade <span className="mono">#{id.toString()}</span> <StateBadge state={t.state} /></>}
        right={deadline && (
          <span className={`chip ${now > deadline.at ? "chip-danger" : "chip-warn"}`} title={fmtTs(deadline.at)}>
            {deadline.label} {countdown(deadline.at)}
          </span>
        )}
      >
        <div className="stack">
          <div className="stack-xs">
            <div className="big-num">{fmtToken(t.amount)} <span className="faint" style={{ fontSize: 14 }}>{SYM}</span></div>
            {fiat && terms.data && (
              <div className="small faint">
                for <span className="mono muted strong">{fiat}</span> at {Number(terms.data.price).toLocaleString("en-US")} {terms.data.fiatCurrency}/{SYM}
              </div>
            )}
            <div className="small muted row" style={{ gap: 6 }}>{roleLine}</div>
            {counterparty && <Reputation stats={reputationOf(counterparty)} address={counterparty} detailed />}
          </div>

          <Progress state={t.state} summary={summary} />

          {!isParty && open && <Notice tone="info">You&apos;re viewing someone else&apos;s trade. Only the time-based closing actions are open to you.</Notice>}

          {claimable > 0n && (
            <Notice tone="ok">
              <div className="row-between">
                <span>{formatEther(claimable)} ETH of dispute fees to collect.</span>
                <Button size="sm" busy={busy === "refund"} onClick={() => run("refund", () => client.withdrawNative(), "Fees withdrawn.")}>Withdraw</Button>
              </div>
            </Notice>
          )}

          {primary && (
            <div className="stack-sm">
              <span className="eyebrow">{isParty ? "Your next step" : "Available actions"}</span>
              {primary.node}
            </div>
          )}
          {!primary && open && isParty && waitingFor && <Notice tone="info">{waitingFor}</Notice>}
          {others.length > 0 && (
            <details className="stack-sm">
              <summary className="small faint" style={{ cursor: "pointer" }}>
                {primary ? `Other options (${others.length})` : `Things you can still do (${others.length})`}
              </summary>
              <div className="stack-sm" style={{ marginTop: 10 }}>{others.map((a, i) => <div key={i}>{a.node}</div>)}</div>
            </details>
          )}
          <PendingNotice pending={pending} />

          <details>
            <summary className="small faint" style={{ cursor: "pointer" }}>Trade details</summary>
            <div style={{ marginTop: 10 }}>
              <KV rows={kvRows} />
            </div>
          </details>
        </div>
      </Card>

      {t.state === TradeState.DISPUTED && isParty && (
        <EvidenceCard tradeId={id} isBuyer={isBuyer} panelistKey={panelistKey} assignee={assignee} onSubmitted={() => void chain.refetch()} />
      )}

      {/* A finished trade needs no chat; only show its history if messaging is already unlocked. */}
      {(open || identity) && <TradeChatPanel summary={summary} />}

      <Timeline summary={summary} />
    </div>
  );
}

interface Act {
  rank: number;
  /** The connected wallet is the one expected to do this. */
  mine: boolean;
  node: ReactNode;
}

/** Lower is more urgent. Only NOW…FALLBACK can be "your next step". */
const Rank = {
  NOW: 10,        // what the protocol is waiting on you for
  DEADLINE: 20,   // a window has expired and someone must close it out
  FALLBACK: 40,   // legitimate, but only after the normal path stalls
  EARLY: 60,      // allowed, out of turn
  GIVE_UP: 90,    // hands the money to the other side
} as const;

function ActionBox({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="action">
      <div className="stack-xs">
        <h3>{title}</h3>
        {note && <p className="small faint">{note}</p>}
      </div>
      {children}
    </div>
  );
}

// ─── Progress ─────────────────────────────────────────────────────────────────

function Progress({ state, summary }: { state: number; summary: TradeSummary }) {
  return (
    <div className="stepper" aria-label="Trade progress">
      {progressSteps(state as V4State, summary.events).map((s) => (
        <div key={s.label} className={`step ${s.status}`} aria-current={s.status === "current" ? "step" : undefined}>
          <div className="step-bar" />
          <span className="step-label">{s.label}</span>
        </div>
      ))}
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
  const pending = usePendingAction();
  const busy = pending.busy === "evidence";

  async function submit() {
    if (!client || !identity || !panelistKey) return;
    await pending.run("evidence", async () => {
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
    }, {
      success: "Evidence key sealed to the assigned panelist and recorded on-chain. Send the downloaded encrypted file to the arbitration firm through its case channel.",
      onDone: onSubmitted,
    });
  }

  return (
    <Card title="Dispute evidence" sub="Only the assigned panelist can open what you submit.">
      <MessagingGate reason="seal evidence for the arbitrator">
        {!panelistKey ? (
          <Notice tone="info">
            {assignee === zeroAddress ? "The arbitration firm hasn't assigned a panelist yet." : "The assigned arbitrator hasn't published an encryption key."} You can submit evidence once a panelist with a published key is assigned.
          </Notice>
        ) : (
          <div className="stack-sm">
            <p className="small muted p0">
              Encrypted on this device, with the key sealed so that <strong>only panelist {shortAddr(assignee)}</strong> can open it. The other party can see that you submitted something, but not what.
            </p>
            {stored && !file && <Notice tone="ok">Using the receipt you attached when marking paid ({stored.fileName}) — fingerprint <span className="mono">{shortHash(stored.commitment)}</span> is already on-chain.</Notice>}
            <Field label="File" hint={stored ? "or choose a different one" : undefined}>
              <input className="file" type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            <div>
              <Button variant="primary" busy={busy} disabled={!file && !stored} onClick={() => void submit()}>
                {busy ? pendingLabel(pending, "") : "Seal & submit evidence"}
              </Button>
            </div>
            <PendingNotice pending={pending} />
          </div>
        )}
      </MessagingGate>
    </Card>
  );
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

function Timeline({ summary }: { summary: TradeSummary }) {
  return (
    <Card title="On-chain record" sub="Every step, read straight from the escrow contract.">
      <ol className="timeline">
        {summary.events.map((e) => (
          <li key={`${e.txHash}-${e.logIndex}`}>
            <span className="node" aria-hidden />
            <div className="stack-xs">
              <span className="small">{describeEvent(e)}</span>
              <span className="tiny faint">
                {e.timestamp ? fmtTs(e.timestamp) : "—"} · block <span className="mono">{e.blockNumber.toString()}</span> · <TxLink hash={e.txHash} />
              </span>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
