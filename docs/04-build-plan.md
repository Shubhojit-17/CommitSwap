# CommitSwap — Build Plan

## Overview

This document defines the full implementation sequence for CommitSwap — from Foundry smart contracts through to the frontend UI. The ordering is designed so that each layer is tested in isolation before being composed with the next, avoiding late-stage rewrites. The key structural insight: **the commit/bond layer never depends on matching-logic internals**, and the matching logic is a pure library that can be unit-tested without any Uniswap v4 infrastructure. Phase 8 adds a custom web UI that makes the full lifecycle visually interactive.

## Phase Dependency Graph

```
Phase 1: Commit / Reveal / Bond Escrow (standalone)
    │
Phase 2: Window Math (standalone, fuzz-tested)
    │
Phase 3: Matching Logic (pure library, unit-tested)
    │
Phase 4: Wire Matching into settleBatch()
    │       (uses deployFreshManagerAndRouters())
    │       (single matched pair, assert zero-sum deltas)
    │
Phase 5: AMM Fallback via return-delta
    │       (test 0%-matched and 100%-matched extremes)
    │
Phase 6: Keeper Fee + Bond Forfeiture
    │       (fuzzed reveal/non-reveal mix)
    │
Phase 7: Fork Test on Base Mainnet State
    │       (real gas numbers)
    │
Phase 8: Frontend UI (web dashboard)
            (commit / reveal / settle UX + live window state)
```

> [!NOTE]
> Phase 2 (Window Math) was deliberately inlined into `CommitRevealStore.sol` rather than extracted to a separate `WindowLib.sol`. See Phase 2 notes below.

---

## Phase 1: Commit / Reveal / Bond Escrow (Standalone)

**Goal**: Implement and test the commit/reveal state machine and bond escrow in isolation, with no Uniswap v4 dependency.

**What to build**:
- `CommitRevealStore.sol`: A standalone contract (not a hook yet) that implements:
  - `commit(bytes32 intentHash) payable` — stores commitment, escrows bond
  - `reveal(uint256 commitmentId, ...)` — verifies hash, stores plaintext directly in the `Commitment` struct
  - `forfeitBond(uint256 commitmentId)` — callable after reveal window closes if not revealed
  - Storage: `commitments` mapping (single struct containing both commitment metadata and plaintext fields populated on reveal), `windowCommitIds` mapping, `windowSettled` mapping (prep for Phase 4)
  - Immutable constructor parameters: `POOL_ID`, `WINDOW_BLOCKS`, `MIN_BOND`
- No dependency on `BaseHook`, `IPoolManager`, or any v4 code.

**What to test**:
- Commit stores correctly; hash matches on reveal; wrong hash reverts.
- Bond is escrowed on commit; returned on successful settle; forfeited if not revealed.
- Cannot reveal before window closes; cannot reveal for wrong `msg.sender`.
- Cannot double-commit with same commitId; cannot double-reveal.

**Why this order**: The commit/reveal/bond layer is the data layer. It has no dependency on matching or AMM logic. If the interface here needs to change (e.g., bond denomination, hash inputs), it won't ripple into the matching engine.

---

## Phase 2: Window Math (Inlined into CommitRevealStore)

**Goal**: ~~Implement the window calculation as a pure library and fuzz-test its edge cases.~~ **[UPDATED]** Window math was deliberately inlined as `currentWindowIndex()` inside `CommitRevealStore.sol` rather than extracted to a separate `WindowLib.sol`. This simplification was made because the function is trivial (`block.number / WINDOW_BLOCKS`) and doesn't justify a separate library for the hackathon scope.

**What was built**:
- `currentWindowIndex()` — public view function in `CommitRevealStore.sol`: returns `block.number / WINDOW_BLOCKS`
- Window math is tested via the commit/reveal timing tests in `CommitRevealStore.t.sol` (fuzz tests cover window boundary conditions)

**What was originally planned but not built**:
- `WindowLib.sol` with `currentWindow(blockNumber, windowSize)` and `isWindowClosed(windowId, blockNumber, windowSize)` — these are unnecessary given the inlined approach

**Why the change**: The window calculation is a single division. Extracting it to a library adds deployment overhead and import complexity with no meaningful testability benefit. The inlined function is tested through the commit/reveal fuzz tests which exercise window boundaries thoroughly.

