// src/components/v4/MessagingGate.tsx — asks for the one signature that unlocks encrypted messaging.

import type { ReactNode } from "react";
import { useEscrowX } from "@/context/EscrowX";
import { Button, Notice } from "@/components/ui";

export function MessagingGate({ children, reason }: { children: ReactNode; reason: string }) {
  const { identity, unlockMessaging, unlocking, unlockError, address } = useEscrowX();
  if (identity) return <>{children}</>;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <Notice tone="info">
        <strong>Unlock encrypted messaging</strong> to {reason}. Your wallet signs two free messages: one derives your
        private chat key (kept only in this tab), one publicly links that key to your wallet. Neither moves funds.
      </Notice>
      {unlockError && <Notice tone="error">{unlockError}</Notice>}
      <div>
        <Button variant="blue" solid onClick={() => void unlockMessaging()} disabled={!address || unlocking}>
          {unlocking ? "Waiting for signatures…" : "Unlock messaging"}
        </Button>
      </div>
    </div>
  );
}
