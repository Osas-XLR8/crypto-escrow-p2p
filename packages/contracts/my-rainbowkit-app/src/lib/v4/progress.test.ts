import { describe, expect, it } from "vitest";
import { V4State, progressSteps } from "@/lib/v4/tradeIndex";

const events = (...names: string[]) => names.map((name) => ({ name }) as { name: never });
const status = (steps: ReturnType<typeof progressSteps>, label: string) => steps.find((s) => s.label === label)?.status;

describe("progressSteps", () => {
  it("marks the stage a trade is sitting in", () => {
    expect(status(progressSteps(V4State.LOCKED, events("TradeOpened")), "Locked")).toBe("current");
    expect(status(progressSteps(V4State.PAID, events("TradeOpened", "PaymentMarked")), "Paid")).toBe("current");
  });

  it("greys out a stage that never happened instead of claiming it did", () => {
    // A seller can release straight from LOCKED: the buyer never confirmed a payment.
    const steps = progressSteps(V4State.RELEASED, events("TradeOpened", "Released"));
    expect(status(steps, "Locked")).toBe("done");
    expect(status(steps, "Paid")).toBe("skipped");
    expect(status(steps, "Released")).toBe("done");
  });

  it("keeps the stage when it did happen", () => {
    const steps = progressSteps(V4State.RELEASED, events("TradeOpened", "PaymentMarked", "Released"));
    expect(status(steps, "Paid")).toBe("done");
  });

  it("shows a dispute as the live stage, with the outcome still ahead", () => {
    const steps = progressSteps(V4State.DISPUTED, events("TradeOpened", "PaymentMarked", "DisputeRequested", "DisputeCreated"));
    expect(steps.map((s) => s.label)).toEqual(["Locked", "Paid", "Dispute", "Resolved"]);
    expect(status(steps, "Dispute")).toBe("current");
    expect(status(steps, "Resolved")).toBe("todo");
  });

  it("closes out a dispute that ended in a release", () => {
    const steps = progressSteps(V4State.RELEASED, events("TradeOpened", "PaymentMarked", "DisputeRequested", "Released"));
    expect(status(steps, "Dispute")).toBe("done");
    expect(status(steps, "Resolved")).toBe("done");
  });

  it("ends a cancelled trade badly, and doesn't invent a payment", () => {
    const steps = progressSteps(V4State.CANCELLED, events("TradeOpened", "Cancelled"));
    expect(steps.map((s) => s.label)).toEqual(["Locked", "Paid", "Returned"]);
    expect(status(steps, "Paid")).toBe("skipped");
    expect(status(steps, "Returned")).toBe("bad");
  });

  it("remembers a dispute on a cancelled trade", () => {
    const steps = progressSteps(V4State.CANCELLED, events("TradeOpened", "PaymentMarked", "DisputeRequested", "Cancelled"));
    expect(steps.map((s) => s.label)).toEqual(["Locked", "Paid", "Dispute", "Returned"]);
    expect(status(steps, "Paid")).toBe("done");
  });
});
