// src/components/v4/TradeChatPanel.tsx — end-to-end encrypted trade messages over Nostr.
//
// Safety rules enforced here:
//   • A message counts as "from the seller/buyer" only if its sender key has a valid wallet binding for
//     the counterparty address recorded ON-CHAIN for this trade (or is the seller key verified from the offer).
//   • Payment details from anyone else are shown with a loud warning.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TradeChat, verifyHello, type ReceivedMessage } from "@escrowx/sdk";
import type { Address } from "viem";
import { useEscrowX } from "@/context/EscrowX";
import { RELAYS } from "@/config/v4";
import { Button, Card, Field, Notice, errorText } from "@/components/ui";
import { MessagingGate } from "@/components/v4/MessagingGate";
import { findSellerKey, recallPeerKey, rememberPeerKey } from "@/lib/v4/local";

type Outgoing = Parameters<TradeChat["send"]>[1];
/** Messages this tab sent. Gift wraps are addressed to the recipient only, so our own copies aren't on relays. */
interface SentMessage {
  at: number;
  message: Outgoing;
}

export function TradeChatPanel({ tradeId, seller, buyer }: { tradeId: bigint; seller: Address; buyer: Address }) {
  const { address, identity } = useEscrowX();
  const isSeller = !!address && address.toLowerCase() === seller.toLowerCase();
  const isBuyer = !!address && address.toLowerCase() === buyer.toLowerCase();
  if (!isSeller && !isBuyer) return null;

  return (
    <Card title="Private chat" sub="End-to-end encrypted. Relays can't read it or see who's talking.">
      <MessagingGate reason={isBuyer ? "receive the seller's payment details" : "send your payment details to the buyer"}>
        {identity && <ChatBody tradeId={tradeId} counterparty={isSeller ? buyer : seller} role={isSeller ? "seller" : "buyer"} />}
      </MessagingGate>
    </Card>
  );
}

