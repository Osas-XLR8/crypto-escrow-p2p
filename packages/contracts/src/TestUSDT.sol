// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  TestUSDT
/// @notice Worthless 6-decimal test token for public testnets, with a rate-limited public faucet so
///         anyone trying the app can get a balance without asking the deployer.
/// @dev    Deliberately named "EscrowX Test USD" / "tUSDT" so it can't be mistaken for Tether.
contract TestUSDT {
    string public constant name = "EscrowX Test USD";
    string public constant symbol = "tUSDT";
    uint8 public constant decimals = 6;

    uint256 public constant FAUCET_AMOUNT = 1_000e6;
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    address public immutable deployer;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public lastFaucet;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        deployer = msg.sender;
    }

    /// @notice Sends FAUCET_AMOUNT to the caller, at most once per FAUCET_COOLDOWN.
    function faucet() external {
        require(block.timestamp >= faucetAvailableAt(msg.sender), "faucet cooldown");
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice When `account` can next use the faucet (0 if it never has).
    function faucetAvailableAt(address account) public view returns (uint256) {
        uint256 last = lastFaucet[account];
        return last == 0 ? 0 : last + FAUCET_COOLDOWN;
    }

    /// @notice Deployer-only mint, for seeding demo accounts.
    function mint(address to, uint256 amount) external {
        require(msg.sender == deployer, "only deployer");
        _mint(to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "insufficient allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(to != address(0), "zero address");
        require(balanceOf[from] >= amount, "insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) private {
        require(to != address(0), "zero address");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
}
