// src/components/v4/MessagingGate.tsx — asks for the signatures that unlock encrypted messaging.

import type { ReactNode } from "react";
import { useEscrowX } from "@/context/EscrowX";
import { Button, Notice } from "@/components/ui";
import { usePendingAction } from "@/hooks/usePendingAction";
import { PendingNotice, pendingLabel } from "@/components/v4/Pending";

export function MessagingGate({ children, reason }: { children: ReactNode; reason: string }) {
  const { identity, unlockMessaging, unlocking, unlockError, address, retention, setRetention } = useEscrowX();
  const pending = usePendingAction();
  if (identity) return <>{children}</>;
  return (
    <div className="stack-sm">
      <div className="inset" style={{ padding: 16 }}>
        <div className="stack-sm">
          <div className="row">
            <span className="chip chip-info">🔒 Encrypted messaging</span>
          </div>
          <p className="p0 small muted">
            Unlock to {reason}. Your wallet signs two free messages — one creates your private chat key, one links that
            key to your wallet so the other side can verify it&apos;s you. <strong>Neither moves funds or costs gas.</strong>
          </p>
          <p className="p0 tiny faint">
            The key stays in this browser: by default until you close the tab, and it follows you to other tabs and
            reloads without signing again. It never leaves your device.
          </p>
          <label className="row tiny" style={{ gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={retention === "device"}
              onChange={(e) => setRetention(e.target.checked ? "device" : "session")}
            />
            <span>Stay unlocked on this device for 7 days — don&apos;t tick this on a shared computer.</span>
          </label>
          <div>
            <Button
              variant="primary"
              disabled={!address || !!pending.busy}
              busy={unlocking || !!pending.busy}
              onClick={() =>
                void pending.run("unlock", async () => {
                  if (!(await unlockMessaging())) throw new Error("Messaging wasn't unlocked.");
                }, { signature: true })
              }
            >
              {pending.busy ? pendingLabel(pending, "") : "Unlock messaging"}
            </Button>
          </div>
        </div>
      </div>
      <PendingNotice pending={pending} shows="this panel" />
      {!pending.busy && !pending.message && unlockError && <Notice tone="error">{unlockError}</Notice>}
    </div>
  );
}
