#!/usr/bin/env node
// Runs one complete dispute, start to finish, with real transactions:
//
//   offer → trade → payment marked → dispute opened → fee matched → panelist assigned →
//   encrypted evidence from the buyer → ruling proposed → firm review → ruling executed → payout checked
//
// It exists because the arbitration machinery is the part of this product nobody ever sees: watching it
// happen end to end takes days of waiting on a live network, or a script like this one.
//
//   node scripts/demo-dispute.mjs --chain 31337 --warp     # local Anvil, time warped past the review period
//   PRIVATE_KEY=0x… node scripts/demo-dispute.mjs          # Base Sepolia, minutes end to end
//   … --stop-at fee-pending                                # park a trade in one state to look at the UI
//   … --contested                                          # both sides file evidence, not just the buyer
//   … --seller seller-3 --buyer buyer-3                     # run it between named demo wallets
//   … --opener buyer --warp                                # the buyer opens the dispute (needs the release
//                                                            window to pass, so local chains only)
//
// Test networks only — it refuses to run on a mainnet. Every wallet it uses is derived from the deployer
// key, so re-runs reuse the same demo parties instead of littering the chain with new ones.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, erc20Abi, formatEther, http, keccak256, parseEther, parseUnits, toBytes, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, arbitrumSepolia, baseSepolia, optimismSepolia, sepolia } from "viem/chains";
import {
  EscrowV4Client,
  adapterKeyFromNostrPubkey,
  createOffer,
  decryptEvidence,
  deriveNostrIdentity,
  encryptEvidence,
  escrowCoreV4Abi,
  formatEvidenceUri,
  keyToHex,
  licensedArbitratorAdapterAbi,
  openEvidenceKey,
  parseEvidenceUri,
  sealEvidenceKey,
  signOffer,
} from "../dist/index.js";
import { getLogsChunked } from "./lib/logs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const contracts = join(here, "../../contracts");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const CHAIN_ID = Number(arg("chain", "84532"));
const CHAINS = { 31337: anvil, 84532: baseSepolia, 11155111: sepolia, 421614: arbitrumSepolia, 11155420: optimismSepolia };
const chain = CHAINS[CHAIN_ID];
if (!chain) throw new Error(`Unsupported or non-test chain ${CHAIN_ID}`);
const LOCAL = CHAIN_ID === 31337;
const WARP = flag("warp");
const STOP_AT = arg("stop-at", "done");
/** Both parties file evidence, so the panelist has two accounts to weigh instead of one. */
const CONTESTED = process.argv.includes("--contested");
const OPENER = arg("opener", "seller");
const STAGES = ["locked", "paid", "fee-pending", "disputed", "assigned", "evidence", "proposed", "done"];
if (!STAGES.includes(STOP_AT)) throw new Error(`--stop-at must be one of: ${STAGES.join(", ")}`);
if (!["seller", "buyer"].includes(OPENER)) throw new Error("--opener must be seller or buyer");
/** Stops the run once the trade is parked in the state you asked for. */
function stopHere(stage) {
  if (STOP_AT !== stage) return false;
  console.log(`
Stopped at "${stage}" as asked — the trade is sitting in that state for you to look at.`);
  process.exit(0);
}
async function warpPast(seconds, why) {
  if (!WARP) throw new Error(`${why} needs ${seconds}s to pass; re-run with --warp on a local chain`);
  for (const [method, params] of [["evm_increaseTime", [seconds]], ["evm_mine", []]]) {
    await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  }
}
if (WARP && !LOCAL) throw new Error("--warp only works on a local chain you control");

const deploymentPath = arg("deployment", [join(contracts, `deployments/v4-${CHAIN_ID}.json`), join(contracts, `.deployments/v4-${CHAIN_ID}.json`)].find(existsSync));
if (!deploymentPath) throw new Error(`No deployment file for chain ${CHAIN_ID}. Deploy first.`);
const d = JSON.parse(readFileSync(deploymentPath, "utf8"));

function deployerKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;
  if (LOCAL) return "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Anvil #0
  const env = join(contracts, ".env.testnet");
  const line = existsSync(env) && readFileSync(env, "utf8").split(/\r?\n/).find((l) => l.startsWith("PRIVATE_KEY="));
  if (!line) throw new Error("Set PRIVATE_KEY or create packages/contracts/.env.testnet (./testnet-wallet.sh)");
  return line.slice("PRIVATE_KEY=".length).trim();
}

// The chain's own endpoint: some public mirrors accept a transaction and then quietly drop it from their
// mempool, which looks exactly like a chain that never mines.
const RPC = arg("rpc", process.env.RPC_URL || chain.rpcUrls.default.http[0]);
const AMOUNT = parseUnits(arg("amount", "20"), 6);
// Faucet ETH is scarce: give each demo wallet only what its part of the run costs. The two parties also
// each put up the arbitration fee, which comes back to whoever wins.
const GAS_TOPUP = parseEther(LOCAL ? "1" : "0.0002");
const GAS_MIN = parseEther(LOCAL ? "0.2" : "0.00008");
const PARTY_TOPUP = parseEther(LOCAL ? "1" : "0.0008");
const units = (n) => Number(n) / 1e6;

const publicClient = createPublicClient({ chain, transport: http(RPC) });
if ((await publicClient.getChainId()) !== CHAIN_ID) throw new Error(`RPC is not on chain ${CHAIN_ID}`);

const key = deployerKey();
const deployer = privateKeyToAccount(key);
const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });
const derived = (label) => privateKeyToAccount(keccak256(toBytes(`${key}:escrowx-demo-${label}`)));
const walletFor = (account) => createWalletClient({ account, chain, transport: http(RPC) });

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;

// Every transaction this run makes, so the case can be handed over as a record rather than a claim.
const record = [];
const note = (what, hash) => record.push({ at: elapsed(), what, hash });
const EXPLORERS = { 84532: "https://base-sepolia.blockscout.com/tx/" };
const step = (n, text) => console.log(`[${elapsed().padStart(4)}] ${n}. ${text}`);

