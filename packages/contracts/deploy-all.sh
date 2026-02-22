
#!/usr/bin/env bash
set -euo pipefail

# ==============================
# Config
# ==============================
RPC="${RPC:-http://127.0.0.1:8545}"
PRIVATE_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

NAME="${NAME:-Tether USD}"
SYMBOL="${SYMBOL:-USDT}"
DECIMALS="${DECIMALS:-6}"

MINT_AMOUNT="${MINT_AMOUNT:-1000000000}"
APPROVE_AMOUNT="${APPROVE_AMOUNT:-1000000000}"

BACKEND_SIGNER="${BACKEND_SIGNER:-}"

OUT_DIR="${OUT_DIR:-./.deployments}"
mkdir -p "$OUT_DIR"

USDT_ADDR_FILE="$OUT_DIR/mockusdt.address"
ESCROW_ADDR_FILE="$OUT_DIR/escrow.address"
ENV_FILE="$OUT_DIR/.env"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: '$1' not found in PATH"
    exit 1
  }
}

need forge
need cast
need awk
need date

echo "==> RPC: $RPC"
echo "==> Building..."
forge build >/dev/null

DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
SIGNER="${BACKEND_SIGNER:-$DEPLOYER}"

echo "==> Deployer:       $DEPLOYER"
echo "==> Backend signer: $SIGNER"

# ==============================
# Deploy MockUSDT
# ==============================
echo "==> Deploying MockUSDT..."
USDT_OUT="$(forge create \
  --rpc-url "$RPC" \
  --broadcast \
  --private-key "$PRIVATE_KEY" \
  src/MockUSDT.sol:MockUSDT \
  --constructor-args "$NAME" "$SYMBOL" "$DECIMALS")"

USDT_ADDR="$(echo "$USDT_OUT" | awk '/Deployed to:/ {print $3; exit}')"
[[ -z "$USDT_ADDR" ]] && { echo "ERROR: could not parse MockUSDT address"; exit 1; }

echo -n "$USDT_ADDR" > "$USDT_ADDR_FILE"
echo "==> MockUSDT: $USDT_ADDR"

# ==============================
# Deploy Escrow
# ==============================
echo "==> Deploying P2PEscrowTestable..."
ESCROW_OUT="$(forge create \
  --rpc-url "$RPC" \
  --broadcast \
  --private-key "$PRIVATE_KEY" \
  src/P2PEscrowTestable.sol:P2PEscrowTestable \
  --constructor-args "$SIGNER" "$USDT_ADDR")"

ESCROW_ADDR="$(echo "$ESCROW_OUT" | awk '/Deployed to:/ {print $3; exit}')"
[[ -z "$ESCROW_ADDR" ]] && { echo "ERROR: could not parse Escrow address"; exit 1; }

echo -n "$ESCROW_ADDR" > "$ESCROW_ADDR_FILE"
echo "==> Escrow:   $ESCROW_ADDR"

# ==============================
# Mint + Approve (MockUSDT)
# ==============================
echo "==> Minting tokens..."
cast send --rpc-url "$RPC" --private-key "$PRIVATE_KEY" \
  "$USDT_ADDR" "mint(address,uint256)" "$DEPLOYER" "$MINT_AMOUNT" >/dev/null

echo "==> Approving escrow..."
cast send --rpc-url "$RPC" --private-key "$PRIVATE_KEY" \
  "$USDT_ADDR" "approve(address,uint256)" "$ESCROW_ADDR" "$APPROVE_AMOUNT" >/dev/null

# ==============================
# Resolve actual token used by escrow
# ==============================
ESCROW_USDT="$(cast call --rpc-url "$RPC" "$ESCROW_ADDR" "USDT()(address)")"
ESCROW_TEST_TOKEN="$(cast call --rpc-url "$RPC" "$ESCROW_ADDR" "TEST_TOKEN()(address)" 2>/dev/null || true)"

if [[ "$ESCROW_USDT" == "$USDT_ADDR" ]]; then
  ESCROW_TOKEN="$USDT_ADDR"
else
  ESCROW_TOKEN="$ESCROW_TEST_TOKEN"
fi

# ==============================
# Save env
# ==============================
cat > "$ENV_FILE" <<ENV
RPC=$RPC
USDT_ADDR=$USDT_ADDR
ESCROW_ADDR=$ESCROW_ADDR
ESCROW_TOKEN=$ESCROW_TOKEN
DEPLOYER=$DEPLOYER
BACKEND_SIGNER=$SIGNER
ENV

echo "Saved: $ENV_FILE"

# ==============================
# Quick sanity
# ==============================
echo
echo "Escrow sanity:"
echo "USDT():        $ESCROW_USDT"
echo "TEST_TOKEN():  $ESCROW_TEST_TOKEN"
echo "ESCROW_TOKEN:  $ESCROW_TOKEN"

# ==============================
# Smoke test
# ==============================
if [[ "${1:-}" == "--smoke" ]]; then
  echo
  echo "==> Running SMOKE TEST"

  BUYER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
  AMT=100000000

  NOW=$(date +%s)
  LOCK=$((NOW + 600))
  EXP=$((NOW + 86400))
  TRADE_ID=$(cast keccak "trade-$NOW")

  echo "Trade: $TRADE_ID"

  cast send --rpc-url "$RPC" --private-key "$PRIVATE_KEY" \
    "$ESCROW_ADDR" \
    "createTrade(bytes32,address,address,uint256,uint64,uint64)" \
    "$TRADE_ID" "$DEPLOYER" "$BUYER" "$AMT" "$LOCK" "$EXP" >/dev/null

  cast send --rpc-url "$RPC" --private-key "$PRIVATE_KEY" \
    "$ESCROW_ADDR" "deposit(bytes32)" "$TRADE_ID" >/dev/null

  AUTH_EXP=$((NOW + 3600))
  SALT=$(cast keccak "salt-$NOW")

  DIGEST=$(cast call --rpc-url "$RPC" "$ESCROW_ADDR" \
    "releaseDigest(bytes32,uint64,bytes32)(bytes32)" \
    "$TRADE_ID" "$AUTH_EXP" "$SALT")

  SIG=$(cast wallet sign --private-key "$PRIVATE_KEY" "$DIGEST")

  cast send --rpc-url "$RPC" --private-key "$PRIVATE_KEY" \
    "$ESCROW_ADDR" \
    "release(bytes32,uint64,bytes32,bytes)" \
    "$TRADE_ID" "$AUTH_EXP" "$SALT" "$SIG" >/dev/null

  echo "==> Smoke test PASSED"
fi

echo
echo "✅ Done."

