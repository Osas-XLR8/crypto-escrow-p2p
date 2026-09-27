// src/components/v4/MerchantProfile.tsx — everything this escrow knows about one trader, in one place.
//
// Until now a counterparty's record was scattered across the chip line on an offer card and whatever you
// could reconstruct from a block explorer. This is the page you open before trusting someone with a large
// trade: the same facts, gathered, with the explorer link still there for anyone who would rather check
// than be told.
//
// Nothing here is a profile in the social sense. There is no display name, no avatar and no bio, because
// every one of those is a field a scammer fills in. What a wallet did is the only thing it cannot rewrite.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { formatUnits } from "viem";
import { CHAIN, V4, arbitratorName, explorerAddress } from "@/config/v4";
import { useEscrowX } from "@/context/EscrowX";
import { Addr, Button, Card, Chip, Empty, Notice } from "@/components/ui";
import { fmtDuration } from "@/lib/format";
import { DisputeWarning, useReputation, useWalletActivity } from "@/components/v4/Reputation";
import { useRatingsFor } from "@/hooks/useRatings";
import { confidence, completionRate, disputeRate, releaseTime, settled } from "@/lib/v4/reputation";
import { isBlocked, setBlocked } from "@/lib/v4/local";
import { closeTrader } from "@/lib/v4/nav";

const SYM = V4.tokenSymbol;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const day = (ts: number) => new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="stack-xs" title={hint}>
      <span className="tiny faint">{label}</span>
      <span className="strong">{value}</span>
    </div>
  );
}

export function MerchantProfile({ address }: { address: Address }) {
  const { address: me, book } = useEscrowX();
  const reputationOf = useReputation();
  const stats = reputationOf(address);
  const ratings = useRatingsFor(address);
  const activity = useWalletActivity(address);
  const [blocked, setBlockedState] = useState(() => isBlocked(address));
  const isMe = !!me && me.toLowerCase() === address.toLowerCase();

  // What they are offering right now — the reason most people open a profile at all.
  const offers = useQuery({
    queryKey: ["trader-offers", address],
    enabled: !!book,
    staleTime: 30_000,
    queryFn: async () => (await book!.fetch({ chainId: CHAIN.id, maker: address })).offers,
  });

  const done = stats ? settled(stats) : 0;
  const rate = stats && completionRate(stats);
  const release = stats && releaseTime(stats);
  const trust = stats ? confidence(stats, Math.floor(Date.now() / 1000)) : "none";
  const said = ratings.data?.summary;
  const explorer = explorerAddress(address);

  return (
    <div className="stack">
      <Card
        title={<>Trader <Addr address={address} you={isMe} full /></>}
        right={<Button size="sm" variant="ghost" onClick={closeTrader}>← Back</Button>}
        sub={
          stats?.firstSeen
            ? `First traded here on ${day(stats.firstSeen)}. Everything below comes from this escrow's own events.`
            : "Everything below comes from this escrow's own events."
        }
      >
        <div className="stack">
          {!stats || stats.total === 0 ? (
            <Empty title="No trades on this escrow yet">
              That isn&apos;t proof of anything — everyone starts here — but there is no history to check, so
              treat a first trade as a first trade.
            </Empty>
          ) : (
            <>
              <div className="profile-stats">
                <Stat label="Trades" value={stats.total} hint={`${stats.asSeller} as seller, ${stats.asBuyer} as buyer`} />
                <Stat
                  label="Completed"
                  value={rate === undefined ? "—" : pct(rate)}
                  hint={`${stats.completed} of ${done} finished trades ended with the seller releasing.`}
                />
                <Stat
                  label="Volume"
                  value={`${Number(formatUnits(stats.volume, V4.tokenDecimals)).toLocaleString("en-US")} ${SYM}`}
                  hint="Across completed trades only."
                />
                <Stat
                  label="Releases in"
                  value={release ? (release.seconds < 60 ? "under a minute" : fmtDuration(release.seconds)) : "—"}
                  hint={release ? `Median over ${release.from} trade${release.from === 1 ? "" : "s"} they released themselves.` : "No completed releases yet."}
                />
                <Stat
                  label="Disputed"
                  value={stats.disputed === 0 ? "none" : `${stats.disputed}${stats.lost ? ` · ${stats.lost} lost` : ""}`}
                  hint={`${stats.disputed} of ${stats.total} trades went to a dispute.`}
                />
                <Stat
                  label="Rated good"
                  value={said && said.total > 0 ? `${pct(said.rate ?? 0)} of ${said.total}` : ratings.isLoading ? "…" : "no ratings"}
                  hint="Only counterparties from a finished trade can rate, and every rating is checked against the chain."
                />
              </div>

              {trust === "thin" && (
                <Notice tone="warn">
                  <span className="small">
                    <strong>Thin history.</strong> A clean record is cheap to build quickly — two wallets and an
                    afternoon buys a perfect completion rate. This one does not yet have the settled trades,
                    volume and age together that would make it expensive to fake. Nothing is wrong here; there
                    is just less to go on than the percentages suggest.
                  </span>
                </Notice>
              )}
              <DisputeWarning stats={stats} />

              {said && said.tags.length > 0 && (
                <div className="stack-xs">
                  <span className="eyebrow">What counterparties said</span>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {said.tags.map((t) => (
                      <Chip key={t.tag}>{t.tag} <span className="faint">· {t.count}</span></Chip>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            {explorer && (
              <a className="btn btn-ghost btn-sm" href={explorer} target="_blank" rel="noreferrer">
                View on explorer ↗
              </a>
            )}
            {activity.data !== undefined && (
              <span className="tiny faint">
                {activity.data} transaction{activity.data === 1 ? "" : "s"} from this wallet on {CHAIN.name}
              </span>
            )}
            <span style={{ flex: 1 }} />
            {!isMe && (
              <button
                type="button"
                className="linklike tiny"
                onClick={() => {
                  setBlocked(address, !blocked);
                  setBlockedState(!blocked);
                }}
              >
                {blocked ? "Unblock this trader" : "Block this trader"}
              </button>
            )}
          </div>
          {blocked && (
            <p className="tiny faint" style={{ margin: 0 }}>
              Their offers are hidden from your market on this device. They can still take offers you post —
              an offer is a signed message on public relays and the escrow honours it from anyone who meets
              its terms.
            </p>
          )}
        </div>
      </Card>

      <Card title="Live offers" sub={offers.data ? `${offers.data.length} signed and published right now.` : "Reading the relays…"} flush>
        {offers.isLoading ? (
          <div className="stack-sm" style={{ padding: 18 }}>
            <div className="skeleton" style={{ width: "45%" }} />
            <div className="skeleton" style={{ width: "70%" }} />
          </div>
        ) : !offers.data || offers.data.length === 0 ? (
          <Empty title="Nothing on the book">This trader has no live offers at the moment.</Empty>
        ) : (
          <div>
            {offers.data.map((o) => (
              <div key={o.offerHash} className="row-between" style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", gap: 12, flexWrap: "wrap" }}>
                <span className="small">
                  <span className="mono strong">{Number(o.terms.price).toLocaleString("en-US")} {o.terms.fiatCurrency}</span>
                  <span className="faint"> per {o.terms.tokenSymbol} · {o.side === "sell" ? "selling" : "buying"}</span>
                </span>
                <span className="tiny faint">
                  {o.terms.paymentMethods.join(", ")} · disputes: {arbitratorName(o.offer.arbitrator)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
