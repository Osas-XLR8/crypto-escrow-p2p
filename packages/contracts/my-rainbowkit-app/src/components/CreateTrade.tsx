import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { keccak256, toBytes, parseUnits } from "viem";
import { ESCROW_ADDRESS, ESCROW_ABI } from "@/config/escrow";

function isAddress(s: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(s.trim());
}

export default function CreateTrade() {
  const { address, isConnected } = useAccount();

  const [seller, setSeller] = useState("");
  const [buyer, setBuyer] = useState("");
  const [amount, setAmount] = useState("10"); // 10 USDT
  const [lockMins, setLockMins] = useState("10"); // lock in 10 mins
  const [fiatHours, setFiatHours] = useState("24"); // fiat deadline in 24h

  // ✅ HYDRATION FIX:
  // tradeId is generated ONLY in the browser after the component mounts.
  const [tradeId, setTradeId] = useState<`0x${string}` | "">("");

  useEffect(() => {
    const id = keccak256(toBytes(`ui-trade-${Date.now()}-${Math.random()}`));
    setTradeId(id as `0x${string}`);
  }, []);

  const { writeContract, data: hash, error, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });

  const now = useMemo(() => Math.floor(Date.now() / 1000), []);

  function onCreate() {
    if (!isConnected || !address) return alert("Connect wallet first.");
    if (!tradeId) return alert("TradeId not ready yet. Refresh page.");
    if (!isAddress(seller)) return alert("Seller must be a valid 0x address.");
    if (!isAddress(buyer)) return alert("Buyer must be a valid 0x address.");

    const lockDeadline = BigInt(now + Number(lockMins) * 60);
    const fiatDeadline = BigInt(now + Number(fiatHours) * 3600);

    const amt = parseUnits(amount, 6); // USDT uses 6 decimals

    writeContract({
      address: ESCROW_ADDRESS as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "createTrade",
      args: [
        tradeId,
        seller as `0x${string}`,
        buyer as `0x${string}`,
        amt,
        lockDeadline,
        fiatDeadline,
      ],
    });
  }

  return (
    <div
      style={{
        border: "1px solid #ddd",
        padding: 16,
        borderRadius: 8,
        marginTop: 12,
        background: "#fff",
      }}
    >
      <h2 style={{ marginTop: 0 }}>Create Trade (Backend Only)</h2>

      <p style={{ marginTop: 0, color: "#666" }}>
        You must be connected with the <b>backendSigner</b> account or this will
        fail with “only backend”.
      </p>

      <div style={{ display: "grid", gap: 10, maxWidth: 700 }}>
        <div>
          <div>Seller address</div>
          <input
            value={seller}
            onChange={(e) => setSeller(e.target.value)}
            placeholder="0x..."
            style={{ width: "100%", padding: 8 }}
          />
          <button
            onClick={() => address && setSeller(address)}
            style={{ marginTop: 6 }}
            disabled={!address}
          >
            Use my address as Seller
          </button>
        </div>

        <div>
          <div>Buyer address</div>
          <input
            value={buyer}
            onChange={(e) => setBuyer(e.target.value)}
            placeholder="0x..."
            style={{ width: "100%", padding: 8 }}
          />
        </div>

        <div>
          <div>Amount (USDT)</div>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="10"
            style={{ width: "100%", padding: 8 }}
          />
          <div style={{ fontSize: 12, color: "#666" }}>
            We convert this to 6 decimals automatically.
          </div>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div>Lock deadline (minutes from now)</div>
            <input
              value={lockMins}
              onChange={(e) => setLockMins(e.target.value)}
              style={{ width: "100%", padding: 8 }}
            />
          </div>

          <div style={{ flex: 1 }}>
            <div>Fiat deadline (hours from now)</div>
            <input
              value={fiatHours}
              onChange={(e) => setFiatHours(e.target.value)}
              style={{ width: "100%", padding: 8 }}
            />
          </div>
        </div>

        <div>
          <div>
            <b>Trade ID (auto-generated)</b>
          </div>
          <code
            style={{
              display: "block",
              padding: 10,
              background: "#f7f7f7",
              borderRadius: 6,
              wordBreak: "break-all",
            }}
          >
            {tradeId || "Generating..."}
          </code>
          <div style={{ fontSize: 12, color: "#666" }}>
            After success: copy Trade ID → paste into Trade Lookup → Refresh.
          </div>
        </div>

        <button
          onClick={onCreate}
          disabled={
            !isConnected ||
            isPending ||
            isConfirming ||
            !seller ||
            !buyer ||
            !tradeId
          }
          style={{ padding: "10px 14px", fontWeight: 600 }}
        >
          {isPending
            ? "Check MetaMask..."
            : isConfirming
            ? "Confirming..."
            : "Create Trade"}
        </button>

        {hash && (
          <div style={{ fontSize: 12 }}>
            Tx Hash: <code>{hash}</code>
          </div>
        )}

        {isSuccess && (
          <div style={{ color: "green" }}>
            ✅ Trade created! Copy Trade ID above → paste into Trade Lookup →
            Refresh Trade.
          </div>
        )}

        {error && <div style={{ color: "crimson" }}>❌ {error.message}</div>}
      </div>
    </div>
  );
}
