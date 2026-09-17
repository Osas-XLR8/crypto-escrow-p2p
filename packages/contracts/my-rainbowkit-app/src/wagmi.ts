// src/wagmi.ts
import { http } from "viem";
import { createConfig } from "wagmi";
import { anvil } from "wagmi/chains";
import { RPC_URL } from "./config/v4";

export const chains = [anvil] as const;

export const wagmiConfig = createConfig({
  chains,
  transports: {
    [anvil.id]: http(RPC_URL),
  },
  ssr: true,
});
