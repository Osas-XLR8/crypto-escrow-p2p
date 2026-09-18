// src/pages/_app.tsx
import type { AppProps } from "next/app";

import "@rainbow-me/rainbowkit/styles.css";
import "@/styles/app.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";

import { wagmiConfig } from "../wagmi";
import { EscrowXProvider } from "@/context/EscrowX";
import { ThemeProvider, useTheme } from "@/context/Theme";

const queryClient = new QueryClient();

const shared = { borderRadius: "medium", fontStack: "system", overlayBlur: "small" } as const;
const rkDark = darkTheme({ ...shared, accentColor: "#3ddc84", accentColorForeground: "#03170b" });
const rkLight = lightTheme({ ...shared, accentColor: "#0b8a4f", accentColorForeground: "#ffffff" });

function Providers({ children }: { children: React.ReactNode }) {
  const { resolved } = useTheme();
  return (
    <RainbowKitProvider theme={resolved === "dark" ? rkDark : rkLight} modalSize="compact">
      <EscrowXProvider>{children}</EscrowXProvider>
    </RainbowKitProvider>
  );
}

export default function App({ Component, pageProps }: AppProps) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Providers>
            <Component {...pageProps} />
          </Providers>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
