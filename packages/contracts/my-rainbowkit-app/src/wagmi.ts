// src/wagmi.ts
import { http } from "viem";
import { createConfig } from "wagmi";
import { anvil } from "wagmi/chains";

export const chains = [anvil] as const;

export const wagmiConfig = createConfig({
  chains,
  transports: {
    [anvil.id]: http("http://127.0.0.1:8545"),
  },
  ssr: true,
});
