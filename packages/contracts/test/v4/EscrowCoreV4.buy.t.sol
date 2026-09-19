// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EscrowCoreV4} from "../../src/v4/EscrowCoreV4.sol";
import {V4TestBase} from "./V4TestBase.sol";

/// @notice Buy offers: a buyer signs "I want to buy", a seller fills it and their crypto is locked.
contract EscrowCoreV4BuyTest is V4TestBase {
    uint256 constant BUYER_PK = 0xB0B; // V4TestBase.buyer
    uint256 sellerTwoPk = 0x5E112;
    address sellerTwo = vm.addr(sellerTwoPk);

    function setUp() public override {
        super.setUp();
        usdt.mint(sellerTwo, 5_000 * U); // wallet only, empty vault
    }

    function _buyOffer() internal returns (EscrowCoreV4.BuyOffer memory o) {
        o = EscrowCoreV4.BuyOffer({
            buyer: buyer,
            token: address(usdt),
            minAmount: 10 * U,
            maxAmount: 1_000 * U,
            totalAmount: 2_000 * U,
            paymentWindow: PAY_WINDOW,
            releaseWindow: RELEASE_WINDOW,
            arbitrator: address(arb),
            fallbackArbitrator: address(arb2),
            termsHash: keccak256("NGN|1600.00|opay"),
            nonce: 0,
            expiry: uint64(block.timestamp + 1 days),
            salt: bytes32(++saltCounter)
        });
    }

    function _signBuy(EscrowCoreV4.BuyOffer memory o) internal view returns (bytes memory) {
        return _sign(BUYER_PK, escrow.hashBuyOffer(o));
    }

    function _takeBuy(address as_, EscrowCoreV4.BuyOffer memory o, uint256 amount) internal returns (uint256) {
        bytes memory sig = _signBuy(o);
        vm.prank(as_);
        return escrow.takeBuyOffer(o, sig, amount);
    }

    // ─── Opening ──────────────────────────────────────────────────────────────

    function testSellerFillsBuyOfferFromVault() public {
        EscrowCoreV4.BuyOffer memory o = _buyOffer();
        uint256 walletBefore = usdt.balanceOf(seller);

        uint256 id = _takeBuy(seller, o, 500 * U);

        EscrowCoreV4.Trade memory t = escrow.getTrade(id);
        assertEq(t.seller, seller);
        assertEq(t.buyer, buyer);
        assertEq(t.amount, 500 * U);
        assertEq(t.offerHash, escrow.hashBuyOffer(o));
        assertEq(t.arbitrator, address(arb));
        assertEq(uint256(t.state), uint256(EscrowCoreV4.State.LOCKED));
        assertEq(t.paymentDeadline, block.timestamp + PAY_WINDOW);
        assertEq(escrow.freeBalance(seller, address(usdt)), 9_500 * U);
        assertEq(usdt.balanceOf(seller), walletBefore, "vault covered it; wallet untouched");
        assertEq(escrow.filled(escrow.hashBuyOffer(o)), 500 * U);
    }

    function testShortfallIsPulledFromTheSellersWallet() public {
        EscrowCoreV4.BuyOffer memory o = _buyOffer();
        vm.startPrank(sellerTwo);
        usdt.approve(address(escrow), type(uint256).max);
        escrow.deposit(address(usdt), 100 * U);
        vm.stopPrank();

        uint256 id = _takeBuy(sellerTwo, o, 300 * U);

        assertEq(escrow.getTrade(id).seller, sellerTwo);
        assertEq(escrow.freeBalance(sellerTwo, address(usdt)), 0, "vault used first");
        assertEq(usdt.balanceOf(sellerTwo), 4_900 * U - 200 * U, "only the shortfall came from the wallet");
    }

    function testWalletFundingNeedsApproval() public {
        EscrowCoreV4.BuyOffer memory o = _buyOffer();
        bytes memory sig = _signBuy(o);
        vm.expectRevert("transferFrom failed");
        vm.prank(sellerTwo);
        escrow.takeBuyOffer(o, sig, 100 * U);
    }

    function testBuyerCannotFillOwnBuyOffer() public {
        EscrowCoreV4.BuyOffer memory o = _buyOffer();
        bytes memory sig = _signBuy(o);
        vm.expectRevert("cannot take own offer");
        vm.prank(buyer);
        escrow.takeBuyOffer(o, sig, 100 * U);
    }

    function testRejectsSignatureFromAnyoneButTheBuyer() public {
        EscrowCoreV4.BuyOffer memory o = _buyOffer();
        bytes memory forged = _sign(0xBAD, escrow.hashBuyOffer(o));
        vm.expectRevert("invalid maker signature");
        vm.prank(seller);
        escrow.takeBuyOffer(o, forged, 100 * U);
    }

    /// @dev A sell-offer signature over identical fields must not authorise a buy offer (or vice versa).
    function testSellAndBuySignaturesAreNotInterchangeable() public {
        EscrowCoreV4.BuyOffer memory b = _buyOffer();
        EscrowCoreV4.Offer memory asSell = EscrowCoreV4.Offer({
            seller: b.buyer,
            token: b.token,
            minAmount: b.minAmount,
            maxAmount: b.maxAmount,
            totalAmount: b.totalAmount,
            paymentWindow: b.paymentWindow,
            releaseWindow: b.releaseWindow,
            arbitrator: b.arbitrator,
            fallbackArbitrator: b.fallbackArbitrator,
            termsHash: b.termsHash,
            nonce: b.nonce,
            expiry: b.expiry,
            salt: b.salt
        });
        assertTrue(escrow.hashOffer(asSell) != escrow.hashBuyOffer(b), "distinct EIP-712 types");

        bytes memory sellSig = _sign(BUYER_PK, escrow.hashOffer(asSell));
        vm.expectRevert("invalid maker signature");
        vm.prank(seller);
        escrow.takeBuyOffer(b, sellSig, 100 * U);

        bytes memory buySig = _signBuy(b);
        vm.expectRevert("invalid maker signature");
        vm.prank(seller);
        escrow.takeOffer(asSell, buySig, 100 * U);
    }

    function testRejectsUnapprovedArbitrator() public {
        EscrowCoreV4.BuyOffer memory o = _buyOffer();
        o.arbitrator = address(0xA4B);
        bytes memory sig = _signBuy(o);
        vm.expectRevert("arbitrator not approved");
        vm.prank(seller);
        escrow.takeBuyOffer(o, sig, 100 * U);
    }

    // ─── Limits, capacity, cancellation ───────────────────────────────────────

    function testLimitsAndCapacity() public {
        EscrowCoreV4.BuyOffer memory o = _buyOffer();
        bytes memory sig = _signBuy(o);

        vm.expectRevert("amount out of range");
        vm.prank(seller);
        escrow.takeBuyOffer(o, sig, 5 * U);

        _takeBuy(seller, o, 1_000 * U);
        _takeBuy(seller, o, 900 * U);
        assertEq(escrow.remainingBuy(o), 100 * U);

        vm.expectRevert("offer capacity exceeded");
        vm.prank(seller);
        escrow.takeBuyOffer(o, sig, 101 * U);
    }

    function testExpiryAndNonceInvalidate() public {
        EscrowCoreV4.BuyOffer memory o = _buyOffer();
        bytes memory sig = _signBuy(o);

        vm.prank(buyer);
        escrow.bumpNonce(); // one call cancels all of the buyer's offers
        assertEq(escrow.remainingBuy(o), 0);
        vm.expectRevert("offer nonce invalid");
        vm.prank(seller);
        escrow.takeBuyOffer(o, sig, 100 * U);

        EscrowCoreV4.BuyOffer memory fresh = _buyOffer();
        fresh.nonce = 1;
        bytes memory freshSig = _signBuy(fresh);
        vm.warp(fresh.expiry + 1);
        assertEq(escrow.remainingBuy(fresh), 0);
        vm.expectRevert("offer expired");
        vm.prank(seller);
        escrow.takeBuyOffer(fresh, freshSig, 100 * U);
    }

    function testOnlyTheBuyerCanCancelTheirBuyOffer() public {
        EscrowCoreV4.BuyOffer memory o = _buyOffer();
        bytes memory sig = _signBuy(o);

        vm.expectRevert("only buyer");
        vm.prank(seller);
        escrow.cancelBuyOffer(o);

        vm.prank(buyer);
        escrow.cancelBuyOffer(o);
        assertEq(escrow.remainingBuy(o), 0);

        vm.expectRevert("offer cancelled");
        vm.prank(seller);
        escrow.takeBuyOffer(o, sig, 100 * U);
    }

    // ─── The resulting trade behaves exactly like any other ───────────────────

    function testFullTradeFromBuyOffer() public {
        uint256 id = _takeBuy(seller, _buyOffer(), 250 * U);

        vm.prank(buyer);
        escrow.markPaid(id, keccak256("receipt"));
        vm.prank(seller);
        escrow.release(id);

        assertEq(usdt.balanceOf(buyer), 250 * U);
        assertEq(uint256(_state(id)), uint256(EscrowCoreV4.State.RELEASED));
    }

    function testBuyerCancelReturnsCryptoToSellersVault() public {
        vm.startPrank(sellerTwo);
        usdt.approve(address(escrow), type(uint256).max);
        vm.stopPrank();
        uint256 id = _takeBuy(sellerTwo, _buyOffer(), 400 * U);

        vm.prank(buyer);
        escrow.buyerCancel(id);

        assertEq(escrow.freeBalance(sellerTwo, address(usdt)), 400 * U, "withdrawable by the seller");
        vm.prank(sellerTwo);
        escrow.withdraw(address(usdt), 400 * U);
        assertEq(usdt.balanceOf(sellerTwo), 5_000 * U);
    }

    function testDisputeFromBuyOfferTradeRulesForBuyer() public {
        uint256 id = _takeBuy(seller, _buyOffer(), 300 * U);
        vm.prank(buyer);
        escrow.markPaid(id, keccak256("receipt"));
        uint256 fee = arb.cost();
        vm.prank(seller);
        escrow.openDispute{value: fee}(id);
        vm.prank(buyer);
        escrow.payArbitrationFee{value: fee}(id);

        arb.giveRuling(_disputeId(id), escrow.RULING_BUYER());
        assertEq(usdt.balanceOf(buyer), 300 * U);
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    /// @dev Whatever mix of vault and wallet funds the seller uses, tokens are conserved exactly.
    function testFuzzFundingMixConservesTokens(uint256 vaultPart, uint256 amount) public {
        amount = bound(amount, 10 * U, 1_000 * U);
        vaultPart = bound(vaultPart, 0, amount);
        vm.startPrank(sellerTwo);
        usdt.approve(address(escrow), type(uint256).max);
        if (vaultPart > 0) escrow.deposit(address(usdt), vaultPart);
        vm.stopPrank();

        uint256 escrowBefore = usdt.balanceOf(address(escrow));
        uint256 walletBefore = usdt.balanceOf(sellerTwo);
        EscrowCoreV4.BuyOffer memory o = _buyOffer();
        _takeBuy(sellerTwo, o, amount);

        assertEq(escrow.freeBalance(sellerTwo, address(usdt)), 0);
        assertEq(walletBefore - usdt.balanceOf(sellerTwo), amount - vaultPart);
        assertEq(usdt.balanceOf(address(escrow)) - escrowBefore, amount - vaultPart);
    }
}
