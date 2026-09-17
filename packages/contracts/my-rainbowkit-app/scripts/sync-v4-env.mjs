#!/usr/bin/env node
// Copies addresses from a DeployV4 run into .env.local (other keys in the file are left untouched).
// Usage: node scripts/sync-v4-env.mjs [path/to/v4-<chainId>.json]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const deployment = process.argv[2] ?? join(here, "../../.deployments/v4-31337.json");
const envFile = join(here, "../.env.local");

if (!existsSync(deployment)) {
  console.error(`No deployment found at ${deployment}. Run packages/contracts/script/DeployV4.s.sol first.`);
  process.exit(1);
}

const d = JSON.parse(readFileSync(deployment, "utf8"));
const updates = {
  NEXT_PUBLIC_CHAIN_ID: String(d.chainId),
  NEXT_PUBLIC_V4_ESCROW: d.escrow,
  NEXT_PUBLIC_V4_USDT: d.usdt,
  NEXT_PUBLIC_V4_PRIMARY_ARBITRATOR: d.primaryArbitrator,
  NEXT_PUBLIC_V4_FALLBACK_ARBITRATOR: d.fallbackArbitrator,
  NEXT_PUBLIC_V4_DEPLOY_BLOCK: String(d.deployBlock ?? 0),
};

let lines = existsSync(envFile) ? readFileSync(envFile, "utf8").replace(/^﻿/, "").split(/\r?\n/) : [];
for (const [key, value] of Object.entries(updates)) {
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
}
if (!lines.some((l) => l.startsWith("NEXT_PUBLIC_NOSTR_RELAYS="))) lines.push("NEXT_PUBLIC_NOSTR_RELAYS=ws://127.0.0.1:7777");
writeFileSync(envFile, lines.filter((l, i, a) => l !== "" || i < a.length - 1).join("\n") + "\n");
console.log(`Updated ${envFile}:`);
for (const [k, v] of Object.entries(updates)) console.log(`  ${k}=${v}`);
console.log("Restart `next dev` to pick up NEXT_PUBLIC_* changes.");
