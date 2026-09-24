import { describe, expect, it } from "vitest";
import { buildReputation, completionRate, disputeRate, settled, statsFor } from "@/lib/v4/reputation";
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
