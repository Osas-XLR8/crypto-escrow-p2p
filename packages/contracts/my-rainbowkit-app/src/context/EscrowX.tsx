// src/context/EscrowX.tsx — shared protocol clients and the user's messaging identity.
//
// The Nostr secret key is derived from a wallet signature (deterministically, so the same wallet always gets
// the same key). It is held for the tab and, if you ask for it, for the device — see lib/identityStore — so a
// reload or a second tab doesn't cost another signature and doesn't lock you out of your own trade chat.
// Only the public wallet binding is cached unconditionally.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import {
  clearIdentity,
  isKeptOnDevice,
  loadIdentity,
  preferredRetention,
  requestFromOtherTabs,
  saveIdentity,
  serveOtherTabs,
  type Retention,
} from "@/lib/identityStore";

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
  /** Forget the messaging key everywhere on this browser. */
  lockMessaging: () => void;
  /** How long an unlocked key is kept: this tab, or this device for a week. */
  retention: Retention;
  setRetention: (r: Retention) => void;
  keptOnDevice: boolean;
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
  const [retention, setRetentionState] = useState<Retention>("session");
  const [keptOnDevice, setKeptOnDevice] = useState(false);

  // Relay connections only exist in the browser.
  useEffect(() => {
    const p = new SimplePool();
    setPool(p);
    return () => p.destroy();
  }, []);

  useEffect(() => setRetentionState(preferredRetention()), []);

  // Pick the key back up on a reload, or from another tab that already has it. Both are the same wallet's own
  // key: this never produces a key the user didn't unlock themselves.
  useEffect(() => {
    setIdentity(null);
    setBinding(null);
    setUnlockError(null);
    setKeptOnDevice(false);
    if (!address) return;
    let live = true;
    const adopt = (held: { identity: NostrIdentity; binding: WalletBinding } | null) => {
      if (!live || !held) return false;
      setIdentity(held.identity);
      setBinding(held.binding);
      setKeptOnDevice(isKeptOnDevice(address));
      return true;
    };
    if (!adopt(loadIdentity(address))) {
      void requestFromOtherTabs(address).then((held) => {
        if (adopt(held) && held) saveIdentity(address, held, "session");
      });
    }
    return () => {
      live = false;
    };
  }, [address]);

  // Hand the key to tabs that open later.
  useEffect(() => {
    if (!address || !identity || !binding) return;
    return serveOtherTabs(address, { identity, binding });
  }, [address, identity, binding]);

  const client = useMemo(
    () => (publicClient ? new EscrowV4Client(publicClient as never, V4.escrow, (walletClient ?? undefined) as never) : null),
    [publicClient, walletClient]
  );

  const book = useMemo(
    () => (pool ? new OfferBook(RELAYS, { escrow: V4.escrow, publicClient: publicClient as never }, pool) : null),
    [pool, publicClient]
  );

  // Kept in a ref so unlockMessaging doesn't get a new identity on every retention change.
  const retentionRef = useRef(retention);
  retentionRef.current = retention;

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
      saveIdentity(address, { identity: id, binding: b }, retentionRef.current);
      setKeptOnDevice(isKeptOnDevice(address));
      return { identity: id, binding: b };
    } catch (e) {
      setUnlockError((e as Error).message?.split("\n")[0] ?? "Signature rejected");
      return null;
    } finally {
      setUnlocking(false);
    }
  }, [walletClient, address]);

  const lockMessaging = useCallback(() => {
    if (address) clearIdentity(address);
    setIdentity(null);
    setBinding(null);
    setKeptOnDevice(false);
  }, [address]);

  const setRetention = useCallback(
    (r: Retention) => {
      setRetentionState(r);
      if (address && identity && binding) {
        saveIdentity(address, { identity, binding }, r);
        setKeptOnDevice(isKeptOnDevice(address));
      } else {
        try {
          localStorage.setItem("escrowx:messaging:retention", r);
        } catch {
          /* ignore */
        }
      }
    },
    [address, identity, binding]
  );

  const value = useMemo<EscrowXContextValue>(
    () => ({
      address,
      client,
      pool,
      book,
      identity,
      binding,
      unlocking,
      unlockError,
      unlockMessaging,
      lockMessaging,
      retention,
      setRetention,
      keptOnDevice,
    }),
    [address, client, pool, book, identity, binding, unlocking, unlockError, unlockMessaging, lockMessaging, retention, setRetention, keptOnDevice]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEscrowX(): EscrowXContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useEscrowX must be used inside EscrowXProvider");
  return v;
}
