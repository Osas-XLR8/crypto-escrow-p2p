import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools/pure";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  OfferEventError,
  buildCancelEvent,
  buildOfferEvent,
  createBinding,
  deriveNostrIdentity,
  hashTerms,
  nostrIdentityFromSignature,
  parseOfferEvent,
  signOffer,
  verifyBinding,
  type OfferRejection,
} from "../../src/index.js";
import { CHAIN_ID, ESCROW, USDT, party, signedOffer, terms } from "../support/fixtures.js";

async function expectRejected(p: Promise<unknown>, reason: OfferRejection) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof OfferEventError && e.reason === reason);
}

describe("wallet-derived Nostr identity", () => {
  it("is deterministic per wallet and differs across wallets", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const a = await deriveNostrIdentity(account, account.address);
    const b = await deriveNostrIdentity(account, account.address);
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.publicKey).toMatch(/^[0-9a-f]{64}$/);
    const other = privateKeyToAccount(generatePrivateKey());
    expect((await deriveNostrIdentity(other, other.address)).publicKey).not.toBe(a.publicKey);
  });

  it("never yields an invalid secret key", () => {
    for (const sig of ["0x00", `0x${"ff".repeat(65)}`, `0x${"00".repeat(65)}`] as const) {
      const id = nostrIdentityFromSignature(sig);
      expect(getPublicKey(id.secretKey)).toBe(id.publicKey);
    }
  });

  it("binds a Nostr key to a wallet, and detects tampering", async () => {
    const p = await party();
    expect(await verifyBinding(p.binding)).toBe(true);
    const other = await party();
    expect(await verifyBinding({ ...p.binding, nostrPubkey: other.identity.publicKey })).toBe(false);
    expect(await verifyBinding({ ...p.binding, address: other.account.address })).toBe(false);
    expect(await verifyBinding({ ...p.binding, issuedAt: p.binding.issuedAt + 1 })).toBe(false);
    await expect(createBinding(p.account, p.account.address, "not-hex")).rejects.toThrow();
  });
});

