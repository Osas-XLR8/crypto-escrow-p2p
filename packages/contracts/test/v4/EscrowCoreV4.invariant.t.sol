// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {EscrowCoreV4} from "../../src/v4/EscrowCoreV4.sol";
import {MockUSDT} from "../../src/MockUSDT.sol";
import {MockArbitrator} from "./Mocks.sol";

/// @notice Drives random sequences of every public action by sellers, buyers, arbitrators and outsiders.
contract EscrowHandler is Test {
    EscrowCoreV4 public immutable escrow;
    MockUSDT public immutable usdt;
    MockArbitrator public immutable arb;
    MockArbitrator public immutable arb2;

    uint256[] public sellerPks;
    address[] public sellers;
    address[] public buyers;
    address public immutable outsider = address(0x0B5E);

    bool public outsiderSucceeded;
    uint256 private salt;

    constructor(EscrowCoreV4 escrow_, MockUSDT usdt_, MockArbitrator arb_, MockArbitrator arb2_) {
        escrow = escrow_;
        usdt = usdt_;
        arb = arb_;
        arb2 = arb2_;
        for (uint256 i = 0; i < 3; i++) {
            uint256 pk = 0x5E11E0 + i;
            sellerPks.push(pk);
            sellers.push(vm.addr(pk));
            buyers.push(vm.addr(0xB0B0 + i));
        }
        vm.deal(outsider, 1_000 ether);
    }

    function actorCount() external view returns (uint256) {
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

    // ─── Vault & offers ───────────────────────────────────────────────────────

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
            fallbackArbitrator: address(arb2),
            termsHash: keccak256("terms"),
            nonce: escrow.sellerNonce(seller),
            expiry: uint64(block.timestamp + 1 days),
            salt: bytes32(++salt)
        });
        bytes32 digest = escrow.hashOffer(o);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(sellerPks[si], digest);
        vm.prank(buyers[b % buyers.length]);
        escrow.takeOffer(o, abi.encodePacked(r, sg, v), amount);
    }

    // ─── Trade lifecycle ──────────────────────────────────────────────────────

    function markPaid(uint256 seed) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        address b = escrow.getTrade(id).buyer;
        vm.prank(b);
        escrow.markPaid(id, keccak256("proof"));
    }

    function release(uint256 seed) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        address s = escrow.getTrade(id).seller;
        vm.prank(s);
        escrow.release(id);
    }

    function buyerCancel(uint256 seed) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        address b = escrow.getTrade(id).buyer;
        vm.prank(b);
        escrow.buyerCancel(id);
    }

    function cancelUnpaid(uint256 seed, uint256 jump) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        vm.warp(block.timestamp + bound(jump, 0, 2 hours));
        escrow.cancelUnpaid(id);
    }

    // ─── Disputes ─────────────────────────────────────────────────────────────

    function setArbitrationCosts(uint256 c1, uint256 c2) external {
        arb.setCost(bound(c1, 0, 0.2 ether));
        arb2.setCost(bound(c2, 0, 0.2 ether));
    }

    function openDispute(uint256 seed, bool asBuyer, uint256 jump, uint256 extra) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        EscrowCoreV4.Trade memory t = escrow.getTrade(id);
        vm.warp(block.timestamp + bound(jump, 0, 2 hours));
        address who = asBuyer ? t.buyer : t.seller;
        uint256 value = arb.cost() + bound(extra, 0, 0.05 ether);
        vm.deal(who, who.balance + value);
        vm.prank(who);
        escrow.openDispute{value: value}(id);
    }

    function payArbitrationFee(uint256 seed, uint256 extra) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        EscrowCoreV4.Trade memory t = escrow.getTrade(id);
        address opener = escrow.getDispute(id).opener;
        address who = opener == t.buyer ? t.seller : t.buyer;
        uint256 value = arb.cost() + bound(extra, 0, 0.05 ether);
        vm.deal(who, who.balance + value);
        vm.prank(who);
        escrow.payArbitrationFee{value: value}(id);
    }

    function claimFeeTimeout(uint256 seed) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        vm.warp(block.timestamp + 3 days);
        escrow.claimFeeTimeout(id);
    }

    function escalate(uint256 seed, bool asBuyer, uint256 extra) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        EscrowCoreV4.Trade memory t = escrow.getTrade(id);
        vm.warp(block.timestamp + 31 days);
        address who = asBuyer ? t.buyer : t.seller;
        uint256 value = arb2.cost() + bound(extra, 0, 0.05 ether);
        vm.deal(who, who.balance + value);
        vm.prank(who);
        escrow.escalateToFallback{value: value}(id);
    }

    /// Rules via the active arbitrator, or (sometimes) a stale ruling via the other one.
    function giveRuling(uint256 seed, uint256 ruling, bool stale) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        EscrowCoreV4.Trade memory t = escrow.getTrade(id);
        if (t.activeArbitrator == address(0)) return;
        uint256 disputeId = escrow.getDispute(id).disputeId;
        MockArbitrator target = MockArbitrator(t.activeArbitrator);
        if (stale) target = t.activeArbitrator == address(arb) ? arb2 : arb;
        if (target.arbitrableOf(disputeId) != address(escrow)) return;
        target.giveRuling(disputeId, bound(ruling, 0, 2));
    }

    function claimArbitrationTimeout(uint256 seed) external {
        uint256 id = _tradeId(seed);
        if (id == 0) return;
        vm.warp(block.timestamp + 61 days);
        escrow.claimArbitrationTimeout(id);
    }

    /// Withdraws for the first actor (starting at a random offset) that actually has something to claim.
    function withdrawNative(uint256 start) external {
        uint256 n = sellers.length * 2;
        for (uint256 i = 0; i < n; i++) {
            uint256 k = (start + i) % n;
            address account = k < sellers.length ? sellers[k] : buyers[k - sellers.length];
            if (escrow.claimableNative(account) == 0) continue;
            vm.prank(account);
            escrow.withdrawNative();
            return;
        }
    }

    /// Outsider tries every fund-moving entry point. None may succeed.
    /// Uses a one-shot prank + low-level call: a reverting call inside startPrank would leak the
    /// prank into later handler calls (cheatcode state is not rolled back by a revert).
    function outsiderAttack(uint256 seed, uint256 action) external {
        uint256 id = _tradeId(seed);
        uint256 a = action % 8;
        bytes memory data;
        if (a == 0) data = abi.encodeCall(EscrowCoreV4.release, (id));
        else if (a == 1) data = abi.encodeCall(EscrowCoreV4.buyerCancel, (id));
        else if (a == 2) data = abi.encodeCall(EscrowCoreV4.rule, (seed, 1));
        else if (a == 3) data = abi.encodeCall(EscrowCoreV4.withdraw, (address(usdt), 1));
        else if (a == 4) data = abi.encodeCall(EscrowCoreV4.openDispute, (id));
        else if (a == 5) data = abi.encodeCall(EscrowCoreV4.payArbitrationFee, (id));
        else if (a == 6) data = abi.encodeCall(EscrowCoreV4.escalateToFallback, (id));
        else data = abi.encodeCall(EscrowCoreV4.withdrawNative, ());
        vm.prank(outsider);
        (bool ok,) = address(escrow).call{value: a >= 4 && a <= 6 ? 1 ether : 0}(data);
        if (ok) outsiderSucceeded = true;
    }
}

