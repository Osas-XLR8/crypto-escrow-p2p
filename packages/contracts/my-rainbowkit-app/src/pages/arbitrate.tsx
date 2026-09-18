// src/pages/arbitrate.tsx — arbitration desk for licensed firms and their panelists.
//
// Reads and writes a firm's LicensedArbitratorAdapter directly. The firm admin manages the panel and assigns
// cases; the assigned panelist opens the sealed evidence and proposes a ruling; after the review period anyone
// can execute it. A ruling can only send the disputed trade's locked crypto to its buyer or back to its seller.

import Head from "next/head";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatEther, keccak256, toBytes, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { adapterKeyFromNostrPubkey, decryptEvidence, keyFromHex, openEvidenceKey, parseEvidenceUri } from "@escrowx/sdk";
import { useEscrowX } from "@/context/EscrowX";
import { IS_TESTNET, V4, arbitratorName } from "@/config/v4";
import { ConnectPrompt, Shell } from "@/components/Shell";
import { StateBadge } from "@/components/StateBadge";
import { Addr, Button, Card, Chip, CopyButton, Empty, Field, KV, Notice, errorText } from "@/components/ui";
import { MessagingGate } from "@/components/v4/MessagingGate";
import { useV4Trades } from "@/hooks/useV4Trades";
import { fmtDuration, fmtTs, shortAddr, shortHash } from "@/lib/format";
import { RULING_BUYER, RULING_SELLER, readCases, readFirm, readPanel, writeFirm, type CaseInfo, type FirmInfo } from "@/lib/v4/arbitration";
import { fmtToken } from "@/lib/v4/local";
import { V4State, type TradeSummary } from "@/lib/v4/tradeIndex";

