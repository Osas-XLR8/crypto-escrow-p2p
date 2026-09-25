// src/client.ts — typed wrapper around EscrowCoreV4 for wallets and apps.
// Every write is simulated first so contract revert reasons surface before the user signs.

import {
  erc20Abi,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { escrowCoreV4Abi } from "./abi/escrowCoreV4.js";
import { licensedArbitratorAdapterAbi } from "./abi/licensedArbitratorAdapter.js";
import { isBuyOffer, type AnyOffer, type Offer } from "./types.js";

export enum TradeState {
  NONE = 0,
  LOCKED = 1,
  PAID = 2,
  FEE_PENDING = 3,
  DISPUTED = 4,
  RELEASED = 5,
  CANCELLED = 6,
}

export type OnchainTrade = {
  seller: Address;
  buyer: Address;
  token: Address;
  arbitrator: Address;
  fallbackArbitrator: Address;
  activeArbitrator: Address;
  amount: bigint;
  offerHash: Hex;
  termsHash: Hex;
  paymentDeadline: bigint;
  releaseWindow: bigint;
  releaseDeadline: bigint;
  state: TradeState;
};

export type OnchainDispute = {
  opener: Address;
  feeDeadline: bigint;
  startedAt: bigint;
  escalated: boolean;
  disputeId: bigint;
  paidBuyer: bigint;
  paidSeller: bigint;
  pool: bigint;
};

/**
 * What a write is doing right now. "signing" is the wallet's prompt (abandonable); "sent" means a
 * transaction exists on the network and only time will resolve it.
 */
export type Activity =
  | { phase: "checking"; functionName: string }
  | { phase: "signing"; functionName: string }
  | { phase: "sent"; functionName: string; hash: Hex }
  | { phase: "confirmed"; functionName: string; hash: Hex };

/** A multi-transaction call reports each wallet prompt before it opens, so the UI can say "step 2 of 3". */
export interface Step {
  index: number;
  total: number;
  label: string;
}

export interface StepOptions {
  onStep?: (step: Step) => void;
}

function steps(opts: StepOptions, labels: string[]): () => void {
  let index = 0;
  return () => {
    index++;
    opts.onStep?.({ index, total: labels.length, label: labels[index - 1]! });
  };
}

export class EscrowV4Client {
  constructor(
    readonly publicClient: PublicClient,
    readonly escrow: Address,
    readonly walletClient?: WalletClient
  ) {}

  private listeners = new Set<(event: Activity) => void>();

  /**
   * Watch what a write is doing, so a UI can say which of the two waits it is in. The difference matters:
   * waiting for a signature can be abandoned safely, waiting for a receipt cannot — the transaction is
   * already out there, and retrying would send a second one.
   */
  onActivity(listener: (event: Activity) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: Activity) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a broken listener must not break the transaction */
      }
    }
  }

  // ─── Reads ──────────────────────────────────────────────────────────────────

  async getTrade(tradeId: bigint): Promise<OnchainTrade> {
    const t = await this.publicClient.readContract({ address: this.escrow, abi: escrowCoreV4Abi, functionName: "getTrade", args: [tradeId] });
    return { ...t, state: Number(t.state) as TradeState };
  }

  async getDispute(tradeId: bigint): Promise<OnchainDispute> {
    return this.publicClient.readContract({ address: this.escrow, abi: escrowCoreV4Abi, functionName: "getDispute", args: [tradeId] });
  }

  /**
   * Amount still takeable from an offer, considering cancellation, nonce, expiry and fills — and for a sell
   * offer the seller's vault balance too (a buy offer is funded by whichever seller takes it).
   */
  remaining(offer: AnyOffer): Promise<bigint> {
    return isBuyOffer(offer)
      ? this.publicClient.readContract({ address: this.escrow, abi: escrowCoreV4Abi, functionName: "remainingBuy", args: [offer] })
      : this.publicClient.readContract({ address: this.escrow, abi: escrowCoreV4Abi, functionName: "remaining", args: [offer] });
  }

  onchainOfferHash(offer: AnyOffer): Promise<Hex> {
    return isBuyOffer(offer)
      ? this.publicClient.readContract({ address: this.escrow, abi: escrowCoreV4Abi, functionName: "hashBuyOffer", args: [offer] })
      : this.publicClient.readContract({ address: this.escrow, abi: escrowCoreV4Abi, functionName: "hashOffer", args: [offer] });
  }

  /** Current offer nonce of a maker (shared by their sell and buy offers). */
  makerNonce(maker: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: this.escrow, abi: escrowCoreV4Abi, functionName: "makerNonce", args: [maker] });
  }

  /** @deprecated use makerNonce */
  sellerNonce(seller: Address): Promise<bigint> {
    return this.makerNonce(seller);
  }

  freeBalance(seller: Address, token: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: this.escrow, abi: escrowCoreV4Abi, functionName: "freeBalance", args: [seller, token] });
  }

  claimableNative(account: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: this.escrow, abi: escrowCoreV4Abi, functionName: "claimableNative", args: [account] });
  }

  arbitrationCost(arbitrator: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: arbitrator, abi: licensedArbitratorAdapterAbi, functionName: "arbitrationCost", args: ["0x"] });
  }

  /** The buyer's evidence commitment from markPaid, read from the PaymentMarked event. */
  async paymentCommitment(tradeId: bigint, fromBlock = 0n): Promise<Hex | null> {
    const logs = await this.publicClient.getContractEvents({
      address: this.escrow,
      abi: escrowCoreV4Abi,
      eventName: "PaymentMarked",
      args: { tradeId },
      fromBlock,
    });
    return logs.at(-1)?.args.evidenceCommitment ?? null;
  }

  /** ERC-1497 evidence pointers submitted for a trade, oldest first. */
  async evidence(tradeId: bigint, fromBlock = 0n): Promise<{ party: Address; uri: string; arbitrator: Address }[]> {
    const logs = await this.publicClient.getContractEvents({
      address: this.escrow,
      abi: escrowCoreV4Abi,
      eventName: "Evidence",
      args: { evidenceGroupID: tradeId },
      fromBlock,
    });
    return logs.map((l) => ({ party: l.args.party!, uri: l.args.evidence!, arbitrator: l.args.arbitrator! }));
  }

  // ─── Writes ─────────────────────────────────────────────────────────────────

  private wallet(): { wallet: WalletClient; account: Account; chain: Chain | undefined } {
    const wallet = this.walletClient;
    if (!wallet?.account) throw new Error("a wallet client with an account is required for writes");
    return { wallet, account: wallet.account, chain: wallet.chain };
  }

  private async write(functionName: string, args: readonly unknown[], value?: bigint) {
    const { wallet, account, chain } = this.wallet();
    this.emit({ phase: "checking", functionName });
    const { request } = await this.publicClient.simulateContract({
      address: this.escrow,
      abi: escrowCoreV4Abi,
      functionName: functionName as never,
      args: args as never,
      account,
      value,
    } as never);
    this.emit({ phase: "signing", functionName });
    const hash = await wallet.writeContract({ ...(request as object), chain } as never);
    this.emit({ phase: "sent", functionName, hash });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    this.emit({ phase: "confirmed", functionName, hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    // Public RPCs are load-balanced: the next call can land on a node that hasn't seen this block yet, which
    // would simulate the following action against stale state. Wait until the endpoint has caught up.
    await waitUntil(async () => (await this.publicClient.getBlockNumber({ cacheTime: 0 })) >= receipt.blockNumber);
    return receipt;
  }

  /** Approves exactly `amount` (never unlimited) and deposits it into the seller vault. */
  async deposit(token: Address, amount: bigint, opts: StepOptions = {}) {
    const step = steps(opts, ["Approve the escrow to move your tokens", "Move the tokens into your vault"]);
    step();
    await this.approveExactly(token, amount);
    step();
    return this.write("deposit", [token, amount]);
  }

  /** Sets the escrow's allowance to exactly `amount` and waits until the RPC can see it. */
  private async approveExactly(token: Address, amount: bigint) {
    const { wallet, account, chain } = this.wallet();
    this.emit({ phase: "checking", functionName: "approve" });
    const { request } = await this.publicClient.simulateContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.escrow, amount],
      account,
    });
    this.emit({ phase: "signing", functionName: "approve" });
    const approveHash = await wallet.writeContract({ ...request, chain } as never);
    this.emit({ phase: "sent", functionName: "approve", hash: approveHash });
    await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
    this.emit({ phase: "confirmed", functionName: "approve", hash: approveHash });
    // Load-balanced public RPCs can answer the next call from a node that hasn't seen the approval yet,
    // which makes the following simulation fail with "transferFrom failed". Wait until the allowance shows.
    await waitUntil(async () => {
      const allowance = await this.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account.address, this.escrow] });
      return allowance >= amount;
    });
  }

  withdraw(token: Address, amount: bigint) {
    return this.write("withdraw", [token, amount]);
  }

  bumpNonce() {
    return this.write("bumpNonce", []);
  }

  /** On-chain cancellation of your own offer (either kind): it can never be taken again. */
  cancelOffer(offer: AnyOffer) {
    return isBuyOffer(offer) ? this.write("cancelBuyOffer", [offer]) : this.write("cancelOffer", [offer]);
  }

  /**
   * Opens a trade from an offer and returns the new trade id. The seller's crypto is locked either way:
   * - sell offer (you are the buyer): locked from the seller's vault
   * - buy offer (you are the seller): locked from your vault first, the shortfall from your wallet —
   *   this approves exactly that shortfall (never an unlimited allowance) before taking.
   */
  async takeOffer(offer: AnyOffer, signature: Hex, amount: bigint, opts: StepOptions = {}): Promise<bigint> {
    let receipt;
    if (isBuyOffer(offer)) {
      const { account } = this.wallet();
      const free = await this.freeBalance(account.address, offer.token);
      const shortfall = free < amount ? amount - free : 0n;
      const step = steps(opts, shortfall > 0n ? ["Approve the escrow to move your tokens", "Lock your crypto in escrow"] : ["Lock your crypto in escrow"]);
      if (shortfall > 0n) {
        step();
        await this.approveExactly(offer.token, shortfall);
      }
      step();
      receipt = await this.write("takeBuyOffer", [offer, signature, amount]);
    } else {
      const step = steps(opts, ["Lock the seller's crypto in escrow"]);
      step();
      receipt = await this.write("takeOffer", [offer, signature, amount]);
    }
    const [opened] = parseEventLogs({ abi: escrowCoreV4Abi, eventName: "TradeOpened", logs: receipt.logs });
    if (!opened) throw new Error("TradeOpened event not found");
    return opened.args.tradeId;
  }

  markPaid(tradeId: bigint, evidenceCommitment: Hex) {
    return this.write("markPaid", [tradeId, evidenceCommitment]);
  }

  release(tradeId: bigint) {
    return this.write("release", [tradeId]);
  }

  buyerCancel(tradeId: bigint) {
    return this.write("buyerCancel", [tradeId]);
  }

  cancelUnpaid(tradeId: bigint) {
    return this.write("cancelUnpaid", [tradeId]);
  }

  async openDispute(tradeId: bigint) {
    const trade = await this.getTrade(tradeId);
    return this.write("openDispute", [tradeId], await this.arbitrationCost(trade.arbitrator));
  }

  async payArbitrationFee(tradeId: bigint): Promise<bigint> {
    const trade = await this.getTrade(tradeId);
    await this.write("payArbitrationFee", [tradeId], await this.arbitrationCost(trade.arbitrator));
    return (await this.getDispute(tradeId)).disputeId;
  }

  /** Pays only the shortfall between the fallback's fee and what the dispute pool already holds. */
  async escalateToFallback(tradeId: bigint) {
    const [trade, dispute] = await Promise.all([this.getTrade(tradeId), this.getDispute(tradeId)]);
    const cost = await this.arbitrationCost(trade.fallbackArbitrator);
    return this.write("escalateToFallback", [tradeId], cost > dispute.pool ? cost - dispute.pool : 0n);
  }

  claimFeeTimeout(tradeId: bigint) {
    return this.write("claimFeeTimeout", [tradeId]);
  }

  claimArbitrationTimeout(tradeId: bigint) {
    return this.write("claimArbitrationTimeout", [tradeId]);
  }

  submitEvidence(tradeId: bigint, uri: string) {
    return this.write("submitEvidence", [tradeId, uri]);
  }

  withdrawNative() {
    return this.write("withdrawNative", []);
  }
}

/** Polls `check` until it returns true (or gives up after `timeoutMs`, letting the caller's next step surface the error). */
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 20_000, intervalMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
