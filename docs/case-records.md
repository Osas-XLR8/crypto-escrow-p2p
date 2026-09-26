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

## Trade #48 — the same path, run fresh on 26 Sep 2026 (case #7)

Trade #2 is the walkthrough; this is the proof the walkthrough still describes the deployment as it stands
today. A contested dispute, both sides filing, opened and settled in **64 seconds** measured from the
seller's first transaction to the ruling executing — block timestamps, not a stopwatch.

| At | What | Transaction |
|---|---|---|
| 0s | seller: approve | [`0x708dbe…`](https://base-sepolia.blockscout.com/tx/0x708dbec89b3af4ee2cdc17c7c55abc8054ca775b0ae20830b66eb54f5c45dc8f) |
| 4s | seller: deposit into the vault | [`0xdb322f…`](https://base-sepolia.blockscout.com/tx/0xdb322f7ddc7c3a427c84acc649c562622e2c4d06f215334243da35533b2b737d) |
| 9s | buyer: take the offer — 20 tUSDT locked | [`0x8f07cf…`](https://base-sepolia.blockscout.com/tx/0x8f07cf690bcb5f8cd516b612de3ae014393d2a4670c066e3b26d929f8e738b19) |
| 14s | buyer: mark paid, with the receipt's fingerprint | [`0x308cbe…`](https://base-sepolia.blockscout.com/tx/0x308cbe27dcfd139c2f7aa6dbbe674517112e0706be68097ddf93091f6e7ce300) |
| 20s | seller: open a dispute (0.0005 ETH) | [`0x0886c4…`](https://base-sepolia.blockscout.com/tx/0x0886c47f41bc93aba4711e7a43a9f7ab0d33e7cb6000bf6ca71245d854376b3a) |
| 25s | buyer: match the fee — case #7 created | [`0x57e156…`](https://base-sepolia.blockscout.com/tx/0x57e1562b477b7a26b7a56647ffb1511fd4324885bee9367e4d16441ccbd5a3fd) |
| 30s | firm: assign a panelist | [`0xd17f16…`](https://base-sepolia.blockscout.com/tx/0xd17f167c66df9849ec3afb34be1f4686f94c954a43feaa2a774c7afc582f0b9e) |
| 34s | **buyer: file evidence** (receipt) | [`0xfa3a2b…`](https://base-sepolia.blockscout.com/tx/0xfa3a2bb8614d625771e768c97265145560bfc87815c4648145c98c66d47f39a6) |
| 38s | **seller: file evidence** (bank statement) | [`0x54efec…`](https://base-sepolia.blockscout.com/tx/0x54efecbc8c9ea6c065b8498dcce1e7aa3142045eb0e376bcd64b8b15fff1fa9a) |
| 60s | panelist: propose a ruling for the buyer | [`0xd8d451…`](https://base-sepolia.blockscout.com/tx/0xd8d45104486d76aa565d6502d48e4b65ce6e2368c9f3f3b002e803686f5dc1d2) |
| 63s | firm: confirm and execute the ruling | [`0x6e4c10…`](https://base-sepolia.blockscout.com/tx/0x6e4c102b7c095ff1cc5d4f9002a875795bc56b468d165a2054c34e73b63883c9) |

Afterwards the chain says: trade #48 `RELEASED`, `Ruling(disputeID 7, ruling 1)` from firm A, 20 tUSDT in the
buyer's wallet and their 0.0005 ETH fee claimable back; the seller's fee paid the firm.

The parties here are two wallets that existed only for this case. That is not decoration: the demo
counterparty bots serve every wallet the demo market uses, and they release a trade the moment it is marked
paid — which is the state a dispute has to be opened from. Running this on the usual dispute wallets would
have raced the bots for the trade. Anyone reproducing it against a live demo should pass their own labels:

```
npm run demo:dispute -- --contested --seller my-seller --buyer my-buyer
```

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
