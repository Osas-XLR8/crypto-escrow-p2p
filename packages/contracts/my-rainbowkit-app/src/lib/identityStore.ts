// src/lib/identityStore.ts — keep the messaging key alive across reloads and tabs.
//
// The Nostr key is derived from a wallet signature. Re-deriving it is deterministic but costs a signature
// prompt, and losing it mid-trade hides the payment details the buyer needs, so signing three or four times
// in a session is not a nuisance — it's the thing that breaks a trade.
//
// Two retentions, both scoped to the connected wallet:
//   "session"  (default) sessionStorage: survives reloads and redirects, dies when the tab closes.
//   "device"             localStorage with an expiry: survives restarts, for your own machine only.
// A new tab asks the tabs already open for the key over a same-origin BroadcastChannel, so opening the
// arbitration desk in a second tab doesn't re-prompt — and nothing extra is written to disk to make that work.

import type { NostrIdentity, WalletBinding } from "@escrowx/sdk";

export type Retention = "session" | "device";

export const DEVICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CHANNEL = "escrowx:messaging";
const storageKey = (address: string) => `escrowx:messaging:${address.toLowerCase()}`;
const retentionKey = "escrowx:messaging:retention";

interface Stored {
  publicKey: string;
  secretKey: string; // hex
  binding: WalletBinding;
  expires: number; // epoch ms; 0 = as long as the tab lives
}

export interface HeldIdentity {
  identity: NostrIdentity;
  binding: WalletBinding;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function encode(held: HeldIdentity, expires: number): Stored {
  return { publicKey: held.identity.publicKey, secretKey: toHex(held.identity.secretKey), binding: held.binding, expires };
}

function decode(raw: string): { held: HeldIdentity; expires: number } | null {
  try {
    const s = JSON.parse(raw) as Stored;
    if (!s?.secretKey || !s.publicKey || !s.binding) return null;
    if (s.expires && Date.now() > s.expires) return null;
    return { held: { identity: { publicKey: s.publicKey, secretKey: fromHex(s.secretKey) }, binding: s.binding }, expires: s.expires };
  } catch {
    return null;
  }
}

/** The retention the user last chose. Defaults to the tab-scoped one. */
export function preferredRetention(): Retention {
  try {
    return localStorage.getItem(retentionKey) === "device" ? "device" : "session";
  } catch {
    return "session";
  }
}

export function saveIdentity(address: string, held: HeldIdentity, retention: Retention): void {
  const expires = retention === "device" ? Date.now() + DEVICE_RETENTION_MS : 0;
  const body = JSON.stringify(encode(held, expires));
  try {
    localStorage.setItem(retentionKey, retention);
    sessionStorage.setItem(storageKey(address), body);
    if (retention === "device") localStorage.setItem(storageKey(address), body);
    else localStorage.removeItem(storageKey(address));
  } catch {
    /* private mode or storage disabled: the key simply stays in memory */
  }
}

export function loadIdentity(address: string): HeldIdentity | null {
  const k = storageKey(address);
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem(k);
      if (!raw) continue;
      const decoded = decode(raw);
      if (decoded) return decoded.held;
      store.removeItem(k); // expired or corrupt
    } catch {
      /* ignore this store */
    }
  }
  return null;
}

export function clearIdentity(address: string): void {
  try {
    sessionStorage.removeItem(storageKey(address));
    localStorage.removeItem(storageKey(address));
  } catch {
    /* nothing to clear */
  }
}

/** True when the key outlives this tab, which is worth saying out loud in the UI. */
export function isKeptOnDevice(address: string): boolean {
  try {
    return !!localStorage.getItem(storageKey(address));
  } catch {
    return false;
  }
}

type Wire = { t: "need"; address: string } | { t: "have"; address: string; body: string };

function channel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

/** Ask the other tabs on this origin for the key, so a second tab doesn't re-prompt. */
export function requestFromOtherTabs(address: string, timeoutMs = 400): Promise<HeldIdentity | null> {
  const bc = channel();
  if (!bc) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (held: HeldIdentity | null) => {
      clearTimeout(timer);
      bc.close();
      resolve(held);
    };
    bc.onmessage = (ev: MessageEvent<Wire>) => {
      const msg = ev.data;
      if (msg?.t !== "have" || msg.address.toLowerCase() !== address.toLowerCase()) return;
      done(decode(msg.body)?.held ?? null);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    bc.postMessage({ t: "need", address } satisfies Wire);
  });
}

/** Answer those requests while this tab holds a key. Returns an unsubscribe. */
export function serveOtherTabs(address: string, held: HeldIdentity): () => void {
  const bc = channel();
  if (!bc) return () => {};
  const body = JSON.stringify(encode(held, 0));
  bc.onmessage = (ev: MessageEvent<Wire>) => {
    const msg = ev.data;
    if (msg?.t === "need" && msg.address.toLowerCase() === address.toLowerCase()) {
      bc.postMessage({ t: "have", address, body } satisfies Wire);
    }
  };
  return () => bc.close();
}
