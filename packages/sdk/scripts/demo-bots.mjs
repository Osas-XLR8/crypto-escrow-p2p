#!/usr/bin/env node
// Makes the demo wallets behave like counterparties instead of props.
//
// The demo market is full of offers from wallets this repo controls. Until now those wallets only acted inside
// their own scripted runs, so a visitor who took one of their offers was left talking to a wall: no payment
// details, no release, a 30-minute clock and nothing to do. The human-initiated path is the one anybody
// actually demos, and it was the one path nobody was serving.
//
// This watches the escrow and plays the demo side of any trade a demo wallet is party to, whoever opened it:
//
//   demo wallet is the SELLER   LOCKED → send payment details over the encrypted chat (once the buyer has
//                                        said hello, so there is a verified key to send them to)
//                               PAID   → check "the money arrived" and release
//   demo wallet is the BUYER    LOCKED → mark paid (after a short, human-looking pause)
//
//   npm run demo:bots                      # Base Sepolia
//   node scripts/demo-bots.mjs --chain 31337 --once
//
// Test networks only. These wallets release test tokens to whoever marks a trade paid: that is the point of a
// demo market, and it is the reason this must never be pointed at a network where the tokens mean anything.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, parseEther, toBytes, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, baseSepolia } from "viem/chains";
import { SimplePool } from "nostr-tools/pool";
import { EscrowV4Client, TradeChat, createBinding, deriveNostrIdentity, escrowCoreV4Abi, verifyHello } from "../dist/index.js";
import { getLogsChunked } from "./lib/logs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const contracts = join(here, "../../contracts");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const chainId = Number(arg("chain", "84532"));
const CHAINS = { 84532: baseSepolia, 31337: anvil };
const chain = CHAINS[chainId];
if (!chain) throw new Error(`Unsupported or non-test chain ${chainId}`);
const ONCE = process.argv.includes("--once");
const EVERY_MS = Number(arg("every", "10")) * 1000;
const PAY_AFTER_MS = Number(arg("pay-after", "20")) * 1000;

const RPC = arg("rpc", process.env.RPC_URL || chain.rpcUrls.default.http[0]);
const RELAYS = arg("relays", chainId === 31337 ? "ws://127.0.0.1:7777" : "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net").split(",");

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
const pool = new SimplePool();

/** The wallets that post the demo market's offers, plus the ones its scripted runs use. */
const LABELS = ["seller-1", "seller-2", "seller-3", "buyer-1", "buyer-2", "buyer-3", "dispute-seller", "dispute-buyer"];

/**
 * What a demo seller answers when a buyer asks where to send the money. The currency lives in the offer's
 * terms, which are off-chain, so there is one set of details — fictional, and obviously so, because nobody
 * should ever send money to a demo counterparty.
 */
const PAYMENT_DETAILS = {
  method: "Bank transfer",
  instructions: "DEMO — send nothing. This is a test network and this account does not exist: Demo Bank · 0123456789.",
  payeeName: "EscrowX Demo Seller",
};

const bots = new Map(); // address(lower) → { label, account, client, chat, identity }
for (const label of LABELS) {
  const account = derived(label);
  bots.set(account.address.toLowerCase(), { label, account, wallet: createWalletClient({ account, chain, transport: http(RPC) }) });
}

const GAS_FLOOR = parseEther(chainId === 31337 ? "0.2" : "0.00005");
const GAS_TOPUP = parseEther(chainId === 31337 ? "1" : "0.0003");

async function ready(bot) {
  if (bot.client) return bot;
  bot.client = new EscrowV4Client(publicClient, d.escrow, bot.wallet);
  bot.identity = await deriveNostrIdentity(bot.wallet, bot.account.address);
  bot.binding = await createBinding(bot.wallet, bot.account.address, bot.identity.publicKey);
  bot.chat = new TradeChat(pool, RELAYS, bot.identity);
  return bot;
}

async function fund(bot) {
  if ((await publicClient.getBalance({ address: bot.account.address })) >= GAS_FLOOR) return true;
  const funds = await publicClient.getBalance({ address: deployer.address });
  if (funds < GAS_TOPUP * 2n) {
    console.log(`   ! ${bot.label} is out of gas and so is the deployer (${formatEther(funds)} ETH)`);
    return false;
  }
  const hash = await deployerWallet.sendTransaction({ to: bot.account.address, value: GAS_TOPUP });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`   + funded ${bot.label} with ${formatEther(GAS_TOPUP)} ETH`);
  return true;
}

