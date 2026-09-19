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

export class EscrowV4Client {
  constructor(
    readonly publicClient: PublicClient,
    readonly escrow: Address,
    readonly walletClient?: WalletClient
  ) {}

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
    const { request } = await this.publicClient.simulateContract({
      address: this.escrow,
      abi: escrowCoreV4Abi,
      functionName: functionName as never,
      args: args as never,
      account,
      value,
    } as never);
    const hash = await wallet.writeContract({ ...(request as object), chain } as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return receipt;
  }

  /** Approves exactly `amount` (never unlimited) and deposits it into the seller vault. */
  async deposit(token: Address, amount: bigint) {
    await this.approveExactly(token, amount);
    return this.write("deposit", [token, amount]);
  }

  /** Sets the escrow's allowance to exactly `amount` and waits until the RPC can see it. */
  private async approveExactly(token: Address, amount: bigint) {
    const { wallet, account, chain } = this.wallet();
    const { request } = await this.publicClient.simulateContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.escrow, amount],
      account,
    });
    const approveHash = await wallet.writeContract({ ...request, chain } as never);
    await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
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
  async takeOffer(offer: AnyOffer, signature: Hex, amount: bigint): Promise<bigint> {
    let receipt;
    if (isBuyOffer(offer)) {
      const { account } = this.wallet();
      const free = await this.freeBalance(account.address, offer.token);
      if (free < amount) await this.approveExactly(offer.token, amount - free);
      receipt = await this.write("takeBuyOffer", [offer, signature, amount]);
    } else {
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
