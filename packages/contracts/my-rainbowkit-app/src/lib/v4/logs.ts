// src/lib/v4/logs.ts — history scanning that survives whatever the RPC endpoint allows.
//
// Public endpoints cap eth_getLogs ranges (Base's own caps at 1,000 blocks; publicnode allows 50,000+), and
// they don't agree on how to say so. This scans in chunks, halves the chunk whenever an endpoint rejects the
// range, and remembers what worked for the rest of the session.

import type { AbiEvent, Address, PublicClient } from "viem";
import { LOG_CHUNK } from "@/config/v4";

const MIN_CHUNK = 500n;
let chunk = LOG_CHUNK;

/** True for "your range is too wide" style errors, which differ per provider. */
function isRangeError(e: unknown): boolean {
  const text = `${(e as { details?: string })?.details ?? ""} ${(e as Error)?.message ?? ""}`.toLowerCase();
  return /range|block range|too many blocks|limited to|exceed|too large|query returned more than/.test(text);
}

export interface ScanRequest {
  address: Address;
  events?: AbiEvent[];
  event?: AbiEvent;
  fromBlock: bigint;
  toBlock: bigint;
}

/** Fetches logs across a block span, adapting the chunk size to the endpoint's limit. */
export async function scanLogs<T>(client: PublicClient, req: ScanRequest): Promise<T[]> {
  const out: T[] = [];
  let from = req.fromBlock;
  while (from <= req.toBlock) {
    const to = from + chunk - 1n < req.toBlock ? from + chunk - 1n : req.toBlock;
    try {
      const logs = await client.getLogs({
        address: req.address,
        ...(req.events ? { events: req.events } : {}),
        ...(req.event ? { event: req.event } : {}),
        fromBlock: from,
        toBlock: to,
      } as never);
      out.push(...(logs as unknown as T[]));
      from = to + 1n;
    } catch (e) {
      if (!isRangeError(e) || chunk <= MIN_CHUNK) throw e;
      chunk = chunk / 2n > MIN_CHUNK ? chunk / 2n : MIN_CHUNK;
      // retry the same `from` with the smaller chunk
    }
  }
  return out;
}

/** The chunk size currently known to work (for diagnostics). */
export const currentChunk = () => chunk;