async function send(hashPromise, label) {
  const hash = await hashPromise;
  if (label) note(label, hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  // Public endpoints are load-balanced: the next read can land on a node that hasn't seen this block yet,
  // which once made a finished trade look like it was still in dispute.
  for (let i = 0; i < 30; i++) {
    if ((await publicClient.getBlockNumber({ cacheTime: 0 })) >= receipt.blockNumber) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return receipt;
}

async function topUp(account, label, needsFee = false) {
  const balance = await publicClient.getBalance({ address: account.address });
  const want = needsFee ? PARTY_TOPUP : GAS_TOPUP;
  const floor = needsFee ? want / 2n : GAS_MIN;
  if (balance < floor) {
    const funds = await publicClient.getBalance({ address: deployer.address });
    const give = funds - want > GAS_MIN ? want : funds / 4n;
    if (give < GAS_MIN) throw new Error(`The deployer is out of test ETH (${formatEther(funds)}). Top it up from a faucet.`);
    await send(deployerWallet.sendTransaction({ to: account.address, value: give }));
  }
  console.log(`         ${label}: ${account.address}`);
}

// ─── Cast ─────────────────────────────────────────────────────────────────────

// The parties default to wallets kept for disputes, but can be any demo wallet — running a dispute against a
// market maker is how that maker ends up with a dispute on its record, which is the whole point of showing one.
const seller = derived(arg("seller", "dispute-seller"));
const buyer = derived(arg("buyer", "dispute-buyer"));
const panelist = derived("panelist");
const sellerClient = new EscrowV4Client(publicClient, d.escrow, walletFor(seller));
const buyerClient = new EscrowV4Client(publicClient, d.escrow, walletFor(buyer));
// The client reports every transaction it sends, which is exactly the list this run needs to keep.
for (const [who, client] of [["seller", sellerClient], ["buyer", buyerClient]]) {
  client.onActivity((e) => {
    if (e.phase === "sent") note(`${who}: ${e.functionName}`, e.hash);
  });
}
const firm = d.primaryArbitrator;

console.log(`Chain ${CHAIN_ID} · escrow ${d.escrow} · firm ${firm}`);
await topUp(seller, "seller  ", true);
await topUp(buyer, "buyer   ", true);
await topUp(panelist, "panelist");

const firmAdmin = await publicClient.readContract({ address: firm, abi: licensedArbitratorAdapterAbi, functionName: "firmAdmin" });
if (firmAdmin.toLowerCase() !== deployer.address.toLowerCase()) throw new Error(`This key doesn't run firm ${firm} (admin is ${firmAdmin})`);
const reviewPeriod = Number(await publicClient.readContract({ address: firm, abi: licensedArbitratorAdapterAbi, functionName: "REVIEW_PERIOD" }));

// The panelist publishes an encryption key so parties can seal evidence to them; the firm registers it.
const panelistIdentity = await deriveNostrIdentity(walletFor(panelist), panelist.address);
const panelistKey = adapterKeyFromNostrPubkey(panelistIdentity.publicKey);
const registered = await publicClient.readContract({ address: firm, abi: licensedArbitratorAdapterAbi, functionName: "isPanelist", args: [panelist.address] });
if (!registered) {
  await send(deployerWallet.writeContract({ address: firm, abi: licensedArbitratorAdapterAbi, functionName: "setPanelist", args: [panelist.address, true, panelistKey] }));
  console.log(`         registered the demo panelist on the firm`);
}

// ─── 1. A seller with crypto in the vault, and a signed offer ─────────────────

const mintAbi = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }];
const free = await sellerClient.freeBalance(seller.address, d.usdt);
if (free < AMOUNT) {
  const held = await publicClient.readContract({ address: d.usdt, abi: erc20Abi, functionName: "balanceOf", args: [seller.address] });
  if (held < AMOUNT - free) {
    await send(deployerWallet.writeContract({ address: d.usdt, abi: mintAbi, functionName: "mint", args: [seller.address, AMOUNT - free - held] }));
    for (let i = 0; i < 20; i++) {
      const now = await publicClient.readContract({ address: d.usdt, abi: erc20Abi, functionName: "balanceOf", args: [seller.address] });
      if (now >= AMOUNT - free) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await sellerClient.deposit(d.usdt, AMOUNT - free);
}
step(1, `seller has ${units(AMOUNT)} tUSDT in the vault and signs an offer`);

const offer = createOffer({
  seller: seller.address,
  token: d.usdt,
  minAmount: AMOUNT,
  maxAmount: AMOUNT,
  totalAmount: AMOUNT,
  paymentWindow: 600n, // the contract's own minimum
  releaseWindow: 1800n,
  arbitrator: firm,
  fallbackArbitrator: d.fallbackArbitrator,
  terms: {
    chainId: CHAIN_ID,
    escrow: d.escrow,
    tokenSymbol: "tUSDT",
    tokenDecimals: 6,
    fiatCurrency: "NGN",
    price: "1600",
    paymentMethods: ["Bank transfer"],
    conditions: "Demo trade: this one is scripted to end in a dispute.",
  },
  nonce: await sellerClient.makerNonce(seller.address),
  // The chain's clock, not this machine's: a local chain that has been time-warped is often hours ahead.
  expiry: (await publicClient.getBlock({ blockTag: "latest" })).timestamp + 3600n,
});
const signature = await signOffer(walletFor(seller), offer, CHAIN_ID, d.escrow);

// ─── 2. The trade ─────────────────────────────────────────────────────────────

const tradeId = await buyerClient.takeOffer(offer, signature, AMOUNT);
step(2, `buyer takes it — trade #${tradeId}, ${units(AMOUNT)} tUSDT locked in escrow`);
stopHere("locked");

// The buyer encrypts a receipt; only its fingerprint goes on-chain with the payment.
const receipt = new TextEncoder().encode(`Demo transfer receipt for trade ${tradeId} — bank ref DEMO-${tradeId}-${Date.now()}`);
const evidence = await encryptEvidence(receipt);
await buyerClient.markPaid(tradeId, evidence.commitment);
step(3, `buyer marks the fiat as sent, with an encrypted receipt fingerprint on-chain`);
stopHere("paid");

// ─── 3. The dispute ───────────────────────────────────────────────────────────

const fee = formatEther(await sellerClient.arbitrationCost(firm));
if (OPENER === "seller") {
  await sellerClient.openDispute(tradeId);
  step(4, `seller says the money never arrived and opens a dispute (fee ${fee} ETH)`);
} else {
  // The contract only lets a buyer dispute once the seller's release window has run out.
  const trade = await buyerClient.getTrade(tradeId);
  const now = Number((await publicClient.getBlock({ blockTag: "latest" })).timestamp);
  if (now <= Number(trade.releaseDeadline)) await warpPast(Number(trade.releaseDeadline) - now + 1, "a buyer-opened dispute");
  await buyerClient.openDispute(tradeId);
  step(4, `seller never released, so the buyer opens the dispute (fee ${fee} ETH)`);
}
stopHere("fee-pending");

const matcher = OPENER === "seller" ? buyerClient : sellerClient;
const disputeId = await matcher.payArbitrationFee(tradeId);
step(5, `${OPENER === "seller" ? "buyer" : "seller"} matches the fee — case #${disputeId} is now with the firm`);
stopHere("disputed");

await send(deployerWallet.writeContract({ address: firm, abi: licensedArbitratorAdapterAbi, functionName: "assign", args: [disputeId, panelist.address] }), "firm: assign panelist");
step(6, `firm assigns the case to a panelist (not a party to the trade — the contract checks)`);
stopHere("assigned");

// ─── 4. Evidence, sealed to the assigned panelist only ────────────────────────
//
// Both sides can file. With --contested the seller files too, and the panelist has to actually weigh two
// accounts of the same trade instead of rubber-stamping the only one on offer.

const buyerIdentity = await deriveNostrIdentity(walletFor(buyer), buyer.address);
const filings = [
  { who: "buyer", client: buyerClient, identity: buyerIdentity, evidence, note: "the receipt for the transfer" },
];

if (CONTESTED) {
  const statement = new TextEncoder().encode(
    `Seller's statement for trade ${tradeId}: no credit appeared on the account ending 4471 between ` +
      `${new Date().toISOString()} and the dispute. Bank statement attached; the reference the buyer quoted is not on it.`
  );
  const sellerEvidence = await encryptEvidence(statement);
  filings.push({ who: "seller", client: sellerClient, identity: await deriveNostrIdentity(walletFor(seller), seller.address), evidence: sellerEvidence, note: "a bank statement showing nothing arrived" });
}

for (const filing of filings) {
  const sealed = sealEvidenceKey(filing.identity, panelistIdentity.publicKey, {
    tradeId: tradeId.toString(),
    commitment: filing.evidence.commitment,
    key: keyToHex(filing.evidence.key),
    mimeType: "text/plain",
  });
  await filing.client.submitEvidence(tradeId, formatEvidenceUri(filing.identity.publicKey, panelistIdentity.publicKey, sealed));
}
step(7, `${filings.map((f) => `${f.who} files ${f.note}`).join("; ")} — each sealed so only the assigned panelist can open it`);

// The panelist does what the desk does: read the events, open the keys, check the fingerprints match.
const evidenceLogs = await getLogsChunked(publicClient, {
  address: d.escrow,
  event: escrowCoreV4Abi.find((x) => x.type === "event" && x.name === "Evidence"),
  fromBlock: BigInt(d.deployBlock ?? 0),
});
const mine = evidenceLogs.filter((l) => l.args.evidenceGroupID === tradeId);
const read = [];
for (const log of mine) {
  const parsed = parseEvidenceUri(log.args.evidence);
  if (!parsed || parsed.recipientPubkey !== panelistIdentity.publicKey) continue;
  const opened = openEvidenceKey(panelistIdentity, parsed.senderPubkey, parsed.sealed);
  const filing = filings.find((f) => f.identity.publicKey === parsed.senderPubkey);
  if (!filing) continue;
  const plain = new TextDecoder().decode(await decryptEvidence(filing.evidence.ciphertext, Buffer.from(opened.key.slice(2), "hex"), opened.commitment));
  read.push({ who: filing.who, party: log.args.party, plain });
}
if (read.length !== filings.length) throw new Error(`panelist could only open ${read.length} of ${filings.length} filings`);
for (const r of read) console.log(`         ${r.who} (${r.party}): "${r.plain.slice(0, 96)}…"`);
step(8, `panelist opens ${read.length === 1 ? "it" : `both filings`} and checks each against its on-chain fingerprint`);
stopHere("evidence");

// ─── 5. The ruling ────────────────────────────────────────────────────────────

const RULING_BUYER = 1n;
// The decision hash is the fingerprint of the written reasons the firm keeps off-chain; what it covers is
// what the panelist actually read.
const reasons = CONTESTED
  ? `Both filings opened. The buyer's receipt carries the reference and the amount for trade ${tradeId} and matches its on-chain fingerprint; the seller's statement shows an account that does not cover the window the receipt falls in. Ruling for the buyer.`
  : `The buyer's receipt matches the payment they claimed and its on-chain fingerprint. Ruling for the buyer.`;
await send(walletFor(panelist).writeContract({
  address: firm,
  abi: licensedArbitratorAdapterAbi,
  functionName: "proposeRuling",
  args: [disputeId, RULING_BUYER, keccak256(toBytes(reasons))],
}), "panelist: propose ruling");
step(9, CONTESTED
  ? `panelist weighs both accounts and proposes: the buyer's evidence carries the day`
  : `panelist proposes: the buyer paid, so the crypto goes to the buyer`);
stopHere("proposed");

if (WARP) {
  await warpPast(reviewPeriod + 1, "the review period");
  step(10, `firm review period (${reviewPeriod / 60} min) — warped past it on this local chain`);
} else if (deployer.address.toLowerCase() !== panelist.address.toLowerCase()) {
  // The review period is the firm's window to veto its panelist. This key IS the firm, and it did not decide
  // the case, so confirming the ruling now is that review happening in person rather than by the clock.
  step(10, `firm reviews its panelist's decision and confirms it (what the ${reviewPeriod / 60}-minute window is for)`);
} else {
  const until = Math.floor(Date.now() / 1000) + reviewPeriod + 5;
  step(10, `firm review period: ${reviewPeriod / 60} min in which the firm can veto its panelist. Waiting…`);
  while (Math.floor(Date.now() / 1000) < until) {
    await new Promise((r) => setTimeout(r, 15_000));
    process.stdout.write(`         ${Math.max(0, until - Math.floor(Date.now() / 1000))}s left\r`);
  }
}

await send(deployerWallet.writeContract({ address: firm, abi: licensedArbitratorAdapterAbi, functionName: "executeRuling", args: [disputeId] }), "firm: execute ruling");
step(11, `the ruling executes: the escrow moves the locked crypto to the buyer`);

// ─── 6. Did the money actually move? ──────────────────────────────────────────

const trade = await buyerClient.getTrade(tradeId);
const buyerBalance = await publicClient.readContract({ address: d.usdt, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] });
const buyerVault = await buyerClient.freeBalance(buyer.address, d.usdt);
const buyerRefund = await buyerClient.claimableNative(buyer.address);
const sellerRefund = await sellerClient.claimableNative(seller.address);

console.log(`\nTrade #${tradeId} state ${trade.state} (5 = RELEASED)`);
console.log(`Buyer  ${units(buyerVault)} tUSDT in vault · ${units(buyerBalance)} in wallet · ${formatEther(buyerRefund)} ETH fee refund waiting`);
console.log(`Seller ${formatEther(sellerRefund)} ETH refund (the loser's fee pays the firm)`);
console.log("");
console.log(`Case record — trade #${tradeId}, case #${disputeId}${CONTESTED ? ", contested (both sides filed)" : ""}:`);
for (const r of record) console.log(`   ${r.at.padStart(4)}  ${r.what.padEnd(26)} ${EXPLORERS[CHAIN_ID] ? EXPLORERS[CHAIN_ID] + r.hash : r.hash}`);
console.log("");
console.log(`Complete dispute in ${elapsed()}.`);
if (trade.state !== 5) {
  console.error("Expected the trade to be RELEASED to the buyer.");
  process.exit(1);
}
