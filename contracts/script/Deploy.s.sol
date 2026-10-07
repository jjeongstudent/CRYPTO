// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Executor} from "../src/Executor.sol";

/// Usage:
///   OWNER=0xColdWallet OPERATOR=0xBotHotWallet \
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_KEY --broadcast
contract Deploy is Script {
    function run() external returns (Executor executor) {
        address owner = vm.envAddress("OWNER");
        address operator = vm.envAddress("OPERATOR");
        vm.startBroadcast();
        executor = new Executor(owner, operator);
        vm.stopBroadcast();
        console.log("Executor deployed at", address(executor));
        console.log("  owner   ", owner);
        console.log("  operator", operator);
    }
}
