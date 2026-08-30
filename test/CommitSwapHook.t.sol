// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {CommitSwapHook} from "../src/CommitSwapHook.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Constants} from "@uniswap/v4-core/test/utils/Constants.sol";

contract CommitSwapHookTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    CommitSwapHook hook;
    PoolId testPoolId;
    PoolKey testKey;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");

    bytes32 constant SALT_A = keccak256("salt-alice");
    bytes32 constant SALT_B = keccak256("salt-bob");

    uint256 constant WINDOW_BLOCKS = 5;
    uint256 constant MIN_BOND = 0.001 ether;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        // Target hook flags: BEFORE_SWAP_FLAG (1<<7 = 128) | BEFORE_SWAP_RETURNS_DELTA_FLAG (1<<3 = 8) = 136 (0x0088)
        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        address hookAddress = address(flags);

        // Precompute testKey and testPoolId with this hook address
        testKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(hookAddress)
        });
        testPoolId = testKey.toId();

        // Deploy CommitSwapHook directly to hookAddress
        deployCodeTo(
            "CommitSwapHook.sol:CommitSwapHook",
            abi.encode(manager, PoolId.unwrap(testPoolId), WINDOW_BLOCKS, MIN_BOND),
            hookAddress
        );
        hook = CommitSwapHook(payable(hookAddress));

        // Initialize pool with 1:1 initial price
        manager.initialize(testKey, SQRT_PRICE_1_1);

        // Seed initial pool liquidity for AMM fallback routing
        IPoolManager.ModifyLiquidityParams memory liqParams = IPoolManager.ModifyLiquidityParams({
            tickLower: -1200,
            tickUpper: 1200,
            liquidityDelta: 10000 ether,
            salt: 0
        });
        modifyLiquidityRouter.modifyLiquidity(testKey, liqParams, ZERO_BYTES);

        // Fund user accounts with tokens & ETH
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(keeper, 100 ether);

        MockERC20(Currency.unwrap(currency0)).mint(alice, 1000 ether);
        MockERC20(Currency.unwrap(currency1)).mint(alice, 1000 ether);

        MockERC20(Currency.unwrap(currency0)).mint(bob, 1000 ether);
        MockERC20(Currency.unwrap(currency1)).mint(bob, 1000 ether);

        // Approvals for hook & poolManager
        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(manager), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(manager), type(uint256).max);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(bob);
        MockERC20(Currency.unwrap(currency0)).approve(address(manager), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(manager), type(uint256).max);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
        vm.stopPrank();
    }

    // ──────────────────────────────────────────────────────────────────────
    // Unit & Integration Tests — Phase 4 (CoW Matching)
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Single matched pair (Alice sells 10 token0 for token1, Bob sells 10 token1 for token0).
    ///         Both reveal, keeper calls settleBatch, tokens transfer atomically, deltas zero.
    function test_settleBatch_singleMatchedPair() public {
        uint256 amountA = 10 ether;
        uint256 minOutA = 9 ether;
        bool zeroForOneA = true;

        uint256 amountB = 10 ether;
        uint256 minOutB = 9 ether;
        bool zeroForOneB = false;

        // Window 0 (blocks 0-4): Alice and Bob commit
        vm.roll(1);
        bytes32 hashA = hook.computeIntentHash(amountA, minOutA, zeroForOneA, PoolId.unwrap(testPoolId), SALT_A, alice);
        bytes32 hashB = hook.computeIntentHash(amountB, minOutB, zeroForOneB, PoolId.unwrap(testPoolId), SALT_B, bob);

        vm.prank(alice);
        uint256 idA = hook.commit{value: MIN_BOND}(hashA);

        vm.prank(bob);
        uint256 idB = hook.commit{value: MIN_BOND}(hashB);

        // Window 1 (blocks 5-9): Alice and Bob reveal
        vm.roll(5);
        vm.prank(alice);
        hook.reveal(idA, amountA, minOutA, zeroForOneA, PoolId.unwrap(testPoolId), SALT_A);

        vm.prank(bob);
        hook.reveal(idB, amountB, minOutB, zeroForOneB, PoolId.unwrap(testPoolId), SALT_B);

        // Record balances before settlement
        uint256 alice0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 alice1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);

        uint256 bob0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(bob);
        uint256 bob1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(bob);

        // Window 2 (block 10+): Keeper settles window 0
        vm.roll(10);
        vm.prank(keeper);
        hook.settleBatch(0, testKey);

        // Verify window is settled
        assertTrue(hook.windowSettled(0), "window 0 should be settled");

        // Verify balances after matching:
        // Alice gave 10 token0, received 10 token1
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(alice), alice0Before - amountA, "Alice token0 spent");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(alice), alice1Before + amountA, "Alice token1 received");

        // Bob gave 10 token1, received 10 token0
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(bob), bob1Before - amountB, "Bob token1 spent");
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(bob), bob0Before + amountB, "Bob token0 received");
    }

    /// @notice Settle batch reverts if window is not yet closed.
    function test_settleBatch_windowNotClosed_reverts() public {
        vm.roll(2); // still in window 0
        vm.prank(keeper);
        vm.expectRevert(CommitSwapHook.WindowNotClosed.selector);
        hook.settleBatch(0, testKey);
    }

    /// @notice Settle batch reverts on double settlement of the same window.
    function test_settleBatch_alreadySettled_reverts() public {
        // Advance past window 0
        vm.roll(10);
        vm.prank(keeper);
        hook.settleBatch(0, testKey);

        // Second settle attempt on window 0 reverts
        vm.prank(keeper);
        vm.expectRevert(CommitSwapHook.WindowAlreadySettled.selector);
        hook.settleBatch(0, testKey);
    }

    /// @notice Settle batch reverts when passed an incorrect PoolKey.
    function test_settleBatch_wrongPoolKey_reverts() public {
        PoolKey memory wrongKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 500, // different fee tier -> different poolId
            tickSpacing: 10,
            hooks: testKey.hooks
        });

        vm.roll(10);
        vm.prank(keeper);
        vm.expectRevert(CommitSwapHook.PoolKeyMismatch.selector);
        hook.settleBatch(0, wrongKey);
    }

    /// @notice Empty window (0 commits) settles cleanly with no matching or revert.
    function test_settleBatch_emptyWindow_succeeds() public {
        vm.roll(10);
        vm.prank(keeper);
        hook.settleBatch(0, testKey);

        assertTrue(hook.windowSettled(0));
    }

    /// @notice Window with unrevealed commitments settles cleanly.
    function test_settleBatch_unrevealedCommits_succeeds() public {
        vm.roll(1);
        bytes32 hashA = hook.computeIntentHash(10 ether, 9 ether, true, PoolId.unwrap(testPoolId), SALT_A, alice);
        vm.prank(alice);
        hook.commit{value: MIN_BOND}(hashA);

        // Do not reveal — advance to window 2
        vm.roll(10);
        vm.prank(keeper);
        hook.settleBatch(0, testKey);

        assertTrue(hook.windowSettled(0));
    }

    // ──────────────────────────────────────────────────────────────────────
    // Unit & Integration Tests — Phase 5 (AMM Fallback)
    // ──────────────────────────────────────────────────────────────────────

    /// @notice 0% matched: Alice and Bob commit in the same direction (both token0 -> token1).
    ///         0 CoW matches. 100% of volume routes through AMM pool fallback swaps.
    function test_settleBatch_0pctMatched_allAMM() public {
        uint256 amountA = 5 ether;
        uint256 minOutA = 4.5 ether;

        uint256 amountB = 5 ether;
        uint256 minOutB = 4.5 ether;

        // Window 0: Both Alice and Bob offer token0 for token1
        vm.roll(1);
        bytes32 hashA = hook.computeIntentHash(amountA, minOutA, true, PoolId.unwrap(testPoolId), SALT_A, alice);
        bytes32 hashB = hook.computeIntentHash(amountB, minOutB, true, PoolId.unwrap(testPoolId), SALT_B, bob);

        vm.prank(alice);
        uint256 idA = hook.commit{value: MIN_BOND}(hashA);
        vm.prank(bob);
        uint256 idB = hook.commit{value: MIN_BOND}(hashB);

        // Window 1: Both reveal
        vm.roll(5);
        vm.prank(alice);
        hook.reveal(idA, amountA, minOutA, true, PoolId.unwrap(testPoolId), SALT_A);
        vm.prank(bob);
        hook.reveal(idB, amountB, minOutB, true, PoolId.unwrap(testPoolId), SALT_B);

        uint256 alice0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 alice1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);
        uint256 bob0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(bob);
        uint256 bob1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(bob);

        // Window 2: Keeper settles
        vm.roll(10);
        vm.prank(keeper);
        hook.settleBatch(0, testKey);

        assertTrue(hook.windowSettled(0));

        // Both Alice and Bob spent 5 token0 and received > 4.5 token1 via AMM
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(alice), alice0Before - amountA);
        assertGe(MockERC20(Currency.unwrap(currency1)).balanceOf(alice) - alice1Before, minOutA);

        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(bob), bob0Before - amountB);
        assertGe(MockERC20(Currency.unwrap(currency1)).balanceOf(bob) - bob1Before, minOutB);
    }

    /// @notice Partial match with AMM fallback: Alice offers 10 token0, Bob offers 6 token1.
    ///         6 units match via CoW, 4 residual token0 swap through AMM fallback.
    function test_settleBatch_partialMatch_withAMMFallback() public {
        uint256 amountA = 10 ether;
        uint256 minOutA = 9 ether;
        bool zeroForOneA = true;

        uint256 amountB = 6 ether;
        uint256 minOutB = 5 ether;
        bool zeroForOneB = false;

        vm.roll(1);
        bytes32 hashA = hook.computeIntentHash(amountA, minOutA, zeroForOneA, PoolId.unwrap(testPoolId), SALT_A, alice);
        bytes32 hashB = hook.computeIntentHash(amountB, minOutB, zeroForOneB, PoolId.unwrap(testPoolId), SALT_B, bob);

        vm.prank(alice);
        uint256 idA = hook.commit{value: MIN_BOND}(hashA);
        vm.prank(bob);
        uint256 idB = hook.commit{value: MIN_BOND}(hashB);

        vm.roll(5);
        vm.prank(alice);
        hook.reveal(idA, amountA, minOutA, zeroForOneA, PoolId.unwrap(testPoolId), SALT_A);
        vm.prank(bob);
        hook.reveal(idB, amountB, minOutB, zeroForOneB, PoolId.unwrap(testPoolId), SALT_B);

        uint256 alice0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 alice1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);
        uint256 bob0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(bob);
        uint256 bob1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(bob);

        vm.roll(10);
        vm.prank(keeper);
        hook.settleBatch(0, testKey);

        assertTrue(hook.windowSettled(0));

        // Alice spent full 10 token0, received 6 token1 from CoW + ~3.98 token1 from AMM fallback
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(alice), alice0Before - 10 ether);
        assertGe(MockERC20(Currency.unwrap(currency1)).balanceOf(alice) - alice1Before, minOutA);

        // Bob matched 100% (6 token1 spent, 6 token0 received)
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(bob), bob1Before - 6 ether);
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(bob), bob0Before + 6 ether);
    }

    /// @notice Slippage exceeded on AMM fallback leg reverts batch.
    function test_settleBatch_ammFallback_slippageExceeded_reverts() public {
        uint256 amountA = 5 ether;
        // Unreasonable min output (100 token1 for 5 token0 when price is 1:1)
        uint256 minOutA = 100 ether;

        vm.roll(1);
        bytes32 hashA = hook.computeIntentHash(amountA, minOutA, true, PoolId.unwrap(testPoolId), SALT_A, alice);
        vm.prank(alice);
        uint256 idA = hook.commit{value: MIN_BOND}(hashA);

        vm.roll(5);
        vm.prank(alice);
        hook.reveal(idA, amountA, minOutA, true, PoolId.unwrap(testPoolId), SALT_A);

        vm.roll(10);
        vm.prank(keeper);
        vm.expectRevert();
        hook.settleBatch(0, testKey);
    }
}
