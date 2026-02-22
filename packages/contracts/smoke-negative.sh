#!/usr/bin/env bash
set -euo pipefail

# load deployment outputs
source ./.deployments/.env

SELLER_PK="${PRIVATE_KEY:?set PRIVATE_KEY in env}"
BUYER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
BUYER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

echo "RPC=$RPC"
echo "ESCROW=$ESCROW_ADDR"
echo "TOKEN=$ESCROW_TOKEN"
echo "DEPLOYER=$DEPLOYER"
echo

NOW=$(date +%s)
LOCK=$((NOW + 600))
EXP=$((NOW + 86400))
TRADE_ID=$(cast keccak "neg-$NOW")
AMT=100000000

echo "Creating trade: $TRADE_ID"
cast send --rpc-url "$RPC" --private-key "$SELLER_PK" \
  "$ESCROW_ADDR" \
  "createTrade(bytes32,address,address,uint256,uint64,uint64)" \
  "$TRADE_ID" "$DEPLOYER" "$BUYER" "$AMT" "$LOCK" "$EXP" >/dev/null
echo "✅ trade created"
echo

echo "1) deposit by BUYER should fail (only seller)"
set +e
cast send --rpc-url "$RPC" --private-key "$BUYER_PK" \
  "$ESCROW_ADDR" "deposit(bytes32)" "$TRADE_ID" >/dev/null
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
  echo "✅ expected fail"
else
  echo "❌ UNEXPECTED: buyer deposit succeeded" >&2
  exit 1
fi
echo

echo "2) valid seller deposit should succeed"
cast send --rpc-url "$RPC" --private-key "$SELLER_PK" \
  "$ESCROW_ADDR" "deposit(bytes32)" "$TRADE_ID" >/dev/null
echo "✅ deposit ok"
echo

echo "3) release with WRONG backend signer should fail"
AUTH_EXP=$((NOW + 3600))
SALT=$(cast keccak "salt-$NOW-wrong-signer")

DIGEST=$(cast call --rpc-url "$RPC" "$ESCROW_ADDR" \
  "releaseDigest(bytes32,uint64,bytes32)(bytes32)" \
  "$TRADE_ID" "$AUTH_EXP" "$SALT")

BAD_SIG=$(cast wallet sign --private-key "$BUYER_PK" "$DIGEST")

set +e
cast send --rpc-url "$RPC" --private-key "$SELLER_PK" \
  "$ESCROW_ADDR" "release(bytes32,uint64,bytes32,bytes)" \
  "$TRADE_ID" "$AUTH_EXP" "$SALT" "$BAD_SIG" >/dev/null
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
  echo "✅ expected fail"
else
  echo "❌ UNEXPECTED: wrong-signer release succeeded" >&2
  exit 1
fi
echo

echo "4) release with EXPIRED authorization should fail"
AUTH_EXP_PAST=$((NOW - 10))
SALT2=$(cast keccak "salt-$NOW-expired")

DIGEST2=$(cast call --rpc-url "$RPC" "$ESCROW_ADDR" \
  "releaseDigest(bytes32,uint64,bytes32)(bytes32)" \
  "$TRADE_ID" "$AUTH_EXP_PAST" "$SALT2")

SIG_EXPIRED=$(cast wallet sign --private-key "$SELLER_PK" "$DIGEST2")

set +e
cast send --rpc-url "$RPC" --private-key "$SELLER_PK" \
  "$ESCROW_ADDR" "release(bytes32,uint64,bytes32,bytes)" \
  "$TRADE_ID" "$AUTH_EXP_PAST" "$SALT2" "$SIG_EXPIRED" >/dev/null
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
  echo "✅ expected fail"
else
  echo "❌ UNEXPECTED: expired-authorization release succeeded" >&2
  exit 1
fi
echo

echo "5) replay protection: second release attempt should fail (trade no longer locked)"
AUTH_EXP_OK=$((NOW + 3600))
SALT3=$(cast keccak "salt-$NOW-replay")

DIGEST3=$(cast call --rpc-url "$RPC" "$ESCROW_ADDR" \
  "releaseDigest(bytes32,uint64,bytes32)(bytes32)" \
  "$TRADE_ID" "$AUTH_EXP_OK" "$SALT3")

SIG_OK=$(cast wallet sign --private-key "$SELLER_PK" "$DIGEST3")

echo "   5a) first release should succeed"
cast send --rpc-url "$RPC" --private-key "$SELLER_PK" \
  "$ESCROW_ADDR" "release(bytes32,uint64,bytes32,bytes)" \
  "$TRADE_ID" "$AUTH_EXP_OK" "$SALT3" "$SIG_OK" >/dev/null
echo "✅ first release ok"

echo "   5b) second release (same params) should fail"
set +e
cast send --rpc-url "$RPC" --private-key "$SELLER_PK" \
  "$ESCROW_ADDR" "release(bytes32,uint64,bytes32,bytes)" \
  "$TRADE_ID" "$AUTH_EXP_OK" "$SALT3" "$SIG_OK" >/dev/null
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
  echo "✅ expected fail"
else
  echo "❌ UNEXPECTED: replayed release succeeded" >&2
  exit 1
fi

echo
echo "✅ Negative suite complete."
