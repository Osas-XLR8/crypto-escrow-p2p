// src/relayTimeout.ts — a relay that accepts a connection and then says nothing must not hold a caller open.
//
// nostr-tools returns one promise per relay from `publish`, and a relay that never answers never settles its
// promise. Waiting on all of them therefore waits forever, which in a UI is a spinner with no way out.

/** How long a publish waits for each relay before counting it as no answer. */
export const RELAY_PUBLISH_TIMEOUT_MS = 10_000;

export function settleWithin<T>(promises: Promise<T>[], ms: number): Promise<PromiseSettledResult<T>[]> {
  return Promise.all(
    promises.map((p) =>
      Promise.race([
        p.then(
          (value) => ({ status: "fulfilled", value }) as PromiseSettledResult<T>,
          (reason) => ({ status: "rejected", reason }) as PromiseSettledResult<T>
        ),
        new Promise<PromiseSettledResult<T>>((resolve) =>
          setTimeout(() => resolve({ status: "rejected", reason: new Error("relay did not answer") }), ms)
        ),
      ])
    )
  );
}
