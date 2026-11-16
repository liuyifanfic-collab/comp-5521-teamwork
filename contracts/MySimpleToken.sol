// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Official COMP5521 Lab 3 educational MST token, copied from
// https://github.com/leid19/Lab3-COMP5521-2026/blob/main/contracts/MySimpleToken.sol
// so the team can deploy the token required by the cross-chain project if no
// pre-deployed MST address is available. MST is not a production stablecoin.
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract MySimpleToken is ERC20, Ownable {
    // The deployer becomes the owner and is therefore allowed to mint.
    constructor() ERC20("My Simple Token", "MST") Ownable(msg.sender) {}

    // Create new tokens and allocate them to an account. Only the owner can call.
    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }
}
