// src/pages/api/escrow/sign-resolve.ts
// EIP-712 backend signature generator for dispute resolution (Release / Refund)
//
// AUTH: the caller must sign resolveAuthMessage(...) with the wallet that is the
// escrow's on-chain backendSigner. Without this, anyone could obtain resolution
// signatures for any disputed trade.

import type { NextApiRequest, NextApiResponse } from "next";
import { ethers } from "ethers";
import { ESCROW_ADDRESS } from "@/config/escrow";
import { resolveAuthMessage, RESOLVE_AUTH_TTL_SECONDS } from "@/lib/resolveAuth";

const ESCROW_ABI = [
  {
    type: "function",
    name: "backendSigner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "trades",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "seller", type: "address" },
      { name: "buyer", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "lockDeadline", type: "uint64" },
      { name: "fiatDeadline", type: "uint64" },
      { name: "state", type: "uint8" },
    ],
  },
] as const;

// Must match contract exactly
const RELEASE_TYPE = [
  { name: "tradeId", type: "bytes32" },
  { name: "buyer", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "expiresAt", type: "uint64" },
  { name: "nonce", type: "bytes32" },
];

const REFUND_TYPE = [
  { name: "tradeId", type: "bytes32" },
  { name: "seller", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "expiresAt", type: "uint64" },
  { name: "nonce", type: "bytes32" },
];

const State = { DISPUTE: 5 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const tradeId = String(req.body?.tradeId ?? "").trim();
    const buyerWinsRaw = req.body?.buyerWins;

    const buyerWins =
      typeof buyerWinsRaw === "boolean"
        ? buyerWinsRaw
        : String(buyerWinsRaw).toLowerCase() === "true";

    if (!/^0x[0-9a-fA-F]{64}$/.test(tradeId)) {
      return res.status(400).json({ error: "Invalid tradeId — must be 0x + 64 hex chars" });
    }

    const pk = process.env.BACKEND_SIGNER_PRIVATE_KEY;
    if (!pk) return res.status(500).json({ error: "Missing BACKEND_SIGNER_PRIVATE_KEY in environment" });

    const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8545";
    const contractAddress = ESCROW_ADDRESS;

    const issuedAt = Number(req.body?.issuedAt);
    const authSig = String(req.body?.authSig ?? "");
    if (!Number.isInteger(issuedAt) || !/^0x[0-9a-fA-F]{130}$/.test(authSig)) {
      return res.status(401).json({ error: "Missing or malformed admin auth (issuedAt, authSig)" });
    }
    const now = Math.floor(Date.now() / 1000);
    if (issuedAt > now + 60 || now - issuedAt > RESOLVE_AUTH_TTL_SECONDS) {
      return res.status(401).json({ error: "Admin auth expired — sign again" });
    }

    const provider = new ethers.JsonRpcProvider(rpc);
    const contract = new ethers.Contract(contractAddress, ESCROW_ABI, provider);
    const chainId = (await provider.getNetwork()).chainId; // bigint

    const message = resolveAuthMessage({
      tradeId,
      buyerWins,
      issuedAt,
      chainId: Number(chainId),
      escrow: contractAddress,
    });

    let caller: string;
    try {
      caller = ethers.verifyMessage(message, authSig);
    } catch {
      return res.status(401).json({ error: "Invalid admin auth signature" });
    }

    const onchainSigner: string = await contract.backendSigner();
    if (caller.toLowerCase() !== onchainSigner.toLowerCase()) {
      return res.status(403).json({ error: "Only the escrow backend signer may request resolutions" });
    }

    // Defence in depth: the server key must be the key the contract trusts.
    const wallet = new ethers.Wallet(pk);
    if (wallet.address.toLowerCase() !== onchainSigner.toLowerCase()) {
      return res.status(500).json({ error: "Server signer key does not match on-chain backendSigner" });
    }

    const trade = await contract.trades(tradeId);
    const seller: string = trade.seller;
    const buyer: string = trade.buyer;
    const amount: bigint = trade.amount;
    const stateNum: number = Number(trade.state);

    if (!buyer || buyer === ethers.ZeroAddress) {
      return res.status(400).json({ error: "Trade not found on-chain" });
    }

    // 🔒 production safety: only sign dispute resolutions in DISPUTE state
    if (stateNum !== State.DISPUTE) {
      return res.status(400).json({ error: `Trade not in DISPUTE state (state=${stateNum})` });
    }

    const domain = {
      name: "P2PEscrow",
      version: "2",
      chainId,
      verifyingContract: contractAddress,
    };

    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 600);
    const nonce = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;

    const releaseValue = { tradeId, buyer, amount, expiresAt, nonce };
    const refundValue = { tradeId, seller, amount, expiresAt, nonce };

    const digest = buyerWins
      ? ethers.TypedDataEncoder.hash(domain, { Release: RELEASE_TYPE }, releaseValue)
      : ethers.TypedDataEncoder.hash(domain, { Refund: REFUND_TYPE }, refundValue);

    // Sign raw digest (NO EIP-191 wrapping)
    const sigObj = wallet.signingKey.sign(digest);
    const backendSig = ethers.Signature.from(sigObj).serialized;

    return res.status(200).json({
      expiresAt: Number(expiresAt),
      nonce,
      backendSig,
    });
  } catch (e: any) {
    console.error("[sign-resolve] error:", e);
    return res.status(500).json({ error: "Internal error while signing resolution" });
  }
}