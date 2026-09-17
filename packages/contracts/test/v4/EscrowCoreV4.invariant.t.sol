// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {EscrowCoreV4} from "../../src/v4/EscrowCoreV4.sol";
import {MockUSDT} from "../../src/MockUSDT.sol";
import {MockArbitrator} from "./Mocks.sol";

/// @notice Drives random sequences of every public action by sellers, buyers, the arbitrator and outsiders.
contract EscrowHandler is Test {
    EscrowCoreV4 public immutable escrow;
    MockUSDT public immutable usdt;
    MockArbitrator public immutable arb;

    uint256[] public sellerPks;
    address[] public sellers;
    address[] public buyers;
    address public immutable outsider = address(0x0B5E);

    uint256 public releasedToBuyers;
    bool public outsiderSucceeded;
    uint256 private salt;

    constructor(EscrowCoreV4 escrow_, MockUSDT usdt_, MockArbitrator arb_) {
        escrow = escrow_;
        usdt = usdt_;
        arb = arb_;
        for (uint256 i = 0; i < 3; i++) {
            uint256 pk = 0x5E11E0 + i;
            sellerPks.push(pk);
            sellers.push(vm.addr(pk));
            buyers.push(vm.addr(0xB0B0 + i));
        }
        vm.deal(outsider, 100 ether);
    }

    function sellerCount() external view returns (uint256) {
        return sellers.length;
    }

    function buyerAt(uint256 i) external view returns (address) {
        return buyers[i];
    }

    function sellerAt(uint256 i) external view returns (address) {
        return sellers[i];
    }

    function _tradeId(uint256 seed) internal view returns (uint256) {
        uint256 n = escrow.tradeCount();
        return n == 0 ? 0 : (seed % n) + 1;
    }

    // ─── Actions ──────────────────────────────────────────────────────────────

    function deposit(uint256 s, uint256 amount) external {
        address seller = sellers[s % sellers.length];
        amount = bound(amount, 1, 50_000e6);
        vm.prank(seller);
        escrow.deposit(address(usdt), amount);
    }

    function withdraw(uint256 s, uint256 amount) external {
        address seller = sellers[s % sellers.length];
        uint256 free = escrow.freeBalance(seller, address(usdt));
        if (free == 0) return;
        amount = bound(amount, 1, free);
        vm.prank(seller);
        escrow.withdraw(address(usdt), amount);
    }

    function takeOffer(uint256 s, uint256 b, uint256 amount) external {
        uint256 si = s % sellers.length;
        address seller = sellers[si];
        uint256 free = escrow.freeBalance(seller, address(usdt));
        if (free < 1e6) return;
        amount = bound(amount, 1e6, free < 5_000e6 ? free : 5_000e6);

        EscrowCoreV4.Offer memory o = EscrowCoreV4.Offer({
            seller: seller,
            token: address(usdt),
            minAmount: 1e6,
            maxAmount: 5_000e6,
            totalAmount: 20_000e6,
            paymentWindow: 30 minutes,
            releaseWindow: 1 hours,
            arbitrator: address(arb),
            termsHash: keccak256("terms"),
            nonce: escrow.sellerNonce(seller),
            expiry: uint64(block.timestamp + 1 days),
            salt: bytes32(++salt)
        });
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(sellerPks[si], escrow.hashOffer(o));
        vm.prank(buyers[b % buyers.length]);
        escrow.takeOffer(o, abi.encodePacked(r, sg, v), amount);
    }

    function markPaid(uint256 seed) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        vm.prank(escrow.getTrade(id).buyer);
        escrow.markPaid(id, keccak256("proof"));
    }

    function release(uint256 seed) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        EscrowCoreV4.Trade memory t = escrow.getTrade(id);
        vm.prank(t.seller);
        escrow.release(id);
        releasedToBuyers += t.amount;
    }

    function buyerCancel(uint256 seed) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        vm.prank(escrow.getTrade(id).buyer);
        escrow.buyerCancel(id);
    }

    function cancelUnpaid(uint256 seed, uint256 jump) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        vm.warp(block.timestamp + bound(jump, 0, 2 hours));
        escrow.cancelUnpaid(id);
    }

    function openDispute(uint256 seed, bool asBuyer, uint256 jump) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        EscrowCoreV4.Trade memory t = escrow.getTrade(id);
        vm.warp(block.timestamp + bound(jump, 0, 2 hours));
        uint256 fee = arb.cost();
        vm.prank(asBuyer ? t.buyer : t.seller);
        escrow.openDispute{value: fee}(id);
    }

    function giveRuling(uint256 seed, uint256 ruling) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        EscrowCoreV4.Trade memory t = escrow.getTrade(id);
        if (t.disputeId == 0) return;
        ruling = bound(ruling, 0, 2);
        bool pays = t.state == EscrowCoreV4.State.DISPUTED && ruling == 1;
        arb.giveRuling(t.disputeId, ruling);
        if (pays) releasedToBuyers += t.amount;
    }

    function claimTimeout(uint256 seed) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        vm.warp(block.timestamp + 31 days);
        escrow.claimArbitrationTimeout(id);
    }

    /// Outsider tries every fund-moving entry point. None may succeed.
    /// Uses a one-shot prank + low-level call: a reverting call inside startPrank would leak the
    /// prank into later handler calls (cheatcode state is not rolled back by a revert).
    function outsiderAttack(uint256 seed, uint256 action) external {
        uint256 id = _tradeId(seed);
        uint256 a = action % 5;
        bytes memory data = a == 0
            ? abi.encodeCall(EscrowCoreV4.release, (id))
            : a == 1
                ? abi.encodeCall(EscrowCoreV4.buyerCancel, (id))
                : a == 2
                    ? abi.encodeCall(EscrowCoreV4.rule, (seed, 1))
                    : a == 3
                        ? abi.encodeCall(EscrowCoreV4.withdraw, (address(usdt), 1))
                        : abi.encodeCall(EscrowCoreV4.openDispute, (id));
        vm.prank(outsider);
        (bool ok,) = address(escrow).call{value: a == 4 ? 1 ether : 0}(data);
        if (ok) outsiderSucceeded = true;
    }
}

