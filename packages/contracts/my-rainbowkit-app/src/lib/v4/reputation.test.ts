import { describe, expect, it } from "vitest";
import { DAY, buildReputation, completionRate, confidence, disputeAlarm, disputeRate, releaseTime, settled, statsFor } from "@/lib/v4/reputation";
import { CANCEL_REASONS, RELEASE_REASONS, V4State, type Hex, type TradeSummary } from "@/lib/v4/tradeIndex";

const SELLER = "0x1111111111111111111111111111111111111111" as Hex;
const BUYER = "0x2222222222222222222222222222222222222222" as Hex;

let nextId = 0n;

function trade(over: Partial<TradeSummary> = {}): TradeSummary {
  return {
    tradeId: ++nextId,
    seller: SELLER,
    buyer: BUYER,
    amount: 100n,
    arbitrator: "0x3333333333333333333333333333333333333333" as Hex,
    termsHash: "0x00" as Hex,
    state: V4State.RELEASED,
    outcome: RELEASE_REASONS[0],
    openedAt: 1_700_000_000,
    paymentDeadline: 1_700_000_900,
    escalated: false,
    lastBlock: 1n,
    events: [],
    ...over,
  };
}

const of = (trades: TradeSummary[], who: Hex) => statsFor(buildReputation(trades), who)!;

describe("buildReputation", () => {
  it("counts a clean release for both sides", () => {
    const s = of([trade()], SELLER);
    expect(s.total).toBe(1);
    expect(s.completed).toBe(1);
    expect(s.open).toBe(0);
    expect(s.asSeller).toBe(1);
    expect(completionRate(s)).toBe(1);
    expect(of([trade()], BUYER).asBuyer).toBe(1);
  });

  it("does not count an open trade as finished, and takes no rate over it", () => {
    const s = of([trade({ state: V4State.LOCKED, outcome: undefined })], SELLER);
    expect(s.total).toBe(1);
    expect(s.open).toBe(1);
    expect(settled(s)).toBe(0);
    expect(completionRate(s)).toBeUndefined();
  });

  it("separates an arbitrated release from one the seller chose", () => {
    const s = of([trade({ outcome: RELEASE_REASONS[1] })], SELLER);
    expect(s.completed).toBe(0);
    expect(s.arbitrated).toBe(1);
    expect(s.lost).toBe(1);
    expect(completionRate(s)).toBe(0);
  });

  it("blames the side that walked away from the dispute fee", () => {
    const seller = of([trade({ outcome: RELEASE_REASONS[2] })], SELLER);
    expect(seller.lost).toBe(1);
    const buyer = of([trade({ state: V4State.CANCELLED, outcome: CANCEL_REASONS[5] })], BUYER);
    expect(buyer.lost).toBe(1);
    expect(of([trade({ state: V4State.CANCELLED, outcome: CANCEL_REASONS[5] })], SELLER).lost).toBe(0);
  });

  it("counts a plain cancellation against nobody", () => {
    const s = of([trade({ state: V4State.CANCELLED, outcome: CANCEL_REASONS[0] })], SELLER);
    expect(s.cancelled).toBe(1);
    expect(s.lost).toBe(0);
    expect(s.arbitrated).toBe(0);
    expect(completionRate(s)).toBe(0);
  });

  it("remembers a dispute even when the trade settled afterwards", () => {
    const disputedThenReleased = trade({
      events: [{ name: "DisputeRequested", blockNumber: 1n, logIndex: 0, txHash: "0x0" as Hex, args: {} }],
      outcome: RELEASE_REASONS[1],
    });
    const s = of([disputedThenReleased, trade(), trade()], SELLER);
    expect(s.disputed).toBe(1);
    expect(s.total).toBe(3);
    expect(disputeRate(s)).toBeCloseTo(1 / 3);
    expect(completionRate(s)).toBeCloseTo(2 / 3);
  });

  it("keeps volume to trades that actually paid out", () => {
    const s = of([trade({ amount: 500n }), trade({ state: V4State.CANCELLED, outcome: CANCEL_REASONS[0], amount: 900n })], SELLER);
    expect(s.volume).toBe(500n);
  });

  it("dates a party from their earliest trade", () => {
    const s = of([trade({ openedAt: 1_700_000_500 }), trade({ openedAt: 1_600_000_000 })], SELLER);
    expect(s.firstSeen).toBe(1_600_000_000);
    expect(s.lastSeen).toBe(1_700_000_500);
  });

  it("has nothing to say about an address that never traded", () => {
    expect(statsFor(buildReputation([trade()]), "0x9999999999999999999999999999999999999999")).toBeUndefined();
  });
});

