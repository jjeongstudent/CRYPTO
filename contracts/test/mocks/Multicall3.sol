// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Minimal Multicall3-compatible aggregator (aggregate3 only). The e2e test plants its
///      runtime code at the canonical Multicall3 address so viem's multicall works on anvil.
contract Multicall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory results) {
        results = new Result[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool success, bytes memory ret) = calls[i].target.call(calls[i].callData);
            require(success || calls[i].allowFailure, "Multicall3: call failed");
            results[i] = Result(success, ret);
        }
    }
}
