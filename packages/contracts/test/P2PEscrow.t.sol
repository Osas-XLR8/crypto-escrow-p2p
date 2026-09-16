// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {P2PEscrow} from "../src/P2PEscrow.sol";

// ─── Testable escrow ──────────────────────────────────────────────────────────

contract P2PEscrowTestable is P2PEscrow {
    address public immutable TEST_TOKEN;

    constructor(address _backendSigner, address token) P2PEscrow(_backendSigner) {
        TEST_TOKEN = token;
    }

    function _token() internal view override returns (address) {
        return TEST_TOKEN;
    }

    function _maxAmount() internal pure override returns (uint256) {
        return type(uint256).max;
    }

    // Reads from the inherited `trades` mapping directly — no override needed.
    function exposedReleaseDigest(bytes32 tid, uint64 expiresAt, bytes32 nonce) external view returns (bytes32) {
        Trade storage t = trades[tid];
        return _releaseDigest(tid, t.buyer, t.amount, expiresAt, nonce);
    }

    function exposedRefundDigest(bytes32 tid, uint64 expiresAt, bytes32 nonce) external view returns (bytes32) {
        Trade storage t = trades[tid];
        return _refundDigest(tid, t.seller, t.amount, expiresAt, nonce);
    }
}

// ─── Mock ERC20 ──────────────────────────────────────────────────────────────

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
        emit Transfer(address(0), to, amt);
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        emit Approval(msg.sender, spender, amt);
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "bal");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        emit Transfer(msg.sender, to, amt);
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(balanceOf[from] >= amt, "bal");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amt, "allow");
        allowance[from][msg.sender] = allowed - amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        emit Transfer(from, to, amt);
        return true;
    }
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

