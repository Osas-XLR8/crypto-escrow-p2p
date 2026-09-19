// src/components/v4/TradeChatPanel.tsx — the private, end-to-end encrypted conversation for one trade.
//
// Messages from anyone other than the verified counterparty are shown with a loud warning and never as
// trusted payment details. On-chain milestones (locked, paid, released, disputes) are woven into the thread
// straight from the contract, so both sides see the same authoritative status next to the conversation.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReceivedMessage } from "@escrowx/sdk";
import { useEscrowX } from "@/context/EscrowX";
import { useMessages } from "@/context/Messages";
import { Button, Card, Field, Notice, TxLink, errorText } from "@/components/ui";
import { MessagingGate } from "@/components/v4/MessagingGate";
import { CHAT_MILESTONES, describeEvent } from "@/lib/v4/describe";
import type { TradeSummary } from "@/lib/v4/tradeIndex";
import { V4State } from "@/lib/v4/tradeIndex";

export function TradeChatPanel({ summary }: { summary: TradeSummary }) {
  const { address, identity } = useEscrowX();
  const isSeller = !!address && address.toLowerCase() === summary.seller.toLowerCase();
  const isBuyer = !!address && address.toLowerCase() === summary.buyer.toLowerCase();
  if (!isSeller && !isBuyer) return null;

  return (
    <Card
      title={<>Chat <span className="chip chip-accent" title="Only you and the other party can read this">🔒 end-to-end encrypted</span></>}
      sub="Private between you and the other party. Relays can't read it or see who's talking."
    >
      <MessagingGate reason={isBuyer ? "chat with the seller and receive their payment details" : "chat with the buyer and share your payment details"}>
        {identity && <ChatBody summary={summary} role={isSeller ? "seller" : "buyer"} />}
      </MessagingGate>
    </Card>
  );
}

type Item =
  | { kind: "msg"; at: number; m: ReceivedMessage }
  | { kind: "chain"; at: number; text: string; txHash: string };

