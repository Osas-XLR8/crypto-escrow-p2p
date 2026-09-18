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

SDK (TypeScript client toolkit for v4):
- `packages/sdk/` — signed offers on Nostr, encrypted trade chat, sealed evidence, typed contract client

Frontend (Next.js, v4 reference client):
- `packages/contracts/my-rainbowkit-app/`
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
1) Operator creates trade → state CREATED
2) Seller deposits tokens → state LOCKED
3) Anyone submits a backendSigner-signed release → state RELEASED
4) Buyer (until fiatDeadline) or operator (any time) opens dispute → state DISPUTE
5) Operator resolves dispute with a backendSigner signature (release or refund)
6) If a dispute is unresolved for `DISPUTE_TIMEOUT` (7 days), anyone can call
   `claimDisputeTimeout` → seller refunded

---

## 5) Contract functions (high level) — P2PEscrow v3

Reads:
- `trades(bytes32 tradeId) -> (seller, buyer, amount, lockDeadline, fiatDeadline, state)`
- `releaseDigest / resolveReleaseDigest / refundDigest(tradeId, expiresAt, nonce) -> bytes32`
- `owner()`, `pendingOwner()`, `backendSigner()`, `operator()`, `paused()`
- `disputeOpenedAt(tradeId) -> uint64`, `DISPUTE_TIMEOUT() -> uint64`

Writes:
- `createTrade(tradeId, seller, buyer, amount, lockDeadline, fiatDeadline)` (operator only, not paused)
- `deposit(tradeId)` (seller only, not paused)
- `refund(tradeId)` (anyone, after the relevant deadline, not in dispute)
- `openDispute(tradeId)` (buyer until fiatDeadline, or operator)
- `release(tradeId, expiresAt, nonce, backendSig)` (anyone, with `Release` signature)
- `resolveDisputeRelease(tradeId, expiresAt, nonce, backendSig)` (operator, with `ResolveRelease` signature)
- `resolveDisputeRefund(tradeId, expiresAt, nonce, backendSig)` (operator, with `Refund` signature)
- `claimDisputeTimeout(tradeId)` (anyone, after dispute timeout → refunds seller)

Admin (owner only):
- `setBackendSigner(addr)`, `setOperator(addr)` — key rotation
- `pause()` / `unpause()` — blocks createTrade + deposit ONLY; every exit path stays open
- `transferOwnership(addr)` + `acceptOwnership()` — two-step

---

## 6) Roles & signature model (important)

Three separate keys (they default to the deployer locally):

| Role | Holds | Can do |
|---|---|---|
| `owner` | cold key / multisig | rotate signer/operator, pause, transfer ownership |
| `backendSigner` | server-side key (`BACKEND_SIGNER_PRIVATE_KEY`) | sign EIP-712 authorizations only |
| `operator` | hot wallet (connected in the UI) | create trades, open disputes, submit resolutions |

Dispute resolution needs BOTH the operator (tx sender) AND a backendSigner
signature, so a single leaked key cannot move disputed funds.

EIP-712 domain: `name="P2PEscrow"`, `version="3"`, chainId, verifyingContract.
Each action has its own typehash (`Release`, `ResolveRelease`, `Refund`), so a
signature for one action can never be replayed as another. The contract also
checks expiry, digest/nonce replay, and rejects malleable (high-s) signatures.

Signatures are over the raw EIP-712 digest — sign with `cast wallet sign --no-hash`.

Frontend 1-click resolution: the operator wallet signs a short auth message
(`src/lib/resolveAuth.ts`); `/api/escrow/sign-resolve` verifies the signer is the
on-chain `operator` and that its own key matches `backendSigner`, then returns
the EIP-712 signature.

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
- Create trade (operator wallet required)
- Trade lookup by bytes32 tradeId
- Deposit (seller)
- Refund
- Open Dispute (buyer before fiat deadline, or operator)
- 1-click dispute resolution (operator) and Claim Timeout Refund (anyone, after 7 days)
- Role badge, paused banner, dispute countdown

Important UI rule:
- Some actions should only be enabled depending on state:
  - Deposit only when state is CREATED
  - Open dispute only when state is LOCKED
  - Resolve only when state is DISPUTE
  - Release only when state is LOCKED

---

## 10) Current status (as of latest work)

- P2PEscrow v3: role separation, key rotation, entry-only pause, dispute timeout
- 48 Foundry tests incl. fuzz (99% line coverage on P2PEscrow.sol)
- `demo-all.sh` (deploy + smoke + negative suite) passes with separate owner/signer/operator keys
- Frontend builds; `/api/escrow/sign-resolve` requires operator wallet auth
- CI (repo root `.github/workflows/ci.yml`): forge fmt/build/test + frontend typecheck/build
- v4 redesign underway on branches (see git log): EscrowCoreV4 (no platform control over funds),
  loser-pays arbitration + fallback arbitrator + licensed-firm adapter, @escrowx/sdk, and the web app
  migrated to v4 (Market / Sell / Trades, relay offer book, encrypted chat, sealed evidence)
- Web app redesigned (light/dark design system, onboarding checklist, fiat amounts on trades) and made
  network-agnostic: static export, chunked log scanning, TestUSDT faucet token, `deploy-testnet.sh` for
  Base Sepolia, and a GitHub Pages workflow (`.github/workflows/deploy-web.yml`)

---

## 11) Next steps (what we should build next)

### Product
- Trade indexing now scans in chunks from the deploy block; past a few hundred thousand blocks a shared
  indexer (or a persisted client cache) will be needed for fast first loads
- Clearer UX: tx explorer links, per-role guided flows

### Backend for marketplace demo
- Minimal API service + DB: create trade requests, deterministic tradeIds,
  signed release authorizations after fiat confirmation

### Security hardening
- Invariant tests (token balance == sum of LOCKED/DISPUTE amounts)
- Owner as multisig on any shared network; signer key in a KMS/HSM
- External audit before real funds

---

## 12) Rules for any AI assistant working on this project

When suggesting changes:
- Do NOT break the state machine
- Do NOT weaken signature verification
- Keep things simple and demo-focused first
- Prefer explicit checks and readable code over clever hacks
- Always provide step-by-step instructions for the user

---