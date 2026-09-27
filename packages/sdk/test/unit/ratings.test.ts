// A rating is only worth showing if it can only come from someone who actually traded. These tests are
// about who may speak, which is the only thing a rating system can honestly guarantee.

import { describe, expect, it } from "vitest";
import { verifyMessage, verifyTypedData } from "viem";
import {
  RatingEventError,
  buildRatingEvent,
  parseRatingEvent,
  ratingAddress,
  summariseRatings,
  type ParsedRating,
  type Rating,
  type RatingRejection,
} from "../../src/index.js";
import { CHAIN_ID, ESCROW, party } from "../support/fixtures.js";

/**
 * A stand-in chain client: getTrade answers with whatever the test set up, and signature verification is
 * done locally. The real client checks signatures on-chain so that contract wallets can validate their own;
 * for an EOA the answer is the same either way, which is what makes the substitution honest.
 */
function chainWith(trade: { seller: string; buyer: string; state: number } | Error) {
  return {
    readContract: async () => {
      if (trade instanceof Error) throw trade;
      return trade;
    },
    verifyMessage: (args: Parameters<typeof verifyMessage>[0]) => verifyMessage(args),
    verifyTypedData: (args: Parameters<typeof verifyTypedData>[0]) => verifyTypedData(args),
  } as never;
}

const RELEASED = 5;
const LOCKED = 1;

async function setup(over: Partial<Rating> = {}) {
  const rater = await party();
  const subject = await party();
  const rating: Rating = {
    score: 1,
    tag: "fast release",
    tradeId: 7n,
    chainId: CHAIN_ID,
    escrow: ESCROW,
    subject: subject.account.address,
    rater: rater.account.address,
    ...over,
  };
  const event = buildRatingEvent({ rating, binding: rater.binding, identity: rater.identity });
  return { rater, subject, rating, event };
}

async function expectRejected(p: Promise<unknown>, reason: RatingRejection) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof RatingEventError && e.reason === reason);
}

describe("rating events", () => {
  it("accepts a rating from one party of a finished trade about the other", async () => {
    const { rater, subject, event } = await setup();
    const parsed = await parseRatingEvent(event, {
      chainId: CHAIN_ID,
      escrow: ESCROW,
      publicClient: chainWith({ seller: subject.account.address, buyer: rater.account.address, state: RELEASED }),
    });
    expect(parsed.score).toBe(1);
    expect(parsed.tag).toBe("fast release");
    expect(parsed.tradeId).toBe(7n);
  });

  it("refuses a rating from someone who was not in the trade", async () => {
    const { subject, event } = await setup();
    const stranger = await party();
    await expectRejected(
      parseRatingEvent(event, {
        chainId: CHAIN_ID,
        publicClient: chainWith({ seller: subject.account.address, buyer: stranger.account.address, state: RELEASED }),
      }),
      "not_a_party"
    );
  });

  it("refuses a rating about someone who was not in the trade", async () => {
    const { rater, event } = await setup();
    const stranger = await party();
    await expectRejected(
      parseRatingEvent(event, {
        chainId: CHAIN_ID,
        publicClient: chainWith({ seller: stranger.account.address, buyer: rater.account.address, state: RELEASED }),
      }),
      "not_a_party"
    );
  });

  it("refuses a rating on a trade that has not finished", async () => {
    const { rater, subject, event } = await setup();
    await expectRejected(
      parseRatingEvent(event, {
        chainId: CHAIN_ID,
        publicClient: chainWith({ seller: subject.account.address, buyer: rater.account.address, state: LOCKED }),
      }),
      "trade_unfinished"
    );
  });

  it("refuses a rating with nothing to check it against", async () => {
    const { event } = await setup();
    await expectRejected(parseRatingEvent(event, { chainId: CHAIN_ID }), "unreadable_trade");
  });

  it("refuses a wallet rating itself", async () => {
    const rater = await party();
    const rating: Rating = {
      score: 1, tradeId: 1n, chainId: CHAIN_ID, escrow: ESCROW,
      subject: rater.account.address, rater: rater.account.address,
    };
    const event = buildRatingEvent({ rating, binding: rater.binding, identity: rater.identity });
    await expectRejected(
      parseRatingEvent(event, { chainId: CHAIN_ID, publicClient: chainWith({ seller: rater.account.address, buyer: rater.account.address, state: RELEASED }) }),
      "not_a_party"
    );
  });

  it("refuses a Nostr key that isn't bound to the rater", async () => {
    const { rating } = await setup();
    const impostor = await party();
    // Someone else's key, signing a rating that claims to be from the rater.
    const event = buildRatingEvent({ rating: { ...rating, rater: impostor.account.address }, binding: impostor.binding, identity: impostor.identity });
    const tampered = { ...event, content: JSON.stringify({ ...JSON.parse(event.content), rater: rating.rater }) };
    await expectRejected(parseRatingEvent(tampered, { chainId: CHAIN_ID, publicClient: chainWith({ seller: rating.subject, buyer: rating.rater, state: RELEASED }) }), "bad_nostr_signature");
  });

  it("refuses a rating for another chain", async () => {
    const { event } = await setup();
    await expectRejected(parseRatingEvent(event, { chainId: CHAIN_ID + 1 }), "wrong_network");
  });

  it("rejects an unknown score outright", async () => {
    const rater = await party();
    expect(() =>
      buildRatingEvent({
        rating: { score: 5 as never, tradeId: 1n, chainId: CHAIN_ID, escrow: ESCROW, subject: rater.account.address, rater: rater.account.address },
        binding: rater.binding,
        identity: rater.identity,
      })
    ).toThrow();
  });
});