function ChatBody({ summary, role }: { summary: TradeSummary; role: "seller" | "buyer" }) {
  const messages = useMessages();
  const id = summary.tradeId;
  const peer = messages.peer(id);
  const thread = messages.thread(id);
  const other = role === "buyer" ? "seller" : "buyer";
  const [text, setText] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [details, setDetails] = useState({ method: "", instructions: "", payeeName: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const items: Item[] = useMemo(() => {
    const msgs: Item[] = thread.filter((m) => m.message.type !== "hello").map((m) => ({ kind: "msg", at: m.createdAt, m }));
    const chain: Item[] = summary.events
      .filter((e) => CHAT_MILESTONES.has(e.name))
      .map((e) => ({ kind: "chain", at: e.timestamp ?? 0, text: describeEvent(e), txHash: e.txHash }));
    return [...msgs, ...chain].sort((a, b) => a.at - b.at);
  }, [thread, summary.events]);

  // Keep the newest message in view and mark the conversation read while it's on screen.
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
    messages.markRead(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, id]);

  const open = summary.state === V4State.LOCKED || summary.state === V4State.PAID || summary.state === V4State.FEE_PENDING || summary.state === V4State.DISPUTED;
  const sharedDetails = thread.some((m) => m.mine && m.message.type === "payment_details");
  const gotDetails = thread.some((m) => !m.mine && m.message.type === "payment_details" && messages.trusted(id, m.from));
  const otherTalked = thread.some((m) => !m.mine && messages.trusted(id, m.from));

  async function send(label: string, message: Parameters<typeof messages.send>[1]) {
    setBusy(label);
    setError(null);
    try {
      await messages.send(id, message);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="row small">
        {peer ? (
          <span className="chip chip-accent" title={peer.via === "offer" ? "Their key is bound to their wallet in their signed offer" : "They proved their key belongs to the wallet on this trade"}>
            ✓ {otherTalked ? `Connected with the ${other}` : `The ${other}'s key is verified`} · wallet-verified
          </span>
        ) : (
          <span className="chip">Waiting for the {other} to open the chat…</span>
        )}
        {!messages.ready && <span className="chip">loading messages…</span>}
      </div>

      <div className="chat" ref={scroller} aria-live="polite">
        {items.length === 0 && <div className="empty small">No messages yet. Say hello — only the {other} can read it.</div>}
        {items.map((it, i) =>
          it.kind === "chain" ? (
            <div key={`c-${i}`} className="chat-system" title="Recorded on-chain">
              <span className="chip chip-info">⛓ on-chain</span>
              <span>{it.text}</span>
              <span className="faint">{hhmm(it.at)} · <TxLink hash={it.txHash} /></span>
            </div>
          ) : (
            <Bubble key={it.m.id} m={it.m} trusted={it.m.mine || messages.trusted(id, it.m.from)} other={other} />
          )
        )}
      </div>

      {/* Seller: share where to pay, once, early in the trade. */}
      {role === "seller" && open && summary.state === V4State.LOCKED && (
        sharedDetails && !showDetails ? (
          <button className="btn btn-ghost btn-sm" style={{ justifySelf: "start" }} onClick={() => setShowDetails(true)}>Send updated payment details</button>
        ) : (
          <div className="action action-primary">
            <h3>Tell the buyer where to pay</h3>
            <p className="small muted">Encrypted to the verified buyer only. Never post these anywhere public.</p>
            <div className="fields">
              <Field label="Method"><input className="input" value={details.method} onChange={(e) => setDetails((d) => ({ ...d, method: e.target.value }))} placeholder="e.g. Opay" /></Field>
              <Field label="Account name"><input className="input" value={details.payeeName} onChange={(e) => setDetails((d) => ({ ...d, payeeName: e.target.value }))} placeholder="Name on the account" /></Field>
            </div>
            <Field label="Account number / details">
              <input className="input mono" value={details.instructions} onChange={(e) => setDetails((d) => ({ ...d, instructions: e.target.value }))} placeholder="Bank + account number, or mobile money number" />
            </Field>
            <div className="row">
              <Button variant="primary" disabled={!peer || details.instructions.trim().length < 4} busy={busy === "details"}
                title={!peer ? "Available once the buyer's key is verified" : undefined}
                onClick={async () => {
                  const ok = await send("details", {
                    type: "payment_details",
                    method: details.method.trim() || "Bank transfer",
                    instructions: details.instructions.trim(),
                    ...(details.payeeName.trim() ? { payeeName: details.payeeName.trim() } : {}),
                  });
                  if (ok) {
                    setDetails({ method: "", instructions: "", payeeName: "" });
                    setShowDetails(false);
                  }
                }}>
                Send payment details
              </Button>
              {sharedDetails && <Button variant="ghost" size="sm" onClick={() => setShowDetails(false)}>Cancel</Button>}
            </div>
          </div>
        )
      )}
      {role === "buyer" && summary.state === V4State.LOCKED && !gotDetails && (
        <p className="help">The seller&apos;s payment details will appear here, encrypted to you. You&apos;ll get a notification.</p>
      )}

      <form className="row" style={{ flexWrap: "nowrap" }} onSubmit={async (e) => {
        e.preventDefault();
        const body = text.trim();
        if (!body) return;
        if (await send("text", { type: "text", text: body })) setText("");
      }}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={peer ? `Message the ${other}…` : `Waiting for the ${other}…`} aria-label="Message" disabled={!peer} maxLength={4000} />
        <Button type="submit" variant="primary" disabled={!peer || !text.trim()} busy={busy === "text"}>Send</Button>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

const hhmm = (ts: number) => (ts ? new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");

function Bubble({ m, trusted, other }: { m: ReceivedMessage; trusted: boolean; other: string }) {
  const who = m.mine ? "You" : trusted ? `${other[0]!.toUpperCase()}${other.slice(1)}` : "⚠ Unverified sender";
  const meta = (
    <div className="msg-meta">
      <span className={m.mine ? "" : trusted ? "accent" : "danger-text"}>{who}</span>
      <span>· {hhmm(m.createdAt)}</span>
    </div>
  );

  if (m.message.type === "payment_details") {
    return (
      <div className={`msg ${m.mine ? "mine" : ""}`} style={{ maxWidth: "100%" }}>
        {meta}
        <div className={`pay-card${!m.mine && !trusted ? " untrusted" : ""}`}>
          <span className="eyebrow">{m.mine ? "You shared where to pay" : "Pay to"}</span>
          <div className="pay-number">{m.message.instructions}</div>
          <div className="small muted">{m.message.method}{m.message.payeeName ? ` · ${m.message.payeeName}` : ""}</div>
          {!m.mine && (trusted ? (
            <div className="small warn-text">Pay only from an account in your own name, then tap “I&apos;ve paid”.</div>
          ) : (
            <div className="small danger-text strong">Not from your trade counterparty. Do not pay these details.</div>
          ))}
        </div>
      </div>
    );
  }
  if (m.message.type === "payment_sent") {
    return (
      <div className={`msg ${m.mine ? "mine" : ""}`}>
        {meta}
        <div className="small"><strong>I&apos;ve paid.</strong>{m.message.reference ? <> Reference: <span className="mono">{m.message.reference}</span></> : null}</div>
        {!m.mine && trusted && <div className="tiny warn-text">Check your own banking app before releasing.</div>}
      </div>
    );
  }
  if (m.message.type === "text") {
    return (
      <div className={`msg ${m.mine ? "mine" : ""}${!m.mine && !trusted ? " untrusted" : ""}`}>
        {meta}
        <div className="small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.message.text}</div>
      </div>
    );
  }
  return null;
}
