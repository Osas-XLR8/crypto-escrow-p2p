# Arbitration case records

Every dispute path this escrow offers, run end to end on a public network, with the transactions that prove
it. These are real cases on Base Sepolia — test money, real contracts, real time.

Anyone can check them without a wallet: the [arbitration desk](https://osas-xlr8.github.io/crypto-escrow-p2p/arbitrate/)
shows the case, the panel, the evidence entries and the ruling; the links below go to the transactions.

Deployment (chain 84532):

| | |
|---|---|
| Escrow | [`0xC63B71eDC6e4F8C5F4e2bf981F0BAe0775d7399C`](https://base-sepolia.blockscout.com/address/0xC63B71eDC6e4F8C5F4e2bf981F0BAe0775d7399C) |
| Arbitration firm A (primary) | [`0x150dD59E62aD6C287Ed00f7394FF7f85E6fe622F`](https://base-sepolia.blockscout.com/address/0x150dD59E62aD6C287Ed00f7394FF7f85E6fe622F) |
| Arbitration firm B (fallback) | [`0x286d151279Bc4aaa73bF6c39Ef7B4c9F3ba20716`](https://base-sepolia.blockscout.com/address/0x286d151279Bc4aaa73bF6c39Ef7B4c9F3ba20716) |
| Test token | [`0x35Cf099D71B00715F8A36251F39102F923A93804`](https://base-sepolia.blockscout.com/address/0x35Cf099D71B00715F8A36251F39102F923A93804) |

The two firms have **separate panels** and **treasuries separate from their admin keys**, so escalation moves a
case to different people, not just a different contract.

---

## Trade #1 — a ruling, start to finish (case #1)

The plain path: a buyer says they paid, the seller says they didn't see it, a panelist reads the evidence and
rules. Opened and settled in **44 seconds**.

Readable on the desk as *Case #1 · Ruled: buyer · RELEASED*. The trade ended with 20 tUSDT released to the
buyer and the buyer's arbitration fee refunded; the seller's fee paid the firm.

---

## Trade #2 — a **contested** case: both sides filed evidence (case #2)

The case worth showing. Both parties submitted sealed evidence and the panelist had two accounts of the same
trade to weigh — the buyer's receipt against the seller's bank statement. **60 seconds**, eleven transactions.

| At | What | Transaction |
|---|---|---|
| 15s | seller: approve | [`0x8ab1da…`](https://base-sepolia.blockscout.com/tx/0x8ab1dade39a60ddd8aa8fdc485cad94d618f4ccc70e8034888fef6076a611f26) |
| 18s | seller: deposit into the vault | [`0x6acba0…`](https://base-sepolia.blockscout.com/tx/0x6acba030c10e119c31956cc7ee981a634a676c31ebc4a171640f2c29f212c9ae) |
| 23s | buyer: take the offer — 20 tUSDT locked | [`0xc7cfd9…`](https://base-sepolia.blockscout.com/tx/0xc7cfd987d75a71fffc42831b96dd725aec8719b9d45150b4927352e8f88af66c) |
| 27s | buyer: mark paid, with the receipt's fingerprint | [`0xcda3de…`](https://base-sepolia.blockscout.com/tx/0xcda3de0ea69b98875ea509d406fa94090bad30272d0b521aff6938ecc635e326) |
| 31s | seller: open a dispute (0.0005 ETH) | [`0x9b8315…`](https://base-sepolia.blockscout.com/tx/0x9b83150a99b86a6e9b694ea6d5a9ddd296dc44b812c75bdf33afde8918932137) |
| 34s | buyer: match the fee — case created | [`0xe9424a…`](https://base-sepolia.blockscout.com/tx/0xe9424a78ceebd9aab051611cca929481e735baacafc8e1639c353c2d38998930) |
| 39s | firm: assign a panelist | [`0xe82806…`](https://base-sepolia.blockscout.com/tx/0xe82806cf31a59e41a48e2ab2cb3c4ee13ca083cbbac9241c6f5950aab299e563) |
| 42s | **buyer: file evidence** (receipt) | [`0xb1988f…`](https://base-sepolia.blockscout.com/tx/0xb1988fd5c8c2294952bd4ef9eb58c48be3ead97bfe9349d86e9bc9a6be2f8026) |
| 46s | **seller: file evidence** (bank statement) | [`0x092d02…`](https://base-sepolia.blockscout.com/tx/0x092d0267960db0f58043064e8e07e0fee4f59e57dac08954cb76ffd72a67fb54) |
| 52s | panelist: propose a ruling for the buyer | [`0x4d2f31…`](https://base-sepolia.blockscout.com/tx/0x4d2f31d2393d8dddb24036063b34202cf1eb03a3074dcfd09e33b23ad3c25e42) |
| 56s | firm: confirm and execute the ruling | [`0x2168dc…`](https://base-sepolia.blockscout.com/tx/0x2168dc765af3d8af1565e34e6dff63e481c301ed4218b3490d8f16c4de9f6ccd) |

What the panelist actually did: opened both sealed filings with their own key, checked each ciphertext against
the fingerprint the party had put on-chain *before* the dispute existed, and ruled. Neither filing is readable
by the other party, by the firm, or by anyone reading the chain — only by the assigned panelist.

The firm executed the ruling without waiting out its review window. It is allowed to do that on a case it did
not decide itself: that window exists so the firm can veto its panelist, and the firm confirming in person is
that review. A panelist holding the admin key gets no such shortcut.

Reproduce it: `npm run demo:dispute -- --contested` (from `packages/sdk`).

---

## Trade #3 — fee forfeit: the other side never paid, and lost

A dispute where the counterparty simply doesn't match the arbitration fee. The escrow's fee window is 24 hours
— the contract's own minimum, unshortenable — and once it closes, **anyone** can settle the trade in the
opener's favour.

Opened 25 Sep 2026, 06:54 UTC. The window closed 26 Sep 2026 at 06:54 UTC and the trade was settled 98 seconds
later. Readable on the desk as *Trade #3 · CANCELLED*.

| At | What | Transaction |
|---|---|---|
| +24h 2m | settle by default — nobody's permission needed | [`0x261d5d…`](https://base-sepolia.blockscout.com/tx/0x261d5db6929fb06fb42b8ca3711ba8d934ca9429ba4f7771001997f240d39a3a) |

What the chain says afterwards: trade #3 is `CANCELLED` with reason `FEE_DEFAULT`, the seller's 20 tUSDT is
back in their vault balance, and their 0.0005 ETH fee is credited back to them as claimable. The buyer, who
opened nothing and paid nothing, gets nothing back — that is the whole point of the window.

Two details worth reading off this one transaction:

- **A third party sent it.** Not the buyer, not the seller — the deployer key, which is party to neither side
  of this trade. The refund still went to the opener. A stalemate cannot be used to strand someone's money,
  because it doesn't take either party's cooperation to end it.
- **Refunds are credited, not pushed.** The fee lands in `claimableNative` and the tokens in the vault's free
  balance, both withdrawn in a separate transaction of the party's choosing. So settling can never fail
  because a recipient refuses to receive.

The same path, proven end to end on a local chain where the clock can be moved:
`node scripts/demo-dispute.mjs --chain 31337 --stop-at fee-pending` then
`node scripts/finish-timeout.mjs --chain 31337 --trade <id> --warp`.

---

## Trade #4 — escalation: the firm went quiet (case #3) · *window closes 2 Oct 2026*

A dispute the first firm never rules on. After the escrow's arbitration timeout (7 days — again the contract
minimum), either party can move the case to the fallback firm, which has its own panel.

Opened 25 Sep 2026. Trade #4 is sitting in `DISPUTED` with firm A, unassigned. Finish it with:

```
node scripts/finish-timeout.mjs --trade 4
```

Proven end to end locally in the same way (`--stop-at disputed`, then `finish-timeout --warp`): the buyer
escalates, firm B assigns **its own** panelist, that panelist rules, the ruling executes, and the trade
settles — four transactions, no involvement from the firm that went quiet.

---

## Trade #47 — the fallback firm decides a case of its own (its case #1)

Firm B had never heard anything, which made "there is a fallback" a claim about a contract rather than about
people. It doesn't take an escalation to fix that: a firm can be named as an offer's primary arbitrator like
any other, so this dispute went straight to Firm B and **its own panelist** — `0x1A2035f9B6c96864fC54c5b947418296C42C2550`,
who serves on Firm B and not on Firm A. Contested, both sides filed, **78 seconds**.

| At | What | Transaction |
|---|---|---|
| 26s | buyer: take the offer — 20 tUSDT locked | [`0x7fc7c2…`](https://base-sepolia.blockscout.com/tx/0x7fc7c289120b3d1e34f40b9fd28a4723d10d970dcb43311c37c2e8d54a754e03) |
| 31s | buyer: mark paid | [`0x2450cf…`](https://base-sepolia.blockscout.com/tx/0x2450cf40e5bf98a6243017a61734f192a45c7e80505cfa0073ddce1ffecd205d) |
| 36s | seller: open a dispute with **firm B** | [`0x0fcbe5…`](https://base-sepolia.blockscout.com/tx/0x0fcbe5edc057ff839bc676977968b1d09ce742e406c6f85f7a13d33ffefd824f) |
| 41s | buyer: match the fee — firm B's case #1 | [`0x583b32…`](https://base-sepolia.blockscout.com/tx/0x583b328beda284cbef935c9daf52af9e2a2450c585a137322e6e91994d63d1cf) |
| 45s | firm B: assign **its own** panelist | [`0x890276…`](https://base-sepolia.blockscout.com/tx/0x8902766f58554195da63f511b5ec86bc0feb6d7a2248312932c875be65987d5f) |
| 48s | buyer: file evidence | [`0xf3ba16…`](https://base-sepolia.blockscout.com/tx/0xf3ba1651b2da0a8aac307c7d8edb8f8859eb1ff1ea76fefa6cd12fe1b126d17e) |
| 53s | seller: file evidence | [`0x0ca945…`](https://base-sepolia.blockscout.com/tx/0x0ca945db0c201ede3b014d20db0b9d685a6ac0d7c5a308b763c6121dfe028f18) |
| 70s | firm B's panelist: propose a ruling | [`0x1b5f53…`](https://base-sepolia.blockscout.com/tx/0x1b5f536117d0c8cf295caaa2cfd8e79a668cb506841cd3eda5ed87bc3cfd9912) |
| 74s | firm B: confirm and execute | [`0xe13384…`](https://base-sepolia.blockscout.com/tx/0xe1338441dd15cb513fe59c72aecd09f5dcc480e00cf575c9113099064cb29675) |

This is not the escalation path — that still waits out the escrow's seven-day timeout on trade #4. It is the
half of the fallback guarantee that can be proven without a clock: firm B has a panel, that panel can be
assigned, and it can rule.

Reproduce it: `npm run demo:dispute -- --contested --firm fallback`.

---

## Also on this deployment

| Trade | Case | What it shows |
|---|---|---|
| #44 | #6 | A contested dispute against a market maker — the same path as case 2, but the loser is a maker with offers on the book, so the loss shows on its reputation badge. |
| #41 | #4 | **A panelist declining to rule.** The case was opened by a run that crashed before either party filed anything; with no evidence to weigh, the panelist ruled "refuse", and the escrow returned the crypto to the seller. The ruling a firm should make when it has nothing to go on is also a ruling. |

---

## What these records are not

They are transactions on a test network, read through a UI that reads the chain. They show the mechanism
working. They are **not** an audit, and nobody should present them as one: this is pre-audit software, and the
footer of the app says so for a reason.
