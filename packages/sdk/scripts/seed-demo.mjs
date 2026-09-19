#!/usr/bin/env node
// Seeds a demo market on both sides:
//   • demo SELLERS: funded with a little gas and test tokens, deposit into their vault, publish sell offers
//   • demo BUYERS: publish buy offers (signing only — no gas or tokens needed until someone fills them)
// Re-running refreshes the offers (the previous ones are withdrawn from the relays) and only tops balances
// up when they're low.
//
//   npm run build && npm run seed:demo                      # Base Sepolia, keys from contracts/.env.testnet
//   npm run seed:demo -- --chain 31337                      # local Anvil + local relay
//
// The seller keys are derived from the deployer key, so the same demo sellers come back on every run.
// Test-network only: it refuses to run on a mainnet.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, erc20Abi, formatEther, http, keccak256, parseEther, parseUnits, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, arbitrumSepolia, baseSepolia, optimismSepolia, sepolia } from "viem/chains";
import { SimplePool } from "nostr-tools/pool";
import {
  EscrowV4Client,
  OfferBook,
  buildCancelEvent,
  buildOfferEvent,
  createBinding,
  createBuyOffer,
  createOffer,
  deriveNostrIdentity,
  signOffer,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const contracts = join(here, "../../contracts");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const CHAIN_ID = Number(arg("chain", "84532"));
const CHAINS = { 31337: anvil, 84532: baseSepolia, 11155111: sepolia, 421614: arbitrumSepolia, 11155420: optimismSepolia };
const chain = CHAINS[CHAIN_ID];
if (!chain) throw new Error(`Unsupported or non-test chain ${CHAIN_ID}`);
const LOCAL = CHAIN_ID === 31337;

// ─── Config ───────────────────────────────────────────────────────────────────

const deploymentPath = arg("deployment", [join(contracts, `deployments/v4-${CHAIN_ID}.json`), join(contracts, `.deployments/v4-${CHAIN_ID}.json`)].find(existsSync));
if (!deploymentPath || !existsSync(deploymentPath)) throw new Error(`No deployment file for chain ${CHAIN_ID}. Deploy first.`);
const d = JSON.parse(readFileSync(deploymentPath, "utf8"));

function deployerKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;
  if (LOCAL) return "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Anvil #0
  const env = join(contracts, ".env.testnet");
  const line = existsSync(env) && readFileSync(env, "utf8").split(/\r?\n/).find((l) => l.startsWith("PRIVATE_KEY="));
  if (!line) throw new Error("Set PRIVATE_KEY or create packages/contracts/.env.testnet (./testnet-wallet.sh)");
  return line.slice("PRIVATE_KEY=".length).trim();
}

const RPC = arg("rpc", process.env.RPC_URL || chain.rpcUrls.default.http[0]);
const RELAYS = arg("relays", LOCAL ? "ws://127.0.0.1:7777" : "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net").split(",");
const SYMBOL = "tUSDT";
const GAS_TOPUP = parseEther(LOCAL ? "1" : "0.0004");
const GAS_MIN = parseEther(LOCAL ? "0.5" : "0.0002");
const EXPIRY_DAYS = Number(arg("days", "7"));

/** Three demo sellers with the kind of offers a Lagos / Nairobi / Accra market would show. */
const SELLERS = [
  {
    label: "demo seller 1",
    offers: [
      { fiat: "NGN", price: "1592", methods: ["Bank transfer", "Opay", "Moniepoint"], min: 20, max: 500, total: 1500, pay: 30, conditions: "Pay only from an account in your own name. No third-party payments." },
      { fiat: "NGN", price: "1610", methods: ["PalmPay", "Kuda"], min: 10, max: 200, total: 600, pay: 15, conditions: "Fast release, usually under 10 minutes. Instant transfers only." },
    ],
  },
  {
    label: "demo seller 2",
    offers: [
      { fiat: "NGN", price: "1601", methods: ["Bank transfer"], min: 50, max: 1000, total: 1500, pay: 45, conditions: "Business hours 8am–8pm WAT. Include the trade number in the transfer narration." },
      { fiat: "KES", price: "129.6", methods: ["M-Pesa"], min: 10, max: 300, total: 900, pay: 20, conditions: "M-Pesa only, from a line registered in your own name." },
    ],
  },
  {
    label: "demo seller 3",
    offers: [
      { fiat: "GHS", price: "15.35", methods: ["MTN MoMo", "Bank transfer"], min: 10, max: 400, total: 1200, pay: 30, conditions: "MoMo preferred. No cash deposits." },
      { fiat: "ZAR", price: "18.9", methods: ["Bank transfer", "Capitec Pay"], min: 25, max: 500, total: 800, pay: 60, conditions: "EFT from your own account. Allow up to an hour for bank clearing." },
    ],
  },
];

