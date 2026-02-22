#!/usr/bin/env bash
set -euo pipefail

echo "==============================="
echo " P2P ESCROW - INVESTOR DEMO RUN"
echo "==============================="
echo

# 1) Deploy + happy path smoke
echo "==> 1/3 Deploy + Smoke"
./deploy-all.sh --smoke
echo

# load deployment outputs for following scripts
source ./.deployments/.env

# 2) Negative suite
echo "==> 2/3 Negative Suite"
./smoke-negative.sh
echo

# 3) Summary
echo "==> 3/3 Summary"
echo "RPC:        $RPC"
echo "ESCROW:     $ESCROW_ADDR"
echo "MOCK USDT:  $USDT_ADDR"
echo "TOKEN USED: ${ESCROW_TOKEN:-"(not set)"}"
echo "DEPLOYER:   $DEPLOYER"
echo
echo "✅ ALL CHECKS PASSED (smoke + negative suite)"
