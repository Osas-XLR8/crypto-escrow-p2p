// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IArbitrator, IArbitrable} from "../../src/v4/interfaces/IArbitration.sol";

/// @notice Minimal ERC-792 arbitrator: collects the fee, and rules when told to.
contract MockArbitrator is IArbitrator {
    uint256 public cost = 0.01 ether;
    uint256 public disputeCount;
    mapping(uint256 => address) public arbitrableOf;

    function setCost(uint256 c) external {
        cost = c;
    }

    function arbitrationCost(bytes calldata) external view returns (uint256) {
        return cost;
    }

    function createDispute(uint256, bytes calldata) external payable returns (uint256 id) {
        require(msg.value >= cost, "fee");
        id = ++disputeCount;
        arbitrableOf[id] = msg.sender;
    }

    function giveRuling(uint256 id, uint256 ruling) external {
        IArbitrable(arbitrableOf[id]).rule(id, ruling);
    }
}

/// @notice USDT-style token whose transfer functions return nothing.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address spender, uint256 amt) external {
        allowance[msg.sender][spender] = amt;
    }

    function transfer(address to, uint256 amt) external {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
    }

    function transferFrom(address from, address to, uint256 amt) external {
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
    }
}

/// @notice Burns 1% on every transfer.
contract FeeOnTransferToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        _move(msg.sender, to, amt);
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt;
        _move(from, to, amt);
        return true;
    }

    function _move(address from, address to, uint256 amt) private {
        balanceOf[from] -= amt;
        balanceOf[to] += amt - amt / 100;
    }
}

/// @notice ERC-1271 smart-contract wallet controlled by one EOA key.
contract SmartWallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        address recovered = ecrecover(hash, uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
        return recovered == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function exec(address target, bytes calldata data) external {
        require(msg.sender == owner, "not owner");
        (bool ok,) = target.call(data);
        require(ok, "exec failed");
    }
}