// ─── Release time ─────────────────────────────────────────────────────────────

const paidThenReleased = (paidAt: number, releasedAt: number, over: Partial<TradeSummary> = {}) =>
  trade({
    events: [
      { name: "PaymentMarked", blockNumber: 1n, logIndex: 0, txHash: "0x00" as Hex, timestamp: paidAt, args: {} },
      { name: "Released", blockNumber: 2n, logIndex: 0, txHash: "0x01" as Hex, timestamp: releasedAt, args: {} },
    ],
    ...over,
  });

describe("releaseTime", () => {
  it("is undefined until a seller has released something themselves", () => {
    expect(releaseTime(of([trade({ state: V4State.LOCKED })], SELLER))).toBeUndefined();
  });

  it("measures paid → released, and says how many trades it is drawn from", () => {
    const s = of([paidThenReleased(1000, 1180), paidThenReleased(2000, 2060)], SELLER);
    expect(releaseTime(s)).toEqual({ seconds: 120, from: 2 });
  });

  it("takes the median, so one seller who went to bed does not define the rest", () => {
    const s = of([paidThenReleased(0, 60), paidThenReleased(0, 120), paidThenReleased(0, 40_000)], SELLER);
    expect(releaseTime(s)!.seconds).toBe(120);
  });

  it("ignores arbitrated releases — a firm's ruling is not the seller's speed", () => {
    const s = of([paidThenReleased(0, 90, { outcome: RELEASE_REASONS[1] })], SELLER);
    expect(releaseTime(s)).toBeUndefined();
  });

  it("counts a same-second release, which is the fastest measurement there is", () => {
    expect(releaseTime(of([paidThenReleased(5000, 5000)], SELLER))).toEqual({ seconds: 0, from: 1 });
  });

  it("is only recorded for the seller, who is the one doing the releasing", () => {
    expect(releaseTime(of([paidThenReleased(0, 90)], BUYER))).toBeUndefined();
  });
});

// ─── Confidence ───────────────────────────────────────────────────────────────

const NOW = 1_700_000_000;
const clean = (n: number, over: Partial<TradeSummary> = {}) => Array.from({ length: n }, () => trade(over));

describe("confidence", () => {
  it("is none with nothing settled", () => {
    expect(confidence(of([trade({ state: V4State.LOCKED })], SELLER), NOW)).toBe("none");
  });

  it("is thin for a wallet that only looks good because it is new", () => {
    // 30 spotless trades, all today, small amounts: the record a self-dealer builds in an afternoon.
    const s = of(clean(30, { openedAt: NOW - 3600, amount: 1_000_000n }), SELLER);
    expect(confidence(s, NOW)).toBe("thin");
  });

  it("needs trades, volume and age together before it calls anything strong", () => {
    const s = of(clean(25, { openedAt: NOW - 60 * DAY, amount: 500_000_000n }), SELLER);
    expect(confidence(s, NOW)).toBe("strong");
  });

  it("is capped by the weakest of the three", () => {
    // Old and heavy, but only two trades to show for it.
    const s = of(clean(2, { openedAt: NOW - 400 * DAY, amount: 50_000_000_000n }), SELLER);
    expect(confidence(s, NOW)).toBe("thin");
  });
});

// ─── Dispute alarm ────────────────────────────────────────────────────────────

describe("disputeAlarm", () => {
  const disputed = (over: Partial<TradeSummary> = {}) =>
    trade({ events: [{ name: "DisputeRequested", blockNumber: 1n, logIndex: 0, txHash: "0x00" as Hex, args: {} }], ...over });

  it("stays quiet on too few trades to mean anything", () => {
    expect(disputeAlarm(of([disputed(), trade()], SELLER)).level).toBe("none");
  });

  it("warns once a quarter of a real history ends in dispute", () => {
    const s = of([...clean(6), disputed(), disputed()], SELLER);
    expect(disputeAlarm(s).level).toBe("warn");
  });

  it("escalates when most trades end in dispute", () => {
    const s = of([...clean(2), disputed(), disputed(), disputed()], SELLER);
    expect(disputeAlarm(s).level).toBe("severe");
  });
});
