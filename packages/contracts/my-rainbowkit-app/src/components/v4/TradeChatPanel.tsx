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
import { Button, Card, Label, Notice, colors, errorText, inputStyle } from "@/components/ui";
import { MessagingGate } from "@/components/v4/MessagingGate";
import { findSellerKey, recallPeerKey, rememberPeerKey } from "@/lib/v4/local";

export function TradeChatPanel({ tradeId, seller, buyer }: { tradeId: bigint; seller: Address; buyer: Address }) {
  const { address, identity } = useEscrowX();
  const isSeller = !!address && address.toLowerCase() === seller.toLowerCase();
  const isBuyer = !!address && address.toLowerCase() === buyer.toLowerCase();
  if (!isSeller && !isBuyer) return null;

  return (
    <Card title="SECURE TRADE CHAT">
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
  const [text, setText] = useState("");
  const [details, setDetails] = useState({ method: "bank-transfer", instructions: "", payeeName: "" });
  const [busy, setBusy] = useState(false);
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

  async function send(message: Parameters<TradeChat["send"]>[1]) {
    if (!chat || !targetKey || !binding) return;
    setBusy(true);
    setError(null);
    try {
      if (!helloSent) {
        await chat.send(targetKey, { type: "hello", tradeId: tradeId.toString(), binding });
        setHelloSent(true);
      }
      if (message.type !== "hello") await chat.send(targetKey, message);
      await inbox.refetch();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const messages = inbox.data?.messages ?? [];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {role === "seller" && !targetKey && (
        <Notice tone="info">Waiting for the buyer to open the chat. Payment details can only be sent to a key the buyer&apos;s wallet has signed for.</Notice>
      )}
      {role === "buyer" && !peerKey && (
        <Notice tone={sellerKeyQuery.isFetching ? "info" : "warn"}>
          {sellerKeyQuery.isFetching ? "Looking up the seller's verified messaging key on relays…" : "Couldn't find the seller's messaging key on the configured relays."}
        </Notice>
      )}
      {role === "buyer" && peerKey && !helloSent && messages.length === 0 && (
        <div>
          <Button variant="blue" solid disabled={busy} onClick={() => void send({ type: "hello", tradeId: tradeId.toString(), binding: binding! })}>
            {busy ? "Sending…" : "Request payment details"}
          </Button>
        </div>
      )}

      <div style={{ display: "grid", gap: 8, maxHeight: 320, overflowY: "auto" }}>
        {messages.filter((m) => m.message.type !== "hello").map((m, i) => <MessageBubble key={`${m.from}-${m.createdAt}-${i}`} m={m} trusted={trusted(m.from)} counterpartyLabel={role === "buyer" ? "Seller" : "Buyer"} />)}
        {messages.length > 0 && messages.every((m) => m.message.type === "hello") && (
          <div style={{ fontSize: 12, color: colors.muted }}>{role === "seller" ? "✓ Buyer verified and connected." : "Connected."}</div>
        )}
      </div>

      {role === "seller" && targetKey && (
        <div style={{ display: "grid", gap: 8, padding: 12, borderRadius: 10, background: "#060d1a", border: `1px solid ${colors.border}` }}>
          <Label hint="sent encrypted to the verified buyer only">YOUR PAYMENT DETAILS</Label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
            <input value={details.method} onChange={(e) => setDetails((d) => ({ ...d, method: e.target.value }))} placeholder="Method" style={inputStyle} />
            <input value={details.payeeName} onChange={(e) => setDetails((d) => ({ ...d, payeeName: e.target.value }))} placeholder="Account name" style={inputStyle} />
          </div>
          <input value={details.instructions} onChange={(e) => setDetails((d) => ({ ...d, instructions: e.target.value }))} placeholder="Bank + account number, or mobile money number" style={inputStyle} />
          <div>
            <Button variant="primary" solid disabled={busy || details.instructions.trim().length < 4}
              onClick={() => void send({ type: "payment_details", tradeId: tradeId.toString(), method: details.method.trim(), instructions: details.instructions.trim(), ...(details.payeeName.trim() ? { payeeName: details.payeeName.trim() } : {}) })}>
              {busy ? "Sending…" : "Send payment details"}
            </Button>
          </div>
        </div>
      )}

      {targetKey && (
        <div style={{ display: "flex", gap: 8 }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message" style={{ ...inputStyle, flex: 1 }}
            onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) { void send({ type: "text", tradeId: tradeId.toString(), text: text.trim() }); setText(""); } }} />
          <Button disabled={busy || !text.trim()} onClick={() => { void send({ type: "text", tradeId: tradeId.toString(), text: text.trim() }); setText(""); }}>Send</Button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div style={{ fontSize: 11, color: colors.faint }}>
        End-to-end encrypted and gift-wrapped (NIP-17). Relays can&apos;t read messages or see who is talking to whom. You only see messages sent to you.
      </div>
    </div>
  );
}

function MessageBubble({ m, trusted, counterpartyLabel }: { m: ReceivedMessage; trusted: boolean; counterpartyLabel: string }) {
  const time = new Date(m.createdAt * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const header = (
    <div style={{ fontSize: 11, color: trusted ? colors.greenText : colors.redText, marginBottom: 4 }}>
      {trusted ? `✓ ${counterpartyLabel} (wallet-verified)` : "⚠ Unverified sender — not the trade counterparty"} · {time}
    </div>
  );
  if (m.message.type === "payment_details") {
    return (
      <div style={{ padding: 12, borderRadius: 10, background: trusted ? "#052e16" : "#1a0808", border: `1px solid ${trusted ? "#10b98150" : "#ef444470"}` }}>
        {header}
        <div style={{ fontSize: 11, color: colors.muted, letterSpacing: "0.08em" }}>PAYMENT DETAILS</div>
        <div style={{ fontSize: 15, color: colors.strong, fontWeight: 600, margin: "4px 0" }}>{m.message.instructions}</div>
        <div style={{ fontSize: 12, color: "#94a3b8" }}>{m.message.method}{m.message.payeeName ? ` · ${m.message.payeeName}` : ""}</div>
        {!trusted && <div style={{ marginTop: 6, fontSize: 12, color: colors.redText }}>Do not pay these details.</div>}
        {trusted && <div style={{ marginTop: 6, fontSize: 12, color: colors.amberText }}>Pay only from an account in your own name, then mark the trade as paid.</div>}
      </div>
    );
  }
  if (m.message.type === "text") {
    return (
      <div style={{ padding: "8px 12px", borderRadius: 10, background: "#0f172a", border: `1px solid ${colors.border}` }}>
        {header}
        <div style={{ fontSize: 13, color: colors.text, whiteSpace: "pre-wrap" }}>{m.message.text}</div>
      </div>
    );
  }
  return null;
}
