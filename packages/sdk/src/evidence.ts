// src/evidence.ts — encrypted payment evidence for disputes.
//
// Flow:
//   1. Buyer encrypts the receipt locally (AES-256-GCM). Only keccak256(ciphertext) — the commitment —
//      goes on-chain via markPaid(tradeId, commitment). The ciphertext can sit anywhere (IPFS, S3, …).
//   2. Nobody can read it until a dispute is assigned. Then the party seals the decryption key to the
//      assigned arbitrator's published key (LicensedArbitratorAdapter.encryptionKey / CaseAssigned).
//   3. The arbitrator opens the key, decrypts, and checks the ciphertext matches the on-chain commitment,
//      so evidence can't be swapped after the fact.

import { hexToBytes, keccak256, toHex, type Hex } from "viem";
import { v2 as nip44 } from "nostr-tools/nip44";
import type { NostrIdentity } from "./types.js";

const IV_BYTES = 12;
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

export interface EncryptedEvidence {
  /** iv (12 bytes) || AES-GCM ciphertext+tag */
  ciphertext: Uint8Array;
  key: Uint8Array;
  /** keccak256(ciphertext) — pass to EscrowCoreV4.markPaid */
  commitment: Hex;
}

export interface SealedEvidenceKey {
  tradeId: string;
  commitment: Hex;
  key: Hex;
  /** Where the ciphertext can be fetched from */
  uri?: string;
  mimeType?: string;
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw new Error("WebCrypto is not available in this environment");
  return globalThis.crypto.subtle;
}

export function evidenceCommitment(ciphertext: Uint8Array): Hex {
  return keccak256(ciphertext);
}

export async function encryptEvidence(plaintext: Uint8Array): Promise<EncryptedEvidence> {
  if (plaintext.length > MAX_EVIDENCE_BYTES) throw new Error("evidence too large");
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const aesKey = await subtle().importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, aesKey, plaintext));
  const ciphertext = new Uint8Array(IV_BYTES + ct.length);
  ciphertext.set(iv, 0);
  ciphertext.set(ct, IV_BYTES);
  return { ciphertext, key, commitment: evidenceCommitment(ciphertext) };
}

/** Throws if the ciphertext doesn't match the expected commitment, or if it was tampered with. */
export async function decryptEvidence(ciphertext: Uint8Array, key: Uint8Array, expectedCommitment?: Hex): Promise<Uint8Array> {
  if (expectedCommitment && evidenceCommitment(ciphertext).toLowerCase() !== expectedCommitment.toLowerCase()) {
    throw new Error("evidence does not match the on-chain commitment");
  }
  if (ciphertext.length <= IV_BYTES) throw new Error("ciphertext too short");
  const aesKey = await subtle().importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const plain = await subtle().decrypt({ name: "AES-GCM", iv: ciphertext.slice(0, IV_BYTES) }, aesKey, ciphertext.slice(IV_BYTES));
  return new Uint8Array(plain);
}

/** Seals the evidence key so only `recipientPubkey` (e.g. the assigned arbitrator) can open it. */
export function sealEvidenceKey(sender: NostrIdentity, recipientPubkey: string, payload: SealedEvidenceKey): string {
  const conversationKey = nip44.utils.getConversationKey(sender.secretKey, recipientPubkey);
  return nip44.encrypt(JSON.stringify({ escrowxEvidence: 1, ...payload }), conversationKey);
}

export function openEvidenceKey(recipient: NostrIdentity, senderPubkey: string, sealed: string): SealedEvidenceKey {
  if (sealed.length > 16_000) throw new Error("sealed payload too large");
  const conversationKey = nip44.utils.getConversationKey(recipient.secretKey, senderPubkey);
  const body = JSON.parse(nip44.decrypt(sealed, conversationKey)) as Record<string, unknown>;
  if (body.escrowxEvidence !== 1 || typeof body.key !== "string" || typeof body.commitment !== "string") {
    throw new Error("not an EscrowX evidence key");
  }
  const { escrowxEvidence: _v, ...payload } = body;
  return payload as unknown as SealedEvidenceKey;
}

export function keyToHex(key: Uint8Array): Hex {
  return toHex(key);
}

export function keyFromHex(hex: Hex): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("evidence key must be 32 bytes");
  return hexToBytes(hex);
}

// ─── Arbitrator key encoding (LicensedArbitratorAdapter.encryptionKey is `bytes`) ─────────────────

export function adapterKeyFromNostrPubkey(pubkey: string): Hex {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("Nostr pubkey must be 64 lowercase hex chars");
  return `0x${pubkey}`;
}

export function nostrPubkeyFromAdapterKey(key: Hex): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("arbitrator encryption key must be a 32-byte x-only pubkey");
  return key.slice(2).toLowerCase();
}

// ─── On-chain evidence pointers (ERC-1497 Evidence event via EscrowCoreV4.submitEvidence) ────────
//
// `escrowx-evidence:v1:<senderNostrPubkey>:<recipientNostrPubkey>:<sealed>`
// The sealed payload holds only an encrypted key + commitment + where the ciphertext lives.
// It is permanent once on-chain, so it must never contain personal data in the clear.

const EVIDENCE_URI_PREFIX = "escrowx-evidence:v1:";

export function formatEvidenceUri(senderPubkey: string, recipientPubkey: string, sealed: string): string {
  for (const k of [senderPubkey, recipientPubkey]) {
    if (!/^[0-9a-f]{64}$/.test(k)) throw new Error("pubkeys must be 64 lowercase hex chars");
  }
  return `${EVIDENCE_URI_PREFIX}${senderPubkey}:${recipientPubkey}:${sealed}`;
}

export function parseEvidenceUri(uri: string): { senderPubkey: string; recipientPubkey: string; sealed: string } | null {
  if (!uri.startsWith(EVIDENCE_URI_PREFIX)) return null;
  const rest = uri.slice(EVIDENCE_URI_PREFIX.length);
  const m = /^([0-9a-f]{64}):([0-9a-f]{64}):(.+)$/s.exec(rest);
  return m ? { senderPubkey: m[1]!, recipientPubkey: m[2]!, sealed: m[3]! } : null;
}
