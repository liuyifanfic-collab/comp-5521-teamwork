// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IETHHTLC.sol";

contract ETHHTLC is IETHHTLC, ReentrancyGuard {

    struct Swap {
        address sender;
        address recipient;
        uint256 amount;
        bytes32 hashlock;
        uint256 timelock;
        IETHHTLC.SwapStatus status;
    }

    mapping(bytes32 => Swap) private swaps;

    uint256 private nonce;

    // using address(0) for native ETH since no token for native ETH
    function getSwap(
        bytes32 swapId
    )
        external
        view
        override
        returns (
            address sender,
            address recipient,
            address token,
            uint256 amount,
            bytes32 hashlock,
            uint256 timelock,
            uint8 status
        )
    {
        Swap storage s = swaps[swapId];
        return (
            s.sender,
            s.recipient,
            address(0),
            s.amount,
            s.hashlock,
            s.timelock,
            uint8(s.status)
        );
    }

    // lock msg.value for recipient until the lock time.
    function lock(
        address recipient,
        bytes32 hashlock,
        uint256 timelock
    ) external payable override nonReentrant returns (bytes32 swapId) {
        if (recipient == address(0)) revert InvalidAddress();
        if (msg.value == 0) revert InvalidAmount();
        if (hashlock == bytes32(0)) revert InvalidHashlock();
        if (timelock <= block.timestamp) revert InvalidTimelock();

        swapId = keccak256(abi.encode(block.chainid, address(this), msg.sender, nonce));

        if (swaps[swapId].status != IETHHTLC.SwapStatus.None) revert SwapAlreadyExists(swapId);

        swaps[swapId] = Swap({
            sender: msg.sender,
            recipient: recipient,
            amount: msg.value,
            hashlock: hashlock,
            timelock: timelock,
            status: IETHHTLC.SwapStatus.Active
        });

        nonce++;

        emit Locked(
            swapId,
            msg.sender,
            recipient,
            address(0),
            msg.value,
            hashlock,
            timelock
        );
    }

    // claim the native ETH for specified recipient
    function claim(
        bytes32 swapId,
        bytes32 secret
    ) external override nonReentrant {
        Swap storage s = swaps[swapId];

        if (s.status == IETHHTLC.SwapStatus.None) revert SwapNotFound(swapId);
        if (s.status != IETHHTLC.SwapStatus.Active) revert SwapNotActive(swapId);
        if (msg.sender != s.recipient) revert UnauthorizedReceiver(swapId, msg.sender);
        if (block.timestamp >= s.timelock) revert SwapExpired(swapId);
        if (keccak256(abi.encodePacked(secret)) != s.hashlock) revert InvalidSecret(swapId);

        s.status = IETHHTLC.SwapStatus.Claimed;
        (bool sent, ) = payable(s.recipient).call{value: s.amount}("");
        if (!sent) revert ETHTransferFailed(swapId);
        emit Claimed(swapId, secret);
    }

    // original owner can refund if no recipient claim and beyond the lock time
    function refund(bytes32 swapId) external override nonReentrant {
        Swap storage s = swaps[swapId];

        if (s.status == IETHHTLC.SwapStatus.None) revert SwapNotFound(swapId);
        if (s.status != IETHHTLC.SwapStatus.Active) revert SwapNotActive(swapId);
        if (msg.sender != s.sender) revert UnauthorizedSender(swapId, msg.sender);
        if (block.timestamp < s.timelock) revert SwapNotExpired(swapId);

        s.status = IETHHTLC.SwapStatus.Refunded;
        (bool sent, ) = payable(s.sender).call{value: s.amount}("");
        if (!sent) revert ETHTransferFailed(swapId);
        emit Refunded(swapId);
    }

    receive() external payable {
        revert UnexpectedEther();
    }

    fallback() external payable {
        revert UnexpectedEther();
    }
}
