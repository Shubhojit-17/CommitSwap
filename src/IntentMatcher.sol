// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IntentMatcher
/// @author CommitSwap — Phase 2
/// @notice Pure library that performs greedy sequential matching of revealed swap intents within one window.
///
/// @dev Architectural & Design Decisions (each references 06-open-questions.md / Phase 2 specification):
///
///   1. Library Choice: Implemented as a Solidity `library` containing `internal pure` functions.
///      A library is stateless, can be called internally without delegatecall overhead in Phase 4,
///      and compiles inline into the consuming contract's bytecode. It operates solely on in-memory data structures.
///
///   2. Price Format (price18 vs sqrtPriceX96): Uses `uint256 price18` (token0 price in terms of token1, scaled by 1e18).
///      Formula: token1Amount = (token0Amount * price18) / 1e18.
///      Rationale: `price18` keeps Phase 2 math clean, highly readable, and free of Q64.96 fixed-point math dependencies.
///      Phase 3 is responsible for converting Uniswap v4's `sqrtPriceX96` to `price18` before calling this library.
///
///   3. Canonical Accounting Basis: `token1` terms are used as the canonical basis for comparing remaining intent amounts.
///      Token0 amounts are converted to token1 terms via `price18` when evaluating candidate match sizes.
///
///   4. Pro-Rated minAmountOut Check: For partial fills, the minimum acceptable output is pro-rated:
///      `requiredMinOut = (matchedIn * minAmountOut) / amountIn`.
///      If a candidate match increment violates either side's pro-rated `minAmountOut`, the match increment is skipped,
///      and remaining amounts are left as unmatched residuals.
///
///   5. Deterministic Ordering: Intent lists for each direction (`zeroForOne = true` and `zeroForOne = false`) are sorted
///      by `id` ascending before matching to guarantee deterministic execution order.
///
///   6. Batch Size Constraint: The matching algorithm uses insertion sort (O(n²)) for deterministic
///      ordering. This is efficient for batch sizes up to ~20 intents per window. For hackathon scope,
///      this is acceptable. Post-hackathon, if batch sizes need to grow, replace with a more efficient
///      sort (e.g., merge sort) or enforce an on-chain batch size cap.
library IntentMatcher {
    // ──────────────────────────────────────────────────────────────────────
    // Structs
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Plaintext revealed swap intent data.
    struct RevealedIntent {
        uint256 id; // commitmentId, used for output ordering / tie-breaking
        address committer;
        uint256 amount; // amountIn: how much of their input token they are offering
        uint256 minAmountOut; // minimum output they will accept for full amount
        bool zeroForOne; // true = offering token0 for token1, false = offering token1 for token0
    }

    /// @notice Outcome for a single input intent after matching.
    struct MatchOutcome {
        uint256 id;
        uint256 matchedAmountIn; // portion of `amount` that got matched against counterparties
        uint256 matchedAmountOut; // total output received for the matched portion (per price18)
        uint256 residualAmountIn; // amount - matchedAmountIn (unmatched, needs AMM fallback in Phase 3)
    }

    // ──────────────────────────────────────────────────────────────────────
    // Core Functions
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Match a list of revealed swap intents against each other in a greedy sequential sweep.
    /// @param intents List of revealed intents in the current window.
    /// @param price18 Price of token0 in token1 terms, scaled by 1e18 (token1Amount = token0Amount * price18 / 1e18).
    /// @return outcomes Matching results for each input intent, in the exact same array order as `intents`.
    function matchIntents(RevealedIntent[] memory intents, uint256 price18)
        internal
        pure
        returns (MatchOutcome[] memory outcomes)
    {
        uint256 n = intents.length;
        outcomes = new MatchOutcome[](n);

        if (n == 0) {
            return outcomes;
        }

        require(price18 > 0, "Invalid price");

        // Initialize outcomes to 0 matched, 100% residual
        for (uint256 i = 0; i < n; i++) {
            outcomes[i] = MatchOutcome({
                id: intents[i].id, matchedAmountIn: 0, matchedAmountOut: 0, residualAmountIn: intents[i].amount
            });
        }

        // Partition indices by direction
        (uint256[] memory trueIndices, uint256[] memory falseIndices) = _partitionAndSort(intents);
        if (trueIndices.length == 0 || falseIndices.length == 0) {
            return outcomes;
        }

        // Remaining input amounts per intent index
        uint256[] memory remIn = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            remIn[i] = intents[i].amount;
        }

        // Two-pointer greedy sequential sweep
        uint256 pTrue = 0;
        uint256 pFalse = 0;

        while (pTrue < trueIndices.length && pFalse < falseIndices.length) {
            uint256 idxT = trueIndices[pTrue];
            uint256 idxF = falseIndices[pFalse];

            if (remIn[idxT] == 0) {
                pTrue++;
                continue;
            }
            if (remIn[idxF] == 0) {
                pFalse++;
                continue;
            }

            (MatchOutcome memory resT, MatchOutcome memory resF, bool advanceT, bool advanceF, bool matchedAny) = _processPair(
                intents[idxT], intents[idxF], remIn[idxT], remIn[idxF], price18, outcomes[idxT], outcomes[idxF]
            );

            outcomes[idxT] = resT;
            outcomes[idxF] = resF;

            if (!matchedAny) {
                // MinAmountOut check failed -> advance both pointers to avoid loop deadlock
                pTrue++;
                pFalse++;
            } else {
                if (advanceT) {
                    remIn[idxT] = 0;
                    pTrue++;
                } else {
                    remIn[idxT] = intents[idxT].amount - outcomes[idxT].matchedAmountIn;
                }

                if (advanceF) {
                    remIn[idxF] = 0;
                    pFalse++;
                } else {
                    remIn[idxF] = intents[idxF].amount - outcomes[idxF].matchedAmountIn;
                }
            }
        }

        return outcomes;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Helper Functions
    // ──────────────────────────────────────────────────────────────────────

    /// @dev Processes a potential match between a true intent and a false intent.
    function _processPair(
        RevealedIntent memory intentT,
        RevealedIntent memory intentF,
        uint256 remT0,
        uint256 remF1,
        uint256 price18,
        MatchOutcome memory outcomeT,
        MatchOutcome memory outcomeF
    )
        private
        pure
        returns (MatchOutcome memory newT, MatchOutcome memory newF, bool advanceT, bool advanceF, bool matchedAny)
    {
        newT = outcomeT;
        newF = outcomeF;

        uint256 remT0_in_1 = _mulDiv(remT0, price18, 1e18);
        if (remT0_in_1 == 0) {
            return (newT, newF, true, false, false);
        }

        uint256 matched0;
        uint256 matched1;

        if (remT0_in_1 <= remF1) {
            matched0 = remT0;
            matched1 = remT0_in_1;
            advanceT = true;
            advanceF = (remT0_in_1 == remF1);
        } else {
            matched1 = remF1;
            matched0 = _mulDiv(remF1, 1e18, price18);
            advanceT = false;
            advanceF = true;
        }

        if (matched0 == 0 || matched1 == 0) {
            return (newT, newF, true, true, false);
        }

        // Verify pro-rated minAmountOut for both sides.
        // Uses _mulDiv to avoid intermediate overflow on large token amounts.
        bool passTrue = _mulDiv(matched1, intentT.amount, 1) >= _mulDiv(matched0, intentT.minAmountOut, 1);
        bool passFalse = _mulDiv(matched0, intentF.amount, 1) >= _mulDiv(matched1, intentF.minAmountOut, 1);

        if (passTrue && passFalse) {
            newT.matchedAmountIn += matched0;
            newT.matchedAmountOut += matched1;
            newT.residualAmountIn -= matched0;

            newF.matchedAmountIn += matched1;
            newF.matchedAmountOut += matched0;
            newF.residualAmountIn -= matched1;

            return (newT, newF, advanceT, advanceF, true);
        } else {
            return (newT, newF, true, true, false);
        }
    }

    /// @dev Partitions intent indices into trueIndices and falseIndices, sorted by ID ascending.
    function _partitionAndSort(RevealedIntent[] memory intents)
        private
        pure
        returns (uint256[] memory trueIndices, uint256[] memory falseIndices)
    {
        uint256 n = intents.length;
        uint256 trueCount = 0;
        for (uint256 i = 0; i < n; i++) {
            if (intents[i].zeroForOne) trueCount++;
        }
        uint256 falseCount = n - trueCount;

        trueIndices = new uint256[](trueCount);
        falseIndices = new uint256[](falseCount);

        uint256 tIdx = 0;
        uint256 fIdx = 0;
        for (uint256 i = 0; i < n; i++) {
            if (intents[i].zeroForOne) {
                trueIndices[tIdx++] = i;
            } else {
                falseIndices[fIdx++] = i;
            }
        }

        _sortIndicesById(trueIndices, intents);
        _sortIndicesById(falseIndices, intents);
    }

    /// @dev Insertion sort indices by intent ID ascending.
    function _sortIndicesById(uint256[] memory indices, RevealedIntent[] memory intents) private pure {
        uint256 len = indices.length;
        for (uint256 i = 1; i < len; i++) {
            uint256 key = indices[i];
            uint256 keyId = intents[key].id;
            int256 j = int256(i) - 1;
            while (j >= 0 && intents[indices[uint256(j)]].id > keyId) {
                indices[uint256(j + 1)] = indices[uint256(j)];
                j--;
            }
            indices[uint256(j + 1)] = key;
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Safe Math Helpers
    // ──────────────────────────────────────────────────────────────────────

    /// @dev Calculates `(a * b) / denominator` without risk of intermediate overflow.
    ///      Uses the same 512-bit intermediate product technique as Uniswap v4's FullMath.mulDiv.
    ///      When `denominator == 1`, this is a safe multiplication that reverts on overflow.
    /// @param a First multiplicand.
    /// @param b Second multiplicand.
    /// @param denominator Divisor (must be > 0).
    /// @return result The result of (a * b) / denominator, rounded down.
    function _mulDiv(uint256 a, uint256 b, uint256 denominator) private pure returns (uint256 result) {
        require(denominator > 0, "mulDiv: zero denominator");

        // We use unchecked to detect overflow without reverting.
        // The overflow check is done manually: if prod0 / a != b, overflow occurred.
        unchecked {
            uint256 prod0 = a * b; // Low 256 bits of the product
            uint256 prod1; // High 256 bits of the product

            // Detect overflow: if a != 0 && prod0 / a != b, then overflow occurred.
            if (a == 0 || b == 0) {
                return 0;
            }
            if (prod0 / a == b) {
                // No overflow — simple division.
                return prod0 / denominator;
            }

            // Overflow case: compute 512-bit product.
            // This uses Knuth's method via assembly for gas efficiency.
            assembly {
                let mm := mulmod(a, b, not(0))
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }

            // Ensure result fits in 256 bits.
            require(prod1 < denominator, "mulDiv: overflow");

            // 512 by 256 division.
            // Make division exact by subtracting the remainder from [prod1 prod0].
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
            }
            assembly {
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            // Factor powers of two out of denominator.
            uint256 twos;
            assembly {
                twos := and(sub(0, denominator), denominator)
            }
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
            }
            assembly {
                let flip := add(div(sub(0, twos), twos), 1)
                prod0 := or(prod0, mul(prod1, flip))
            }

            // Compute the modular inverse of denominator using Newton-Raphson iteration.
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;

            result = prod0 * inv;
        }
    }
}
