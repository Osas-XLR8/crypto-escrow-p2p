// src/hooks/useFirmPanels.ts — what each arbitration firm charges, and whether it has anyone to hear a case.
//
// A firm with an empty panel can be named on an offer and can receive a dispute, but it can never assign the
// case to anyone, so a trade that lands there only ever ends on the escrow's timeout. That's worth knowing
// before you take an offer — and before you escalate to a fallback. The fee matters for the same reason:
// it's the only charge in the whole product, and it should be on screen before you commit, not after.

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { licensedArbitratorAdapterAbi } from "@escrowx/sdk";
import { FIRMS } from "@/config/v4";
import { readPanel } from "@/lib/v4/arbitration";

export interface FirmStatus {
  /** Undefined while the firm is still being read — don't warn on "not loaded yet". */
  panel?: number;
  staffed: boolean;
  /** What a dispute with this firm costs each side, in wei. */
  fee?: bigint;
}

export function useFirmPanels() {
  const publicClient = usePublicClient();
  const query = useQuery({
    queryKey: ["firmStatus", FIRMS, publicClient?.chain.id],
    enabled: !!publicClient,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const entries = await Promise.all(
        FIRMS.map(async (firm) => {
          const [panel, fee] = await Promise.all([
            readPanel(publicClient!, firm),
            publicClient!.readContract({ address: firm, abi: licensedArbitratorAdapterAbi, functionName: "fee" }),
          ]);
          return [firm.toLowerCase(), { panel: panel.length, fee }] as const;
        })
      );
      return Object.fromEntries(entries) as Record<string, { panel: number; fee: bigint }>;
    },
  });

  const status = (firm?: Address): FirmStatus => {
    const found = firm ? query.data?.[firm.toLowerCase()] : undefined;
    return { panel: found?.panel, staffed: found === undefined || found.panel > 0, fee: found?.fee };
  };

  return { status, isLoading: query.isLoading };
}
