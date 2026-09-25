import { describe, expect, it } from "vitest";
import * as nip59 from "nostr-tools/nip59";
import { getEventHash } from "nostr-tools/pure";
import {
  adapterKeyFromNostrPubkey,
  decryptEvidence,
  encryptEvidence,
  keyFromHex,
  keyToHex,
  nostrPubkeyFromAdapterKey,
  openEvidenceKey,
  sealEvidenceKey,
  TradeChat,
  unwrapTradeMessage,
  verifyHello,
  wrapTradeMessage,
} from "../../src/index.js";
import { party } from "../support/fixtures.js";

describe("encrypted trade chat", () => {
  it("delivers payment details only to the intended recipient", async () => {
    const seller = await party();
    const buyer = await party();
    const eve = await party();

    const wrap = wrapTradeMessage(seller.identity, buyer.identity.publicKey, {
      type: "payment_details",
      tradeId: "7",
      method: "bank-transfer",
      instructions: "GTBank 0123456789",
      payeeName: "Ada Obi",
    });

    // What a relay sees: an ephemeral author, no plaintext, only the recipient tag.
    expect(wrap.kind).toBe(1059);
    expect(wrap.pubkey).not.toBe(seller.identity.publicKey);
    expect(wrap.content).not.toContain("0123456789");
    expect(JSON.stringify(wrap)).not.toContain(seller.identity.publicKey);

    const received = unwrapTradeMessage(buyer.identity, wrap);
    expect(received?.from).toBe(seller.identity.publicKey);
    expect(received?.message).toMatchObject({ type: "payment_details", instructions: "GTBank 0123456789" });

    expect(unwrapTradeMessage(eve.identity, wrap)).toBeNull();
    expect(unwrapTradeMessage(seller.identity, wrap)).toBeNull();
  });

  it("cannot be forged to appear from another sender", async () => {
    const seller = await party();
    const buyer = await party();
    const mallory = await party();
    // Mallory builds a rumor claiming the seller's pubkey, but can only seal it with her own key.
    const rumor = { kind: 14, pubkey: seller.identity.publicKey, created_at: Math.floor(Date.now() / 1000), tags: [["p", buyer.identity.publicKey]], content: JSON.stringify({ escrowx: 1, type: "payment_details", tradeId: "7", method: "bank", instructions: "SCAM 999" }) };
    const forged = nip59.createWrap(nip59.createSeal({ ...rumor, id: getEventHash(rumor) }, mallory.identity.secretKey, buyer.identity.publicKey), buyer.identity.publicKey);
    expect(unwrapTradeMessage(buyer.identity, forged)).toBeNull();
  });

  it("rejects malformed messages at send time", async () => {
    const a = await party();
    const b = await party();
    expect(() => wrapTradeMessage(a.identity, b.identity.publicKey, { type: "text", tradeId: "abc", text: "hi" })).toThrow();
    expect(() => wrapTradeMessage(a.identity, b.identity.publicKey, { type: "text", tradeId: "1", text: "x".repeat(5000) })).toThrow();
  });

  it("verifies a hello comes from the on-chain counterparty", async () => {
    const buyer = await party();
    const seller = await party();
    const mallory = await party();

    const hello = unwrapTradeMessage(seller.identity, wrapTradeMessage(buyer.identity, seller.identity.publicKey, { type: "hello", tradeId: "3", binding: buyer.binding }))!;
    expect(await verifyHello(hello, buyer.account.address)).toBe(true);
    expect(await verifyHello(hello, mallory.account.address)).toBe(false); // not the trade's buyer

    // Mallory replays the buyer's (public) binding from her own Nostr key.
    const replay = unwrapTradeMessage(seller.identity, wrapTradeMessage(mallory.identity, seller.identity.publicKey, { type: "hello", tradeId: "3", binding: buyer.binding }))!;
    expect(await verifyHello(replay, buyer.account.address)).toBe(false);
  });
});

