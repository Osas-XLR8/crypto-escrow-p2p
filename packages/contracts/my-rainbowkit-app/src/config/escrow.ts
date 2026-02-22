// src/config/escrow.ts

// Put your latest deployed escrow address here (from ./deploy-all.sh output)
export const ESCROW_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

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

  // =========================
  // WRITES
  // =========================

  // CREATE TRADE (backend only)
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

  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "tradeId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "refund", stateMutability: "nonpayable", inputs: [{ name: "tradeId", type: "bytes32" }], outputs: [] },
  { type: "function", name: "openDispute", stateMutability: "nonpayable", inputs: [{ name: "tradeId", type: "bytes32" }], outputs: [] },

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
] as const;
