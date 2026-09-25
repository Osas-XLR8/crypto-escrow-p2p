#!/usr/bin/env node
// Finishes a trade that was deliberately left waiting on a clock.
//
// Two of the escrow's guarantees only exist once their window has actually elapsed, and those windows are
// contract minimums that cannot be shortened on a public network:
//
//   • fee forfeit — a dispute where the other side never matched the arbitration fee (24h), which anyone can
//     then settle in the opener's favour.
//   • escalation  — a dispute the firm never ruled on (7 days), which either party can move to the fallback
//     firm; this script then takes it through the fallback's own panel to a ruling.
//
//   node scripts/finish-timeout.mjs --trade 3 [--chain 84532] [--warp]
//
// Run it any time: if the window isn't up yet it says when it will be, and does nothing.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, parseEther, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, baseSepolia } from "viem/chains";
import { EscrowV4Client, adapterKeyFromNostrPubkey, deriveNostrIdentity, licensedArbitratorAdapterAbi } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const contracts = join(here, "../../contracts");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const chainId = Number(arg("chain", "84532"));
const CHAINS = { 84532: baseSepolia, 31337: anvil };
const chain = CHAINS[chainId];
if (!chain) throw new Error(`No chain config for ${chainId}`);
const WARP = process.argv.includes("--warp");
if (WARP && chainId !== 31337) throw new Error("--warp only works on a local chain you control");
const tradeId = BigInt(arg("trade", "0"));
if (!tradeId) throw new Error("Which trade? Pass --trade <id>");

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

const publicClient = createPublicClient({ chain, transport: http(RPC) });
const key = deployerKey();
const deployer = privateKeyToAccount(key);
const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });
const derived = (label) => privateKeyToAccount(keccak256(toBytes(`${key}:escrowx-demo-${label}`)));
const walletFor = (account) => createWalletClient({ account, chain, transport: http(RPC) });

const record = [];
const EXPLORER = { 84532: "https://base-sepolia.blockscout.com/tx/" }[chainId];
const note = (what, hash) => {
  record.push({ what, hash });
  console.log(`   ${what.padEnd(26)} ${EXPLORER ? EXPLORER + hash : hash}`);
};

