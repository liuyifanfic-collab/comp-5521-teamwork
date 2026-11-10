// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IERC20HTLC.sol";

// 状态：None --lock--> Active --claim--> Claimed / --refund--> Refunded。
contract ERC20HTLC is IERC20HTLC, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Swap {
        address sender;
        address recipient;
        address token;
        uint256 amount;
        bytes32 hashlock;
        uint256 timelock;
        IERC20HTLC.SwapStatus status;
    }

    mapping(bytes32 => Swap) private swaps;
    uint256 private nonce;

    function getSwap(bytes32 swapId)
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
            s.token,
            s.amount,
            s.hashlock,
            s.timelock,
            uint8(s.status)
        );
    }

    function lock(
        address token,
        address recipient,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) external override nonReentrant returns (bytes32 swapId) {
        if (token == address(0)) revert InvalidToken();
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        if (hashlock == bytes32(0)) revert InvalidHashlock();
        if (timelock <= block.timestamp) revert InvalidTimelock();

        swapId = keccak256(
            abi.encode(block.chainid, address(this), msg.sender, nonce)
        );
        if (swaps[swapId].status != IERC20HTLC.SwapStatus.None) {
            revert SwapAlreadyExists(swapId);
        }

        // Effects 先于外部转账；失败时整笔交易回滚。
        swaps[swapId] = Swap({
            sender: msg.sender,
            recipient: recipient,
            token: token,
            amount: amount,
            hashlock: hashlock,
            timelock: timelock,
            status: IERC20HTLC.SwapStatus.Active
        });
        nonce++;

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Locked(
            swapId,
            msg.sender,
            recipient,
            token,
            amount,
            hashlock,
            timelock
        );
    }

    function claim(
        bytes32 swapId,
        bytes32 secret
    ) external override nonReentrant {
        Swap storage s = swaps[swapId];
        if (s.status == IERC20HTLC.SwapStatus.None) {
            revert SwapNotFound(swapId);
        }
        if (s.status != IERC20HTLC.SwapStatus.Active) {
            revert SwapNotActive(swapId);
        }
        if (msg.sender != s.recipient) {
            revert UnauthorizedReceiver(swapId, msg.sender);
        }
        if (block.timestamp >= s.timelock) revert SwapExpired(swapId);
        if (keccak256(abi.encodePacked(secret)) != s.hashlock) {
            revert InvalidSecret(swapId);
        }

        s.status = IERC20HTLC.SwapStatus.Claimed;
        IERC20(s.token).safeTransfer(s.recipient, s.amount);
        emit Claimed(swapId, secret);
    }

    function refund(bytes32 swapId) external override nonReentrant {
        Swap storage s = swaps[swapId];
        if (s.status == IERC20HTLC.SwapStatus.None) {
            revert SwapNotFound(swapId);
        }
        if (s.status != IERC20HTLC.SwapStatus.Active) {
            revert SwapNotActive(swapId);
        }
        if (msg.sender != s.sender) {
            revert UnauthorizedSender(swapId, msg.sender);
        }
        if (block.timestamp < s.timelock) revert SwapNotExpired(swapId);

        s.status = IERC20HTLC.SwapStatus.Refunded;
        IERC20(s.token).safeTransfer(s.sender, s.amount);
        emit Refunded(swapId);
    }

    // 直接转入的 ETH / MST 不形成有效 swap。
    receive() external payable {
        revert UnexpectedEther();
    }

    fallback() external payable {
        revert UnexpectedEther();
    }
}
