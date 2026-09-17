// src/identity.ts — Nostr messaging identity derived from a wallet, and wallet↔Nostr bindings.
//
// Users never manage a second key: the Nostr secret is derived from a wallet signature over a fixed
// message. This relies on deterministic ECDSA signing (RFC 6979), which standard EOA wallets and
// hardware wallets use. Smart-contract wallets need a stored Nostr key instead (not handled here).

import { concat, getAddress, keccak256, toBytes, toHex, verifyMessage, type Address, type Hex, type PublicClient } from "viem";
import { getPublicKey } from "nostr-tools/pure";
import type { MessageSigner, NostrIdentity, WalletBinding } from "./types.js";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const DERIVATION_TAG = toBytes("escrowx-nostr-key-v1");

export function keyDerivationMessage(address: Address): string {
  return [
    "EscrowX messaging key (v1)",
    "",
    "Sign to unlock your end-to-end encrypted EscrowX trade chat.",
    "This signature costs no gas and cannot move your funds.",
    "Only sign this on an app you trust: it controls who can read your trade messages.",
    "",
    `Wallet: ${getAddress(address)}`,
  ].join("\n");
}

/** Derives the wallet's Nostr identity. The derivation signature itself must never be published. */
export async function deriveNostrIdentity(signer: MessageSigner, address: Address): Promise<NostrIdentity> {
  const signature = await signer.signMessage({ message: keyDerivationMessage(address) });
  return nostrIdentityFromSignature(signature);
}

export function nostrIdentityFromSignature(signature: Hex): NostrIdentity {
  const digest = BigInt(keccak256(concat([DERIVATION_TAG, signature])));
  const scalar = (digest % (SECP256K1_N - 1n)) + 1n; // uniform enough, never zero, always < n
  const secretKey = toBytes(toHex(scalar, { size: 32 }));
  return { secretKey, publicKey: getPublicKey(secretKey) };
}

export function bindingMessage(address: Address, nostrPubkey: string, issuedAt: number): string {
  return [
    "EscrowX identity binding (v1)",
    "",
    "This Nostr key may send and receive trade messages for this wallet.",
    "",
    `Wallet: ${getAddress(address)}`,
    `Nostr key: ${nostrPubkey.toLowerCase()}`,
    `Issued at: ${issuedAt}`,
  ].join("\n");
}

export async function createBinding(
  signer: MessageSigner,
  address: Address,
  nostrPubkey: string,
  issuedAt = Math.floor(Date.now() / 1000)
): Promise<WalletBinding> {
  if (!/^[0-9a-f]{64}$/.test(nostrPubkey)) throw new Error("nostrPubkey must be 64 lowercase hex chars");
  const signature = await signer.signMessage({ message: bindingMessage(address, nostrPubkey, issuedAt) });
  return { address: getAddress(address), nostrPubkey, issuedAt, signature };
}

/** With a client, ERC-1271 wallets are also supported. */
export async function verifyBinding(binding: WalletBinding, publicClient?: PublicClient): Promise<boolean> {
  if (!binding || typeof binding !== "object") return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(binding.address ?? "")) return false;
  if (!/^[0-9a-f]{64}$/.test(binding.nostrPubkey ?? "")) return false;
  if (!Number.isInteger(binding.issuedAt)) return false;
  const args = {
    address: binding.address,
    message: bindingMessage(binding.address, binding.nostrPubkey, binding.issuedAt),
    signature: binding.signature,
  };
  try {
    return publicClient ? await publicClient.verifyMessage(args) : await verifyMessage(args);
  } catch {
    return false;
  }
}

export function sameAddress(a?: string, b?: string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
