// src/components/StateBadge.tsx — EscrowCoreV4 trade states.

export const STATE_META: Record<number, { label: string; cls: string }> = {
  0: { label: "None", cls: "" },
  1: { label: "Locked", cls: "badge-locked" },
  2: { label: "Paid", cls: "badge-paid" },
  3: { label: "Fee pending", cls: "badge-dispute" },
  4: { label: "Disputed", cls: "badge-dispute" },
  5: { label: "Released", cls: "badge-released" },
  6: { label: "Cancelled", cls: "badge-cancelled" },
};

export function StateBadge({ state }: { state: number }) {
  const m = STATE_META[state] ?? STATE_META[0]!;
  return (
    <span className={`badge ${m.cls}`}>
      <span className="dot" aria-hidden />
      {m.label}
    </span>
  );
}
