// src/config/v4.ts — deployment + network settings for the v4 (non-custodial) protocol.
// Written into .env.local by `npm run sync:v4` after running packages/contracts/script/DeployV4.s.sol.
// Fallbacks are the deterministic addresses of a fresh Anvil deployment, so builds work without env.

import type { Address } from "viem";

const address = (value: string | undefined, fallback: Address): Address =>
  value && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as Address) : fallback;

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

export const V4 = {
  escrow: address(process.env.NEXT_PUBLIC_V4_ESCROW, "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9"),
  usdt: address(process.env.NEXT_PUBLIC_V4_USDT, "0x5FbDB2315678afecb367f032d93F642f64180aa3"),
  primaryArbitrator: address(process.env.NEXT_PUBLIC_V4_PRIMARY_ARBITRATOR, "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"),
  fallbackArbitrator: address(process.env.NEXT_PUBLIC_V4_FALLBACK_ARBITRATOR, "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"),
  deployBlock: BigInt(process.env.NEXT_PUBLIC_V4_DEPLOY_BLOCK ?? "0"),
  tokenSymbol: "USDT",
  tokenDecimals: 6,
} as const;

/** Any Nostr relays. EscrowX does not need to operate any of them. */
export const RELAYS: string[] = (process.env.NEXT_PUBLIC_NOSTR_RELAYS ?? "ws://127.0.0.1:7777")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

/** Optional display names: "0xabc…=Lagos ADR Chambers,0xdef…=Accra Arbitration". */
const ARBITRATOR_NAMES: Record<string, string> = Object.fromEntries(
  (process.env.NEXT_PUBLIC_V4_ARBITRATOR_NAMES ?? "")
    .split(",")
    .map((pair) => pair.split("="))
    .filter((p): p is [string, string] => p.length === 2 && /^0x[0-9a-fA-F]{40}$/.test(p[0]!.trim()))
    .map(([a, n]) => [a.trim().toLowerCase(), n.trim()])
);

export function arbitratorName(addr: string): string {
  const named = ARBITRATOR_NAMES[addr.toLowerCase()];
  if (named) return named;
  if (addr.toLowerCase() === V4.primaryArbitrator.toLowerCase()) return "Primary arbitration firm";
  if (addr.toLowerCase() === V4.fallbackArbitrator.toLowerCase()) return "Fallback arbitration firm";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export const FIAT_CURRENCIES = ["NGN", "KES", "GHS", "ZAR", "BRL", "INR"] as const;
