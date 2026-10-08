// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Executor} from "../src/Executor.sol";

/// Usage:
///   OWNER=0xColdWallet OPERATOR=0xBotHotWallet \
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_KEY --broadcast
/// Optional: POOL_MANAGER (Uniswap V4; 0x0 disables V4 hops) and WETH, both defaulting to Base mainnet.
contract Deploy is Script {
    address internal constant BASE_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address internal constant BASE_WETH = 0x4200000000000000000000000000000000000006;

    function run() external returns (Executor executor) {
        address owner = vm.envAddress("OWNER");
        address operator = vm.envAddress("OPERATOR");
        address poolManager = vm.envOr("POOL_MANAGER", BASE_POOL_MANAGER);
        address weth = vm.envOr("WETH", BASE_WETH);
        vm.startBroadcast();
        executor = new Executor(owner, operator, poolManager, weth);
        vm.stopBroadcast();
        console.log("Executor deployed at", address(executor));
        console.log("  owner       ", owner);
        console.log("  operator    ", operator);
        console.log("  poolManager ", poolManager);
        console.log("  weth        ", weth);
    }
}
