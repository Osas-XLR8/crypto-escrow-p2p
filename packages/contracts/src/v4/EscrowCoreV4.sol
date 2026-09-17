// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IArbitrator, IArbitrable, IDisputeParties, IEvidence} from "./interfaces/IArbitration.sol";

/*
    EscrowCoreV4 — non-custodial P2P escrow core

    WHAT CHANGED FROM v3 (removes every path by which a company could move or freeze funds)
    ─────────────────────────────────────────────────────────────────────────────
    [1] No owner, operator, backend signer, pause, or upgrade proxy. There is no privileged
        address in this contract at all. Supported tokens and approved arbitrators are fixed
        at deployment; changing them means deploying a new version.

    [2] Only the SELLER can release locked funds to the buyer. v3's release() accepted a
        backend signature instead — that gave the platform functional control over sellers'
        money and is gone.

    [3] Trades are created by the BUYER taking a seller-signed EIP-712 offer. Sellers pre-fund
        a vault they alone can withdraw from; taking an offer atomically moves the amount from
        the seller's free balance into the trade. No operator creates trades.

    [4] Exits never depend on anyone but the parties:
          • buyer can cancel at any time (funds return to the seller's vault)
          • anyone can cancel an unpaid trade after the payment window
          • seller can release at any time, including during a dispute
          • a dispute can always be ended: fee default, fallback arbitrator, then a terminal
            timeout that restores the seller's position — funds can never be frozen permanently.

    [5] Disputes go to independent ERC-792 arbitrators chosen in the offer (and therefore
        accepted by the buyer when taking it). Arbitrators can only send the locked amount to the
        buyer or back to the seller — never anywhere else.

    DISPUTE ECONOMICS (loser pays)
    ─────────────────────────────────────────────────────────────────────────────
    • The party opening a dispute deposits the primary arbitrator's fee (FEE_PENDING).
    • The counterparty must match it within FEE_TIMEOUT, or the opener wins by default.
    • Once both have paid, the dispute is created and one fee goes to the arbitrator. The rest
      stays in the trade's pool. On settlement the winner is refunded up to what they paid and the
      remainder goes to the loser. Refusal to rule / terminal timeout splits the pool pro rata.
    • Conceding (seller release, buyer cancel) during a dispute counts as losing it.
    • If the primary arbitrator doesn't rule within ARBITRATION_TIMEOUT, either party may escalate
      to the offer's fallback arbitrator (fee paid from the pool; caller tops up any shortfall).
      The terminal timeout is reachable only after the fallback also times out, or after
      2 × ARBITRATION_TIMEOUT if nobody escalated.
    • All native-currency refunds are credited to claimableNative and pulled via withdrawNative(),
      so a party that rejects ETH can never block settlement.

    Retained from v3: EIP-712 domain separation, signature malleability guard, reentrancy guard,
    checks-effects-interactions, safe transfer helpers for non-standard tokens (USDT).

    NOT YET INCLUDED (planned): protocol/integrator fees, on-chain reputation counters, timelocked
    parameter registry, entry-time sanctions/credential checks.
    ─────────────────────────────────────────────────────────────────────────────
*/

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

