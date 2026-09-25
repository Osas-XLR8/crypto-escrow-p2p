// src/lib/v4/faucet.ts — TestUSDT's public faucet (testnets only).

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { V4 } from "@/config/v4";

export const testTokenAbi = [
  { type: "function", name: "faucet", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "faucetAvailableAt", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "FAUCET_AMOUNT", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export async function faucetAvailableAt(client: PublicClient, account: Address): Promise<number> {
  return Number(await client.readContract({ address: V4.usdt, abi: testTokenAbi, functionName: "faucetAvailableAt", args: [account] }));
}

/** `report` lets the caller show which wait this is in — the wallet's, or the network's. */
export async function claimFaucet(
  publicClient: PublicClient,
  wallet: WalletClient,
  report?: (phase: "checking" | "signing" | "sent", hash?: Hex) => void
): Promise<void> {
  if (!wallet.account) throw new Error("Connect a wallet first");
  report?.("checking");
  const { request } = await publicClient.simulateContract({ address: V4.usdt, abi: testTokenAbi, functionName: "faucet", account: wallet.account });
  report?.("signing");
  const hash = await wallet.writeContract(request);
  report?.("sent", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Faucet transaction reverted");
}
