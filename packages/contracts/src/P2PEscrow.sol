// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
    P2PEscrow v3 — Roles, Pause, Dispute Timeout

    CHANGES FROM v2:
    ─────────────────────────────────────────────────────────────────────────────
    [1] Role separation. One key no longer does everything:
          owner         — admin (cold key / multisig). Rotates keys, pauses.
          backendSigner — signs EIP-712 authorizations only.
          operator      — hot key that sends createTrade / dispute txs.
        Dispute resolution needs BOTH the operator (msg.sender) AND a
        backendSigner signature, so a single leaked key cannot move funds.

    [2] Key rotation. backendSigner and operator are owner-settable.
        Ownership transfer is two-step (transferOwnership + acceptOwnership).

    [3] Pause. Blocks NEW money entering (createTrade, deposit) only.
        Every exit path (release, refund, resolutions, timeout claim) stays
        open so pausing can never trap user funds.

    [4] Dispute timeout. A dispute unresolved for DISPUTE_TIMEOUT can be
        closed by anyone, refunding the seller. Funds can no longer be frozen
        forever if the backend disappears.

    [5] Buyer dispute window. The buyer may only open a dispute up to
        fiatDeadline, so they cannot block the seller's refund after the
        deadline has passed. The operator may still dispute any LOCKED trade.

    [6] Dispute release uses its own ResolveRelease typehash, so a signature
        for release() can never be used for resolveDisputeRelease() or
        vice versa. EIP-712 domain version bumped to "3".

    Retained from v2: ReentrancyGuard, CEI ordering, EIP-712 digests, digest +
    nonce replay protection, signature malleability guard, safe ERC20 transfer
    helpers (non-returning tokens such as USDT), amount cap.
    ─────────────────────────────────────────────────────────────────────────────