/** Trades this deployment knows about, newest first, read from TradeOpened. */
async function openedTrades() {
  const logs = await getLogsChunked(publicClient, {
    address: d.escrow,
    event: escrowCoreV4Abi.find((x) => x.type === "event" && x.name === "TradeOpened"),
    fromBlock: BigInt(d.deployBlock ?? 0),
  });
  return logs.map((l) => ({ tradeId: l.args.tradeId, seller: l.args.seller, buyer: l.args.buyer, blockNumber: l.blockNumber })).reverse();
}

const seenOpenedAt = new Map(); // tradeId → epoch ms this process first saw it LOCKED
const detailsSent = new Set(); // tradeId strings

async function serve(trade) {
  const { tradeId } = trade;
  const onchain = await publicClient.readContract({ address: d.escrow, abi: escrowCoreV4Abi, functionName: "getTrade", args: [tradeId] });
  const state = Number(onchain.state);
  const sellerBot = bots.get(onchain.seller.toLowerCase());
  const buyerBot = bots.get(onchain.buyer.toLowerCase());
  if (!sellerBot && !buyerBot) return;
  if (state !== 1 && state !== 2) return; // only LOCKED and PAID need anything from us

  // ── the demo wallet is the seller ──────────────────────────────────────────
  if (sellerBot) {
    const bot = await ready(sellerBot);
    if (state === 1 && !detailsSent.has(tradeId.toString())) {
      // Only send to a key that proved it belongs to this trade's buyer.
      const thread = await bot.chat.inbox(tradeId);
      let peer = null;
      for (const m of thread) {
        if (m.mine || m.message.type !== "hello") continue;
        if (await verifyHello(m, onchain.buyer)) peer = m.from;
      }
      if (!peer) {
        // Say hello ourselves so the buyer's client has a verified key to answer to.
        await bot.chat.send(bot.identity.publicKey, { type: "hello", tradeId: tradeId.toString(), binding: bot.binding }).catch(() => {});
        return;
      }
      await bot.chat.send(peer, { type: "hello", tradeId: tradeId.toString(), binding: bot.binding });
      await bot.chat.send(peer, { type: "payment_details", tradeId: tradeId.toString(), ...PAYMENT_DETAILS });
      detailsSent.add(tradeId.toString());
      console.log(`   #${tradeId} ${bot.label}: sent payment details to the buyer`);
      return;
    }
    if (state === 2) {
      if (!(await fund(bot))) return;
      await bot.client.release(tradeId);
      console.log(`   #${tradeId} ${bot.label}: buyer marked paid — released`);
      return;
    }
  }

  // ── the demo wallet is the buyer (a human filled one of our buy offers) ────
  if (buyerBot && state === 1) {
    const first = seenOpenedAt.get(tradeId.toString()) ?? Date.now();
    seenOpenedAt.set(tradeId.toString(), first);
    if (Date.now() - first < PAY_AFTER_MS) return; // a beat, so the seller sees the trade open first
    const bot = await ready(buyerBot);
    if (!(await fund(bot))) return;
    await bot.client.markPaid(tradeId, zeroHash);
    console.log(`   #${tradeId} ${bot.label}: paid the seller and marked it`);
  }
}

console.log(`Demo bots on chain ${chainId} · escrow ${d.escrow}`);
console.log(`Serving ${bots.size} demo wallets · checking every ${EVERY_MS / 1000}s${ONCE ? " (once)" : ""}`);

async function tick() {
  try {
    const trades = await openedTrades();
    for (const trade of trades.slice(0, 40)) {
      try {
        await serve(trade);
      } catch (e) {
        console.log(`   #${trade.tradeId} skipped: ${(e.shortMessage ?? e.message ?? String(e)).split("\n")[0]}`);
      }
    }
  } catch (e) {
    console.log(`   scan failed: ${(e.shortMessage ?? e.message ?? String(e)).split("\n")[0]}`);
  }
}

await tick();
if (!ONCE) {
  console.log("Watching. Ctrl-C to stop.");
  setInterval(tick, EVERY_MS);
} else {
  pool.destroy();
}
