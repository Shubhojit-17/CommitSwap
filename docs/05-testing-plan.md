# CommitSwap — Testing Plan

## Overview

This document specifies the test suite for CommitSwap, organized by test type: unit tests, fuzz tests, invariant tests, and fork tests. Every test maps back to a build phase from `04-build-plan.md` and an attack vector from `02-threat-model.md`.

## Test Infrastructure

- **Framework**: Foundry (`forge test`)
- **v4 test utilities**: `deployFreshManagerAndRouters()` from `v4-core/test/utils/` for setting up PoolManager + routers in test environments. [Likely — standard pattern; exact import path to be verified against current v4-core]
- **Hook deployment**: HookMiner or CREATE2 salt mining to deploy the hook at an address matching its permission flags. [Likely — standard pattern]
- **Token mocks**: Use `MockERC20` for test tokens.

---

## Unit Tests

### Phase 1: Commit / Reveal / Bond Escrow

| Test ID | Description | Expected Result |
|---|---|---|
| `test_commit_storesCorrectly` | Call `commit()` with valid hash and bond → verify stored commitment fields | Commitment stored with correct hash, committer, bond, windowIndex |
| `test_commit_requiresMinBond` | Call `commit()` with insufficient `msg.value` | Reverts |
| `test_reveal_matchesHash` | Commit, then reveal with correct plaintext → hash matches | Reveal succeeds; intent stored |
| `test_reveal_wrongHash_reverts` | Commit, then reveal with wrong plaintext | Reverts |
| `test_reveal_wrongSender_reverts` | Commit as Alice, then reveal as Bob | Reverts |
| `test_reveal_beforeWindowClose_reverts` | Commit in window W, reveal in same window W | Reverts |
| `test_reveal_afterWindowClose_succeeds` | Commit in window W, advance to window W+1, reveal | Succeeds |
| `test_reveal_doubleReveal_reverts` | Reveal the same commitId twice | Reverts |
| `test_forfeitBond_unrevealed` | Commit without revealing, advance past window, forfeit | Bond transferred to fee pool |
| `test_forfeitBond_alreadyRevealed_reverts` | Reveal, then try to forfeit | Reverts |
| `test_commit_emitsEvent` | Call `commit()` | `Committed` event emitted with correct parameters |

### Phase 2: Window Math

| Test ID | Description | Expected Result |
|---|---|---|
| `test_currentWindow_basic` | `currentWindow(0, 50) == 0`, `currentWindow(49, 50) == 0`, `currentWindow(50, 50) == 1` | Correct window IDs |
| `test_currentWindow_boundary` | `currentWindow(N-1, N)` vs `currentWindow(N, N)` for various N | Window increments at boundary |
| `test_isWindowClosed_basic` | `isWindowClosed(0, 50, 50) == true`, `isWindowClosed(0, 49, 50) == false` | Correct boolean |
| `test_currentWindow_windowSizeOne` | `currentWindow(b, 1) == b` for all b | Each block is its own window |
| `test_currentWindow_windowSizeZero_reverts` | `currentWindow(b, 0)` | Reverts (division by zero) |

### Phase 3: Matching Logic

| Test ID | Description | Expected Result |
|---|---|---|
| `test_match_perfectOpposing` | A sells 100 X→Y, B sells 100 Y→X | 1 match (100 units), 0 residuals |
| `test_match_unequalOpposing` | A sells 100 X→Y, B sells 60 Y→X | 1 match (60 units), 1 residual (A has 40 unmatched) |
| `test_match_sameDirection` | A sells 100 X→Y, B sells 50 X→Y | 0 matches, 2 residuals |
| `test_match_singleIntent` | A sells 100 X→Y | 0 matches, 1 residual |
| `test_match_emptyBatch` | No intents | 0 matches, 0 residuals |
| `test_match_multiPair` | 4 intents, 2 X→Y and 2 Y→X | 2 matches |
| `test_match_minAmountOut_violated` | Matching price would give A less than `minAmountOut` | A excluded from matching; goes to residual |
| `test_match_priceCalculation` | Two opposing intents with known amounts | Settlement price equals expected midpoint |

