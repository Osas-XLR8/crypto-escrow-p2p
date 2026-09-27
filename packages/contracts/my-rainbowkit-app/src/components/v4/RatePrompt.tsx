// src/components/v4/RatePrompt.tsx — "how did that go?", asked once, at the only moment anyone knows.
//
// Asked on the trade that just finished, because a rating written weeks later from a list is a rating about
// a vague memory. Skippable without friction: a prompt that nags is a prompt people learn to dismiss, and a
// rating given to make a box go away is worse than no rating.

import { useState } from "react";
import type { Address } from "viem";
import { RATING_TAGS, type RatingTag } from "@escrowx/sdk";
import { Button, Notice, errorText } from "@/components/ui";
import { useSubmitRating } from "@/hooks/useRatings";
import { recallRatingGiven, rememberRatingGiven } from "@/lib/v4/local";

/** Tags worth offering depend on which side you were: you judge a seller's release, a buyer's payment. */
function tagsFor(counterpartyWasSeller: boolean): RatingTag[] {
  return counterpartyWasSeller
    ? (["fast release", "slow release", "clear communication", "no response"] as RatingTag[])
    : (["paid promptly", "slow to pay", "clear communication", "no response"] as RatingTag[]);
}

export function RatePrompt({
  tradeId,
  counterparty,
  counterpartyWasSeller,
}: {
  tradeId: bigint;
  counterparty: Address;
  counterpartyWasSeller: boolean;
}) {
  const { submit, canRate } = useSubmitRating();
  const [given, setGiven] = useState(() => recallRatingGiven(tradeId));
  const [score, setScore] = useState<1 | -1 | null>(null);
  const [tag, setTag] = useState<RatingTag | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  if (given) return <p className="small faint" style={{ margin: 0 }}>You rated this trade {given === 1 ? "👍" : "👎"}. Thanks — it shows on their card.</p>;
  if (dismissed) return null;

  async function send(chosen: 1 | -1) {
    setBusy(true);
    setError(null);
    try {
      await submit({ tradeId, subject: counterparty, score: chosen, tag });
      rememberRatingGiven(tradeId, chosen);
      setGiven(chosen);
    } catch (e) {
      setError(errorText(e));
      setScore(null);
    } finally {
      setBusy(false);
    }
  }

  if (!canRate) {
    return (
      <p className="small faint" style={{ margin: 0 }}>
        Unlock encrypted messaging to rate this trader — a rating is signed by your wallet, which is what
        stops anyone rating a trade they weren&apos;t in.
      </p>
    );
  }

  return (
    <div className="stack-xs">
      <div className="row-between" style={{ gap: 12, flexWrap: "wrap" }}>
        <span className="small">How did this trader do?</span>
        <span className="row" style={{ gap: 6 }}>
          <Button size="sm" variant={score === 1 ? "accent" : "ghost"} disabled={busy} onClick={() => { setScore(1); void send(1); }}>
            👍 Good
          </Button>
          <Button size="sm" variant={score === -1 ? "danger" : "ghost"} disabled={busy} onClick={() => { setScore(-1); void send(-1); }}>
            👎 Bad
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDismissed(true)}>Skip</Button>
        </span>
      </div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {tagsFor(counterpartyWasSeller).map((t) => (
          <button
            key={t}
            type="button"
            className={`chip ${tag === t ? "chip-accent" : ""}`}
            aria-pressed={tag === t}
            disabled={busy}
            onClick={() => setTag(tag === t ? undefined : t)}
          >
            {t}
          </button>
        ))}
      </div>
      <p className="tiny faint" style={{ margin: 0 }}>
        Signed by your wallet and published to the relays. Anyone can check that you were really in this
        trade; nobody can check whether you are being fair, so it counts for what it is.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

export { RATING_TAGS };
