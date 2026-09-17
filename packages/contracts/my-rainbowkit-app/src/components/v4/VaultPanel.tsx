// src/components/v4/VaultPanel.tsx — seller vault (only the seller can withdraw) + dispute fee refunds.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, formatEther } from "viem";
import { usePublicClient } from "wagmi";
import { useEscrowX } from "@/context/EscrowX";
import { V4 } from "@/config/v4";
import { Button, Card, FieldRow, Label, Notice, errorText, inputStyle } from "@/components/ui";
import { fmtToken, parseTokenInput } from "@/lib/v4/local";

export function VaultPanel() {
  const { address, client } = useEscrowX();
  const publicClient = usePublicClient();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const balances = useQuery({
    queryKey: ["vault", address, V4.escrow],
    enabled: !!address && !!client && !!publicClient,
    refetchInterval: 4000,
    queryFn: async () => {
      const [wallet, free, claimable] = await Promise.all([
        publicClient!.readContract({ address: V4.usdt, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
        client!.freeBalance(address!, V4.usdt),
        client!.claimableNative(address!),
      ]);
      return { wallet, free, claimable };
    },
  });

  const parsed = parseTokenInput(amount);

  async function run(label: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
      setMessage({ tone: "ok", text: ok });
      setAmount("");
      await balances.refetch();
    } catch (e) {
      setMessage({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  const b = balances.data;
  return (
    <Card title="SELLER VAULT">
      <div style={{ background: "#060d1a", borderRadius: 10, padding: "0 14px", marginBottom: 14 }}>
        <FieldRow label="IN YOUR WALLET" value={b ? `${fmtToken(b.wallet)} ${V4.tokenSymbol}` : "—"} />
        <FieldRow label="AVAILABLE TO SELL" value={b ? <strong style={{ color: "#34d399" }}>{fmtToken(b.free)} {V4.tokenSymbol}</strong> : "—"} />
        {b && b.claimable > 0n && <FieldRow label="DISPUTE FEE REFUNDS" value={`${formatEther(b.claimable)} ETH`} />}
      </div>

      <p style={{ color: "#64748b", fontSize: 12, lineHeight: 1.5, margin: "0 0 12px" }}>
        Funds sit in the escrow contract under your address. Only you can withdraw what isn&apos;t locked in a trade —
        nobody can pause or freeze withdrawals.
      </p>

      <Label hint={V4.tokenSymbol}>AMOUNT</Label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 500" inputMode="decimal" style={{ ...inputStyle, flex: "1 1 140px", width: "auto" }} />
        <Button variant="primary" solid disabled={!parsed || !!busy || !client} onClick={() => parsed && run("deposit", () => client!.deposit(V4.usdt, parsed), `Deposited ${amount} ${V4.tokenSymbol}`)}>
          {busy === "deposit" ? "Depositing…" : "Deposit"}
        </Button>
        <Button disabled={!parsed || !!busy || !client || (b ? parsed! > b.free : true)} onClick={() => parsed && run("withdraw", () => client!.withdraw(V4.usdt, parsed), `Withdrew ${amount} ${V4.tokenSymbol}`)}>
          {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
        </Button>
      </div>
      {b && b.claimable > 0n && (
        <div style={{ marginTop: 10 }}>
          <Button variant="blue" disabled={!!busy} onClick={() => run("refunds", () => client!.withdrawNative(), "Dispute fee refunds withdrawn")}>
            {busy === "refunds" ? "Withdrawing…" : "Withdraw fee refunds"}
          </Button>
        </div>
      )}
      <p style={{ color: "#475569", fontSize: 11, margin: "10px 0 0" }}>Deposit approves exactly this amount — never an unlimited allowance.</p>
      {message && <div style={{ marginTop: 12 }}><Notice tone={message.tone}>{message.text}</Notice></div>}
    </Card>
  );
}
