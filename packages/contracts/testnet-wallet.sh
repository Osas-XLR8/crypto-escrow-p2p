#!/usr/bin/env bash
# Creates a throwaway deployer wallet for public testnets in .env.testnet (git-ignored), or shows the existing one.
# Never reuse this key on mainnet, and never fund it with anything but faucet ETH.
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=${ENV_FILE:-.env.testnet}

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "./$ENV_FILE"; set +a
  echo "Deployer: $(cast wallet address --private-key "$PRIVATE_KEY")  (from $ENV_FILE)"
  exit 0
fi

out=$(cast wallet new)
address=$(printf '%s\n' "$out" | awk '/^Address:/ {print $2}')
key=$(printf '%s\n' "$out" | awk '/^Private key:/ {print $3}')
[ -n "$address" ] && [ -n "$key" ] || { echo "Could not parse 'cast wallet new' output"; exit 1; }

umask 077
cat > "$ENV_FILE" <<EOF
# Testnet-only deployer. Git-ignored. Fund with faucet ETH only.
PRIVATE_KEY=$key
# Optional: a less rate-limited RPC endpoint for the target network.
# RPC_URL=https://sepolia.base.org
EOF

echo "Created $ENV_FILE"
echo "Deployer: $address"
echo "Fund it with a little Base Sepolia ETH (0.01 is plenty), then run ./deploy-testnet.sh"