contract P2PEscrowTest is Test {
    P2PEscrowTestable escrow;
    MockERC20 usdt;

    uint256 backendPk = 11;
    address backend = vm.addr(backendPk);
    address seller = vm.addr(22);
    address buyer = vm.addr(33);

    bytes32 tradeId = keccak256("trade-1");

    uint256 constant AMOUNT = 100_000000; // 100 USDT (6 decimals)

    // ── Setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        usdt = new MockERC20("USDT", "USDT", 6);
        escrow = new P2PEscrowTestable(backend, address(usdt));
        usdt.mint(seller, 1000_000000);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _createTrade() internal {
        uint64 lockDl = uint64(block.timestamp) + 60;
        uint64 fiatDl = uint64(block.timestamp) + 300;
        vm.prank(backend);
        escrow.createTrade(tradeId, seller, buyer, AMOUNT, lockDl, fiatDl);
    }

    function _createAndDeposit() internal {
        _createTrade();
        vm.prank(seller);
        usdt.approve(address(escrow), AMOUNT);
        vm.prank(seller);
        escrow.deposit(tradeId);
    }

    // v2 EIP-712: digest already has \x19\x01 prefix baked in.
    // Sign the raw digest directly — no extra \x19Ethereum wrapping.
    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _backendSign(bytes32 digest) internal view returns (bytes memory) {
        return _sign(backendPk, digest);
    }

    // ── Create ────────────────────────────────────────────────────────────────

    function testCreateTradeBackendOnly() public {
        uint64 lockDl = uint64(block.timestamp) + 60;
        uint64 fiatDl = uint64(block.timestamp) + 300;

        vm.prank(seller);
        vm.expectRevert("only backend");
        escrow.createTrade(tradeId, seller, buyer, AMOUNT, lockDl, fiatDl);

        vm.prank(backend);
        escrow.createTrade(tradeId, seller, buyer, AMOUNT, lockDl, fiatDl);

        (address s, address b, uint256 amt,,, P2PEscrow.State st) = escrow.trades(tradeId);
        assertEq(s, seller);
        assertEq(b, buyer);
        assertEq(amt, AMOUNT);
        assertEq(uint256(st), uint256(P2PEscrow.State.CREATED));
    }

    function testCannotCreateSellerEqualsBuyer() public {
        uint64 lockDl = uint64(block.timestamp) + 60;
        uint64 fiatDl = uint64(block.timestamp) + 300;
        vm.prank(backend);
        vm.expectRevert("seller == buyer");
        escrow.createTrade(tradeId, seller, seller, AMOUNT, lockDl, fiatDl);
    }

    function testCannotCreateWithPastLockDeadline() public {
        uint64 lockDl = uint64(block.timestamp) - 1;
        uint64 fiatDl = uint64(block.timestamp) + 300;
        vm.prank(backend);
        vm.expectRevert("lockDeadline in past");
        escrow.createTrade(tradeId, seller, buyer, AMOUNT, lockDl, fiatDl);
    }

    // ── Deposit ───────────────────────────────────────────────────────────────

    function testDepositLocksFunds() public {
        _createTrade();
        vm.prank(seller);
        usdt.approve(address(escrow), AMOUNT);

        uint256 sellerBefore = usdt.balanceOf(seller);
        vm.prank(seller);
        escrow.deposit(tradeId);

        assertEq(usdt.balanceOf(address(escrow)), AMOUNT);
        assertEq(usdt.balanceOf(seller), sellerBefore - AMOUNT);

        (,,,,, P2PEscrow.State st) = escrow.trades(tradeId);
        assertEq(uint256(st), uint256(P2PEscrow.State.LOCKED));
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
        vm.prank(seller);
        usdt.approve(address(escrow), AMOUNT);
        vm.prank(seller);
        vm.expectRevert("lock deadline passed");
        escrow.deposit(tradeId);
    }

    // ── Release ───────────────────────────────────────────────────────────────

    function testReleaseWithValidSig() public {
        _createAndDeposit();

        uint64 expiresAt = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nonce-1");
        bytes32 digest = escrow.exposedReleaseDigest(tradeId, expiresAt, nonce);
        bytes memory sig = _backendSign(digest);

        uint256 buyerBefore = usdt.balanceOf(buyer);
        escrow.release(tradeId, expiresAt, nonce, sig);

        assertEq(usdt.balanceOf(buyer), buyerBefore + AMOUNT);
        assertEq(usdt.balanceOf(address(escrow)), 0);

        (,,,,, P2PEscrow.State st) = escrow.trades(tradeId);
        assertEq(uint256(st), uint256(P2PEscrow.State.RELEASED));
    }

    function testReleaseRevertsWithWrongSig() public {
        _createAndDeposit();

        uint64 expiresAt = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nonce-bad");
        bytes32 digest = escrow.exposedReleaseDigest(tradeId, expiresAt, nonce);
        bytes memory sig = _sign(99, digest); // wrong private key

        vm.expectRevert("invalid backend signature");
        escrow.release(tradeId, expiresAt, nonce, sig);
    }

    function testReleaseRevertsWhenExpired() public {
        _createAndDeposit();

        uint64 expiresAt = uint64(block.timestamp) + 10;
        bytes32 nonce = keccak256("nonce-exp");
        bytes32 digest = escrow.exposedReleaseDigest(tradeId, expiresAt, nonce);
        bytes memory sig = _backendSign(digest);

        vm.warp(block.timestamp + 20);
        vm.expectRevert("authorization expired");
        escrow.release(tradeId, expiresAt, nonce, sig);
    }

    function testDoubleReleasePrevented() public {
        _createAndDeposit();

        uint64 expiresAt = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nonce-double");
        bytes32 digest = escrow.exposedReleaseDigest(tradeId, expiresAt, nonce);
        bytes memory sig = _backendSign(digest);

        escrow.release(tradeId, expiresAt, nonce, sig);

        vm.expectRevert("not locked");
        escrow.release(tradeId, expiresAt, nonce, sig);
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

        (,,,,, P2PEscrow.State st) = escrow.trades(tradeId);
        assertEq(uint256(st), uint256(P2PEscrow.State.REFUNDED));
    }

    function testRefundTooEarlyReverts() public {
        _createAndDeposit();
        vm.expectRevert("too early");
        escrow.refund(tradeId);
    }

    // ── Dispute ───────────────────────────────────────────────────────────────

    function testSellerCannotOpenDispute() public {
        _createAndDeposit();
        // v2 security fix: seller removed — was a griefing vector
        vm.prank(seller);
        vm.expectRevert("not allowed");
        escrow.openDispute(tradeId);
    }

    function testBuyerCanOpenDispute() public {
        _createAndDeposit();
        vm.prank(buyer);
        escrow.openDispute(tradeId);

        (,,,,, P2PEscrow.State st) = escrow.trades(tradeId);
        assertEq(uint256(st), uint256(P2PEscrow.State.DISPUTE));
    }

    function testBackendCanOpenDispute() public {
        _createAndDeposit();
        vm.prank(backend);
        escrow.openDispute(tradeId);

        (,,,,, P2PEscrow.State st) = escrow.trades(tradeId);
        assertEq(uint256(st), uint256(P2PEscrow.State.DISPUTE));
    }

    function testDisputeBlocksRefund() public {
        _createAndDeposit();
        vm.prank(buyer);
        escrow.openDispute(tradeId);

        (,,,, uint64 fiatDl,) = escrow.trades(tradeId);
        vm.warp(fiatDl + 1);

        vm.expectRevert("in dispute");
        escrow.refund(tradeId);
    }

    // ── Dispute resolution ────────────────────────────────────────────────────

    function testResolveDisputeReleaseToBuyer() public {
        _createAndDeposit();
        vm.prank(buyer);
        escrow.openDispute(tradeId);

        uint64 expiresAt = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nonce-resolve");
        bytes32 digest = escrow.exposedReleaseDigest(tradeId, expiresAt, nonce);
        bytes memory sig = _backendSign(digest);

        uint256 buyerBefore = usdt.balanceOf(buyer);
        vm.prank(backend);
        escrow.resolveDisputeRelease(tradeId, expiresAt, nonce, sig);

        assertEq(usdt.balanceOf(buyer), buyerBefore + AMOUNT);
        assertEq(usdt.balanceOf(address(escrow)), 0);

        (,,,,, P2PEscrow.State st) = escrow.trades(tradeId);
        assertEq(uint256(st), uint256(P2PEscrow.State.RELEASED));
    }

    function testResolveDisputeRefundToSeller() public {
        _createAndDeposit();
        vm.prank(buyer);
        escrow.openDispute(tradeId);

        uint64 expiresAt = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nonce-refund");
        bytes32 digest = escrow.exposedRefundDigest(tradeId, expiresAt, nonce);
        bytes memory sig = _backendSign(digest);

        uint256 sellerBefore = usdt.balanceOf(seller);
        vm.prank(backend);
        escrow.resolveDisputeRefund(tradeId, expiresAt, nonce, sig);

        assertEq(usdt.balanceOf(seller), sellerBefore + AMOUNT);
        assertEq(usdt.balanceOf(address(escrow)), 0);

        (,,,,, P2PEscrow.State st) = escrow.trades(tradeId);
        assertEq(uint256(st), uint256(P2PEscrow.State.REFUNDED));
    }

    function testOnlyBackendCanResolveDispute() public {
        _createAndDeposit();
        vm.prank(buyer);
        escrow.openDispute(tradeId);

        uint64 expiresAt = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nonce-x");
        bytes32 digest = escrow.exposedReleaseDigest(tradeId, expiresAt, nonce);
        bytes memory sig = _backendSign(digest);

        vm.prank(seller);
        vm.expectRevert("only backend");
        escrow.resolveDisputeRelease(tradeId, expiresAt, nonce, sig);
    }

    function testReleaseDigestCannotBeUsedForRefund() public {
        // Proves RELEASE_TYPEHASH != REFUND_TYPEHASH at the EIP-712 level
        _createAndDeposit();
        vm.prank(buyer);
        escrow.openDispute(tradeId);

        uint64 expiresAt = uint64(block.timestamp) + 120;
        bytes32 nonce = keccak256("nonce-cross");
        bytes32 releaseDigest = escrow.exposedReleaseDigest(tradeId, expiresAt, nonce);
        bytes memory sig = _backendSign(releaseDigest);

        // Release sig must NOT work for refund
        vm.prank(backend);
        vm.expectRevert("invalid backend signature");
        escrow.resolveDisputeRefund(tradeId, expiresAt, nonce, sig);
    }
}