*/

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract P2PEscrow {
    // ─── Constants ────────────────────────────────────────────────────────────

    /// Arbitrum One USDT
    address public constant USDT = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;

    /// Max trade size: 10,000,000 USDT (6 decimals)
    uint256 public constant MAX_AMOUNT = 10_000_000 * 1e6;

    /// How long a dispute may stay unresolved before anyone can refund the seller.
    uint64 public constant DISPUTE_TIMEOUT = 7 days;

    // ─── EIP-712 ──────────────────────────────────────────────────────────────

    bytes32 public immutable DOMAIN_SEPARATOR;

    /// Used ONLY by release()
    bytes32 public constant RELEASE_TYPEHASH =
        keccak256("Release(bytes32 tradeId,address buyer,uint256 amount,uint64 expiresAt,bytes32 nonce)");

    /// Used ONLY by resolveDisputeRelease()
    bytes32 public constant RESOLVE_RELEASE_TYPEHASH =
        keccak256("ResolveRelease(bytes32 tradeId,address buyer,uint256 amount,uint64 expiresAt,bytes32 nonce)");

    /// Used ONLY by resolveDisputeRefund()
    bytes32 public constant REFUND_TYPEHASH =
        keccak256("Refund(bytes32 tradeId,address seller,uint256 amount,uint64 expiresAt,bytes32 nonce)");

    // ─── Reentrancy Guard ─────────────────────────────────────────────────────

    uint256 private _reentrancyStatus;
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    modifier nonReentrant() {
        require(_reentrancyStatus != _ENTERED, "ReentrancyGuard: reentrant call");
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    // ─── State Machine ────────────────────────────────────────────────────────

    enum State {
        NONE,
        CREATED,
        LOCKED,
        RELEASED,
        REFUNDED,
        DISPUTE
    }

    struct Trade {
        address seller;
        address buyer;
        uint256 amount; // USDT (6 decimals)
        uint64 lockDeadline; // seller must deposit before this
        uint64 fiatDeadline; // fiat must be funded before this
        State state;
    }

    // ─── Roles ────────────────────────────────────────────────────────────────

    address public owner;
    address public pendingOwner;
    address public backendSigner;
    address public operator;
    bool public paused;

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "only operator");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    // ─── Storage ──────────────────────────────────────────────────────────────

    /// tradeId => Trade
    mapping(bytes32 => Trade) public trades;

    /// tradeId => nonce => used?
    mapping(bytes32 => mapping(bytes32 => bool)) public usedNonces;

    /// digest => used? (strong replay protection)
    mapping(bytes32 => bool) public usedDigest;

    /// tradeId => timestamp the dispute was opened (0 if never disputed)
    mapping(bytes32 => uint64) public disputeOpenedAt;

    // ─── Events ───────────────────────────────────────────────────────────────

    event TradeCreated(
        bytes32 indexed tradeId,
        address indexed seller,
        address indexed buyer,
        uint256 amount,
        uint64 lockDeadline,
        uint64 fiatDeadline
    );

    event CryptoDeposited(bytes32 indexed tradeId, address indexed seller, uint256 amount);
    event Released(bytes32 indexed tradeId, address indexed buyer, uint256 amount);
    event Refunded(bytes32 indexed tradeId, address indexed seller, uint256 amount);
    event DisputeOpened(bytes32 indexed tradeId, address indexed openedBy);
    event DisputeResolved(bytes32 indexed tradeId, bool releasedToBuyer);
    event DisputeTimedOut(bytes32 indexed tradeId, address indexed claimedBy);

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event BackendSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _owner, address _backendSigner, address _operator) {
        require(_owner != address(0), "owner required");
        require(_backendSigner != address(0), "backend signer required");
        require(_operator != address(0), "operator required");

        owner = _owner;
        backendSigner = _backendSigner;
        operator = _operator;
        _reentrancyStatus = _NOT_ENTERED;

        emit OwnershipTransferred(address(0), _owner);
        emit BackendSignerUpdated(address(0), _backendSigner);
        emit OperatorUpdated(address(0), _operator);

        // Cache EIP-712 domain separator at deploy time.
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("P2PEscrow"),
                keccak256("3"),
                block.chainid,
                address(this)
            )
        );
    }

    // ─── Token Selector ───────────────────────────────────────────────────────

    /// @dev Override in test subclass to point to MockUSDT.
    function _token() internal view virtual returns (address) {
        return USDT;
    }

    /// @dev Max amount — override in subclass if needed.
    function _maxAmount() internal view virtual returns (uint256) {
        return MAX_AMOUNT;
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Starts a two-step ownership transfer. Pass address(0) to cancel.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice Rotates the signing key. Outstanding signatures from the old key become invalid.
    function setBackendSigner(address newSigner) external onlyOwner {
        require(newSigner != address(0), "zero address");
        emit BackendSignerUpdated(backendSigner, newSigner);
        backendSigner = newSigner;
    }

    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "zero address");
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    /// @notice Blocks new trades and deposits. Exits (release/refund/resolution) stay open.
    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ─── Trade Creation ───────────────────────────────────────────────────────

    function createTrade(
        bytes32 tradeId,
        address seller,
        address buyer,
        uint256 amount,
        uint64 lockDeadline,
        uint64 fiatDeadline
    ) external onlyOperator whenNotPaused {
        require(trades[tradeId].state == State.NONE, "trade exists");
        require(seller != address(0) && buyer != address(0), "zero address");
        require(seller != buyer, "seller == buyer");
        require(amount > 0 && amount <= _maxAmount(), "bad amount");
        require(uint64(block.timestamp) < lockDeadline, "lockDeadline in past");
        require(lockDeadline < fiatDeadline, "bad deadlines");

        trades[tradeId] = Trade({
            seller: seller,
            buyer: buyer,
            amount: amount,
            lockDeadline: lockDeadline,
            fiatDeadline: fiatDeadline,
            state: State.CREATED
        });

        emit TradeCreated(tradeId, seller, buyer, amount, lockDeadline, fiatDeadline);
    }

    // ─── Seller Deposit ───────────────────────────────────────────────────────

    function deposit(bytes32 tradeId) external nonReentrant whenNotPaused {
        Trade storage t = trades[tradeId];

        require(t.state == State.CREATED, "not created");
        require(msg.sender == t.seller, "only seller");
        require(block.timestamp <= t.lockDeadline, "lock deadline passed");

        // CEI: update state BEFORE external call
        t.state = State.LOCKED;

        _safeTransferFrom(_token(), msg.sender, address(this), t.amount);

        emit CryptoDeposited(tradeId, msg.sender, t.amount);
    }

    // ─── Release ──────────────────────────────────────────────────────────────

    function release(bytes32 tradeId, uint64 expiresAt, bytes32 nonce, bytes calldata backendSig)
        external
        nonReentrant
    {
        Trade storage t = trades[tradeId];
        require(t.state == State.LOCKED, "not locked");

        _consumeAuthorization(
            tradeId,
            _digest(RELEASE_TYPEHASH, tradeId, t.buyer, t.amount, expiresAt, nonce),
            expiresAt,
            nonce,
            backendSig
        );

        // CEI: update state before transfer
        t.state = State.RELEASED;

        _safeTransfer(_token(), t.buyer, t.amount);

        emit Released(tradeId, t.buyer, t.amount);
    }

    // ─── Refund ───────────────────────────────────────────────────────────────

    function refund(bytes32 tradeId) external nonReentrant {
        Trade storage t = trades[tradeId];

        require(t.state != State.DISPUTE, "in dispute");

        // Seller never deposited — just close the trade, no token transfer needed
        if (t.state == State.CREATED) {
            require(block.timestamp > t.lockDeadline, "too early");
            t.state = State.REFUNDED;
            emit Refunded(tradeId, t.seller, 0);
            return;
        }

        require(t.state == State.LOCKED, "not refundable");
        require(block.timestamp > t.fiatDeadline, "too early");

        // CEI: update state before transfer
        t.state = State.REFUNDED;

        _safeTransfer(_token(), t.seller, t.amount);

        emit Refunded(tradeId, t.seller, t.amount);
    }

    // ─── Dispute ──────────────────────────────────────────────────────────────

    /**
     * @notice Opens a dispute, freezing funds until resolved or timed out.
     * @dev    Buyer may dispute only up to fiatDeadline (cannot block a due refund).
     *         Operator may dispute any LOCKED trade (e.g. fraud signals).
     *         Seller cannot dispute (v2 griefing fix).
     */
    function openDispute(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];

        require(t.state == State.LOCKED, "cannot dispute");

        if (msg.sender == t.buyer) {
            require(block.timestamp <= t.fiatDeadline, "dispute window closed");
        } else {
            require(msg.sender == operator, "not allowed");
        }

        t.state = State.DISPUTE;
        disputeOpenedAt[tradeId] = uint64(block.timestamp);
        emit DisputeOpened(tradeId, msg.sender);
    }

    // ─── Dispute Resolution ───────────────────────────────────────────────────

    function resolveDisputeRelease(bytes32 tradeId, uint64 expiresAt, bytes32 nonce, bytes calldata backendSig)
        external
        nonReentrant
        onlyOperator
    {
        Trade storage t = trades[tradeId];
        require(t.state == State.DISPUTE, "not in dispute");

        _consumeAuthorization(
            tradeId,
            _digest(RESOLVE_RELEASE_TYPEHASH, tradeId, t.buyer, t.amount, expiresAt, nonce),
            expiresAt,
            nonce,
            backendSig
        );

        t.state = State.RELEASED;

        _safeTransfer(_token(), t.buyer, t.amount);

        emit Released(tradeId, t.buyer, t.amount);
        emit DisputeResolved(tradeId, true);
    }

    function resolveDisputeRefund(bytes32 tradeId, uint64 expiresAt, bytes32 nonce, bytes calldata backendSig)
        external
        nonReentrant
        onlyOperator
    {
        Trade storage t = trades[tradeId];
        require(t.state == State.DISPUTE, "not in dispute");

        _consumeAuthorization(
            tradeId,
            _digest(REFUND_TYPEHASH, tradeId, t.seller, t.amount, expiresAt, nonce),
            expiresAt,
            nonce,
            backendSig
        );

        t.state = State.REFUNDED;

        _safeTransfer(_token(), t.seller, t.amount);

        emit Refunded(tradeId, t.seller, t.amount);
        emit DisputeResolved(tradeId, false);
    }

    /**
     * @notice Refunds the seller once a dispute has been unresolved for DISPUTE_TIMEOUT.
     *         Callable by anyone — guarantees funds are never frozen permanently.
     */
    function claimDisputeTimeout(bytes32 tradeId) external nonReentrant {
        Trade storage t = trades[tradeId];
        require(t.state == State.DISPUTE, "not in dispute");
        require(block.timestamp > uint256(disputeOpenedAt[tradeId]) + DISPUTE_TIMEOUT, "dispute not timed out");

        t.state = State.REFUNDED;

        _safeTransfer(_token(), t.seller, t.amount);

        emit Refunded(tradeId, t.seller, t.amount);
        emit DisputeTimedOut(tradeId, msg.sender);
    }

    // ─── Public Digest Helpers (for scripts / cast) ───────────────────────────

    function releaseDigest(bytes32 tradeId, uint64 expiresAt, bytes32 nonce) external view returns (bytes32) {
        Trade storage t = trades[tradeId];
        return _digest(RELEASE_TYPEHASH, tradeId, t.buyer, t.amount, expiresAt, nonce);
    }

    function resolveReleaseDigest(bytes32 tradeId, uint64 expiresAt, bytes32 nonce) external view returns (bytes32) {
        Trade storage t = trades[tradeId];
        return _digest(RESOLVE_RELEASE_TYPEHASH, tradeId, t.buyer, t.amount, expiresAt, nonce);
    }

    function refundDigest(bytes32 tradeId, uint64 expiresAt, bytes32 nonce) external view returns (bytes32) {
        Trade storage t = trades[tradeId];
        return _digest(REFUND_TYPEHASH, tradeId, t.seller, t.amount, expiresAt, nonce);
    }

    // ─── Internal: Authorization ──────────────────────────────────────────────

    /// @dev Checks expiry, replay and signer, then marks the authorization used.
    function _consumeAuthorization(
        bytes32 tradeId,
        bytes32 digest,
        uint64 expiresAt,
        bytes32 nonce,
        bytes calldata backendSig
    ) internal {
        require(block.timestamp <= expiresAt, "authorization expired");
        require(!usedDigest[digest], "digest used");
        require(!usedNonces[tradeId][nonce], "nonce used");
        require(_recoverSigner(digest, backendSig) == backendSigner, "invalid backend signature");

        usedDigest[digest] = true;
        usedNonces[tradeId][nonce] = true;
    }

    /// @dev EIP-712 digest. All three typehashes share the same field layout.
    function _digest(bytes32 typehash, bytes32 tradeId, address party, uint256 amount, uint64 expiresAt, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, tradeId, party, amount, expiresAt, nonce));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    // ─── Signature Recovery ───────────────────────────────────────────────────

    /**
     * @dev Recovers signer from an EIP-712 digest.
     *      The digest already contains the EIP-712 prefix (\x19\x01), so we
     *      pass it DIRECTLY to ecrecover — no extra \x19Ethereum wrapping.
     */
    function _recoverSigner(bytes32 digest, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig length");

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }

        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad v");

        // Malleability guard: s must be in lower half of curve order
        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "malleable signature");

        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0), "ecrecover failed");
        return recovered;
    }

    // ─── Safe Transfer Helpers ────────────────────────────────────────────────

    /**
     * @dev Handles ERC20s that don't return a bool (e.g. real USDT on some chains).
     *      Uses low-level call; reverts if call fails or returns false.
     *      Also reverts if the token has no code (a call to an EOA would "succeed").
     */
    function _safeTransfer(address token, address to, uint256 amount) internal {
        require(token.code.length > 0, "token has no code");
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "safeTransfer failed");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        require(token.code.length > 0, "token has no code");
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "safeTransferFrom failed");
    }
}
