// src/lib/resolveAuth.ts
// Shared between the browser and /api/escrow/sign-resolve so the auth message
// the admin wallet signs is byte-for-byte identical on both sides.

/** How long a signed auth request stays valid (seconds). */
export const RESOLVE_AUTH_TTL_SECONDS = 300;

export function resolveAuthMessage(params: {
  tradeId: string;
  buyerWins: boolean;
  issuedAt: number;
  chainId: number;
  escrow: string;
}): string {
  return [
    "P2PEscrow dispute resolution request",
    `Trade: ${params.tradeId.toLowerCase()}`,
    `Outcome: ${params.buyerWins ? "RELEASE_TO_BUYER" : "REFUND_TO_SELLER"}`,
    `Chain: ${params.chainId}`,
    `Escrow: ${params.escrow.toLowerCase()}`,
    `Issued: ${params.issuedAt}`,
  ].join("\n");
}
