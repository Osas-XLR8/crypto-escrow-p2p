// src/components/v4/MessagingGate.tsx — asks for the signatures that unlock encrypted messaging.

import type { ReactNode } from "react";
import { useEscrowX } from "@/context/EscrowX";
import { Button, Notice } from "@/components/ui";

export function MessagingGate({ children, reason }: { children: ReactNode; reason: string }) {
  const { identity, unlockMessaging, unlocking, unlockError, address } = useEscrowX();
  if (identity) return <>{children}</>;
  return (
    <div className="stack-sm">
      <div className="inset" style={{ padding: 16 }}>
        <div className="stack-sm">
          <div className="row">
            <span className="chip chip-info">🔒 Encrypted messaging</span>
          </div>
          <p className="p0 small muted">
            Unlock to {reason}. Your wallet signs two free messages — one creates your private chat key (kept only in this
            tab), one links that key to your wallet so the other side can verify it&apos;s you. <strong>Neither moves funds or costs gas.</strong>
          </p>
          <div>
            <Button variant="primary" onClick={() => void unlockMessaging()} disabled={!address} busy={unlocking}>
              {unlocking ? "Waiting for signatures…" : "Unlock messaging"}
            </Button>
          </div>
        </div>
      </div>
      {unlockError && <Notice tone="error">{unlockError}</Notice>}
    </div>
  );
}
