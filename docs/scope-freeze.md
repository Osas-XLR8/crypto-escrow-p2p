# Scope freeze

**Frozen 25 September 2026** at commit `267d8d6`, deployed to Base Sepolia and
[the live app](https://osas-xlr8.github.io/crypto-escrow-p2p/).

Everything shipped before this line is what goes to audit. The reason for drawing it here is simple: every
feature added before the review increases the surface that has to be paid for and read, and the honest
constraint on this project is now the audit, not the feature list.

## What is frozen

The product surface: the escrow and arbitration contracts, the SDK, and the web app's behaviour. No new
features, no new flows, no new contract functions.

## What is still allowed

- **Defects.** Anything that is broken, misleading, or unsafe gets fixed. A fix is not a feature.
- **The two cases still on the clock** ([case records](case-records.md)): finishing trade #3's fee forfeit and
  trade #4's escalation when their windows close. These are runs of code that already exists.
- **Demo operations.** Re-seeding the demo market, topping up demo wallets, recording more cases with the
  existing scripts.
- **Anything the audit asks for**, including the changes it recommends.
- **Documentation**, including whatever a reviewer needs to check a claim.

## What is deliberately not in this build

Written down so nobody has to guess whether it was forgotten or decided:

- No protocol fee. The escrow takes no cut; the only charge anywhere is an arbitration firm's fee, paid by the
  parties to a dispute and refunded to the winner.
- No on-chain reputation counters. Reputation is derived from the escrow's events, which is why it cannot be
  bought or edited — and why a fresh deployment starts everyone at zero.
- No integrator hooks, no timelocked upgrades, no admin pause on the escrow. There is nothing to pause: the
  contract cannot move a trade's funds anywhere except to its buyer or back to its seller.
- The app is a static site with no backend of any kind. Offers and chat travel over public Nostr relays; every
  signature is checked in the browser.

## Contract state at the freeze

| | |
|---|---|
| Escrow | `0xC63B71eDC6e4F8C5F4e2bf981F0BAe0775d7399C` |
| Arbitration firm A | `0x150dD59E62aD6C287Ed00f7394FF7f85E6fe622F` · panel `0xe306…1d78` · treasury `0xbC1c…4Ad5` |
| Arbitration firm B (fallback) | `0x286d151279Bc4aaa73bF6c39Ef7B4c9F3ba20716` · panel `0x1A20…2550` · treasury `0xeFcA…ae49` |
| Test token | `0x35Cf099D71B00715F8A36251F39102F923A93804` |
| Chain | Base Sepolia (84532) · all four contracts verified on Blockscout |

Windows are the contracts' own minimums: payment 10 min, release 30 min, fee match 24 h, arbitration 7 days,
firm review 1 h.

## Still true, and worth repeating

This is pre-audit software. Everything recorded in [case records](case-records.md) is a transaction on a test
network read through a UI that reads the chain. It shows the mechanism working. It is not an audit, and nobody
should present it as one.