describe("offer events", () => {
  it("builds a NIP-69 order event that parses back exactly", async () => {
    const seller = await party();
    const signed = await signedOffer(seller);
    const event = buildOfferEvent({ ...signed, binding: seller.binding, identity: seller.identity });

    expect(event.kind).toBe(38383);
    const tags = Object.fromEntries(event.tags.map((t) => [t[0], t.slice(1)]));
    expect(tags.f).toEqual(["NGN"]);
    expect(tags.s).toEqual(["pending"]);
    expect(tags.pm).toEqual(["bank-transfer", "opay"]);
    expect(tags.network).toEqual([`eip155:${CHAIN_ID}`]);
    expect(event.content).not.toMatch(/account number|0123456789/i); // no bank details ever

    const parsed = await parseOfferEvent(event, { chainId: CHAIN_ID, escrow: ESCROW });
    expect(parsed.offer).toEqual(signed.offer);
    expect(parsed.terms).toEqual(signed.terms);
    expect(parsed.offerHash).toBe(tags.d![0]);
    expect(parsed.status).toBe("pending");
  });

  it("refuses to build inconsistent events", async () => {
    const seller = await party();
    const other = await party();
    const signed = await signedOffer(seller);
    expect(() => buildOfferEvent({ ...signed, terms: terms({ price: "1" }), binding: seller.binding, identity: seller.identity })).toThrow(/termsHash/);
    expect(() => buildOfferEvent({ ...signed, binding: other.binding, identity: seller.identity })).toThrow(/wallet/);
    expect(() => buildOfferEvent({ ...signed, binding: seller.binding, identity: other.identity })).toThrow(/Nostr key/);
  });

  it("rejects content tampered after signing", async () => {
    const seller = await party();
    const event = buildOfferEvent({ ...(await signedOffer(seller)), binding: seller.binding, identity: seller.identity });
    const tampered: Event = { ...event, content: event.content.replace("1600.50", "1.00") };
    await expectRejected(parseOfferEvent(tampered), "bad_nostr_signature");
  });

  it("re-checks signatures on clones of already-verified events (no cached-verification bypass)", async () => {
    const seller = await party();
    const event = buildOfferEvent({ ...(await signedOffer(seller)), binding: seller.binding, identity: seller.identity });
    await parseOfferEvent(event); // marks the original as verified inside nostr-tools
    const retagged = { ...event, tags: event.tags.map((t) => (t[0] === "s" ? ["s", "canceled"] : t)) };
    await expectRejected(parseOfferEvent(retagged), "bad_nostr_signature");
  });

  it("rejects a seller's offer republished by an impostor (message hijacking)", async () => {
    const seller = await party();
    const signed = await signedOffer(seller);
    const impostorKey = generateSecretKey();
    const genuine = buildOfferEvent({ ...signed, binding: seller.binding, identity: seller.identity });
    // Impostor copies the genuine content (valid offer + valid seller binding) under their own Nostr key.
    const copy = finalizeEvent({ kind: genuine.kind, tags: genuine.tags, content: genuine.content, created_at: genuine.created_at }, impostorKey);
    await expectRejected(parseOfferEvent(copy), "binding_mismatch");
  });

  it("rejects terms changed and re-signed by an impostor", async () => {
    const seller = await party();
    const signed = await signedOffer(seller);
    const genuine = buildOfferEvent({ ...signed, binding: seller.binding, identity: seller.identity });
    const body = JSON.parse(genuine.content);
    body.terms.price = "1.00";
    const forged = finalizeEvent({ kind: genuine.kind, tags: genuine.tags, content: JSON.stringify(body), created_at: genuine.created_at }, seller.identity.secretKey);
    await expectRejected(parseOfferEvent(forged), "terms_mismatch");
  });

  it("rejects offers signed by a different wallet than the seller field", async () => {
    const seller = await party();
    const mallory = await party();
    const signed = await signedOffer(seller);
    const malloryOffer = { ...signed.offer, seller: mallory.account.address };
    const badSig = await signOffer(seller.account, malloryOffer, CHAIN_ID, ESCROW); // signed by the wrong key
    const event = buildOfferEvent({ offer: malloryOffer, signature: badSig, terms: signed.terms, binding: mallory.binding, identity: mallory.identity });
    await expectRejected(parseOfferEvent(event), "bad_offer_signature");
  });

  it("rejects wrong network, wrong escrow, expired offers and mismatched tags", async () => {
    const seller = await party();
    const event = buildOfferEvent({ ...(await signedOffer(seller)), binding: seller.binding, identity: seller.identity });
    await expectRejected(parseOfferEvent(event, { chainId: 1 }), "wrong_network");
    await expectRejected(parseOfferEvent(event, { escrow: USDT }), "wrong_network");
    await expectRejected(parseOfferEvent(event, { now: Math.floor(Date.now() / 1000) + 2 * 86400 }), "expired");

    const badTags = finalizeEvent({ kind: event.kind, tags: event.tags.map((t) => (t[0] === "f" ? ["f", "USD"] : t)), content: event.content, created_at: event.created_at }, seller.identity.secretKey);
    await expectRejected(parseOfferEvent(badTags), "tag_mismatch");

    const junk = finalizeEvent({ kind: 38383, tags: [], content: "{not json", created_at: 1 }, seller.identity.secretKey);
    await expectRejected(parseOfferEvent(junk), "malformed_content");
  });

  it("produces a valid cancel event for the same offer", async () => {
    const seller = await party();
    const event = buildOfferEvent({ ...(await signedOffer(seller)), binding: seller.binding, identity: seller.identity, createdAt: 1000 });
    const parsed = await parseOfferEvent(event);
    const cancel = buildCancelEvent(parsed, seller.identity);
    const reparsed = await parseOfferEvent(cancel);
    expect(reparsed.status).toBe("canceled");
    expect(reparsed.offerHash).toBe(parsed.offerHash);
    expect(hashTerms(reparsed.terms)).toBe(parsed.offer.termsHash);
  });
});
