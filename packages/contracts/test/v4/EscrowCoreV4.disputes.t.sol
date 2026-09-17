// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EscrowCoreV4} from "../../src/v4/EscrowCoreV4.sol";
import {MockArbitrator, EtherRejectingActor} from "./Mocks.sol";
import {V4TestBase} from "./V4TestBase.sol";

/// @notice Change #2: loser-pays arbitration fees, fallback arbitrator, terminal timeouts.
contract EscrowCoreV4DisputesTest is V4TestBase {
    uint256 c; // primary arbitrator cost

    function setUp() public override {
        super.setUp();
        c = arb.cost();
    }

    function _buyerOpens(uint256 amount) internal returns (uint256 id) {
        id = _paid(amount);
        vm.warp(block.timestamp + RELEASE_WINDOW + 1);
        vm.prank(buyer);
        escrow.openDispute{value: c}(id);
    }

    function _escalated(uint256 amount) internal returns (uint256 id) {
        id = _disputed(amount);
        vm.warp(block.timestamp + ARB_TIMEOUT + 1);
        uint256 fallbackCost = arb2.cost();
        vm.prank(buyer);
        escrow.escalateToFallback{value: fallbackCost}(id);
    }

    // ─── Opening & fee matching ───────────────────────────────────────────────

    function testOpenDisputeWaitsForCounterpartyFee() public {
        uint256 id = _feePending(100 * U);
        EscrowCoreV4.DisputeInfo memory d = escrow.getDispute(id);

        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.FEE_PENDING));
        assertEq(d.opener, seller);
        assertEq(d.paidSeller, c);
        assertEq(d.paidBuyer, 0);
        assertEq(d.pool, c);
        assertEq(d.feeDeadline, block.timestamp + FEE_TIMEOUT);
        assertEq(arb.disputeCount(), 0); // arbitrator not engaged (or paid) yet
    }

    function testOnlyCounterpartyCanMatchFeeWithinWindow() public {
        uint256 id = _feePending(100 * U);

        vm.prank(seller); // the opener
        vm.expectRevert("only counterparty");
        escrow.payArbitrationFee{value: c}(id);

        vm.prank(stranger);
        vm.expectRevert("only counterparty");
        escrow.payArbitrationFee{value: c}(id);

        vm.prank(buyer);
        vm.expectRevert("insufficient arbitration fee");
        escrow.payArbitrationFee{value: c - 1}(id);

        vm.warp(block.timestamp + FEE_TIMEOUT + 1);
        vm.prank(buyer);
        vm.expectRevert("fee window closed");
        escrow.payArbitrationFee{value: c}(id);
    }

    function testMatchingFeeCreatesDisputeWithPrimary() public {
        uint256 id = _disputed(100 * U);
        EscrowCoreV4.Trade memory t = escrow.getTrade(id);
        EscrowCoreV4.DisputeInfo memory d = escrow.getDispute(id);

        assertEq(uint256(t.state), uint256(EscrowCoreV4.State.DISPUTED));
        assertEq(t.activeArbitrator, address(arb));
        assertEq(arb.disputeCount(), 1);
        assertEq(address(arb).balance, c); // exactly one fee spent
        assertEq(d.pool, c); // the other fee is held for the winner
        assertEq(d.startedAt, block.timestamp);
        assertEq(escrow.disputeToTrade(address(arb), d.disputeId), id);
        (address b, address s) = escrow.disputeParties(address(arb), d.disputeId);
        assertEq(b, buyer);
        assertEq(s, seller);
    }

    // ─── Fee default ──────────────────────────────────────────────────────────

    function testSellerWinsIfBuyerNeverPaysFee() public {
        uint256 id = _feePending(400 * U);

        vm.expectRevert("fee window open");
        escrow.claimFeeTimeout(id);

        vm.warp(block.timestamp + FEE_TIMEOUT + 1);
        vm.prank(stranger); // permissionless
        escrow.claimFeeTimeout(id);

        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.CANCELLED));
        assertEq(escrow.freeBalance(seller, address(usdt)), 10_000 * U);
        assertEq(escrow.claimableNative(seller), c); // opener fully refunded
        assertEq(address(arb).balance, 0);
    }

    function testBuyerWinsIfSellerNeverPaysFee() public {
        uint256 id = _buyerOpens(400 * U);
        vm.warp(block.timestamp + FEE_TIMEOUT + 1);
        escrow.claimFeeTimeout(id);

        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.RELEASED));
        assertEq(usdt.balanceOf(buyer), 400 * U);
        assertEq(escrow.claimableNative(buyer), c);
        assertEq(escrow.claimableNative(seller), 0);
    }

    // ─── Loser pays ───────────────────────────────────────────────────────────

    function testLoserPaysWhenBuyerWins() public {
        uint256 id = _disputed(250 * U);
        arb.giveRuling(_disputeId(id), 1);

        assertEq(usdt.balanceOf(buyer), 250 * U);
        assertEq(escrow.claimableNative(buyer), c); // winner refunded
        assertEq(escrow.claimableNative(seller), 0); // loser's fee paid the arbitrator
        assertEq(escrow.getDispute(id).pool, 0);
    }

    function testLoserPaysWhenSellerWins() public {
        uint256 id = _disputed(250 * U);
        arb.giveRuling(_disputeId(id), 2);

        assertEq(escrow.freeBalance(seller, address(usdt)), 10_000 * U);
        assertEq(escrow.claimableNative(seller), c);
        assertEq(escrow.claimableNative(buyer), 0);
    }

    function testRefusalToRuleSplitsFeesProRata() public {
        uint256 id = _disputed(250 * U);
        arb.giveRuling(_disputeId(id), 0);

        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.CANCELLED));
        assertEq(escrow.claimableNative(buyer), c / 2);
        assertEq(escrow.claimableNative(seller), c - c / 2);
    }

    // ─── Concessions count as losing ──────────────────────────────────────────

    function testSellerReleaseDuringFeePendingRefundsBuyerOpener() public {
        uint256 id = _buyerOpens(100 * U);
        vm.prank(seller);
        escrow.release(id);
        assertEq(usdt.balanceOf(buyer), 100 * U);
        assertEq(escrow.claimableNative(buyer), c);
        assertEq(escrow.claimableNative(seller), 0);
    }

    function testOpenerConcedingBeforeArbitrationGetsOwnFeeBack() public {
        // Seller opened, then changed their mind before any arbitrator was paid: nothing was spent,
        // so the pool (the seller's own deposit) goes back to the seller.
        uint256 id = _feePending(100 * U);
        vm.prank(seller);
        escrow.release(id);
        assertEq(escrow.claimableNative(seller), c);
        assertEq(escrow.claimableNative(buyer), 0);
    }

    function testConcessionAfterArbitrationStartedLoserPays() public {
        uint256 id = _disputed(100 * U);
        vm.prank(buyer);
        escrow.buyerCancel(id);
        assertEq(escrow.claimableNative(seller), c);
        assertEq(escrow.claimableNative(buyer), 0);

        // A later ruling from the arbitrator is ignored and moves nothing.
        arb.giveRuling(_disputeId(id), 1);
        assertEq(usdt.balanceOf(buyer), 0);
        assertEq(escrow.claimableNative(buyer), 0);
    }

    // ─── Pull payments ────────────────────────────────────────────────────────

    function testWithdrawNative() public {
        uint256 id = _disputed(100 * U);
        arb.giveRuling(_disputeId(id), 1);

        uint256 before = buyer.balance;
        vm.prank(buyer);
        escrow.withdrawNative();
        assertEq(buyer.balance, before + c);
        assertEq(escrow.claimableNative(buyer), 0);

        vm.prank(buyer);
        vm.expectRevert("nothing to withdraw");
        escrow.withdrawNative();
    }

    function testPartyRejectingEtherCannotBlockSettlement() public {
        EtherRejectingActor actor = new EtherRejectingActor();
        vm.deal(address(actor), 1 ether);

        // The ether-rejecting contract is the buyer.
        EscrowCoreV4.Offer memory o = _offer();
        bytes memory sig = _signOffer(escrow, o);
        uint256 id = abi.decode(
            actor.exec(address(escrow), 0, abi.encodeCall(EscrowCoreV4.takeOffer, (o, sig, 100 * U))), (uint256)
        );
        actor.exec(address(escrow), 0, abi.encodeCall(EscrowCoreV4.markPaid, (id, bytes32(0))));
        vm.prank(seller);
        escrow.openDispute{value: c}(id);
        actor.exec(address(escrow), c, abi.encodeCall(EscrowCoreV4.payArbitrationFee, (id)));

        arb.giveRuling(_disputeId(id), 1); // settles even though the buyer can't receive ether
        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.RELEASED));
        assertEq(usdt.balanceOf(address(actor)), 100 * U);
        assertEq(escrow.claimableNative(address(actor)), c);

        vm.expectRevert("native transfer failed"); // only its own withdrawal fails
        actor.exec(address(escrow), 0, abi.encodeCall(EscrowCoreV4.withdrawNative, ()));
    }

    // ─── Fallback arbitrator ──────────────────────────────────────────────────

    function testEscalationRequiresPrimaryTimeoutAndParty() public {
        uint256 id = _disputed(100 * U);

        vm.prank(buyer);
        vm.expectRevert("primary arbitrator still has time");
        escrow.escalateToFallback{value: 1 ether}(id);

        vm.warp(block.timestamp + ARB_TIMEOUT + 1);
        vm.prank(stranger);
        vm.expectRevert("only parties");
        escrow.escalateToFallback{value: 1 ether}(id);

        vm.prank(seller);
        escrow.escalateToFallback(id); // pool (one fee) covers the fallback's equal cost

        EscrowCoreV4.Trade memory t = escrow.getTrade(id);
        EscrowCoreV4.DisputeInfo memory d = escrow.getDispute(id);
        assertEq(t.activeArbitrator, address(arb2));
        assertTrue(d.escalated);
        assertEq(d.startedAt, block.timestamp);
        assertEq(arb2.disputeCount(), 1);
        assertEq(d.pool, 0);

        vm.prank(buyer);
        vm.expectRevert("already escalated");
        escrow.escalateToFallback{value: 1 ether}(id);
    }

    function testEscalationShortfallToppedUpByCaller() public {
        uint256 id = _disputed(100 * U);
        arb2.setCost(3 * c); // pool holds c → shortfall 2c
        vm.warp(block.timestamp + ARB_TIMEOUT + 1);

        vm.prank(buyer);
        vm.expectRevert("insufficient arbitration fee");
        escrow.escalateToFallback{value: 2 * c - 1}(id);

        vm.prank(buyer);
        escrow.escalateToFallback{value: 2 * c + 5}(id);

        EscrowCoreV4.DisputeInfo memory d = escrow.getDispute(id);
        assertEq(d.paidBuyer, 3 * c);
        assertEq(d.paidSeller, c);
        assertEq(d.pool, 0);
        assertEq(address(arb2).balance, 3 * c);
        assertEq(escrow.claimableNative(buyer), 5); // overpayment credited
    }

    function testEscalationLeavesExcessPoolForWinner() public {
        uint256 id = _disputed(100 * U);
        arb2.setCost(c / 4);
        vm.warp(block.timestamp + ARB_TIMEOUT + 1);
        vm.prank(seller);
        escrow.escalateToFallback(id);
        assertEq(escrow.getDispute(id).pool, c - c / 4);

        arb2.giveRuling(_disputeId(id), 2);
        assertEq(escrow.claimableNative(seller), c - c / 4); // winner gets what's left (≤ what they paid)
        assertEq(escrow.claimableNative(buyer), 0);
    }

    function testPrimaryRulingIgnoredAfterEscalation() public {
        uint256 id = _disputed(100 * U);
        uint256 primaryDisputeId = _disputeId(id);
        vm.warp(block.timestamp + ARB_TIMEOUT + 1);
        vm.prank(buyer);
        escrow.escalateToFallback(id);

        arb.giveRuling(primaryDisputeId, 1); // late primary ruling: no revert, no effect
        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.DISPUTED));
        assertEq(usdt.balanceOf(buyer), 0);

        arb2.giveRuling(_disputeId(id), 2);
        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.CANCELLED));
        assertEq(escrow.freeBalance(seller, address(usdt)), 10_000 * U);
    }

    function testTerminalTimeoutAfterFallback() public {
        uint256 id = _escalated(300 * U);

        vm.warp(block.timestamp + ARB_TIMEOUT);
        vm.expectRevert("arbitration ongoing");
        escrow.claimArbitrationTimeout(id);

        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        escrow.claimArbitrationTimeout(id);
        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.CANCELLED));
        assertEq(escrow.freeBalance(seller, address(usdt)), 10_000 * U);
    }

    function testTerminalTimeoutWithoutEscalationNeedsDoubleTimeout() public {
        uint256 id = _disputed(300 * U);
        vm.warp(block.timestamp + ARB_TIMEOUT + 1);
        vm.expectRevert("arbitration ongoing");
        escrow.claimArbitrationTimeout(id);

        vm.warp(block.timestamp + ARB_TIMEOUT);
        escrow.claimArbitrationTimeout(id);
        assertEq(escrow.claimableNative(buyer), c / 2);
        assertEq(escrow.claimableNative(seller), c - c / 2);
    }

    function testOfferRequiresDistinctApprovedFallback() public {
        EscrowCoreV4.Offer memory o = _offer();
        o.fallbackArbitrator = address(arb);
        bytes memory sig = _signOffer(escrow, o);
        vm.prank(buyer);
        vm.expectRevert("fallback must differ from primary");
        escrow.takeOffer(o, sig, 100 * U);

        o = _offer();
        o.fallbackArbitrator = address(new MockArbitrator());
        sig = _signOffer(escrow, o);
        vm.prank(buyer);
        vm.expectRevert("fallback arbitrator not approved");
        escrow.takeOffer(o, sig, 100 * U);
    }

    function testArbitrationCostRiseBetweenPayments() public {
        uint256 id = _feePending(100 * U); // seller deposited c
        arb.setCost(2 * c);

        vm.prank(buyer);
        escrow.payArbitrationFee{value: 2 * c}(id);
        assertEq(address(arb).balance, 2 * c);
        assertEq(escrow.getDispute(id).pool, c);

        arb.giveRuling(_disputeId(id), 1);
        // Documented edge: the winner is refunded only what the pool holds (c of their 2c).
        assertEq(escrow.claimableNative(buyer), c);
        assertEq(escrow.claimableNative(seller), 0);
    }

    // ─── Fuzz: native currency is always conserved ────────────────────────────

    function testFuzzNativeConservation(uint256 primaryCost, uint256 fallbackCost, uint8 path) public {
        primaryCost = bound(primaryCost, 0, 1 ether);
        fallbackCost = bound(fallbackCost, 0, 1 ether);
        path = uint8(bound(path, 0, 5));
        arb.setCost(primaryCost);
        arb2.setCost(fallbackCost);
        vm.deal(buyer, 10 ether);
        vm.deal(seller, 10 ether);
        uint256 startTotal = buyer.balance + seller.balance;

        uint256 id = _paid(100 * U);
        vm.prank(seller);
        escrow.openDispute{value: primaryCost}(id);

        if (path == 0) {
            vm.warp(block.timestamp + FEE_TIMEOUT + 1);
            escrow.claimFeeTimeout(id);
        } else {
            vm.prank(buyer);
            escrow.payArbitrationFee{value: primaryCost}(id);
            if (path == 1) {
                arb.giveRuling(_disputeId(id), 1);
            } else if (path == 2) {
                arb.giveRuling(_disputeId(id), 0);
            } else {
                vm.warp(block.timestamp + ARB_TIMEOUT + 1);
                vm.prank(seller);
                escrow.escalateToFallback{value: fallbackCost}(id);
                if (path == 3) {
                    arb2.giveRuling(_disputeId(id), 2);
                } else if (path == 4) {
                    vm.warp(block.timestamp + ARB_TIMEOUT + 1);
                    escrow.claimArbitrationTimeout(id);
                } else {
                    vm.prank(buyer);
                    escrow.buyerCancel(id);
                }
            }
        }

        if (escrow.claimableNative(buyer) > 0) {
            vm.prank(buyer);
            escrow.withdrawNative();
        }
        if (escrow.claimableNative(seller) > 0) {
            vm.prank(seller);
            escrow.withdrawNative();
        }

        // Every wei either returned to a party or paid an arbitrator; nothing stuck in the escrow.
        assertEq(address(escrow).balance, 0);
        assertEq(buyer.balance + seller.balance + address(arb).balance + address(arb2).balance, startTotal);
    }
}
