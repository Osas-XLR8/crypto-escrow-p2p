// End-to-end: EscrowCoreV4 + LicensedArbitratorAdapter on Anvil, two in-process Nostr relays, and the SDK.
// No EscrowX server is involved anywhere in these flows.
//
// Requires a fresh deployment (packages/contracts/script/DeployV4.s.sol with MINT_TO = Anvil #1).
// Set V4_DEPLOYMENT to the JSON it wrote, or it defaults to packages/contracts/.deployments/v4-31337.json.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, http, keccak256, toBytes, type Address, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { SimplePool } from "nostr-tools/pool";
import {
  EscrowV4Client,
  OfferBook,
  TradeChat,
  TradeState,
  adapterKeyFromNostrPubkey,
  buildOfferEvent,
  createBinding,
  createBuyOffer,
  createOffer,
  decryptEvidence,
  deriveNostrIdentity,
  encryptEvidence,
  formatEvidenceUri,
  hashOffer,
  keyFromHex,
  keyToHex,
  licensedArbitratorAdapterAbi,
  nostrPubkeyFromAdapterKey,
  openEvidenceKey,
  parseEvidenceUri,
  sealEvidenceKey,
  signOffer,
  verifyHello,
  type NostrIdentity,
  type OfferTerms,
  type ParsedOffer,
  type WalletBinding,
} from "../../src/index.js";
import { startTestRelay, type TestRelay } from "../support/testRelay.js";

const here = dirname(fileURLToPath(import.meta.url));
const deploymentPath = process.env.V4_DEPLOYMENT ?? join(here, "../../../contracts/.deployments/v4-31337.json");
const RPC = process.env.E2E_RPC_URL ?? "http://127.0.0.1:8545";
const hasDeployment = existsSync(deploymentPath);

