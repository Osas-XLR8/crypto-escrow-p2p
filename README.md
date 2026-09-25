# Crypto Escrow P2P (Demo MVP)

A minimal, investor-safe P2P escrow demo:
- Seller deposits USDT (or a mock token in local demo)
- Buyer pays fiat off-chain
- Backend authorizes release using an EIP-712 signature
- Refunds after deadline (unless dispute)
- Disputes freeze funds until resolved — or auto-refund the seller after 7 days
- Separate owner / signer / operator keys, with rotation and an entry-only pause

> ⚠️ Demo MVP. Not audited. Do not use in production with real funds.

## What’s Included
- **Solidity escrow contract** (state machine + replay protection)
- **Foundry tests** (basic + negative suite)
- **Local dev scripts** (deploy + smoke tests)
- **Client SDK** (`packages/sdk`): signed offers on Nostr relays, end-to-end encrypted trade chat, encrypted dispute evidence, typed v4 contract client
- **Next.js web app** (RainbowKit/Wagmi): v4 reference client — two-sided relay order book (buy and sell offers),
  encrypted trade chat with on-chain milestones and notifications, disputes, arbitration desk.
  Builds to a static site; deploys to Base Sepolia + GitHub Pages (see [the app README](packages/contracts/my-rainbowkit-app/README.md#run-it))
- **Arbitration case records** ([docs/case-records.md](docs/case-records.md)): every dispute path run end to end
  on Base Sepolia, with the transactions — including a contested case where both sides filed sealed evidence.

> **Scope is frozen** as of 25 Sep 2026 ([docs/scope-freeze.md](docs/scope-freeze.md)): this build is what goes
> to audit. Defects and the audit's own findings still get fixed; features don't get added.

## Quick Demo (Local)

```bash
npm run demo
```

One command: frees stale ports, clears the build cache, installs, starts a local chain, deploys the contracts,
seeds a market with trade history and a recorded dispute, starts demo counterparties that answer trades you
open, and serves the app on http://localhost:3200. Ctrl-C stops all of it.

`npm run check:cold` loads the published site in a fresh browser profile with **no wallet extension** and fails
if anything the app promises in that state is missing. It runs on every deploy.

<details><summary>The longer way, step by step</summary>

### 1) Start local chain
```bash
anvil

Deploy + smoke test

cd packages/contracts
./demo-all.sh   # deploy + smoke + negative suite; also syncs addresses into the frontend .env.local

Frontend

cd packages/contracts/my-rainbowkit-app
npm install
npm run dev -- -p 3001

Open:

http://localhost:3001

</details>

Architecture (High level)

Operator wallet creates trades and submits dispute resolutions; a separate backend signer key signs authorizations; the owner key administers roles and pause.
Smart contract holds funds + enforces state machine.
Frontend reads state and triggers deposit/refund/dispute.

State Machine

NONE → CREATED → LOCKED → (RELEASED | REFUNDED | DISPUTE)
DISPUTE → (RELEASED | REFUNDED) by operator + signer resolution
DISPUTE → REFUNDED by anyone after DISPUTE_TIMEOUT (7 days)

Security Notes

Replay protection: usedDigest + usedNonces

Dispute mode freezes release/refund until resolved or timed out

Buyer can only dispute before the fiat deadline (cannot block a due refund)

Role separation: owner / backendSigner / operator, rotatable

Pause blocks new money in, never money out

EIP-712 typed signatures with per-action typehashes

Roadmap

Multi-token support / per-trade token

Partial fills / escrow fees

Backend service + DB + admin dashboard

Formal audit + invariant testing (fuzz tests already included)

License

MIT