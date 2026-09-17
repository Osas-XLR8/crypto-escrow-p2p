# EscrowX web app (v4)

Reference client for the non-custodial v4 protocol, built on [`@escrowx/sdk`](../../sdk/README.md).

**No EscrowX server is involved.** Offers come from Nostr relays and are verified in the browser;
payment details are end-to-end encrypted between buyer and seller; funds move only through
`EscrowCoreV4`, controlled by the parties and independent arbitrators.

## Tabs

| Tab | What it does |
|---|---|
| **Market** | Verified offers from the relays, with live on-chain availability, and buying (which locks the seller's funds). |
| **Sell** | Vault deposit / withdraw, publishing signed offers, cancelling them (on-chain plus a relay update). |
| **Trades** | Trades rebuilt from contract events: role-aware actions, deadline countdowns, encrypted chat, disputes and evidence. |

## Run it locally

1. **Chain + contracts** (from `packages/contracts`, in WSL/Linux):

   ```bash
   anvil
   ```

   ```bash
   MINT_TO=<your wallet> forge script script/DeployV4.s.sol:DeployV4 --rpc-url http://127.0.0.1:8545 --broadcast
   ```

2. **A Nostr relay** — any relay works. For local dev (from `packages/sdk`):

   ```bash
   npm run relay
   ```

3. **The app**:

   ```bash
   npm run sync:v4
   ```

   ```bash
   npm run dev
   ```

`sync:v4` copies the deployed addresses into `.env.local` (other keys are left alone). Relays come from
`NEXT_PUBLIC_NOSTR_RELAYS` (comma-separated). Restart the dev server after changing `NEXT_PUBLIC_*`.

The SDK is a local `file:` dependency, so run `npm run build` in `packages/sdk` after changing it.

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

- **Local chains only produce blocks when a transaction arrives**, so contract simulations can run against a
  stale timestamp and reject a deadline action the UI already offers. Mine a block (or send any transaction)
  and retry. Real networks produce blocks continuously, so this doesn't arise.
- **Encrypted evidence files stay on the device that created them.** Submitting seals the key on-chain for the
  arbitrator and downloads the encrypted file to hand over. Shared storage is still to be decided.
- **Arbitrator tooling isn't in this app.** Firms assign panelists and rule through their own adapter contract.
- `.env.local` may still contain v3 keys (e.g. `BACKEND_SIGNER_PRIVATE_KEY`). Nothing reads them any more.
