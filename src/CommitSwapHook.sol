// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseHook} from "./BaseHook.sol";
import {CommitRevealStore} from "./CommitRevealStore.sol";
import {IntentMatcher} from "./IntentMatcher.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";

/// @title CommitSwapHook
/// @notice Uniswap v4 hook implementing MEV-resistant commit-reveal batch swaps with CoW matching.
contract CommitSwapHook is BaseHook, CommitRevealStore, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;

    // ──────────────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────────────
    error WindowNotClosed();
    error WindowAlreadySettled();
    error PoolKeyMismatch();

    // ──────────────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────────────
    event BatchSettled(
        uint256 indexed windowIndex,
        address indexed keeper,
        uint256 totalRevealed,
        uint256 totalMatchedPairs,
        uint256 totalMatched0,
        uint256 totalMatched1
    );

    // ──────────────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────────────
    constructor(
        IPoolManager _poolManager,
        bytes32 _poolId,
        uint256 _windowBlocks,
        uint256 _minBond
    )
        BaseHook(_poolManager)
        CommitRevealStore(_poolId, _windowBlocks, _minBond)
    {}

    // ──────────────────────────────────────────────────────────────────────
    // Hook Permissions
    // ──────────────────────────────────────────────────────────────────────
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ──────────────────────────────────────────────────────────────────────
    // Hook Callbacks
    // ──────────────────────────────────────────────────────────────────────
    function beforeSwap(
        address,
        PoolKey calldata,
        IPoolManager.SwapParams calldata,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Settle Batch Flow
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Settle all revealed commitments in a closed window.
    /// @param windowIndex The window index to settle.
    /// @param key The PoolKey associated with this hook and POOL_ID.
    function settleBatch(uint256 windowIndex, PoolKey calldata key) external returns (bytes memory) {
        if (PoolId.unwrap(key.toId()) != POOL_ID) revert PoolKeyMismatch();
        if (currentWindowIndex() <= windowIndex) revert WindowNotClosed();
        if (windowSettled[windowIndex]) revert WindowAlreadySettled();

        return poolManager.unlock(abi.encode(windowIndex, key, msg.sender));
    }

    /// @notice Callback executed inside poolManager.unlock().
    /// @param data Encoded (windowIndex, PoolKey, keeper).
    function unlockCallback(bytes calldata data) external override onlyPoolManager returns (bytes memory) {
        (uint256 windowIndex, PoolKey memory key, address keeper) = abi.decode(data, (uint256, PoolKey, address));

        windowSettled[windowIndex] = true;

        uint256[] memory commitIds = windowCommitIds[windowIndex];
        uint256 totalCommits = commitIds.length;

        if (totalCommits == 0) {
            emit BatchSettled(windowIndex, keeper, 0, 0, 0, 0);
            return "";
        }

        // Count revealed commitments
        uint256 revealedCount = 0;
        for (uint256 i = 0; i < totalCommits; i++) {
            if (commitments[commitIds[i]].revealed) {
                revealedCount++;
            }
        }

        if (revealedCount == 0) {
            emit BatchSettled(windowIndex, keeper, 0, 0, 0, 0);
            return "";
        }

        // Populate revealed intents for IntentMatcher
        IntentMatcher.RevealedIntent[] memory revealed = new IntentMatcher.RevealedIntent[](revealedCount);
        uint256 rIdx = 0;
        for (uint256 i = 0; i < totalCommits; i++) {
            Commitment storage c = commitments[commitIds[i]];
            if (c.revealed) {
                revealed[rIdx++] = IntentMatcher.RevealedIntent({
                    id: commitIds[i],
                    committer: c.committer,
                    amount: c.amount,
                    minAmountOut: c.minAmountOut,
                    zeroForOne: c.zeroForOne
                });
            }
        }

        // Get spot price from poolManager slot0
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        uint256 price18 = _sqrtPriceX96ToPrice18(sqrtPriceX96);

        // Run matching algorithm
        IntentMatcher.MatchOutcome[] memory outcomes = IntentMatcher.matchIntents(revealed, price18);

        uint256 totalMatched0 = 0;
        uint256 totalMatched1 = 0;
        uint256 matchedPairs = 0;

        // Pass 1: Settle all input tokens into PoolManager from counterparties
        for (uint256 i = 0; i < revealedCount; i++) {
            if (outcomes[i].matchedAmountIn > 0) {
                matchedPairs++;
                address committer = revealed[i].committer;
                if (revealed[i].zeroForOne) {
                    totalMatched0 += outcomes[i].matchedAmountIn;
                    _settleCurrency(key.currency0, committer, outcomes[i].matchedAmountIn);
                } else {
                    totalMatched1 += outcomes[i].matchedAmountIn;
                    _settleCurrency(key.currency1, committer, outcomes[i].matchedAmountIn);
                }
            }
        }

        // Pass 2: Distribute all matched output tokens from PoolManager to counterparties
        for (uint256 i = 0; i < revealedCount; i++) {
            if (outcomes[i].matchedAmountIn > 0) {
                address committer = revealed[i].committer;
                if (revealed[i].zeroForOne) {
                    totalMatched1 += outcomes[i].matchedAmountOut;
                    poolManager.take(key.currency1, committer, outcomes[i].matchedAmountOut);
                } else {
                    totalMatched0 += outcomes[i].matchedAmountOut;
                    poolManager.take(key.currency0, committer, outcomes[i].matchedAmountOut);
                }
            }
        }

        emit BatchSettled(windowIndex, keeper, revealedCount, matchedPairs, totalMatched0, totalMatched1);
        return "";
    }

    // ──────────────────────────────────────────────────────────────────────
    // Internal Currency Helpers
    // ──────────────────────────────────────────────────────────────────────

    function _settleCurrency(Currency currency, address payer, uint256 amount) internal {
        if (currency.isAddressZero()) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            IERC20Minimal(Currency.unwrap(currency)).transferFrom(payer, address(poolManager), amount);
            poolManager.settle();
        }
    }

    /// @dev Converts sqrtPriceX96 to price18 (token0 price in terms of token1, scaled by 1e18).
    ///      price18 = (sqrtPriceX96 * sqrtPriceX96 * 1e18) / 2^192
    function _sqrtPriceX96ToPrice18(uint160 sqrtPriceX96) internal pure returns (uint256) {
        uint256 sp = uint256(sqrtPriceX96);
        // Compute (sp * sp * 1e18) >> 192 using 512-bit intermediate product
        uint256 prod0 = sp * sp;
        uint256 prod1;
        assembly {
            let mm := mulmod(sp, sp, not(0))
            prod1 := sub(sub(mm, prod0), lt(mm, prod0))
        }

        // Multiply 512-bit product [prod1, prod0] by 1e18
        uint256 p0 = prod0 * 1e18;
        uint256 p1;
        assembly {
            let mm := mulmod(prod0, 1000000000000000000, not(0))
            p1 := add(mul(prod1, 1000000000000000000), sub(sub(mm, p0), lt(mm, p0)))
        }

        // Divide 512-bit [p1, p0] by 2^192 (shift right 192 bits)
        return (p1 << 64) | (p0 >> 192);
    }
}
