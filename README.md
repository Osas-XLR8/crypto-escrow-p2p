# Crypto Escrow P2P (Demo MVP)

A minimal, investor-safe P2P escrow demo:
- Seller deposits USDT (or a mock token in local demo)
- Buyer pays fiat off-chain
- Backend authorizes release using a signature
- Refunds after deadline (unless dispute)
- Disputes freeze funds until backend resolves

> ⚠️ Demo MVP. Not audited. Do not use in production with real funds.

## What’s Included
- **Solidity escrow contract** (state machine + replay protection)
- **Foundry tests** (basic + negative suite)
- **Local dev scripts** (deploy + smoke tests)
- **Next.js frontend** (RainbowKit/Wagmi) for demo interactions

## Quick Demo (Local)
### 1) Start local chain
```bash
anvil

Deploy + smoke test

cd packages/contracts
./deploy-all.sh --smoke
source ./.deployments/.env
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
./smoke-negative.sh

Frontend

cd packages/contracts/my-rainbowkit-app
npm install
npm run dev -- -p 3001

Open:

http://localhost:3001

Architecture (High level)

Backend creates trade + signs authorizations.
Smart contract holds funds + enforces state machine.
Frontend reads state and triggers deposit/refund/dispute.

State Machine

NONE → CREATED → LOCKED → (RELEASED | REFUNDED | DISPUTE)
DISPUTE → (RELEASED | REFUNDED) by backend resolution

Security Notes

Replay protection: usedDigest + usedNonces

Dispute mode freezes release/refund until resolved

Backend signer is explicit and auditable

Roadmap

EIP-712 typed signatures

Multi-token support / per-trade token

Partial fills / escrow fees

Backend service + DB + admin dashboard

Formal audit + fuzz testing

License

MIT