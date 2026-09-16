// src/config/escrow.ts

// Put your latest deployed escrow address here (from ./deploy-all.sh output)
export const ESCROW_ADDRESS =
  "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e" as const;

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

  // 🔍 Production debugging: confirm the on-chain backend signer address
  {
    type: "function",
    name: "backendSigner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },

  // 🔍 EIP-712 debugging (only works if your contract exposes this function)
  // If your contract uses a different name (e.g. "domainSeparator"), change it here to match.
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
] as const;
