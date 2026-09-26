// src/config/v4.ts — deployment + network settings for the v4 (non-custodial) protocol.
// Written into .env.local by `npm run sync:v4` (local) or `npm run sync:v4 -- <deployment.json>` (testnet).
// Fallbacks are the deterministic addresses of a fresh Anvil deployment, so builds work without env.

import type { Address, Chain } from "viem";
import { anvil, arbitrumSepolia, baseSepolia, optimismSepolia, polygonAmoy, sepolia } from "viem/chains";

const address = (value: string | undefined, fallback: Address): Address =>
  value && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as Address) : fallback;

const list = (value: string | undefined, fallback: string): string[] =>
  (value || fallback).split(",").map((s) => s.trim()).filter(Boolean);

const SUPPORTED: Chain[] = [anvil, baseSepolia, sepolia, arbitrumSepolia, optimismSepolia, polygonAmoy];

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
const known = SUPPORTED.find((c) => c.id === CHAIN_ID);
if (!known) throw new Error(`Unsupported NEXT_PUBLIC_CHAIN_ID ${CHAIN_ID}`);

/**
 * Default endpoints per chain. Base's own testnet RPC caps eth_getLogs at 1,000 blocks, which makes reading
 * trade history slow; these allow much wider ranges. Override with NEXT_PUBLIC_RPC_URL.
 */
const PREFERRED_RPC: Record<number, string> = {
  [baseSepolia.id]: "https://base-sepolia-rpc.publicnode.com",
  [sepolia.id]: "https://ethereum-sepolia-rpc.publicnode.com",
  [optimismSepolia.id]: "https://optimism-sepolia-rpc.publicnode.com",
  [arbitrumSepolia.id]: "https://arbitrum-sepolia-rpc.publicnode.com",
};

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || PREFERRED_RPC[CHAIN_ID] || known.rpcUrls.default.http[0]!;
export const CHAIN: Chain = { ...known, rpcUrls: { default: { http: [RPC_URL] } } };
export const IS_LOCAL = CHAIN_ID === anvil.id;
export const IS_TESTNET = IS_LOCAL || !!known.testnet;
export const EXPLORER = known.blockExplorers?.default.url ?? null;

export const V4 = {
  escrow: address(process.env.NEXT_PUBLIC_V4_ESCROW, "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9"),
  usdt: address(process.env.NEXT_PUBLIC_V4_USDT, "0x5FbDB2315678afecb367f032d93F642f64180aa3"),
  primaryArbitrator: address(process.env.NEXT_PUBLIC_V4_PRIMARY_ARBITRATOR, "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512"),
  fallbackArbitrator: address(process.env.NEXT_PUBLIC_V4_FALLBACK_ARBITRATOR, "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"),
  deployBlock: BigInt(process.env.NEXT_PUBLIC_V4_DEPLOY_BLOCK ?? "0"),
  tokenSymbol: process.env.NEXT_PUBLIC_V4_TOKEN_SYMBOL || "tUSDT",
  tokenDecimals: 6,
  /** The token has TestUSDT's public faucet() (true for any DeployV4 run that didn't pass TOKEN). */
  tokenFaucet: (process.env.NEXT_PUBLIC_V4_TOKEN_FAUCET ?? "true") === "true",
} as const;

/** Any Nostr relays. EscrowX does not need to operate any of them. */
export const RELAYS: string[] = list(
  process.env.NEXT_PUBLIC_NOSTR_RELAYS,
  IS_LOCAL ? "ws://127.0.0.1:7777" : "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net"
);

/** Optional: enables WalletConnect-based wallets (mobile Trust Wallet, MetaMask Mobile, …). Free at cloud.reown.com. */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

/**
 * Blocks per eth_getLogs request. Endpoints cap this differently, so it's only a starting point: the scanner
 * halves it automatically whenever an endpoint rejects the range (see lib/v4/logs.ts).
 */
export const LOG_CHUNK = BigInt(process.env.NEXT_PUBLIC_LOG_CHUNK || (IS_LOCAL ? "100000" : "50000"));
export const POLL_MS = IS_LOCAL ? 4000 : 8000;

/** Where to get gas on this network. */
export const GAS_FAUCETS: { name: string; url: string }[] =
  CHAIN_ID === baseSepolia.id
    ? [
        { name: "Coinbase (CDP)", url: "https://portal.cdp.coinbase.com/products/faucet" },
        { name: "Superchain", url: "https://console.optimism.io/faucet" },
        { name: "Alchemy", url: "https://www.alchemy.com/faucets/base-sepolia" },
        { name: "QuickNode", url: "https://faucet.quicknode.com/base/sepolia" },
      ]
    : CHAIN_ID === sepolia.id
      ? [
          { name: "Google Cloud", url: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia" },
          { name: "Alchemy", url: "https://www.alchemy.com/faucets/ethereum-sepolia" },
        ]
      : [];

/** Optional display names: "0xabc…=Lagos ADR Chambers,0xdef…=Accra Arbitration". */
const ARBITRATOR_NAMES: Record<string, string> = Object.fromEntries(
  list(process.env.NEXT_PUBLIC_V4_ARBITRATOR_NAMES, "")
    .map((pair) => pair.split("="))
    .filter((p): p is [string, string] => p.length === 2 && /^0x[0-9a-fA-F]{40}$/.test(p[0]!.trim()))
    .map(([a, n]) => [a.trim().toLowerCase(), n.trim()])
);

export function arbitratorName(addr: string): string {
  const named = ARBITRATOR_NAMES[addr.toLowerCase()];
  if (named) return named;
  if (addr.toLowerCase() === V4.primaryArbitrator.toLowerCase()) return IS_TESTNET ? "Demo arbitration firm A" : "Primary arbitration firm";
  if (addr.toLowerCase() === V4.fallbackArbitrator.toLowerCase()) return IS_TESTNET ? "Demo arbitration firm B" : "Fallback arbitration firm";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Every arbitration firm this deployment knows about, primary first. */
export const FIRMS = [V4.primaryArbitrator, V4.fallbackArbitrator] as const;

export const explorerTx = (hash: string) => (EXPLORER ? `${EXPLORER}/tx/${hash}` : null);
export const explorerAddress = (addr: string) => (EXPLORER ? `${EXPLORER}/address/${addr}` : null);

export const FIAT_CURRENCIES = ["NGN", "KES", "GHS", "ZAR", "BRL", "INR"] as const;

/**
 * Where this build is served from, absolute and with a trailing slash.
 *
 * Link previews need it: Open Graph consumers won't resolve a relative og:image, so a WhatsApp or Telegram
 * share falls back to a bare link with no card. Set NEXT_PUBLIC_SITE_URL when deploying anywhere other than
 * the project's GitHub Pages site.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://osas-xlr8.github.io/crypto-escrow-p2p/").replace(/\/?$/, "/");