contract EscrowCoreV4InvariantTest is Test {
    EscrowCoreV4 escrow;
    MockUSDT usdt;
    MockArbitrator arb;
    MockArbitrator arb2;
    EscrowHandler handler;

    function setUp() public {
        usdt = new MockUSDT("Tether USD", "USDT", 6);
        arb = new MockArbitrator();
        arb2 = new MockArbitrator();
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdt);
        address[] memory arbs = new address[](2);
        arbs[0] = address(arb);
        arbs[1] = address(arb2);
        escrow = new EscrowCoreV4(tokens, arbs, 30 days, 2 days);

        handler = new EscrowHandler(escrow, usdt, arb, arb2);

        // MockUSDT.mint is deployer-only (this contract), so fund the handler's actors here.
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address seller = handler.sellerAt(i);
            usdt.mint(seller, 1_000_000e6);
            vm.prank(seller);
            usdt.approve(address(escrow), type(uint256).max);
        }
        targetContract(address(handler));
    }

    function _isOpen(EscrowCoreV4.State s) internal pure returns (bool) {
        return s == EscrowCoreV4.State.LOCKED || s == EscrowCoreV4.State.PAID || s == EscrowCoreV4.State.FEE_PENDING
            || s == EscrowCoreV4.State.DISPUTED;
    }

    /// Every token held by the escrow is either a seller's free balance or locked in an open trade.
    function invariant_tokensFullyAccounted() public view {
        uint256 accounted;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            accounted += escrow.freeBalance(handler.sellerAt(i), address(usdt));
        }
        uint256 n = escrow.tradeCount();
        for (uint256 id = 1; id <= n; id++) {
            EscrowCoreV4.Trade memory t = escrow.getTrade(id);
            if (_isOpen(t.state)) accounted += t.amount;
        }
        assertEq(usdt.balanceOf(address(escrow)), accounted);
    }

    /// Buyers hold exactly the sum of released trades; no other path pays them tokens.
    function invariant_buyersOnlyReceiveReleasedFunds() public view {
        uint256 held;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            held += usdt.balanceOf(handler.buyerAt(i));
        }
        uint256 released;
        uint256 n = escrow.tradeCount();
        for (uint256 id = 1; id <= n; id++) {
            EscrowCoreV4.Trade memory t = escrow.getTrade(id);
            if (t.state == EscrowCoreV4.State.RELEASED) released += t.amount;
        }
        assertEq(held, released);
    }

    /// Native currency held == unspent dispute pools + balances parties can withdraw.
    function invariant_nativeFullyAccounted() public view {
        uint256 owed;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            owed += escrow.claimableNative(handler.sellerAt(i)) + escrow.claimableNative(handler.buyerAt(i));
        }
        uint256 n = escrow.tradeCount();
        for (uint256 id = 1; id <= n; id++) {
            owed += escrow.getDispute(id).pool;
        }
        assertEq(address(escrow).balance, owed);
    }

    /// Settled trades never keep an unspent pool (fees are always distributed at settlement).
    function invariant_settledTradesHaveNoPool() public view {
        uint256 n = escrow.tradeCount();
        for (uint256 id = 1; id <= n; id++) {
            EscrowCoreV4.Trade memory t = escrow.getTrade(id);
            if (!_isOpen(t.state)) assertEq(escrow.getDispute(id).pool, 0);
        }
    }

    /// Nobody outside the trade (and not an arbitrator) ever moved or froze anything.
    function invariant_outsidersNeverSucceed() public view {
        assertFalse(handler.outsiderSucceeded());
    }
}
