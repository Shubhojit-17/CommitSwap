// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {CommitSwapHook} from "../src/CommitSwapHook.sol";
import {CommitRevealStore} from "../src/CommitRevealStore.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";

/// @title MEVSimulationTest
/// @notice Comprehensive attack simulation suite validating MEV and griefing resistance from 02-threat-model.md.
contract MEVSimulationTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    CommitSwapHook hook;
    PoolId testPoolId;
    PoolKey testKey;

    address alice = makeAddr("alice");
    address eve = makeAddr("eve_attacker");
    address keeper = makeAddr("keeper");

    bytes32 constant SALT_ALICE = keccak256("alice-salt");
    bytes32 constant SALT_EVE = keccak256("eve-salt");

    uint256 constant WINDOW_BLOCKS = 5;
    uint256 constant MIN_BOND = 0.05 ether; // 0.05 ETH bond

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        address hookAddress = address(flags);

        testKey = PoolKey({
            currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 60, hooks: IHooks(hookAddress)
        });
        testPoolId = testKey.toId();

        deployCodeTo(
            "CommitSwapHook.sol:CommitSwapHook",
            abi.encode(manager, PoolId.unwrap(testPoolId), WINDOW_BLOCKS, MIN_BOND),
            hookAddress
        );
        hook = CommitSwapHook(payable(hookAddress));

        manager.initialize(testKey, SQRT_PRICE_1_1);

        // Seed 10,000 ETH of liquidity for AMM pool
        IPoolManager.ModifyLiquidityParams memory liqParams = IPoolManager.ModifyLiquidityParams({
            tickLower: -1200, tickUpper: 1200, liquidityDelta: 10000 ether, salt: 0
        });
        modifyLiquidityRouter.modifyLiquidity(testKey, liqParams, ZERO_BYTES);

        vm.deal(alice, 100 ether);
        vm.deal(eve, 100 ether);
        vm.deal(keeper, 100 ether);

        MockERC20(Currency.unwrap(currency0)).mint(alice, 1000 ether);
        MockERC20(Currency.unwrap(currency1)).mint(alice, 1000 ether);
        MockERC20(Currency.unwrap(currency0)).mint(eve, 1000 ether);
        MockERC20(Currency.unwrap(currency1)).mint(eve, 1000 ether);

        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(manager), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(manager), type(uint256).max);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(eve);
        MockERC20(Currency.unwrap(currency0)).approve(address(manager), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(manager), type(uint256).max);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
        vm.stopPrank();
    }

    // ──────────────────────────────────────────────────────────────────────
    // Threat 1: Free-Option Attack / Strategic Withhold Simulation (G1)
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Attacker commits an opposing trade to create a free option.
    ///         When price moves adversely, attacker strategically abandons reveal.
    ///         Validation:
    ///         1. Attacker suffers strict capital loss = 100% of bond.
    ///         2. Honest user (Alice) falls back safely to AMM pool without getting stuck.
    ///         3. Keeper captures attacker's forfeited bond as profit.
    function test_threat_withheldReveal_freeOptionDefense() public {
        uint256 amountAlice = 10 ether; // Alice sells 10 token0 for token1
        uint256 amountEve = 10 ether; // Eve sells 10 token1 for token0

        uint256 eveEthBefore = eve.balance;
        uint256 keeperEthBefore = keeper.balance;
        uint256 alice0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 alice1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);

        // Window 0: Both Alice and Eve commit
        vm.roll(1);
        bytes32 hashAlice =
            hook.computeIntentHash(amountAlice, 9 ether, true, PoolId.unwrap(testPoolId), SALT_ALICE, alice);
        bytes32 hashEve = hook.computeIntentHash(amountEve, 9 ether, false, PoolId.unwrap(testPoolId), SALT_EVE, eve);

        vm.prank(alice);
        uint256 idAlice = hook.commit{value: MIN_BOND}(hashAlice);

        vm.prank(eve);
        hook.commit{value: MIN_BOND}(hashEve);

        // Window 1: Alice reveals, but Eve WITHHOLDS her reveal
        vm.roll(5);
        vm.prank(alice);
        hook.reveal(idAlice, amountAlice, 9 ether, true, PoolId.unwrap(testPoolId), SALT_ALICE);

        // Window 2: Keeper settles window 0
        vm.roll(10);
        vm.prank(keeper);
        hook.settleBatch(0, testKey);

        // 1. Eve lost full bond (0.05 ETH)
        assertEq(eveEthBefore - eve.balance, MIN_BOND, "Attacker must lose 100% of bond");

        // 2. Alice safely executed via AMM fallback
        assertEq(
            MockERC20(Currency.unwrap(currency0)).balanceOf(alice), alice0Before - amountAlice, "Alice token0 spent"
        );
        assertGe(
            MockERC20(Currency.unwrap(currency1)).balanceOf(alice) - alice1Before,
            9 ether,
            "Alice received tokens via AMM"
        );

        // 3. Keeper received Eve's forfeited bond + 5% fee from Alice's bond
        uint256 expectedKeeperProfit = MIN_BOND + (MIN_BOND * 500 / 10000);
        assertEq(keeper.balance - keeperEthBefore, expectedKeeperProfit, "Keeper earned forfeited bond + fee");
    }

    // ──────────────────────────────────────────────────────────────────────
    // Threat 2: Front-running & Sandwich Attack Resistance
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Verifies that all intent parameters are opaque during the commit phase.
    ///         A searcher cannot determine tokens, directions, or amounts from commitment data.
    function test_threat_sandwichAttackResistance() public {
        uint256 amount = 50 ether;
        bytes32 salt = keccak256("unpredictable-user-salt");

        vm.roll(1);
        bytes32 intentHash = hook.computeIntentHash(amount, 45 ether, true, PoolId.unwrap(testPoolId), salt, alice);

        vm.prank(alice);
        uint256 commitId = hook.commit{value: MIN_BOND}(intentHash);

        CommitRevealStore.Commitment memory c = hook.getCommitment(commitId);

        // In commit window, plaintext values are strictly zero
        assertEq(c.amount, 0, "Amount must remain hidden");
        assertEq(c.minAmountOut, 0, "MinAmountOut must remain hidden");
        assertEq(c.zeroForOne, false, "Direction must remain hidden");
        assertFalse(c.revealed, "Must not be marked revealed");
        assertEq(c.intentHash, intentHash, "Only cryptographic commitment is visible");
    }

    // ──────────────────────────────────────────────────────────────────────
    // Threat 3: Denial-of-Service / Spam Intent Cost Imposition (G3)
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Attacker attempts to flood the contract with 20 dummy unrevealed commitments.
    ///         The contract forces the attacker to deposit MIN_BOND for every single commit.
    ///         Upon settlement, all 20 bonds are 100% forfeited to the keeper.
    function test_threat_dustSpamCostImposition() public {
        uint256 spamCount = 20;
        uint256 totalSpamBondCost = spamCount * MIN_BOND;

        uint256 eveEthBefore = eve.balance;
        uint256 keeperEthBefore = keeper.balance;

        vm.roll(1);
        for (uint256 i = 0; i < spamCount; i++) {
            bytes32 spamHash = keccak256(abi.encode("spam-payload", i));
            vm.prank(eve);
            hook.commit{value: MIN_BOND}(spamHash);
        }

        // Eve paid 20 * MIN_BOND = 1.0 ETH
        assertEq(eveEthBefore - eve.balance, totalSpamBondCost, "Spammer must pay bond for every commit");

        // Advance past reveal window without revealing
        vm.roll(10);
        vm.prank(keeper);
        hook.settleBatch(0, testKey);

        // Keeper claims all 20 forfeited bonds
        assertEq(keeper.balance - keeperEthBefore, totalSpamBondCost, "Keeper collected all spammer bonds");
        assertEq(address(hook).balance, 0, "Hook retains zero remaining ETH");
    }
}