describe("encrypted evidence", () => {
  const receipt = new TextEncoder().encode("NIP session 000013250917123456789012345678 ₦320,100.00 → Ada Obi");

  it("encrypts, commits and decrypts", async () => {
    const ev = await encryptEvidence(receipt);
    expect(Buffer.from(ev.ciphertext).includes(Buffer.from("Ada Obi"))).toBe(false);
    expect(ev.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await decryptEvidence(ev.ciphertext, ev.key, ev.commitment)).toEqual(receipt);
    expect((await encryptEvidence(receipt)).commitment).not.toBe(ev.commitment); // fresh key + iv each time
  });

  it("detects swapped evidence, tampering and wrong keys", async () => {
    const ev = await encryptEvidence(receipt);
    const other = await encryptEvidence(new TextEncoder().encode("a different receipt"));
    await expect(decryptEvidence(other.ciphertext, other.key, ev.commitment)).rejects.toThrow(/commitment/);

    const tampered = ev.ciphertext.slice();
    tampered[20]! ^= 0xff;
    await expect(decryptEvidence(tampered, ev.key)).rejects.toThrow();
    await expect(decryptEvidence(ev.ciphertext, other.key)).rejects.toThrow();
  });

  it("seals the key so only the assigned arbitrator can open it", async () => {
    const buyer = await party();
    const arbitrator = await party();
    const eve = await party();
    const ev = await encryptEvidence(receipt);

    const sealed = sealEvidenceKey(buyer.identity, arbitrator.identity.publicKey, { tradeId: "9", commitment: ev.commitment, key: keyToHex(ev.key), uri: "ipfs://bafy..." });
    expect(sealed).not.toContain(keyToHex(ev.key).slice(2));

    const opened = openEvidenceKey(arbitrator.identity, buyer.identity.publicKey, sealed);
    expect(await decryptEvidence(ev.ciphertext, keyFromHex(opened.key), opened.commitment)).toEqual(receipt);

    expect(() => openEvidenceKey(eve.identity, buyer.identity.publicKey, sealed)).toThrow();
  });

  it("encodes arbitrator keys for the adapter's bytes field", async () => {
    const arbitrator = await party();
    const onchain = adapterKeyFromNostrPubkey(arbitrator.identity.publicKey);
    expect(onchain).toMatch(/^0x[0-9a-f]{64}$/);
    expect(nostrPubkeyFromAdapterKey(onchain)).toBe(arbitrator.identity.publicKey);
    expect(() => nostrPubkeyFromAdapterKey("0x04aa01")).toThrow();
  });
});

describe("sending a message", () => {
  /** A pool whose relays behave however the test says: resolve, reject, or never answer at all. */
  const poolWith = (...behaviours: ("ok" | "fail" | "hang")[]) =>
    ({
      publish: () =>
        behaviours.map((b) =>
          b === "ok"
            ? Promise.resolve("ok")
            : b === "fail"
              ? Promise.reject(new Error("relay said no"))
              : new Promise<string>(() => {})
        ),
    }) as never;

  it("counts the relays that accepted it", async () => {
    const me = await party();
    const them = await party();
    const chat = new TradeChat(poolWith("ok", "fail", "ok"), ["a", "b", "c"], me.identity, 50);
    await expect(chat.send(them.identity.publicKey, { type: "text", tradeId: "1", text: "hi" })).resolves.toBe(2);
  });

  it("does not wait forever on a relay that never answers", async () => {
    const me = await party();
    const them = await party();
    const chat = new TradeChat(poolWith("hang", "ok"), ["a", "b"], me.identity, 50);
    const started = Date.now();
    await expect(chat.send(them.identity.publicKey, { type: "text", tradeId: "1", text: "hi" })).resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("says so when nothing got through, instead of hanging", async () => {
    const me = await party();
    const them = await party();
    const chat = new TradeChat(poolWith("hang", "fail"), ["a", "b"], me.identity, 50);
    await expect(chat.send(them.identity.publicKey, { type: "text", tradeId: "1", text: "hi" })).rejects.toThrow(/no relay accepted/i);
  });
});
