#!/usr/bin/env node
// Copies addresses from a DeployV4 run into .env.local (other keys in the file are left untouched).
// Usage:
//   node scripts/sync-v4-env.mjs                 local Anvil (.deployments/v4-31337.json)
//   node scripts/sync-v4-env.mjs 84532           a public deployment (deployments/v4-84532.json)
//   node scripts/sync-v4-env.mjs path/to/v4.json any deployment file

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contracts = join(here, "../..");
const arg = process.argv[2] ?? "31337";
const candidates = /^\d+$/.test(arg)
  ? [join(contracts, `deployments/v4-${arg}.json`), join(contracts, `.deployments/v4-${arg}.json`)]
  : [arg];
const deployment = candidates.find((p) => existsSync(p));
const envFile = join(here, "../.env.local");

if (!deployment) {
  console.error(`No deployment found (looked in ${candidates.join(", ")}). Run packages/contracts/script/DeployV4.s.sol first.`);
  process.exit(1);
}

const d = JSON.parse(readFileSync(deployment, "utf8"));
const local = Number(d.chainId) === 31337;
const updates = {
  NEXT_PUBLIC_CHAIN_ID: String(d.chainId),
  NEXT_PUBLIC_V4_ESCROW: d.escrow,
  NEXT_PUBLIC_V4_USDT: d.usdt,
  NEXT_PUBLIC_V4_PRIMARY_ARBITRATOR: d.primaryArbitrator,
  NEXT_PUBLIC_V4_FALLBACK_ARBITRATOR: d.fallbackArbitrator,
  NEXT_PUBLIC_V4_DEPLOY_BLOCK: String(d.deployBlock ?? 0),
  NEXT_PUBLIC_V4_TOKEN_FAUCET: String(d.tokenFaucet ?? true),
  NEXT_PUBLIC_V4_TOKEN_SYMBOL: d.tokenSymbol ?? "tUSDT",
};

let lines = existsSync(envFile) ? readFileSync(envFile, "utf8").replace(/^﻿/, "").split(/\r?\n/) : [];
for (const [key, value] of Object.entries(updates)) {
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
}
// Relays and RPC follow the network: the app's defaults are right for both local and public chains,
// so drop a leftover localhost value when switching to a public network.
if (!local) lines = lines.filter((l) => !/^NEXT_PUBLIC_(NOSTR_RELAYS|RPC_URL)=.*(127\.0\.0\.1|localhost)/.test(l));
writeFileSync(envFile, lines.filter((l, i, a) => l !== "" || i < a.length - 1).join("\n") + "\n");
console.log(`Updated ${envFile} from ${deployment}:`);
for (const [k, v] of Object.entries(updates)) console.log(`  ${k}=${v}`);
console.log("Restart `next dev` to pick up NEXT_PUBLIC_* changes.");
