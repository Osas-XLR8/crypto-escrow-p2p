// src/hooks/useRatings.ts — read and write counterparty ratings over the same relays offers travel on.
//
// Every rating is verified against the chain before it counts (see @escrowx/sdk ratings.ts), which costs a
// read per rating — so this is deliberately not called from offer cards in a list. It is for a trade you
// are in and for a profile you opened on purpose.

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { RatingBook, buildRatingEvent, summariseRatings, type Rating, type RatingTag } from "@escrowx/sdk";
import { CHAIN_ID, RELAYS, V4 } from "@/config/v4";
import { useEscrowX } from "@/context/EscrowX";

export function useRatingBook(): RatingBook | null {
  const client = usePublicClient();
  return useMemo(
    () =>
      client
        ? new RatingBook(RELAYS, { chainId: CHAIN_ID, escrow: V4.escrow, publicClient: client as never })
        : null,
    [client]
  );
}

/** What people who actually traded with this address said about it. */
export function useRatingsFor(subject?: Address) {
  const book = useRatingBook();
  const query = useQuery({
    queryKey: ["ratings", subject, CHAIN_ID],
    enabled: !!book && !!subject,
    staleTime: 60_000,
    queryFn: async () => {
      const { ratings, rejected } = await book!.fetch(subject!);
      return { summary: summariseRatings(ratings, subject!), ratings, rejected };
    },
  });
  return query;
}

export function useSubmitRating() {
  const book = useRatingBook();
  const { address, identity, binding } = useEscrowX();

  const canRate = !!book && !!address && !!identity && !!binding;

  const submit = useCallback(
    async (args: { tradeId: bigint; subject: Address; score: 1 | -1; tag?: RatingTag }) => {
      if (!book || !address || !identity || !binding) throw new Error("Unlock messaging first, so your rating can be signed.");
      const rating: Rating = {
        score: args.score,
        tag: args.tag,
        tradeId: args.tradeId,
        chainId: CHAIN_ID,
        escrow: V4.escrow,
        subject: args.subject,
        rater: address,
      };
      const event = buildRatingEvent({ rating, binding, identity });
      const results = await book.publish(event);
      const accepted = results.filter((r) => r.ok).length;
      if (accepted === 0) throw new Error(`No relay accepted the rating (${results.map((r) => r.message).join("; ")})`);
      return accepted;
    },
    [book, address, identity, binding]
  );

  return { submit, canRate };
}
