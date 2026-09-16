// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {P2PEscrow} from "./P2PEscrow.sol";

/**
 * @title  P2PEscrowTestable
 * @notice Local dev / test override that swaps the hardcoded Arbitrum USDT
 *         address for a MockUSDT and removes the amount cap so smoke tests
 *         can use arbitrary values.
 * @dev    NEVER deploy this contract to mainnet or any production network.
 */
contract P2PEscrowTestable is P2PEscrow {
    address public immutable TEST_TOKEN;

    constructor(address _owner, address _backendSigner, address _operator, address _testToken)
        P2PEscrow(_owner, _backendSigner, _operator)
    {
        require(_testToken != address(0), "test token required");
        TEST_TOKEN = _testToken;
    }

    /// @dev Points to MockUSDT instead of Arbitrum USDT.
    function _token() internal view override returns (address) {
        return TEST_TOKEN;
    }

    /// @dev Remove the amount cap for tests.
    function _maxAmount() internal pure override returns (uint256) {
        return type(uint256).max;
    }
}
