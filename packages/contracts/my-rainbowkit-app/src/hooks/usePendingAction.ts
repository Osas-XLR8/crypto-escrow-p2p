// src/hooks/usePendingAction.ts — one place where "waiting on the wallet" is handled properly.
//
// A spinner that can run forever is worse than an error: the user who dismissed the MetaMask popup by
// accident has no way back except reloading and losing their place. Every wallet action in this app goes
// through here, so all of them explain themselves, can be given up on, and can be retried.
//
// The two waits are not the same and must never be treated the same:
//   • waiting for a signature — nothing exists yet, so giving up costs nothing and retrying is safe.
//   • waiting for a receipt — the transaction is already on the network. Retrying would send a second one,
//     so this state is never offered a retry; it offers the explorer instead and keeps waiting.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import type { Activity } from "@escrowx/sdk";
import { useEscrowX } from "@/context/EscrowX";
import { errorText } from "@/components/ui";

/** How long before we suggest the wallet might be waiting out of sight, and before we call it stuck. */
export const HINT_AFTER_MS = 10_000;
export const STUCK_AFTER_MS = 30_000;

export type PendingPhase = "idle" | "checking" | "signing" | "sent";

export interface PendingStep {
  index: number;
  total: number;
  label: string;
}

export interface PendingState {
  /** Key of the action currently running, or null. */
  busy: string | null;
  phase: PendingPhase;
  hash?: Hex;
  /** Milliseconds spent in the current phase. */
  waited: number;
  /** The wallet hasn't answered for a while and the action can be abandoned. */
  stuck: boolean;
  step?: PendingStep;
  error: string | null;
  message: { tone: "ok" | "error"; text: string } | null;
}

/** What a running action can tell the UI about itself. */
export interface PendingContext {
  /** Which prompt of how many this is. */
  step: (step: PendingStep) => void;
  /** For actions that don't go through the escrow client (a faucet claim, a bare signature). */
  phase: (phase: PendingPhase, hash?: Hex) => void;
}

export interface PendingApi extends PendingState {
  run: (key: string, fn: (ctx: PendingContext) => Promise<unknown>, opts?: RunOptions) => Promise<void>;
  /** Stop waiting here. The wallet prompt stays open in the wallet; this only frees the UI. */
  cancel: () => void;
  retry: () => void;
  dismiss: () => void;
}

interface RunOptions {
  /** Shown when the action finishes. */
  success?: string;
  /** A plain signature (no transaction): starts in the signing phase, since nothing is simulated first. */
  signature?: boolean;
  onDone?: () => void | Promise<void>;
}

export function usePendingAction(): PendingApi {
  const { client } = useEscrowX();
  const [state, setState] = useState<PendingState>({ busy: null, phase: "idle", waited: 0, stuck: false, error: null, message: null });
  // Kept in refs so a retry re-runs exactly what was asked for, and a cancel can orphan the old run.
  const last = useRef<{ key: string; fn: Parameters<PendingApi["run"]>[1]; opts?: RunOptions } | null>(null);
  const runId = useRef(0);
  const phaseStartedAt = useRef(0);

  // One ticker while something is pending, so "waited" and the hints stay honest without a timer per action.
  useEffect(() => {
    if (!state.busy) return;
    const id = setInterval(() => {
      setState((s) => {
        if (!s.busy) return s;
        const waited = Date.now() - phaseStartedAt.current;
        return { ...s, waited, stuck: s.phase !== "sent" && waited >= STUCK_AFTER_MS };
      });
    }, 500);
    return () => clearInterval(id);
  }, [state.busy]);

  const run = useCallback<PendingApi["run"]>(
    async (key, fn, opts) => {
      last.current = { key, fn, opts };
      const id = ++runId.current;
      phaseStartedAt.current = Date.now();
      setState({ busy: key, phase: opts?.signature ? "signing" : "checking", waited: 0, stuck: false, error: null, message: null });

      const unsubscribe = client?.onActivity((event: Activity) => {
        if (runId.current !== id) return; // a cancelled or superseded run
        phaseStartedAt.current = Date.now();
        setState((s) => ({
          ...s,
          phase: event.phase === "confirmed" ? "sent" : event.phase,
          hash: "hash" in event ? event.hash : s.hash,
          waited: 0,
          stuck: false,
        }));
      });

      try {
        await fn({
          step: (step) => {
            if (runId.current === id) setState((s) => ({ ...s, step }));
          },
          phase: (phase, hash) => {
            if (runId.current !== id) return;
            phaseStartedAt.current = Date.now();
            setState((s) => ({ ...s, phase, hash: hash ?? s.hash, waited: 0, stuck: false }));
          },
        });
        if (runId.current !== id) return; // abandoned: leave the UI as the user left it
        setState({ busy: null, phase: "idle", waited: 0, stuck: false, error: null, message: opts?.success ? { tone: "ok", text: opts.success } : null });
        await opts?.onDone?.();
      } catch (e) {
        if (runId.current !== id) return;
        const text = errorText(e);
        setState({ busy: null, phase: "idle", waited: 0, stuck: false, error: text, message: { tone: "error", text } });
      } finally {
        unsubscribe?.();
      }
    },
    [client]
  );

  const cancel = useCallback(() => {
    runId.current++; // anything the old run reports from here on is ignored
    setState({
      busy: null,
      phase: "idle",
      waited: 0,
      stuck: false,
      error: null,
      message: {
        tone: "error",
        text: "Stopped waiting. If you approve it in your wallet later it will still go through — this page will pick it up.",
      },
    });
  }, []);

  const retry = useCallback(() => {
    const previous = last.current;
    if (previous) void run(previous.key, previous.fn, previous.opts);
  }, [run]);

  const dismiss = useCallback(() => setState((s) => ({ ...s, error: null, message: null })), []);

  return { ...state, run, cancel, retry, dismiss };
}