describe("summarising", () => {
  const fake = (over: Partial<ParsedRating>): ParsedRating =>
    ({
      score: 1, tradeId: 1n, chainId: CHAIN_ID, escrow: ESCROW,
      subject: "0x1111111111111111111111111111111111111111",
      rater: "0x2222222222222222222222222222222222222222",
      event: { created_at: 100 } as never,
      binding: {} as never,
      ...over,
    }) as ParsedRating;

  const SUBJECT = "0x1111111111111111111111111111111111111111" as const;

  it("counts one rating per rater per trade, newest winning", () => {
    // The same person changing their mind about the same trade is one rating, not two.
    const s = summariseRatings(
      [fake({ score: -1, event: { created_at: 100 } as never }), fake({ score: 1, event: { created_at: 200 } as never })],
      SUBJECT
    );
    expect(s.total).toBe(1);
    expect(s.positive).toBe(1);
  });

  it("keeps separate raters and trades apart", () => {
    const s = summariseRatings(
      [
        fake({ tradeId: 1n, rater: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
        fake({ tradeId: 2n, rater: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", score: -1 }),
      ],
      SUBJECT
    );
    expect(s.total).toBe(2);
    expect(s.rate).toBe(0.5);
  });

  it("ignores ratings about somebody else", () => {
    const s = summariseRatings([fake({ subject: "0x9999999999999999999999999999999999999999" })], SUBJECT);
    expect(s.total).toBe(0);
    expect(s.rate).toBeUndefined();
  });

  it("ranks the tags people actually used", () => {
    const s = summariseRatings(
      [
        fake({ tradeId: 1n, rater: "0xa1", tag: "fast release" }),
        fake({ tradeId: 2n, rater: "0xa2", tag: "fast release" }),
        fake({ tradeId: 3n, rater: "0xa3", tag: "slow to pay" }),
      ],
      SUBJECT
    );
    expect(s.tags[0]).toEqual({ tag: "fast release", count: 2 });
  });

  it("addresses a rating slot by rater and trade, so re-rating replaces", () => {
    expect(ratingAddress(CHAIN_ID, ESCROW, 7n, "0xAbC0000000000000000000000000000000000000")).toBe(
      `${CHAIN_ID}:${ESCROW.toLowerCase()}:7:0xabc0000000000000000000000000000000000000`
    );
  });
});
