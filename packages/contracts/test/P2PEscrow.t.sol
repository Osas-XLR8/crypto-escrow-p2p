// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/P2PEscrow.sol";

contract P2PEscrowTest is Test {
    P2PEscrowTestable escrow;
    MockERC20 usdt;

    // Backend signer (platform key)
    uint256 backendPk = 11;
    address backend = vm.addr(backendPk);

    address seller = vm.addr(22);
    address buyer = vm.addr(33);

    bytes32 tradeId;

    function setUp() public {
        // Deploy mock USDT (6 decimals)
        usdt = new MockERC20("USDT", "USDT", 6);
        // Mint seller 1000 USDT (1000 * 1e6)
        usdt.mint(seller, 1000_000000);

        // Deploy escrow (testable version uses mock token)
        escrow = new P2PEscrowTestable(backend, address(usdt));

        tradeId = keccak256("trade-1");
    }

    function testCreateTradeBackendOnly() public {
        uint64 nowTs = uint64(block.timestamp);
        uint64 lockDl = nowTs + 60;
        uint64 fiatDl = nowTs + 300;

        // Non-backend should fail
        vm.prank(seller);
        vm.expectRevert("only backend");
        escrow.createTrade(tradeId, seller, buyer, 100_000000, lockDl, fiatDl);

        // Backend can create
        vm.prank(backend);
        escrow.createTrade(tradeId, seller, buyer, 100_000000, lockDl, fiatDl);

        (address s, address b, uint256 amt, uint64 ld, uint64 fd, P2PEscrow.State st) = escrow.trades(tradeId);
        assertEq(s, seller);
        assertEq(b, buyer);
        assertEq(amt, 100_000000);
        assertEq(ld, lockDl);
        assertEq(fd, fiatDl);
        assertEq(uint256(st), uint256(P2PEscrow.State.CREATED));
    }

    function testDepositLocksFunds() public {
        uint64 nowTs = uint64(block.timestamp);
        uint64 lockDl = nowTs + 60;
        uint64 fiatDl = nowTs + 300;

        vm.prank(backend);
        escrow.createTrade(tradeId, seller, buyer, 100_000000, lockDl, fiatDl);

        // Seller approves escrow
        vm.prank(seller);
        usdt.approve(address(escrow), 100_000000);

        uint256 sellerBefore = usdt.balanceOf(seller);

        vm.prank(seller);
        escrow.deposit(tradeId);

        assertEq(usdt.balanceOf(address(escrow)), 100_000000);
        assertEq(usdt.balanceOf(seller), sellerBefore - 100_000000);

        (,,,,, P2PEscrow.State st) = escrow.trades(tradeId);
        assertEq(uint256(st), uint256(P2PEscrow.State.LOCKED));
    }

    function testReleaseNeedsValidBackendSig() public {
        uint64 nowTs = uint64(block.timestamp);
        uint64 lockDl = nowTs + 60;
        uint64 fiatDl = nowTs + 300;

        vm.prank(backend);
        escrow.createTrade(tradeId, seller, buyer, 100_000000, lockDl, fiatDl);

        vm.prank(seller);
        usdt.approve(address(escrow), 100_000000);

        vm.prank(seller);
        escrow.deposit(tradeId);

        uint64 expiresAt = nowTs + 120;
        bytes32 nonce = keccak256("nonce-1");

        // Build digest exactly like contract does
        bytes32 digest = escrow.exposedReleaseDigest(tradeId, expiresAt, nonce);

        // Sign "Ethereum Signed Message" hash
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(backendPk, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);

        uint256 buyerBefore = usdt.balanceOf(buyer);

        escrow.release(tradeId, expiresAt, nonce, sig);

        assertEq(usdt.balanceOf(buyer), buyerBefore + 100_000000);
        assertEq(usdt.balanceOf(address(escrow)), 0);

        (,,,,, P2PEscrow.State st) = escrow.trades(tradeId);
        assertEq(uint256(st), uint256(P2PEscrow.State.RELEASED));
    }

    function testRefundAfterFiatDeadline() public {
        uint64 nowTs = uint64(block.timestamp);
        uint64 lockDl = nowTs + 60;
        uint64 fiatDl = nowTs + 120;

        vm.prank(backend);
        escrow.createTrade(tradeId, seller, buyer, 100_000000, lockDl, fiatDl);

        vm.prank(seller);
        usdt.approve(address(escrow), 100_000000);

        vm.prank(seller);
        escrow.deposit(tradeId);

        // Warp past fiat deadline
        vm.warp(fiatDl + 1);

        uint256 sellerBefore = usdt.balanceOf(seller);
        escrow.refund(tradeId);

        assertEq(usdt.balanceOf(seller), sellerBefore + 100_000000);
        assertEq(usdt.balanceOf(address(escrow)), 0);

        (,,,,, P2PEscrow.State st) = escrow.trades(tradeId);
        assertEq(uint256(st), uint256(P2PEscrow.State.REFUNDED));
    }
}

/* ------------------------
   Mock ERC20 for tests
------------------------- */

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "bal");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(balanceOf[from] >= amt, "bal");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amt, "allow");
        allowance[from][msg.sender] = allowed - amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/* ------------------------
   Testable escrow:
   Overrides _token() so tests can use MockERC20
------------------------- */

contract P2PEscrowTestable is P2PEscrow {
    address public TEST_TOKEN;

    constructor(address _backendSigner, address token) P2PEscrow(_backendSigner) {
        TEST_TOKEN = token;
    }

    function _token() internal view override returns (address) {
        return TEST_TOKEN;
    }

    function exposedReleaseDigest(bytes32 tradeId, uint64 expiresAt, bytes32 nonce) external view returns (bytes32) {
        return _releaseDigest(tradeId, expiresAt, nonce);
    }
}
