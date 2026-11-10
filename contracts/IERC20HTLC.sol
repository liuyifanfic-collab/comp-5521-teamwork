// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20HTLC {
    enum SwapStatus {
        None,
        Active,
        Claimed,
        Refunded
    }

    event Locked(
        bytes32 indexed swapId,
        address indexed sender,
        address indexed recipient,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    );
    event Claimed(bytes32 indexed swapId, bytes32 secret);
    event Refunded(bytes32 indexed swapId);

    error InvalidAddress();
    error InvalidToken();
    error InvalidAmount();
    error InvalidHashlock();
    error InvalidTimelock();
    error UnexpectedEther();
    error SwapAlreadyExists(bytes32 swapId);
    error SwapNotFound(bytes32 swapId);
    error SwapNotActive(bytes32 swapId);
    error UnauthorizedReceiver(bytes32 swapId, address caller);
    error UnauthorizedSender(bytes32 swapId, address caller);
    error SwapExpired(bytes32 swapId);
    error SwapNotExpired(bytes32 swapId);
    error InvalidSecret(bytes32 swapId);

    function lock(
        address token,
        address recipient,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) external returns (bytes32 swapId);

    function claim(bytes32 swapId, bytes32 secret) external;

    function refund(bytes32 swapId) external;

    function getSwap(bytes32 swapId)
        external
        view
        returns (
            address sender,
            address recipient,
            address token,
            uint256 amount,
            bytes32 hashlock,
            uint256 timelock,
            uint8 status
        );
}
