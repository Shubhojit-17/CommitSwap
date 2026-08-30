// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {IntentMatcher} from "../src/IntentMatcher.sol";

/// @title IntentMatcher Unit & Fuzz Tests
/// @notice Comprehensive unit and fuzz tests for IntentMatcher library.
contract IntentMatcherTest is Test {
    using IntentMatcher for IntentMatcher.RevealedIntent[];

    // ──────────────────────────────────────────────────────────────────────
    // Helper Constructors
    // ──────────────────────────────────────────────────────────────────────

    function _createIntent(uint256 id, address committer, uint256 amount, uint256 minAmountOut, bool zeroForOne)
        internal
        pure
        returns (IntentMatcher.RevealedIntent memory)
    {
        return IntentMatcher.RevealedIntent({
            id: id, committer: committer, amount: amount, minAmountOut: minAmountOut, zeroForOne: zeroForOne
        });
    }

    // ══════════════════════════════════════════════════════════════════════
    //                       UNIT TESTS
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Exact 1:1 match at price18 = 1e18.
    ///         Both sides fully consumed, zero residual on both.
    function test_matchIntents_exactOneToOne() public pure {
        IntentMatcher.RevealedIntent[] memory intents = new IntentMatcher.RevealedIntent[](2);
        intents[0] = _createIntent(1, address(0x1), 10 ether, 9 ether, true);
        intents[1] = _createIntent(2, address(0x2), 10 ether, 9 ether, false);

        uint256 price18 = 1e18;

        IntentMatcher.MatchOutcome[] memory outcomes = IntentMatcher.matchIntents(intents, price18);

        assertEq(outcomes.length, 2);

        // Outcome 1
        assertEq(outcomes[0].id, 1);
        assertEq(outcomes[0].matchedAmountIn, 10 ether);
        assertEq(outcomes[0].matchedAmountOut, 10 ether);
        assertEq(outcomes[0].residualAmountIn, 0);

        // Outcome 2
        assertEq(outcomes[1].id, 2);
        assertEq(outcomes[1].matchedAmountIn, 10 ether);
        assertEq(outcomes[1].matchedAmountOut, 10 ether);
        assertEq(outcomes[1].residualAmountIn, 0);
    }

    /// @notice Partial match: one side larger than the other.
    ///         Smaller side fully consumed, larger side has correct residual.
    function test_matchIntents_partialMatch() public pure {
        IntentMatcher.RevealedIntent[] memory intents = new IntentMatcher.RevealedIntent[](2);
        intents[0] = _createIntent(1, address(0x1), 10 ether, 9 ether, true);
        intents[1] = _createIntent(2, address(0x2), 6 ether, 5 ether, false);

        uint256 price18 = 1e18;

        IntentMatcher.MatchOutcome[] memory outcomes = IntentMatcher.matchIntents(intents, price18);

        // Outcome 1 (offered 10, matched 6, residual 4)
        assertEq(outcomes[0].id, 1);
        assertEq(outcomes[0].matchedAmountIn, 6 ether);
        assertEq(outcomes[0].matchedAmountOut, 6 ether);
        assertEq(outcomes[0].residualAmountIn, 4 ether);

        // Outcome 2 (offered 6, matched 6, residual 0)
        assertEq(outcomes[1].id, 2);
        assertEq(outcomes[1].matchedAmountIn, 6 ether);
        assertEq(outcomes[1].matchedAmountOut, 6 ether);
        assertEq(outcomes[1].residualAmountIn, 0);
    }

    /// @notice Chained match: one large zeroForOne=true intent matched sequentially against two smaller zeroForOne=false intents.
    ///         Confirms greedy sequential matching across multiple counterparties.
    function test_matchIntents_chainedMatch() public pure {
        IntentMatcher.RevealedIntent[] memory intents = new IntentMatcher.RevealedIntent[](3);
        intents[0] = _createIntent(1, address(0x1), 10 ether, 9 ether, true);
        intents[1] = _createIntent(2, address(0x2), 4 ether, 3.5 ether, false);
        intents[2] = _createIntent(3, address(0x3), 6 ether, 5.5 ether, false);

        uint256 price18 = 1e18;

        IntentMatcher.MatchOutcome[] memory outcomes = IntentMatcher.matchIntents(intents, price18);

        // Large intent (id=1): matched 4 + 6 = 10 ether, residual = 0
        assertEq(outcomes[0].id, 1);
        assertEq(outcomes[0].matchedAmountIn, 10 ether);
        assertEq(outcomes[0].matchedAmountOut, 10 ether);
        assertEq(outcomes[0].residualAmountIn, 0);

        // First counterparty (id=2): matched 4 ether, residual = 0
        assertEq(outcomes[1].id, 2);
        assertEq(outcomes[1].matchedAmountIn, 4 ether);
        assertEq(outcomes[1].matchedAmountOut, 4 ether);
        assertEq(outcomes[1].residualAmountIn, 0);

        // Second counterparty (id=3): matched 6 ether, residual = 0
        assertEq(outcomes[2].id, 3);
        assertEq(outcomes[2].matchedAmountIn, 6 ether);
        assertEq(outcomes[2].matchedAmountOut, 6 ether);
        assertEq(outcomes[2].residualAmountIn, 0);
    }

    /// @notice Non-trivial price (price18 = 2e18 -> 1 token0 = 2 token1).
    ///         Confirms correct token0 / token1 unit conversion on both sides.
    function test_matchIntents_nonTrivialPrice() public pure {
        IntentMatcher.RevealedIntent[] memory intents = new IntentMatcher.RevealedIntent[](2);
        // Offering 10 token0. Expecting at least 18 token1.
        intents[0] = _createIntent(1, address(0x1), 10 ether, 18 ether, true);
        // Offering 20 token1. Expecting at least 9 token0.
        intents[1] = _createIntent(2, address(0x2), 20 ether, 9 ether, false);

        uint256 price18 = 2e18; // 1 token0 = 2 token1

        IntentMatcher.MatchOutcome[] memory outcomes = IntentMatcher.matchIntents(intents, price18);

        // Intent 1: offered 10 token0, receives 20 token1
        assertEq(outcomes[0].id, 1);
        assertEq(outcomes[0].matchedAmountIn, 10 ether);
        assertEq(outcomes[0].matchedAmountOut, 20 ether);
        assertEq(outcomes[0].residualAmountIn, 0);

        // Intent 2: offered 20 token1, receives 10 token0
        assertEq(outcomes[1].id, 2);
        assertEq(outcomes[1].matchedAmountIn, 20 ether);
        assertEq(outcomes[1].matchedAmountOut, 10 ether);
        assertEq(outcomes[1].residualAmountIn, 0);
    }

    /// @notice minAmountOut violation: candidate match gives one side less than their pro-rated minAmountOut.
    ///         Confirms pairing is skipped and both sides retain 100% residual.
    function test_matchIntents_minAmountOutViolation() public pure {
        IntentMatcher.RevealedIntent[] memory intents = new IntentMatcher.RevealedIntent[](2);
        // Offering 10 token0, demanding 12 token1 (above market price of 10 token1)
        intents[0] = _createIntent(1, address(0x1), 10 ether, 12 ether, true);
        intents[1] = _createIntent(2, address(0x2), 10 ether, 8 ether, false);

        uint256 price18 = 1e18;

        IntentMatcher.MatchOutcome[] memory outcomes = IntentMatcher.matchIntents(intents, price18);

        // Pairing skipped due to intent 1 minAmountOut violation
        assertEq(outcomes[0].matchedAmountIn, 0);
        assertEq(outcomes[0].residualAmountIn, 10 ether);

        assertEq(outcomes[1].matchedAmountIn, 0);
        assertEq(outcomes[1].residualAmountIn, 10 ether);
    }

    /// @notice No counterparties on one side (all zeroForOne = true).
    ///         Confirms every intent returns 100% residual and 0 matched.
    function test_matchIntents_noCounterparties() public pure {
        IntentMatcher.RevealedIntent[] memory intents = new IntentMatcher.RevealedIntent[](3);
        intents[0] = _createIntent(1, address(0x1), 10 ether, 9 ether, true);
        intents[1] = _createIntent(2, address(0x2), 5 ether, 4 ether, true);
        intents[2] = _createIntent(3, address(0x3), 8 ether, 7 ether, true);

        uint256 price18 = 1e18;

        IntentMatcher.MatchOutcome[] memory outcomes = IntentMatcher.matchIntents(intents, price18);

        for (uint256 i = 0; i < 3; i++) {
            assertEq(outcomes[i].matchedAmountIn, 0);
            assertEq(outcomes[i].residualAmountIn, intents[i].amount);
        }
    }

    /// @notice Empty input array returns cleanly with empty output array.
    function test_matchIntents_emptyArray() public pure {
        IntentMatcher.RevealedIntent[] memory intents = new IntentMatcher.RevealedIntent[](0);
        uint256 price18 = 1e18;

        IntentMatcher.MatchOutcome[] memory outcomes = IntentMatcher.matchIntents(intents, price18);

        assertEq(outcomes.length, 0);
    }

    // ══════════════════════════════════════════════════════════════════════
    //                       FUZZ TESTS
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Fuzz: Conservation of Amount Invariant.
    ///         For every intent, matchedAmountIn + residualAmountIn == amount.
    function testFuzz_conservationOfAmount(uint8 countRaw, uint96 priceRaw, uint256 seed) public pure {
        uint256 count = bound(countRaw, 1, 15);
        uint256 price18 = bound(priceRaw, 1e15, 1e21); // price between 0.001 and 1000

        IntentMatcher.RevealedIntent[] memory intents = new IntentMatcher.RevealedIntent[](count);

        for (uint256 i = 0; i < count; i++) {
            bytes32 hash = keccak256(abi.encode(seed, i));
            uint256 amount = bound(uint256(hash), 1 ether, 100 ether);
            bool zeroForOne = (uint256(hash) % 2 == 0);
            uint256 minOut = (amount * 9) / 10; // reasonable 90% minOut

            intents[i] = _createIntent(i + 1, address(uint160(i + 1)), amount, minOut, zeroForOne);
        }

        IntentMatcher.MatchOutcome[] memory outcomes = IntentMatcher.matchIntents(intents, price18);

        assertEq(outcomes.length, count);
        for (uint256 i = 0; i < count; i++) {
            assertEq(
                outcomes[i].matchedAmountIn + outcomes[i].residualAmountIn,
                intents[i].amount,
                "matched + residual must equal original amount"
            );
        }
    }

    /// @notice Fuzz: Zero-Sum / Matching Balance Invariant.
    ///         Total token0 matched converted to token1 terms equals total token1 matched, within 1 wei rounding tolerance.
    function testFuzz_zeroSumMatchingBalance(uint8 countRaw, uint96 priceRaw, uint256 seed) public pure {
        uint256 count = bound(countRaw, 1, 15);
        uint256 price18 = bound(priceRaw, 1e16, 1e20);

        IntentMatcher.RevealedIntent[] memory intents = new IntentMatcher.RevealedIntent[](count);

        for (uint256 i = 0; i < count; i++) {
            bytes32 hash = keccak256(abi.encode(seed, i));
            uint256 amount = bound(uint256(hash), 1 ether, 100 ether);
            bool zeroForOne = (uint256(hash) % 2 == 0);
            uint256 minOut = (amount * 8) / 10;

            intents[i] = _createIntent(i + 1, address(uint160(i + 1)), amount, minOut, zeroForOne);
        }

        IntentMatcher.MatchOutcome[] memory outcomes = IntentMatcher.matchIntents(intents, price18);

        uint256 totalToken0Matched = 0;
        uint256 totalToken1Matched = 0;

        for (uint256 i = 0; i < count; i++) {
            if (intents[i].zeroForOne) {
                totalToken0Matched += outcomes[i].matchedAmountIn;
            } else {
                totalToken1Matched += outcomes[i].matchedAmountIn;
            }
        }

        // Convert total token0 matched to token1 terms
        uint256 totalToken0InToken1 = (totalToken0Matched * price18) / 1e18;

        // Allow up to count wei rounding tolerance due to integer division steps
        assertApproxEqAbs(
            totalToken0InToken1,
            totalToken1Matched,
            count,
            "Total token0 matched in token1 terms must equal total token1 matched"
        );
    }
}
