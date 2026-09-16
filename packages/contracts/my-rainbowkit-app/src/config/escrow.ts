// src/config/escrow.ts

// Addresses come from NEXT_PUBLIC_* env vars, which ./deploy-all.sh writes into
// .env.local after every deploy. The fallbacks are only for builds without env (CI).

const isAddress = (v: string | undefined): v is `0x${string}` =>
  !!v && /^0x[0-9a-fA-F]{40}$/.test(v);

const envEscrow = process.env.NEXT_PUBLIC_ESCROW_ADDRESS;
const envUsdt = process.env.NEXT_PUBLIC_USDT_ADDRESS;

export const ESCROW_ADDRESS: `0x${string}` = isAddress(envEscrow)
  ? envEscrow
  : "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e";

export const USDT_ADDRESS: `0x${string}` = isAddress(envUsdt)
  ? envUsdt
  : "0x5FbDB2315678afecb367f032d93F642f64180aa3";

export const ESCROW_ABI = [
  // =========================
  // READS
  // =========================
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

  // Helps debug signature mismatches (digest computed by the contract)
  {
    type: "function",
    name: "releaseDigest",
    stateMutability: "view",
    inputs: [
      { name: "tradeId", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "refundDigest",
    stateMutability: "view",
    inputs: [
      { name: "tradeId", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },

  {
    type: "function",
    name: "resolveReleaseDigest",
    stateMutability: "view",
    inputs: [
      { name: "tradeId", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },

  // Roles & safety switches
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "backendSigner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "operator", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },

  // Dispute timeout
  { type: "function", name: "DISPUTE_TIMEOUT", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  {
    type: "function",
    name: "disputeOpenedAt",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint64" }],
  },

  // EIP-712 debugging
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },

  // =========================
  // WRITES
  // =========================

  // CREATE TRADE (operator only)
  {
    type: "function",
    name: "createTrade",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tradeId", type: "bytes32" },
      { name: "seller", type: "address" },
      { name: "buyer", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "lockDeadline", type: "uint64" },
      { name: "fiatDeadline", type: "uint64" },
    ],
    outputs: [],
  },

  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "tradeId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "tradeId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "openDispute",
    stateMutability: "nonpayable",
    inputs: [{ name: "tradeId", type: "bytes32" }],
    outputs: [],
  },

  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tradeId", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "nonce", type: "bytes32" },
      { name: "backendSig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "resolveDisputeRelease",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tradeId", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "nonce", type: "bytes32" },
      { name: "backendSig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "resolveDisputeRefund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tradeId", type: "bytes32" },
      { name: "expiresAt", type: "uint64" },
      { name: "nonce", type: "bytes32" },
      { name: "backendSig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimDisputeTimeout",
    stateMutability: "nonpayable",
    inputs: [{ name: "tradeId", type: "bytes32" }],
    outputs: [],
  },

  // Admin (owner only)
  { type: "function", name: "pause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "unpause", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;
