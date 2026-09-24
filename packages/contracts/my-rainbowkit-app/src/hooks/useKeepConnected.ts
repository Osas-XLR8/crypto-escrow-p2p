// src/hooks/useKeepConnected.ts — pick the wallet session back up when a tab comes to the front.
//
// wagmi only tries to reconnect when a page mounts. A tab opened before you connected somewhere else (or left
// in the background while you connected in another tab) therefore sits there looking disconnected, which makes
// the app feel broken — especially on the arbitration desk, where "not connected" reads like a dead end.

import { useEffect } from "react";
import { useAccount, useConfig, useReconnect } from "wagmi";

export function useKeepConnected() {
  const { isConnected, isConnecting, isReconnecting } = useAccount();
  const { reconnect } = useReconnect();
  const config = useConfig();

  useEffect(() => {
    const tryReconnect = () => {
      if (document.visibilityState !== "visible") return;
      if (isConnected || isConnecting || isReconnecting) return;
      // Only when a previous session exists, so visitors are never prompted.
      const stored = config.storage?.getItem("recentConnectorId");
      Promise.resolve(stored).then((id) => {
        if (id) reconnect();
      });
    };
    tryReconnect();
    window.addEventListener("focus", tryReconnect);
    document.addEventListener("visibilitychange", tryReconnect);
    return () => {
      window.removeEventListener("focus", tryReconnect);
      document.removeEventListener("visibilitychange", tryReconnect);
    };
  }, [isConnected, isConnecting, isReconnecting, reconnect, config]);
}
