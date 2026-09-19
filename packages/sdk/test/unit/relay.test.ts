// Integration over a real WebSocket relay (in-process): discovery, forgery filtering, cancellation,
// live subscriptions and encrypted chat delivery.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { OfferBook, TradeChat, buildCancelEvent, buildOfferEvent, parseOfferEvent, type ParsedOffer } from "../../src/index.js";
import { CHAIN_ID, party, signedBuyOffer, signedOffer, terms } from "../support/fixtures.js";
import { startTestRelay, type TestRelay } from "../support/testRelay.js";

let relayA: TestRelay;
let relayB: TestRelay;
let pool: SimplePool;

beforeAll(async () => {
  [relayA, relayB] = await Promise.all([startTestRelay(), startTestRelay()]);
  pool = new SimplePool();
});

afterAll(async () => {
  pool.destroy();
  await Promise.all([relayA.close(), relayB.close()]);
});

describe("OfferBook over relays", () => {
  it("publishes to every relay and discovers verified offers by currency", async () => {
    const book = new OfferBook([relayA.url, relayB.url], {}, pool);
    const ngn = await party();
    const kes = await party();

    const ngnEvent = buildOfferEvent({ ...(await signedOffer(ngn)), binding: ngn.binding, identity: ngn.identity });
    const kesEvent = buildOfferEvent({ ...(await signedOffer(kes, terms({ fiatCurrency: "KES", price: "129" }))), binding: kes.binding, identity: kes.identity });

    expect((await book.publish(ngnEvent)).every((r) => r.ok)).toBe(true);
    await book.publish(kesEvent);

    const { offers, rejected } = await book.fetch({ chainId: CHAIN_ID, fiatCurrency: "NGN" });
    expect(rejected).toEqual([]);
    expect(offers.map((o) => o.maker)).toEqual([ngn.account.address]);

    // Offers survive a relay going away: relay B alone still serves them.
    const onlyB = await new OfferBook([relayB.url], {}, pool).fetch({ chainId: CHAIN_ID, fiatCurrency: "KES" });
    expect(onlyB.offers).toHaveLength(1);
  });

  it("queries relays by indexed tags only and ignores other deployments", async () => {
    const book = new OfferBook([relayA.url], {}, pool);
    // NIP-01 relays only index single-letter tags; anything else matches nothing on real relays.
    expect(Object.keys(book.filter({ chainId: CHAIN_ID, fiatCurrency: "INR" })).filter((k) => k.startsWith("#") && k.length !== 2)).toEqual([]);

    const here = await party();
    const elsewhere = await party();
    await book.publish(buildOfferEvent({ ...(await signedOffer(here, terms({ fiatCurrency: "INR", price: "88.1" }))), binding: here.binding, identity: here.identity }));
    const otherChain = await signedOffer(elsewhere, terms({ fiatCurrency: "INR", price: "88", chainId: 84532 }));
    await book.publish(buildOfferEvent({ ...otherChain, binding: elsewhere.binding, identity: elsewhere.identity }));

    const { offers, rejected } = await book.fetch({ chainId: CHAIN_ID, fiatCurrency: "INR" });
    expect(offers.map((o) => o.maker)).toEqual([here.account.address]);
    expect(rejected).toEqual([]); // another deployment's offer is not a forgery
  });

  it("separates buy offers from sell offers by side", async () => {
    const book = new OfferBook([relayA.url], {}, pool);
    const seller = await party();
    const buyer = await party();
    await book.publish(buildOfferEvent({ ...(await signedOffer(seller, terms({ fiatCurrency: "UGX", price: "3700" }))), binding: seller.binding, identity: seller.identity }));
    await book.publish(buildOfferEvent({ ...(await signedBuyOffer(buyer, terms({ fiatCurrency: "UGX", price: "3650" }))), binding: buyer.binding, identity: buyer.identity }));

    const buys = await book.fetch({ chainId: CHAIN_ID, fiatCurrency: "UGX", side: "buy" });
    expect(buys.offers.map((o) => [o.side, o.maker])).toEqual([["buy", buyer.account.address]]);
    const mine = await book.fetch({ chainId: CHAIN_ID, maker: buyer.account.address });
    expect(mine.offers).toHaveLength(1);
  });

  it("filters out forged offers instead of trusting the relay", async () => {
    const book = new OfferBook([relayA.url], {}, pool);
    const seller = await party();
    const genuine = buildOfferEvent({ ...(await signedOffer(seller, terms({ fiatCurrency: "GHS", price: "15" }))), binding: seller.binding, identity: seller.identity });
    const hijack = finalizeEvent({ kind: genuine.kind, tags: genuine.tags, content: genuine.content, created_at: genuine.created_at + 1 }, generateSecretKey());
    await book.publish(genuine);
    await book.publish(hijack);

    const { offers, rejected } = await book.fetch({ chainId: CHAIN_ID, fiatCurrency: "GHS" });
    expect(offers).toHaveLength(1);
    expect(offers[0]!.event.pubkey).toBe(seller.identity.publicKey);
    expect(rejected).toEqual([{ eventId: hijack.id, reason: "binding_mismatch" }]);
  });

  it("hides offers once the seller publishes a cancellation", async () => {
    const book = new OfferBook([relayA.url], {}, pool);
    const seller = await party();
    const event = buildOfferEvent({ ...(await signedOffer(seller, terms({ fiatCurrency: "ZAR", price: "18" }))), binding: seller.binding, identity: seller.identity, createdAt: Math.floor(Date.now() / 1000) - 10 });
    await book.publish(event);
    expect((await book.fetch({ chainId: CHAIN_ID, fiatCurrency: "ZAR" })).offers).toHaveLength(1);

    await book.publish(buildCancelEvent(await parseOfferEvent(event), seller.identity));
    expect((await book.fetch({ chainId: CHAIN_ID, fiatCurrency: "ZAR" })).offers).toHaveLength(0);
  });

  it("streams new offers to live subscribers", async () => {
    const book = new OfferBook([relayA.url], {}, pool);
    const seller = await party();
    const received = new Promise<ParsedOffer>((resolve) => {
      const close = book.subscribe({ chainId: CHAIN_ID, fiatCurrency: "BRL" }, (o) => {
        close();
        resolve(o);
      });
    });
    await new Promise((r) => setTimeout(r, 200)); // let the subscription register
    await book.publish(buildOfferEvent({ ...(await signedOffer(seller, terms({ fiatCurrency: "BRL", price: "5.4" }))), binding: seller.binding, identity: seller.identity }));
    expect((await received).maker).toBe(seller.account.address);
  });
});

