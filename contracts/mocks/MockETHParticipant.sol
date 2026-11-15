// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../IETHHTLC.sol";

// Local unit test for Mock ETH participant.
contract MockETHParticipant {
    error PaymentRejected();

    IETHHTLC private immutable htlc;
    bool private rejectPayments;
    bytes32 private observedSwapId;
    bytes private callbackData;
    uint256 private callbackValue;

    uint256 public paymentCount;
    uint8 public observedStatus;
    bool public callbackSucceeded;
    bytes public callbackResult;

    constructor(IETHHTLC htlc_) {
        htlc = htlc_;
    }

    function setRejectPayments(bool rejectPayments_) external {
        rejectPayments = rejectPayments_;
    }

    function configureCallback(
        bytes32 payoutSwapId,
        bytes calldata data,
        uint256 value
    ) external {
        observedSwapId = payoutSwapId;
        callbackData = data;
        callbackValue = value;
    }

    //updated by AI
    function execute(
        bytes calldata data
    ) external payable returns (bytes memory) {
        (bool success, bytes memory result) = address(htlc).call{
            value: msg.value
        }(data);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }

    receive() external payable {
        if (rejectPayments) revert PaymentRejected();

        paymentCount++;
        if (callbackData.length != 0) {
            (, , , , , , observedStatus) = htlc.getSwap(observedSwapId);
            (callbackSucceeded, callbackResult) = address(htlc).call{value: callbackValue}(callbackData);
        }
    }
}
