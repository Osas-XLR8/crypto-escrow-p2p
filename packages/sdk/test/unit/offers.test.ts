import { describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Hex } from "viem";
import {
  canonicalJson,
  createOffer,
  deserializeOffer,
  hashOffer,
  hashTerms,
  serializeOffer,
  verifyOfferSignature,
} from "../../src/index.js";
import { ARB_FALLBACK, ARB_PRIMARY, CHAIN_ID, ESCROW, USDT, party, signedOffer, terms } from "../support/fixtures.js";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe("terms", () => {
  it("hashes canonically regardless of key order", () => {
    const a = terms();
    const b = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(hashTerms(a)).toBe(hashTerms(b));
    expect(hashTerms(terms({ price: "1600.51" }))).not.toBe(hashTerms(a));
  });

  it("rejects invalid terms", () => {
    const base = { seller: USDT, token: USDT, minAmount: 1n, maxAmount: 2n, totalAmount: 3n, paymentWindow: 1800n, releaseWindow: 3600n, arbitrator: ARB_PRIMARY, fallbackArbitrator: ARB_FALLBACK, nonce: 0n, expiry: 1n };
    expect(() => createOffer({ ...base, terms: terms({ fiatCurrency: "naira" }) })).toThrow(/ISO 4217/);
    expect(() => createOffer({ ...base, terms: terms({ price: "0" }) })).toThrow(/price/);
    expect(() => createOffer({ ...base, terms: terms({ paymentMethods: [] }) })).toThrow(/payment method/);
  });
});

describe("offer construction", () => {
  it("enforces the same bounds as the contract", () => {
    const base = { seller: USDT, token: USDT, minAmount: 1n, maxAmount: 2n, totalAmount: 3n, paymentWindow: 1800n, releaseWindow: 3600n, arbitrator: ARB_PRIMARY, fallbackArbitrator: ARB_FALLBACK, nonce: 0n, expiry: 1n, terms: terms() };
    expect(() => createOffer({ ...base, minAmount: 0n })).toThrow();
    expect(() => createOffer({ ...base, minAmount: 3n })).toThrow();
    expect(() => createOffer({ ...base, maxAmount: 4n })).toThrow(/totalAmount/);
    expect(() => createOffer({ ...base, paymentWindow: 60n })).toThrow(/paymentWindow/);
    expect(() => createOffer({ ...base, releaseWindow: 2n * 86400n })).toThrow(/releaseWindow/);
    expect(() => createOffer({ ...base, fallbackArbitrator: ARB_PRIMARY.toLowerCase() as Hex })).toThrow(/fallback/);
    const o = createOffer(base);
    expect(o.termsHash).toBe(hashTerms(base.terms));
    expect(o.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(createOffer(base).salt).not.toBe(o.salt);
  });

  it("round-trips through JSON without losing bigints", () => {
    const o = createOffer({ seller: USDT, token: USDT, minAmount: 1n, maxAmount: 2n ** 200n, totalAmount: 2n ** 201n, paymentWindow: 1800n, releaseWindow: 3600n, arbitrator: ARB_PRIMARY, fallbackArbitrator: ARB_FALLBACK, nonce: 7n, expiry: 99n, terms: terms() });
    expect(deserializeOffer(JSON.parse(JSON.stringify(serializeOffer(o))))).toEqual(o);
    expect(() => deserializeOffer({ ...serializeOffer(o), minAmount: "1.5" })).toThrow();
    expect(() => deserializeOffer({ ...serializeOffer(o), seller: "0x123" })).toThrow();
  });
});

describe("offer signatures", () => {
  it("verifies the seller's EIP-712 signature", async () => {
    const seller = await party();
    const { offer, signature } = await signedOffer(seller);
    expect(await verifyOfferSignature(offer, signature, CHAIN_ID, ESCROW)).toBe(true);
  });

  it("rejects other signers, tampered offers, other chains and other escrows", async () => {
    const seller = await party();
    const { offer, signature } = await signedOffer(seller);
    const mallory = privateKeyToAccount(generatePrivateKey());
    const forged = await mallory.signTypedData({
      domain: { name: "EscrowX", version: "4", chainId: CHAIN_ID, verifyingContract: ESCROW },
      types: { Offer: [{ name: "seller", type: "address" }] },
      primaryType: "Offer",
      message: { seller: offer.seller },
    });
    expect(await verifyOfferSignature(offer, forged, CHAIN_ID, ESCROW)).toBe(false);
    expect(await verifyOfferSignature({ ...offer, maxAmount: offer.maxAmount + 1n }, signature, CHAIN_ID, ESCROW)).toBe(false);
    expect(await verifyOfferSignature(offer, signature, 1, ESCROW)).toBe(false);
    expect(await verifyOfferSignature(offer, signature, CHAIN_ID, USDT)).toBe(false);
  });

  it("rejects high-s signatures, exactly like the contract", async () => {
    const seller = await party();
    const { offer, signature } = await signedOffer(seller);
    const r = signature.slice(2, 66);
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = parseInt(signature.slice(130, 132), 16);
    const flipped = `0x${r}${(SECP256K1_N - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    expect(await verifyOfferSignature(offer, flipped, CHAIN_ID, ESCROW)).toBe(false);
  });

  it("uses the chain and escrow in the offer id", async () => {
    const seller = await party();
    const { offer } = await signedOffer(seller);
    expect(hashOffer(offer, CHAIN_ID, ESCROW)).not.toBe(hashOffer(offer, 1, ESCROW));
  });
});
