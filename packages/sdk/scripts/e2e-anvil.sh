#!/usr/bin/env bash
# Starts a throwaway Anvil, deploys the v4 stack (escrow + two licensed-firm adapters + MockUSDT),
# then runs the SDK end-to-end suite against it. Used by CI; works on Linux/macOS/WSL.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SDK_DIR="$(cd "$HERE/.." && pwd)"
CONTRACTS_DIR="$(cd "$SDK_DIR/../contracts" && pwd)"
PORT="${ANVIL_PORT:-8545}"
RPC="http://127.0.0.1:$PORT"

anvil --port "$PORT" --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done

# Anvil #1 is the test seller.
(
  cd "$CONTRACTS_DIR"
  MINT_TO=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
    forge script script/DeployV4.s.sol:DeployV4 --rpc-url "$RPC" --broadcast --silent
)

cd "$SDK_DIR"
E2E_RPC_URL="$RPC" V4_DEPLOYMENT="$CONTRACTS_DIR/.deployments/v4-31337.json" npm run test:e2e