---

## Phase 3: Matching Logic (Pure Library, Unit-Tested)

**Goal**: Implement the CoW matching algorithm as a pure `internal` library with no side effects, no Uniswap v4 dependency, and no storage reads.

**What to build**:
- `IntentMatcher.sol`: A library with `internal pure` functions that takes an array of revealed intents and returns matching outcomes:
  - Input: `RevealedIntent[] memory intents`
  - Output: `MatchResult[] memory matches, UnmatchedIntent[] memory residuals`
  - A `MatchResult` specifies: intentA index, intentB index, matched amount, settlement price.
  - An `UnmatchedIntent` specifies: intent index, unmatched amount (to be routed to AMM).
  - Price logic: midpoint of the two intents' implied prices, or midpoint of the AMM spot price and the intent's limit price. [Assumption — exact formula TBD; see `06-open-questions.md`]

**What to test (unit)**:
- Two perfectly opposing intents (A sells X for Y, B sells Y for X, equal amounts) → full match, zero residual.
- Two opposing intents with unequal amounts → partial match, one residual.
- All intents in the same direction → zero matches, all residual.
- Single intent → zero matches, full residual.
- Zero intents → zero matches, zero residuals.
- `minAmountOut` violation → intent is excluded from matching (treated as unmatchable).
- Multiple pairs: 4 intents, 2 in each direction → 2 matches.

**Why this order**: The matching logic is the algorithmic core of CommitSwap. Testing it as a pure function (no storage, no EVM side effects) makes it easy to reason about correctness and catch bugs before integrating with the PoolManager.

---

## Phase 4: Wire Matching into settleBatch()

**Goal**: Integrate the matching logic into the hook's `unlockCallback`, execute a single matched pair via `PoolManager`, and assert zero-sum deltas.

**What to build**:
- `CommitSwapHook.sol`: The actual hook contract extending `BaseHook`. Wire together:
  - Commit/reveal from Phase 1 (refactored into the hook)
  - Window math from Phase 2
  - Matching from Phase 3
  - `settleBatch(uint256 windowId)` → calls `poolManager.unlock()`
  - `unlockCallback()` → runs matching, executes CoW settlements via `poolManager.take()` and `poolManager.settle()`

**What to test**:
- Use `deployFreshManagerAndRouters()` from v4-core test utilities to set up a test environment. [Confirmed — standard Foundry test pattern for v4 hooks]
- Deploy the hook with the correct address prefix (using HookMiner or CREATE2 salt mining). [Likely — standard pattern, exact HookMiner API to be verified against current v4-periphery]
- Initialize a pool with the hook attached.
- Two users commit opposing intents, reveal, then a third party calls `settleBatch()`.
- Assert: both users' token balances change correctly; PoolManager currency deltas are zero after the unlock session.

**Why this order**: This is the first phase that touches Uniswap v4 infrastructure. By this point, each component (commit/reveal, window math, matching) is individually tested. This phase tests the composition.

---

## Phase 5: AMM Fallback via Return-Delta

**Goal**: Implement the fall-through-to-AMM leg for unmatched residuals using `BeforeSwapDelta` and `beforeSwapReturnDelta`.

**What to build**:
- In the `unlockCallback`, after CoW matching, route unmatched residuals through `poolManager.swap()`.
- The hook's `_beforeSwap()` returns a `BeforeSwapDelta` that adjusts the swap amount to match the unmatched residual. [Confirmed — this is the standard custom accounting pattern in v4; see Uniswap v4 custom accounting guide]
- The hook must track which swaps are "settlement fallback swaps" vs. normal pool swaps (e.g., using a transient storage flag set before calling `swap()` inside the callback).

**What to test**:
- **0% matched**: All intents in the same direction. The entire batch goes through the AMM. Assert: AMM pool state changes correctly; user balances reflect AMM execution prices; deltas zero.
- **100% matched**: All intents perfectly matched. No AMM interaction. Assert: pool state unchanged; user balances reflect midpoint matching price; deltas zero.
- **Partial match**: Some matched, some fall through. Assert: correct split between matched and AMM-executed amounts.