### Phase 4: Integration (settleBatch with PoolManager)

| Test ID | Description | Expected Result |
|---|---|---|
| `test_settleBatch_singleMatchedPair` | Two opposing commits, both revealed, settle | User balances correct; PM deltas zero |
| `test_settleBatch_windowNotClosed_reverts` | Call `settleBatch()` for current window | Reverts |
| `test_settleBatch_alreadySettled_reverts` | Settle same window twice | Reverts |
| `test_settleBatch_noReveals` | All commits unrevealed | Settlement succeeds; bonds forfeited; no matching |

### Phase 5: AMM Fallback

| Test ID | Description | Expected Result |
|---|---|---|
| `test_settleBatch_0pctMatched` | All intents same direction | All go through AMM; deltas zero |
| `test_settleBatch_100pctMatched` | Perfect opposing intents | None go through AMM; pool state unchanged; deltas zero |
| `test_settleBatch_partialMatch` | Partial match + residual AMM | Correct split; deltas zero |
| `test_settleBatch_ammFallback_respectsSlippage` | Unmatched residual exceeds pool liquidity | Reverts or partial fill per `minAmountOut` |

### Phase 6: Keeper Fee + Bond

| Test ID | Description | Expected Result |
|---|---|---|
| `test_keeperFee_allForfeited` | Zero reveals → all bonds forfeited | Keeper receives sum of all bonds |
| `test_keeperFee_noForfeitures` | All revealed + 100% matched | Keeper receives zero or AMM skim only |
| `test_bondReturn_onSettlement` | Committed, revealed, settled | Bond returned to committer |

---

## Fuzz Tests

### Phase 2: Window Math

| Test ID | Description | Bounds/Assume |
|---|---|---|
| `testFuzz_windowMonotonicity` | `currentWindow(b, N)` non-decreasing as `b` increases | `assume(N > 0); assume(b2 >= b1)` → `currentWindow(b2, N) >= currentWindow(b1, N)` |
| `testFuzz_windowBoundary` | Window increments exactly at block `N * (w + 1)` | `assume(N > 0); assume(N < 1e6)` |
| `testFuzz_windowConsistency` | `isWindowClosed(currentWindow(b, N), b, N) == false` | `assume(N > 0)` |

### Phase 3: Matching Logic

| Test ID | Description | Bounds/Assume |
|---|---|---|
| `testFuzz_matchConservation` | Sum of all matched amounts + all residual amounts == sum of all input amounts | `assume(intents.length <= 20); assume(amountIn > 0 && amountIn < 1e30)` |
| `testFuzz_matchNoOverflow` | Matching with large amounts doesn't overflow | `assume(amountIn < type(uint128).max)` |

### Phase 6: Keeper Fee + Bond Forfeiture

| Test ID | Description | Bounds/Assume |
|---|---|---|
| `testFuzz_revealNonRevealMix` | Fuzz the subset of commitments that get revealed vs. not. Assert: forfeited bonds == sum of unrevealed bonds; keeper fee >= forfeited bonds; all deltas zero. | `assume(numCommits > 0 && numCommits <= 10); assume(revealBitmap < (1 << numCommits))` |
| `testFuzz_bondAmounts` | Fuzz bond amounts and verify correct escrow/return/forfeit accounting | `assume(bondAmount >= MIN_BOND && bondAmount < 1e24)` |

---

## Invariant Tests

### The Primary Invariant

**This is the single required invariant test for CommitSwap.**

```
invariant: After every settleBatch() call:
  sum(currency0 deltas across all addresses) == 0
  AND
  sum(currency1 deltas across all addresses) == 0
```

This invariant is enforced by the PoolManager itself (it reverts if deltas are nonzero at the end of `unlock()`), but the invariant test validates that our hook correctly sets up all operations to achieve this. [Confirmed — Uniswap v4 flash accounting guarantee]

