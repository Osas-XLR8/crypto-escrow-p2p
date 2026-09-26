// src/components/v4/VaultPanel.tsx — seller vault (only the seller can withdraw), test-token faucet, fee refunds.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, formatEther, formatUnits } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { useEscrowX } from "@/context/EscrowX";
import { usePendingAction } from "@/hooks/usePendingAction";
import { PendingNotice, pendingLabel } from "@/components/v4/Pending";
import { IS_TESTNET, V4 } from "@/config/v4";
import { Button, Card, Field, Notice, errorText } from "@/components/ui";
import { fmtDuration } from "@/lib/format";
import { claimFaucet, faucetAvailableAt } from "@/lib/v4/faucet";
import { fmtToken, parseTokenInput } from "@/lib/v4/local";

export function VaultPanel() {
  const { address, client } = useEscrowX();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [amount, setAmount] = useState("");
  const pending = usePendingAction();
  const busy = pending.busy;
  const showFaucet = IS_TESTNET && V4.tokenFaucet;

  const balances = useQuery({
    queryKey: ["vault", address, V4.escrow],
    enabled: !!address && !!client && !!publicClient,
    refetchInterval: 6000,
    queryFn: async () => {
      const [wallet, free, claimable, faucetAt] = await Promise.all([
        publicClient!.readContract({ address: V4.usdt, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
        client!.freeBalance(address!, V4.usdt),
        client!.claimableNative(address!),
        showFaucet ? faucetAvailableAt(publicClient as never, address!).catch(() => 0) : Promise.resolve(0),
      ]);
      return { wallet, free, claimable, faucetAt };
    },
  });

  const parsed = parseTokenInput(amount);
  const b = balances.data;
  const now = Math.floor(Date.now() / 1000);
  const faucetWait = b ? b.faucetAt - now : 0;

  function run(label: string, fn: (ctx: { step: (s: { index: number; total: number; label: string }) => void }) => Promise<unknown>, ok: string) {
    void pending.run(label, fn, {
      success: ok,
      onDone: async () => {
        setAmount("");
        await balances.refetch();
      },
    });
  }

  return (
    <Card title="Your vault" sub="Crypto you've made available to sell">
      <div className="stack">
        <div className="stack-xs">
          <span className="eyebrow">Available to sell</span>
          <div className="big-num">
            {b ? fmtToken(b.free) : "—"} <span className="faint" style={{ fontSize: 14 }}>{V4.tokenSymbol}</span>
          </div>
          <div className="small faint">
            In your wallet: <span className="mono muted">{b ? fmtToken(b.wallet) : "—"} {V4.tokenSymbol}</span>
          </div>
        </div>

        {showFaucet && (
          <div className="row-between inset" style={{ padding: "10px 12px" }}>
            <div className="small">
              <div className="strong">Test tokens</div>
              <div className="faint">{faucetWait > 0 ? `Next claim in ${fmtDuration(faucetWait)}` : "Free, worthless, 1,000 per hour"}</div>
            </div>
            <Button size="sm" disabled={faucetWait > 0 || !walletClient || !publicClient} busy={busy === "faucet"}
              onClick={() => run("faucet", () => claimFaucet(publicClient as never, walletClient as never), `Received 1,000 ${V4.tokenSymbol}`)}>
              Get 1,000 {V4.tokenSymbol}
            </Button>
          </div>
        )}

        <Field label="Amount" hint={V4.tokenSymbol}>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input className="input mono" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" />
            <Button size="sm" variant="ghost" disabled={!b || b.wallet === 0n} onClick={() => b && setAmount(formatUnits(b.wallet, V4.tokenDecimals))} title="Use your whole wallet balance">
              Max
            </Button>
          </div>
        </Field>

        <div className="row" style={{ flexWrap: "nowrap" }}>
          <div className="grow">
            <Button variant="accent" block disabled={!parsed || !client || (b ? parsed! > b.wallet : true)} busy={busy === "deposit"}
              onClick={() => parsed && run("deposit", () => client!.deposit(V4.usdt, parsed), `Deposited ${amount} ${V4.tokenSymbol}`)}>
              Deposit
            </Button>
          </div>
          <div className="grow">
            <Button block disabled={!parsed || !client || (b ? parsed! > b.free : true)} busy={busy === "withdraw"}
              onClick={() => parsed && run("withdraw", () => client!.withdraw(V4.usdt, parsed), `Withdrew ${amount} ${V4.tokenSymbol}`)}>
              Withdraw
            </Button>
          </div>
        </div>

        {b && b.claimable > 0n && (
          <Notice tone="ok">
            <div className="row-between">
              <span>{formatEther(b.claimable)} ETH of dispute fees to collect.</span>
              <Button size="sm" busy={busy === "refunds"} onClick={() => run("refunds", () => client!.withdrawNative(), "Dispute fee refunds withdrawn")}>Withdraw</Button>
            </div>
          </Notice>
        )}

        <PendingNotice pending={pending} shows="your vault balance" />

        <p className="help">
          Held by the escrow contract under your address. Only you can withdraw what isn&apos;t locked in a trade — nobody can
          pause or freeze it. Deposits approve exactly the amount, never an unlimited allowance.
        </p>
      </div>
    </Card>
  );
}
