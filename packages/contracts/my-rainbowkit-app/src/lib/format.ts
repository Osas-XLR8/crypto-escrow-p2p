// src/lib/format.ts
import { formatUnits } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000";

export function fmtUSDT(raw: bigint) {
  return parseFloat(formatUnits(raw, 6)).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 6,
  });
}

export function fmtTs(ts: bigint | number | undefined) {
  if (!ts) return "—";
  return new Date(Number(ts) * 1000).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function fmtDuration(secs: number) {
  if (secs <= 0) return "now";
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${Math.max(m, 1)}m`;
}

/** "3m ago" style relative time. */
export function fmtAgo(ts: number | undefined, now: number) {
  if (!ts) return "";
  const diff = now - ts;
  if (diff < 45) return "just now";
  return `${fmtDuration(diff)} ago`;
}

export function sameAddr(a?: string, b?: string) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function shortAddr(addr: string) {
  if (!addr || addr === ZERO) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function shortHash(hash: string) {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}
