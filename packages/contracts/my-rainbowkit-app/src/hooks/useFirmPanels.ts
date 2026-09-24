// src/hooks/useFirmPanels.ts — how many panelists each arbitration firm actually has.
//
// A firm with an empty panel can be named on an offer and can receive a dispute, but it can never assign the
// case to anyone, so a trade that lands there only ever ends on the escrow's timeout. That's worth knowing
// before you take an offer — and before you escalate to a fallback.

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { FIRMS } from "@/config/v4";
import { readPanel } from "@/lib/v4/arbitration";

export interface PanelStatus {
  /** Undefined while the panel is still being read — don't warn on "not loaded yet". */
  size?: number;
  staffed: boolean;
}

export function useFirmPanels() {
  const publicClient = usePublicClient();
  const query = useQuery({
    queryKey: ["firmPanels", FIRMS],
    enabled: !!publicClient,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const entries = await Promise.all(
        FIRMS.map(async (firm) => [firm.toLowerCase(), (await readPanel(publicClient!, firm)).length] as const)
      );
      return Object.fromEntries(entries) as Record<string, number>;
    },
  });

  const status = (firm?: Address): PanelStatus => {
    const size = firm ? query.data?.[firm.toLowerCase()] : undefined;
    return { size, staffed: size === undefined || size > 0 };
  };

  return { status, isLoading: query.isLoading };
}
