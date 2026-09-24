// src/components/v4/GettingStarted.tsx — first-run checklist for a test network: gas, test tokens, messaging.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi } from "viem";
import { useBalance, usePublicClient, useWalletClient } from "wagmi";
import { useEscrowX } from "@/context/EscrowX";
import { CHAIN, GAS_FAUCETS, IS_LOCAL, V4 } from "@/config/v4";
import { Button, Card, Notice, errorText } from "@/components/ui";
import { claimFaucet } from "@/lib/v4/faucet";

const DISMISS_KEY = "escrowx:onboarding-dismissed";

export function GettingStarted() {
  const { address, identity, unlockMessaging, unlocking, keptOnDevice, lockMessaging } = useEscrowX();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const gas = useBalance({ address, query: { refetchInterval: 10_000 } });
  const [dismissed, setDismissed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  const token = useQuery({
    queryKey: ["tokenBalance", address, V4.usdt],
    enabled: !!address && !!publicClient,
    refetchInterval: 10_000,
    queryFn: () => publicClient!.readContract({ address: V4.usdt, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
  });

  const hasGas = (gas.data?.value ?? 0n) > 0n;
  const hasTokens = (token.data ?? 0n) > 0n;
  const steps = [hasGas, hasTokens, !!identity];
  const done = steps.filter(Boolean).length;
  // Test tokens are only needed to sell, so gas + messaging is enough to finish setup.
  const ready = hasGas && !!identity;

  if (!address || dismissed || (ready && !error)) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* not persisted */
    }
  };

  return (
    <Card
      flush
      title={<>Get set up <span className="chip">{done}/{steps.length}</span></>}
      sub={`Everything here runs on ${CHAIN.name}, a test network. Nothing costs real money.`}
      right={<Button size="sm" variant="ghost" onClick={dismiss}>Hide</Button>}
    >
      <ol className="checklist">
        <li>
          <span className={`tick${hasGas ? " done" : ""}`}>{hasGas ? "✓" : "1"}</span>
          <div className="stack-xs">
            <span className="strong small">Test ETH for gas</span>
            <span className="tiny faint">
              {hasGas ? "You have gas." : IS_LOCAL ? "Use a funded Anvil account." : "Free from a faucet — paste your address there."}
            </span>
          </div>
          {!hasGas && GAS_FAUCETS.length > 0 && (
            <div className="row" style={{ gap: 6 }}>
              {GAS_FAUCETS.slice(0, 3).map((f) => (
                <a key={f.url} className="btn btn-sm" href={f.url} target="_blank" rel="noreferrer">{f.name} ↗</a>
              ))}
            </div>
          )}
        </li>
        <li>
          <span className={`tick${hasTokens ? " done" : ""}`}>{hasTokens ? "✓" : "2"}</span>
          <div className="stack-xs">
            <span className="strong small">Test {V4.tokenSymbol} <span className="faint" style={{ fontWeight: 400 }}>· only needed to sell</span></span>
            <span className="tiny faint">Worthless test dollars from the token&apos;s own faucet, 1,000 per hour.</span>
          </div>
          {!hasTokens && V4.tokenFaucet && (
            <Button size="sm" busy={busy} disabled={!hasGas || !walletClient} title={!hasGas ? "Get test ETH first" : undefined}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await claimFaucet(publicClient as never, walletClient as never);
                  await token.refetch();
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}>
              Get 1,000 {V4.tokenSymbol}
            </Button>
          )}
        </li>
        <li>
          <span className={`tick${identity ? " done" : ""}`}>{identity ? "✓" : "3"}</span>
          <div className="stack-xs">
            <span className="strong small">Unlock private messaging</span>
            <span className="tiny faint">
              {identity
                ? keptOnDevice
                  ? "Unlocked and kept on this device for 7 days — reloads and new tabs won't ask again."
                  : "Unlocked for this browser session — reloads and new tabs won't ask again."
                : "Two free signatures. This is how payment details reach you, encrypted."}
            </span>
          </div>
          {identity ? (
            <Button size="sm" variant="ghost" onClick={lockMessaging} title="Forget the messaging key on this browser">Lock</Button>
          ) : (
            <Button size="sm" busy={unlocking} onClick={() => void unlockMessaging()}>Unlock</Button>
          )}
        </li>
      </ol>
      {error && <div style={{ padding: "0 18px 14px" }}><Notice tone="error">{error}</Notice></div>}
    </Card>
  );
}
