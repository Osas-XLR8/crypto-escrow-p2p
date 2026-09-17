// test/support/fixtures.ts
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from "viem/accounts";
import type { Address } from "viem";
import { createBinding, createOffer, deriveNostrIdentity, signOffer, type NostrIdentity, type Offer, type OfferTerms, type WalletBinding } from "../../src/index.js";

export const CHAIN_ID = 31337;
export const ESCROW = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" as Address;
export const USDT = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
export const ARB_PRIMARY = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;
export const ARB_FALLBACK = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as Address;

export function terms(overrides: Partial<OfferTerms> = {}): OfferTerms {
  return {
    chainId: CHAIN_ID,
    escrow: ESCROW,
    tokenSymbol: "USDT",
    tokenDecimals: 6,
    fiatCurrency: "NGN",
    price: "1600.50",
    paymentMethods: ["bank-transfer", "opay"],
    conditions: "Pay only from an account in your own name",
    ...overrides,
  };
}

export interface Party {
  account: PrivateKeyAccount;
  identity: NostrIdentity;
  binding: WalletBinding;
}

export async function party(account: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey())): Promise<Party> {
  const identity = await deriveNostrIdentity(account, account.address);
  const binding = await createBinding(account, account.address, identity.publicKey);
  return { account, identity, binding };
}

export async function signedOffer(seller: Party, t: OfferTerms = terms(), overrides: Partial<Parameters<typeof createOffer>[0]> = {}) {
  const offer: Offer = createOffer({
    seller: seller.account.address,
    token: USDT,
    minAmount: 10_000_000n,
    maxAmount: 500_000_000n,
    totalAmount: 2_000_000_000n,
    paymentWindow: 1800n,
    releaseWindow: 3600n,
    arbitrator: ARB_PRIMARY,
    fallbackArbitrator: ARB_FALLBACK,
    nonce: 0n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 86400),
    terms: t,
    ...overrides,
  });
  const signature = await signOffer(seller.account, offer, t.chainId, t.escrow);
  return { offer, signature, terms: t };
}