contract EscrowCoreV4InvariantTest is Test {
    EscrowCoreV4 escrow;
    MockUSDT usdt;
    MockArbitrator arb;
    EscrowHandler handler;

    function setUp() public {
        usdt = new MockUSDT("Tether USD", "USDT", 6);
        arb = new MockArbitrator();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdt);
        address[] memory arbs = new address[](1);
        arbs[0] = address(arb);
        escrow = new EscrowCoreV4(tokens, arbs, 30 days);

        handler = new EscrowHandler(escrow, usdt, arb);

        // MockUSDT.mint is deployer-only (this contract), so fund the handler's actors here.
        for (uint256 i = 0; i < handler.sellerCount(); i++) {
            address seller = handler.sellerAt(i);
            usdt.mint(seller, 1_000_000e6);
            vm.prank(seller);
            usdt.approve(address(escrow), type(uint256).max);
            vm.deal(seller, 100 ether);
            vm.deal(handler.buyerAt(i), 100 ether);
        }
        targetContract(address(handler));
    }

    /// Every token held by the escrow is either a seller's free balance or locked in an open trade.
    function invariant_tokensFullyAccounted() public view {
        uint256 accounted;
        for (uint256 i = 0; i < handler.sellerCount(); i++) {
            accounted += escrow.freeBalance(handler.sellerAt(i), address(usdt));
        }
        uint256 n = escrow.tradeCount();
        for (uint256 id = 1; id <= n; id++) {
            EscrowCoreV4.Trade memory t = escrow.getTrade(id);
            if (
                t.state == EscrowCoreV4.State.LOCKED || t.state == EscrowCoreV4.State.PAID
                    || t.state == EscrowCoreV4.State.DISPUTED
            ) accounted += t.amount;
        }
        assertEq(usdt.balanceOf(address(escrow)), accounted);
    }

    /// Buyers only ever receive tokens through a seller release or a buyer-favouring ruling.
    function invariant_buyersOnlyReceiveReleasedFunds() public view {
        uint256 held;
        for (uint256 i = 0; i < handler.sellerCount(); i++) {
            held += usdt.balanceOf(handler.buyerAt(i));
        }
        assertEq(held, handler.releasedToBuyers());
    }

    /// Nobody outside the trade (and not the arbitrator) ever moved or froze anything.
    function invariant_outsidersNeverSucceed() public view {
        assertFalse(handler.outsiderSucceeded());
    }

    /// The escrow never keeps native currency (dispute fees pass straight to the arbitrator).
    function invariant_noStrandedNativeCurrency() public view {
        assertEq(address(escrow).balance, 0);
    }
}