contract EscrowCoreV4 is IArbitrable, IEvidence, IDisputeParties {
    // ─── Types ────────────────────────────────────────────────────────────────

    enum State {
        NONE,
        LOCKED, // buyer took the offer; seller's funds are locked
        PAID, // buyer declared the fiat payment sent
        FEE_PENDING, // a party opened a dispute; waiting for the counterparty's fee
        DISPUTED, // an arbitrator is deciding
        RELEASED, // funds sent to buyer (terminal)
        CANCELLED // funds returned to seller's vault (terminal)
    }

    enum Party {
        NONE,
        BUYER,
        SELLER
    }

    enum ReleaseReason {
        SELLER_RELEASED,
        ARBITRATION_RULED_BUYER,
        FEE_DEFAULT
    }

    enum CancelReason {
        BUYER_CANCELLED,
        PAYMENT_TIMEOUT,
        ARBITRATION_RULED_SELLER,
        ARBITRATION_REFUSED,
        ARBITRATION_TIMEOUT,
        FEE_DEFAULT
    }

    /// @notice Signed by the seller off-chain and published (e.g. to Nostr relays).
    /// @dev All members are static types, so abi.encode(TYPEHASH, offer) is the EIP-712 hashStruct.
    struct Offer {
        address seller;
        address token;
        uint256 minAmount; // per trade
        uint256 maxAmount; // per trade
        uint256 totalAmount; // cap across all open + completed trades from this offer
        uint64 paymentWindow; // buyer must mark paid within this
        uint64 releaseWindow; // seller's time to release after payment before buyer may dispute
        address arbitrator;
        address fallbackArbitrator;
        bytes32 termsHash; // hash of off-chain terms: fiat currency, price, payment rails
        uint256 nonce; // must equal sellerNonce[seller]; bumping it cancels all offers
        uint64 expiry;
        bytes32 salt;
    }

    struct Trade {
        address seller;
        address buyer;
        address token;
        address arbitrator;
        address fallbackArbitrator;
        address activeArbitrator; // arbitrator currently deciding (set when a dispute is created)
        uint256 amount;
        bytes32 offerHash;
        bytes32 termsHash;
        uint64 paymentDeadline;
        uint64 releaseWindow;
        uint64 releaseDeadline; // set by markPaid
        State state;
    }

    struct DisputeInfo {
        address opener;
        uint64 feeDeadline; // counterparty must match the fee by this time
        uint64 startedAt; // when the active arbitrator's dispute was created
        bool escalated;
        uint256 disputeId; // at the active arbitrator
        uint256 paidBuyer; // total native currency contributed by the buyer
        uint256 paidSeller;
        uint256 pool; // contributions not yet spent on arbitration fees
    }

    // ─── Constants ────────────────────────────────────────────────────────────

    uint64 public constant MIN_PAYMENT_WINDOW = 10 minutes;
    uint64 public constant MAX_PAYMENT_WINDOW = 3 hours;
    uint64 public constant MIN_RELEASE_WINDOW = 30 minutes;
    uint64 public constant MAX_RELEASE_WINDOW = 24 hours;
    uint64 public constant MIN_ARBITRATION_TIMEOUT = 7 days;
    uint64 public constant MAX_ARBITRATION_TIMEOUT = 90 days;
    uint64 public constant MIN_FEE_TIMEOUT = 1 days;
    uint64 public constant MAX_FEE_TIMEOUT = 7 days;

    /// @dev ERC-792 ruling options. 0 means the arbitrator refused to rule.
    uint256 public constant RULING_BUYER = 1;
    uint256 public constant RULING_SELLER = 2;
    uint256 public constant NUMBER_OF_CHOICES = 2;

    bytes32 public constant OFFER_TYPEHASH = keccak256(
        "Offer(address seller,address token,uint256 minAmount,uint256 maxAmount,uint256 totalAmount,uint64 paymentWindow,uint64 releaseWindow,address arbitrator,address fallbackArbitrator,bytes32 termsHash,uint256 nonce,uint64 expiry,bytes32 salt)"
    );

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("EscrowX");
    bytes32 private constant _VERSION_HASH = keccak256("4");

    // ─── Immutable configuration ──────────────────────────────────────────────

    uint64 public immutable ARBITRATION_TIMEOUT;
    uint64 public immutable FEE_TIMEOUT;
    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;

    /// @notice Set once in the constructor; no function can change these.
    mapping(address => bool) public supportedToken;
    mapping(address => bool) public approvedArbitrator;

    // ─── Storage ──────────────────────────────────────────────────────────────

    /// seller => token => balance not locked in any trade (withdrawable by the seller at any time)
    mapping(address => mapping(address => uint256)) public freeBalance;
    mapping(address => uint256) public sellerNonce;
    mapping(bytes32 => uint256) public filled;
    mapping(bytes32 => bool) public offerCancelled;
    /// arbitrator => disputeId => tradeId
    mapping(address => mapping(uint256 => uint256)) public disputeToTrade;
    /// Native currency (dispute fee refunds, overpayments) owed to an address; pulled via withdrawNative.
    mapping(address => uint256) public claimableNative;

    mapping(uint256 => Trade) private _trades;
    mapping(uint256 => DisputeInfo) private _disputes;
    uint256 public tradeCount;

    uint256 private _reentrancyStatus = 1;

    // ─── Events ───────────────────────────────────────────────────────────────

    event Deposited(address indexed seller, address indexed token, uint256 amount);
    event Withdrawn(address indexed seller, address indexed token, uint256 amount);
    event OfferCancelled(bytes32 indexed offerHash, address indexed seller);
    event NonceBumped(address indexed seller, uint256 newNonce);
    event TradeOpened(
        uint256 indexed tradeId,
        bytes32 indexed offerHash,
        address indexed buyer,
        address seller,
        address token,
        uint256 amount,
        address arbitrator,
        bytes32 termsHash,
        uint64 paymentDeadline
    );
    event PaymentMarked(uint256 indexed tradeId, bytes32 evidenceCommitment, uint64 releaseDeadline);
    event Released(uint256 indexed tradeId, address indexed buyer, uint256 amount, ReleaseReason reason);
    event Cancelled(uint256 indexed tradeId, address indexed seller, uint256 amount, CancelReason reason);
    event DisputeRequested(uint256 indexed tradeId, address indexed opener, uint256 feePaid, uint64 feeDeadline);
    event ArbitrationFeePaid(uint256 indexed tradeId, address indexed party, uint256 amount);
    event DisputeCreated(uint256 indexed tradeId, address indexed arbitrator, uint256 indexed disputeId, uint256 cost);
    event Escalated(uint256 indexed tradeId, address indexed by, address indexed fallbackArbitrator);
    event RulingIgnored(uint256 indexed tradeId, address indexed arbitrator, uint256 indexed disputeId, uint256 ruling);
    event FeesSettled(uint256 indexed tradeId, uint256 toBuyer, uint256 toSeller);
    event NativeWithdrawn(address indexed account, uint256 amount);

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier nonReentrant() {
        require(_reentrancyStatus == 1, "reentrant call");
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address[] memory tokens, address[] memory arbitrators, uint64 arbitrationTimeout, uint64 feeTimeout) {
        require(tokens.length > 0, "no tokens");
        require(arbitrators.length >= 2, "need primary and fallback arbitrators");
        require(
            arbitrationTimeout >= MIN_ARBITRATION_TIMEOUT && arbitrationTimeout <= MAX_ARBITRATION_TIMEOUT,
            "bad arbitration timeout"
        );
        require(feeTimeout >= MIN_FEE_TIMEOUT && feeTimeout <= MAX_FEE_TIMEOUT, "bad fee timeout");

        for (uint256 i = 0; i < tokens.length; i++) {
            require(tokens[i].code.length > 0, "token has no code");
            supportedToken[tokens[i]] = true;
        }
        for (uint256 i = 0; i < arbitrators.length; i++) {
            require(arbitrators[i].code.length > 0, "arbitrator has no code");
            approvedArbitrator[arbitrators[i]] = true;
        }

        ARBITRATION_TIMEOUT = arbitrationTimeout;
        FEE_TIMEOUT = feeTimeout;
        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    // ─── Seller vault ─────────────────────────────────────────────────────────

    /// @notice Credits the amount actually received (safe for tokens that take a transfer fee).
    function deposit(address token, uint256 amount) external nonReentrant {
        require(supportedToken[token], "unsupported token");
        require(amount > 0, "zero amount");

        uint256 before = IERC20Minimal(token).balanceOf(address(this));
        _safeTransferFrom(token, msg.sender, address(this), amount);
        uint256 received = IERC20Minimal(token).balanceOf(address(this)) - before;
        require(received > 0, "nothing received");

        freeBalance[msg.sender][token] += received;
        emit Deposited(msg.sender, token, received);
    }

    /// @notice Withdraws unlocked balance. Never pausable, never screened.
    function withdraw(address token, uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        uint256 free = freeBalance[msg.sender][token];
        require(free >= amount, "insufficient free balance");

        freeBalance[msg.sender][token] = free - amount;
        _safeTransfer(token, msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    /// @notice Pulls native currency owed from dispute fee settlements and overpayments.
    function withdrawNative() external nonReentrant {
        uint256 amount = claimableNative[msg.sender];
        require(amount > 0, "nothing to withdraw");
        claimableNative[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "native transfer failed");
        emit NativeWithdrawn(msg.sender, amount);
    }

    // ─── Offers ───────────────────────────────────────────────────────────────

    function cancelOffer(Offer calldata offer) external {
        require(msg.sender == offer.seller, "only seller");
        bytes32 h = hashOffer(offer);
        offerCancelled[h] = true;
        emit OfferCancelled(h, msg.sender);
    }

    /// @notice Invalidates every outstanding offer signed with the current nonce.
    function bumpNonce() external {
        uint256 n = ++sellerNonce[msg.sender];
        emit NonceBumped(msg.sender, n);
    }

    /// @notice Buyer takes `amount` from a seller-signed offer; funds lock atomically.
    function takeOffer(Offer calldata offer, bytes calldata signature, uint256 amount)
        external
        nonReentrant
        returns (uint256 tradeId)
    {
        bytes32 offerHash = hashOffer(offer);
        _validateOffer(offer, offerHash, signature, amount);

        uint256 free = freeBalance[offer.seller][offer.token];
        require(free >= amount, "insufficient seller balance");

        freeBalance[offer.seller][offer.token] = free - amount;
        filled[offerHash] += amount;

        tradeId = _storeTrade(offer, offerHash, amount);
        _emitTradeOpened(tradeId, _trades[tradeId]);
    }

    // ─── Trade lifecycle ──────────────────────────────────────────────────────

    /// @param evidenceCommitment hash of the encrypted payment evidence (revealed only in a dispute)
    function markPaid(uint256 tradeId, bytes32 evidenceCommitment) external {
        Trade storage t = _trades[tradeId];
        require(msg.sender == t.buyer, "only buyer");
        require(t.state == State.LOCKED, "not locked");
        require(block.timestamp <= t.paymentDeadline, "payment window closed");

        t.state = State.PAID;
        t.releaseDeadline = uint64(block.timestamp) + t.releaseWindow;
        emit PaymentMarked(tradeId, evidenceCommitment, t.releaseDeadline);
    }

    /// @notice The ONLY way funds reach the buyer without an arbitrator: the seller releases.
    ///         Releasing during a dispute concedes it (seller bears the arbitration cost).
    function release(uint256 tradeId) external nonReentrant {
        Trade storage t = _trades[tradeId];
        require(msg.sender == t.seller, "only seller");
        require(_isOpen(t.state), "trade not open");
        _settleFees(tradeId, t, Party.BUYER);
        _payBuyer(tradeId, t, ReleaseReason.SELLER_RELEASED);
    }

    /// @notice Buyer abandons the trade at any time; funds return to the seller's vault.
    ///         Cancelling during a dispute concedes it (buyer bears the arbitration cost).
    function buyerCancel(uint256 tradeId) external nonReentrant {
        Trade storage t = _trades[tradeId];
        require(msg.sender == t.buyer, "only buyer");
        require(_isOpen(t.state), "trade not open");
        _settleFees(tradeId, t, Party.SELLER);
        _returnToSeller(tradeId, t, CancelReason.BUYER_CANCELLED);
    }

    /// @notice Permissionless: closes a trade the buyer never marked paid.
    function cancelUnpaid(uint256 tradeId) external nonReentrant {
        Trade storage t = _trades[tradeId];
        require(t.state == State.LOCKED, "not locked");
        require(block.timestamp > t.paymentDeadline, "payment window open");
        _returnToSeller(tradeId, t, CancelReason.PAYMENT_TIMEOUT);
    }

    // ─── Disputes: fees ───────────────────────────────────────────────────────

    /// @notice Buyer may dispute once the release window has passed; seller may dispute any paid trade.
    ///         Opener deposits the primary arbitrator's fee; overpayment is credited to claimableNative.
    function openDispute(uint256 tradeId) external payable nonReentrant {
        Trade storage t = _trades[tradeId];
        require(t.state == State.PAID, "not paid");
        if (msg.sender == t.buyer) {
            require(block.timestamp > t.releaseDeadline, "release window open");
        } else {
            require(msg.sender == t.seller, "only parties");
        }

        uint256 cost = IArbitrator(t.arbitrator).arbitrationCost("");
        require(msg.value >= cost, "insufficient arbitration fee");

        DisputeInfo storage d = _disputes[tradeId];
        d.opener = msg.sender;
        d.feeDeadline = uint64(block.timestamp) + FEE_TIMEOUT;
        d.pool = cost;
        if (msg.sender == t.buyer) d.paidBuyer = cost;
        else d.paidSeller = cost;

        t.state = State.FEE_PENDING;
        _creditExcess(msg.value - cost);
        emit DisputeRequested(tradeId, msg.sender, cost, d.feeDeadline);
    }

    /// @notice Counterparty matches the fee; the dispute is created with the primary arbitrator.
    function payArbitrationFee(uint256 tradeId) external payable nonReentrant returns (uint256 disputeId) {
        Trade storage t = _trades[tradeId];
        DisputeInfo storage d = _disputes[tradeId];
        require(t.state == State.FEE_PENDING, "no fee pending");
        require(block.timestamp <= d.feeDeadline, "fee window closed");
        address counterparty = d.opener == t.buyer ? t.seller : t.buyer;
        require(msg.sender == counterparty, "only counterparty");

        uint256 cost = IArbitrator(t.arbitrator).arbitrationCost("");
        require(msg.value >= cost, "insufficient arbitration fee");

        if (msg.sender == t.buyer) d.paidBuyer += cost;
        else d.paidSeller += cost;
        d.pool += cost;
        _creditExcess(msg.value - cost);
        emit ArbitrationFeePaid(tradeId, msg.sender, cost);

        disputeId = _createDispute(tradeId, t, d, t.arbitrator);
    }

    /// @notice Permissionless: the counterparty didn't pay in time, so the opener wins by default.
    function claimFeeTimeout(uint256 tradeId) external nonReentrant {
        Trade storage t = _trades[tradeId];
        DisputeInfo storage d = _disputes[tradeId];
        require(t.state == State.FEE_PENDING, "no fee pending");
        require(block.timestamp > d.feeDeadline, "fee window open");

        if (d.opener == t.buyer) {
            _settleFees(tradeId, t, Party.BUYER);
            _payBuyer(tradeId, t, ReleaseReason.FEE_DEFAULT);
        } else {
            _settleFees(tradeId, t, Party.SELLER);
            _returnToSeller(tradeId, t, CancelReason.FEE_DEFAULT);
        }
    }

    // ─── Disputes: arbitration ────────────────────────────────────────────────

    /// @notice If the primary arbitrator hasn't ruled within ARBITRATION_TIMEOUT, a party may move the
    ///         dispute to the offer's fallback arbitrator. Its fee comes from the pool; caller covers any shortfall.
    function escalateToFallback(uint256 tradeId) external payable nonReentrant returns (uint256 disputeId) {
        Trade storage t = _trades[tradeId];
        DisputeInfo storage d = _disputes[tradeId];
        require(t.state == State.DISPUTED, "not disputed");
        require(msg.sender == t.buyer || msg.sender == t.seller, "only parties");
        require(!d.escalated, "already escalated");
        require(block.timestamp > uint256(d.startedAt) + ARBITRATION_TIMEOUT, "primary arbitrator still has time");

        uint256 cost = IArbitrator(t.fallbackArbitrator).arbitrationCost("");
        uint256 shortfall = cost > d.pool ? cost - d.pool : 0;
        require(msg.value >= shortfall, "insufficient arbitration fee");

        if (shortfall > 0) {
            if (msg.sender == t.buyer) d.paidBuyer += shortfall;
            else d.paidSeller += shortfall;
            d.pool += shortfall;
        }
        _creditExcess(msg.value - shortfall);

        d.escalated = true;
        emit Escalated(tradeId, msg.sender, t.fallbackArbitrator);
        disputeId = _createDispute(tradeId, t, d, t.fallbackArbitrator);
    }

    /// @notice ERC-792 callback. Only the currently active arbitrator's current dispute can settle a trade.
    /// @dev Stale or superseded rulings are ignored (not reverted) so the arbitrator's execution never gets stuck.
    function rule(uint256 disputeId, uint256 ruling) external override nonReentrant {
        uint256 tradeId = disputeToTrade[msg.sender][disputeId];
        require(tradeId != 0, "unknown dispute");
        require(ruling <= NUMBER_OF_CHOICES, "invalid ruling");

        emit Ruling(IArbitrator(msg.sender), disputeId, ruling);

        Trade storage t = _trades[tradeId];
        DisputeInfo storage d = _disputes[tradeId];
        if (t.state != State.DISPUTED || msg.sender != t.activeArbitrator || disputeId != d.disputeId) {
            emit RulingIgnored(tradeId, msg.sender, disputeId, ruling);
            return;
        }

        if (ruling == RULING_BUYER) {
            _settleFees(tradeId, t, Party.BUYER);
            _payBuyer(tradeId, t, ReleaseReason.ARBITRATION_RULED_BUYER);
        } else if (ruling == RULING_SELLER) {
            _settleFees(tradeId, t, Party.SELLER);
            _returnToSeller(tradeId, t, CancelReason.ARBITRATION_RULED_SELLER);
        } else {
            // Refused to arbitrate: restore the seller's original position, split fees pro rata.
            _settleFees(tradeId, t, Party.NONE);
            _returnToSeller(tradeId, t, CancelReason.ARBITRATION_REFUSED);
        }
    }

    /// @notice Terminal escape hatch: after the fallback arbitrator's timeout (or 2 × timeout if nobody
    ///         escalated), anyone can restore the seller's position. Fees are split pro rata.
    function claimArbitrationTimeout(uint256 tradeId) external nonReentrant {
        Trade storage t = _trades[tradeId];
        DisputeInfo storage d = _disputes[tradeId];
        require(t.state == State.DISPUTED, "not disputed");
        uint256 limit = d.escalated ? ARBITRATION_TIMEOUT : 2 * uint256(ARBITRATION_TIMEOUT);
        require(block.timestamp > uint256(d.startedAt) + limit, "arbitration ongoing");

        _settleFees(tradeId, t, Party.NONE);
        _returnToSeller(tradeId, t, CancelReason.ARBITRATION_TIMEOUT);
    }

    /// @notice ERC-1497 evidence pointer (e.g. URI of an encrypted blob). Parties only.
    function submitEvidence(uint256 tradeId, string calldata evidenceUri) external {
        Trade storage t = _trades[tradeId];
        require(msg.sender == t.buyer || msg.sender == t.seller, "only parties");
        require(t.state == State.PAID || t.state == State.FEE_PENDING || t.state == State.DISPUTED, "no evidence stage");
        address arbitrator = t.activeArbitrator == address(0) ? t.arbitrator : t.activeArbitrator;
        emit Evidence(IArbitrator(arbitrator), tradeId, msg.sender, evidenceUri);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getTrade(uint256 tradeId) external view returns (Trade memory) {
        return _trades[tradeId];
    }

    function getDispute(uint256 tradeId) external view returns (DisputeInfo memory) {
        return _disputes[tradeId];
    }

    /// @inheritdoc IDisputeParties
    function disputeParties(address arbitrator, uint256 disputeId)
        external
        view
        override
        returns (address buyer, address seller)
    {
        Trade storage t = _trades[disputeToTrade[arbitrator][disputeId]];
        return (t.buyer, t.seller);
    }

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _CACHED_CHAIN_ID ? _CACHED_DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    /// @notice EIP-712 digest the seller signs.
    function hashOffer(Offer calldata offer) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(OFFER_TYPEHASH, offer))));
    }

    /// @notice How much more can be taken from an offer right now (0 if it can't be taken at all).
    function remaining(Offer calldata offer) external view returns (uint256) {
        bytes32 h = hashOffer(offer);
        if (offerCancelled[h] || offer.nonce != sellerNonce[offer.seller] || block.timestamp > offer.expiry) return 0;
        uint256 left = offer.totalAmount > filled[h] ? offer.totalAmount - filled[h] : 0;
        uint256 free = freeBalance[offer.seller][offer.token];
        return left < free ? left : free;
    }

    // ─── Internal: trades ─────────────────────────────────────────────────────

    function _storeTrade(Offer calldata offer, bytes32 offerHash, uint256 amount) private returns (uint256 tradeId) {
        tradeId = ++tradeCount;
        Trade storage t = _trades[tradeId];
        t.seller = offer.seller;
        t.buyer = msg.sender;
        t.token = offer.token;
        t.arbitrator = offer.arbitrator;
        t.fallbackArbitrator = offer.fallbackArbitrator;
        t.amount = amount;
        t.offerHash = offerHash;
        t.termsHash = offer.termsHash;
        t.paymentDeadline = uint64(block.timestamp) + offer.paymentWindow;
        t.releaseWindow = offer.releaseWindow;
        t.state = State.LOCKED;
    }

    function _emitTradeOpened(uint256 tradeId, Trade storage t) private {
        emit TradeOpened(
            tradeId, t.offerHash, t.buyer, t.seller, t.token, t.amount, t.arbitrator, t.termsHash, t.paymentDeadline
        );
    }

    function _validateOffer(Offer calldata offer, bytes32 offerHash, bytes calldata signature, uint256 amount)
        internal
        view
    {
        require(offer.seller != address(0), "zero seller");
        require(msg.sender != offer.seller, "seller cannot take own offer");
        require(supportedToken[offer.token], "unsupported token");
        require(approvedArbitrator[offer.arbitrator], "arbitrator not approved");
        require(approvedArbitrator[offer.fallbackArbitrator], "fallback arbitrator not approved");
        require(offer.fallbackArbitrator != offer.arbitrator, "fallback must differ from primary");
        require(
            offer.paymentWindow >= MIN_PAYMENT_WINDOW && offer.paymentWindow <= MAX_PAYMENT_WINDOW, "bad payment window"
        );
        require(
            offer.releaseWindow >= MIN_RELEASE_WINDOW && offer.releaseWindow <= MAX_RELEASE_WINDOW, "bad release window"
        );
        require(block.timestamp <= offer.expiry, "offer expired");
        require(offer.nonce == sellerNonce[offer.seller], "offer nonce invalid");
        require(!offerCancelled[offerHash], "offer cancelled");
        require(offer.minAmount > 0 && offer.minAmount <= offer.maxAmount, "bad offer limits");
        require(amount >= offer.minAmount && amount <= offer.maxAmount, "amount out of range");
        require(filled[offerHash] + amount <= offer.totalAmount, "offer capacity exceeded");
        require(_isValidSignature(offer.seller, offerHash, signature), "invalid seller signature");
    }

    function _isOpen(State s) internal pure returns (bool) {
        return s == State.LOCKED || s == State.PAID || s == State.FEE_PENDING || s == State.DISPUTED;
    }

    function _payBuyer(uint256 tradeId, Trade storage t, ReleaseReason reason) internal {
        t.state = State.RELEASED;
        _safeTransfer(t.token, t.buyer, t.amount);
        emit Released(tradeId, t.buyer, t.amount, reason);
    }

    function _returnToSeller(uint256 tradeId, Trade storage t, CancelReason reason) internal {
        t.state = State.CANCELLED;
        freeBalance[t.seller][t.token] += t.amount;
        // Cancelled amounts no longer count against the offer, so its capacity is restored.
        filled[t.offerHash] -= t.amount;
        emit Cancelled(tradeId, t.seller, t.amount, reason);
    }

    // ─── Internal: disputes ───────────────────────────────────────────────────

    /// @dev Pays the arbitrator from the pool. Caller must have ensured the pool covers the cost.
    function _createDispute(uint256 tradeId, Trade storage t, DisputeInfo storage d, address arbitrator)
        internal
        returns (uint256 disputeId)
    {
        uint256 cost = IArbitrator(arbitrator).arbitrationCost("");
        require(d.pool >= cost, "pool below arbitration cost");

        d.pool -= cost;
        d.startedAt = uint64(block.timestamp);
        t.state = State.DISPUTED;
        t.activeArbitrator = arbitrator;

        disputeId = IArbitrator(arbitrator).createDispute{value: cost}(NUMBER_OF_CHOICES, "");
        require(disputeToTrade[arbitrator][disputeId] == 0, "dispute id reused");
        disputeToTrade[arbitrator][disputeId] = tradeId;
        d.disputeId = disputeId;

        emit DisputeCreated(tradeId, arbitrator, disputeId, cost);
    }

    /// @dev Loser pays: winner is refunded up to what they contributed, the loser gets whatever is left.
    ///      With no winner (refusal / timeout) the pool is split pro rata to contributions.
    function _settleFees(uint256 tradeId, Trade storage t, Party winner) internal {
        DisputeInfo storage d = _disputes[tradeId];
        uint256 pool = d.pool;
        if (pool == 0) return;
        d.pool = 0;

        uint256 toBuyer;
        if (winner == Party.BUYER) {
            toBuyer = d.paidBuyer < pool ? d.paidBuyer : pool;
        } else if (winner == Party.SELLER) {
            uint256 toSellerFirst = d.paidSeller < pool ? d.paidSeller : pool;
            toBuyer = pool - toSellerFirst;
        } else {
            toBuyer = (pool * d.paidBuyer) / (d.paidBuyer + d.paidSeller);
        }
        uint256 toSeller = pool - toBuyer;

        if (toBuyer > 0) claimableNative[t.buyer] += toBuyer;
        if (toSeller > 0) claimableNative[t.seller] += toSeller;
        emit FeesSettled(tradeId, toBuyer, toSeller);
    }

    function _creditExcess(uint256 amount) internal {
        if (amount > 0) claimableNative[msg.sender] += amount;
    }

    // ─── Internal: crypto & transfers ─────────────────────────────────────────

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }

    /// @dev EOA signature (low-s, 65 bytes) first; falls back to ERC-1271 for contract wallets.
    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        if (signature.length == 65) {
            bytes32 r = bytes32(signature[0:32]);
            bytes32 s = bytes32(signature[32:64]);
            uint8 v = uint8(signature[64]);
            if (v < 27) v += 27;
            if (
                (v == 27 || v == 28) && uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
            ) {
                address recovered = ecrecover(digest, v, r, s);
                if (recovered != address(0) && recovered == signer) return true;
            }
        }
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) =
                signer.staticcall(abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, signature));
            return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == IERC1271.isValidSignature.selector;
        }
        return false;
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transferFrom failed");
    }
}