async function send(hashPromise, label) {
  const hash = await hashPromise;
  note(label, hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
  for (let i = 0; i < 30; i++) {
    if ((await publicClient.getBlockNumber({ cacheTime: 0 })) >= receipt.blockNumber) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return receipt;
}

async function warpTo(when) {
  const now = Number((await publicClient.getBlock({ blockTag: "latest" })).timestamp);
  if (now >= when) return;
  for (const [method, params] of [["evm_increaseTime", [when - now + 1]], ["evm_mine", []]]) {
    await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  }
}

const client = new EscrowV4Client(publicClient, d.escrow, deployerWallet);
const trade = await client.getTrade(tradeId);
const dispute = await client.getDispute(tradeId);
const arbitrationTimeout = Number(await publicClient.readContract({ address: d.escrow, abi: (await import("../dist/index.js")).escrowCoreV4Abi, functionName: "ARBITRATION_TIMEOUT" }));
const now = Number((await publicClient.getBlock({ blockTag: "latest" })).timestamp);
const when = (ts) => `${new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;
const left = (ts) => `${Math.ceil((ts - now) / 3600)}h`;

const STATE = ["NONE", "LOCKED", "PAID", "FEE_PENDING", "DISPUTED", "RELEASED", "CANCELLED"];
console.log(`Trade #${tradeId} is ${STATE[trade.state]} · buyer ${trade.buyer} · seller ${trade.seller}`);

// ─── Fee forfeit ──────────────────────────────────────────────────────────────

if (trade.state === 3) {
  const deadline = Number(dispute.feeDeadline);
  if (now <= deadline) {
    if (!WARP) {
      console.log(`The other side can still match the fee until ${when(deadline)} (${left(deadline)} left). Nothing to do yet.`);
      process.exit(0);
    }
    await warpTo(deadline + 1);
  }
  console.log(`Fee window closed at ${when(deadline)}; ${dispute.opener} opened it and the other side never matched.`);
  await send(client.claimFeeTimeout(tradeId).then((r) => r.transactionHash), "settle by default");
  const after = await client.getTrade(tradeId);
  console.log(`\nTrade #${tradeId} is now ${STATE[after.state]} — the side that didn't pay lost by default.`);
  console.log(`Buyer fee refund ${formatEther(await client.claimableNative(trade.buyer))} ETH · seller ${formatEther(await client.claimableNative(trade.seller))} ETH`);
  process.exit(0);
}

// ─── Escalation to the fallback firm ──────────────────────────────────────────

if (trade.state === 4) {
  const startedAt = Number(dispute.startedAt);
  const escalateAt = startedAt + arbitrationTimeout;
  if (!dispute.escalated) {
    if (now <= escalateAt) {
      if (!WARP) {
        console.log(`${d.primaryArbitrator} still has until ${when(escalateAt)} (${left(escalateAt)} left) to rule. Nothing to do yet.`);
        process.exit(0);
      }
      await warpTo(escalateAt + 1);
    }
    console.log(`The first firm missed its deadline (${when(escalateAt)}). Moving the case to the fallback firm.`);
    // Either party can do this; use the buyer.
    const buyer = derived("dispute-buyer");
    const buyerClient = new EscrowV4Client(publicClient, d.escrow, walletFor(buyer));
    buyerClient.onActivity((e) => e.phase === "sent" && note("buyer: escalate", e.hash));
    await buyerClient.escalateToFallback(tradeId);
  }

  // The fallback firm now has the case: assign, rule, execute — with its own panel.
  const fresh = await client.getDispute(tradeId);
  const firm = d.fallbackArbitrator;
  const disputeId = fresh.disputeId;
  const panelist = derived("panelist-b");
  const panelistIdentity = await deriveNostrIdentity(walletFor(panelist), panelist.address);
  // A panelist who can't pay gas can't rule, which would strand the case just as surely as an empty panel.
  const floor = parseEther(chainId === 31337 ? "0.2" : "0.00005");
  if ((await publicClient.getBalance({ address: panelist.address })) < floor) {
    await send(deployerWallet.sendTransaction({ to: panelist.address, value: parseEther(chainId === 31337 ? "1" : "0.0002") }), "fund fallback panelist");
  }
  const registered = await publicClient.readContract({ address: firm, abi: licensedArbitratorAdapterAbi, functionName: "isPanelist", args: [panelist.address] });
  if (!registered) {
    await send(
      deployerWallet.writeContract({ address: firm, abi: licensedArbitratorAdapterAbi, functionName: "setPanelist", args: [panelist.address, true, adapterKeyFromNostrPubkey(panelistIdentity.publicKey)] }),
      "fallback: add panelist"
    );
  }
  const c = await publicClient.readContract({ address: firm, abi: licensedArbitratorAdapterAbi, functionName: "getCase", args: [disputeId] });
  if (c.assignee === "0x0000000000000000000000000000000000000000") {
    await send(deployerWallet.writeContract({ address: firm, abi: licensedArbitratorAdapterAbi, functionName: "assign", args: [disputeId, panelist.address] }), "fallback: assign panelist");
  }
  if (!c.hasProposal) {
    await send(
      walletFor(panelist).writeContract({
        address: firm,
        abi: licensedArbitratorAdapterAbi,
        functionName: "proposeRuling",
        args: [disputeId, 1n, keccak256(toBytes(`Escalated case ${disputeId}: the first firm never ruled. On the evidence filed, ruling for the buyer.`))],
      }),
      "fallback panelist: rule"
    );
  }
  // The firm can confirm its panelist's ruling immediately (it didn't write it), but an older deployment may
  // still hold everything to the full review window.
  const adapter = { address: firm, abi: licensedArbitratorAdapterAbi };
  try {
    await publicClient.simulateContract({ ...adapter, functionName: "executeRuling", args: [disputeId], account: deployer });
  } catch (e) {
    const reviewPeriod = Number(await publicClient.readContract({ ...adapter, functionName: "REVIEW_PERIOD" }));
    const proposedAt = Number((await publicClient.readContract({ ...adapter, functionName: "getCase", args: [disputeId] })).proposedAt);
    const executableAt = proposedAt + reviewPeriod;
    if (!WARP) {
      console.log(`
Ruling proposed. The firm's review window runs until ${when(executableAt)} — run this again after that to execute it.`);
      throw new Error("review period still running");
    }
    await warpTo(executableAt + 1);
  }
  await send(deployerWallet.writeContract({ ...adapter, functionName: "executeRuling", args: [disputeId] }), "fallback: execute ruling");

  const after = await client.getTrade(tradeId);
  console.log(`\nTrade #${tradeId} is now ${STATE[after.state]}, decided by the fallback firm after the first one went quiet.`);
  process.exit(0);
}

console.log(`Nothing here is waiting on a clock (state ${STATE[trade.state]}).`);
