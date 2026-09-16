// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title  MockUSDT
 * @notice Minimal ERC-20 for local dev and tests.
 *         Added Transfer and Approval events (ERC-20 spec requires them).
 *         Added mint access control — only deployer can mint.
 */
contract MockUSDT {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    address public immutable deployer;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ─── ERC-20 Events (required by spec) ────────────────────────────────────

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
        deployer = msg.sender;
    }

    // ─── Mint (deployer only) ─────────────────────────────────────────────────

    function mint(address to, uint256 amount) external {
        require(msg.sender == deployer, "only deployer");
        require(to != address(0), "zero address");
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    // ─── ERC-20 Core ──────────────────────────────────────────────────────────

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        emit Approval(msg.sender, spender, amt);
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(to != address(0), "zero address");
        require(balanceOf[msg.sender] >= amt, "insufficient balance");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        emit Transfer(msg.sender, to, amt);
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(to != address(0), "zero address");
        require(balanceOf[from] >= amt, "insufficient balance");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amt, "insufficient allowance");
        allowance[from][msg.sender] = allowed - amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        emit Transfer(from, to, amt);
        return true;
    }
}
