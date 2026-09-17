# @escrowx/sdk

Client toolkit for the non-custodial EscrowX v4 protocol. It's built for wallets and apps that
integrate P2P trading **without running, or depending on, an EscrowX server**.

| Concern | Where it lives | Who can see it |
|---|---|---|
| Offers (price, currency, limits) | Signed EIP-712 offers on any Nostr relays | Public |
| Locked funds | `EscrowCoreV4` | Only the seller can release; only arbitrators can rule |
| Bank / mobile-money details | NIP-17 gift-wrapped DMs between buyer and seller | The two parties only |
| Payment evidence | Encrypted client-side; hash committed on-chain via `markPaid` | Only the assigned arbitrator, and only during a dispute |

## Modules

- **`offers`** builds and signs offers that satisfy every check `takeOffer` performs. `hashOffer` matches
  the contract exactly (the end-to-end tests assert this). `hashTerms` commits the human terms into the offer.
  High-s signatures are rejected, just as the contract rejects them.
- **`identity`** derives a Nostr messaging key from one wallet signature (no second key to back up).
  `createBinding` is a wallet-signed statement that a Nostr key speaks for that wallet.
- **`offerEvents`** turns offers into NIP-69-style order events (kind 38383). `parseOfferEvent` checks the
  Nostr signature, the seller's EIP-712 signature, the terms commitment, the wallet binding, the tags,
  the network and the expiry. Every rejection has a reason code.
- **`OfferBook`** publishes offers to many relays, fetches and verifies them, supports live subscriptions,
  and handles cancellation. Forged or hijacked offers are returned in `rejected`, never trusted.
- **`TradeChat`** sends end-to-end encrypted trade messages. `verifyHello` checks that a message really comes from
  the trade's on-chain buyer or seller before the other party shares payment details.
- **`evidence`** covers AES-256-GCM encryption, keccak commitments, and keys sealed (NIP-44) to the assigned
  arbitrator's published key. `formatEvidenceUri` anchors sealed evidence on-chain via ERC-1497.
- **`EscrowV4Client`** is a typed contract wrapper. Every write is simulated first, and approvals are for exact
  amounts, never unlimited.

## Typical flow

```ts
const identity = await deriveNostrIdentity(wallet, address);
const binding = await createBinding(wallet, address, identity.publicKey);

// Seller
const offer = createOffer({ seller, token, minAmount, maxAmount, totalAmount, paymentWindow: 1800n,
  releaseWindow: 3600n, arbitrator, fallbackArbitrator, nonce, expiry, terms });
const signature = await signOffer(wallet, offer, terms.chainId, terms.escrow);
await book.publish(buildOfferEvent({ offer, signature, terms, binding, identity }));

// Buyer
const { offers } = await book.fetch({ chainId, fiatCurrency: "NGN" });
const tradeId = await client.takeOffer(offers[0].offer, offers[0].signature, amount);
await chat.send(offers[0].event.pubkey, { type: "hello", tradeId: `${tradeId}`, binding });
```

See `test/e2e/flow.test.ts` for complete trade and dispute flows.

## Security notes

- **Always verify, never trust relays.** Use `OfferBook.fetch` or `parseOfferEvent`. Don't read raw events.
- **Share payment details only after `verifyHello`** succeeds against `getTrade(tradeId).buyer`.
- **Sellers must confirm fiat in their own banking app.** Screenshots can be forged. Evidence commitments only
  prove *which* file was submitted, not that the payment happened.
- **Key derivation relies on deterministic wallet signatures** (RFC 6979). Smart-contract wallets need a stored
  Nostr key instead.
- **Evidence pointers on-chain are permanent.** They contain only an encrypted key, a hash and a location. Keep
  ciphertext in deletable storage, since data-protection rules (e.g. Nigeria's NDPA) may require erasure.
- **Cancelling needs the chain for a hard guarantee.** A Nostr cancellation hides an offer, but only
  `cancelOffer` or `bumpNonce` on-chain guarantees it can't be taken.

## Development

```bash
npm test
```

Runs the unit tests and the tests against in-process relays.

```bash
./scripts/e2e-anvil.sh
```

Runs the full flows on Anvil. It needs Foundry.

```bash
npm run gen:abi
```

Regenerates `src/abi` after contract changes (run `forge build` first).
