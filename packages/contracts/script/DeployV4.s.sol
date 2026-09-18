// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {EscrowCoreV4} from "../src/v4/EscrowCoreV4.sol";
import {LicensedArbitratorAdapter} from "../src/v4/arbitration/LicensedArbitratorAdapter.sol";
import {TestUSDT} from "../src/TestUSDT.sol";

/// @notice Local / testnet deployment of the v4 stack:
///         TestUSDT (faucet token), two licensed-firm arbitrator adapters (primary + fallback), EscrowCoreV4.
/// @dev    Env:
///           PRIVATE_KEY          deployer (default: Anvil #0)
///           FIRM_ADMIN           admin for both adapters (default: deployer) — in production each
///                                firm deploys and controls its own adapter; never EscrowX
///           FIRM_FEE             arbitration fee in wei (default 0.01 ether)
///           REVIEW_PERIOD        adapter review period seconds (default 1 day)
///           ARBITRATION_TIMEOUT  escrow timeout seconds (default 30 days)
///           FEE_TIMEOUT          escrow fee-matching window seconds (default 2 days)
///           MINT_TO              optional address to receive 1,000,000 test tokens
///           TOKEN                optional existing ERC-20 to allow instead of deploying TestUSDT
///         Writes addresses to .deployments/v4-<chainid>.json
contract DeployV4 is Script {
    function run() external {
        uint256 pk =
            vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        address deployer = vm.addr(pk);
        address firmAdmin = vm.envOr("FIRM_ADMIN", deployer);
        uint256 firmFee = vm.envOr("FIRM_FEE", uint256(0.01 ether));
        uint64 reviewPeriod = uint64(vm.envOr("REVIEW_PERIOD", uint256(1 days)));
        uint64 arbitrationTimeout = uint64(vm.envOr("ARBITRATION_TIMEOUT", uint256(30 days)));
        uint64 feeTimeout = uint64(vm.envOr("FEE_TIMEOUT", uint256(2 days)));
        address mintTo = vm.envOr("MINT_TO", address(0));
        address existingToken = vm.envOr("TOKEN", address(0));

        vm.startBroadcast(pk);

        address usdt = existingToken;
        if (usdt == address(0)) {
            usdt = address(new TestUSDT());
        }
        LicensedArbitratorAdapter primary = new LicensedArbitratorAdapter(firmAdmin, firmAdmin, firmFee, reviewPeriod);
        LicensedArbitratorAdapter fallbackFirm =
            new LicensedArbitratorAdapter(firmAdmin, firmAdmin, firmFee, reviewPeriod);

        address[] memory tokens = new address[](1);
        tokens[0] = usdt;
        address[] memory arbitrators = new address[](2);
        arbitrators[0] = address(primary);
        arbitrators[1] = address(fallbackFirm);
        EscrowCoreV4 escrow = new EscrowCoreV4(tokens, arbitrators, arbitrationTimeout, feeTimeout);

        // After the core deploys, so their addresses stay deterministic on a fresh chain.
        if (mintTo != address(0) && existingToken == address(0)) TestUSDT(usdt).mint(mintTo, 1_000_000e6);

        vm.stopBroadcast();

        string memory key = "v4";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "deployBlock", block.number);
        vm.serializeAddress(key, "usdt", usdt);
        vm.serializeUint(key, "firmFee", firmFee);
        vm.serializeBool(key, "tokenFaucet", existingToken == address(0));
        vm.serializeAddress(key, "primaryArbitrator", address(primary));
        vm.serializeAddress(key, "fallbackArbitrator", address(fallbackFirm));
        string memory json = vm.serializeAddress(key, "escrow", address(escrow));
        string memory path = string.concat(vm.projectRoot(), "/.deployments/v4-", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console2.log("EscrowCoreV4       ", address(escrow));
        console2.log("Token              ", usdt);
        console2.log("Primary arbitrator ", address(primary));
        console2.log("Fallback arbitrator", address(fallbackFirm));
        console2.log("Written to         ", path);
    }
}