describe("TradeChat over relays", () => {
  it("delivers encrypted payment details to the buyer only", async () => {
    const seller = await party();
    const buyer = await party();
    const eve = await party();

    const sellerChat = new TradeChat(pool, [relayA.url, relayB.url], seller.identity);
    const buyerChat = new TradeChat(pool, [relayA.url, relayB.url], buyer.identity);

    await buyerChat.send(seller.identity.publicKey, { type: "hello", tradeId: "42", binding: buyer.binding });
    const [hello] = await sellerChat.inbox(42n);
    expect(hello?.message.type).toBe("hello");

    await sellerChat.send(buyer.identity.publicKey, { type: "payment_details", tradeId: "42", method: "bank-transfer", instructions: "Zenith 2200110033" });
    await sellerChat.send(buyer.identity.publicKey, { type: "text", tradeId: "43", text: "other trade" });

    const inbox = await buyerChat.inbox(42n);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.message).toMatchObject({ type: "payment_details", instructions: "Zenith 2200110033" });

    expect(await new TradeChat(pool, [relayA.url], eve.identity).inbox(42n)).toEqual([]);
    expect(relayA.events.some((e) => e.content.includes("2200110033"))).toBe(false); // relay never sees plaintext
  });

  it("keeps both sides of the conversation, and streams new messages live", async () => {
    const seller = await party();
    const buyer = await party();
    const sellerChat = new TradeChat(pool, [relayA.url], seller.identity);
    const buyerChat = new TradeChat(pool, [relayA.url], buyer.identity);

    const live: string[] = [];
    let ready = false;
    const close = sellerChat.subscribe((m) => live.push(`${m.mine ? "me" : "them"}:${m.message.type}`), () => (ready = true));
    await new Promise((r) => setTimeout(r, 200));
    expect(ready).toBe(true);

    await buyerChat.send(seller.identity.publicKey, { type: "payment_sent", tradeId: "77", reference: "OPY-1234" });
    await new Promise((r) => setTimeout(r, 1100)); // message timestamps have one-second resolution
    await sellerChat.send(buyer.identity.publicKey, { type: "text", tradeId: "77", text: "Got it, checking my app" });
    await new Promise((r) => setTimeout(r, 200));
    close();
    expect(live).toEqual(["them:payment_sent", "me:text"]);

    // The buyer sees their own message (sealed copy) and the seller's reply.
    const thread = await buyerChat.inbox(77n);
    expect(thread.map((m) => [m.mine, m.message.type])).toEqual([[true, "payment_sent"], [false, "text"]]);
    expect(relayA.events.some((e) => e.content.includes("OPY-1234"))).toBe(false);
  });

  it("fails loudly when no relay accepts the message", async () => {
    const a = await party();
    const b = await party();
    relayB.setRejectAll(true);
    try {
      await expect(new TradeChat(pool, [relayB.url], a.identity).send(b.identity.publicKey, { type: "text", tradeId: "1", text: "hi" })).rejects.toThrow(/not accepted/);
    } finally {
      relayB.setRejectAll(false);
    }
  });
});
