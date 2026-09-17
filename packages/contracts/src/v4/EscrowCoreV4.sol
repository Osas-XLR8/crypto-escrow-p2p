// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IArbitrator, IArbitrable, IEvidence} from "./interfaces/IArbitration.sol";

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
          • anyone can end a dispute the arbitrator never ruled on (after ARBITRATION_TIMEOUT),
            restoring the seller's position — funds can never be frozen permanently.

    [5] Disputes go to an independent ERC-792 arbitrator chosen in the offer (and therefore
        accepted by the buyer when taking it). The arbitrator can only send the locked amount
        to the buyer or back to the seller — never anywhere else.

    Retained from v3: EIP-712 domain separation, signature malleability guard, reentrancy guard,
    checks-effects-interactions, safe transfer helpers for non-standard tokens (USDT).

    NOT YET INCLUDED (planned): protocol/integrator fees, on-chain reputation counters, timelocked
    parameter registry, entry-time sanctions/credential checks, loser-pays arbitration fees.
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

contract EscrowCoreV4 is IArbitrable, IEvidence {
    // ─── Types ────────────────────────────────────────────────────────────────

    enum State {
        NONE,
        LOCKED, // buyer took the offer; seller's funds are locked
        PAID, // buyer declared the fiat payment sent
        DISPUTED, // arbitrator is deciding
        RELEASED, // funds sent to buyer (terminal)
        CANCELLED // funds returned to seller's vault (terminal)
    }

    enum CancelReason {
        BUYER_CANCELLED,
        PAYMENT_TIMEOUT,
        ARBITRATION_RULED_SELLER,
        ARBITRATION_TIMEOUT
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
        uint256 amount;
        bytes32 offerHash;
        bytes32 termsHash;
        uint64 paymentDeadline;
        uint64 releaseWindow;
        uint64 releaseDeadline; // set by markPaid
        uint64 disputedAt;
        uint256 disputeId;
        State state;
    }

    // ─── Constants ────────────────────────────────────────────────────────────

    uint64 public constant MIN_PAYMENT_WINDOW = 10 minutes;
    uint64 public constant MAX_PAYMENT_WINDOW = 3 hours;
    uint64 public constant MIN_RELEASE_WINDOW = 30 minutes;
    uint64 public constant MAX_RELEASE_WINDOW = 24 hours;
    uint64 public constant MIN_ARBITRATION_TIMEOUT = 7 days;
    uint64 public constant MAX_ARBITRATION_TIMEOUT = 90 days;

    /// @dev ERC-792 ruling options. 0 means the arbitrator refused to rule (treated as seller).
    uint256 public constant RULING_BUYER = 1;
    uint256 public constant RULING_SELLER = 2;
    uint256 public constant NUMBER_OF_CHOICES = 2;

    bytes32 public constant OFFER_TYPEHASH = keccak256(
        "Offer(address seller,address token,uint256 minAmount,uint256 maxAmount,uint256 totalAmount,uint64 paymentWindow,uint64 releaseWindow,address arbitrator,bytes32 termsHash,uint256 nonce,uint64 expiry,bytes32 salt)"
    );

    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("EscrowX");
    bytes32 private constant _VERSION_HASH = keccak256("4");

    // ─── Immutable configuration ──────────────────────────────────────────────

    uint64 public immutable ARBITRATION_TIMEOUT;
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

    mapping(uint256 => Trade) private _trades;
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
    event Released(uint256 indexed tradeId, address indexed buyer, uint256 amount, bool byArbitrator);
    event Cancelled(uint256 indexed tradeId, address indexed seller, uint256 amount, CancelReason reason);
    event DisputeOpened(uint256 indexed tradeId, uint256 indexed disputeId, address indexed openedBy);
    event RulingIgnored(uint256 indexed tradeId, uint256 indexed disputeId, uint256 ruling);

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier nonReentrant() {
        require(_reentrancyStatus == 1, "reentrant call");
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address[] memory tokens, address[] memory arbitrators, uint64 arbitrationTimeout) {
        require(tokens.length > 0, "no tokens");
        require(arbitrators.length > 0, "no arbitrators");
        require(
            arbitrationTimeout >= MIN_ARBITRATION_TIMEOUT && arbitrationTimeout <= MAX_ARBITRATION_TIMEOUT,
            "bad arbitration timeout"
        );

        for (uint256 i = 0; i < tokens.length; i++) {
            require(tokens[i].code.length > 0, "token has no code");
            supportedToken[tokens[i]] = true;
        }
        for (uint256 i = 0; i < arbitrators.length; i++) {
            require(arbitrators[i].code.length > 0, "arbitrator has no code");
            approvedArbitrator[arbitrators[i]] = true;
        }

        ARBITRATION_TIMEOUT = arbitrationTimeout;
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

    function _storeTrade(Offer calldata offer, bytes32 offerHash, uint256 amount) private returns (uint256 tradeId) {
        tradeId = ++tradeCount;
        Trade storage t = _trades[tradeId];
        t.seller = offer.seller;
        t.buyer = msg.sender;
        t.token = offer.token;
        t.arbitrator = offer.arbitrator;
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
    function release(uint256 tradeId) external nonReentrant {
        Trade storage t = _trades[tradeId];
        require(msg.sender == t.seller, "only seller");
        require(_isOpen(t.state), "trade not open");
        _payBuyer(tradeId, t, false);
    }

    /// @notice Buyer abandons the trade at any time; funds return to the seller's vault.
    function buyerCancel(uint256 tradeId) external nonReentrant {
        Trade storage t = _trades[tradeId];
        require(msg.sender == t.buyer, "only buyer");
        require(_isOpen(t.state), "trade not open");
        _returnToSeller(tradeId, t, CancelReason.BUYER_CANCELLED);
    }

    /// @notice Permissionless: closes a trade the buyer never marked paid.
    function cancelUnpaid(uint256 tradeId) external nonReentrant {
        Trade storage t = _trades[tradeId];
        require(t.state == State.LOCKED, "not locked");
        require(block.timestamp > t.paymentDeadline, "payment window open");
        _returnToSeller(tradeId, t, CancelReason.PAYMENT_TIMEOUT);
    }

    // ─── Disputes ─────────────────────────────────────────────────────────────

    /// @notice Buyer may dispute once the release window has passed; seller may dispute any paid trade.
    ///         Caller pays the arbitrator's fee in the native token; any excess is refunded.
    function openDispute(uint256 tradeId) external payable nonReentrant returns (uint256 disputeId) {
        Trade storage t = _trades[tradeId];
        require(t.state == State.PAID, "not paid");
        if (msg.sender == t.buyer) {
            require(block.timestamp > t.releaseDeadline, "release window open");
        } else {
            require(msg.sender == t.seller, "only parties");
        }

        IArbitrator arbitrator = IArbitrator(t.arbitrator);
        uint256 cost = arbitrator.arbitrationCost("");
        require(msg.value >= cost, "insufficient arbitration fee");

        t.state = State.DISPUTED;
        t.disputedAt = uint64(block.timestamp);

        disputeId = arbitrator.createDispute{value: cost}(NUMBER_OF_CHOICES, "");
        require(disputeToTrade[t.arbitrator][disputeId] == 0, "dispute id reused");
        disputeToTrade[t.arbitrator][disputeId] = tradeId;
        t.disputeId = disputeId;

        emit DisputeOpened(tradeId, disputeId, msg.sender);

        if (msg.value > cost) {
            (bool ok,) = msg.sender.call{value: msg.value - cost}("");
            require(ok, "refund failed");
        }
    }

    /// @notice ERC-1497 evidence pointer (e.g. URI of an encrypted blob). Parties only.
    function submitEvidence(uint256 tradeId, string calldata evidenceUri) external {
        Trade storage t = _trades[tradeId];
        require(msg.sender == t.buyer || msg.sender == t.seller, "only parties");
        require(t.state == State.PAID || t.state == State.DISPUTED, "no evidence stage");
        emit Evidence(IArbitrator(t.arbitrator), tradeId, msg.sender, evidenceUri);
    }

    /// @notice ERC-792 callback. Only the arbitrator that created the dispute can reach a trade.
    /// @dev Does not revert if a party already conceded, so the arbitrator's execution never gets stuck.
    function rule(uint256 disputeId, uint256 ruling) external override nonReentrant {
        uint256 tradeId = disputeToTrade[msg.sender][disputeId];
        require(tradeId != 0, "unknown dispute");
        require(ruling <= NUMBER_OF_CHOICES, "invalid ruling");

        emit Ruling(IArbitrator(msg.sender), disputeId, ruling);

        Trade storage t = _trades[tradeId];
        if (t.state != State.DISPUTED) {
            emit RulingIgnored(tradeId, disputeId, ruling);
            return;
        }

        if (ruling == RULING_BUYER) {
            _payBuyer(tradeId, t, true);
        } else {
            // RULING_SELLER, or 0 (arbitrator refused): restore the seller's original position.
            _returnToSeller(tradeId, t, CancelReason.ARBITRATION_RULED_SELLER);
        }
    }

    /// @notice Permissionless escape hatch if the arbitrator never rules.
    function claimArbitrationTimeout(uint256 tradeId) external nonReentrant {
        Trade storage t = _trades[tradeId];
        require(t.state == State.DISPUTED, "not disputed");
        require(block.timestamp > uint256(t.disputedAt) + ARBITRATION_TIMEOUT, "arbitration ongoing");
        _returnToSeller(tradeId, t, CancelReason.ARBITRATION_TIMEOUT);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getTrade(uint256 tradeId) external view returns (Trade memory) {
        return _trades[tradeId];
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

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _validateOffer(Offer calldata offer, bytes32 offerHash, bytes calldata signature, uint256 amount)
        internal
        view
    {
        require(offer.seller != address(0), "zero seller");
        require(msg.sender != offer.seller, "seller cannot take own offer");
        require(supportedToken[offer.token], "unsupported token");
        require(approvedArbitrator[offer.arbitrator], "arbitrator not approved");
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
        return s == State.LOCKED || s == State.PAID || s == State.DISPUTED;
    }

    function _payBuyer(uint256 tradeId, Trade storage t, bool byArbitrator) internal {
        t.state = State.RELEASED;
        _safeTransfer(t.token, t.buyer, t.amount);
        emit Released(tradeId, t.buyer, t.amount, byArbitrator);
    }

    function _returnToSeller(uint256 tradeId, Trade storage t, CancelReason reason) internal {
        t.state = State.CANCELLED;
        freeBalance[t.seller][t.token] += t.amount;
        // Cancelled amounts no longer count against the offer, so its capacity is restored.
        filled[t.offerHash] -= t.amount;
        emit Cancelled(tradeId, t.seller, t.amount, reason);
    }

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
