// src/context/EscrowX.tsx — shared protocol clients and the user's messaging identity.
//
// The Nostr secret key is derived from a wallet signature and kept in memory only; it's gone on reload
// or account switch and re-derived (same key) with one signature. Only the public wallet binding is cached.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { Address } from "viem";
import { SimplePool } from "nostr-tools/pool";
import {
  EscrowV4Client,
  OfferBook,
  createBinding,
  deriveNostrIdentity,
  verifyBinding,
  type NostrIdentity,
  type WalletBinding,
} from "@escrowx/sdk";
import { RELAYS, V4 } from "@/config/v4";

interface EscrowXContextValue {
  address?: Address;
  client: EscrowV4Client | null;
  pool: SimplePool | null;
  book: OfferBook | null;
  identity: NostrIdentity | null;
  binding: WalletBinding | null;
  unlocking: boolean;
  unlockError: string | null;
  unlockMessaging: () => Promise<{ identity: NostrIdentity; binding: WalletBinding } | null>;
}

const Ctx = createContext<EscrowXContextValue | null>(null);

const bindingKey = (address: string) => `escrowx:binding:${address.toLowerCase()}`;

function readCachedBinding(address: string): WalletBinding | null {
  try {
    const raw = localStorage.getItem(bindingKey(address));
    return raw ? (JSON.parse(raw) as WalletBinding) : null;
  } catch {
    return null;
  }
}

export function EscrowXProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [pool, setPool] = useState<SimplePool | null>(null);
  const [identity, setIdentity] = useState<NostrIdentity | null>(null);
  const [binding, setBinding] = useState<WalletBinding | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  // Relay connections only exist in the browser.
  useEffect(() => {
    const p = new SimplePool();
    setPool(p);
    return () => p.destroy();
  }, []);

  // Forget the identity whenever the wallet changes.
  useEffect(() => {
    setIdentity(null);
    setBinding(null);
    setUnlockError(null);
  }, [address]);

  const client = useMemo(
    () => (publicClient ? new EscrowV4Client(publicClient as never, V4.escrow, (walletClient ?? undefined) as never) : null),
    [publicClient, walletClient]
  );

  const book = useMemo(
    () => (pool ? new OfferBook(RELAYS, { escrow: V4.escrow, publicClient: publicClient as never }, pool) : null),
    [pool, publicClient]
  );

  const unlockMessaging = useCallback(async () => {
    if (!walletClient || !address) {
      setUnlockError("Connect a wallet first");
      return null;
    }
    setUnlocking(true);
    setUnlockError(null);
    try {
      const id = await deriveNostrIdentity(walletClient as never, address);
      let b = readCachedBinding(address);
      if (!b || b.nostrPubkey !== id.publicKey || !(await verifyBinding(b))) {
        b = await createBinding(walletClient as never, address, id.publicKey);
        try {
          localStorage.setItem(bindingKey(address), JSON.stringify(b));
        } catch {
          /* storage unavailable: re-sign next time */
        }
      }
      setIdentity(id);
      setBinding(b);
      return { identity: id, binding: b };
    } catch (e) {
      setUnlockError((e as Error).message?.split("\n")[0] ?? "Signature rejected");
      return null;
    } finally {
      setUnlocking(false);
    }
  }, [walletClient, address]);

  const value = useMemo<EscrowXContextValue>(
    () => ({ address, client, pool, book, identity, binding, unlocking, unlockError, unlockMessaging }),
    [address, client, pool, book, identity, binding, unlocking, unlockError, unlockMessaging]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEscrowX(): EscrowXContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useEscrowX must be used inside EscrowXProvider");
  return v;
}
