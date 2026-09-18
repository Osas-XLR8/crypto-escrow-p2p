// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {TestUSDT} from "../src/TestUSDT.sol";

contract TestUSDTTest is Test {
    TestUSDT token;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new TestUSDT();
    }

    function testFaucetMintsToCaller() public {
        vm.prank(alice);
        token.faucet();
        assertEq(token.balanceOf(alice), token.FAUCET_AMOUNT());
        assertEq(token.totalSupply(), token.FAUCET_AMOUNT());
        assertEq(token.faucetAvailableAt(alice), block.timestamp + token.FAUCET_COOLDOWN());
    }

    function testFaucetCooldownPerAccount() public {
        vm.prank(alice);
        token.faucet();

        vm.warp(block.timestamp + token.FAUCET_COOLDOWN() - 1);
        vm.expectRevert(bytes("faucet cooldown"));
        vm.prank(alice);
        token.faucet();

        vm.prank(bob); // other accounts are unaffected
        token.faucet();

        vm.warp(block.timestamp + 1);
        vm.prank(alice);
        token.faucet();
        assertEq(token.balanceOf(alice), 2 * token.FAUCET_AMOUNT());
    }

    function testOnlyDeployerMints() public {
        token.mint(alice, 5e6);
        assertEq(token.balanceOf(alice), 5e6);
        vm.expectRevert(bytes("only deployer"));
        vm.prank(alice);
        token.mint(alice, 1);
    }

    function testTransferFromUsesAllowance() public {
        token.mint(alice, 100e6);
        vm.prank(alice);
        token.approve(bob, 60e6);

        vm.prank(bob);
        token.transferFrom(alice, bob, 60e6);
        assertEq(token.balanceOf(bob), 60e6);
        assertEq(token.allowance(alice, bob), 0);

        vm.expectRevert(bytes("insufficient allowance"));
        vm.prank(bob);
        token.transferFrom(alice, bob, 1);
    }

    function testIsNotNamedLikeTether() public view {
        assertEq(token.symbol(), "tUSDT");
        assertEq(token.decimals(), 6);
    }
}