const KEYS = {
  firmAdmin: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  seller: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  buyer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  panelist: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;

const USDT = (n: number) => BigInt(Math.round(n * 1e6));

interface Actor {
  account: PrivateKeyAccount;
  client: EscrowV4Client;
  identity: NostrIdentity;
  binding: WalletBinding;
}

describe.skipIf(!hasDeployment)("SDK end-to-end on Anvil (no EscrowX servers)", () => {
  const d = hasDeployment
    ? (JSON.parse(readFileSync(deploymentPath, "utf8")) as { chainId: number; escrow: Address; usdt: Address; primaryArbitrator: Address; fallbackArbitrator: Address })
    : ({} as never);

  const publicClient = createPublicClient({ chain: anvil, transport: http(RPC) }) as PublicClient;
  const testClient = createTestClient({ chain: anvil, mode: "anvil", transport: http(RPC) });
  const wallet = (account: PrivateKeyAccount) => createWalletClient({ chain: anvil, transport: http(RPC), account });

  let relays: TestRelay[];
  let pool: SimplePool;
  let seller: Actor, buyer: Actor, panelist: Actor;
  let book: OfferBook;
  const ipfs = new Map<string, Uint8Array>(); // stand-in for wherever ciphertext is stored

  async function actor(pk: `0x${string}`): Promise<Actor> {
    const account = privateKeyToAccount(pk);
    const identity = await deriveNostrIdentity(account, account.address);
    return { account, client: new EscrowV4Client(publicClient, d.escrow, wallet(account)), identity, binding: await createBinding(account, account.address, identity.publicKey) };
  }

  const chainNow = async () => (await publicClient.getBlock()).timestamp;
  const warp = async (seconds: number) => {
    await testClient.increaseTime({ seconds });
    await testClient.mine({ blocks: 1 });
  };
  const usdtBalance = (who: Address) => publicClient.readContract({ address: d.usdt, abi: erc20Abi, functionName: "balanceOf", args: [who] });

  const terms: OfferTerms = {
    chainId: 31337,
    escrow: undefined as never,
    tokenSymbol: "USDT",
    tokenDecimals: 6,
    fiatCurrency: "NGN",
    price: "1600",
    paymentMethods: ["bank-transfer"],
    conditions: "Pay from an account in your own name",
  };

  async function publishOffer(totalUsdt: number): Promise<ParsedOffer> {
    const t = { ...terms, escrow: d.escrow };
    const offer = createOffer({
      seller: seller.account.address,
      token: d.usdt,
      minAmount: USDT(10),
      maxAmount: USDT(500),
      totalAmount: USDT(totalUsdt),
      paymentWindow: 1800n,
      releaseWindow: 3600n,
      arbitrator: d.primaryArbitrator,
      fallbackArbitrator: d.fallbackArbitrator,
      nonce: await seller.client.sellerNonce(seller.account.address),
      expiry: (await chainNow()) + 86400n,
      terms: t,
    });
    const signature = await signOffer(seller.account, offer, t.chainId, t.escrow);
    const event = buildOfferEvent({ offer, signature, terms: t, binding: seller.binding, identity: seller.identity });
    const results = await book.publish(event);
    expect(results.every((r) => r.ok)).toBe(true);
    const { offers } = await book.fetch({ chainId: 31337, fiatCurrency: "NGN", seller: seller.account.address });
    const found = offers.find((o) => o.offerHash === hashOffer(offer, t.chainId, t.escrow));
    expect(found).toBeDefined();
    return found!;
  }

  beforeAll(async () => {
    relays = await Promise.all([startTestRelay(), startTestRelay()]);
    pool = new SimplePool();
    [seller, buyer, panelist] = await Promise.all([actor(KEYS.seller), actor(KEYS.buyer), actor(KEYS.panelist)]);
    book = new OfferBook(relays.map((r) => r.url), { escrow: d.escrow, publicClient, now: null }, pool);
    await seller.client.deposit(d.usdt, USDT(2_000));
  });

  afterAll(async () => {
    pool?.destroy();
    await Promise.all((relays ?? []).map((r) => r.close()));
  });

  it("SDK offer hash matches the contract exactly", async () => {
    const parsed = await publishOffer(1_000);
    expect(await buyer.client.onchainOfferHash(parsed.offer)).toBe(parsed.offerHash);
    expect(await buyer.client.remaining(parsed.offer)).toBe(USDT(1_000));
  });

  it("happy path: relay discovery → lock → encrypted payment details → paid → seller releases", async () => {
    const parsed = await publishOffer(1_000);
    const buyerStart = await usdtBalance(buyer.account.address);

    // Buyer takes the verified offer straight from the relay data.
    const tradeId = await buyer.client.takeOffer(parsed.offer, parsed.signature, USDT(250));
    const trade = await buyer.client.getTrade(tradeId);
    expect(trade.state).toBe(TradeState.LOCKED);

    // Buyer introduces themselves to the seller's bound Nostr key.
    const relayUrls = relays.map((r) => r.url);
    const buyerChat = new TradeChat(pool, relayUrls, buyer.identity);
    const sellerChat = new TradeChat(pool, relayUrls, seller.identity);
    await buyerChat.send(parsed.event.pubkey, { type: "hello", tradeId: tradeId.toString(), binding: buyer.binding });

    // Seller only shares bank details after proving the hello comes from trade.buyer ON-CHAIN.
    const [hello] = await sellerChat.inbox(tradeId);
    expect(await verifyHello(hello!, (await seller.client.getTrade(tradeId)).buyer)).toBe(true);
    await sellerChat.send(hello!.from, { type: "payment_details", tradeId: tradeId.toString(), method: "bank-transfer", instructions: "Zenith Bank 2200110033", payeeName: "Ada Obi" });

    const [details] = await buyerChat.inbox(tradeId);
    expect(details!.message).toMatchObject({ type: "payment_details", instructions: "Zenith Bank 2200110033" });
    expect(relays.some((r) => r.events.some((e) => e.content.includes("2200110033")))).toBe(false);

    // Buyer pays off-chain, commits to encrypted proof on-chain.
    const receipt = await encryptEvidence(new TextEncoder().encode("NIP transfer ₦400,000 to Ada Obi, session 000015260917"));
    await buyer.client.markPaid(tradeId, receipt.commitment);
    expect(await buyer.client.paymentCommitment(tradeId)).toBe(receipt.commitment);

    // Seller checks their own bank app, then releases. Nobody else could.
    await seller.client.release(tradeId);
    expect((await buyer.client.getTrade(tradeId)).state).toBe(TradeState.RELEASED);
    expect(await usdtBalance(buyer.account.address)).toBe(buyerStart + USDT(250));
  });

  it("buy offer: buyer posts, seller fills from vault then wallet, chat both ways, paid, released", async () => {
    const t = { ...terms, escrow: d.escrow, price: "1590", paymentMethods: ["opay"] };
    const offer = createBuyOffer({
      buyer: buyer.account.address,
      token: d.usdt,
      minAmount: USDT(10),
      maxAmount: USDT(5_000),
      totalAmount: USDT(5_000),
      paymentWindow: 1800n,
      releaseWindow: 3600n,
      arbitrator: d.primaryArbitrator,
      fallbackArbitrator: d.fallbackArbitrator,
      nonce: await buyer.client.makerNonce(buyer.account.address),
      expiry: (await chainNow()) + 86400n,
      terms: t,
    });
    const signature = await signOffer(buyer.account, offer, t.chainId, t.escrow);
    await book.publish(buildOfferEvent({ offer, signature, terms: t, binding: buyer.binding, identity: buyer.identity }));

    // Sellers browse buy offers by side; the buyer is the verified maker.
    const { offers } = await book.fetch({ chainId: 31337, side: "buy", maker: buyer.account.address });
    const parsed = offers.find((o) => o.offerHash === hashOffer(offer, t.chainId, t.escrow))!;
    expect(parsed.side).toBe("buy");
    expect(await seller.client.remaining(parsed.offer)).toBe(USDT(5_000));
    expect(await seller.client.onchainOfferHash(parsed.offer)).toBe(parsed.offerHash);

    // Seller fills more than their vault holds: the vault is used first, only the shortfall comes from the wallet.
    const free = await seller.client.freeBalance(seller.account.address, d.usdt);
    const amount = free + USDT(100);
    const walletBefore = await usdtBalance(seller.account.address);
    const buyerStart = await usdtBalance(buyer.account.address);
    const tradeId = await seller.client.takeOffer(parsed.offer, parsed.signature, amount);

    const trade = await seller.client.getTrade(tradeId);
    expect([trade.seller, trade.buyer, trade.state]).toEqual([seller.account.address, buyer.account.address, TradeState.LOCKED]);
    expect(walletBefore - (await usdtBalance(seller.account.address))).toBe(USDT(100));
    expect(await seller.client.freeBalance(seller.account.address, d.usdt)).toBe(0n);
    expect(await seller.client.remaining(parsed.offer)).toBe(USDT(5_000) - amount);

    // The taker (seller) introduces themselves to the maker's bound key; the buyer checks it against trade.seller.
    const relayUrls = relays.map((r) => r.url);
    const sellerChat = new TradeChat(pool, relayUrls, seller.identity);
    const buyerChat = new TradeChat(pool, relayUrls, buyer.identity);
    await sellerChat.send(parsed.event.pubkey, { type: "hello", tradeId: tradeId.toString(), binding: seller.binding });
    await sellerChat.send(parsed.event.pubkey, { type: "payment_details", tradeId: tradeId.toString(), method: "opay", instructions: "Opay 8123456789" });
    const inbox = await buyerChat.inbox(tradeId);
    const hello = inbox.find((m) => m.message.type === "hello")!;
    expect(await verifyHello(hello, trade.seller)).toBe(true);
    expect(inbox.find((m) => m.message.type === "payment_details")?.from).toBe(hello.from);

    // Buyer pays, tells the seller the reference, and the seller sees it next to their own message.
    await buyer.client.markPaid(tradeId, (await encryptEvidence(new TextEncoder().encode("Opay ref OPY-99"))).commitment);
    await buyerChat.send(hello.from, { type: "payment_sent", tradeId: tradeId.toString(), reference: "OPY-99" });
    const sellerThread = await sellerChat.inbox(tradeId);
    expect(sellerThread.some((m) => m.mine && m.message.type === "payment_details")).toBe(true);
    expect(sellerThread.some((m) => !m.mine && m.message.type === "payment_sent")).toBe(true);

    await seller.client.release(tradeId);
    expect(await usdtBalance(buyer.account.address)).toBe(buyerStart + amount);
    await seller.client.deposit(d.usdt, USDT(2_000)); // restore the vault for later tests
  });

  it("dispute: evidence sealed to the assigned licensed-firm panelist, ruling executes on-chain", async () => {
    const parsed = await publishOffer(1_000);
    const buyerStart = await usdtBalance(buyer.account.address);
    const claimableStart = await buyer.client.claimableNative(buyer.account.address);
    const tradeId = await buyer.client.takeOffer(parsed.offer, parsed.signature, USDT(100));

    const receiptBytes = new TextEncoder().encode("Bank statement: ₦160,000 debited to Ada Obi, session 000015260917999");
    const receipt = await encryptEvidence(receiptBytes);
    ipfs.set(receipt.commitment, receipt.ciphertext);
    await buyer.client.markPaid(tradeId, receipt.commitment);

    // Seller never releases. After the release window, buyer disputes; seller matches the fee.
    await warp(3601);
    await buyer.client.openDispute(tradeId);
    const disputeId = await seller.client.payArbitrationFee(tradeId);
    expect((await buyer.client.getTrade(tradeId)).state).toBe(TradeState.DISPUTED);

    // The arbitration FIRM (not EscrowX) registers its panelist's encryption key and assigns the case.
    const firm = wallet(privateKeyToAccount(KEYS.firmAdmin));
    const adapter = { address: d.primaryArbitrator, abi: licensedArbitratorAdapterAbi } as const;
    await publicClient.waitForTransactionReceipt({
      hash: await firm.writeContract({ ...adapter, functionName: "setPanelist", args: [panelist.account.address, true, adapterKeyFromNostrPubkey(panelist.identity.publicKey)] }),
    });
    await publicClient.waitForTransactionReceipt({ hash: await firm.writeContract({ ...adapter, functionName: "assign", args: [disputeId, panelist.account.address] }) });

    // Buyer reads the assigned panelist's key from the chain and anchors sealed evidence on-chain.
    const assigned = (await publicClient.readContract({ ...adapter, functionName: "getCase", args: [disputeId] })).assignee;
    const panelistKey = nostrPubkeyFromAdapterKey(await publicClient.readContract({ ...adapter, functionName: "encryptionKey", args: [assigned] }));
    const sealed = sealEvidenceKey(buyer.identity, panelistKey, { tradeId: tradeId.toString(), commitment: receipt.commitment, key: keyToHex(receipt.key), uri: `ipfs://${receipt.commitment}` });
    await buyer.client.submitEvidence(tradeId, formatEvidenceUri(buyer.identity.publicKey, panelistKey, sealed));

    // Panelist: finds evidence on-chain, opens it, and verifies it against the buyer's markPaid commitment.
    const [submission] = await panelist.client.evidence(tradeId);
    expect(submission!.party.toLowerCase()).toBe(buyer.account.address.toLowerCase());
    const pointer = parseEvidenceUri(submission!.uri)!;
    const opened = openEvidenceKey(panelist.identity, pointer.senderPubkey, pointer.sealed);
    const onchainCommitment = await panelist.client.paymentCommitment(tradeId);
    const plaintext = await decryptEvidence(ipfs.get(opened.commitment)!, keyFromHex(opened.key), onchainCommitment!);
    expect(new TextDecoder().decode(plaintext)).toContain("₦160,000");

    // The seller (or anyone else) reading the same public evidence can't open it.
    expect(() => openEvidenceKey(seller.identity, pointer.senderPubkey, pointer.sealed)).toThrow();

    // Panelist rules for the buyer; after the firm's review period anyone can execute.
    const panelistWallet = wallet(panelist.account);
    await publicClient.waitForTransactionReceipt({
      hash: await panelistWallet.writeContract({ ...adapter, functionName: "proposeRuling", args: [disputeId, 1n, keccak256(toBytes("Statement shows the transfer"))] }),
    });
    await warp(86400);
    await publicClient.waitForTransactionReceipt({ hash: await firm.writeContract({ ...adapter, functionName: "executeRuling", args: [disputeId] }) });

    expect((await buyer.client.getTrade(tradeId)).state).toBe(TradeState.RELEASED);
    expect(await usdtBalance(buyer.account.address)).toBe(buyerStart + USDT(100));
    const fee = await buyer.client.arbitrationCost(d.primaryArbitrator);
    expect(await buyer.client.claimableNative(buyer.account.address)).toBe(claimableStart + fee); // loser (seller) paid
  });

  it("on-chain cancellation beats any cached copy of the offer", async () => {
    const parsed = await publishOffer(600);
    await seller.client.cancelOffer(parsed.offer);
    expect(await buyer.client.remaining(parsed.offer)).toBe(0n);
    await expect(buyer.client.takeOffer(parsed.offer, parsed.signature, USDT(50))).rejects.toThrow(/offer cancelled/);
  });
});
