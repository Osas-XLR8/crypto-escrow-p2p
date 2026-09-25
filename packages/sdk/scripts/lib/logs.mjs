// scripts/lib/logs.mjs — eth_getLogs that survives whatever the endpoint's range limit happens to be.
//
// Public endpoints disagree wildly: Base's own RPC caps a query at 1,000 blocks, others allow 50,000. Rather
// than hard-code one number per provider, start wide and halve on a range complaint until it goes through.

const RANGE_ERROR = /range|too many blocks|limited to|exceed|too large|query returned more than/i;

export async function getLogsChunked(client, { address, event, fromBlock, toBlock, startChunk = 40_000n, minChunk = 1_000n }) {
  const head = toBlock ?? (await client.getBlockNumber());
  const logs = [];
  let chunk = startChunk;
  let from = fromBlock;
  while (from <= head) {
    const to = from + chunk - 1n > head ? head : from + chunk - 1n;
    try {
      logs.push(...(await client.getLogs({ address, event, fromBlock: from, toBlock: to })));
      from = to + 1n;
    } catch (e) {
      const message = e?.cause?.message ?? e?.details ?? e?.shortMessage ?? e?.message ?? "";
      if (!RANGE_ERROR.test(message) || chunk <= minChunk) throw e;
      chunk = chunk / 2n > minChunk ? chunk / 2n : minChunk;
    }
  }
  return logs;
}
