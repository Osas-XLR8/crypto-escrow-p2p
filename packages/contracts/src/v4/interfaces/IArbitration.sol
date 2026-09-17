// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice ERC-792 arbitrator. Kleros courts implement this; a licensed arbitration firm can be
///         plugged in through an adapter contract exposing the same interface.
interface IArbitrator {
    function createDispute(uint256 choices, bytes calldata extraData) external payable returns (uint256 disputeID);

    function arbitrationCost(bytes calldata extraData) external view returns (uint256 cost);
}

/// @notice ERC-792 arbitrable. The arbitrator calls rule() to enforce its decision.
interface IArbitrable {
    /// @dev ERC-792: emitted when a ruling is given.
    event Ruling(IArbitrator indexed arbitrator, uint256 indexed disputeID, uint256 ruling);

    function rule(uint256 disputeID, uint256 ruling) external;
}

/// @notice Lets an arbitrator look up who is party to a dispute (e.g. for conflict-of-interest checks)
///         without relying on extraData, which Kleros courts interpret as court configuration.
interface IDisputeParties {
    function disputeParties(address arbitrator, uint256 disputeID) external view returns (address buyer, address seller);
}

/// @notice ERC-1497 evidence events, consumed by arbitrator front ends.
interface IEvidence {
    event Evidence(
        IArbitrator indexed arbitrator, uint256 indexed evidenceGroupID, address indexed party, string evidence
    );
}
