# CommitSwap — Architecture

## Overview

CommitSwap is a Uniswap v4 hook deployed on an L2 (default: Base) that implements a commit → reveal → settleBatch lifecycle to protect swaps from sandwich attacks. The hook does NOT intercept `beforeSwap`/`afterSwap` for normal pool interactions — instead, it provides a separate entrypoint for committing swap intents, which are later batch-settled in a single `PoolManager.unlock()` session.

## Why L2-Only

Running a commit-reveal-batch lifecycle on Ethereum L1 is impractical for the same reason Angstrom uses an off-chain validator network there: gas costs. Each phase (commit, reveal, settleBatch) is a separate transaction, and the batch settlement performs multiple pool operations inside a single `unlock()` session. On L1, this would cost hundreds of thousands of gas per batch — prohibitive for small swaps. On L2s like Base (where calldata is cheap and block times are fast), the economics work. [Likely — standard reasoning; exact gas numbers will come from fork tests in build phase 7]

Base is the default deployment target because:
- Highest Uniswap v4 swap volume among L2s covered in UHI10 course materials [Assumption — based on user-provided context]
- Cheap gas makes multi-step on-chain lifecycles viable
- Unichain is the second choice if Uniswap Foundation alignment matters more than volume

## Lifecycle

```
┌──────────┐    ┌──────────┐    ┌──────────────┐
│  COMMIT  │───▶│  REVEAL  │───▶│ SETTLE BATCH │
│ (user)   │    │ (user)   │    │ (anyone)     │
└──────────┘    └──────────┘    └──────────────┘
  Window W        Window W+1      Window W+1
                  (after close)   (after close)
```

### Phase 1: Commit

