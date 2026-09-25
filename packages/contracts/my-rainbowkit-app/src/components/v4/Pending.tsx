// src/components/v4/Pending.tsx — what a wallet action looks like while it is happening.
//
// Every state here has a way out. Nothing spins on its own with no explanation, and the wording says which
// wait you are in, because they end differently: a signature you can abandon, a sent transaction you cannot.

import { Button, Notice } from "@/components/ui";
import { explorerTx } from "@/config/v4";
import { HINT_AFTER_MS, type PendingApi } from "@/hooks/usePendingAction";

const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;

/** The label a busy button should carry, including "Step 2 of 3" on multi-transaction flows. */
export function pendingLabel(pending: PendingApi, fallback: string): string {
  const { phase, step } = pending;
  const prefix = step && step.total > 1 ? `Step ${step.index} of ${step.total} · ` : "";
  if (phase === "checking") return `${prefix}Checking…`;
  if (phase === "signing") return `${prefix}${step?.label ?? "Confirm in your wallet"}…`;
  if (phase === "sent") return `${prefix}Waiting for the network…`;
  return fallback;
}

export function PendingNotice({ pending }: { pending: PendingApi }) {
  const { busy, phase, waited, stuck, hash, step, message, cancel, retry, dismiss } = pending;

  if (!busy) {
    if (!message) return null;
    return (
      <Notice tone={message.tone === "ok" ? "ok" : "error"}>
        <div className="row-between" style={{ gap: 12 }}>
          <span>{message.text}</span>
          <span className="row" style={{ gap: 8 }}>
            {message.tone === "error" && <Button size="sm" onClick={retry}>Try again</Button>}
            <Button size="sm" variant="ghost" onClick={dismiss}>Dismiss</Button>
          </span>
        </div>
      </Notice>
    );
  }

  const link = hash ? explorerTx(hash) : null;
  const sent = phase === "sent";

  return (
    <Notice tone={stuck ? "warn" : "info"}>
      <div className="stack-xs">
        <div className="row-between" style={{ gap: 12 }}>
          <span>
            {step && step.total > 1 && <strong>Step {step.index} of {step.total}: </strong>}
            {sent
              ? "Sent. Waiting for the network to confirm it."
              : phase === "checking"
                ? "Checking this will go through before your wallet asks for anything."
                : `${step?.label ?? "Waiting for you to confirm this"} in your wallet.`}
            <span className="faint"> · {seconds(waited)}</span>
          </span>
          <span className="row" style={{ gap: 8 }}>
            {link && <a className="btn btn-ghost btn-sm mono" href={link} target="_blank" rel="noreferrer">View ↗</a>}
            {!sent && stuck && <Button size="sm" onClick={retry}>Ask again</Button>}
            <Button size="sm" variant="ghost" onClick={cancel}>{sent ? "Stop watching" : "Cancel"}</Button>
          </span>
        </div>

        {!sent && waited >= HINT_AFTER_MS && (
          <span className="small faint">
            Nothing happening? Your wallet may be waiting out of sight — open the MetaMask icon in your browser
            toolbar. If you dismissed the popup by accident, cancel here and try again; nothing has been sent.
          </span>
        )}
        {sent && waited >= HINT_AFTER_MS && (
          <span className="small faint">
            This is already on the network, so it can&apos;t be taken back or sent twice. Leaving this page is
            safe — the trade will show the result when it lands.
          </span>
        )}
      </div>
    </Notice>
  );
}
