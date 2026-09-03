// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CommitSwapHook} from "../src/CommitSwapHook.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";

/// @title DeployCommitSwapHookScript
/// @notice Deployment script for deploying CommitSwapHook on Base / Base Sepolia.
contract DeployCommitSwapHookScript is Script {
    using PoolIdLibrary for PoolKey;

    // Hook flags: BEFORE_SWAP_FLAG (1<<7) | BEFORE_SWAP_RETURNS_DELTA_FLAG (1<<3) = 136 (0x0088)
    uint160 constant HOOK_FLAGS = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);

    // Base Sepolia standard parameters
    uint256 constant WINDOW_BLOCKS = 5; // 5 blocks (~10 seconds on Base)
    uint256 constant MIN_BOND = 0.001 ether; // 0.001 ETH bond

    function run() external {
        uint256 deployerPrivateKey = vm.envOr(
            "PRIVATE_KEY",
            uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80) // Default Anvil key
        );

        address poolManagerAddress = vm.envOr(
            "POOL_MANAGER",
            address(0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f) // Placeholder or Anvil manager
        );

        bytes32 dummyPoolId = vm.envOr("POOL_ID", bytes32(uint256(0xBEEF)));

        vm.startBroadcast(deployerPrivateKey);

        console.log("--------------------------------------------------");
        console.log("Deploying CommitSwapHook on Base / Base Sepolia");
        console.log("PoolManager:", poolManagerAddress);
        console.log("Target Hook Flags:", HOOK_FLAGS);
        console.log("Window Blocks:", WINDOW_BLOCKS);
        console.log("Min Bond (ETH):", MIN_BOND);
        console.log("--------------------------------------------------");

        // Bytecode for CommitSwapHook deployment
        bytes memory constructorArgs = abi.encode(IPoolManager(poolManagerAddress), WINDOW_BLOCKS, MIN_BOND);

        bytes memory creationCode = abi.encodePacked(type(CommitSwapHook).creationCode, constructorArgs);

        address CREATE2_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        bytes32 initCodeHash = keccak256(creationCode);
        bytes32 salt;
        address predictedHookAddress;

        for (uint256 i = 0; i < 100000; i++) {
            salt = bytes32(i);
            predictedHookAddress = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, salt, initCodeHash))))
            );

            if (uint160(predictedHookAddress) & Hooks.ALL_HOOK_MASK == HOOK_FLAGS) {
                console.log("Found valid CREATE2 salt:", i);
                console.log("Predicted Hook Address:", predictedHookAddress);
                break;
            }
        }

        (bool success,) = CREATE2_FACTORY.call(abi.encodePacked(salt, creationCode));
        require(success, "CREATE2 deployment failed");
        console.log("CommitSwapHook successfully deployed at:", predictedHookAddress);

        vm.stopBroadcast();
    }
}
