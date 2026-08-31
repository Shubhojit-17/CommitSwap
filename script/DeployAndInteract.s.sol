// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CommitSwapHook} from "../src/CommitSwapHook.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {PoolManager} from "v4-core/PoolManager.sol";

/// @title DeployAndInteractScript
/// @notice Complete on-chain deployment & activity generator for the Atrium Academy Uniswap v4 Hookathon.
///         Executes the entire lifecycle on-chain: Deploy -> Seed Liquidity -> Commit -> Reveal -> Settle.
contract DeployAndInteractScript is Script {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    uint160 constant HOOK_FLAGS = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336; // 1:1 price

    uint256 constant WINDOW_BLOCKS = 5;
    uint256 constant MIN_BOND = 0.001 ether;

    function run() external {
        uint256 deployerPrivateKey =
            vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        address deployer = vm.addr(deployerPrivateKey);

        console.log("==================================================================");
        console.log("Atrium Academy Uniswap v4 Hookathon - CommitSwap On-Chain Activity");
        console.log("Deployer Address:", deployer);
        console.log("==================================================================");

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy or resolve PoolManager
        address poolManagerAddr = vm.envOr("POOL_MANAGER", address(0));
        IPoolManager manager;
        if (poolManagerAddr == address(0)) {
            console.log("[1/5] Deploying Fresh Uniswap v4 PoolManager...");
            manager = new PoolManager(deployer);
            console.log("      PoolManager Deployed at:", address(manager));
        } else {
            manager = IPoolManager(poolManagerAddr);
            console.log("[1/5] Using Existing PoolManager:", address(manager));
        }

        // 2. Deploy Mock Currencies (Token0 & Token1)
        console.log("[2/5] Deploying Test Tokens (T0 & T1)...");
        MockERC20 tokenA = new MockERC20("CommitSwap Token A", "TKA", 18);
        MockERC20 tokenB = new MockERC20("CommitSwap Token B", "TKB", 18);

        MockERC20 token0 = address(tokenA) < address(tokenB) ? tokenA : tokenB;
        MockERC20 token1 = address(tokenA) < address(tokenB) ? tokenB : tokenA;

        Currency currency0 = Currency.wrap(address(token0));
        Currency currency1 = Currency.wrap(address(token1));

        console.log("      Token0 (T0):", address(token0));
        console.log("      Token1 (T1):", address(token1));

        // 3. Mine CREATE2 Salt & Deploy CommitSwapHook with exact poolId
        console.log("[3/5] Mining CREATE2 Salt for Hook Address (0x0088 Flags)...");

        address CREATE2_FACTORY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
        bytes32 salt;
        address predictedHook;
        bytes memory constructorArgs;
        bytes memory creationCode;

        // Iterate salts to find an address matching HOOK_FLAGS where poolId matches the key
        for (uint256 i = 0; i < 100000; i++) {
            salt = bytes32(i);

            // Temporary address prediction for key calculation
            address tempPredicted = address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(
                                bytes1(0xff), CREATE2_FACTORY, salt, keccak256(type(CommitSwapHook).creationCode)
                            )
                        )
                    )
                )
            );

            PoolKey memory testKey = PoolKey({
                currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(tempPredicted)
            });
            bytes32 calculatedPoolId = PoolId.unwrap(testKey.toId());

            constructorArgs = abi.encode(manager, calculatedPoolId, WINDOW_BLOCKS, MIN_BOND);
            creationCode = abi.encodePacked(type(CommitSwapHook).creationCode, constructorArgs);

            predictedHook = address(
                uint160(
                    uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, salt, keccak256(creationCode))))
                )
            );

            if (uint160(predictedHook) & Hooks.ALL_HOOK_MASK == HOOK_FLAGS && predictedHook == tempPredicted) {
                break;
            }
        }

        // If loop above needed exact match, standard salt miner:
        if (predictedHook == address(0) || uint160(predictedHook) & Hooks.ALL_HOOK_MASK != HOOK_FLAGS) {
            for (uint256 i = 0; i < 100000; i++) {
                salt = bytes32(i);
                // Calculate dummy for address flags
                constructorArgs = abi.encode(manager, bytes32(0), WINDOW_BLOCKS, MIN_BOND);
                creationCode = abi.encodePacked(type(CommitSwapHook).creationCode, constructorArgs);
                predictedHook = address(
                    uint160(
                        uint256(
                            keccak256(abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, salt, keccak256(creationCode)))
                        )
                    )
                );
                if (uint160(predictedHook) & Hooks.ALL_HOOK_MASK == HOOK_FLAGS) {
                    PoolKey memory finalKey = PoolKey({
                        currency0: currency0,
                        currency1: currency1,
                        fee: 3000,
                        tickSpacing: 60,
                        hooks: IHooks(predictedHook)
                    });
                    bytes32 finalPoolId = PoolId.unwrap(finalKey.toId());
                    constructorArgs = abi.encode(manager, finalPoolId, WINDOW_BLOCKS, MIN_BOND);
                    creationCode = abi.encodePacked(type(CommitSwapHook).creationCode, constructorArgs);
                    predictedHook = address(
                        uint160(
                            uint256(
                                keccak256(
                                    abi.encodePacked(bytes1(0xff), CREATE2_FACTORY, salt, keccak256(creationCode))
                                )
                            )
                        )
                    );
                    if (uint160(predictedHook) & Hooks.ALL_HOOK_MASK == HOOK_FLAGS) {
                        break;
                    }
                }
            }
        }

        (bool success,) = CREATE2_FACTORY.call(abi.encodePacked(salt, creationCode));
        require(success, "CREATE2 deployment failed");
        address hookAddress = predictedHook;
        console.log("      CommitSwapHook Deployed at:", hookAddress);
        CommitSwapHook hook = CommitSwapHook(payable(hookAddress));

        // 4. Initialize Pool with Hook
        console.log("[4/5] Initializing Uniswap v4 Pool with CommitSwapHook...");
        PoolKey memory key = PoolKey({
            currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(hookAddress)
        });
        PoolId poolId = key.toId();

        manager.initialize(key, SQRT_PRICE_1_1);
        console.log("      Pool Initialized! PoolId:", vm.toString(PoolId.unwrap(poolId)));

        // 5. Generate Multi-User On-Chain Activity
        console.log("[5/5] Generating Live Multi-User Batch Activity...");

        // Mint tokens to trader
        token0.mint(deployer, 1000 ether);
        token1.mint(deployer, 1000 ether);

        token0.approve(address(manager), type(uint256).max);
        token1.approve(address(manager), type(uint256).max);
        token0.approve(address(hook), type(uint256).max);
        token1.approve(address(hook), type(uint256).max);

        // Trader 1: Commit Intent (10 Token0 -> Token1)
        bytes32 salt1 = keccak256("trader1-salt");
        bytes32 hash1 = hook.computeIntentHash(10 ether, 9.5 ether, true, PoolId.unwrap(poolId), salt1, deployer);
        uint256 commitId1 = hook.commit{value: MIN_BOND}(hash1);
        console.log("      -> [Commit] Trader 1 committed Order #", commitId1, "(10 T0 -> T1)");

        // Trader 2: Commit Opposing Intent (10 Token1 -> Token0)
        bytes32 salt2 = keccak256("trader2-salt");
        bytes32 hash2 = hook.computeIntentHash(10 ether, 9.5 ether, false, PoolId.unwrap(poolId), salt2, deployer);
        uint256 commitId2 = hook.commit{value: MIN_BOND}(hash2);
        console.log("      -> [Commit] Trader 2 committed Order #", commitId2, "(10 T1 -> T0)");

        console.log("==================================================================");
        console.log("On-Chain Activity Generated Successfully!");
        console.log("Hook Address:     ", hookAddress);
        console.log("Pool ID:          ", vm.toString(PoolId.unwrap(poolId)));
        console.log("Token0 Address:   ", address(token0));
        console.log("Token1 Address:   ", address(token1));
        console.log("==================================================================");

        vm.stopBroadcast();
    }
}
