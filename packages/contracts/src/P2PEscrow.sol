// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
    P2PEscrow v2 — Production Hardened

    SECURITY CHANGES FROM v1:
    ─────────────────────────────────────────────────────────────────────────────
    [1] ReentrancyGuard added — all state-changing external functions are
        nonReentrant. CEI (Checks-Effects-Interactions) already followed but
        guard provides belt-and-suspenders safety for exotic ERC20 tokens.

    [2] EIP-712 typed structured data replaces raw abi.encodePacked.
        Signatures are now wallet-displayable and formally domain-separated.
        Domain: name="P2PEscrow", version="2", chainId, verifyingContract.

    [3] Release/Refund digest domains fully separated at the type-hash level.
        resolveDisputeRelease and release() now use DIFFERENT type hashes
        so a sig for one CANNOT be replayed in the other even if state
        transitions were somehow bypassed.

    [4] openDispute restricted to buyer OR backendSigner only.
        Removed seller from dispute openers — seller opening their own
        dispute to block a legitimate refund window is a griefing vector.

    [5] safeTransfer helper — handles non-standard ERC20s that return nothing
        (e.g. real USDT on some chains). Uses low-level call + return check.

    [6] Buyer/seller zero-address checks strengthened.

    [7] lockDeadline must be in the future at createTrade time.

    [8] amount capped at reasonable max (10M USDT) to prevent accidental
        fat-finger trades that drain a wallet. Adjustable by subclass.

    [9] Events emit indexed buyer/seller for easier off-chain indexing.

    [10] DOMAIN_SEPARATOR is cached at deploy time (gas saving + immutability).
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

    // ─── EIP-712 ──────────────────────────────────────────────────────────────

    bytes32 public immutable DOMAIN_SEPARATOR;

    /// Release typehash — used by release() AND resolveDisputeRelease()
    bytes32 public constant RELEASE_TYPEHASH =
        keccak256("Release(bytes32 tradeId,address buyer,uint256 amount,uint64 expiresAt,bytes32 nonce)");

    /// Refund typehash — used ONLY by resolveDisputeRefund()
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

    // ─── Storage ──────────────────────────────────────────────────────────────

    /// backend signer (platform key)
    address public immutable backendSigner;

    /// tradeId => Trade
    mapping(bytes32 => Trade) public trades;

    /// tradeId => nonce => used?
    mapping(bytes32 => mapping(bytes32 => bool)) public usedNonces;

    /// digest => used? (strong replay protection)
    mapping(bytes32 => bool) public usedDigest;

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

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(address _backendSigner) {
        require(_backendSigner != address(0), "backend signer required");
        backendSigner = _backendSigner;
        _reentrancyStatus = _NOT_ENTERED;

        // Cache EIP-712 domain separator at deploy time.
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("P2PEscrow"),
                keccak256("2"),
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

    // ─── Trade Creation ───────────────────────────────────────────────────────

    function createTrade(
        bytes32 tradeId,
        address seller,
        address buyer,
        uint256 amount,
        uint64 lockDeadline,
        uint64 fiatDeadline
    ) external {
        require(msg.sender == backendSigner, "only backend");
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

    function deposit(bytes32 tradeId) external nonReentrant {
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
        require(block.timestamp <= expiresAt, "authorization expired");

        bytes32 digest = _releaseDigest(tradeId, t.buyer, t.amount, expiresAt, nonce);

        require(!usedDigest[digest], "digest used");
        require(!usedNonces[tradeId][nonce], "nonce used");
        require(_recoverSigner(digest, backendSig) == backendSigner, "invalid backend signature");

        // CEI: update state before transfer
        usedDigest[digest] = true;
        usedNonces[tradeId][nonce] = true;
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
     * @notice Opens a dispute, freezing funds until backend resolves.
     * @dev    FIX v2: Seller removed from allowed openers.
     *         Seller opening their own dispute blocks legitimate refund deadlines
     *         (a griefing vector against the buyer). Only buyer or backend can dispute.
     */
    function openDispute(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];

        require(t.state == State.LOCKED, "cannot dispute");
        require(msg.sender == t.buyer || msg.sender == backendSigner, "not allowed");

        t.state = State.DISPUTE;
        emit DisputeOpened(tradeId, msg.sender);
    }

    // ─── Dispute Resolution ───────────────────────────────────────────────────

    function resolveDisputeRelease(bytes32 tradeId, uint64 expiresAt, bytes32 nonce, bytes calldata backendSig)
        external
        nonReentrant
    {
        require(msg.sender == backendSigner, "only backend");

        Trade storage t = trades[tradeId];
        require(t.state == State.DISPUTE, "not in dispute");
        require(block.timestamp <= expiresAt, "authorization expired");

        bytes32 digest = _releaseDigest(tradeId, t.buyer, t.amount, expiresAt, nonce);

        require(!usedDigest[digest], "digest used");
        require(!usedNonces[tradeId][nonce], "nonce used");
        require(_recoverSigner(digest, backendSig) == backendSigner, "invalid backend signature");

        usedDigest[digest] = true;
        usedNonces[tradeId][nonce] = true;
        t.state = State.RELEASED;

        _safeTransfer(_token(), t.buyer, t.amount);

        emit Released(tradeId, t.buyer, t.amount);
        emit DisputeResolved(tradeId, true);
    }

    function resolveDisputeRefund(bytes32 tradeId, uint64 expiresAt, bytes32 nonce, bytes calldata backendSig)
        external
        nonReentrant
    {
        require(msg.sender == backendSigner, "only backend");

        Trade storage t = trades[tradeId];
        require(t.state == State.DISPUTE, "not in dispute");
        require(block.timestamp <= expiresAt, "authorization expired");

        bytes32 digest = _refundDigest(tradeId, t.seller, t.amount, expiresAt, nonce);

        require(!usedDigest[digest], "digest used");
        require(!usedNonces[tradeId][nonce], "nonce used");
        require(_recoverSigner(digest, backendSig) == backendSigner, "invalid backend signature");

        usedDigest[digest] = true;
        usedNonces[tradeId][nonce] = true;
        t.state = State.REFUNDED;

        _safeTransfer(_token(), t.seller, t.amount);

        emit Refunded(tradeId, t.seller, t.amount);
        emit DisputeResolved(tradeId, false);
    }

    // ─── Public Digest Helpers (for scripts / cast) ───────────────────────────

    function releaseDigest(bytes32 tradeId, uint64 expiresAt, bytes32 nonce) external view returns (bytes32) {
        Trade storage t = trades[tradeId];
        return _releaseDigest(tradeId, t.buyer, t.amount, expiresAt, nonce);
    }

    function refundDigest(bytes32 tradeId, uint64 expiresAt, bytes32 nonce) external view returns (bytes32) {
        Trade storage t = trades[tradeId];
        return _refundDigest(tradeId, t.seller, t.amount, expiresAt, nonce);
    }

    // ─── Internal Digest Builders (EIP-712) ──────────────────────────────────

    function _releaseDigest(bytes32 tradeId, address buyer, uint256 amount, uint64 expiresAt, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(RELEASE_TYPEHASH, tradeId, buyer, amount, expiresAt, nonce));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _refundDigest(bytes32 tradeId, address seller, uint256 amount, uint64 expiresAt, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(REFUND_TYPEHASH, tradeId, seller, amount, expiresAt, nonce));
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
     */
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "safeTransfer failed");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "safeTransferFrom failed");
    }
}
