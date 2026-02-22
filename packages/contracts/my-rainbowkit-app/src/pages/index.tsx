import Head from "next/head";
import { useMemo, useState } from "react";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId, useReadContract, useWriteContract } from "wagmi";

import { ESCROW_ABI, ESCROW_ADDRESS } from "@/config/escrow";
import CreateTrade from "@/components/CreateTrade";

const STATE_LABEL: Record<number, string> = {
  0: "NONE",
  1: "CREATED",
  2: "LOCKED",
  3: "RELEASED",
  4: "REFUNDED",
  5: "DISPUTE",
};

function isBytes32Hex(s: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(s.trim());
}
function isHex(s: string) {
  return /^0x[0-9a-fA-F]+$/.test(s.trim());
}

export default function Home() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  const [tradeId, setTradeId] = useState<string>("");

  // Step 5 UI inputs
  const [resolveExpiresAt, setResolveExpiresAt] = useState<string>("");
  const [resolveNonce, setResolveNonce] = useState<string>("");
  const [resolveSig, setResolveSig] = useState<string>("");

  const tradeIdOk = useMemo(() => isBytes32Hex(tradeId), [tradeId]);

  const escrowAddr = ESCROW_ADDRESS as `0x${string}`;

  const read = useReadContract({
    abi: ESCROW_ABI,
    address: escrowAddr,
    functionName: "trades",
    args: tradeIdOk ? [tradeId.trim() as `0x${string}`] : undefined,
    query: { enabled: isConnected && tradeIdOk },
  });

  const { writeContractAsync, isPending } = useWriteContract();

  async function doDeposit() {
    if (!tradeIdOk) return alert("Paste a valid tradeId (bytes32).");
    await writeContractAsync({
      abi: ESCROW_ABI,
      address: escrowAddr,
      functionName: "deposit",
      args: [tradeId.trim() as `0x${string}`],
    });
    await read.refetch();
  }

  async function doRefund() {
    if (!tradeIdOk) return alert("Paste a valid tradeId (bytes32).");
    await writeContractAsync({
      abi: ESCROW_ABI,
      address: escrowAddr,
      functionName: "refund",
      args: [tradeId.trim() as `0x${string}`],
    });
    await read.refetch();
  }

  async function doDispute() {
    if (!tradeIdOk) return alert("Paste a valid tradeId (bytes32).");
    await writeContractAsync({
      abi: ESCROW_ABI,
      address: escrowAddr,
      functionName: "openDispute",
      args: [tradeId.trim() as `0x${string}`],
    });
    await read.refetch();
  }

  // ✅ Step 5: Resolve dispute (seller wins) — backend signer only
  async function doResolveDisputeRelease() {
    if (!tradeIdOk) return alert("Paste a valid tradeId (bytes32) first.");

    const expiresStr = resolveExpiresAt.trim();
    const nonceStr = resolveNonce.trim();
    const sigStr = resolveSig.trim();

    if (expiresStr.length === 0) return alert("Enter expiresAt (unix seconds).");
    if (!/^\d+$/.test(expiresStr)) return alert("expiresAt must be a number (unix seconds).");
    if (!isBytes32Hex(nonceStr)) return alert("nonce must be bytes32 (0x + 64 hex).");
    if (!isHex(sigStr) || sigStr.length < 10) return alert("backendSig must be a 0x... hex string.");

    await writeContractAsync({
      abi: ESCROW_ABI,
      address: escrowAddr,
      functionName: "resolveDisputeRelease",
      args: [
        tradeId.trim() as `0x${string}`,
        BigInt(expiresStr),
        nonceStr as `0x${string}`,
        sigStr as `0x${string}`,
      ],
    });

    await read.refetch();
  }

  const t = read.data as
    | readonly [string, string, bigint, bigint, bigint, number]
    | undefined;

  const tradeStateNum = t?.[5];
  const isDispute = tradeStateNum === 5;

  return (
    <>
      <Head>
        <title>P2P Escrow MVP</title>
      </Head>

      <main style={{ padding: 32, fontFamily: "system-ui, Arial" }}>
        <h1 style={{ fontSize: 40, marginBottom: 12 }}>P2P Escrow MVP</h1>

        <ConnectButton />

        <div style={{ marginTop: 20, maxWidth: 720 }}>
          <div style={{ marginBottom: 10, color: "#444" }}>
            <div>
              <b>Connected:</b> {isConnected ? "Yes" : "No"}
            </div>
            <div>
              <b>Address:</b> {address ?? "-"}
            </div>
            <div>
              <b>Chain ID:</b> {chainId ?? "-"}
            </div>
            <div>
              <b>Escrow:</b> {ESCROW_ADDRESS}
            </div>
          </div>

          <hr style={{ margin: "18px 0" }} />

          <h2 style={{ fontSize: 20, marginBottom: 8 }}>Create Trade</h2>
          <p style={{ marginTop: 0, color: "#555" }}>
            This calls <b>createTrade()</b>. It only works if your connected wallet is the{" "}
            <b>backend signer</b>.
          </p>

          <div
            style={{
              border: "1px solid #eee",
              borderRadius: 12,
              padding: 12,
              background: "#fafafa",
            }}
          >
            <CreateTrade />
          </div>

          <hr style={{ margin: "18px 0" }} />

          <h2 style={{ fontSize: 20, marginBottom: 8 }}>Trade Lookup</h2>
          <p style={{ marginTop: 0, color: "#555" }}>
            Paste a <b>tradeId (bytes32)</b> from your scripts or from Create Trade.
          </p>

          <input
            value={tradeId}
            onChange={(e) => setTradeId(e.target.value)}
            placeholder="0x... (64 hex chars)"
            style={{
              width: "100%",
              padding: 12,
              fontSize: 14,
              borderRadius: 10,
              border: "1px solid #ddd",
            }}
          />

          <div
            style={{
              marginTop: 8,
              color: tradeId.length === 0 ? "#555" : tradeIdOk ? "green" : "crimson",
            }}
          >
            {tradeId.length === 0 ? "" : tradeIdOk ? "✅ valid bytes32" : "❌ not bytes32"}
          </div>

          <div style={{ marginTop: 16 }}>
            <button
              disabled={!isConnected || isPending || !tradeIdOk}
              onClick={() => read.refetch()}
            >
              Refresh Trade
            </button>{" "}
            <button disabled={!isConnected || isPending || !tradeIdOk} onClick={doDeposit}>
              Deposit (seller)
            </button>{" "}
            <button disabled={!isConnected || isPending || !tradeIdOk} onClick={doRefund}>
              Refund
            </button>{" "}
            <button disabled={!isConnected || isPending || !tradeIdOk} onClick={doDispute}>
              Open Dispute
            </button>
          </div>

          {/* ✅ STEP 5: Resolve dispute UI */}
          <div
            style={{
              marginTop: 18,
              border: "1px solid #eee",
              borderRadius: 12,
              padding: 12,
              background: "#fafafa",
            }}
          >
            <h3 style={{ marginTop: 0, marginBottom: 6 }}>Resolve Dispute (Seller Wins)</h3>

            <div style={{ color: "#666", fontSize: 13, marginBottom: 10 }}>
              Use this only when the trade is in <b>DISPUTE</b>. You must be connected as the{" "}
              <b>backend signer</b>. Generate <b>expiresAt</b>, <b>nonce</b>, and <b>backendSig</b>{" "}
              from your CLI script, then paste here.
            </div>

            <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
              expiresAt (unix seconds)
            </label>
            <input
              value={resolveExpiresAt}
              onChange={(e) => setResolveExpiresAt(e.target.value)}
              placeholder="e.g. 1771763088"
              style={{
                width: "100%",
                padding: 10,
                fontSize: 14,
                borderRadius: 10,
                border: "1px solid #ddd",
                marginBottom: 10,
              }}
            />

            <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
              nonce (bytes32)
            </label>
            <input
              value={resolveNonce}
              onChange={(e) => setResolveNonce(e.target.value)}
              placeholder="0x... (64 hex chars)"
              style={{
                width: "100%",
                padding: 10,
                fontSize: 14,
                borderRadius: 10,
                border: "1px solid #ddd",
                marginBottom: 10,
              }}
            />

            <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
              backendSig (0x...)
            </label>
            <input
              value={resolveSig}
              onChange={(e) => setResolveSig(e.target.value)}
              placeholder="0x..."
              style={{
                width: "100%",
                padding: 10,
                fontSize: 14,
                borderRadius: 10,
                border: "1px solid #ddd",
                marginBottom: 12,
              }}
            />

            <button
              disabled={!isConnected || isPending || !tradeIdOk || !isDispute}
              onClick={doResolveDisputeRelease}
              title={!isDispute ? "Trade must be in DISPUTE state first" : ""}
            >
              Resolve → Seller Wins (Release)
            </button>

            {!t && (
              <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
                Tip: Click <b>Refresh Trade</b> first so the UI knows the current state.
              </div>
            )}

            {t && !isDispute && (
              <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
                Current state is <b>{STATE_LABEL[t[5]] ?? `UNKNOWN(${t[5]})`}</b>. Resolve is only
                enabled in <b>DISPUTE</b>.
              </div>
            )}
          </div>

          <hr style={{ margin: "18px 0" }} />

          <h2 style={{ fontSize: 20, marginBottom: 8 }}>Trade Info</h2>

          {!isConnected && <div>Connect your wallet to continue.</div>}
          {isConnected && !tradeIdOk && <div>Paste a valid tradeId to load trade data.</div>}
          {isConnected && tradeIdOk && read.isLoading && <div>Loading...</div>}

          {isConnected && tradeIdOk && read.error && (
            <div style={{ color: "crimson" }}>
              Error reading trade. (Often means tradeId doesn’t exist yet.)
            </div>
          )}

          {t && (
            <div style={{ lineHeight: 1.8 }}>
              <div>
                <b>Seller:</b> {t[0]}
              </div>
              <div>
                <b>Buyer:</b> {t[1]}
              </div>
              <div>
                <b>Amount:</b> {t[2].toString()}
              </div>
              <div>
                <b>Lock Deadline:</b> {t[3].toString()}
              </div>
              <div>
                <b>Fiat Deadline:</b> {t[4].toString()}
              </div>
              <div>
                <b>State:</b> {STATE_LABEL[t[5]] ?? `UNKNOWN(${t[5]})`}
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}