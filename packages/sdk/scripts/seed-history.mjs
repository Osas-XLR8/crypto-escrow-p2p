#!/usr/bin/env node
// Gives the demo market a trading history, by trading.
//
// Reputation on this app is derived from the escrow's own events, so the only way to have any is to do the
// trades. On a fresh deployment every maker reads "no trades here yet", which is honest and makes a working
// market look abandoned — and leaves the one signal that separates a new wallet from a busy merchant flat for
// everyone. This runs real trades between the demo wallets until they have a spread of histories worth
// looking at: some deep, some thin, one with a dispute it lost.
//
//   npm run build && npm run seed:history                 # Base Sepolia
//   node scripts/seed-history.mjs --chain 31337           # local Anvil
//   … --scale 0.5                                         # fewer trades (they cost time, not much else)
//
// Everything here is a genuine trade between wallets this repo controls, on a test network. It is demo data
// in the only sense that matters: the counterparties are ours. The events are real.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, erc20Abi, formatEther, http, keccak256, parseEther, parseUnits, toBytes, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, baseSepolia } from "viem/chains";
import { EscrowV4Client, createOffer, signOffer } from "../dist/index.js";

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
const scale = Number(arg("scale", "1"));
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
if ((await publicClient.getChainId()) !== chainId) throw new Error(`RPC is not on chain ${chainId}`);

const key = deployerKey();
const deployer = privateKeyToAccount(key);
const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });
const derived = (label) => privateKeyToAccount(keccak256(toBytes(`${key}:escrowx-demo-${label}`)));
const walletFor = (account) => createWalletClient({ account, chain, transport: http(RPC) });

const AMOUNT = parseUnits("1", 6); // one token per trade: history is about counts, not size
const GAS_FLOOR = parseEther(chainId === 31337 ? "0.2" : "0.00008");
const GAS_TOPUP = parseEther(chainId === 31337 ? "1" : "0.0004");
const mintAbi = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }];

/** Who trades with whom, and how much history each ends up with. Distinct pairs so the runs don't queue. */
const SERIES = [
  { seller: "seller-1", buyer: "buyer-1", trades: Math.max(1, Math.round(24 * scale)), note: "a merchant people have used" },
  { seller: "seller-2", buyer: "buyer-2", trades: Math.max(1, Math.round(9 * scale)), note: "a regular" },
  { seller: "seller-3", buyer: "buyer-3", trades: Math.max(1, Math.round(3 * scale)), note: "nearly new" },
];

// The series run in parallel, but they all draw on one deployer account: its transactions have to queue, or
// they collide on the same nonce.
let deployerQueue = Promise.resolve();
function fromDeployer(fn) {
  const run = deployerQueue.then(fn);
  deployerQueue = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function topUp(account) {
  if ((await publicClient.getBalance({ address: account.address })) >= GAS_FLOOR) return;
  const funds = await publicClient.getBalance({ address: deployer.address });
  if (funds < GAS_TOPUP * 3n) throw new Error(`The deployer has ${formatEther(funds)} ETH — top it up from a faucet first.`);
  await fromDeployer(async () => {
    const hash = await deployerWallet.sendTransaction({ to: account.address, value: GAS_TOPUP });
    await publicClient.waitForTransactionReceipt({ hash });
  });
}

/** One seller's run of identical trades with one buyer, taken one at a time from a single signed offer. */
async function runSeries({ seller: sellerLabel, buyer: buyerLabel, trades, note }) {
  const seller = derived(sellerLabel);
  const buyer = derived(buyerLabel);
  const sellerClient = new EscrowV4Client(publicClient, d.escrow, walletFor(seller));
  const buyerClient = new EscrowV4Client(publicClient, d.escrow, walletFor(buyer));
  const needed = AMOUNT * BigInt(trades);

  await topUp(seller);
  await topUp(buyer);

  const free = await sellerClient.freeBalance(seller.address, d.usdt);
  if (free < needed) {
    const shortfall = needed - free;
    const held = await publicClient.readContract({ address: d.usdt, abi: erc20Abi, functionName: "balanceOf", args: [seller.address] });
    if (held < shortfall) {
      await fromDeployer(async () => {
        const hash = await deployerWallet.writeContract({ address: d.usdt, abi: mintAbi, functionName: "mint", args: [seller.address, shortfall - held] });
        await publicClient.waitForTransactionReceipt({ hash });
      });
      for (let i = 0; i < 20; i++) {
        if ((await publicClient.readContract({ address: d.usdt, abi: erc20Abi, functionName: "balanceOf", args: [seller.address] })) >= shortfall) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await sellerClient.deposit(d.usdt, shortfall);
  }

  // One signed offer, filled `trades` times: each fill is its own trade, which is what history is made of.
  const offer = createOffer({
    seller: seller.address,
    token: d.usdt,
    minAmount: AMOUNT,
    maxAmount: AMOUNT,
    totalAmount: needed,
    paymentWindow: 600n,
    releaseWindow: 1800n,
    arbitrator: d.primaryArbitrator,
    fallbackArbitrator: d.fallbackArbitrator,
    nonce: await sellerClient.makerNonce(seller.address),
    expiry: (await publicClient.getBlock({ blockTag: "latest" })).timestamp + 86_400n,
    terms: {
      chainId,
      escrow: d.escrow,
      tokenSymbol: "tUSDT",
      tokenDecimals: 6,
      fiatCurrency: "NGN",
      price: "1600",
      paymentMethods: ["Bank transfer"],
      conditions: "Demo history: a completed trade between two demo wallets.",
    },
  });
  const signature = await signOffer(walletFor(seller), offer, chainId, d.escrow);

  for (let i = 1; i <= trades; i++) {
    const tradeId = await buyerClient.takeOffer(offer, signature, AMOUNT);
    await buyerClient.markPaid(tradeId, zeroHash);
    await sellerClient.release(tradeId);
    process.stdout.write(`   ${sellerLabel} → ${buyerLabel}: ${i}/${trades} settled\r`);
  }
  console.log(`   ${sellerLabel} → ${buyerLabel}: ${trades} settled trades (${note})`.padEnd(70));
}

console.log(`Chain ${chainId} · escrow ${d.escrow}`);
console.log(`Deployer ${deployer.address} · ${formatEther(await publicClient.getBalance({ address: deployer.address }))} ETH\n`);

// The series run in parallel: separate wallets, separate nonces, no queueing behind each other.
await Promise.all(SERIES.map(runSeries));

console.log("\nHistories now on the market:");
for (const s of SERIES) {
  console.log(`   ${derived(s.seller).address}  ${s.trades} trades as seller`);
  console.log(`   ${derived(s.buyer).address}  ${s.trades} trades as buyer`);
}
console.log("\nThe offer cards read these straight from the escrow's events — nothing is written down anywhere else.");
