// src/pages/arbitrate.tsx — arbitration desk for licensed firms and their panelists.
//
// Reads and writes a firm's LicensedArbitratorAdapter directly. The firm admin manages the panel, assigns
// cases and can veto; the assigned panelist opens the sealed evidence and proposes a ruling; after the review
// period anyone can execute it. A ruling can only send the disputed trade's locked crypto to its buyer or back
// to its seller — and if the firm is slow, the parties can take the case to the escrow's fallback arbitrator,
// so every case here carries that deadline.

import Head from "next/head";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatEther, keccak256, parseEther, toBytes, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { adapterKeyFromNostrPubkey, decryptEvidence, keyFromHex, openEvidenceKey, parseEvidenceUri } from "@escrowx/sdk";
import { useEscrowX } from "@/context/EscrowX";
import { FIRMS, IS_TESTNET, V4, arbitratorName } from "@/config/v4";
import { usePendingAction } from "@/hooks/usePendingAction";
import { useWalletSession } from "@/hooks/useWalletSession";
import { PendingNotice } from "@/components/v4/Pending";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Shell } from "@/components/Shell";
import { StateBadge } from "@/components/StateBadge";
import { Addr, Button, Card, Chip, CopyButton, Empty, Field, KV, Notice, TxLink, errorText } from "@/components/ui";
import { MessagingGate } from "@/components/v4/MessagingGate";
import { useV4Trades } from "@/hooks/useV4Trades";
import { fmtDuration, fmtTs, shortAddr, shortHash } from "@/lib/format";
import { RULING_BUYER, RULING_SELLER, escalationDeadline, readCases, readFirm, readPanel, writeFirm, type CaseInfo, type FirmInfo } from "@/lib/v4/arbitration";
import { describeEvent } from "@/lib/v4/describe";
import { fmtToken } from "@/lib/v4/local";
import { V4State, type TradeSummary } from "@/lib/v4/tradeIndex";

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

type Filter = "attention" | "mine" | "open" | "all";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "attention", label: "Needs attention" },
  { key: "mine", label: "Assigned to me" },
  { key: "open", label: "Open" },
  { key: "all", label: "All" },
];

