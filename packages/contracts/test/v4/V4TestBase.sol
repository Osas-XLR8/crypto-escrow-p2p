// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {EscrowCoreV4} from "../../src/v4/EscrowCoreV4.sol";
import {MockUSDT} from "../../src/MockUSDT.sol";
import {MockArbitrator} from "./Mocks.sol";

/// @notice Shared fixtures for the EscrowCoreV4 test suites.
abstract contract V4TestBase is Test {
    EscrowCoreV4 escrow;
    MockUSDT usdt;
    MockArbitrator arb; // primary
    MockArbitrator arb2; // fallback

    uint256 sellerPk = 0xA11CE;
    address seller = vm.addr(sellerPk);
    address buyer = vm.addr(0xB0B);
    address stranger = vm.addr(0x5757);

    uint256 constant U = 1e6; // 1 USDT
    uint64 constant PAY_WINDOW = 30 minutes;
    uint64 constant RELEASE_WINDOW = 1 hours;
    uint64 constant ARB_TIMEOUT = 30 days;
    uint64 constant FEE_TIMEOUT = 2 days;
    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    uint256 saltCounter;

    function setUp() public virtual {
        usdt = new MockUSDT("Tether USD", "USDT", 6);
        arb = new MockArbitrator();
        arb2 = new MockArbitrator();
        escrow = _deploy(address(usdt), address(arb));

        usdt.mint(seller, 100_000 * U);
        vm.startPrank(seller);
        usdt.approve(address(escrow), type(uint256).max);
        escrow.deposit(address(usdt), 10_000 * U);
        vm.stopPrank();

        vm.deal(buyer, 10 ether);
        vm.deal(seller, 10 ether);
        vm.deal(stranger, 10 ether);
    }

    // ─── Deployment ───────────────────────────────────────────────────────────

    /// @dev Approves `primary` plus the fallback arbitrator `arb2`.
    function _deploy(address token, address primary) internal returns (EscrowCoreV4) {
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        address[] memory arbs = new address[](2);
        arbs[0] = primary;
        arbs[1] = address(arb2);
        return new EscrowCoreV4(tokens, arbs, ARB_TIMEOUT, FEE_TIMEOUT);
    }

    // ─── Offers & trades ──────────────────────────────────────────────────────

    function _offer() internal returns (EscrowCoreV4.Offer memory o) {
        o = EscrowCoreV4.Offer({
            seller: seller,
            token: address(usdt),
            minAmount: 10 * U,
            maxAmount: 1_000 * U,
            totalAmount: 5_000 * U,
            paymentWindow: PAY_WINDOW,
            releaseWindow: RELEASE_WINDOW,
            arbitrator: address(arb),
            fallbackArbitrator: address(arb2),
            termsHash: keccak256("NGN|1600.00|bank-transfer"),
            nonce: 0,
            expiry: uint64(block.timestamp + 1 days),
            salt: bytes32(++saltCounter)
        });
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signOffer(EscrowCoreV4 e, EscrowCoreV4.Offer memory o) internal view returns (bytes memory) {
        return _sign(sellerPk, e.hashOffer(o));
    }

    function _take(EscrowCoreV4.Offer memory o, uint256 amount) internal returns (uint256) {
        bytes memory sig = _signOffer(escrow, o);
        vm.prank(buyer);
        return escrow.takeOffer(o, sig, amount);
    }

    function _open(uint256 amount) internal returns (uint256) {
        return _take(_offer(), amount);
    }

    function _paid(uint256 amount) internal returns (uint256 id) {
        id = _open(amount);
        vm.prank(buyer);
        escrow.markPaid(id, keccak256("evidence"));
    }

    // ─── Disputes ─────────────────────────────────────────────────────────────

    /// @dev Seller opens (seller may dispute any paid trade) — state FEE_PENDING.
    function _feePending(uint256 amount) internal returns (uint256 id) {
        id = _paid(amount);
        uint256 fee = arb.cost();
        vm.prank(seller);
        escrow.openDispute{value: fee}(id);
    }

    /// @dev Seller opens, buyer matches the fee — state DISPUTED with the primary arbitrator.
    function _disputed(uint256 amount) internal returns (uint256 id) {
        id = _feePending(amount);
        uint256 fee = arb.cost();
        vm.prank(buyer);
        escrow.payArbitrationFee{value: fee}(id);
    }

    function _disputeId(uint256 id) internal view returns (uint256) {
        return escrow.getDispute(id).disputeId;
    }

    function _state(uint256 id) internal view returns (EscrowCoreV4.State) {
        return escrow.getTrade(id).state;
    }
}
