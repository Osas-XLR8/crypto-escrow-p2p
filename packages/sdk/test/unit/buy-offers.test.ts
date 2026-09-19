// Buy offers: buyer-signed "I want to buy" offers that sellers fill.

import { describe, expect, it } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import {
  OfferEventError,
  buildOfferEvent,
  deserializeOffer,
  hashOffer,
  offerMaker,
  offerSide,
  parseOfferEvent,
  serializeOffer,
  signOffer,
  verifyOfferSignature,
  type Offer,
} from "../../src/index.js";
import { CHAIN_ID, ESCROW, party, signedBuyOffer, terms } from "../support/fixtures.js";

describe("buy offers", () => {
  it("are signed and verified for the buyer", async () => {
    const buyer = await party();
    const { offer, signature } = await signedBuyOffer(buyer);
    expect(offerSide(offer)).toBe("buy");
    expect(offerMaker(offer)).toBe(buyer.account.address);
    expect(await verifyOfferSignature(offer, signature, CHAIN_ID, ESCROW)).toBe(true);

    const impostor = await party();
    const forged = await signOffer(impostor.account, offer, CHAIN_ID, ESCROW);
    expect(await verifyOfferSignature(offer, forged, CHAIN_ID, ESCROW)).toBe(false);
  });

  it("never share a hash or signature with a sell offer over the same fields", async () => {
    const buyer = await party();
    const { offer: buy, signature: buySig } = await signedBuyOffer(buyer);
    const { buyer: maker, ...fields } = buy;
    const asSell: Offer = { seller: maker, ...fields };

    expect(hashOffer(asSell, CHAIN_ID, ESCROW)).not.toBe(hashOffer(buy, CHAIN_ID, ESCROW));
    expect(await verifyOfferSignature(asSell, buySig, CHAIN_ID, ESCROW)).toBe(false);
    const sellSig = await signOffer(buyer.account, asSell, CHAIN_ID, ESCROW);
    expect(await verifyOfferSignature(buy, sellSig, CHAIN_ID, ESCROW)).toBe(false);
  });

  it("round-trip through JSON as buy offers", async () => {
    const { offer } = await signedBuyOffer(await party());
    const back = deserializeOffer(JSON.parse(JSON.stringify(serializeOffer(offer))));
    expect(back).toEqual(offer);
    expect(offerSide(back)).toBe("buy");
    expect(() => deserializeOffer({ ...serializeOffer(offer), seller: offer.buyer })).toThrow(/exactly one/);
  });

  it("publish as k=buy events that parse back with the buyer as maker", async () => {
    const buyer = await party();
    const signed = await signedBuyOffer(buyer, terms({ fiatCurrency: "KES", price: "129.5", paymentMethods: ["M-Pesa"] }));
    const event = buildOfferEvent({ ...signed, binding: buyer.binding, identity: buyer.identity });
    expect(event.tags.find((t) => t[0] === "k")?.[1]).toBe("buy");

    const parsed = await parseOfferEvent(event, { chainId: CHAIN_ID, escrow: ESCROW });
    expect(parsed.side).toBe("buy");
    expect(parsed.maker).toBe(buyer.account.address);
    expect(parsed.offer).toEqual(signed.offer);
  });

  it("reject an event whose k tag disagrees with the signed offer", async () => {
    const buyer = await party();
    const event = buildOfferEvent({ ...(await signedBuyOffer(buyer)), binding: buyer.binding, identity: buyer.identity });
    // Re-signed by the same key, so only the side mismatch is wrong.
    const relabelled = finalizeEvent(
      { kind: event.kind, created_at: event.created_at, content: event.content, tags: event.tags.map((t) => (t[0] === "k" ? ["k", "sell"] : t)) },
      buyer.identity.secretKey
    );
    await expect(parseOfferEvent(relabelled)).rejects.toSatisfy((e: unknown) => e instanceof OfferEventError && e.reason === "tag_mismatch");
  });

  it("reject a buy offer republished under someone else's messaging key", async () => {
    const buyer = await party();
    const thief = await party();
    const signed = await signedBuyOffer(buyer);
    expect(() => buildOfferEvent({ ...signed, binding: thief.binding, identity: thief.identity })).toThrow(/different wallet/);
  });
});
