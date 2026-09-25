// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IArbitrator, IArbitrable, IDisputeParties} from "../interfaces/IArbitration.sol";

/*
    LicensedArbitratorAdapter — ERC-792 arbitrator operated by an independent licensed arbitration firm

    WHO CONTROLS WHAT
    ─────────────────────────────────────────────────────────────────────────────
    • firmAdmin is the arbitration FIRM (e.g. its multisig) — never EscrowX. It manages its panel,
      assigns cases, sets its fee, and can veto a proposed ruling during the review period.
    • Panelists are the firm's individual arbitrators. Only the panelist assigned to a case can
      propose a ruling for it.
    • Nobody here can move escrowed funds. Rulings reach the escrow only through IArbitrable.rule,
      which can only send a trade's locked amount to its buyer or back to its seller. If the firm
      stalls or vetoes forever, the escrow's fallback arbitrator and timeouts still end the dispute.

    SAFEGUARDS
    ─────────────────────────────────────────────────────────────────────────────
    • Conflict of interest: a panelist who is the buyer or seller of the disputed trade cannot be
      assigned (parties are read from the escrow via IDisputeParties).
    • Two-person rule: a panelist's ruling only executes after REVIEW_PERIOD, during which the firm
      can veto it (every proposal and veto is an on-chain event, forming an audit trail). The firm may
      confirm a ruling before that period is up, but never one of its own — see executeRuling.
    • Evidence privacy: each panelist publishes an encryption public key; assignment emits it so the
      parties' clients can re-encrypt their evidence to the assigned panelist only.
    ─────────────────────────────────────────────────────────────────────────────
*/
contract LicensedArbitratorAdapter is IArbitrator {
    struct Case {
        IArbitrable arbitrable;
        uint256 choices;
        address assignee;
        uint256 proposedRuling;
        uint64 proposedAt;
        bool hasProposal;
        bool executed;
    }

    uint64 public constant MIN_REVIEW_PERIOD = 1 hours;
    uint64 public constant MAX_REVIEW_PERIOD = 7 days;

    uint64 public immutable REVIEW_PERIOD;

    address public firmAdmin;
    address public pendingFirmAdmin;
    address public treasury;
    uint256 public fee;
    uint256 public accruedFees;

    mapping(address => bool) public isPanelist;
    mapping(address => bytes) public encryptionKey;
    mapping(uint256 => Case) private _cases;
    uint256 public caseCount;

    /// @dev ERC-792 event.
    event DisputeCreation(uint256 indexed disputeID, IArbitrable indexed arbitrable);
    event PanelistUpdated(address indexed panelist, bool active, bytes encryptionKey);
    event CaseAssigned(uint256 indexed disputeID, address indexed panelist, bytes encryptionKey);
    event RulingProposed(uint256 indexed disputeID, address indexed panelist, uint256 ruling, bytes32 decisionHash);
    event ProposalVetoed(uint256 indexed disputeID, address indexed by, bytes32 reasonHash);
    event RulingExecuted(uint256 indexed disputeID, uint256 ruling);
    event FeeUpdated(uint256 fee);
    event TreasuryUpdated(address treasury);
    event FeesWithdrawn(address indexed treasury, uint256 amount);
    event FirmAdminTransferStarted(address indexed current, address indexed pending);
    event FirmAdminTransferred(address indexed previous, address indexed current);

    modifier onlyFirmAdmin() {
        require(msg.sender == firmAdmin, "only firm admin");
        _;
    }

    constructor(address firmAdmin_, address treasury_, uint256 fee_, uint64 reviewPeriod) {
        require(firmAdmin_ != address(0) && treasury_ != address(0), "zero address");
        require(reviewPeriod >= MIN_REVIEW_PERIOD && reviewPeriod <= MAX_REVIEW_PERIOD, "bad review period");
        firmAdmin = firmAdmin_;
        treasury = treasury_;
        fee = fee_;
        REVIEW_PERIOD = reviewPeriod;
        emit FirmAdminTransferred(address(0), firmAdmin_);
        emit FeeUpdated(fee_);
        emit TreasuryUpdated(treasury_);
    }

    // ─── ERC-792 ──────────────────────────────────────────────────────────────

    function arbitrationCost(bytes calldata) external view override returns (uint256) {
        return fee;
    }

    function createDispute(uint256 choices, bytes calldata) external payable override returns (uint256 disputeID) {
        require(choices >= 2, "need at least two choices");
        require(msg.value >= fee, "insufficient fee");

        disputeID = ++caseCount;
        Case storage c = _cases[disputeID];
        c.arbitrable = IArbitrable(msg.sender);
        c.choices = choices;
        accruedFees += msg.value;

        emit DisputeCreation(disputeID, IArbitrable(msg.sender));
    }

    // ─── Case handling ────────────────────────────────────────────────────────

    /// @notice Assigns (or reassigns) a case. Clears any pending proposal from a previous assignee.
    function assign(uint256 disputeID, address panelist) external onlyFirmAdmin {
        Case storage c = _existingCase(disputeID);
        require(!c.executed, "case closed");
        require(isPanelist[panelist], "not an active panelist");

        (bool ok, bytes memory ret) =
            address(c.arbitrable).staticcall(abi.encodeCall(IDisputeParties.disputeParties, (address(this), disputeID)));
        if (ok && ret.length >= 64) {
            (address buyer, address seller) = abi.decode(ret, (address, address));
            require(panelist != buyer && panelist != seller, "conflict of interest");
        }

        c.assignee = panelist;
        c.hasProposal = false;
        emit CaseAssigned(disputeID, panelist, encryptionKey[panelist]);
    }

    /// @param decisionHash hash of the reasoned written decision kept by the firm
    function proposeRuling(uint256 disputeID, uint256 ruling, bytes32 decisionHash) external {
        Case storage c = _existingCase(disputeID);
        require(!c.executed, "case closed");
        require(msg.sender == c.assignee, "only assigned panelist");
        require(isPanelist[msg.sender], "panelist deactivated");
        require(ruling <= c.choices, "invalid ruling");

        c.proposedRuling = ruling;
        c.proposedAt = uint64(block.timestamp);
        c.hasProposal = true;
        emit RulingProposed(disputeID, msg.sender, ruling, decisionHash);
    }

    /// @notice Firm-level review: reject a proposal before it becomes final.
    function vetoProposal(uint256 disputeID, bytes32 reasonHash) external onlyFirmAdmin {
        Case storage c = _existingCase(disputeID);
        require(!c.executed, "case closed");
        require(c.hasProposal, "no proposal");
        require(block.timestamp < uint256(c.proposedAt) + REVIEW_PERIOD, "review period over");

        c.hasProposal = false;
        emit ProposalVetoed(disputeID, msg.sender, reasonHash);
    }

    /// @notice Permissionless once the review period has passed without a veto.
    /// @dev The firm can confirm a ruling sooner, but only one it did not write itself. The review period
    /// exists to give the firm time to veto its panelist; the firm signing off in person is that review,
    /// happening early. A panelist who also holds the admin key gets no shortcut — one key can never both
    /// decide a case and finalise it without the full period elapsing.
    function executeRuling(uint256 disputeID) external {
        Case storage c = _existingCase(disputeID);
        require(!c.executed, "case closed");
        require(c.hasProposal, "no proposal");
        bool confirmedByFirm = msg.sender == firmAdmin && msg.sender != c.assignee;
        require(confirmedByFirm || block.timestamp >= uint256(c.proposedAt) + REVIEW_PERIOD, "review period active");

        c.executed = true;
        emit RulingExecuted(disputeID, c.proposedRuling);
        c.arbitrable.rule(disputeID, c.proposedRuling);
    }

    // ─── Firm administration ──────────────────────────────────────────────────

    function setPanelist(address panelist, bool active, bytes calldata key) external onlyFirmAdmin {
        require(panelist != address(0), "zero address");
        require(!active || key.length > 0, "encryption key required");
        isPanelist[panelist] = active;
        encryptionKey[panelist] = key;
        emit PanelistUpdated(panelist, active, key);
    }

    /// @notice Applies to disputes created after the change (escrows read the cost at creation time).
    function setFee(uint256 newFee) external onlyFirmAdmin {
        fee = newFee;
        emit FeeUpdated(newFee);
    }

    function setTreasury(address newTreasury) external onlyFirmAdmin {
        require(newTreasury != address(0), "zero address");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @notice Anyone can trigger; fees only ever go to the firm's treasury.
    function withdrawFees() external {
        uint256 amount = accruedFees;
        require(amount > 0, "nothing to withdraw");
        accruedFees = 0;
        (bool ok,) = treasury.call{value: amount}("");
        require(ok, "transfer failed");
        emit FeesWithdrawn(treasury, amount);
    }

    function transferFirmAdmin(address newAdmin) external onlyFirmAdmin {
        pendingFirmAdmin = newAdmin;
        emit FirmAdminTransferStarted(firmAdmin, newAdmin);
    }

    function acceptFirmAdmin() external {
        require(msg.sender == pendingFirmAdmin, "not pending admin");
        emit FirmAdminTransferred(firmAdmin, msg.sender);
        firmAdmin = msg.sender;
        pendingFirmAdmin = address(0);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getCase(uint256 disputeID) external view returns (Case memory) {
        return _cases[disputeID];
    }

    function _existingCase(uint256 disputeID) private view returns (Case storage c) {
        c = _cases[disputeID];
        require(address(c.arbitrable) != address(0), "unknown case");
    }
}