**Who calls**: The user (or a relay on the user's behalf).

**When**: During window `W`, defined as `block.number / N` for some constant `N`. [Assumption — `N` is not yet decided; see `06-open-questions.md`]

**What happens**:
1. User constructs their swap intent off-chain: `(amount, minAmountOut, zeroForOne, salt)`.
2. User computes `intentHash = keccak256(abi.encode(amount, minAmountOut, zeroForOne, poolId, salt, msg.sender))`. Including `msg.sender` in the hash prevents a third party from front-running the reveal with the same parameters. Including `poolId` prevents cross-deployment replay. [Design choice — see CommitRevealStore.sol §6]
3. User calls `commit(bytes32 intentHash)` on the CommitRevealStore contract, sending a bond in native ETH (≥ `MIN_BOND`). [Implemented — see CommitRevealStore.sol]
4. The contract stores `Commitment { committer, intentHash, windowIndex, bondAmount, revealed: false, ... }` and emits a `Committed` event.

**Design-level signature** (matches implementation):
```
function commit(bytes32 intentHash) external payable returns (uint256 commitmentId)
  // Requires: msg.value >= MIN_BOND
  // Stores: commitments[commitmentId] = Commitment(...)
  // Appends commitmentId to windowCommitIds[currentWindowIndex()]
  // Emits: Committed(commitmentId, msg.sender, intentHash, windowIndex, msg.value)
```

**Why not `beforeSwap`**: A live `PoolManager.swap()` call already exposes plaintext `SwapParams` in calldata. Attaching a hash to a real swap is pointless — the parameters the hash is supposed to hide are already visible. Commitments must live on a separate path, outside the normal swap flow. [Confirmed — this is a fundamental architectural constraint of the Uniswap v4 swap path]

### Phase 2: Reveal

**Who calls**: The original committer.

**When**: After window `W` has closed (i.e., `block.number / N > W`), during a reveal period. The reveal period is the same as the settlement window — once the commit window closes, reveals and settlement both become possible. [Assumption — whether there's a dedicated reveal-only sub-window before settlement is TBD; see `06-open-questions.md`]

**What happens**:
1. User calls `reveal(uint256 commitmentId, uint256 amount, uint256 minAmountOut, bool zeroForOne, bytes32 poolId, bytes32 salt)` on the CommitRevealStore contract.
2. The contract verifies `msg.sender == commitment.committer`.
3. The contract verifies timing: current window must be exactly `commitment.windowIndex + 1` (reveal is only possible during the window immediately after the commit window).
4. The contract verifies `poolId == POOL_ID` (the deployed contract's pool identifier).
5. The contract recomputes `keccak256(abi.encode(amount, minAmountOut, zeroForOne, poolId, salt, committer))` and verifies it matches the stored `intentHash`.
6. The contract stores the plaintext parameters (`amount`, `minAmountOut`, `zeroForOne`) directly inside the `Commitment` struct, marks it as `revealed = true`, and returns the bond to the committer.

**Design-level signature** (matches implementation):
```
function reveal(
    uint256 commitmentId,
    uint256 amount,
    uint256 minAmountOut,
    bool zeroForOne,
    bytes32 poolId,
    bytes32 salt
) external
  // Requires: msg.sender == commitments[commitmentId].committer
  // Requires: currentWindowIndex() == commitments[commitmentId].windowIndex + 1
  // Requires: poolId == POOL_ID
  // Requires: keccak256(abi.encode(amount, minAmountOut, zeroForOne, poolId, salt, committer))
  //           == commitments[commitmentId].intentHash
  // Effects: stores plaintext in commitment struct, sets revealed = true
  // Effects: returns bond to committer (Phase 1 behavior — see C1 note below)
  // Emits: Revealed(commitmentId, amount, minAmountOut, zeroForOne)
```

### Phase 3: Settle Batch

**Who calls**: Anyone. The caller receives a keeper fee as incentive. This makes the system permissionless — no dedicated keeper network is required.

**When**: After the window has closed and at least one intent has been revealed (or the window has closed with unrevealed commitments whose bonds can be forfeited).

**What happens** (inside a single `PoolManager.unlock()` session):

1. Caller invokes `settleBatch(uint256 windowId)` on the hook.
2. The hook calls `poolManager.unlock(abi.encode(windowId))`.
3. Inside the `unlockCallback`:
   a. **CoW matching**: For each pair of opposing revealed intents (e.g., user A wants to sell token0 for token1, user B wants to sell token1 for token0), match them at the **midpoint price** (arithmetic mean of the AMM's current price and the implied price from the two intents). [Assumption — exact midpoint calculation formula is TBD; see `06-open-questions.md`] Matching uses `poolManager.take()` and `poolManager.settle()` to move tokens between the matched parties via flash accounting, without touching the AMM. This is the Coincidence-of-Wants (CoW) pattern.
   b. **AMM fallback for unmatched residuals**: Any intent (or portion of an intent) that could not be matched in step (a) is routed through the AMM pool using a `poolManager.swap()` call. The hook uses `beforeSwapReturnDelta` to adjust the swap amounts via `BeforeSwapDelta`. [Confirmed — this is the standard return-delta pattern in Uniswap v4; see the custom accounting guide] **This leg inherits ordinary MEV exposure** — see `02-threat-model.md`.
   c. **Bond forfeiture**: Any commitment from the closed window that was NOT revealed has its bond forfeited. Forfeited bonds fund the keeper fee pool.
   d. **Keeper fee payment**: The caller receives a fee from: (i) forfeited bonds, and/or (ii) a small skim from the AMM fallback swaps. [Assumption — exact fee split is TBD]
   e. **Delta resolution**: All currency deltas must net to zero by the end of the `unlock()` session. [Confirmed — this is a hard requirement of Uniswap v4's flash accounting system]

**Design-level signature**:
```
function settleBatch(uint256 windowId) external
  // Requires: block.number / N > windowId (window has closed)
  // Requires: batch not already settled for this windowId
  // Calls: poolManager.unlock(abi.encode(windowId))

function unlockCallback(bytes calldata data) external override returns (bytes memory)
  // Called by PoolManager
  // Decodes windowId from data
  // Performs CoW matching, AMM fallback, bond forfeiture, keeper fee
  // All currency deltas must resolve to zero
```

## Window Definition

A window is identified by `windowId = block.number / N`, where `N` is a protocol constant representing the window length in blocks.

- All commits with the same `windowId` are in the same batch.
- The window is "open" while `block.number / N == windowId`.
- The window is "closed" once `block.number / N > windowId`.
- Deterministic: any observer can compute the current window from `block.number` alone — no oracle or timestamp dependency.

**Example with N = 50 (on Base, ~2 seconds/block = ~100 seconds per window)**:
- Blocks 0–49: window 0
- Blocks 50–99: window 1
- A commit in block 37 has windowId = 0. It can be revealed starting at block 50.

[Assumption — N = 50 is an example; the actual value is TBD and should be fuzz-tested]

## Bond Mechanics

| Parameter | Current Design | Status |
|---|---|---|
| Bond amount | Fixed amount in native ETH (default: `MIN_BOND = 0.001 ether`, configurable at deployment) | [Implemented] |
| Bond denomination | Native ETH (sent as `msg.value`) | [Implemented] |
| Bond return | Returned to committer upon successful reveal (Phase 1) — see C1 note in Keeper Fee Mechanics below | [Implemented — Phase 1 placeholder] |
| Bond forfeiture | If commitment is not revealed by the end of window W+1, bond is forfeit | [Implemented] |
| Forfeited bond destination | `forfeitedBonds` counter; swept via `withdrawForfeited()` (Phase 1 placeholder) | [Implemented — Phase 1 placeholder] |

The bond serves two purposes:
1. **Anti-griefing**: Prevents users from spamming commitments they never intend to reveal (which would inflate batch size and waste gas during settlement).
2. **Keeper incentive**: Forfeited bonds fund the keeper fee, making `settleBatch()` calls economically rational for anyone.

## Keeper Fee Mechanics

The keeper who calls `settleBatch()` receives compensation from:
1. **Forfeited bonds** from unrevealed commitments in the batch.
2. **A small skim** from the AMM fallback leg of unmatched intents. [Assumption — percentage TBD]

> [!CAUTION]
> **Known Issue (C1 from 07-review.md)**: In the current Phase 1 implementation, bonds are returned to committers immediately on `reveal()`. This means in the happy path (100% reveals + 100% CoW matching), the keeper fee is **zero** — nobody has an economic reason to call `settleBatch()`. This breaks the permissionless settlement thesis.
>
> **Planned Fix (Phase 4/6)**: Bonds will be held until `settleBatch()` settles the window. The keeper takes a small cut (e.g., 5–10%) from ALL bonds in the window (revealed or not), and returns the remainder to committers. This guarantees the keeper always gets paid regardless of reveal rate or match rate. The `windowSettled` mapping has been added to `CommitRevealStore.sol` in preparation for this change.

## Single-Unlock-Session Atomicity

The entire batch settlement — CoW matching, AMM fallback, bond handling, keeper payment — executes inside a single `poolManager.unlock()` callback. This guarantees:

1. **Atomicity**: Either the entire batch settles or none of it does. No partial-settlement states.
2. **Flash accounting compliance**: Uniswap v4 requires that all currency deltas resolve to zero by the end of the `unlock()` session. [Confirmed — Uniswap v4 developer docs] The hook must ensure that every token taken from the PoolManager is balanced by a corresponding settlement, and vice versa.
3. **Multiple pool operations in one session**: The `unlock()` callback can perform multiple `swap()`, `take()`, `settle()`, and `mint()` calls. This is confirmed by the Uniswap v4 docs: "multiple pool actions — including a batch match + AMM fallback — can be executed inside a single unlock() session as long as net currency deltas resolve to zero by the end." [Confirmed — Uniswap developer docs on unlock callback and deltas]

## Hook Permission Flags

CommitSwap requires the following Uniswap v4 hook permissions:

```
beforeSwap: true              // To intercept fallback AMM swaps during settlement
beforeSwapReturnDelta: true   // To adjust swap amounts for unmatched residuals
```

**Allow-listing note**: Because CommitSwap uses `beforeSwapReturnDelta`, it requires manual submission to Uniswap for allow-listing. This involves providing: full description, verified hook address, deployed pool address, audit links, and public source code. [Confirmed — user-provided context on allow-listing requirements]

## Data Structures (Matches Implementation)

```solidity
/// @notice A single commitment record.
struct Commitment {
    address committer;       // The committer's address
    bytes32 intentHash;      // keccak256(abi.encode(amount, minAmountOut, zeroForOne, poolId, salt, committer))
    uint256 windowIndex;     // Window index at commit time (block.number / WINDOW_BLOCKS)
    uint256 bondAmount;      // ETH bond escrowed (0 after reveal or forfeiture)
    bool revealed;           // Whether successfully revealed
    uint256 amount;          // Plaintext swap amount (populated on reveal)
    uint256 minAmountOut;    // Plaintext min output for slippage (populated on reveal)
    bool zeroForOne;         // Plaintext swap direction (populated on reveal)
}

// Immutables (set at deployment)
uint256 public immutable WINDOW_BLOCKS;  // Blocks per window (e.g. 25)
uint256 public immutable MIN_BOND;       // Minimum bond in ETH (e.g. 0.001 ether)
bytes32 public immutable POOL_ID;        // Uniswap v4 pool identifier

// Storage
mapping(uint256 => Commitment) public commitments;       // commitmentId => Commitment
mapping(uint256 => uint256[]) public windowCommitIds;    // windowIndex => list of commitmentIds
mapping(uint256 => bool) public windowSettled;            // windowIndex => settled flag (Phase 4)
uint256 public nextCommitmentId;                          // Auto-incrementing ID counter
uint256 public forfeitedBonds;                            // Phase 1 placeholder for keeper fees
```

> [!NOTE]
> **Design choice**: Plaintext swap parameters (`amount`, `minAmountOut`, `zeroForOne`) are stored directly inside the `Commitment` struct rather than in a separate `RevealedIntent` mapping. This avoids a second storage write and simplifies Phase 4's `settleBatch()` — it can read all data from a single mapping.

---

*Cross-references: see `00-thesis.md` for positioning, `02-threat-model.md` for attack analysis, `04-build-plan.md` for implementation sequence, `05-testing-plan.md` for test coverage.*
