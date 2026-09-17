// Integration over a real WebSocket relay (in-process): discovery, forgery filtering, cancellation,
// live subscriptions and encrypted chat delivery.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import { OfferBook, TradeChat, buildCancelEvent, buildOfferEvent, parseOfferEvent, type ParsedOffer } from "../../src/index.js";
import { CHAIN_ID, party, signedOffer, terms } from "../support/fixtures.js";
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
    expect(offers.map((o) => o.offer.seller)).toEqual([ngn.account.address]);

    // Offers survive a relay going away: relay B alone still serves them.
    const onlyB = await new OfferBook([relayB.url], {}, pool).fetch({ chainId: CHAIN_ID, fiatCurrency: "KES" });
    expect(onlyB.offers).toHaveLength(1);
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
    expect((await received).offer.seller).toBe(seller.account.address);
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
