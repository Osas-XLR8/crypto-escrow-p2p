// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EscrowCoreV4} from "../../src/v4/EscrowCoreV4.sol";
import {LicensedArbitratorAdapter} from "../../src/v4/arbitration/LicensedArbitratorAdapter.sol";
import {V4TestBase} from "./V4TestBase.sol";

/// @notice Licensed arbitration firm adapter, exercised end-to-end as an escrow's primary arbitrator.
contract LicensedArbitratorAdapterTest is V4TestBase {
    LicensedArbitratorAdapter adapter;

    address firmAdmin = address(0xF1A);
    address treasury = address(0x7EA5);
    address panelist1 = vm.addr(0xA1);
    address panelist2 = vm.addr(0xA2);

    uint256 constant FIRM_FEE = 0.02 ether;
    uint64 constant REVIEW = 1 days;
    bytes constant KEY1 = hex"04aa01";
    bytes constant KEY2 = hex"04aa02";

    function setUp() public override {
        super.setUp();
        adapter = new LicensedArbitratorAdapter(firmAdmin, treasury, FIRM_FEE, REVIEW);
        escrow = _deploy(address(usdt), address(adapter)); // adapter primary, arb2 fallback

        vm.startPrank(seller);
        usdt.approve(address(escrow), type(uint256).max);
        escrow.deposit(address(usdt), 10_000 * U);
        vm.stopPrank();

        vm.startPrank(firmAdmin);
        adapter.setPanelist(panelist1, true, KEY1);
        adapter.setPanelist(panelist2, true, KEY2);
        vm.stopPrank();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _firmOffer() internal returns (EscrowCoreV4.Offer memory o) {
        o = _offer();
        o.arbitrator = address(adapter);
    }

    /// @dev Trade in DISPUTED state with the adapter; returns (tradeId, adapter dispute id).
    function _firmDispute(uint256 amount) internal returns (uint256 id, uint256 caseId) {
        id = _take(_firmOffer(), amount);
        vm.prank(buyer);
        escrow.markPaid(id, keccak256("receipt"));
        vm.prank(seller);
        escrow.openDispute{value: FIRM_FEE}(id);
        vm.prank(buyer);
        caseId = escrow.payArbitrationFee{value: FIRM_FEE}(id);
    }

    function _proposeAndWait(uint256 caseId, address panelist, uint256 ruling) internal {
        vm.prank(firmAdmin);
        adapter.assign(caseId, panelist);
        vm.prank(panelist);
        adapter.proposeRuling(caseId, ruling, keccak256("written decision"));
        vm.warp(block.timestamp + REVIEW);
    }

    // ─── Deployment & ERC-792 surface ─────────────────────────────────────────

    function testConstructorValidation() public {
        vm.expectRevert("zero address");
        new LicensedArbitratorAdapter(address(0), treasury, FIRM_FEE, REVIEW);
        vm.expectRevert("zero address");
        new LicensedArbitratorAdapter(firmAdmin, address(0), FIRM_FEE, REVIEW);
        vm.expectRevert("bad review period");
        new LicensedArbitratorAdapter(firmAdmin, treasury, FIRM_FEE, 30 minutes);
        vm.expectRevert("bad review period");
        new LicensedArbitratorAdapter(firmAdmin, treasury, FIRM_FEE, 8 days);
    }

    function testEscrowDisputeOpensCaseAndPaysFirmFee() public {
        (uint256 id, uint256 caseId) = _firmDispute(200 * U);

        assertEq(adapter.arbitrationCost(""), FIRM_FEE);
        assertEq(adapter.caseCount(), 1);
        assertEq(adapter.accruedFees(), FIRM_FEE);
        assertEq(address(adapter.getCase(caseId).arbitrable), address(escrow));
        assertEq(escrow.getTrade(id).activeArbitrator, address(adapter));
    }

    function testCreateDisputeValidation() public {
        vm.expectRevert("insufficient fee");
        adapter.createDispute{value: FIRM_FEE - 1}(2, "");
        vm.expectRevert("need at least two choices");
        adapter.createDispute{value: FIRM_FEE}(1, "");
    }

    // ─── Firm administration ──────────────────────────────────────────────────

    function testOnlyFirmAdminManagesFirm() public {
        (, uint256 caseId) = _firmDispute(100 * U);
        vm.startPrank(stranger);
        vm.expectRevert("only firm admin");
        adapter.setPanelist(stranger, true, KEY1);
        vm.expectRevert("only firm admin");
        adapter.assign(caseId, panelist1);
        vm.expectRevert("only firm admin");
        adapter.vetoProposal(caseId, 0);
        vm.expectRevert("only firm admin");
        adapter.setFee(0);
        vm.expectRevert("only firm admin");
        adapter.setTreasury(stranger);
        vm.expectRevert("only firm admin");
        adapter.transferFirmAdmin(stranger);
        vm.stopPrank();
    }

    function testPanelistsMustPublishEncryptionKey() public {
        vm.prank(firmAdmin);
        vm.expectRevert("encryption key required");
        adapter.setPanelist(stranger, true, "");
    }

    function testFeeChangeAppliesToNextDispute() public {
        vm.prank(firmAdmin);
        adapter.setFee(0.05 ether);
        uint256 id = _take(_firmOffer(), 100 * U);
        vm.prank(buyer);
        escrow.markPaid(id, 0);
        vm.prank(seller);
        vm.expectRevert("insufficient arbitration fee");
        escrow.openDispute{value: FIRM_FEE}(id);
    }

    function testTwoStepAdminTransfer() public {
        vm.prank(firmAdmin);
        adapter.transferFirmAdmin(stranger);
        assertEq(adapter.firmAdmin(), firmAdmin);

        vm.prank(buyer);
        vm.expectRevert("not pending admin");
        adapter.acceptFirmAdmin();

        vm.prank(stranger);
        adapter.acceptFirmAdmin();
        assertEq(adapter.firmAdmin(), stranger);
    }

    function testFeesOnlyEverGoToTreasury() public {
        _firmDispute(100 * U);
        vm.prank(stranger); // anyone can trigger
        adapter.withdrawFees();
        assertEq(treasury.balance, FIRM_FEE);
        assertEq(adapter.accruedFees(), 0);

        vm.expectRevert("nothing to withdraw");
        adapter.withdrawFees();
    }

    // ─── Case handling safeguards ─────────────────────────────────────────────

    function testAssignmentRequiresActivePanelistWithoutConflict() public {
        (, uint256 caseId) = _firmDispute(100 * U);

        vm.startPrank(firmAdmin);
        vm.expectRevert("not an active panelist");
        adapter.assign(caseId, stranger);

        // The firm (unknowingly) lists the trade's buyer and seller as panelists.
        adapter.setPanelist(buyer, true, KEY1);
        adapter.setPanelist(seller, true, KEY1);
        vm.expectRevert("conflict of interest");
        adapter.assign(caseId, buyer);
        vm.expectRevert("conflict of interest");
        adapter.assign(caseId, seller);

        adapter.assign(caseId, panelist1);
        vm.stopPrank();
        assertEq(adapter.getCase(caseId).assignee, panelist1);
    }

    function testOnlyAssignedActivePanelistProposesValidRuling() public {
        (, uint256 caseId) = _firmDispute(100 * U);
        vm.prank(firmAdmin);
        adapter.assign(caseId, panelist1);

        vm.prank(panelist2);
        vm.expectRevert("only assigned panelist");
        adapter.proposeRuling(caseId, 1, 0);

        vm.prank(panelist1);
        vm.expectRevert("invalid ruling");
        adapter.proposeRuling(caseId, 3, 0);

        vm.prank(firmAdmin);
        adapter.setPanelist(panelist1, false, KEY1);
        vm.prank(panelist1);
        vm.expectRevert("panelist deactivated");
        adapter.proposeRuling(caseId, 1, 0);
    }

    function testRulingExecutesAfterReviewAndSettlesEscrow() public {
        (uint256 id, uint256 caseId) = _firmDispute(300 * U);
        vm.prank(firmAdmin);
        adapter.assign(caseId, panelist1);
        vm.prank(panelist1);
        adapter.proposeRuling(caseId, 1, keccak256("decision"));

        vm.warp(block.timestamp + REVIEW - 1);
        vm.expectRevert("review period active");
        adapter.executeRuling(caseId);

        vm.warp(block.timestamp + 1);
        vm.prank(stranger); // permissionless once final
        adapter.executeRuling(caseId);

        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.RELEASED));
        assertEq(usdt.balanceOf(buyer), 300 * U);
        assertEq(escrow.claimableNative(buyer), FIRM_FEE); // loser (seller) paid the firm
        assertEq(escrow.claimableNative(seller), 0);

        vm.expectRevert("case closed");
        adapter.executeRuling(caseId);
    }

    /// @dev The review period is the firm's window to veto its panelist; the firm confirming in person is
    ///      that review happening early, so it may execute straight away.
    function testFirmConfirmsItsPanelistsRulingWithoutWaiting() public {
        (uint256 id, uint256 caseId) = _firmDispute(300 * U);
        vm.prank(firmAdmin);
        adapter.assign(caseId, panelist1);
        vm.prank(panelist1);
        adapter.proposeRuling(caseId, 1, keccak256("decision"));

        vm.prank(stranger);
        vm.expectRevert("review period active");
        adapter.executeRuling(caseId);

        vm.prank(firmAdmin);
        adapter.executeRuling(caseId);

        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.RELEASED));
        assertEq(usdt.balanceOf(buyer), 300 * U);
    }

    /// @dev …but a panelist holding the admin key is one person, not two, so they wait like everyone else.
    function testFirmAdminActingAsItsOwnPanelistStillWaits() public {
        vm.prank(firmAdmin);
        adapter.setPanelist(firmAdmin, true, KEY1);

        (, uint256 caseId) = _firmDispute(300 * U);
        vm.startPrank(firmAdmin);
        adapter.assign(caseId, firmAdmin);
        adapter.proposeRuling(caseId, 1, keccak256("decision"));

        vm.expectRevert("review period active");
        adapter.executeRuling(caseId);

        vm.warp(block.timestamp + REVIEW);
        adapter.executeRuling(caseId);
        vm.stopPrank();
    }

    function testFirmVetoThenReassignedPanelistDecides() public {
        (uint256 id, uint256 caseId) = _firmDispute(300 * U);
        vm.prank(firmAdmin);
        adapter.assign(caseId, panelist1);
        vm.prank(panelist1);
        adapter.proposeRuling(caseId, 2, keccak256("questionable"));

        vm.prank(firmAdmin);
        adapter.vetoProposal(caseId, keccak256("reasoning did not address bank statement"));
        vm.warp(block.timestamp + REVIEW);
        vm.expectRevert("no proposal");
        adapter.executeRuling(caseId);

        _proposeAndWait(caseId, panelist2, 1);
        adapter.executeRuling(caseId);
        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.RELEASED));
    }

    function testVetoOnlyDuringReviewPeriod() public {
        (, uint256 caseId) = _firmDispute(100 * U);
        _proposeAndWait(caseId, panelist1, 2);
        vm.prank(firmAdmin);
        vm.expectRevert("review period over");
        adapter.vetoProposal(caseId, 0);
    }

    function testReassignmentClearsPendingProposal() public {
        (, uint256 caseId) = _firmDispute(100 * U);
        vm.prank(firmAdmin);
        adapter.assign(caseId, panelist1);
        vm.prank(panelist1);
        adapter.proposeRuling(caseId, 1, 0);

        vm.prank(firmAdmin);
        adapter.assign(caseId, panelist2);
        vm.warp(block.timestamp + REVIEW);
        vm.expectRevert("no proposal");
        adapter.executeRuling(caseId);
    }

    function testUnknownCase() public {
        vm.expectRevert("unknown case");
        adapter.executeRuling(42);
    }

    // ─── The firm can never trap funds ────────────────────────────────────────

    function testStallingFirmIsBypassedByFallbackAndLateRulingIgnored() public {
        (uint256 id, uint256 caseId) = _firmDispute(500 * U);

        // Firm never rules. After ARBITRATION_TIMEOUT the buyer escalates to the fallback arbitrator.
        vm.warp(block.timestamp + ARB_TIMEOUT + 1);
        uint256 fallbackCost = arb2.cost();
        vm.prank(buyer);
        escrow.escalateToFallback{value: fallbackCost}(id);
        arb2.giveRuling(_disputeId(id), 1);
        assertEq(usdt.balanceOf(buyer), 500 * U);

        // The firm finally rules the other way: executes fine on the adapter, changes nothing in escrow.
        _proposeAndWait(caseId, panelist1, 2);
        adapter.executeRuling(caseId);
        assertTrue(adapter.getCase(caseId).executed);
        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.RELEASED));
        assertEq(usdt.balanceOf(buyer), 500 * U);
    }

    function testFirmAdminHasNoPowerOverEscrow() public {
        (uint256 id,) = _firmDispute(100 * U);
        vm.startPrank(firmAdmin);
        vm.expectRevert("only seller");
        escrow.release(id);
        vm.expectRevert("only buyer");
        escrow.buyerCancel(id);
        vm.expectRevert("unknown dispute"); // firm admin is not the adapter contract
        escrow.rule(1, 1);
        vm.stopPrank();
    }
}
