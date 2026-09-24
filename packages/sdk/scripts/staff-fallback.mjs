#!/usr/bin/env node
// Mirrors the primary demo firm's panel onto the fallback firm.
//
// Escalation is only worth offering if the firm it escalates to can rule. On a fresh deployment the fallback
// adapter has no panelists at all, so a party who escalates lands on a firm that can never assign a case — the
// escrow's own timeout is then the only way out. This registers the same panelists (address and encryption key)
// on the fallback firm, so the escalation path terminates somewhere real.
//
//   PRIVATE_KEY=0x… node scripts/staff-fallback.mjs [--chain 84532] [--dry-run]
//
// The key must belong to the firm admin of the fallback adapter (on the demo deployment that's the deployer).

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, foundry } from "viem/chains";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const chainId = Number(arg("chain", 84532));
const dryRun = process.argv.includes("--dry-run");

const CHAINS = { 84532: baseSepolia, 31337: foundry };
const RPCS = { 84532: "https://base-sepolia-rpc.publicnode.com", 31337: "http://127.0.0.1:8545" };
const chain = CHAINS[chainId];
if (!chain) throw new Error(`No chain config for ${chainId}`);

const deployment = JSON.parse(readFileSync(new URL(`../../contracts/deployments/v4-${chainId}.json`, import.meta.url), "utf8"));
const { primaryArbitrator, fallbackArbitrator, deployBlock } = deployment;

const panelistUpdated = parseAbiItem("event PanelistUpdated(address indexed panelist, bool active, bytes key)");
const setPanelist = parseAbiItem("function setPanelist(address panelist, bool active, bytes key)");
const isPanelist = parseAbiItem("function isPanelist(address) view returns (bool)");
const firmAdmin = parseAbiItem("function firmAdmin() view returns (address)");

const publicClient = createPublicClient({ chain, transport: http(RPCS[chainId]) });

/** Public RPCs cap getLogs ranges, so walk the history in chunks. */
async function panelOf(address) {
  const head = await publicClient.getBlockNumber();
  const logs = [];
  for (let from = BigInt(deployBlock ?? 0); from <= head; from += 40_000n) {
    const to = from + 39_999n > head ? head : from + 39_999n;
    logs.push(...(await publicClient.getLogs({ address, event: panelistUpdated, fromBlock: from, toBlock: to })));
  }
  const latest = new Map();
  for (const log of logs) latest.set(log.args.panelist, { active: log.args.active, key: log.args.key });
  return latest;
}

const primary = await panelOf(primaryArbitrator);
const active = [...primary].filter(([, v]) => v.active);
console.log(`primary firm ${primaryArbitrator}: ${active.length} active panelist(s)`);
if (!active.length) {
  console.error("The primary firm has no panel to mirror. Add a panelist there first (arbitration desk → Panel).");
  process.exit(1);
}

const missing = [];
for (const [panelist, v] of active) {
  const already = await publicClient.readContract({ address: fallbackArbitrator, abi: [isPanelist], functionName: "isPanelist", args: [panelist] });
  console.log(`   ${panelist} → fallback: ${already ? "already active" : "missing"}`);
  if (!already) missing.push([panelist, v.key]);
}
if (!missing.length) {
  console.log("Fallback firm is already staffed. Nothing to do.");
  process.exit(0);
}
if (dryRun) {
  console.log(`Would register ${missing.length} panelist(s) on ${fallbackArbitrator}.`);
  process.exit(0);
}

const pk = process.env.PRIVATE_KEY;
if (!pk) throw new Error("PRIVATE_KEY is required to write to the fallback firm");
const account = privateKeyToAccount(pk);
const admin = await publicClient.readContract({ address: fallbackArbitrator, abi: [firmAdmin], functionName: "firmAdmin" });
if (admin.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error(`${account.address} is not the fallback firm's admin (${admin})`);
}

const wallet = createWalletClient({ account, chain, transport: http(RPCS[chainId]) });
for (const [panelist, key] of missing) {
  const hash = await wallet.writeContract({ address: fallbackArbitrator, abi: [setPanelist], functionName: "setPanelist", args: [panelist, true, key] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`registered ${panelist} on the fallback firm (${receipt.status}, ${hash})`);
}
console.log("Fallback firm can now be assigned cases.");
