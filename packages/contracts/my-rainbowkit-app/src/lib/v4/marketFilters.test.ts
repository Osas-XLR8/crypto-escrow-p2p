import { describe, expect, it } from "vitest";
import type { ParsedOffer } from "@escrowx/sdk";
import { ESTABLISHED_TRADES, filterOffers, offerFitsAmount, parseFiatAmount, sortOffers } from "@/lib/v4/marketFilters";
import type { PartyStats } from "@/lib/v4/reputation";

const DECIMALS = 6;
const tok = (n: number) => BigInt(Math.round(n * 10 ** DECIMALS));

function offer(over: {
  maker?: string;
  price?: string;
  min?: number;
  max?: number;
  methods?: string[];
} = {}): ParsedOffer {
  return {
    maker: over.maker ?? "0xaaaa",
    offerHash: `${over.maker ?? "0xaaaa"}:${over.price ?? "1600"}`,
    terms: { price: over.price ?? "1600", paymentMethods: over.methods ?? ["Bank transfer"] },
    offer: { minAmount: tok(over.min ?? 10), maxAmount: tok(over.max ?? 500) },
  } as unknown as ParsedOffer;
}

function stats(over: Partial<PartyStats> = {}): PartyStats {
  return {
    address: "0x", total: 0, open: 0, completed: 0, cancelled: 0, arbitrated: 0,
    disputed: 0, lost: 0, volume: 0n, releaseSeconds: [], asSeller: 0, asBuyer: 0,
    ...over,
  };
}

describe("parseFiatAmount", () => {
  it("reads what people actually type", () => {
    expect(parseFiatAmount("50,000")).toBe(50000);
    expect(parseFiatAmount("₦50 000")).toBe(50000);
    expect(parseFiatAmount("1500.75")).toBe(1500.75);
  });

  it("treats empty, zero and nonsense as no filter at all", () => {
    for (const v of ["", "   ", "abc", "0", "-5"]) expect(parseFiatAmount(v)).toBeNull();
  });
});

describe("offerFitsAmount", () => {
  // At ₦1,600/token, ₦50,000 is 31.25 tokens.
  const o = offer({ price: "1600", min: 10, max: 500 });

  it("accepts an amount inside the offer's per-trade limits", () => {
    expect(offerFitsAmount(o, 50_000, DECIMALS)).toBe(true);
  });

  it("rejects an amount below the minimum", () => {
    expect(offerFitsAmount(o, 5_000, DECIMALS)).toBe(false); // 3.1 tokens, under the 10 minimum
  });

  it("rejects an amount above the maximum", () => {
    expect(offerFitsAmount(o, 900_000, DECIMALS)).toBe(false); // 562 tokens, over the 500 cap
  });

  it("respects what is actually left, not just the advertised cap", () => {
    // 31.25 tokens wanted, 500 advertised, but only 20 left on the offer.
    expect(offerFitsAmount(o, 50_000, DECIMALS, tok(20))).toBe(false);
    expect(offerFitsAmount(o, 50_000, DECIMALS, tok(100))).toBe(true);
  });

  it("rejects an offer with an unusable price rather than dividing by it", () => {
    expect(offerFitsAmount(offer({ price: "0" }), 50_000, DECIMALS)).toBe(false);
    expect(offerFitsAmount(offer({ price: "nonsense" }), 50_000, DECIMALS)).toBe(false);
  });
});

describe("filterOffers", () => {
  const opay = offer({ maker: "0xopay", methods: ["Opay", "Bank transfer"] });
  const bank = offer({ maker: "0xbank", methods: ["Bank transfer"] });
  const all = [opay, bank];
  const noStats = () => undefined;

  it("keeps everything when nothing is asked", () => {
    expect(filterOffers(all, { wantFiat: "", methods: [], establishedOnly: false }, { tokenDecimals: DECIMALS, statsOf: noStats })).toHaveLength(2);
  });

  it("matches an offer that accepts any of the chosen methods", () => {
    const out = filterOffers(all, { wantFiat: "", methods: ["Opay"], establishedOnly: false }, { tokenDecimals: DECIMALS, statsOf: noStats });
    expect(out).toEqual([opay]);
  });

  it("hides traders below the established threshold, including ones with no record at all", () => {
    const statsOf = (a: string) => (a === "0xbank" ? stats({ total: ESTABLISHED_TRADES }) : stats({ total: 3 }));
    const out = filterOffers(all, { wantFiat: "", methods: [], establishedOnly: true }, { tokenDecimals: DECIMALS, statsOf });
    expect(out).toEqual([bank]);
    const none = filterOffers(all, { wantFiat: "", methods: [], establishedOnly: true }, { tokenDecimals: DECIMALS, statsOf: noStats });
    expect(none).toHaveLength(0);
  });

  it("combines filters rather than choosing between them", () => {
    const statsOf = () => stats({ total: 50 });
    const out = filterOffers(
      [opay, bank],
      { wantFiat: "50,000", methods: ["Opay"], establishedOnly: true },
      { tokenDecimals: DECIMALS, statsOf }
    );
    expect(out).toEqual([opay]);
  });
});

describe("sortOffers", () => {
  const cheap = offer({ maker: "0xcheap", price: "1500" });
  const mid = offer({ maker: "0xmid", price: "1600" });
  const dear = offer({ maker: "0xdear", price: "1700" });
  const makers = (offers: ParsedOffer[]) => offers.map((o) => o.maker);

  it("puts the best price first for whichever side is asking", () => {
    expect(makers(sortOffers([dear, cheap, mid], "price", true, () => undefined))).toEqual(["0xcheap", "0xmid", "0xdear"]);
    expect(makers(sortOffers([dear, cheap, mid], "price", false, () => undefined))).toEqual(["0xdear", "0xmid", "0xcheap"]);
  });

  it("ranks by completion, best first", () => {
    const statsOf = (a: string) =>
      a === "0xcheap" ? stats({ total: 10, completed: 5 }) : a === "0xmid" ? stats({ total: 10, completed: 9 }) : stats({ total: 10, completed: 7 });
    expect(makers(sortOffers([cheap, mid, dear], "completion", true, statsOf))).toEqual(["0xmid", "0xdear", "0xcheap"]);
  });

  it("ranks by release time, fastest first", () => {
    const statsOf = (a: string) =>
      a === "0xcheap" ? stats({ releaseSeconds: [600] }) : a === "0xmid" ? stats({ releaseSeconds: [60] }) : stats({ releaseSeconds: [300] });
    expect(makers(sortOffers([cheap, mid, dear], "release", true, statsOf))).toEqual(["0xmid", "0xdear", "0xcheap"]);
  });

  it("sends traders with no history to the back, never the front", () => {
    // The whole point: an unknown wallet must not outrank a known one by having nothing to show.
    const statsOf = (a: string) => (a === "0xdear" ? stats({ total: 10, completed: 6 }) : undefined);
    expect(makers(sortOffers([cheap, mid, dear], "completion", true, statsOf))).toEqual(["0xdear", "0xcheap", "0xmid"]);
  });

  it("falls back to price when reputations tie, so the list still reads as a market", () => {
    const statsOf = () => stats({ total: 10, completed: 10 });
    expect(makers(sortOffers([dear, cheap, mid], "completion", true, statsOf))).toEqual(["0xcheap", "0xmid", "0xdear"]);
  });

  it("does not mutate the array it was given", () => {
    const input = [dear, cheap, mid];
    sortOffers(input, "price", true, () => undefined);
    expect(makers(input)).toEqual(["0xdear", "0xcheap", "0xmid"]);
  });
});
