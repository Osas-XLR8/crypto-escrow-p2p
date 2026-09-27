// src/hooks/useWalletSession.ts — "are we connected?" with the honest third answer: still finding out.
//
// Reconnecting to an injected wallet can take many seconds on a cold page. Treating that window as
// "disconnected" showed a returning user the first-time landing page, complete with "connect a wallet to
// start", before quietly swapping it for their own trades. The app looked like it had forgotten them.

import { useEffect, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { recallDisconnected } from "@/lib/v4/local";

/** Grace period for wagmi to report `reconnecting` after a fresh mount. */
const SETTLE_MS = 2000;
/**
 * The longest this will ever claim to be resuming.
 *
 * wagmi can sit in `reconnecting` indefinitely when the wallet has revoked the site — which is exactly what
 * an explicit disconnect does — and the banner then never goes away, hiding the signed-out page behind a
 * promise that is not coming true. Better to admit we are not connected and let them connect.
 */
const GIVE_UP_MS = 8000;

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
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    let live = true;
    // A session only counts as resumable if they didn't end it themselves: wagmi keeps recentConnectorId
    // through an explicit disconnect, so on its own it cannot tell the two apart.
    Promise.resolve(config.storage?.getItem("recentConnectorId"))
      .then((id) => live && setHadSession(!!id && !recallDisconnected()))
      .catch(() => {
        /* storage unavailable: treat as a first visit */
      });
    const id = setTimeout(() => live && setSettling(false), SETTLE_MS);
    const stop = setTimeout(() => live && setGaveUp(true), GIVE_UP_MS);
    return () => {
      live = false;
      clearTimeout(id);
      clearTimeout(stop);
    };
  }, [config]);

  const resuming =
    !isConnected && !gaveUp && (status === "connecting" || status === "reconnecting" || (hadSession && settling));

  return { isConnected, resuming };
}
