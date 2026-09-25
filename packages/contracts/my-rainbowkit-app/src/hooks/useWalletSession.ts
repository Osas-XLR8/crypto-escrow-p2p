// src/hooks/useWalletSession.ts — "are we connected?" with the honest third answer: still finding out.
//
// Reconnecting to an injected wallet can take many seconds on a cold page. Treating that window as
// "disconnected" showed a returning user the first-time landing page, complete with "connect a wallet to
// start", before quietly swapping it for their own trades. The app looked like it had forgotten them.

import { useEffect, useState } from "react";
import { useAccount, useConfig } from "wagmi";

/** Grace period for wagmi to report `reconnecting` after a fresh mount. */
const SETTLE_MS = 2000;

export interface WalletSession {
  isConnected: boolean;
  /** A session is being restored: render what a connected user sees, with skeletons where data isn't in yet. */
  resuming: boolean;
}

export function useWalletSession(): WalletSession {
  const { isConnected, status } = useAccount();
  const config = useConfig();
  const [hadSession, setHadSession] = useState(false);
  const [settling, setSettling] = useState(true);

  useEffect(() => {
    let live = true;
    Promise.resolve(config.storage?.getItem("recentConnectorId"))
      .then((id) => live && setHadSession(!!id))
      .catch(() => {
        /* storage unavailable: treat as a first visit */
      });
    const id = setTimeout(() => live && setSettling(false), SETTLE_MS);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [config]);

  const resuming =
    !isConnected && (status === "connecting" || status === "reconnecting" || (hadSession && settling));

  return { isConnected, resuming };
}
