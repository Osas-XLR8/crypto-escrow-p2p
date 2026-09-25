#!/usr/bin/env node
// Gives each arbitration firm its own panel — and keeps them separate.
//
// A fallback firm with no panelists can receive a case and never assign it, so escalation would only ever end
// on the escrow's timeout. A fallback firm staffed with the SAME panelist as the primary is barely better: the
// case escalates to a different contract but the same judgment. Both firms need someone, and not the same
// someone.
//
//   PRIVATE_KEY=0x… node scripts/staff-firms.mjs [--chain 84532] [--dry-run]
//
// The demo panelists are derived from the deployer key, so re-runs reuse the same people. The key must be the
// firm admin of both adapters (on the demo deployment that is the deployer).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, parseEther, parseAbiItem, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, baseSepolia } from "viem/chains";
import { adapterKeyFromNostrPubkey, deriveNostrIdentity } from "../dist/index.js";
import { getLogsChunked } from "./lib/logs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const contracts = join(here, "../../contracts");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const dryRun = process.argv.includes("--dry-run");
const chainId = Number(arg("chain", "84532"));
const CHAINS = { 84532: baseSepolia, 31337: anvil };
const chain = CHAINS[chainId];
if (!chain) throw new Error(`No chain config for ${chainId}`);
const RPC = arg("rpc", process.env.RPC_URL || chain.rpcUrls.default.http[0]);

const deploymentPath = [join(contracts, `deployments/v4-${chainId}.json`), join(contracts, `.deployments/v4-${chainId}.json`)].find(existsSync);
if (!deploymentPath) throw new Error(`No deployment file for chain ${chainId}`);
const d = JSON.parse(readFileSync(deploymentPath, "utf8"));

function deployerKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;
  if (chainId === 31337) return "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const env = join(contracts, ".env.testnet");
  const line = existsSync(env) && readFileSync(env, "utf8").split(/\r?\n/).find((l) => l.startsWith("PRIVATE_KEY="));
  if (!line) throw new Error("Set PRIVATE_KEY or create packages/contracts/.env.testnet");
  return line.slice("PRIVATE_KEY=".length).trim();
}

const panelistUpdated = parseAbiItem("event PanelistUpdated(address indexed panelist, bool active, bytes key)");
const setPanelist = parseAbiItem("function setPanelist(address panelist, bool active, bytes key)");
const firmAdminFn = parseAbiItem("function firmAdmin() view returns (address)");
const treasuryFn = parseAbiItem("function treasury() view returns (address)");
const setTreasuryFn = parseAbiItem("function setTreasury(address newTreasury)");

const publicClient = createPublicClient({ chain, transport: http(RPC) });
const key = deployerKey();
const deployer = privateKeyToAccount(key);
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });
const derived = (label) => privateKeyToAccount(keccak256(toBytes(`${key}:escrowx-demo-${label}`)));

async function panelOf(address) {
  const logs = await getLogsChunked(publicClient, { address, event: panelistUpdated, fromBlock: BigInt(d.deployBlock ?? 0) });
  const latest = new Map();
  for (const log of logs) latest.set(log.args.panelist.toLowerCase(), { panelist: log.args.panelist, active: log.args.active });
  return [...latest.values()].filter((p) => p.active).map((p) => p.panelist);
}

const FIRMS = [
  { name: "primary", address: d.primaryArbitrator, panelist: derived("panelist"), treasury: derived("treasury-a") },
  { name: "fallback", address: d.fallbackArbitrator, panelist: derived("panelist-b"), treasury: derived("treasury-b") },
];

const GAS_FLOOR = parseEther(chainId === 31337 ? "0.2" : "0.00005");
const GAS_TOPUP = parseEther(chainId === 31337 ? "1" : "0.0002");

for (const firm of FIRMS) {
  const admin = await publicClient.readContract({ address: firm.address, abi: [firmAdminFn], functionName: "firmAdmin" });
  if (admin.toLowerCase() !== deployer.address.toLowerCase()) throw new Error(`${deployer.address} does not run the ${firm.name} firm (admin ${admin})`);

  const current = await panelOf(firm.address);
  const other = FIRMS.find((f) => f !== firm);
  const shared = current.filter((p) => p.toLowerCase() === other.panelist.address.toLowerCase());
  const wanted = firm.panelist.address;
  const alreadyRight = current.some((p) => p.toLowerCase() === wanted.toLowerCase());

  console.log(`${firm.name} firm ${firm.address}`);
  console.log(`   panel now: ${current.length ? current.join(", ") : "(nobody)"}`);
  if (alreadyRight && !shared.length) {
    console.log(`   ✓ staffed with its own panelist`);
    continue;
  }
  if (dryRun) {
    if (!alreadyRight) console.log(`   would add ${wanted}`);
    for (const p of shared) console.log(`   would remove ${p} (also serves the ${other.name} firm)`);
    continue;
  }

  if (!alreadyRight) {
    // The panelist publishes an encryption key so parties can seal evidence to them alone.
    const panelistWallet = createWalletClient({ account: firm.panelist, chain, transport: http(RPC) });
    const identity = await deriveNostrIdentity(panelistWallet, firm.panelist.address);
    const hash = await wallet.writeContract({
      address: firm.address,
      abi: [setPanelist],
      functionName: "setPanelist",
      args: [wanted, true, adapterKeyFromNostrPubkey(identity.publicKey)],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`   + ${wanted} registered with a published key`);

    const balance = await publicClient.getBalance({ address: wanted });
    if (balance < GAS_FLOOR) {
      const funds = await publicClient.getBalance({ address: deployer.address });
      if (funds > GAS_TOPUP * 2n) {
        await publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: wanted, value: GAS_TOPUP }) });
        console.log(`   + ${formatEther(GAS_TOPUP)} ETH so they can actually rule`);
      } else {
        console.log(`   ! the deployer has ${formatEther(funds)} ETH — top it up so this panelist can pay gas`);
      }
    }
  }

  for (const p of shared) {
    const hash = await wallet.writeContract({ address: firm.address, abi: [setPanelist], functionName: "setPanelist", args: [p, false, "0x"] });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`   - ${p} removed (they serve the ${other.name} firm, and a fallback that shares a panel is not a fallback)`);
  }
}

// ─── Who the fees belong to ───────────────────────────────────────────────────
// The key that runs a firm and the account its fees land in should not be the same one: whoever holds the
// admin key already sets the panel and can confirm rulings, which is plenty of authority for one key.

for (const firm of FIRMS) {
  const treasury = await publicClient.readContract({ address: firm.address, abi: [treasuryFn], functionName: "treasury" });
  if (treasury.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log(`${firm.name} treasury: ${treasury} (already separate from the admin)`);
    continue;
  }
  if (dryRun) {
    console.log(`${firm.name} treasury: would move from the admin key to ${firm.treasury.address}`);
    continue;
  }
  const hash = await wallet.writeContract({ address: firm.address, abi: [setTreasuryFn], functionName: "setTreasury", args: [firm.treasury.address] });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${firm.name} treasury: moved off the admin key to ${firm.treasury.address}`);
}

console.log("");
console.log("Final state:");
for (const firm of FIRMS) {
  const treasury = await publicClient.readContract({ address: firm.address, abi: [treasuryFn], functionName: "treasury" });
  console.log(`   ${firm.name}: panel ${(await panelOf(firm.address)).join(", ") || "(nobody)"} · treasury ${treasury}`);
}
