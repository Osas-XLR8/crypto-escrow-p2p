#!/usr/bin/env bash
# Deploys the v4 stack (TestUSDT faucet token, two demo arbitration adapters, EscrowCoreV4) to a public testnet
# and writes the addresses to deployments/v4-<chainId>.json, which the web app build reads.
#
#   ./testnet-wallet.sh            # once: create a throwaway deployer, then fund it from a faucet
#   ./deploy-testnet.sh            # Base Sepolia by default; RPC_URL=... for another network
#
# On a testnet the deployer administers both demo arbitration adapters. That is fine for a demo and is shown as
# "Demo arbitration firm A/B" in the app; in production each firm deploys and controls its own adapter.
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=${ENV_FILE:-.env.testnet}
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE. Run ./testnet-wallet.sh first."; exit 1; }
# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a

RPC_URL=${RPC_URL:-https://sepolia.base.org}
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
BALANCE=$(cast balance "$DEPLOYER" --rpc-url "$RPC_URL")

echo "Network : chain $CHAIN_ID via $RPC_URL"
echo "Deployer: $DEPLOYER ($(cast from-wei "$BALANCE") ETH)"
if [ "$CHAIN_ID" = "1" ] || [ "$CHAIN_ID" = "8453" ] || [ "$CHAIN_ID" = "42161" ] || [ "$CHAIN_ID" = "10" ] || [ "$CHAIN_ID" = "137" ]; then
  echo "Refusing to deploy test contracts to a mainnet (chain $CHAIN_ID)."; exit 1
fi
[ "$BALANCE" != "0" ] || { echo "The deployer has no ETH. Send it some faucet ETH first."; exit 1; }

# Blockscout verification needs no API key; skipped for networks not listed here.
case "$CHAIN_ID" in
  84532)    VERIFIER_URL=https://base-sepolia.blockscout.com/api/ ;;
  11155111) VERIFIER_URL=https://eth-sepolia.blockscout.com/api/ ;;
  421614)   VERIFIER_URL=https://arbitrum-sepolia.blockscout.com/api/ ;;
  11155420) VERIFIER_URL=https://optimism-sepolia.blockscout.com/api/ ;;
  *)        VERIFIER_URL= ;;
esac

export PRIVATE_KEY
export MINT_TO=${MINT_TO:-$DEPLOYER}
export FIRM_FEE=${FIRM_FEE:-500000000000000} # 0.0005 ETH: cheap enough for faucet-funded testers
# Shortest values the contracts allow (their MIN_* constants), so a full dispute can be demoed with a ~1 hour
# wait: fee match window 1 day, arbitrator deadline 7 days, firm review period 1 hour.
export FEE_TIMEOUT=${FEE_TIMEOUT:-86400}
export ARBITRATION_TIMEOUT=${ARBITRATION_TIMEOUT:-604800}
export REVIEW_PERIOD=${REVIEW_PERIOD:-3600}

VERIFY_ARGS=()
if [ -n "$VERIFIER_URL" ] && [ "${VERIFY:-1}" = "1" ]; then
  VERIFY_ARGS=(--verify --verifier blockscout --verifier-url "$VERIFIER_URL")
fi

set +e
forge script script/DeployV4.s.sol:DeployV4 --rpc-url "$RPC_URL" --broadcast --slow "${VERIFY_ARGS[@]}"
status=$?
set -e

RESULT=".deployments/v4-$CHAIN_ID.json"
[ -f "$RESULT" ] || { echo "No deployment record written."; exit 1; }
ESCROW=$(sed -n 's/.*"escrow": *"\(0x[0-9a-fA-F]*\)".*/\1/p' "$RESULT")
# The record is written during simulation, so confirm the escrow really exists on-chain before publishing it.
if [ "$(cast code "$ESCROW" --rpc-url "$RPC_URL")" = "0x" ]; then
  echo "Escrow $ESCROW has no code on chain $CHAIN_ID — the broadcast failed (exit $status)."; exit 1
fi
[ "$status" = "0" ] || echo "Deployed, but source verification reported a problem (exit $status). The contracts work; verify later if needed."

mkdir -p deployments
cp "$RESULT" "deployments/v4-$CHAIN_ID.json"
echo
echo "Published deployments/v4-$CHAIN_ID.json:"
cat "deployments/v4-$CHAIN_ID.json"
echo
echo "Next: commit deployments/v4-$CHAIN_ID.json and push to main — the 'Deploy web app' workflow builds and publishes the site."
echo "Local preview against this network: (cd my-rainbowkit-app && npm run sync:v4 -- $CHAIN_ID && npm run dev)"
