// src/wagmi.ts — one chain (from config), browser wallets always, WalletConnect wallets when a project id is set.
import { http } from "viem";
import { createConfig } from "wagmi";
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  trustWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { CHAIN, WALLETCONNECT_PROJECT_ID } from "./config/v4";

export const chains = [CHAIN] as const;

const connectors = connectorsForWallets(
  WALLETCONNECT_PROJECT_ID
    ? [
        { groupName: "Popular", wallets: [metaMaskWallet, trustWallet, coinbaseWallet, rainbowWallet] },
        { groupName: "More", wallets: [walletConnectWallet, injectedWallet] },
      ]
    : [{ groupName: "Browser wallets", wallets: [injectedWallet, coinbaseWallet] }],
  { appName: "EscrowX", projectId: WALLETCONNECT_PROJECT_ID || "unset" }
);

export const wagmiConfig = createConfig({
  chains,
  connectors,
  // Public RPC endpoints rate-limit bursts, so reads are batched into as few HTTP requests as possible:
  // eth_calls are aggregated through multicall, the rest are sent as JSON-RPC batches, and failures back off.
  batch: { multicall: { wait: 32 } },
  transports: {
    [CHAIN.id]: http(CHAIN.rpcUrls.default.http[0], {
      batch: { wait: 32 },
      retryCount: 5,
      retryDelay: 400,
      timeout: 20_000,
    }),
  },
  ssr: true,
});
