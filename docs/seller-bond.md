# Seller bonds — design for review

**Status: proposal, not built.** Step 3 of the 26 Sep work plan. This needs a decision before any contract
work, because it changes `EscrowCoreV4` and must therefore land *before* the audit freeze (Step 10) or wait
for a v5 after it.

---

## What problem this solves

Reputation, as it now stands, answers *"has this wallet behaved well so far?"*. The weighting shipped in
`54c10c1` makes that expensive to fake — a clean record needs settled trades, volume at risk, and wallet age
together, and the weakest of the three caps the confidence shown.

But reputation is backward-looking, and it has a structural hole: **a good record is an asset that can be
spent**. A merchant builds a real history over months, then takes payment on a large trade and never
releases. Everything before that was genuine; the exit is profitable precisely *because* the history was
real. Ratings, release times and completion rates all fail here, because they were all telling the truth.

A bond changes the arithmetic. If defecting costs more than it earns, the exit stops being profitable, and
the merchant's own money says so in a way no history can.

## The constraint that decides everything

A bond deters only if:

```
bond  >  what the merchant nets by defecting  =  the largest single trade they can take
```

That is the whole design, and it is uncomfortable, because it means **the bond scales with trade size**. A
merchant whose cap is ₦2,000,000 needs more than ₦2,000,000 locked to be credibly bonded. For an honest
merchant that is working capital sitting idle — exactly the cost that pushes people back to Binance P2P,
where the platform absorbs this risk with its own balance sheet.

There is no clever mechanism that escapes this. Anything cheaper is a bond that a sufficiently large scam
can profitably eat. So the real question is not *how* to build a bond but **what it is honestly for**:

- **A full bond** (≥ max trade) genuinely deters, and only well-capitalised merchants can offer it.
- **A partial bond** (say 20% of max trade) does not deter a determined exit, but it does deter *casual*
  bad behaviour, filters out zero-cost throwaway wallets, and gives arbitration something to compensate a
  wronged buyer with. It is a signal and a remedy, not a guarantee.

**Both are defensible. They are different products, and the UI must not describe one as the other.** A
"bonded" badge that a reader takes to mean "cannot afford to cheat me" when it means "has posted 20%" is
worse than no badge, because it converts an honest signal into a false assurance.

## Options considered

### A. Per-offer bond, escrowed with the offer

The maker locks a bond alongside the offer; it covers every trade taken from that offer.

- Simple to reason about; the badge maps to one offer.
- But one bond backing many simultaneous trades is exactly the arithmetic above, failing: three buyers each
  taking the cap can jointly lose more than the bond covers.
- Fixable only by capping concurrent trades against the bond, which is real complexity in the contract.

### B. Per-trade bond, locked when the trade opens

The seller's bond is locked per trade, released with it.

- The arithmetic always holds: one bond, one trade, bounded exposure.
- Capital cost is proportional to actual business rather than advertised business.
- Costs an extra token approval and transfer per trade, and gas.
- A merchant running ten concurrent trades locks ten bonds — which is correct, and expensive.

### C. Global merchant stake, tracked separately

One stake per merchant, slashed by arbitration, with offers showing the ratio of stake to exposure.

- Best capital efficiency and the nicest badge.
- Needs accounting for committed-versus-free stake across concurrent trades, which is the most contract
  surface and the most to get wrong under audit.

**Recommendation: B.** It is the only one whose safety property is true without additional bookkeeping, and
bookkeeping is where audits find bugs. C is the better product once there is evidence people want it.

## Who may slash, and the hole that opens

This is the part I would most want a second opinion on before writing any code.

A slashable bond hands the arbitration firm a new power: **the ability to take a party's money beyond the
trade amount**. Today a firm can only direct the escrowed crypto to one of two parties. It cannot invent a
transfer, and its worst behaviour is deciding a case wrongly. With slashing, a corrupt or compromised firm
can rule against a seller *in order to take the bond*, and the seller's loss is no longer bounded by the
trade they chose to enter.

Mitigations, none free:

- **Slash to the wronged buyer, never to the firm or treasury.** Removes the firm's direct incentive. Does
  not remove collusion between a firm and a fake buyer.
- **Cap the slash at the trade amount.** Keeps a seller's downside equal to what they already risked. This
  weakens the bond to "double or nothing", but keeps the failure mode bounded — I lean towards this.
- **Require the two-person rule** (panelist proposes, firm confirms) for any slash, as rulings already do.
- **Bond loss only on `ARBITRATION_RULED_BUYER`**, never on a timeout or fee default, so a seller who
  simply goes offline loses the trade but not the bond.

## Contract surface (if we proceed with B)

Roughly, and deliberately minimal:

- `Offer` gains `bondAmount` (uint256), covered by the existing EIP-712 hash, so a bond is part of what the
  maker signs rather than a mutable side setting.
- `takeOffer` pulls `bondAmount` from the seller's vault free balance into the trade, alongside the crypto.
- Release and cancel return the bond to the seller's free balance, same as the tokens.
- The ruling path gains one branch: on a buyer-favourable ruling, transfer `min(bond, amount)` to the buyer
  and the remainder back to the seller.
- No new roles, no registry, no new authority — the firm's existing ruling is the only trigger.

Everything else — the badge, the ratio, the filters — is UI over data already on-chain.

## What it looks like in the app

- A **"bonded"** chip on offers with a bond, showing the amount, not just the state.
- Next to it, the honest ratio: *"₦500,000 bond · covers 25% of the largest trade"*. The number is the
  claim; the badge alone is not.
- In the trade view, the bond shown as part of what is at stake for each side.
- In the offer form, the bond field defaulting to **zero**, with the cost stated plainly: this is your money,
  locked for the life of each trade, and you lose it if a dispute goes against you.

## Open questions — these need your decision

1. **Full bond or partial?** Deterrence versus merchant capital cost. This decides what the badge may claim.
2. **Cap the slash at the trade amount?** I lean yes: it bounds a seller's downside to what they already
   chose to risk, and it removes the largest new incentive for arbitrator misbehaviour.
3. **Before or after the audit freeze?** Doing it before means auditing a mechanism with no live usage to
   learn from. Doing it after means a second audit for v5. Given that Step 11 replaces the demo firms with
   real ones, and this hands those firms a new power over user funds, my instinct is **after** — ship real
   arbitration, learn how disputes actually go, then design the bond against evidence rather than a guess.
4. **Do we need it at all for launch?** The liquidity plan (Step 12) recruits 10–20 known merchants. Bonds
   solve a trust problem you do not yet have with counterparties you have personally onboarded, and the
   capital cost may be exactly the thing that stops them joining.

## What I would do

Ship Steps 4–9 and the audit with **no bond**, using the weighted reputation already live. Revisit this once
there are real arbitration firms and real dispute history, where the bond can be sized against observed
losses rather than a hypothesis.

If a bonded tier is wanted sooner as a marketing signal rather than a safety mechanism, say so explicitly —
it is a legitimate goal, and it changes the design towards option C and a much smaller bond.
