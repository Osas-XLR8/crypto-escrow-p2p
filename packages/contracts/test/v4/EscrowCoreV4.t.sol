// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EscrowCoreV4} from "../../src/v4/EscrowCoreV4.sol";
import {MockArbitrator, NoReturnToken, FeeOnTransferToken, SmartWallet} from "./Mocks.sol";
import {V4TestBase} from "./V4TestBase.sol";

contract EscrowCoreV4Test is V4TestBase {
    // ─── Deployment: nothing is adjustable afterwards ─────────────────────────

    function testConstructorValidation() public {
        address[] memory none = new address[](0);
        address[] memory one = new address[](1);
        one[0] = address(usdt);
        address[] memory arbs = new address[](2);
        arbs[0] = address(arb);
        arbs[1] = address(arb2);
        address[] memory onlyOneArb = new address[](1);
        onlyOneArb[0] = address(arb);
        address[] memory eoa = new address[](1);
        eoa[0] = address(0xdead);
        address[] memory eoaArbs = new address[](2);
        eoaArbs[0] = address(arb);
        eoaArbs[1] = address(0xdead);

        vm.expectRevert("no tokens");
        new EscrowCoreV4(none, arbs, ARB_TIMEOUT, FEE_TIMEOUT);
        vm.expectRevert("need primary and fallback arbitrators");
        new EscrowCoreV4(one, onlyOneArb, ARB_TIMEOUT, FEE_TIMEOUT);
        vm.expectRevert("bad arbitration timeout");
        new EscrowCoreV4(one, arbs, 6 days, FEE_TIMEOUT);
        vm.expectRevert("bad arbitration timeout");
        new EscrowCoreV4(one, arbs, 91 days, FEE_TIMEOUT);
        vm.expectRevert("bad fee timeout");
        new EscrowCoreV4(one, arbs, ARB_TIMEOUT, 12 hours);
        vm.expectRevert("bad fee timeout");
        new EscrowCoreV4(one, arbs, ARB_TIMEOUT, 8 days);
        vm.expectRevert("token has no code");
        new EscrowCoreV4(eoa, arbs, ARB_TIMEOUT, FEE_TIMEOUT);
        vm.expectRevert("arbitrator has no code");
        new EscrowCoreV4(one, eoaArbs, ARB_TIMEOUT, FEE_TIMEOUT);
    }

    /// Principle 1: the contract exposes no owner / pause / upgrade / role-management surface.
    function testNoPrivilegedFunctionsExist() public {
        bytes[] memory calls = new bytes[](10);
        calls[0] = abi.encodeWithSignature("owner()");
        calls[1] = abi.encodeWithSignature("pause()");
        calls[2] = abi.encodeWithSignature("unpause()");
        calls[3] = abi.encodeWithSignature("transferOwnership(address)", stranger);
        calls[4] = abi.encodeWithSignature("setOperator(address)", stranger);
        calls[5] = abi.encodeWithSignature("setBackendSigner(address)", stranger);
        calls[6] = abi.encodeWithSignature("upgradeTo(address)", stranger);
        calls[7] = abi.encodeWithSignature("upgradeToAndCall(address,bytes)", stranger, "");
        calls[8] = abi.encodeWithSignature(
            "createTrade(bytes32,address,address,uint256,uint64,uint64)", 0, seller, buyer, 1, 1, 2
        );
        calls[9] = abi.encodeWithSignature("release(bytes32,uint64,bytes32,bytes)", 0, 0, 0, "");
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok,) = address(escrow).call(calls[i]);
            assertFalse(ok, "privileged function exists");
        }
    }

    // ─── Vault ────────────────────────────────────────────────────────────────

    function testDepositAndWithdraw() public {
        assertEq(escrow.freeBalance(seller, address(usdt)), 10_000 * U);
        uint256 before = usdt.balanceOf(seller);
        vm.prank(seller);
        escrow.withdraw(address(usdt), 4_000 * U);
        assertEq(usdt.balanceOf(seller), before + 4_000 * U);
        assertEq(escrow.freeBalance(seller, address(usdt)), 6_000 * U);
    }

    function testCannotWithdrawLockedFunds() public {
        _open(1_000 * U);
        vm.startPrank(seller);
        vm.expectRevert("insufficient free balance");
        escrow.withdraw(address(usdt), 10_000 * U);
        escrow.withdraw(address(usdt), 9_000 * U); // everything that isn't locked
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(escrow)), 1_000 * U);
    }

    function testVaultIsolation() public {
        vm.prank(stranger);
        vm.expectRevert("insufficient free balance");
        escrow.withdraw(address(usdt), 1);

        vm.prank(seller);
        vm.expectRevert("unsupported token");
        escrow.deposit(address(0xBEEF), 1);
    }

    function testFeeOnTransferDepositCreditsOnlyWhatArrived() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        EscrowCoreV4 e = _deploy(address(fot), address(arb));
        fot.mint(seller, 1_000 * U);
        vm.startPrank(seller);
        fot.approve(address(e), type(uint256).max);
        e.deposit(address(fot), 100 * U);
        vm.stopPrank();
        assertEq(e.freeBalance(seller, address(fot)), 99 * U);
        assertEq(fot.balanceOf(address(e)), 99 * U);
    }

    // ─── Offers ───────────────────────────────────────────────────────────────

    function testTakeOfferLocksFundsAtomically() public {
        EscrowCoreV4.Offer memory o = _offer();
        uint256 id = _take(o, 250 * U);

        EscrowCoreV4.Trade memory t = escrow.getTrade(id);
        assertEq(t.seller, seller);
        assertEq(t.buyer, buyer);
        assertEq(t.amount, 250 * U);
        assertEq(t.arbitrator, address(arb));
        assertEq(t.termsHash, o.termsHash);
        assertEq(t.paymentDeadline, block.timestamp + PAY_WINDOW);
        assertEq(uint256(t.state), uint256(EscrowCoreV4.State.LOCKED));

        assertEq(escrow.freeBalance(seller, address(usdt)), 9_750 * U);
        assertEq(escrow.filled(escrow.hashOffer(o)), 250 * U);
        assertEq(usdt.balanceOf(address(escrow)), 10_000 * U); // tokens never left the contract
        assertEq(escrow.remaining(o), 4_750 * U);
    }

    function testOfferDigestMatchesEip712Spec() public {
        EscrowCoreV4.Offer memory o = _offer();
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("EscrowX"),
                keccak256("4"),
                block.chainid,
                address(escrow)
            )
        );
        bytes32 structHash = keccak256(
            bytes.concat(
                abi.encode(escrow.OFFER_TYPEHASH(), o.seller, o.token, o.minAmount, o.maxAmount, o.totalAmount),
                abi.encode(o.paymentWindow, o.releaseWindow, o.arbitrator, o.fallbackArbitrator),
                abi.encode(o.termsHash, o.nonce, o.expiry, o.salt)
            )
        );
        assertEq(escrow.hashOffer(o), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    function testRejectsBadSignatures() public {
        EscrowCoreV4.Offer memory o = _offer();

        bytes memory wrongKey = _sign(0xBAD, escrow.hashOffer(o));
        vm.prank(buyer);
        vm.expectRevert("invalid maker signature");
        escrow.takeOffer(o, wrongKey, 100 * U);

        // Signed one offer, submitted a better one for the buyer.
        bytes memory sig = _signOffer(escrow, o);
        o.maxAmount = 5_000 * U;
        vm.prank(buyer);
        vm.expectRevert("invalid maker signature");
        escrow.takeOffer(o, sig, 2_000 * U);
        o.maxAmount = 1_000 * U;

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sellerPk, escrow.hashOffer(o));
        bytes memory highS = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.prank(buyer);
        vm.expectRevert("invalid maker signature");
        escrow.takeOffer(o, highS, 100 * U);

        vm.prank(buyer);
        vm.expectRevert("invalid maker signature");
        escrow.takeOffer(o, hex"1234", 100 * U);
    }

    function testOfferValidity() public {
        EscrowCoreV4.Offer memory o = _offer();
        bytes memory sig = _signOffer(escrow, o);

        vm.startPrank(buyer);
        vm.expectRevert("amount out of range");
        escrow.takeOffer(o, sig, 9 * U);
        vm.expectRevert("amount out of range");
        escrow.takeOffer(o, sig, 1_001 * U);
        vm.stopPrank();

        vm.prank(seller);
        vm.expectRevert("cannot take own offer");
        escrow.takeOffer(o, sig, 100 * U);

        vm.warp(o.expiry + 1);
        vm.prank(buyer);
        vm.expectRevert("offer expired");
        escrow.takeOffer(o, sig, 100 * U);
    }

    function testOfferCapacityAcrossFills() public {
        EscrowCoreV4.Offer memory o = _offer();
        bytes memory sig = _signOffer(escrow, o);
        vm.startPrank(buyer);
        for (uint256 i = 0; i < 5; i++) {
            escrow.takeOffer(o, sig, 1_000 * U);
        }
        vm.expectRevert("offer capacity exceeded");
        escrow.takeOffer(o, sig, 10 * U);
        vm.stopPrank();
        assertEq(escrow.remaining(o), 0);
    }

    function testSellerCanCancelOffersAndBumpNonce() public {
        EscrowCoreV4.Offer memory o = _offer();
        bytes memory sig = _signOffer(escrow, o);

        vm.prank(stranger);
        vm.expectRevert("only seller");
        escrow.cancelOffer(o);

        vm.prank(seller);
        escrow.cancelOffer(o);
        vm.prank(buyer);
        vm.expectRevert("offer cancelled");
        escrow.takeOffer(o, sig, 100 * U);

        EscrowCoreV4.Offer memory o2 = _offer();
        bytes memory sig2 = _signOffer(escrow, o2);
        vm.prank(seller);
        escrow.bumpNonce();
        vm.prank(buyer);
        vm.expectRevert("offer nonce invalid");
        escrow.takeOffer(o2, sig2, 100 * U);
    }

    function testRejectsUnapprovedArbitratorAndOutOfBoundsWindows() public {
        EscrowCoreV4.Offer memory o = _offer();
        o.arbitrator = address(new MockArbitrator());
        bytes memory sig = _signOffer(escrow, o);
        vm.prank(buyer);
        vm.expectRevert("arbitrator not approved");
        escrow.takeOffer(o, sig, 100 * U);

        o = _offer();
        o.paymentWindow = 5 minutes;
        sig = _signOffer(escrow, o);
        vm.prank(buyer);
        vm.expectRevert("bad payment window");
        escrow.takeOffer(o, sig, 100 * U);

        o = _offer();
        o.releaseWindow = 2 days;
        sig = _signOffer(escrow, o);
        vm.prank(buyer);
        vm.expectRevert("bad release window");
        escrow.takeOffer(o, sig, 100 * U);
    }

    function testInsufficientSellerBalance() public {
        vm.prank(seller);
        escrow.withdraw(address(usdt), 9_950 * U);
        EscrowCoreV4.Offer memory o = _offer();
        bytes memory sig = _signOffer(escrow, o);
        vm.prank(buyer);
        vm.expectRevert("insufficient seller balance");
        escrow.takeOffer(o, sig, 100 * U);
        assertEq(escrow.remaining(o), 50 * U);
    }

    function testSmartContractWalletSeller() public {
        SmartWallet wallet = new SmartWallet(seller);
        usdt.mint(address(wallet), 500 * U);
        vm.startPrank(seller);
        wallet.exec(address(usdt), abi.encodeWithSignature("approve(address,uint256)", address(escrow), 500 * U));
        wallet.exec(address(escrow), abi.encodeWithSignature("deposit(address,uint256)", address(usdt), 500 * U));
        vm.stopPrank();

        EscrowCoreV4.Offer memory o = _offer();
        o.seller = address(wallet);
        bytes memory sig = _sign(sellerPk, escrow.hashOffer(o)); // owner key signs; wallet validates via ERC-1271
        vm.prank(buyer);
        uint256 id = escrow.takeOffer(o, sig, 100 * U);
        assertEq(escrow.getTrade(id).seller, address(wallet));
    }

    function testSignatureBoundToChainAndContract() public {
        EscrowCoreV4.Offer memory o = _offer();
        bytes memory sig = _signOffer(escrow, o);

        EscrowCoreV4 other = _deploy(address(usdt), address(arb));
        vm.startPrank(seller);
        usdt.approve(address(other), type(uint256).max);
        other.deposit(address(usdt), 1_000 * U);
        vm.stopPrank();
        vm.prank(buyer);
        vm.expectRevert("invalid maker signature");
        other.takeOffer(o, sig, 100 * U);

        vm.chainId(999);
        vm.prank(buyer);
        vm.expectRevert("invalid maker signature");
        escrow.takeOffer(o, sig, 100 * U);
    }

    // ─── Change #1: nobody but the seller can release ─────────────────────────

    function testOnlySellerCanRelease() public {
        uint256 id = _paid(500 * U);
        address[4] memory notSeller = [buyer, stranger, address(arb), address(this)];
        for (uint256 i = 0; i < notSeller.length; i++) {
            vm.prank(notSeller[i]);
            vm.expectRevert("only seller");
            escrow.release(id);
        }

        vm.prank(seller);
        escrow.release(id);
        assertEq(usdt.balanceOf(buyer), 500 * U);
        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.RELEASED));
    }

    function testSellerCanReleaseInEveryOpenState() public {
        uint256 locked = _open(100 * U);
        uint256 paid = _paid(200 * U);
        uint256 disputed = _disputed(300 * U);
        vm.startPrank(seller);
        escrow.release(locked);
        escrow.release(paid);
        escrow.release(disputed);
        vm.stopPrank();
        assertEq(usdt.balanceOf(buyer), 600 * U);
    }

    function testFuzzOutsidersCannotMoveOrFreezeFunds(address caller, uint8 action) public {
        vm.assume(caller != seller && caller != buyer && caller != address(arb) && caller != address(0));
        vm.assume(caller.code.length == 0 && uint160(caller) > 0xff);
        vm.deal(caller, 1 ether);

        uint256 locked = _open(100 * U);
        uint256 paid = _paid(200 * U);
        uint256 disputed = _disputed(300 * U);
        uint256 escrowBalance = usdt.balanceOf(address(escrow));
        uint256 free = escrow.freeBalance(seller, address(usdt));

        vm.startPrank(caller);
        uint256 a = action % 12;
        bool ok;
        if (a == 0) {
            (ok,) = address(escrow).call(abi.encodeCall(EscrowCoreV4.release, (paid)));
        } else if (a == 1) {
            (ok,) = address(escrow).call(abi.encodeCall(EscrowCoreV4.buyerCancel, (paid)));
        } else if (a == 2) {
            (ok,) = address(escrow).call(abi.encodeCall(EscrowCoreV4.markPaid, (locked, 0)));
        } else if (a == 3) {
            (ok,) = address(escrow).call{value: 0.5 ether}(abi.encodeCall(EscrowCoreV4.openDispute, (paid)));
        } else if (a == 4) {
            (ok,) = address(escrow).call(abi.encodeCall(EscrowCoreV4.rule, (1, 1)));
        } else if (a == 5) {
            (ok,) = address(escrow).call(abi.encodeCall(EscrowCoreV4.cancelUnpaid, (locked)));
        } else if (a == 6) {
            (ok,) = address(escrow).call(abi.encodeCall(EscrowCoreV4.claimArbitrationTimeout, (disputed)));
        } else if (a == 7) {
            (ok,) = address(escrow).call(abi.encodeCall(EscrowCoreV4.withdraw, (address(usdt), 1)));
        } else if (a == 8) {
            (ok,) = address(escrow).call(abi.encodeCall(EscrowCoreV4.release, (disputed)));
        } else if (a == 9) {
            (ok,) = address(escrow).call{value: 0.5 ether}(abi.encodeCall(EscrowCoreV4.payArbitrationFee, (paid)));
        } else if (a == 10) {
            vm.warp(block.timestamp + 90 days);
            (ok,) = address(escrow).call{value: 0.5 ether}(abi.encodeCall(EscrowCoreV4.escalateToFallback, (disputed)));
        } else {
            (ok,) = address(escrow).call(abi.encodeCall(EscrowCoreV4.withdrawNative, ()));
        }
        vm.stopPrank();

        assertFalse(ok, "outsider action succeeded");
        assertEq(usdt.balanceOf(address(escrow)), escrowBalance);
        assertEq(escrow.freeBalance(seller, address(usdt)), free);
        assertEq(uint256(_state(locked)), uint256(EscrowCoreV4.State.LOCKED));
        assertEq(uint256(_state(paid)), uint256(EscrowCoreV4.State.PAID));
        assertEq(uint256(_state(disputed)), uint256(EscrowCoreV4.State.DISPUTED));
    }

    // ─── Payment lifecycle ────────────────────────────────────────────────────

    function testMarkPaidOnlyBuyerWithinWindow() public {
        uint256 id = _open(100 * U);
        vm.prank(seller);
        vm.expectRevert("only buyer");
        escrow.markPaid(id, 0);

        uint256 late = _open(100 * U);
        vm.warp(block.timestamp + PAY_WINDOW + 1);
        vm.prank(buyer);
        vm.expectRevert("payment window closed");
        escrow.markPaid(late, 0);

        uint256 fresh = _open(100 * U);
        vm.prank(buyer);
        escrow.markPaid(fresh, keccak256("receipt"));
        assertEq(escrow.getTrade(fresh).releaseDeadline, block.timestamp + RELEASE_WINDOW);
    }

    function testCancelUnpaidIsPermissionlessAfterWindowAndRestoresCapacity() public {
        EscrowCoreV4.Offer memory o = _offer();
        uint256 id = _take(o, 1_000 * U);

        vm.prank(stranger);
        vm.expectRevert("payment window open");
        escrow.cancelUnpaid(id);

        vm.warp(block.timestamp + PAY_WINDOW + 1);
        vm.prank(stranger);
        escrow.cancelUnpaid(id);

        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.CANCELLED));
        assertEq(escrow.freeBalance(seller, address(usdt)), 10_000 * U);
        assertEq(escrow.filled(escrow.hashOffer(o)), 0);
    }

    function testPaidTradeCannotBeCancelledByTimeout() public {
        uint256 id = _paid(100 * U);
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert("not locked");
        escrow.cancelUnpaid(id);
    }

    function testBuyerCanCancelAnyOpenTrade() public {
        uint256 locked = _open(100 * U);
        uint256 paid = _paid(200 * U);
        uint256 disputed = _disputed(300 * U);
        vm.startPrank(buyer);
        escrow.buyerCancel(locked);
        escrow.buyerCancel(paid);
        escrow.buyerCancel(disputed);
        vm.stopPrank();
        assertEq(escrow.freeBalance(seller, address(usdt)), 10_000 * U);
        assertEq(usdt.balanceOf(buyer), 0);

        uint256 another = _open(100 * U);
        vm.prank(seller);
        vm.expectRevert("only buyer");
        escrow.buyerCancel(another);
    }

    function testSettledTradesStaySettled() public {
        uint256 id = _paid(100 * U);
        vm.prank(seller);
        escrow.release(id);

        vm.prank(seller);
        vm.expectRevert("trade not open");
        escrow.release(id);
        vm.prank(buyer);
        vm.expectRevert("trade not open");
        escrow.buyerCancel(id);
        vm.prank(buyer);
        vm.expectRevert("not paid");
        escrow.openDispute{value: 1 ether}(id);
    }

    // ─── Disputes ─────────────────────────────────────────────────────────────

    function testDisputeEligibility() public {
        uint256 locked = _open(100 * U);
        vm.prank(seller);
        vm.expectRevert("not paid");
        escrow.openDispute{value: 1 ether}(locked);

        uint256 id = _paid(100 * U);
        vm.prank(buyer);
        vm.expectRevert("release window open");
        escrow.openDispute{value: 1 ether}(id);

        vm.prank(stranger);
        vm.expectRevert("only parties");
        escrow.openDispute{value: 1 ether}(id);

        vm.warp(block.timestamp + RELEASE_WINDOW + 1);
        uint256 fee = arb.cost();
        vm.prank(buyer);
        escrow.openDispute{value: fee}(id);
        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.FEE_PENDING));

        vm.prank(seller);
        uint256 disputeId = escrow.payArbitrationFee{value: fee}(id);
        assertEq(escrow.disputeToTrade(address(arb), disputeId), id);
        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.DISPUTED));
    }

    function testSellerMayDisputeBeforeReleaseWindowEnds() public {
        uint256 id = _paid(100 * U);
        uint256 fee = arb.cost();
        vm.prank(seller);
        escrow.openDispute{value: fee}(id);
        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.FEE_PENDING));
    }

    function testDisputeFeeRequiredAndExcessRefunded() public {
        uint256 id = _paid(100 * U);
        uint256 fee = arb.cost();
        vm.prank(seller);
        vm.expectRevert("insufficient arbitration fee");
        escrow.openDispute{value: fee - 1}(id);

        uint256 before = seller.balance;
        vm.prank(seller);
        escrow.openDispute{value: 1 ether}(id);
        // Overpayment is credited for withdrawal (pull payments), not pushed back.
        assertEq(escrow.claimableNative(seller), 1 ether - fee);
        assertEq(escrow.getDispute(id).pool, fee);
        assertEq(address(escrow).balance, 1 ether);
        assertEq(address(arb).balance, 0); // no dispute exists until the counterparty pays

        vm.prank(seller);
        escrow.withdrawNative();
        assertEq(seller.balance, before - fee);
    }

    function testRulingForBuyer() public {
        uint256 id = _disputed(400 * U);
        arb.giveRuling(_disputeId(id), 1);
        assertEq(usdt.balanceOf(buyer), 400 * U);
        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.RELEASED));
    }

    function testRulingForSellerAndRefusalRestoreSeller() public {
        uint256 a = _disputed(400 * U);
        uint256 b = _disputed(100 * U);
        arb.giveRuling(_disputeId(a), 2);
        arb.giveRuling(_disputeId(b), 0);
        assertEq(escrow.freeBalance(seller, address(usdt)), 10_000 * U);
        assertEq(usdt.balanceOf(buyer), 0);
        assertEq(uint256(_state(a)), uint256(EscrowCoreV4.State.CANCELLED));
        assertEq(uint256(_state(b)), uint256(EscrowCoreV4.State.CANCELLED));
    }

    function testInvalidOrForeignRulingsRejected() public {
        uint256 id = _disputed(100 * U);
        uint256 disputeId = _disputeId(id);

        vm.expectRevert("invalid ruling");
        arb.giveRuling(disputeId, 3);

        // Not the arbitrator that created the dispute → cannot touch any trade.
        vm.prank(stranger);
        vm.expectRevert("unknown dispute");
        escrow.rule(disputeId, 1);

        MockArbitrator rogue = new MockArbitrator();
        vm.prank(address(rogue));
        vm.expectRevert("unknown dispute");
        escrow.rule(disputeId, 1);
    }

    function testConcessionDuringDisputeMakesLateRulingANoop() public {
        uint256 id = _disputed(100 * U);
        vm.prank(seller);
        escrow.release(id);

        arb.giveRuling(_disputeId(id), 2); // must not revert or claw back
        assertEq(usdt.balanceOf(buyer), 100 * U);
        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.RELEASED));

        uint256 id2 = _disputed(100 * U);
        vm.prank(buyer);
        escrow.buyerCancel(id2);
        arb.giveRuling(_disputeId(id2), 1);
        assertEq(usdt.balanceOf(buyer), 100 * U); // unchanged
        assertEq(uint256(_state(id2)), uint256(EscrowCoreV4.State.CANCELLED));
    }

    function testArbitrationTimeoutPreventsPermanentFreeze() public {
        uint256 id = _disputed(700 * U);
        // Nobody escalated: terminal default only after 2 x timeout.
        vm.warp(block.timestamp + 2 * uint256(ARB_TIMEOUT));
        vm.expectRevert("arbitration ongoing");
        escrow.claimArbitrationTimeout(id);

        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        escrow.claimArbitrationTimeout(id);
        assertEq(escrow.freeBalance(seller, address(usdt)), 10_000 * U);
    }

    function testEvidenceOnlyFromParties() public {
        uint256 id = _paid(100 * U);
        vm.prank(stranger);
        vm.expectRevert("only parties");
        escrow.submitEvidence(id, "ipfs://x");

        vm.prank(buyer);
        escrow.submitEvidence(id, "ipfs://encrypted-receipt");
    }

    // ─── Tokens ───────────────────────────────────────────────────────────────

    function testNonReturningTokenFullFlow() public {
        NoReturnToken nrt = new NoReturnToken();
        EscrowCoreV4 e = _deploy(address(nrt), address(arb));
        nrt.mint(seller, 1_000 * U);
        vm.startPrank(seller);
        nrt.approve(address(e), 1_000 * U);
        e.deposit(address(nrt), 1_000 * U);
        vm.stopPrank();

        EscrowCoreV4.Offer memory o = _offer();
        o.token = address(nrt);
        bytes memory sig = _signOffer(e, o);
        vm.prank(buyer);
        uint256 id = e.takeOffer(o, sig, 300 * U);
        vm.prank(seller);
        e.release(id);
        assertEq(nrt.balanceOf(buyer), 300 * U);
    }

    // ─── Fuzz: every settlement path conserves funds ──────────────────────────

    function testFuzzSettlementConservesFunds(uint256 amount, uint8 path) public {
        amount = bound(amount, 10 * U, 1_000 * U);
        path = uint8(bound(path, 0, 6));
        uint256 id = _paid(amount);
        bool buyerPaid;

        if (path == 0) {
            vm.prank(seller);
            escrow.release(id);
            buyerPaid = true;
        } else if (path == 1) {
            vm.prank(buyer);
            escrow.buyerCancel(id);
        } else {
            uint256 fee = arb.cost();
            vm.prank(seller);
            escrow.openDispute{value: fee}(id);
            vm.prank(buyer);
            escrow.payArbitrationFee{value: fee}(id);
            uint256 d = _disputeId(id);
            if (path == 2) {
                arb.giveRuling(d, 1);
                buyerPaid = true;
            } else if (path == 3) {
                arb.giveRuling(d, 2);
            } else if (path == 4) {
                vm.warp(block.timestamp + 2 * uint256(ARB_TIMEOUT) + 1);
                escrow.claimArbitrationTimeout(id);
            } else if (path == 5) {
                vm.prank(seller);
                escrow.release(id);
                arb.giveRuling(d, 2);
                buyerPaid = true;
            } else {
                vm.prank(buyer);
                escrow.buyerCancel(id);
                arb.giveRuling(d, 1);
            }
        }

        uint256 expectedBuyer = buyerPaid ? amount : 0;
        assertEq(usdt.balanceOf(buyer), expectedBuyer);
        assertEq(escrow.freeBalance(seller, address(usdt)), 10_000 * U - expectedBuyer);
        assertEq(usdt.balanceOf(address(escrow)), 10_000 * U - expectedBuyer);
    }
}
