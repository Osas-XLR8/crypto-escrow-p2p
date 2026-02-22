# Crypto Escrow P2P — Project Context (AI Handoff)

This file explains the system at a high level so any engineer or AI assistant can instantly understand the project, run it locally, and continue development safely.

---

## 1) What this project is

A demo P2P escrow system for token-based trades (USDT-style token), built with:

- **Solidity + Foundry** smart contracts
- **Local Anvil** chain for development/testing
- **Next.js** frontend UI
- **RainbowKit + wagmi** for wallet connection
- A “backend signer” model for authorizing sensitive actions (release/refund/dispute resolution)

---

## 2) Core purpose (why we built it)

We want a working **state-machine escrow** that demonstrates:

- Creating a trade on-chain
- Seller depositing the token amount into escrow
- Buyer confirming fiat payment off-chain (simulated)
- Funds being released on-chain (authorized by backend signer)
- Disputes that can be opened and resolved safely

This is the foundation for:
- A **P2P marketplace backend system** (demo version first)
- Future API/DB layer and user workflows

---

## 3) Project structure (typical)

Root folder:
- `crypto-escrow-p2p/`

Contracts (Foundry):
- `packages/contracts/`
  - `src/P2PEscrow.sol`
  - `src/P2PEscrowTestable.sol` (testable/dev helper)
  - `test/` tests
  - `deploy-all.sh`
  - `smoke-negative.sh`
  - `.deployments/.env` (generated after deploy)

Frontend (Next.js):
- `packages/frontend/` (or equivalent Next.js folder)
  - `src/pages/index.tsx`
  - `src/components/CreateTrade.tsx`
  - `src/config/escrow.ts`
  - wagmi + rainbowkit config

---

## 4) Escrow state machine

State labels:
- `0 = NONE`
- `1 = CREATED`
- `2 = LOCKED`
- `3 = RELEASED`
- `4 = REFUNDED`
- `5 = DISPUTE`

Typical flow:
1) Backend creates trade → state CREATED
2) Seller deposits tokens → state LOCKED
3) Backend authorizes release → state RELEASED
4) If dispute opened while locked → state DISPUTE
5) Backend resolves dispute (release or refund)

---

## 5) Contract functions (high level)

Reads:
- `trades(bytes32 tradeId) -> (seller, buyer, amount, lockDeadline, fiatDeadline, state)`
- `releaseDigest(tradeId, expiresAt, nonce) -> bytes32`
- `refundDigest(tradeId, expiresAt, nonce) -> bytes32`

Writes:
- `createTrade(tradeId, seller, buyer, amount, lockDeadline, fiatDeadline)` (backend only)
- `deposit(tradeId)` (seller only)
- `refund(tradeId)`
- `openDispute(tradeId)`
- `release(tradeId, expiresAt, nonce, backendSig)` (authorized)
- `resolveDisputeRelease(tradeId, expiresAt, nonce, backendSig)` (authorized)
- `resolveDisputeRefund(tradeId, expiresAt, nonce, backendSig)` (authorized)

---

## 6) Backend signer model (important)

Sensitive actions require a valid backend signature:

- Backend creates a digest on-chain (via `releaseDigest` / `refundDigest`)
- Backend signs the digest with the backend signer private key
- Contract verifies:
  - signature matches `backendSigner`
  - `expiresAt` not expired
  - digest not used before (replay protection)
  - trade is in correct state

This is used for:
- `release`
- `resolveDisputeRelease`
- `resolveDisputeRefund`

---

## 7) Local dev environment

### Chain
- Anvil RPC (usually):
  - `http://127.0.0.1:8545`
- Chain ID often:
  - `31337`

### Deployment
From `packages/contracts/`:
- `./deploy-all.sh --smoke`
This:
- deploys MockUSDT
- deploys Escrow
- writes `.deployments/.env`
- runs smoke tests

### Environment file
Generated:
- `packages/contracts/.deployments/.env`

Common keys:
- `RPC=http://127.0.0.1:8545`
- `ESCROW_ADDR=...`
- `USDT_ADDR=...`
- `ESCROW_TOKEN=...`
- `DEPLOYER=...`
- `BACKEND_SIGNER=...`

Note: Some scripts expect `ESCROW` variable, so sometimes we export:
- `export ESCROW=$ESCROW_ADDR`

---

## 8) Smoke tests (quick verification)

From `packages/contracts/`:
- `./deploy-all.sh --smoke`  (should pass)
- `./smoke-negative.sh`      (tests expected failures + success cases)

Negative suite usually checks:
- deposit by non-seller fails
- valid seller deposit succeeds
- wrong backend signer signature fails
- expired authorization fails
- replay protection works

---

## 9) Frontend behavior

The UI supports:
- Wallet connect
- Create trade (backend-only wallet required)
- Trade lookup by bytes32 tradeId
- Deposit (seller)
- Refund
- Open Dispute
- Display state and trade fields

Important UI rule:
- Some actions should only be enabled depending on state:
  - Deposit only when state is CREATED
  - Open dispute only when state is LOCKED
  - Resolve only when state is DISPUTE
  - Release only when state is LOCKED

---

## 10) Current status (as of latest work)

- Deployment + smoke tests pass
- Trade creation works
- Deposit works when using the seller wallet
- Dispute and release flows are tested
- UI is functional for demo state-machine testing

---

## 11) Next steps (what we should build next)

### Demo completeness
- Make UI enforce correct state-action gating
- Improve UX: clearer status, error messages, tx links

### Backend for marketplace demo
- Minimal API service:
  - create trade requests
  - store trades in DB
  - compute tradeId deterministically
  - generate signed authorizations for release/refund

### Security hardening
- Strict replay protection review
- Ensure tradeId uniqueness
- Ensure proper token handling
- Tight access controls for backend-only calls

---

## 12) Rules for any AI assistant working on this project

When suggesting changes:
- Do NOT break the state machine
- Do NOT weaken signature verification
- Keep things simple and demo-focused first
- Prefer explicit checks and readable code over clever hacks
- Always provide step-by-step instructions for the user

---