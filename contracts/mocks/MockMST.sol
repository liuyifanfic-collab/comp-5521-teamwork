// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// 本地单测用的 MST 替身（18 decimals），不参与部署。
contract MockMST is ERC20 {
    constructor() ERC20("My Simple Token", "MST") {
        _mint(msg.sender, 1_000_000 * 10 ** decimals());
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
