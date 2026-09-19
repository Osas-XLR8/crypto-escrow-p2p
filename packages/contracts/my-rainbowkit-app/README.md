# EscrowX web app (v4)

Reference client for the non-custodial v4 protocol, built on [`@escrowx/sdk`](../../sdk/README.md).

**No EscrowX server is involved.** Offers come from Nostr relays and are verified in the browser;
payment details are end-to-end encrypted between buyer and seller; funds move only through
`EscrowCoreV4`, controlled by the parties and independent arbitrators. The app builds to a **static site**,
so any free static host can serve it.

## Screens

| Tab | What it does |
|---|---|
| **Market** | A **Buy / Sell** switch, like any P2P market. *Buy* lists sell offers: taking one locks the seller's crypto and you pay them. *Sell* lists buy offers: filling one locks **your** crypto (vault first, then wallet) and the buyer pays you. Offers come from relays, verified in the browser; visitors can browse without a wallet. |
| **My offers** | Post an offer to **sell** (backed by your vault) or to **buy** (a signature only; sellers bring the crypto), manage your vault and test-token faucet, and cancel your offers. |
| **Trades** | Your trades rebuilt from contract events: a progress bar, the one next step for your role, deadlines, the private chat, disputes and evidence. |

**Chat** is an end-to-end encrypted conversation per trade (NIP-17). Both sides connect automatically when the trade
opens — each proves its messaging key belongs to the wallet recorded on-chain — and only that key is trusted.
Your own messages are sealed to you as well, so the thread survives reloads and other devices. On-chain milestones
(locked, paid, released, disputes) appear in the thread straight from the contract. The seller shares where to pay;
the buyer can attach a transfer reference when tapping "I've paid".

**Notifications**: toasts when the other side acts on-chain (someone took your offer, the buyer marked paid, crypto
released, a dispute opened) or messages you, unread badges per trade, the tab title counts events while you're away,
and optional browser notifications.

A first-run checklist (gas → test tokens → messaging) appears on test networks until setup is done.
Light and dark themes follow the system, with a toggle in the header.

**Arbitration desk** (`/arbitrate`, linked in the footer) is for arbitration firms: the firm admin manages the
panel and assigns cases; the assigned panelist opens the sealed evidence (checked against the fingerprint the buyer
committed on-chain), proposes a ruling with a hashed written decision, and after the review period anyone can
execute it. The admin can veto during review.

## Run it

### Against a public testnet (Base Sepolia)

From `packages/contracts` (Foundry required; on Windows run these in WSL):

```bash
./testnet-wallet.sh
```

Creates a throwaway deployer in `.env.testnet` (git-ignored) and prints its address. Send it a little Base
Sepolia ETH from a faucet (the whole deploy costs about 0.0002 ETH), then:

```bash
./deploy-testnet.sh
```

This deploys the contracts, verifies the source on Blockscout, and writes `deployments/v4-84532.json`. It uses
the shortest timings the contracts allow (fee match 1 day, arbitrator deadline 7 days, firm review 1 hour), so a
full dispute can be demoed with a one-hour wait.

To give visitors a live market, seed demo offers from `packages/sdk` — three demo sellers with six sell offers and two
demo buyers with four buy offers, across NGN, KES, GHS and ZAR, valid 7 days (re-run to refresh):

```bash
npm run build && npm run seed:demo
```

Then, from this folder:

```bash
npm run sync:v4 -- 84532
```

```bash
npm run dev
```

Public relays (`relay.damus.io`, `nos.lol`, `relay.primal.net`) and Base Sepolia's public RPC are used by default.

### Against a local chain

```bash
anvil
```

```bash
MINT_TO=<your wallet> forge script script/DeployV4.s.sol:DeployV4 --rpc-url http://127.0.0.1:8545 --broadcast
```

```bash
npm run relay
```

(the last one from `packages/sdk`), then here:

```bash
npm run sync:v4
```

```bash
npm run dev
```

`sync:v4` copies the deployed addresses into `.env.local` and leaves other keys alone. Restart the dev server
after changing any `NEXT_PUBLIC_*` value. The SDK is a local `file:` dependency, so run `npm run build` in
`packages/sdk` after changing it.

## Publish it (free)

`npm run build` writes a static site to `out/`. Two ready paths:

- **GitHub Pages (set up in this repo):** commit `packages/contracts/deployments/v4-84532.json` and push to
  `main`. The *Deploy web app* workflow builds and publishes to `https://<user>.github.io/<repo>/`. One-time
  setup: repository **Settings → Pages → Source: GitHub Actions**.
- **Vercel / Netlify / Cloudflare Pages:** import the repo, set the root directory to this folder, build command
  `npm run sync:v4 -- 84532 && npm run build`, output directory `out`. The SDK must be built first (see the
  workflow for the exact steps).

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | `31337` | Anvil, Base Sepolia (84532), Sepolia, Arbitrum/Optimism Sepolia, Polygon Amoy |
| `NEXT_PUBLIC_V4_*` | Anvil addresses | Written by `sync:v4` from a deployment file |
| `NEXT_PUBLIC_RPC_URL` | the chain's public RPC | Use a keyed endpoint if the public one rate-limits |
| `NEXT_PUBLIC_NOSTR_RELAYS` | public relays (local relay on Anvil) | Comma-separated |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | unset | Enables mobile wallets (Trust Wallet, MetaMask Mobile) via WalletConnect; free at cloud.reown.com. Without it, browser-extension wallets work. |
| `NEXT_PUBLIC_BASE_PATH` | empty | Sub-path when hosted under one, e.g. `/crypto-escrow-p2p` on GitHub Pages |
| `NEXT_PUBLIC_LOG_CHUNK` | `9000` | Block range per `eth_getLogs` request |
| `NEXT_PUBLIC_V4_ARBITRATOR_NAMES` | unset | `0xabc…=Firm name,0xdef…=Other firm` |

## What the UI guarantees

- **Messaging keys** are derived from a wallet signature and kept in memory for the session only. Switching
  accounts clears them. Only the public wallet↔key binding is cached in the browser.
- **Payment details are only shown to a verified counterparty**: the sender's key must carry a wallet
  signature matching the buyer/seller recorded on-chain for that trade. Anything else is flagged
  "unverified sender — do not pay".
- **Releasing requires an explicit confirmation** that the seller checked their own banking app, since
  screenshots can be faked.
- **Receipts are encrypted in the browser**; only a fingerprint goes on-chain. In a dispute, the key is
  sealed so that only the assigned arbitrator can open it.
- **Every action maps to a contract function** and is shown only when the contract would accept it from
  that wallet, in that state, at that time.

## Notes and limits

- **Testnet arbitration is a demo.** `deploy-testnet.sh` makes the deployer the admin of both arbitration
  adapters, so the app labels them "Demo arbitration firm A/B". In production each firm deploys and controls
  its own adapter.
- **tUSDT is a worthless test token** with a public faucet (1,000 per address per hour). It is deliberately
  not named after Tether.
- **Price and currency live in the signed offer, not on-chain.** Trades show the fiat amount by matching the
  on-chain offer hash to the offer on the relays (or from memory on the device that opened the trade). If the offer is gone
  from every relay, the fiat amount isn't shown; the crypto amount always is.
- **Local chains only produce blocks when a transaction arrives**, so a deadline action can be rejected
  against a stale timestamp. Mine a block and retry. Real networks don't have this.
- **Evidence files travel outside the app.** Submitting seals the key on-chain for the arbitrator and downloads the
  encrypted file, which the party sends to the firm; the panelist uploads it on the desk, where it's checked against
  the on-chain fingerprint before decrypting. Shared storage is still to be decided.