function ChatBody({ tradeId, counterparty, role }: { tradeId: bigint; counterparty: Address; role: "seller" | "buyer" }) {
  const { pool, book, identity, binding } = useEscrowX();
  const chat = useMemo(() => (pool && identity ? new TradeChat(pool, RELAYS, identity) : null), [pool, identity]);
  const [peerKey, setPeerKey] = useState<string | null>(() => recallPeerKey(tradeId));
  const [helloSent, setHelloSent] = useState(false);
  const [sent, setSent] = useState<SentMessage[]>([]);
  const [text, setText] = useState("");
  const [details, setDetails] = useState({ method: "", instructions: "", payeeName: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inbox = useQuery({
    queryKey: ["inbox", identity?.publicKey, tradeId.toString()],
    enabled: !!chat,
    refetchInterval: 5000,
    queryFn: async () => {
      const messages = await chat!.inbox(tradeId);
      // Which sender keys provably belong to the on-chain counterparty?
      const verified = new Set<string>();
      for (const m of messages) if (m.message.type === "hello" && (await verifyHello(m, counterparty))) verified.add(m.from);
      return { messages, verified };
    },
  });

  // Buyer: the seller's key comes from their verified offer (remembered at purchase, or found on relays).
  const sellerKeyQuery = useQuery({
    queryKey: ["sellerKey", counterparty, tradeId.toString()],
    enabled: role === "buyer" && !peerKey && !!book,
    queryFn: async () => {
      const key = await findSellerKey(book!, counterparty);
      if (key) {
        rememberPeerKey(tradeId, key);
        setPeerKey(key);
      }
      return key;
    },
  });

  const verified = inbox.data?.verified ?? new Set<string>();
  // Seller learns the buyer's key only from a verified hello.
  const targetKey = role === "buyer" ? peerKey : [...verified][0] ?? null;
  const trusted = (from: string) => verified.has(from) || (role === "buyer" && from === peerKey);
  const received = inbox.data?.messages ?? [];
  const counterpartyConnected = received.some((m) => trusted(m.from));

  async function send(label: string, message: Outgoing) {
    if (!chat || !targetKey || !binding) return;
    setBusy(label);
    setError(null);
    try {
      if (!helloSent) {
        await chat.send(targetKey, { type: "hello", tradeId: tradeId.toString(), binding });
        setHelloSent(true);
      }
      if (message.type !== "hello") {
        await chat.send(targetKey, message);
        setSent((s) => [...s, { at: Math.floor(Date.now() / 1000), message }]);
      }
      await inbox.refetch();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  // Received + sent, oldest first.
  const thread: { at: number; mine: boolean; m?: ReceivedMessage; out?: Outgoing }[] = [
    ...received.filter((m) => m.message.type !== "hello").map((m) => ({ at: m.createdAt, mine: false, m })),
    ...sent.map((s) => ({ at: s.at, mine: true, out: s.message })),
  ].sort((a, b) => a.at - b.at);
  const counterpartyLabel = role === "buyer" ? "Seller" : "Buyer";

  return (
    <div className="stack">
      <div className="row small">
        {role === "seller" ? (
          targetKey ? <span className="chip chip-accent">✓ Buyer verified against the trade on-chain</span> : <span className="chip">Waiting for the buyer to connect…</span>
        ) : peerKey ? (
          <span className="chip chip-accent">✓ Seller key verified from their signed offer</span>
        ) : (
          <span className="chip chip-warn">{sellerKeyQuery.isFetching ? "Looking up the seller's key…" : "Seller's messaging key not found on relays"}</span>
        )}
        {counterpartyConnected && role === "buyer" && <span className="chip">connected</span>}
      </div>

      {role === "seller" && !targetKey && (
        <p className="help">Payment details can only be sent to a chat key the buyer&apos;s wallet has signed for. This updates automatically.</p>
      )}

      {role === "buyer" && peerKey && !helloSent && received.length === 0 && (
        <div className="action action-primary">
          <h3>Get the seller&apos;s payment details</h3>
          <p className="small muted">Sends your verified chat key to the seller so they can reply privately.</p>
          <div>
            <Button variant="primary" busy={busy === "hello"} onClick={() => void send("hello", { type: "hello", tradeId: tradeId.toString(), binding: binding! })}>
              Request payment details
            </Button>
          </div>
        </div>
      )}

      {thread.length > 0 && (
        <div className="messages">
          {thread.map((x, i) =>
            x.m ? <MessageBubble key={`r-${i}`} m={x.m} trusted={trusted(x.m.from)} counterpartyLabel={counterpartyLabel} /> : <SentBubble key={`s-${i}`} at={x.at} message={x.out!} />
          )}
        </div>
      )}
      {role === "buyer" && helloSent && received.every((m) => m.message.type === "hello") && (
        <p className="help">Request sent. The seller&apos;s details will appear here — this updates every few seconds.</p>
      )}

      {role === "seller" && targetKey && (
        <div className="action action-primary">
          <h3>Send your payment details</h3>
          <p className="small muted">Encrypted to the verified buyer only. Never post these anywhere public.</p>
          <div className="fields">
            <Field label="Method"><input className="input" value={details.method} onChange={(e) => setDetails((d) => ({ ...d, method: e.target.value }))} placeholder="e.g. Opay" /></Field>
            <Field label="Account name"><input className="input" value={details.payeeName} onChange={(e) => setDetails((d) => ({ ...d, payeeName: e.target.value }))} placeholder="Name on the account" /></Field>
          </div>
          <Field label="Account number / details">
            <input className="input mono" value={details.instructions} onChange={(e) => setDetails((d) => ({ ...d, instructions: e.target.value }))} placeholder="Bank + account number, or mobile money number" />
          </Field>
          <div>
            <Button variant="primary" disabled={details.instructions.trim().length < 4} busy={busy === "details"}
              onClick={async () => {
                const ok = await send("details", {
                  type: "payment_details",
                  tradeId: tradeId.toString(),
                  method: details.method.trim() || "Bank transfer",
                  instructions: details.instructions.trim(),
                  ...(details.payeeName.trim() ? { payeeName: details.payeeName.trim() } : {}),
                });
                if (ok) setDetails({ method: "", instructions: "", payeeName: "" });
              }}>
              Send payment details
            </Button>
          </div>
        </div>
      )}

      {targetKey && (
        <form className="row" style={{ flexWrap: "nowrap" }} onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          const body = text.trim();
          setText("");
          void send("text", { type: "text", tradeId: tradeId.toString(), text: body });
        }}>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message the ${counterpartyLabel.toLowerCase()}`} aria-label="Message" />
          <Button type="submit" disabled={!text.trim()} busy={busy === "text"}>Send</Button>
        </form>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

const hhmm = (ts: number) => new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function SentBubble({ at, message }: { at: number; message: Outgoing }) {
  return (
    <div className="msg mine">
      <div className="msg-meta">You · {hhmm(at)} · <span className="accent">encrypted ✓</span></div>
      {message.type === "payment_details" ? (
        <div className="small">
          Payment details sent: <span className="mono strong">{message.instructions}</span>
          <span className="faint"> · {message.method}{message.payeeName ? ` · ${message.payeeName}` : ""}</span>
        </div>
      ) : message.type === "text" ? (
        <div className="small" style={{ whiteSpace: "pre-wrap" }}>{message.text}</div>
      ) : null}
    </div>
  );
}

function MessageBubble({ m, trusted, counterpartyLabel }: { m: ReceivedMessage; trusted: boolean; counterpartyLabel: string }) {
  const sender = trusted ? (
    <span className="accent">✓ {counterpartyLabel} · wallet-verified</span>
  ) : (
    <span className="danger-text">⚠ Unverified sender — not your trade counterparty</span>
  );
  if (m.message.type === "payment_details") {
    return (
      <div className={`pay-card${trusted ? "" : " untrusted"}`}>
        <div className="msg-meta">{sender} · {hhmm(m.createdAt)}</div>
        <span className="eyebrow">Pay to</span>
        <div className="pay-number">{m.message.instructions}</div>
        <div className="small muted">{m.message.method}{m.message.payeeName ? ` · ${m.message.payeeName}` : ""}</div>
        {trusted ? (
          <div className="small warn-text">Pay only from an account in your own name, then tap “I&apos;ve paid”.</div>
        ) : (
          <div className="small danger-text strong">Do not pay these details.</div>
        )}
      </div>
    );
  }
  if (m.message.type === "text") {
    return (
      <div className="msg">
        <div className="msg-meta">{sender} · {hhmm(m.createdAt)}</div>
        <div className="small" style={{ whiteSpace: "pre-wrap" }}>{m.message.text}</div>
      </div>
    );
  }
  return null;
}