**Why this order**: AMM fallback is the most complex accounting piece (it involves `BeforeSwapDelta` and the interaction between the hook's own `_beforeSwap()` and the PoolManager). Testing it after the pure matching logic is verified isolates this complexity.

---

## Phase 6: Keeper Fee + Bond Forfeiture

**Goal**: Implement and fuzz-test the economic incentive layer.

**What to build**:
- In `unlockCallback`, after matching and AMM fallback:
  - Iterate unrevealed commitments; forfeit their bonds to the keeper fee pool.
  - **Bond retention model**: Do NOT return bonds on `reveal()`. Instead, hold all bonds until `settleBatch()`. The keeper takes a small cut (e.g., 5–10%) from ALL bonds in the window (revealed or not), and returns the remainder to committers. This guarantees the keeper always gets paid regardless of reveal rate or match rate.
  - Compute keeper fee: bond cut + forfeited bonds (from unrevealed commitments) + skim from AMM fallback.
  - Transfer keeper fee to `msg.sender` (the `settleBatch()` caller).
  - Set `windowSettled[windowIndex] = true` to prevent double-settlement.

> [!IMPORTANT]
> This phase will require changing `reveal()` to NOT return the bond immediately. The `windowSettled` mapping has already been added to `CommitRevealStore.sol` in preparation.

**What to test (fuzz)**:
- Fuzz the reveal/non-reveal mix: for a random subset of commitments, reveal some and leave others unrevealed. Assert:
  - All revealed intents are either matched or routed to AMM.
  - All unrevealed bonds are forfeited.
  - Keeper fee equals sum of forfeited bonds + AMM skim.
  - All deltas zero.
- Edge case: zero reveals (all forfeit) — settlement should still succeed, keeper gets all bonds.
- Edge case: all revealed, zero forfeit — keeper gets only AMM skim (or zero if 100% matched).

**Why this order**: The keeper/bond layer is the economic incentive layer. It depends on both matching and AMM fallback being correct. Testing it last with fuzzing catches edge cases in the composition.

---

## Phase 7: Fork Test Against Base Mainnet State

**Goal**: Get real gas numbers and validate against live pool state.

**What to build**:
- A Foundry fork test using `vm.createSelectFork(baseRpcUrl)` that:
  - Forks Base mainnet at a recent block.
  - Uses a real Uniswap v4 pool (e.g., ETH/USDC) with real liquidity.
  - Deploys the CommitSwap hook.
  - Runs a full commit → reveal → settleBatch lifecycle.
  - Records gas usage for each phase.

**What to measure**:
- Gas cost of `commit()` (expected: cheap — one storage write + ETH transfer).
- Gas cost of `reveal()` (expected: cheap — one hash computation + storage writes).
- Gas cost of `settleBatch()` for various batch sizes (1, 5, 10, 20 intents).
- Gas cost breakdown: CoW matching vs. AMM fallback vs. bond handling.
- Compare with L1 gas costs to validate the "this wouldn't work on L1" claim.

**Why this is last**: Fork tests are slow, expensive (require RPC access), and depend on all other phases being correct. They validate the whole system against real state but shouldn't be used for iterative development.

---

## Phase 7b: Deploy to Base Sepolia Testnet

**Goal**: Deploy the hook to a live testnet and verify it works outside of Anvil/fork tests.

**What to build**:
- Foundry deploy script (`forge script` or `forge create`) for deploying `CommitSwapHook.sol` to Base Sepolia.
- Contract verification on Basescan via `forge verify-contract`.
- Output the deployed contract address and ABI for the frontend (Phase 8).
- Seed the deployment with an initial pool and test commitments.

**Why this exists**: Fork tests (Phase 7) validate against real state in a local Anvil fork, but Phase 8's frontend needs a deployed contract on a live chain. This step bridges the gap.

---

## Phase 8: Frontend UI (Web Dashboard)

**Goal**: Build a custom web UI that gives users and demo audiences a visual, interactive way to walk through the full CommitSwap lifecycle — commit, reveal, and settle — without touching a CLI or block explorer.

**Why a custom UI**: CommitSwap's three-phase lifecycle (commit → reveal → settle batch) is unintuitive when demoed through raw Etherscan transactions. A purpose-built dashboard makes the flow legible: users see the current window countdown, their pending commitments, the reveal deadline, and settlement results in real time. For a hackathon presentation, this is the difference between "trust me, it works" and "watch it work."

**Tech stack**:
- **Framework**: Vite + React — lightweight, fast HMR, good for single-page dApp UX.
- **Wallet connection**: wagmi + viem + RainbowKit for wallet connect, chain switching (Base), and contract interaction.
- **Contract interaction**: Auto-generated TypeScript ABIs from Foundry's `out/` artifacts via wagmi CLI or manual ABI import.
- **Styling**: Vanilla CSS with a dark-mode-first design system — glassmorphism panels, gradient accents, micro-animations on state transitions.
- **State**: On-chain reads via wagmi hooks (`useReadContract`, `useWatchContractEvent`) for live window state, commitment list, and settlement status.

**What to build**:

### 8a. Dashboard / Home
- **Window countdown**: Live display of the current `windowId`, blocks remaining until close, and a visual progress bar.
- **Pool info**: Token pair, POOL_ID, contract address, current AMM spot price (read from pool's `slot0`).
- **Recent activity feed**: Stream of `Committed`, `Revealed`, `Settled` events rendered as a timeline.

### 8b. Commit Panel
- Form: token direction toggle (zeroForOne), amount input, minAmountOut input, salt (auto-generated or manual).
- Client-side hash preview: shows the `keccak256(abi.encode(...))` before submitting.
- "Commit" button → sends `commit(bytes32 intentHash)` with bond value attached.
- Post-commit: shows the user's `commitId` and a copy-to-clipboard for the reveal parameters (amount, minAmountOut, zeroForOne, salt) — since these must be kept secret until reveal.

### 8c. Reveal Panel
- Lists the user's unrevealed commitments for closed windows.
- "Reveal" button per commitment → sends `reveal(commitId, amount, minAmountOut, zeroForOne, tokenPair, salt)` with parameters auto-populated from local storage (saved at commit time).
- Status indicator: pending / revealed / expired (bond forfeitable).

### 8d. Settle Panel
- Shows closed windows that have not yet been settled.
- "Settle Batch" button → calls `settleBatch(windowId)`. Any wallet can trigger this (permissionless).
- Post-settlement view: matched pairs, AMM-fallback residuals, keeper fee earned, bonds returned/forfeited — rendered as a visual breakdown (pie chart or bar).

### 8e. History / Explorer
- Per-window breakdown: number of commitments, reveals, matches, residuals, gas used.
- Per-user view: all past commitments, their outcomes (matched / AMM / forfeited), bond status.

**What to test**:
- Wallet connection and chain switching to Base (or local Anvil fork).
- Full lifecycle walkthrough: commit → wait for window close → reveal → settle → verify balances.
- Error states: insufficient bond, wrong hash, reveal before window close, double-reveal — all surfaced as user-friendly toast notifications.
- Responsive layout: desktop-first, but legible on tablet for live demo.

**Why this order**: The UI depends on a stable contract ABI (finalized after Phase 6) and ideally a deployed/forkable instance (Phase 7). Building it last means zero risk of ABI churn forcing UI rewrites. During development, the UI can target a local Anvil instance running the fork test setup from Phase 7.

---

## Why This Order Prevents Late-Stage Rewrites

1. **Phase 1 (commit/reveal)** has no dependency on matching internals. If we change how matching works (e.g., different price formula), the commit/reveal layer is unaffected.
2. **Phase 3 (matching)** is a pure library. If we change how the PoolManager is invoked (e.g., different `take()`/`settle()` calling convention), the matching algorithm doesn't change.
3. **Phase 4 (wiring)** is the integration point. If it fails, the bug is in the wiring, not in the components — because the components are already tested.
4. **Phase 5 (AMM fallback)** is additive — it handles the "unmatched" case without changing the matched case.
5. **Phase 6 (economics)** is a layer on top of settlement — it doesn't affect matching or AMM logic.
6. **Phase 8 (frontend)** depends on a stable ABI from Phases 1–6 and a deployable artifact from Phase 7. Building it last avoids UI churn from contract interface changes.

---

*Cross-references: see `01-architecture.md` for design details, `05-testing-plan.md` for the complete test matrix, `06-open-questions.md` for unresolved decisions that may affect build order.*
