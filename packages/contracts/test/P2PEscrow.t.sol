// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {P2PEscrow} from "../src/P2PEscrow.sol";
import {P2PEscrowTestable} from "../src/P2PEscrowTestable.sol";
import {MockUSDT} from "../src/MockUSDT.sol";

// ─── USDT-style token: transfer/transferFrom return NOTHING ───────────────────

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
        require(balanceOf[msg.sender] >= amt, "bal");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
    }

    function transferFrom(address from, address to, uint256 amt) external {
        require(balanceOf[from] >= amt, "bal");
        require(allowance[from][msg.sender] >= amt, "allow");
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
    }
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

contract P2PEscrowTest is Test {
    P2PEscrowTestable escrow;
    MockUSDT usdt;

    uint256 signerPk = 11;
    address signer = vm.addr(signerPk);
    address owner = vm.addr(1);
    address operator = vm.addr(44);
    address seller = vm.addr(22);
    address buyer = vm.addr(33);
    address stranger = vm.addr(55);

    bytes32 tradeId = keccak256("trade-1");

    uint256 constant AMOUNT = 100_000000; // 100 USDT (6 decimals)
    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        usdt = new MockUSDT("Tether USD", "USDT", 6);
        escrow = new P2PEscrowTestable(owner, signer, operator, address(usdt));
        usdt.mint(seller, 1000_000000);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _createTrade() internal {
        vm.prank(operator);
        escrow.createTrade(tradeId, seller, buyer, AMOUNT, uint64(block.timestamp) + 60, uint64(block.timestamp) + 300);
    }

    function _createAndDeposit() internal {
        _createTrade();
        vm.startPrank(seller);
        usdt.approve(address(escrow), AMOUNT);
        escrow.deposit(tradeId);
        vm.stopPrank();
    }

    function _createDepositDispute() internal {
        _createAndDeposit();
        vm.prank(buyer);
        escrow.openDispute(tradeId);
    }

    // EIP-712: digest already has \x19\x01 prefix baked in — sign it raw.
    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _auth(bytes32 digest) internal view returns (bytes memory) {
        return _sign(signerPk, digest);
    }

    function _state() internal view returns (P2PEscrow.State st) {
        (,,,,, st) = escrow.trades(tradeId);
    }

    // ── Deployment & roles ────────────────────────────────────────────────────

    function testConstructorSetsRoles() public view {
        assertEq(escrow.owner(), owner);
        assertEq(escrow.backendSigner(), signer);
        assertEq(escrow.operator(), operator);
        assertFalse(escrow.paused());
    }

    function testConstructorRejectsZeroRoles() public {
        vm.expectRevert("owner required");
        new P2PEscrowTestable(address(0), signer, operator, address(usdt));
        vm.expectRevert("backend signer required");
        new P2PEscrowTestable(owner, address(0), operator, address(usdt));
        vm.expectRevert("operator required");
        new P2PEscrowTestable(owner, signer, address(0), address(usdt));
        vm.expectRevert("test token required");
        new P2PEscrowTestable(owner, signer, operator, address(0));
    }

    function testAdminFunctionsOwnerOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert("only owner");
        escrow.setBackendSigner(stranger);
        vm.expectRevert("only owner");
        escrow.setOperator(stranger);
        vm.expectRevert("only owner");
        escrow.pause();
        vm.expectRevert("only owner");
        escrow.unpause();
        vm.expectRevert("only owner");
        escrow.transferOwnership(stranger);
        vm.stopPrank();
    }

    function testSettersRejectZeroAddress() public {
        vm.startPrank(owner);
        vm.expectRevert("zero address");
        escrow.setBackendSigner(address(0));
        vm.expectRevert("zero address");
        escrow.setOperator(address(0));
        vm.stopPrank();
    }

    function testTwoStepOwnershipTransfer() public {
        vm.prank(owner);
        escrow.transferOwnership(stranger);
        assertEq(escrow.owner(), owner); // not yet transferred
        assertEq(escrow.pendingOwner(), stranger);

        vm.prank(buyer);
        vm.expectRevert("not pending owner");
        escrow.acceptOwnership();

        vm.prank(stranger);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), stranger);
        assertEq(escrow.pendingOwner(), address(0));

        vm.prank(owner);
        vm.expectRevert("only owner");
        escrow.pause();
    }

    function testRotatedSignerInvalidatesOldSignatures() public {
        _createAndDeposit();
        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("rot");
        bytes memory oldSig = _auth(escrow.releaseDigest(tradeId, exp, nonce));

        uint256 newPk = 77;
        vm.prank(owner);
        escrow.setBackendSigner(vm.addr(newPk));

        vm.expectRevert("invalid backend signature");
        escrow.release(tradeId, exp, nonce, oldSig);

        escrow.release(tradeId, exp, nonce, _sign(newPk, escrow.releaseDigest(tradeId, exp, nonce)));
        assertEq(uint256(_state()), uint256(P2PEscrow.State.RELEASED));
    }

    function testRotatedOperator() public {
        vm.prank(owner);
        escrow.setOperator(stranger);

        uint64 lockDl = uint64(block.timestamp) + 60;
        uint64 fiatDl = uint64(block.timestamp) + 300;

        vm.prank(operator);
        vm.expectRevert("only operator");
        escrow.createTrade(tradeId, seller, buyer, AMOUNT, lockDl, fiatDl);

        vm.prank(stranger);
        escrow.createTrade(tradeId, seller, buyer, AMOUNT, lockDl, fiatDl);
    }

    // ── Create ────────────────────────────────────────────────────────────────

    function testCreateTradeOperatorOnly() public {
        uint64 lockDl = uint64(block.timestamp) + 60;
        uint64 fiatDl = uint64(block.timestamp) + 300;

        // Neither the signer key nor the owner may create trades — only the operator.
        vm.prank(signer);
        vm.expectRevert("only operator");
        escrow.createTrade(tradeId, seller, buyer, AMOUNT, lockDl, fiatDl);

        vm.prank(owner);
        vm.expectRevert("only operator");
        escrow.createTrade(tradeId, seller, buyer, AMOUNT, lockDl, fiatDl);

        vm.prank(operator);
        escrow.createTrade(tradeId, seller, buyer, AMOUNT, lockDl, fiatDl);

        (address s, address b, uint256 amt,,, P2PEscrow.State st) = escrow.trades(tradeId);
        assertEq(s, seller);
        assertEq(b, buyer);
        assertEq(amt, AMOUNT);
        assertEq(uint256(st), uint256(P2PEscrow.State.CREATED));
    }

    function testCreateTradeValidation() public {
        uint64 lockDl = uint64(block.timestamp) + 60;
        uint64 fiatDl = uint64(block.timestamp) + 300;

        vm.startPrank(operator);
        vm.expectRevert("seller == buyer");
        escrow.createTrade(tradeId, seller, seller, AMOUNT, lockDl, fiatDl);

        vm.expectRevert("zero address");
        escrow.createTrade(tradeId, address(0), buyer, AMOUNT, lockDl, fiatDl);

        vm.expectRevert("bad amount");
        escrow.createTrade(tradeId, seller, buyer, 0, lockDl, fiatDl);

        vm.expectRevert("lockDeadline in past");
        escrow.createTrade(tradeId, seller, buyer, AMOUNT, uint64(block.timestamp), fiatDl);

        vm.expectRevert("bad deadlines");
        escrow.createTrade(tradeId, seller, buyer, AMOUNT, lockDl, lockDl);

        escrow.createTrade(tradeId, seller, buyer, AMOUNT, lockDl, fiatDl);
        vm.expectRevert("trade exists");
        escrow.createTrade(tradeId, seller, buyer, AMOUNT, lockDl, fiatDl);
        vm.stopPrank();
    }

    function testProductionAmountCap() public {
        P2PEscrow prod = new P2PEscrow(owner, signer, operator);
        uint256 cap = prod.MAX_AMOUNT();
        vm.prank(operator);
        vm.expectRevert("bad amount");
        prod.createTrade(tradeId, seller, buyer, cap + 1, uint64(block.timestamp) + 60, uint64(block.timestamp) + 300);
    }

    // ── Deposit ───────────────────────────────────────────────────────────────

    function testDepositLocksFunds() public {
        _createTrade();
        uint256 sellerBefore = usdt.balanceOf(seller);

        vm.startPrank(seller);
        usdt.approve(address(escrow), AMOUNT);
        escrow.deposit(tradeId);
        vm.stopPrank();

        assertEq(usdt.balanceOf(address(escrow)), AMOUNT);
        assertEq(usdt.balanceOf(seller), sellerBefore - AMOUNT);
        assertEq(uint256(_state()), uint256(P2PEscrow.State.LOCKED));
    }

    function testOnlySellerCanDeposit() public {
        _createTrade();
        vm.prank(buyer);
        vm.expectRevert("only seller");
        escrow.deposit(tradeId);
    }

    function testDepositFailsAfterLockDeadline() public {
        _createTrade();
        vm.warp(block.timestamp + 61);
        vm.startPrank(seller);
        usdt.approve(address(escrow), AMOUNT);
        vm.expectRevert("lock deadline passed");
        escrow.deposit(tradeId);
        vm.stopPrank();
    }

    function testDepositRevertsWhenTokenHasNoCode() public {
        P2PEscrowTestable bad = new P2PEscrowTestable(owner, signer, operator, address(0xdead));
        vm.prank(operator);
        bad.createTrade(tradeId, seller, buyer, AMOUNT, uint64(block.timestamp) + 60, uint64(block.timestamp) + 300);
        vm.prank(seller);
        vm.expectRevert("token has no code");
        bad.deposit(tradeId);
    }

    // ── Pause ─────────────────────────────────────────────────────────────────

    function testPauseBlocksCreateAndDeposit() public {
        _createTrade();
        vm.prank(owner);
        escrow.pause();

        vm.prank(operator);
        vm.expectRevert("paused");
        escrow.createTrade(
            keccak256("trade-2"), seller, buyer, AMOUNT, uint64(block.timestamp) + 60, uint64(block.timestamp) + 300
        );

        vm.startPrank(seller);
        usdt.approve(address(escrow), AMOUNT);
        vm.expectRevert("paused");
        escrow.deposit(tradeId);
        vm.stopPrank();

        vm.prank(owner);
        escrow.unpause();
        vm.prank(seller);
        escrow.deposit(tradeId);
        assertEq(uint256(_state()), uint256(P2PEscrow.State.LOCKED));
    }

    function testPauseNeverBlocksExits() public {
        // release
        _createAndDeposit();
        vm.prank(owner);
        escrow.pause();
        uint64 exp = uint64(block.timestamp) + 120;
        escrow.release(tradeId, exp, bytes32("n"), _auth(escrow.releaseDigest(tradeId, exp, bytes32("n"))));
        assertEq(uint256(_state()), uint256(P2PEscrow.State.RELEASED));

        // refund
        vm.prank(owner);
        escrow.unpause();
        tradeId = keccak256("trade-2");
        _createAndDeposit();
        vm.prank(owner);
        escrow.pause();
        vm.warp(block.timestamp + 301);
        escrow.refund(tradeId);
        assertEq(uint256(_state()), uint256(P2PEscrow.State.REFUNDED));

        // dispute resolution + timeout claim
        vm.prank(owner);
        escrow.unpause();
        tradeId = keccak256("trade-3");
        _createDepositDispute();
        vm.prank(owner);
        escrow.pause();
        vm.warp(block.timestamp + escrow.DISPUTE_TIMEOUT() + 1);
        escrow.claimDisputeTimeout(tradeId);
        assertEq(uint256(_state()), uint256(P2PEscrow.State.REFUNDED));
    }

    // ── Release ───────────────────────────────────────────────────────────────

    function testReleaseWithValidSig() public {
        _createAndDeposit();

        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nonce-1");
        bytes memory sig = _auth(escrow.releaseDigest(tradeId, exp, nonce));

        uint256 buyerBefore = usdt.balanceOf(buyer);
        vm.prank(stranger); // anyone may submit a valid authorization
        escrow.release(tradeId, exp, nonce, sig);

        assertEq(usdt.balanceOf(buyer), buyerBefore + AMOUNT);
        assertEq(usdt.balanceOf(address(escrow)), 0);
        assertEq(uint256(_state()), uint256(P2PEscrow.State.RELEASED));
    }

    function testReleaseRevertsWithWrongSig() public {
        _createAndDeposit();
        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nonce-bad");
        bytes memory sig = _sign(99, escrow.releaseDigest(tradeId, exp, nonce));

        vm.expectRevert("invalid backend signature");
        escrow.release(tradeId, exp, nonce, sig);
    }

    function testOperatorKeyAloneCannotAuthorize() public {
        _createAndDeposit();
        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("op");
        // operator's pk is 44 — its signature must not be accepted
        bytes memory sig = _sign(44, escrow.releaseDigest(tradeId, exp, nonce));

        vm.prank(operator);
        vm.expectRevert("invalid backend signature");
        escrow.release(tradeId, exp, nonce, sig);
    }

    function testReleaseRevertsWhenExpired() public {
        _createAndDeposit();
        uint64 exp = uint64(block.timestamp) + 10;
        bytes32 nonce = keccak256("nonce-exp");
        bytes memory sig = _auth(escrow.releaseDigest(tradeId, exp, nonce));

        vm.warp(block.timestamp + 20);
        vm.expectRevert("authorization expired");
        escrow.release(tradeId, exp, nonce, sig);
    }

    function testDoubleReleasePrevented() public {
        _createAndDeposit();
        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nonce-double");
        bytes memory sig = _auth(escrow.releaseDigest(tradeId, exp, nonce));

        escrow.release(tradeId, exp, nonce, sig);

        vm.expectRevert("not locked");
        escrow.release(tradeId, exp, nonce, sig);
    }

    function testMalleableSignatureRejected() public {
        _createAndDeposit();
        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("malleable");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, escrow.releaseDigest(tradeId, exp, nonce));

        // Flip to the high-s twin — same signer, different bytes.
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        vm.expectRevert("malleable signature");
        escrow.release(tradeId, exp, nonce, abi.encodePacked(r, highS, flippedV));
    }

    function testBadSignatureLengthRejected() public {
        _createAndDeposit();
        vm.expectRevert("bad sig length");
        escrow.release(tradeId, uint64(block.timestamp) + 120, bytes32("n"), hex"1234");
    }

    // ── Signature domain separation ───────────────────────────────────────────

    function testAllThreeDigestsDiffer() public {
        _createAndDeposit();
        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("x");
        bytes32 a = escrow.releaseDigest(tradeId, exp, nonce);
        bytes32 b = escrow.resolveReleaseDigest(tradeId, exp, nonce);
        bytes32 c = escrow.refundDigest(tradeId, exp, nonce);
        assertTrue(a != b && b != c && a != c);
    }

    function testResolveReleaseSigCannotBeUsedForRelease() public {
        _createAndDeposit();
        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("cross-1");
        bytes memory sig = _auth(escrow.resolveReleaseDigest(tradeId, exp, nonce));

        vm.expectRevert("invalid backend signature");
        escrow.release(tradeId, exp, nonce, sig);
    }

    function testReleaseSigCannotBeUsedForResolveRelease() public {
        _createDepositDispute();
        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("cross-2");
        bytes memory sig = _auth(escrow.releaseDigest(tradeId, exp, nonce));

        vm.prank(operator);
        vm.expectRevert("invalid backend signature");
        escrow.resolveDisputeRelease(tradeId, exp, nonce, sig);
    }

    function testReleaseSigCannotBeUsedForRefund() public {
        _createDepositDispute();
        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("cross-3");
        bytes memory sig = _auth(escrow.resolveReleaseDigest(tradeId, exp, nonce));

        vm.prank(operator);
        vm.expectRevert("invalid backend signature");
        escrow.resolveDisputeRefund(tradeId, exp, nonce, sig);
    }

    function testSignatureBoundToContractAddress() public {
        // A second escrow with identical roles must reject signatures made for the first.
        P2PEscrowTestable other = new P2PEscrowTestable(owner, signer, operator, address(usdt));
        _createAndDeposit();

        vm.prank(operator);
        other.createTrade(tradeId, seller, buyer, AMOUNT, uint64(block.timestamp) + 60, uint64(block.timestamp) + 300);
        vm.startPrank(seller);
        usdt.approve(address(other), AMOUNT);
        other.deposit(tradeId);
        vm.stopPrank();

        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("domain");
        bytes memory sig = _auth(escrow.releaseDigest(tradeId, exp, nonce));

        vm.expectRevert("invalid backend signature");
        other.release(tradeId, exp, nonce, sig);
    }

    // ── Refund ────────────────────────────────────────────────────────────────

    function testRefundAfterFiatDeadline() public {
        _createAndDeposit();
        (,,,, uint64 fiatDl,) = escrow.trades(tradeId);
        vm.warp(fiatDl + 1);

        uint256 sellerBefore = usdt.balanceOf(seller);
        escrow.refund(tradeId);

        assertEq(usdt.balanceOf(seller), sellerBefore + AMOUNT);
        assertEq(usdt.balanceOf(address(escrow)), 0);
        assertEq(uint256(_state()), uint256(P2PEscrow.State.REFUNDED));
    }

    function testRefundTooEarlyReverts() public {
        _createAndDeposit();
        vm.expectRevert("too early");
        escrow.refund(tradeId);
    }

    function testRefundUndepositedTradeAfterLockDeadline() public {
        _createTrade();
        vm.expectRevert("too early");
        escrow.refund(tradeId);

        vm.warp(block.timestamp + 61);
        escrow.refund(tradeId);
        assertEq(uint256(_state()), uint256(P2PEscrow.State.REFUNDED));
        assertEq(usdt.balanceOf(address(escrow)), 0);
    }

    // ── Dispute ───────────────────────────────────────────────────────────────

    function testSellerCannotOpenDispute() public {
        _createAndDeposit();
        vm.prank(seller);
        vm.expectRevert("not allowed");
        escrow.openDispute(tradeId);
    }

    function testBuyerCanOpenDisputeWithinWindow() public {
        _createAndDeposit();
        vm.warp(block.timestamp + 100);
        vm.prank(buyer);
        escrow.openDispute(tradeId);

        assertEq(uint256(_state()), uint256(P2PEscrow.State.DISPUTE));
        assertEq(escrow.disputeOpenedAt(tradeId), uint64(block.timestamp));
    }

    function testBuyerCannotDisputeAfterFiatDeadline() public {
        _createAndDeposit();
        (,,,, uint64 fiatDl,) = escrow.trades(tradeId);
        vm.warp(fiatDl + 1);

        vm.prank(buyer);
        vm.expectRevert("dispute window closed");
        escrow.openDispute(tradeId);

        // ...so the seller's refund can no longer be blocked.
        escrow.refund(tradeId);
        assertEq(uint256(_state()), uint256(P2PEscrow.State.REFUNDED));
    }

    function testOperatorCanDisputeAfterFiatDeadline() public {
        _createAndDeposit();
        (,,,, uint64 fiatDl,) = escrow.trades(tradeId);
        vm.warp(fiatDl + 1);

        vm.prank(operator);
        escrow.openDispute(tradeId);
        assertEq(uint256(_state()), uint256(P2PEscrow.State.DISPUTE));
    }

    function testDisputeRequiresLocked() public {
        _createTrade();
        vm.prank(buyer);
        vm.expectRevert("cannot dispute");
        escrow.openDispute(tradeId);
    }

    function testDisputeBlocksRefund() public {
        _createDepositDispute();
        (,,,, uint64 fiatDl,) = escrow.trades(tradeId);
        vm.warp(fiatDl + 1);

        vm.expectRevert("in dispute");
        escrow.refund(tradeId);
    }

    // ── Dispute resolution ────────────────────────────────────────────────────

    function testResolveDisputeReleaseToBuyer() public {
        _createDepositDispute();
        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nonce-resolve");
        bytes memory sig = _auth(escrow.resolveReleaseDigest(tradeId, exp, nonce));

        uint256 buyerBefore = usdt.balanceOf(buyer);
        vm.prank(operator);
        escrow.resolveDisputeRelease(tradeId, exp, nonce, sig);

        assertEq(usdt.balanceOf(buyer), buyerBefore + AMOUNT);
        assertEq(usdt.balanceOf(address(escrow)), 0);
        assertEq(uint256(_state()), uint256(P2PEscrow.State.RELEASED));
    }

    function testResolveDisputeRefundToSeller() public {
        _createDepositDispute();
        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nonce-refund");
        bytes memory sig = _auth(escrow.refundDigest(tradeId, exp, nonce));

        uint256 sellerBefore = usdt.balanceOf(seller);
        vm.prank(operator);
        escrow.resolveDisputeRefund(tradeId, exp, nonce, sig);

        assertEq(usdt.balanceOf(seller), sellerBefore + AMOUNT);
        assertEq(usdt.balanceOf(address(escrow)), 0);
        assertEq(uint256(_state()), uint256(P2PEscrow.State.REFUNDED));
    }

    function testOnlyOperatorCanResolveDispute() public {
        _createDepositDispute();
        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nonce-x");
        bytes memory relSig = _auth(escrow.resolveReleaseDigest(tradeId, exp, nonce));
        bytes memory refSig = _auth(escrow.refundDigest(tradeId, exp, nonce));

        // Even the signer key itself cannot submit — both keys are required.
        vm.startPrank(signer);
        vm.expectRevert("only operator");
        escrow.resolveDisputeRelease(tradeId, exp, nonce, relSig);
        vm.expectRevert("only operator");
        escrow.resolveDisputeRefund(tradeId, exp, nonce, refSig);
        vm.stopPrank();
    }

    function testResolveRequiresDispute() public {
        _createAndDeposit();
        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nd");
        bytes memory sig = _auth(escrow.resolveReleaseDigest(tradeId, exp, nonce));

        vm.prank(operator);
        vm.expectRevert("not in dispute");
        escrow.resolveDisputeRelease(tradeId, exp, nonce, sig);
    }

    // ── Dispute timeout ───────────────────────────────────────────────────────

    function testClaimDisputeTimeoutTooEarly() public {
        _createDepositDispute();
        vm.warp(block.timestamp + escrow.DISPUTE_TIMEOUT());
        vm.expectRevert("dispute not timed out");
        escrow.claimDisputeTimeout(tradeId);
    }

    function testClaimDisputeTimeoutRefundsSeller() public {
        _createDepositDispute();
        vm.warp(block.timestamp + escrow.DISPUTE_TIMEOUT() + 1);

        uint256 sellerBefore = usdt.balanceOf(seller);
        vm.prank(stranger); // permissionless
        escrow.claimDisputeTimeout(tradeId);

        assertEq(usdt.balanceOf(seller), sellerBefore + AMOUNT);
        assertEq(usdt.balanceOf(address(escrow)), 0);
        assertEq(uint256(_state()), uint256(P2PEscrow.State.REFUNDED));
    }

    function testClaimDisputeTimeoutRequiresDispute() public {
        _createAndDeposit();
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert("not in dispute");
        escrow.claimDisputeTimeout(tradeId);
    }

    function testResolveAfterTimeoutClaimFails() public {
        _createDepositDispute();
        uint64 openedAt = uint64(block.timestamp);
        uint64 exp = openedAt + escrow.DISPUTE_TIMEOUT() + 1000;
        bytes32 nonce = keccak256("late");
        bytes memory sig = _auth(escrow.resolveReleaseDigest(tradeId, exp, nonce));

        vm.warp(openedAt + escrow.DISPUTE_TIMEOUT() + 1);
        escrow.claimDisputeTimeout(tradeId);

        vm.prank(operator);
        vm.expectRevert("not in dispute");
        escrow.resolveDisputeRelease(tradeId, exp, nonce, sig);
    }

    // ── Non-standard tokens ───────────────────────────────────────────────────

    function testWorksWithNonReturningToken() public {
        NoReturnToken nrt = new NoReturnToken();
        P2PEscrowTestable e = new P2PEscrowTestable(owner, signer, operator, address(nrt));
        nrt.mint(seller, AMOUNT);

        vm.prank(operator);
        e.createTrade(tradeId, seller, buyer, AMOUNT, uint64(block.timestamp) + 60, uint64(block.timestamp) + 300);
        vm.startPrank(seller);
        nrt.approve(address(e), AMOUNT);
        e.deposit(tradeId);
        vm.stopPrank();
        assertEq(nrt.balanceOf(address(e)), AMOUNT);

        uint64 exp = uint64(block.timestamp) + 120;
        e.release(tradeId, exp, bytes32("n"), _auth(e.releaseDigest(tradeId, exp, bytes32("n"))));
        assertEq(nrt.balanceOf(buyer), AMOUNT);
    }

    function testDepositRevertsWithoutApproval() public {
        _createTrade();
        // seller never approved
        vm.prank(seller);
        vm.expectRevert("safeTransferFrom failed");
        escrow.deposit(tradeId);
    }

    // ── Fuzz: funds are always conserved and land with exactly one party ──────

    function testFuzzSettlementConservesFunds(uint256 amount, uint8 path) public {
        amount = bound(amount, 1, 1e30);
        path = uint8(bound(path, 0, 4));
        usdt.mint(seller, amount);

        uint256 total = usdt.totalSupply();
        uint256 sellerStart = usdt.balanceOf(seller);

        vm.prank(operator);
        escrow.createTrade(tradeId, seller, buyer, amount, uint64(block.timestamp) + 60, uint64(block.timestamp) + 300);
        vm.startPrank(seller);
        usdt.approve(address(escrow), amount);
        escrow.deposit(tradeId);
        vm.stopPrank();

        uint64 exp = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("fuzz");
        bool buyerPaid;

        if (path == 0) {
            escrow.release(tradeId, exp, nonce, _auth(escrow.releaseDigest(tradeId, exp, nonce)));
            buyerPaid = true;
        } else if (path == 1) {
            vm.warp(block.timestamp + 301);
            escrow.refund(tradeId);
        } else {
            vm.prank(buyer);
            escrow.openDispute(tradeId);
            if (path == 2) {
                bytes memory relSig = _auth(escrow.resolveReleaseDigest(tradeId, exp, nonce));
                vm.prank(operator); // prank must immediately precede the target call
                escrow.resolveDisputeRelease(tradeId, exp, nonce, relSig);
                buyerPaid = true;
            } else if (path == 3) {
                bytes memory refSig = _auth(escrow.refundDigest(tradeId, exp, nonce));
                vm.prank(operator);
                escrow.resolveDisputeRefund(tradeId, exp, nonce, refSig);
            } else {
                vm.warp(block.timestamp + escrow.DISPUTE_TIMEOUT() + 1);
                escrow.claimDisputeTimeout(tradeId);
            }
        }

        assertEq(usdt.balanceOf(address(escrow)), 0);
        assertEq(usdt.totalSupply(), total);
        if (buyerPaid) {
            assertEq(usdt.balanceOf(buyer), amount);
            assertEq(usdt.balanceOf(seller), sellerStart - amount);
        } else {
            assertEq(usdt.balanceOf(buyer), 0);
            assertEq(usdt.balanceOf(seller), sellerStart);
        }
    }
}