export default function Arbitrate() {
  const { address } = useAccount();
  const { isConnected, resuming } = useWalletSession();
  const publicClient = usePublicClient();
  const trades = useV4Trades();
  const [firmAddr, setFirmAddr] = useState<Address>(FIRMS[0]);
  const [selected, setSelected] = useState<bigint | undefined>();
  const [filter, setFilter] = useState<Filter | null>(null);
  // How long the first read has been running. A desk that silently stays empty is the worst outcome here, so
  // after a while it says what it is waiting on — usually a blocked or rate-limited RPC, not a broken page.
  const [waiting, setWaiting] = useState(0);

  const desk = useQuery({
    queryKey: ["firm", firmAddr],
    enabled: !!publicClient,
    refetchInterval: 8000,
    queryFn: async () => {
      const firm = await readFirm(publicClient as never, firmAddr);
      const [cases, panel] = await Promise.all([readCases(publicClient as never, firm), readPanel(publicClient as never, firmAddr)]);
      return { firm, cases, panel };
    },
  });

  useEffect(() => {
    if (!desk.isLoading) return setWaiting(0);
    const started = Date.now();
    const id = setInterval(() => setWaiting(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [desk.isLoading, firmAddr]);

  // Deep link: /arbitrate?firm=0x…&case=3
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const f = params.get("firm");
    const c = params.get("case");
    if (f && FIRMS.some((x) => same(x, f))) setFirmAddr(FIRMS.find((x) => same(x, f))!);
    if (c && /^\d+$/.test(c)) {
      setSelected(BigInt(c));
      setFilter("all");
    }
  }, []);

  const firm = desk.data?.firm;
  const cases = desk.data?.cases ?? [];
  const panel = desk.data?.panel ?? [];
  const isAdmin = same(address, firm?.admin);
  const isPanelist = panel.some((p) => same(p.panelist, address));
  const isPendingAdmin = same(address, firm?.pendingAdmin);
  const tradeOf = (c: CaseInfo) => trades.trades.find((t) => t.tradeId === c.tradeId);

  const needsAttention = (c: CaseInfo) => {
    if (c.executed || c.escalated) return false;
    if (c.assignee === zeroAddress) return isAdmin; // the firm must assign it
    if (!c.hasProposal) return same(c.assignee, address); // the panelist must rule
    return trades.chainNow >= c.proposedAt + (firm?.reviewPeriod ?? 0); // anyone can execute
  };
  const counts: Record<Filter, number> = {
    attention: cases.filter(needsAttention).length,
    mine: cases.filter((c) => same(c.assignee, address)).length,
    open: cases.filter((c) => !c.executed).length,
    all: cases.length,
  };
  // Default to whatever this firm actually has: a desk whose only case is closed should open on it, not on an
  // empty "Open" tab next to a case it is already showing.
  const preferred: Filter = counts.attention > 0 ? "attention" : counts.open > 0 ? "open" : "all";
  const active: Filter = filter ?? preferred;
  const visible = cases.filter((c) =>
    active === "attention" ? needsAttention(c) : active === "mine" ? same(c.assignee, address) : active === "open" ? !c.executed : true
  );
  const selectedCase = cases.find((c) => c.disputeId === selected) ?? visible[0] ?? cases[0];

  const select = (id: bigint) => {
    setSelected(id);
    window.history.replaceState(null, "", `?firm=${firmAddr}&case=${id}`);
  };

  return (
    <>
      <Head>
        <title>Arbitration desk — EscrowX</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <Shell
        nav={
          <nav className="nav" aria-label="Main">
            <Link href="/">← App</Link>
            <button aria-current="page">Arbitration</button>
          </nav>
        }
      >
        <Card
          title="Arbitration desk"
          sub="For independent arbitration firms and their panelists. A ruling can only send a disputed trade's locked crypto to its buyer or back to its seller — nobody here can move anything else."
          right={
            <div className="segmented" role="group" aria-label="Firm">
              {FIRMS.map((f) => (
                <button key={f} aria-pressed={same(f, firmAddr)} onClick={() => { setFirmAddr(f); setSelected(undefined); }}>
                  {arbitratorName(f)}
                </button>
              ))}
            </div>
          }
        >
          <div className="row small">
            <span className="faint">You are</span>
            {resuming ? <Chip>reconnecting your wallet…</Chip> : !isConnected ? <Chip>reading as a visitor</Chip> : isAdmin ? <Chip tone="accent">firm admin</Chip> : null}
            {isPanelist && <Chip tone="info">panelist</Chip>}
            {isConnected && !isAdmin && !isPanelist && <Chip>a visitor — read only</Chip>}
            {isConnected && counts.attention > 0 && <Chip tone="warn">{counts.attention} case{counts.attention === 1 ? " needs" : "s need"} you</Chip>}
            {IS_TESTNET && <span className="faint">· On this test network the deployer runs both demo firms.</span>}
          </div>
          {!isConnected && !resuming && (
            <div className="row-between" style={{ marginTop: 14, gap: 16, flexWrap: "wrap" }}>
              <span className="small muted">
                Cases, panels, evidence and rulings are public — read them without a wallet. Connect one only to act as
                a firm admin or panelist.
              </span>
              <ConnectButton label="Connect wallet" />
            </div>
          )}
        </Card>

        {desk.isLoading && waiting >= 15 && (
          <Notice tone="warn">
            <div className="row-between">
              <span>
                Still reading firm {firmAddr.slice(0, 8)}… from the chain after {waiting}s. This page talks to the
                network directly, so a blocked or rate-limited RPC endpoint looks exactly like this.
              </span>
              <Button size="sm" busy={desk.isFetching} onClick={() => void desk.refetch()}>Retry</Button>
            </div>
          </Notice>
        )}

        {desk.error && (
          <Notice tone="error">
            <div className="row-between">
              <span>Couldn&apos;t read this firm from the network ({errorText(desk.error)}). Public RPC endpoints rate-limit bursts — retrying usually works.</span>
              <Button size="sm" busy={desk.isFetching} onClick={() => void desk.refetch()}>Retry</Button>
            </div>
          </Notice>
        )}

        {firm ? (
          <div className="split split-trades">
            <div className="stack sticky">
              <FirmCard firm={firm} isAdmin={isAdmin} isPendingAdmin={isPendingAdmin} onChanged={() => void desk.refetch()} />
              <PanelCard firm={firm} panel={panel} isAdmin={isAdmin} onChanged={() => void desk.refetch()} />
            </div>
            <div className="stack">
              <Card
                flush
                title={<>Cases <span className="chip">{firm.caseCount}</span></>}
                sub="Disputes the escrow sent to this firm, newest first."
                right={
                  <div className="segmented" role="group" aria-label="Filter cases">
                    {FILTERS.map(({ key, label }) => (
                      <button key={key} aria-pressed={active === key} onClick={() => setFilter(key)}>
                        {label}
                        <span className={`count${key === "attention" && counts.attention > 0 ? " count-hot" : ""}`}>{counts[key]}</span>
                      </button>
                    ))}
                  </div>
                }
              >
                {cases.length === 0 ? (
                  <Empty title="No cases yet">
                    A case arrives when both sides of a disputed trade have paid the arbitration fee. Then: the firm assigns a
                    panelist, the panelist opens the sealed evidence and proposes a ruling, and after the review period anyone
                    can execute it.
                  </Empty>
                ) : visible.length === 0 ? (
                  <Empty title="Nothing here">Try another filter.</Empty>
                ) : (
                  <div className="trade-list">
                    {visible.map((c) => {
                      const t = tradeOf(c);
                      const escalateAt = escalationDeadline(c, trades.arbitrationTimeout);
                      const overdue = escalateAt !== null && trades.chainNow > escalateAt;
                      return (
                        <button key={c.disputeId.toString()} className="trade-row" aria-current={selectedCase?.disputeId === c.disputeId} onClick={() => select(c.disputeId)}>
                          <div className="row" style={{ gap: 8 }}>
                            <span className="mono strong">Case #{c.disputeId.toString()}</span>
                            <CaseStatus c={c} firm={firm} now={trades.chainNow} />
                            {needsAttention(c) && <span className="chip chip-warn">your move</span>}
                          </div>
                          <span className="mono small">{t ? `${fmtToken(t.amount)} ${V4.tokenSymbol}` : ""}</span>
                          <div className={`next${overdue ? " mine" : ""}`}>
                            Trade #{c.tradeId.toString()} · {c.assignee === zeroAddress ? "unassigned" : `panelist ${shortAddr(c.assignee)}`}
                            {escalateAt !== null && (overdue ? " · parties can escalate now" : ` · ${fmtDuration(escalateAt - trades.chainNow)} left to rule`)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </Card>
              {selectedCase && (
                <CaseDetail
                  key={`${firm.address}-${selectedCase.disputeId}`}
                  firm={firm}
                  c={selectedCase}
                  trade={tradeOf(selectedCase)}
                  panel={panel}
                  isAdmin={isAdmin}
                  now={trades.chainNow}
                  arbitrationTimeout={trades.arbitrationTimeout}
                  onChanged={() => { void desk.refetch(); trades.refetch(); }}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="split split-trades">
            <div className="stack">
              <Card title="Reading the firm from the chain…">
                <div className="stack-sm">
                  <div className="skeleton" style={{ width: "55%" }} />
                  <div className="skeleton" style={{ width: "40%" }} />
                  <div className="skeleton" style={{ width: "70%" }} />
                </div>
              </Card>
            </div>
            <div className="stack">
              <Card title="Cases">
                <div className="stack-sm">
                  <div className="skeleton" style={{ width: "80%" }} />
                  <div className="skeleton" style={{ width: "65%" }} />
                  <div className="skeleton" style={{ width: "72%" }} />
                </div>
                <p className="small faint p0">
                  Every panel, case and ruling here is read straight from the contracts — no server sits in
                  between, so this takes as long as the network does.
                </p>
              </Card>
            </div>
          </div>
        )}
      </Shell>
    </>
  );
}

// ─── Status ───────────────────────────────────────────────────────────────────

function caseStage(c: CaseInfo, firm: FirmInfo, now: number) {
  if (c.executed) return { label: c.proposedRuling === RULING_BUYER ? "Ruled: buyer" : "Ruled: seller", tone: "accent" as const };
  if (c.escalated) return { label: "Escalated away", tone: "danger" as const };
  if (c.hasProposal) {
    const at = c.proposedAt + firm.reviewPeriod;
    return now >= at ? { label: "Ready to execute", tone: "warn" as const } : { label: `In review · ${fmtDuration(at - now)}`, tone: "info" as const };
  }
  if (c.assignee !== zeroAddress) return { label: "With panelist", tone: "info" as const };
  return { label: "Needs assignment", tone: "warn" as const };
}

function CaseStatus({ c, firm, now }: { c: CaseInfo; firm: FirmInfo; now: number }) {
  const s = caseStage(c, firm, now);
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

// ─── Firm ─────────────────────────────────────────────────────────────────────

function useFirmWrite(firm: FirmInfo, onChanged: () => void) {
  const publicClient = usePublicClient();
  const { data: wallet } = useWalletClient();
  const pending = usePendingAction();
  async function run(label: string, fn: Parameters<typeof writeFirm>[3], args: readonly unknown[], ok: string) {
    if (!publicClient || !wallet) return false;
    let succeeded = false;
    await pending.run(
      label,
      async (ctx) => {
        await writeFirm(publicClient as never, wallet as never, firm.address, fn, args, (phase, hash) => ctx.phase(phase, hash));
        succeeded = true;
      },
      { success: ok, onDone: onChanged }
    );
    return succeeded;
  }
  return { busy: pending.busy, pending, run };
}

function FirmCard({ firm, isAdmin, isPendingAdmin, onChanged }: { firm: FirmInfo; isAdmin: boolean; isPendingAdmin: boolean; onChanged: () => void }) {
  const { busy, pending, run } = useFirmWrite(firm, onChanged);
  const [fee, setFee] = useState("");
  const [treasury, setTreasury] = useState("");
  const [newAdmin, setNewAdmin] = useState("");
  const feeOk = /^\d+(\.\d+)?$/.test(fee.trim()) && Number(fee) >= 0;
  const addrOk = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v.trim());

  return (
    <Card title={arbitratorName(firm.address)} sub="The firm's own contract. EscrowX has no control over it.">
      <div className="stack-sm">
        <KV rows={[
          ["Contract", <Addr key="c" address={firm.address} />],
          ["Firm admin", <Addr key="a" address={firm.admin} you={isAdmin} />],
          ...(firm.pendingAdmin !== zeroAddress ? [["Pending admin", <Addr key="pa" address={firm.pendingAdmin} you={isPendingAdmin} />] as [React.ReactNode, React.ReactNode]] : []),
          ["Treasury", <Addr key="t" address={firm.treasury} />],
          ["Fee per side", <span key="f" className="mono">{formatEther(firm.fee)} ETH</span>],
          ["Review period", <span key="r" className="mono">{fmtDuration(firm.reviewPeriod)}</span>],
          ["Fees held", <span key="h" className="mono">{formatEther(firm.accruedFees)} ETH</span>],
        ]} />

        {firm.accruedFees > 0n && (
          <div>
            <Button size="sm" busy={busy === "withdraw"} onClick={() => run("withdraw", "withdrawFees", [], "Fees sent to the firm treasury.")}>
              Send fees to treasury
            </Button>
          </div>
        )}
        {isPendingAdmin && (
          <div>
            <Button size="sm" variant="primary" busy={busy === "accept"} onClick={() => run("accept", "acceptFirmAdmin", [], "You now administer this firm.")}>
              Accept the admin role
            </Button>
          </div>
        )}

        {isAdmin && (
          <details>
            <summary className="small strong" style={{ cursor: "pointer" }}>Firm settings</summary>
            <div className="stack-sm" style={{ marginTop: 10 }}>
              <Field label="Arbitration fee" hint="ETH per side" help="Applies to disputes opened from now on; existing cases keep the fee they started with.">
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <input className="input mono" value={fee} onChange={(e) => setFee(e.target.value)} placeholder={formatEther(firm.fee)} inputMode="decimal" />
                  <Button size="sm" disabled={!feeOk} busy={busy === "fee"} onClick={async () => { if (await run("fee", "setFee", [parseEther(fee.trim())], "Fee updated.")) setFee(""); }}>Set</Button>
                </div>
              </Field>
              <Field label="Treasury" help="Where withdrawn fees go. Anyone may trigger the withdrawal, but only this address receives.">
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <input className="input mono" value={treasury} onChange={(e) => setTreasury(e.target.value)} placeholder={firm.treasury} />
                  <Button size="sm" disabled={!addrOk(treasury)} busy={busy === "treasury"} onClick={async () => { if (await run("treasury", "setTreasury", [treasury.trim()], "Treasury updated.")) setTreasury(""); }}>Set</Button>
                </div>
              </Field>
              <Field label="Transfer admin" help="Two steps: you nominate, they accept. Nothing changes until they do.">
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <input className="input mono" value={newAdmin} onChange={(e) => setNewAdmin(e.target.value)} placeholder="0x… new admin" />
                  <Button size="sm" variant="danger" disabled={!addrOk(newAdmin)} busy={busy === "admin"} onClick={async () => { if (await run("admin", "transferFirmAdmin", [newAdmin.trim()], "Nominated. They must accept it.")) setNewAdmin(""); }}>Nominate</Button>
                </div>
              </Field>
            </div>
          </details>
        )}
        {isAdmin && <p className="help">You administer this firm: manage the panel, assign cases, and veto a ruling during its review period.</p>}
        <PendingNotice pending={pending} />
      </div>
    </Card>
  );
}

function PanelCard({ firm, panel, isAdmin, onChanged }: { firm: FirmInfo; panel: { panelist: Address; key: Hex }[]; isAdmin: boolean; onChanged: () => void }) {
  const { address, identity } = useEscrowX();
  const { busy, pending, run } = useFirmWrite(firm, onChanged);
  const [who, setWho] = useState("");
  const [key, setKey] = useState("");
  const myKey = identity ? adapterKeyFromNostrPubkey(identity.publicKey) : null;
  const imOnPanel = panel.some((p) => same(p.panelist, address));
  const validAddr = /^0x[0-9a-fA-F]{40}$/.test(who.trim());
  const validKey = /^0x[0-9a-fA-F]{64}$/.test(key.trim());

  return (
    <Card flush title={<>Panel <span className="chip">{panel.length}</span></>} sub="Panelists rule on cases. Each publishes a key so evidence can be sealed to them alone.">
      {panel.length === 0 ? (
        <Empty title="No panelists yet">{isAdmin ? "Add yourself or another arbitrator below." : "The firm hasn't added any panelists."}</Empty>
      ) : (
        <div className="trade-list">
          {panel.map((p) => (
            <div key={p.panelist} className="trade-row" style={{ cursor: "default" }}>
              <Addr address={p.panelist} you={same(p.panelist, address)} />
              {isAdmin ? (
                <Button size="sm" variant="ghost" busy={busy === `off-${p.panelist}`} onClick={() => run(`off-${p.panelist}`, "setPanelist", [p.panelist, false, "0x"], "Panelist removed.")}>Remove</Button>
              ) : <span />}
              <div className="next mono" title={p.key}>key {shortHash(p.key)}</div>
            </div>
          ))}
        </div>
      )}
      <div className="card-body stack-sm" style={{ borderTop: "1px solid var(--border)" }}>
        <MessagingGate reason={isAdmin ? "get your panel key and add yourself to the panel" : "get the panel key you give to your firm"}>
          {myKey && (
            <div className="stack-xs">
              <span className="eyebrow">Your panel key</span>
              <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                <code className="small" style={{ wordBreak: "break-all" }}>{myKey}</code>
                <CopyButton value={myKey} label="Copy panel key" />
              </div>
              <p className="help">Derived from your wallet, like your chat key. Give it to the firm with your address to join its panel.</p>
            </div>
          )}
          {isAdmin && myKey && !imOnPanel && (
            <div>
              <Button size="sm" variant="primary" busy={busy === "self"} onClick={() => run("self", "setPanelist", [address, true, myKey], "You're on the panel.")}>Add myself to the panel</Button>
            </div>
          )}
        </MessagingGate>
        {isAdmin && (
          <details>
            <summary className="small strong" style={{ cursor: "pointer" }}>Add another panelist</summary>
            <div className="stack-sm" style={{ marginTop: 10 }}>
              <Field label="Wallet address"><input className="input mono" value={who} onChange={(e) => setWho(e.target.value)} placeholder="0x…" /></Field>
              <Field label="Panel key" hint="they copy it from this page"><input className="input mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="0x… (32 bytes)" /></Field>
              <div>
                <Button size="sm" disabled={!validAddr || !validKey} busy={busy === "add"} onClick={() => run("add", "setPanelist", [who.trim(), true, key.trim()], "Panelist added.")}>Add panelist</Button>
              </div>
            </div>
          </details>
        )}
        <PendingNotice pending={pending} />
      </div>
    </Card>
  );
}

// ─── Case ─────────────────────────────────────────────────────────────────────

function CaseDetail({ firm, c, trade, panel, isAdmin, now, arbitrationTimeout, onChanged }: {
  firm: FirmInfo;
  c: CaseInfo;
  trade?: TradeSummary;
  panel: { panelist: Address; key: Hex }[];
  isAdmin: boolean;
  now: number;
  arbitrationTimeout: number;
  onChanged: () => void;
}) {
  const { address } = useEscrowX();
  const { busy, pending, run } = useFirmWrite(firm, onChanged);
  const [assignTo, setAssignTo] = useState<string>("");
  const [ruling, setRuling] = useState<bigint | null>(null);
  const [note, setNote] = useState("");
  const [vetoNote, setVetoNote] = useState("");
  const isAssignee = same(c.assignee, address);
  const reviewEnds = c.proposedAt + firm.reviewPeriod;
  const escalateAt = escalationDeadline(c, arbitrationTimeout);
  const overdue = escalateAt !== null && now > escalateAt;
  // After escalation the fallback firm owns the dispute; the escrow ignores rulings from the first firm.
  const escalation = trade?.events.find((e) => e.name === "Escalated");
  const movedAway = c.escalated || (!!escalation && !same(escalation.args.fallbackArbitrator as string, firm.address));
  const tradeOpen = (!trade || trade.state === V4State.DISPUTED) && !movedAway;
  // A panelist can't rule on a trade they're part of; the contract enforces this too.
  const eligible = panel.filter((p) => !trade || (!same(p.panelist, trade.buyer) && !same(p.panelist, trade.seller)));
  const paidCommitment = trade?.events.find((e) => e.name === "PaymentMarked")?.args.evidenceCommitment as Hex | undefined;
  const evidence = (trade?.events ?? []).filter((e) => e.name === "Evidence" && same(e.args.arbitrator as string, firm.address));
  const stage = caseStage(c, firm, now);
  const partyLabel = (addr: unknown) =>
    !trade || typeof addr !== "string" ? "" : same(addr, trade.buyer) ? "buyer" : same(addr, trade.seller) ? "seller" : "";

  return (
    <div className="stack">
      <Card title={<>Case <span className="mono">#{c.disputeId.toString()}</span> <CaseStatus c={c} firm={firm} now={now} /></>}
        right={trade && <StateBadge state={trade.state} />}>
        <div className="stack">
          {trade ? (
            <div className="stack-xs">
              <div className="big-num">{fmtToken(trade.amount)} <span className="faint" style={{ fontSize: 14 }}>{V4.tokenSymbol}</span></div>
              <div className="small muted">
                Trade <Link href={`/?trade=${trade.tradeId}`} className="mono">#{trade.tradeId.toString()}</Link> between buyer <Addr address={trade.buyer} /> and seller <Addr address={trade.seller} />
              </div>
            </div>
          ) : (
            <Notice tone="info">Trade #{c.tradeId.toString()} is still being indexed.</Notice>
          )}

          {movedAway && !c.executed && (
            <Notice tone="warn">
              This case was escalated to the escrow&apos;s fallback arbitrator{escalation ? ` (${arbitratorName(escalation.args.fallbackArbitrator as string)})` : ""}. Nothing to decide here.
            </Notice>
          )}
          {!tradeOpen && !movedAway && !c.executed && (
            <Notice tone="info">This trade already closed without a ruling (one side conceded or it timed out). Nothing to decide.</Notice>
          )}
          {tradeOpen && escalateAt !== null && (
            <Notice tone={overdue ? "error" : now > escalateAt - 86400 ? "warn" : "info"}>
              {overdue
                ? `Overdue: either party can now move this case to the escrow's fallback arbitrator, and this firm loses it.`
                : `This firm has ${fmtDuration(escalateAt - now)} left to rule (until ${fmtTs(escalateAt)}). After that either party can move the case to the fallback arbitrator.`}
            </Notice>
          )}

          <KV rows={[
            ["Dispute opened by", c.opener === zeroAddress ? "—" : <span key="o" className="row" style={{ gap: 6, justifyContent: "flex-end" }}><Addr address={c.opener} />{partyLabel(c.opener) && <Chip>{partyLabel(c.opener)}</Chip>}</span>],
            ["Assigned panelist", c.assignee === zeroAddress ? "—" : <Addr key="p" address={c.assignee} you={isAssignee} />],
            ["Proposed ruling", c.hasProposal || c.executed ? (c.proposedRuling === RULING_BUYER ? "Buyer — release the crypto" : "Seller — return the crypto") : "—"],
            ...(c.hasProposal && !c.executed ? [["Review ends", <span key="r" className="mono">{fmtTs(reviewEnds)}</span>] as [React.ReactNode, React.ReactNode]] : []),
            ["Evidence submitted", `${evidence.length}`],
            ["Status", stage.label],
          ]} />

          {/* Firm admin: assign */}
          {isAdmin && !c.executed && tradeOpen && (
            <div className="action">
              <h3>{c.assignee === zeroAddress ? "Assign a panelist" : "Reassign"}</h3>
              {eligible.length === 0 ? (
                <p className="small muted">No eligible panelist. Add one to the panel first (panelists can&apos;t be the trade&apos;s buyer or seller).</p>
              ) : (
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <select className="input" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                    <option value="">Choose a panelist…</option>
                    {eligible.map((p) => <option key={p.panelist} value={p.panelist}>{p.panelist}{same(p.panelist, address) ? " (you)" : ""}</option>)}
                  </select>
                  <Button variant="primary" disabled={!assignTo} busy={busy === "assign"} onClick={() => run("assign", "assign", [c.disputeId, assignTo], "Case assigned. Evidence can now be sealed to that panelist.")}>Assign</Button>
                </div>
              )}
              {c.hasProposal && <p className="help">Reassigning clears the current proposal.</p>}
            </div>
          )}

          {/* Panelist: propose */}
          {isAssignee && !c.executed && tradeOpen && !c.hasProposal && (
            <div className="action action-primary">
              <h3>Your ruling</h3>
              <div className="stack-xs">
                <label className="check"><input type="radio" name="ruling" checked={ruling === RULING_BUYER} onChange={() => setRuling(RULING_BUYER)} /><span><strong>Buyer</strong> paid as agreed — release the crypto to the buyer.</span></label>
                <label className="check"><input type="radio" name="ruling" checked={ruling === RULING_SELLER} onChange={() => setRuling(RULING_SELLER)} /><span><strong>Seller</strong> wasn&apos;t paid — return the crypto to the seller.</span></label>
              </div>
              <Field label="Reasoned decision" hint="kept by the firm; only its fingerprint goes on-chain"
                help="Write the reasons as you'd file them. The hash on-chain proves later that this exact text was the basis of the ruling.">
                <textarea className="input" style={{ height: 96, padding: 10, resize: "vertical" }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Evidence reviewed, findings, decision…" />
              </Field>
              <div>
                <Button variant="primary" disabled={ruling === null || note.trim().length < 10} busy={busy === "propose"}
                  onClick={() => run("propose", "proposeRuling", [c.disputeId, ruling, keccak256(toBytes(note.trim()))], `Ruling proposed. It can be executed after the ${fmtDuration(firm.reviewPeriod)} review period unless the firm vetoes it.`)}>
                  Propose ruling
                </Button>
              </div>
            </div>
          )}

          {/* Firm admin: veto during review */}
          {isAdmin && c.hasProposal && !c.executed && now < reviewEnds && (
            <div className="action">
              <h3>Review the proposal</h3>
              <p className="small muted">You can veto it for {fmtDuration(reviewEnds - now)} more. The panelist can then propose again, or you can reassign.</p>
              <Field label="Reason" hint="only its fingerprint goes on-chain">
                <input className="input" value={vetoNote} onChange={(e) => setVetoNote(e.target.value)} placeholder="Why the proposal is rejected" />
              </Field>
              <div>
                <Button variant="danger" size="sm" disabled={vetoNote.trim().length < 5} busy={busy === "veto"}
                  onClick={() => run("veto", "vetoProposal", [c.disputeId, keccak256(toBytes(vetoNote.trim()))], "Proposal vetoed.")}>Veto proposal</Button>
              </div>
            </div>
          )}

          {/* Anyone: execute */}
          {c.hasProposal && !c.executed && now >= reviewEnds && tradeOpen && (
            <div className="action action-primary">
              <h3>Execute the ruling</h3>
              <p className="small muted">The review period is over with no veto. Anyone can execute it: the escrow then {c.proposedRuling === RULING_BUYER ? "releases the crypto to the buyer" : "returns the crypto to the seller"} and settles the fees — the winner gets theirs back and the loser&apos;s pays this firm.</p>
              <div>
                <Button variant="accent" busy={busy === "execute"} onClick={() => run("execute", "executeRuling", [c.disputeId], "Ruling executed on the escrow.")}>Execute ruling</Button>
              </div>
            </div>
          )}

          <PendingNotice pending={pending} />
        </div>
      </Card>

      <Card title="Evidence" sub={isAssignee ? "Only you can open these. Parties send you the encrypted files through the firm's case channel." : "Sealed to the assigned panelist. Nobody else can open it — not the firm, not EscrowX."}>
        {evidence.length === 0 ? (
          <p className="small muted p0">Nothing submitted yet{c.assignee === zeroAddress ? " — parties can seal evidence once a panelist is assigned." : "."}</p>
        ) : isAssignee ? (
          <MessagingGate reason="open evidence sealed to you">
            <div className="stack">
              {evidence.map((e) => (
                <EvidenceItem key={`${e.txHash}-${e.logIndex}`} uri={e.args.evidence as string} party={e.args.party as Address} trade={trade!} submittedAt={e.timestamp} paidCommitment={paidCommitment} />
              ))}
            </div>
          </MessagingGate>
        ) : (
          <div className="stack-sm">
            {evidence.map((e) => (
              <div key={`${e.txHash}-${e.logIndex}`} className="row-between small">
                <span><Addr address={e.args.party as Address} /> {partyLabel(e.args.party) && <Chip>{partyLabel(e.args.party)}</Chip>}</span>
                <span className="tiny faint">{e.timestamp ? fmtTs(e.timestamp) : ""} · <TxLink hash={e.txHash} /></span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {trade && (
        <Card title="Trade history" sub="Straight from the escrow contract — the same record both parties see.">
          <ol className="timeline">
            {trade.events.map((e) => (
              <li key={`${e.txHash}-${e.logIndex}`}>
                <span className="node" aria-hidden />
                <div className="stack-xs">
                  <span className="small">{describeEvent(e)}</span>
                  <span className="tiny faint">{e.timestamp ? fmtTs(e.timestamp) : "—"} · <TxLink hash={e.txHash} /></span>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}

function EvidenceItem({ uri, party, trade, submittedAt, paidCommitment }: { uri: string; party: Address; trade: TradeSummary; submittedAt?: number; paidCommitment?: Hex }) {
  const { identity } = useEscrowX();
  const parsed = useMemo(() => parseEvidenceUri(uri), [uri]);
  const [opened, setOpened] = useState<{ commitment: Hex; key: Hex; mimeType?: string } | null>(null);
  const [file, setFile] = useState<{ url: string; name: string; isImage: boolean; text?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const role = same(party, trade.buyer) ? "Buyer" : same(party, trade.seller) ? "Seller" : "Unknown party";
  const forMe = !!parsed && !!identity && parsed.recipientPubkey === identity.publicKey;
  const matchesPaid = !!opened && !!paidCommitment && paidCommitment !== zeroHash && opened.commitment.toLowerCase() === paidCommitment.toLowerCase();

  async function decrypt(f: File) {
    if (!opened) return;
    setError(null);
    try {
      const plain = await decryptEvidence(new Uint8Array(await f.arrayBuffer()), keyFromHex(opened.key), opened.commitment);
      const type = opened.mimeType || "application/octet-stream";
      const url = URL.createObjectURL(new Blob([plain as BlobPart], { type }));
      const text = type.startsWith("text/") ? new TextDecoder().decode(plain).slice(0, 4000) : undefined;
      setFile({ url, name: f.name.replace(/\.enc$/, ""), isImage: type.startsWith("image/"), text });
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="action">
      <div className="row-between">
        <span className="small"><strong>{role}</strong> <Addr address={party} /></span>
        <span className="tiny faint">{submittedAt ? fmtTs(submittedAt) : ""}</span>
      </div>
      {!parsed ? (
        <p className="small danger-text">Not an EscrowX evidence record.</p>
      ) : !forMe ? (
        <p className="small muted">Sealed to another panelist ({parsed.recipientPubkey.slice(0, 10)}…). Only they can open it.</p>
      ) : !opened ? (
        <div>
          <Button size="sm" variant="primary" onClick={() => {
            try {
              setOpened(openEvidenceKey(identity!, parsed.senderPubkey, parsed.sealed));
            } catch (e) {
              setError(errorText(e));
            }
          }}>Open sealed key</Button>
        </div>
      ) : (
        <div className="stack-sm">
          <div className="small">
            File fingerprint <code>{shortHash(opened.commitment)}</code>{" "}
            {matchesPaid ? <Chip tone="accent">✓ same receipt the buyer committed when marking paid</Chip> : paidCommitment && paidCommitment !== zeroHash ? <Chip tone="warn">differs from the receipt committed at payment</Chip> : null}
          </div>
          {!file ? (
            <Field label="Encrypted file from the party" hint=".enc" help="The file is checked against the fingerprint before it's decrypted, so a swapped file is rejected.">
              <input className="file" type="file" onChange={(e) => e.target.files?.[0] && void decrypt(e.target.files[0])} />
            </Field>
          ) : (
            <div className="stack-sm">
              <Notice tone="ok">Decrypted and verified against the on-chain fingerprint.</Notice>
              {file.isImage && <img src={file.url} alt="Evidence" style={{ maxWidth: "100%", borderRadius: 8, border: "1px solid var(--border)" }} />}
              {file.text !== undefined && <pre className="inset small mono" style={{ padding: 12, margin: 0, whiteSpace: "pre-wrap" }}>{file.text}</pre>}
              <div><a className="btn btn-sm" href={file.url} download={file.name}>Download {file.name}</a></div>
            </div>
          )}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