const FIRMS = [V4.primaryArbitrator, V4.fallbackArbitrator] as const;
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export default function Arbitrate() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const trades = useV4Trades();
  const [firmAddr, setFirmAddr] = useState<Address>(FIRMS[0]);
  const [selected, setSelected] = useState<bigint | undefined>();

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

  const firm = desk.data?.firm;
  const isAdmin = same(address, firm?.admin);
  const isPanelist = !!desk.data?.panel.some((p) => same(p.panelist, address));
  const selectedCase = desk.data?.cases.find((c) => c.disputeId === selected) ?? desk.data?.cases[0];
  const tradeOf = (c: CaseInfo) => trades.trades.find((t) => t.tradeId === c.tradeId);

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
            {!isConnected ? <Chip>not connected</Chip> : isAdmin ? <Chip tone="accent">firm admin</Chip> : null}
            {isPanelist && <Chip tone="info">panelist</Chip>}
            {isConnected && !isAdmin && !isPanelist && <Chip>a visitor — read only</Chip>}
            {IS_TESTNET && <span className="faint">· On this test network the deployer runs both demo firms.</span>}
          </div>
        </Card>

        {desk.error && <Notice tone="error">{errorText(desk.error)}</Notice>}

        {!isConnected ? (
          <ConnectPrompt what="use the arbitration desk" />
        ) : firm ? (
          <div className="split split-trades">
            <div className="stack sticky">
              <FirmCard firm={firm} isAdmin={isAdmin} onChanged={() => void desk.refetch()} />
              <PanelCard firm={firm} panel={desk.data!.panel} isAdmin={isAdmin} onChanged={() => void desk.refetch()} />
            </div>
            <div className="stack">
              <Card flush title={<>Cases <span className="chip">{firm.caseCount}</span></>} sub="Disputes escalated to this firm by the escrow contract.">
                {desk.data!.cases.length === 0 ? (
                  <Empty title="No cases yet">A case appears here when both sides of a disputed trade have paid the arbitration fee.</Empty>
                ) : (
                  <div className="trade-list">
                    {desk.data!.cases.map((c) => {
                      const t = tradeOf(c);
                      return (
                        <button key={c.disputeId.toString()} className="trade-row" aria-current={selectedCase?.disputeId === c.disputeId} onClick={() => setSelected(c.disputeId)}>
                          <div className="row" style={{ gap: 8 }}>
                            <span className="mono strong">Case #{c.disputeId.toString()}</span>
                            <CaseStatus c={c} firm={firm} now={trades.chainNow} />
                          </div>
                          <span className="mono small">{t ? `${fmtToken(t.amount)} ${V4.tokenSymbol}` : ""}</span>
                          <div className="next">Trade #{c.tradeId.toString()} · {c.assignee === zeroAddress ? "unassigned" : `panelist ${shortAddr(c.assignee)}`}</div>
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
                  panel={desk.data!.panel}
                  isAdmin={isAdmin}
                  now={trades.chainNow}
                  onChanged={() => { void desk.refetch(); trades.refetch(); }}
                />
              )}
            </div>
          </div>
        ) : (
          <Card><div className="skeleton" style={{ width: "40%" }} /></Card>
        )}
      </Shell>
    </>
  );
}

// ─── Status ───────────────────────────────────────────────────────────────────

function caseStage(c: CaseInfo, firm: FirmInfo, now: number) {
  if (c.executed) return { label: c.proposedRuling === RULING_BUYER ? "Ruled: buyer" : "Ruled: seller", tone: "accent" as const };
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
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  async function run(label: string, fn: Parameters<typeof writeFirm>[3], args: readonly unknown[], ok: string) {
    if (!publicClient || !wallet) return;
    setBusy(label);
    setMessage(null);
    try {
      await writeFirm(publicClient as never, wallet as never, firm.address, fn, args);
      setMessage({ tone: "ok", text: ok });
      onChanged();
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }
  return { busy, message, run };
}

function FirmCard({ firm, isAdmin, onChanged }: { firm: FirmInfo; isAdmin: boolean; onChanged: () => void }) {
  const { busy, message, run } = useFirmWrite(firm, onChanged);
  return (
    <Card title={arbitratorName(firm.address)} sub="Set by the firm; the escrow reads the fee when a dispute starts.">
      <div className="stack-sm">
        <KV rows={[
          ["Contract", <Addr key="c" address={firm.address} />],
          ["Firm admin", <Addr key="a" address={firm.admin} />],
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
        {isAdmin && <p className="help">You administer this firm: you manage the panel, assign cases and can veto a ruling during its review period.</p>}
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
      </div>
    </Card>
  );
}

function PanelCard({ firm, panel, isAdmin, onChanged }: { firm: FirmInfo; panel: { panelist: Address; key: Hex }[]; isAdmin: boolean; onChanged: () => void }) {
  const { address, identity } = useEscrowX();
  const { busy, message, run } = useFirmWrite(firm, onChanged);
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
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
      </div>
    </Card>
  );
}

// ─── Case ─────────────────────────────────────────────────────────────────────

function CaseDetail({ firm, c, trade, panel, isAdmin, now, onChanged }: {
  firm: FirmInfo;
  c: CaseInfo;
  trade?: TradeSummary;
  panel: { panelist: Address; key: Hex }[];
  isAdmin: boolean;
  now: number;
  onChanged: () => void;
}) {
  const { address } = useEscrowX();
  const { busy, message, run } = useFirmWrite(firm, onChanged);
  const [assignTo, setAssignTo] = useState<string>("");
  const [ruling, setRuling] = useState<bigint | null>(null);
  const [note, setNote] = useState("");
  const [vetoNote, setVetoNote] = useState("");
  const isAssignee = same(c.assignee, address);
  const reviewEnds = c.proposedAt + firm.reviewPeriod;
  // After escalation the fallback firm owns the dispute; the escrow ignores rulings from the first firm.
  const escalation = trade?.events.find((e) => e.name === "Escalated");
  const movedAway = !!escalation && !same(escalation.args.fallbackArbitrator as string, firm.address);
  const tradeOpen = (!trade || trade.state === V4State.DISPUTED) && !movedAway;
  // A panelist can't rule on a trade they're part of; the contract enforces this too.
  const eligible = panel.filter((p) => !trade || (!same(p.panelist, trade.buyer) && !same(p.panelist, trade.seller)));
  const paidCommitment = trade?.events.find((e) => e.name === "PaymentMarked")?.args.evidenceCommitment as Hex | undefined;
  const evidence = (trade?.events ?? []).filter((e) => e.name === "Evidence" && same(e.args.arbitrator as string, firm.address));
  const stage = caseStage(c, firm, now);

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
            <Notice tone="warn">This firm missed its deadline and the case was escalated to {arbitratorName(escalation!.args.fallbackArbitrator as string)}. Nothing to decide here.</Notice>
          )}
          {!tradeOpen && !movedAway && !c.executed && (
            <Notice tone="info">This trade already closed without a ruling (one side conceded or it timed out). Nothing to decide.</Notice>
          )}

          <KV rows={[
            ["Assigned panelist", c.assignee === zeroAddress ? "—" : <Addr key="p" address={c.assignee} you={isAssignee} />],
            ["Proposed ruling", c.hasProposal || c.executed ? (c.proposedRuling === RULING_BUYER ? "Buyer — release the crypto" : "Seller — return the crypto") : "—"],
            ...(c.hasProposal && !c.executed ? [["Review ends", <span key="r" className="mono">{fmtTs(reviewEnds)}</span>] as [React.ReactNode, React.ReactNode]] : []),
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
              <p className="small muted">The review period is over with no veto. Anyone can execute it: the escrow then {c.proposedRuling === RULING_BUYER ? "releases the crypto to the buyer" : "returns the crypto to the seller"} and settles the fees (the loser&apos;s fee pays the firm).</p>
              <div>
                <Button variant="accent" busy={busy === "execute"} onClick={() => run("execute", "executeRuling", [c.disputeId], "Ruling executed on the escrow.")}>Execute ruling</Button>
              </div>
            </div>
          )}

          {message && <Notice tone={message.tone}>{message.text}</Notice>}
        </div>
      </Card>

      {isAssignee && (
        <Card title="Sealed evidence" sub="Only you can open these. Parties send you the encrypted files through the firm's case channel.">
          <MessagingGate reason="open evidence sealed to you">
            {evidence.length === 0 ? (
              <p className="small muted p0">Nothing submitted yet. Parties can seal evidence to you now that the case is assigned.</p>
            ) : (
              <div className="stack">
                {evidence.map((e) => (
                  <EvidenceItem key={`${e.txHash}-${e.logIndex}`} uri={e.args.evidence as string} party={e.args.party as Address} trade={trade!} submittedAt={e.timestamp} paidCommitment={paidCommitment} />
                ))}
              </div>
            )}
          </MessagingGate>
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