**Implementation approach**:
- Use Foundry's invariant testing with a handler contract that randomly performs sequences of: commit, reveal, settleBatch, with randomized parameters.
- After each `settleBatch()` (if it succeeds), assert the invariant.
- The handler should generate both valid and invalid sequences to stress-test the state machine.

### Secondary Invariants

| Invariant | Description |
|---|---|
| `invariant_noDoubleForfeit` | A bond can only be forfeited once |
| `invariant_bondConservation` | Total bonds escrowed == total bonds returned + total bonds forfeited + total bonds still held |
| `invariant_windowSettledOnce` | Each windowId is settled at most once |
| `invariant_revealOnlyAfterClose` | No revealed intent has a windowId == current window |

---

## Fork Tests (Phase 7)

| Test ID | Description | Chain |
|---|---|---|
| `test_fork_fullLifecycle` | Full commit → reveal → settleBatch on a forked Base mainnet pool (ETH/USDC) | Base mainnet fork |
| `test_fork_gasCommit` | Measure gas for `commit()` | Base mainnet fork |
| `test_fork_gasReveal` | Measure gas for `reveal()` | Base mainnet fork |
| `test_fork_gasSettleBatch_N` | Measure gas for `settleBatch()` with N = 1, 5, 10, 20 intents | Base mainnet fork |
| `test_fork_realLiquidity` | Verify AMM fallback works against real pool liquidity (not just mock pools) | Base mainnet fork |

---

## Test Coverage Goals

| Category | Goal |
|---|---|
| Unit tests | 100% of public/external functions |
| Branch coverage | All revert conditions tested |
| Fuzz tests | All arithmetic operations with user-controlled inputs |
| Invariant tests | Primary delta invariant + all secondary invariants |
| Fork tests | At least one full lifecycle on Base mainnet fork |

---

## Frontend Tests (Phase 8)

### Wallet Integration

| Test ID | Description | Expected Result |
|---|---|---|
| `test_ui_walletConnect` | Connect wallet via RainbowKit | Wallet connects; address displayed in UI |
| `test_ui_chainSwitch` | Switch to Base / Base Sepolia / local Anvil fork | Chain switches; contract reads update |
| `test_ui_wrongChain` | Attempt interaction on wrong chain | UI shows chain-switch prompt |

### End-to-End Lifecycle

| Test ID | Description | Expected Result |
|---|---|---|
| `test_ui_commitFlow` | Fill commit form, submit transaction | Commitment created; ID shown; reveal params saved to localStorage |
| `test_ui_revealFlow` | Click "Reveal" on unrevealed commitment during reveal window | Reveal succeeds; commitment status updates |
| `test_ui_settleFlow` | Click "Settle Batch" for a closed window | Settlement executes; results displayed |
| `test_ui_fullLifecycle` | Commit → wait → reveal → settle (2 users, opposing intents) | Both users' balances update; match results shown |

### Error States

| Test ID | Description | Expected Result |
|---|---|---|
| `test_ui_insufficientBond` | Submit commit with insufficient bond value | User-friendly error toast |
| `test_ui_revealBeforeWindow` | Attempt reveal during commit window | Clear error message with countdown |
| `test_ui_revealAfterWindow` | Attempt reveal after reveal window closes | Error with "bond forfeited" warning |
| `test_ui_doubleReveal` | Attempt to reveal same commitment twice | Error indicating already revealed |

### Responsive Layout

| Test ID | Description | Expected Result |
|---|---|---|
| `test_ui_desktop` | View dashboard at 1920×1080 | All panels visible; no overflow |
| `test_ui_tablet` | View dashboard at 1024×768 | Panels stack correctly; text legible |
| `test_ui_countdown` | Window countdown timer | Updates in real-time; matches on-chain state |

---

*Cross-references: see `04-build-plan.md` for which phase each test belongs to, `02-threat-model.md` for which attack vectors each test covers.*