/** Demo buyers bid a little under the sellers' asks, like a real order book. */
const BUYERS = [
  {
    label: "demo buyer 1",
    offers: [
      { fiat: "NGN", price: "1575", methods: ["Bank transfer", "Opay"], min: 20, max: 400, total: 1200, pay: 30, conditions: "I pay from an account in my own name within minutes of the trade opening." },
      { fiat: "GHS", price: "15.1", methods: ["MTN MoMo"], min: 10, max: 300, total: 600, pay: 30, conditions: "MoMo only. Please share the MoMo name in the chat." },
    ],
  },
  {
    label: "demo buyer 2",
    offers: [
      { fiat: "NGN", price: "1582", methods: ["PalmPay", "Moniepoint"], min: 50, max: 800, total: 2000, pay: 20, conditions: "Regular buyer. Instant transfer, reference included." },
      { fiat: "KES", price: "128.8", methods: ["M-Pesa"], min: 10, max: 250, total: 750, pay: 20, conditions: "M-Pesa from my own line." },
    ],
  },
];

// ─── Setup ────────────────────────────────────────────────────────────────────

const publicClient = createPublicClient({ chain, transport: http(RPC) });
const actualChain = await publicClient.getChainId();
if (actualChain !== CHAIN_ID) throw new Error(`RPC is on chain ${actualChain}, expected ${CHAIN_ID}`);

const deployer = privateKeyToAccount(deployerKey());
const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });
const pool = new SimplePool();
const book = new OfferBook(RELAYS, { escrow: d.escrow, publicClient }, pool);
const mintAbi = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }];
const units = (n) => parseUnits(String(n), 6);

async function send(hashPromise) {
  const hash = await hashPromise;
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
}

console.log(`Chain ${CHAIN_ID} · escrow ${d.escrow} · ${RELAYS.length} relay(s)`);
console.log(`Deployer ${deployer.address} · ${formatEther(await publicClient.getBalance({ address: deployer.address }))} ETH`);

// ─── Seed each seller ─────────────────────────────────────────────────────────

