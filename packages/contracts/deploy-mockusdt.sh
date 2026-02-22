#!/usr/bin/env bash
set -euo pipefail

# -------- Config (edit if you want) --------
CONTRACT="MockUSDT"
NAME="${NAME:-Tether USD}"
SYMBOL="${SYMBOL:-USDT}"
DECIMALS="${DECIMALS:-6}"

# RPC + PRIVATE_KEY should be set in your shell (recommended),
# but we provide defaults for local anvil/hardhat style setups:
RPC="${RPC:-http://127.0.0.1:8545}"
PRIVATE_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

OUT_DIR="${OUT_DIR:-/tmp}"
DEPLOY_LOG="${DEPLOY_LOG:-$OUT_DIR/deploy_${CONTRACT}.log}"
ADDR_FILE="${ADDR_FILE:-$OUT_DIR/${CONTRACT}.address}"

echo "==> Building..."
forge build >/dev/null

echo "==> Getting creation bytecode for ${CONTRACT}..."
CODE="$(forge inspect "$CONTRACT" bytecode | tr -d '\r\n\t ')"

if [[ -z "$CODE" || "$CODE" != 0x* ]]; then
  echo "ERROR: Could not read bytecode for ${CONTRACT}. Are you in the right folder?" >&2
  exit 1
fi

echo "==> Encoding constructor args..."
ARGS="$(cast abi-encode "constructor(string,string,uint8)" "$NAME" "$SYMBOL" "$DECIMALS")"

FULL="${CODE}${ARGS#0x}"

echo "==> Deploying to: $RPC"
# Capture full output so we can parse contractAddress reliably
DEPLOY_OUT="$(cast send \
  --rpc-url "$RPC" \
  --private-key "$PRIVATE_KEY" \
  --create "$FULL")"

echo "$DEPLOY_OUT" | tee "$DEPLOY_LOG" >/dev/null

ADDR="$(echo "$DEPLOY_OUT" | awk '/contractAddress/ {print $2; exit}')"

if [[ -z "$ADDR" || "$ADDR" == "null" ]]; then
  echo "ERROR: Could not parse contractAddress from deployment output." >&2
  echo "See log: $DEPLOY_LOG" >&2
  exit 1
fi

echo "==> Deployed ${CONTRACT} at: $ADDR"
echo -n "$ADDR" > "$ADDR_FILE"
echo "==> Saved address to: $ADDR_FILE"

echo
echo "Quick checks:"
cast call --rpc-url "$RPC" "$ADDR" "name()(string)" >/dev/null && echo "  - name():     OK"
cast call --rpc-url "$RPC" "$ADDR" "symbol()(string)" >/dev/null && echo "  - symbol():   OK"
cast call --rpc-url "$RPC" "$ADDR" "decimals()(uint8)" >/dev/null && echo "  - decimals(): OK"
cast call --rpc-url "$RPC" "$ADDR" "totalSupply()(uint256)" >/dev/null && echo "  - totalSupply(): OK"

echo
echo "Tip: In THIS terminal, you can do:"
echo "  export ADDR=$ADDR"

