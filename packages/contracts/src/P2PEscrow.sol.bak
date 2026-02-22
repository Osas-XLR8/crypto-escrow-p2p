// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
    P2PEscrow v1 (MVP)

    - Seller locks USDT into escrow
    - Buyer pays fiat off-chain
    - Backend confirms fiat funded and signs release authorization
    - Anyone can submit the signed release
    - Refunds happen automatically after deadline (EXCEPT when DISPUTE)
    - DISPUTE freezes funds until backend resolution function is called
*/

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract P2PEscrow {
    // Arbitrum USDT (ERC20)
    address public constant USDT = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;

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

    /// backend signer (platform key)
    address public immutable backendSigner;

    /// tradeId => Trade
    mapping(bytes32 => Trade) public trades;

    /// tradeId => nonce => used?
    mapping(bytes32 => mapping(bytes32 => bool)) public usedNonces;

    /// digest => used? (strong replay protection; lets us show "digest used" even after state changes)
    mapping(bytes32 => bool) public usedDigest;

    /* =========================
            EVENTS
       ========================= */

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

    event DisputeOpened(bytes32 indexed tradeId);

    /// When backend resolves a dispute (direction indicates which side received funds)
    event DisputeResolved(bytes32 indexed tradeId, bool releasedToBuyer);

    /* =========================
            CONSTRUCTOR
       ========================= */

    constructor(address _backendSigner) {
        require(_backendSigner != address(0), "backend signer required");
        backendSigner = _backendSigner;
    }

    /* =========================
          TOKEN SELECTOR
       ========================= */

    /// @dev v1 default uses Arbitrum USDT. Tests can override this in a derived contract.
    function _token() internal view virtual returns (address) {
        return USDT;
    }

    /* =========================
          TRADE CREATION
       ========================= */

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
        require(seller != address(0) && buyer != address(0), "bad address");
        require(amount > 0, "amount = 0");
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

    /* =========================
          SELLER DEPOSIT
       ========================= */

    function deposit(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];

        require(t.state == State.CREATED, "not created");
        require(msg.sender == t.seller, "only seller");
        require(block.timestamp <= t.lockDeadline, "lock deadline passed");

        t.state = State.LOCKED;

        require(IERC20(_token()).transferFrom(msg.sender, address(this), t.amount), "transferFrom failed");

        emit CryptoDeposited(tradeId, msg.sender, t.amount);
    }

    /* =========================
          RELEASE (FIAT FUNDED)
       ========================= */

    function release(bytes32 tradeId, uint64 expiresAt, bytes32 nonce, bytes calldata backendSig) external {
        Trade storage t = trades[tradeId];

        // Safest investor stance: DISPUTE freezes releases.
        require(t.state != State.DISPUTE, "in dispute");

        // Compute digest first so replay protection is provable even after state changes.
        bytes32 digest = _releaseDigest(tradeId, expiresAt, nonce);

        // Strong replay protection
        require(!usedDigest[digest], "digest used");
        require(!usedNonces[tradeId][nonce], "nonce used");

        require(block.timestamp <= expiresAt, "authorization expired");
        require(t.state == State.LOCKED, "not locked");

        require(_recoverSigner(digest, backendSig) == backendSigner, "invalid backend signature");

        usedDigest[digest] = true;
        usedNonces[tradeId][nonce] = true;

        t.state = State.RELEASED;

        require(IERC20(_token()).transfer(t.buyer, t.amount), "transfer failed");

        emit Released(tradeId, t.buyer, t.amount);
    }

    /* =========================
              REFUND
       ========================= */

    function refund(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];

        // Safest investor stance: DISPUTE freezes refunds too.
        require(t.state != State.DISPUTE, "in dispute");

        // Seller never deposited
        if (t.state == State.CREATED) {
            require(block.timestamp > t.lockDeadline, "too early");
            t.state = State.REFUNDED;
            emit Refunded(tradeId, t.seller, 0);
            return;
        }

        // Fiat never funded
        require(t.state == State.LOCKED, "not refundable");
        require(block.timestamp > t.fiatDeadline, "too early");

        t.state = State.REFUNDED;

        require(IERC20(_token()).transfer(t.seller, t.amount), "refund transfer failed");

        emit Refunded(tradeId, t.seller, t.amount);
    }

    /* =========================
             DISPUTE
       ========================= */

    function openDispute(bytes32 tradeId) external {
        Trade storage t = trades[tradeId];

        require(t.state == State.LOCKED, "cannot dispute");
        require(msg.sender == t.seller || msg.sender == t.buyer || msg.sender == backendSigner, "not allowed");

        t.state = State.DISPUTE;
        emit DisputeOpened(tradeId);
    }

    /* =========================
        DISPUTE RESOLUTION
       =========================
       Backend-only (investor-safe): explicit admin resolution path.
       Uses digests/nonce/signature rules for auditability and replay safety.
    */

    function resolveDisputeRelease(bytes32 tradeId, uint64 expiresAt, bytes32 nonce, bytes calldata backendSig)
        external
    {
        require(msg.sender == backendSigner, "only backend");
        Trade storage t = trades[tradeId];

        require(t.state == State.DISPUTE, "not in dispute");
        require(block.timestamp <= expiresAt, "authorization expired");

        bytes32 digest = _releaseDigest(tradeId, expiresAt, nonce);

        require(!usedDigest[digest], "digest used");
        require(!usedNonces[tradeId][nonce], "nonce used");

        require(_recoverSigner(digest, backendSig) == backendSigner, "invalid backend signature");

        usedDigest[digest] = true;
        usedNonces[tradeId][nonce] = true;

        t.state = State.RELEASED;

        require(IERC20(_token()).transfer(t.buyer, t.amount), "transfer failed");

        emit Released(tradeId, t.buyer, t.amount);
        emit DisputeResolved(tradeId, true);
    }

    function resolveDisputeRefund(bytes32 tradeId, uint64 expiresAt, bytes32 nonce, bytes calldata backendSig)
        external
    {
        require(msg.sender == backendSigner, "only backend");
        Trade storage t = trades[tradeId];

        require(t.state == State.DISPUTE, "not in dispute");
        require(block.timestamp <= expiresAt, "authorization expired");

        // ✅ Use a distinct digest domain for refunds (investor/audit clarity).
        bytes32 digest = _refundDigest(tradeId, expiresAt, nonce);

        require(!usedDigest[digest], "digest used");
        require(!usedNonces[tradeId][nonce], "nonce used");

        require(_recoverSigner(digest, backendSig) == backendSigner, "invalid backend signature");

        usedDigest[digest] = true;
        usedNonces[tradeId][nonce] = true;

        t.state = State.REFUNDED;

        require(IERC20(_token()).transfer(t.seller, t.amount), "refund transfer failed");

        emit Refunded(tradeId, t.seller, t.amount);
        emit DisputeResolved(tradeId, false);
    }

    /* =========================
           DIGEST HELPERS (PUBLIC)
       =========================
       These make it easy for scripts (cast) to reproduce exact digests.
    */

    function releaseDigest(bytes32 tradeId, uint64 expiresAt, bytes32 nonce) external view returns (bytes32) {
        return _releaseDigest(tradeId, expiresAt, nonce);
    }

    function refundDigest(bytes32 tradeId, uint64 expiresAt, bytes32 nonce) external view returns (bytes32) {
        return _refundDigest(tradeId, expiresAt, nonce);
    }

    /* =========================
           INTERNAL HELPERS
       ========================= */

    function _releaseDigest(bytes32 tradeId, uint64 expiresAt, bytes32 nonce) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "P2PEscrowRelease",
                block.chainid,
                address(this),
                tradeId,
                trades[tradeId].buyer,
                trades[tradeId].amount,
                expiresAt,
                nonce
            )
        );
    }

    function _refundDigest(bytes32 tradeId, uint64 expiresAt, bytes32 nonce) internal view returns (bytes32) {
        Trade storage t = trades[tradeId];
        return keccak256(
            abi.encodePacked(
                "P2PEscrowRefund", block.chainid, address(this), tradeId, t.seller, t.amount, expiresAt, nonce
            )
        );
    }

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

        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        return ecrecover(ethHash, v, r, s);
    }
}
