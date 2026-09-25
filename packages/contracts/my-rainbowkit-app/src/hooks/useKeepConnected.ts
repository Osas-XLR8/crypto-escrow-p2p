// src/hooks/useKeepConnected.ts — pick the wallet session back up when a tab comes to the front.
//
// wagmi only tries to reconnect when a page mounts. A tab opened before you connected somewhere else (or left
// in the background while you connected in another tab) therefore sits there looking disconnected, which makes
// the app feel broken — especially on the arbitration desk, where "not connected" reads like a dead end.

import { useEffect, useRef, useState } from "react";
import { useAccount, useConfig, useReconnect } from "wagmi";

export function useKeepConnected() {
  const { isConnected, isConnecting, isReconnecting } = useAccount();
  const { reconnect } = useReconnect();
  const config = useConfig();

  // wagmi keeps `recentConnectorId` after an explicit disconnect, so that alone can't tell us whether the
  // user wants to be connected. A connection that disappears while this tab is open was dropped on purpose
  // (here or in another tab), and we leave it dropped until they connect again.
  const [dismissed, setDismissed] = useState(false);
  const wasConnected = useRef(false);
  useEffect(() => {
    if (isConnected) {
      wasConnected.current = true;
      setDismissed(false);
    } else if (wasConnected.current) {
      setDismissed(true);
    }
  }, [isConnected]);

  useEffect(() => {
    const tryReconnect = () => {
      if (document.visibilityState !== "visible") return;
      if (dismissed || isConnected || isConnecting || isReconnecting) return;
      // Only when a previous session exists, so first-time visitors are never prompted.
      Promise.resolve(config.storage?.getItem("recentConnectorId"))
        .then((id) => {
          if (id) reconnect();
        })
        .catch(() => {
          /* storage unavailable: nothing to resume */
        });
    };
    tryReconnect();
    window.addEventListener("focus", tryReconnect);
    document.addEventListener("visibilitychange", tryReconnect);
    return () => {
      window.removeEventListener("focus", tryReconnect);
      document.removeEventListener("visibilitychange", tryReconnect);
    };
  }, [dismissed, isConnected, isConnecting, isReconnecting, reconnect, config]);
}