let published = 0;
for (const [i, seller] of SELLERS.entries()) {
  const key = keccak256(toBytes(`${deployerKey()}:escrowx-demo-seller-${i + 1}`));
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const client = new EscrowV4Client(publicClient, d.escrow, wallet);
  console.log(`\n${seller.label}: ${account.address}`);

  // Gas
  const gas = await publicClient.getBalance({ address: account.address });
  if (gas < GAS_MIN) {
    await send(deployerWallet.sendTransaction({ to: account.address, value: GAS_TOPUP }));
    console.log(`  + ${formatEther(GAS_TOPUP)} ETH for gas`);
  }

  // Vault: enough free balance for every offer's total
  const needed = seller.offers.reduce((sum, o) => sum + units(o.total), 0n);
  const free = await client.freeBalance(account.address, d.usdt);
  if (free < needed) {
    const shortfall = needed - free;
    const held = await publicClient.readContract({ address: d.usdt, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    if (held < shortfall) {
      await send(deployerWallet.writeContract({ address: d.usdt, abi: mintAbi, functionName: "mint", args: [account.address, shortfall - held] }));
      // Public RPCs are load-balanced: wait until the node we query sees the mint before depositing.
      for (let tries = 0; tries < 20; tries++) {
        const now = await publicClient.readContract({ address: d.usdt, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
        if (now >= shortfall) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await client.deposit(d.usdt, shortfall);
    console.log(`  + deposited ${Number(shortfall) / 1e6} ${SYMBOL} (vault now ${Number(needed) / 1e6})`);
  } else {
    console.log(`  vault already holds ${Number(free) / 1e6} ${SYMBOL}`);
  }

  // Messaging identity (derived from the wallet, like the app does)
  const identity = await deriveNostrIdentity(wallet, account.address);
  const binding = await createBinding(wallet, account.address, identity.publicKey);

  // Withdraw this seller's previous demo offers from the relays so re-runs don't pile up duplicates.
  const previous = await book.fetch({ chainId: CHAIN_ID, maker: account.address });
  for (const old of previous.offers) await book.publish(buildCancelEvent(old, identity));
  if (previous.offers.length) console.log(`  - withdrew ${previous.offers.length} previous offer(s) from relays`);

  const nonce = await client.makerNonce(account.address);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + EXPIRY_DAYS * 86400);
  for (const o of seller.offers) {
    const terms = {
      chainId: CHAIN_ID,
      escrow: d.escrow,
      tokenSymbol: SYMBOL,
      tokenDecimals: 6,
      fiatCurrency: o.fiat,
      price: o.price,
      paymentMethods: o.methods,
      conditions: o.conditions,
    };
    const offer = createOffer({
      seller: account.address,
      token: d.usdt,
      minAmount: units(o.min),
      maxAmount: units(o.max),
      totalAmount: units(o.total),
      paymentWindow: BigInt(o.pay * 60),
      releaseWindow: 3600n,
      arbitrator: d.primaryArbitrator,
      fallbackArbitrator: d.fallbackArbitrator,
      nonce,
      expiry,
      terms,
    });
    const signature = await signOffer(wallet, offer, CHAIN_ID, d.escrow);
    const results = await book.publish(buildOfferEvent({ offer, signature, terms, binding, identity }));
    const ok = results.filter((r) => r.ok).length;
    if (ok === 0) throw new Error(`no relay accepted the offer: ${results.map((r) => r.message).join("; ")}`);
    published++;
    console.log(`  ✓ ${o.price} ${o.fiat}/${SYMBOL} · ${o.min}–${o.max} · ${o.methods.join(", ")} (${ok}/${RELAYS.length} relays)`);
  }
}

// ─── Seed each buyer (buy offers: signatures only) ────────────────────────────

for (const [i, buyer] of BUYERS.entries()) {
  const account = privateKeyToAccount(keccak256(toBytes(`${deployerKey()}:escrowx-demo-buyer-${i + 1}`)));
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const client = new EscrowV4Client(publicClient, d.escrow, wallet);
  console.log(`\n${buyer.label}: ${account.address}`);

  const identity = await deriveNostrIdentity(wallet, account.address);
  const binding = await createBinding(wallet, account.address, identity.publicKey);
  const previous = await book.fetch({ chainId: CHAIN_ID, maker: account.address });
  for (const old of previous.offers) await book.publish(buildCancelEvent(old, identity));
  if (previous.offers.length) console.log(`  - withdrew ${previous.offers.length} previous offer(s) from relays`);

  const nonce = await client.makerNonce(account.address);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + EXPIRY_DAYS * 86400);
  for (const o of buyer.offers) {
    const terms = { chainId: CHAIN_ID, escrow: d.escrow, tokenSymbol: SYMBOL, tokenDecimals: 6, fiatCurrency: o.fiat, price: o.price, paymentMethods: o.methods, conditions: o.conditions };
    const offer = createBuyOffer({
      buyer: account.address,
      token: d.usdt,
      minAmount: units(o.min),
      maxAmount: units(o.max),
      totalAmount: units(o.total),
      paymentWindow: BigInt(o.pay * 60),
      releaseWindow: 3600n,
      arbitrator: d.primaryArbitrator,
      fallbackArbitrator: d.fallbackArbitrator,
      nonce,
      expiry,
      terms,
    });
    const signature = await signOffer(wallet, offer, CHAIN_ID, d.escrow);
    const results = await book.publish(buildOfferEvent({ offer, signature, terms, binding, identity }));
    const ok = results.filter((r) => r.ok).length;
    if (ok === 0) throw new Error(`no relay accepted the offer: ${results.map((r) => r.message).join("; ")}`);
    published++;
    console.log(`  ✓ buying at ${o.price} ${o.fiat}/${SYMBOL} · ${o.min}–${o.max} · ${o.methods.join(", ")} (${ok}/${RELAYS.length} relays)`);
  }
}

console.log(`\nPublished ${published} offers, valid for ${EXPIRY_DAYS} days. Re-run to refresh them.`);
pool.destroy();
process.exit(0);
