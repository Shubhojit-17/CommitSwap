# CommitSwap — Threat Model

## Overview

This document catalogs known attack vectors against the CommitSwap commit-reveal-batch mechanism, their current mitigation status, and residual risk. The goal is honest accounting — we state what is mitigated, what is partially mitigated, and what remains open.

## Attack Vector Table

| # | Attack | Description | Severity | Mitigation Status | Notes |
|---|---|---|---|---|---|
| 1 | Sandwich on AMM fall-through leg | Unmatched residuals routed to the AMM via `poolManager.swap()` inside `settleBatch()` are normal on-chain swaps — visible in the block, sandwichable by the block builder/sequencer. | **High** | **Open** | This is the single largest residual risk. See detailed analysis below. |
| 2 | Reveal front-running | An observer sees a `reveal()` transaction in the mempool, extracts the plaintext swap parameters, and uses them to position before the batch settles. | Medium | **Partially mitigated** | The reveal only exposes parameters; settlement is a separate tx. On L2s with a single sequencer, front-running is sequencer-dependent. See below. |
| 3 | Commit-and-never-reveal griefing | An attacker commits many hashes with bonds, never reveals, inflating batch overhead (the hook must iterate over unrevealed commitments during settlement). | Medium | **Mitigated** | Bond forfeiture makes this costly. Unrevealed commitments are skipped during matching (O(1) check per commitment), so gas overhead is bounded. |
| 4 | Last-committer timing control | An attacker waits until the last block of a window to commit, knowing all earlier commitments (by observing `Committed` events), and tailors their commitment to exploit the batch once revealed. | Medium | **Partially mitigated** | Commitment hashes are opaque — knowing that a commitment exists does not reveal its parameters. However, the number and timing of commitments leak information about anticipated batch size and direction. |
| 5 | Accounting-invariant bugs | A bug in the `unlockCallback` that causes currency deltas to not net to zero, or double-counts bonds, or miscalculates CoW matching amounts. | **Critical** | **Mitigated by design + testing** | The invariant `sum(currency0 deltas) == 0 ∧ sum(currency1 deltas) == 0` after every `settleBatch()` is enforced by the PoolManager itself (it will revert if deltas are nonzero). Additionally, this is the primary target of our invariant tests — see `05-testing-plan.md`. |
| 6 | Hash collision / preimage attack | An attacker finds a second preimage for a commitment hash, allowing them to reveal different parameters than intended. | Low | **Mitigated** | keccak256 is collision-resistant. Including `msg.sender` in the hash prevents cross-user replay. |
| 7 | Bond theft via reentrancy | A malicious token or callback reenters the hook during settlement to claim bonds multiple times. | Medium | **Mitigated by design** | Settlement runs inside `PoolManager.unlock()`, which uses a reentrancy lock. Bond state is updated before external calls (checks-effects-interactions). |
| 8 | Keeper griefing / DoS | An attacker repeatedly calls `settleBatch()` with invalid or empty windows, wasting gas. Or a keeper front-runs another keeper's settlement tx. | Low | **Mitigated** | `settleBatch()` for an already-settled window is a no-op (reverts cheaply). Multiple keepers racing is a liveness benefit, not a bug — the first valid settlement wins. |
| 9 | Cross-window replay | A revealed intent from window W is replayed in window W+1. | Low | **Mitigated** | Each commitment is bound to a `windowIndex`; the `windowSettled` mapping (added for Phase 4) prevents double-settlement of a window. The `revealed` flag prevents double-reveal of individual commitments. |
| 10 | Information leakage from commitment events | Even though hashes are opaque, the existence and timing of `Committed` events, plus the bond amounts, may leak directional information (e.g., large bonds suggest large swaps). | Low | **Open** | Inherent to any on-chain commit-reveal scheme. Mitigation would require hiding bond amounts (e.g., fixed bonds), which trades off anti-griefing calibration. |

## Detailed Analysis of Critical Vectors

### 1. Sandwich on AMM Fall-Through Leg

**The problem**: When `settleBatch()` routes unmatched residuals through the AMM via `poolManager.swap()`, this swap is a normal on-chain operation. On L2s with a single sequencer (like Base), the sequencer can see this swap in the pending transaction and extract value from it, or allow searchers to do so.

**Why this matters**: The entire premise of CommitSwap is MEV protection. If a significant fraction of intents are unmatched (e.g., all intents are in the same direction — everyone wants to sell token0 for token1), then 100% of the batch volume flows through the AMM fall-through leg and is fully exposed to ordinary MEV.

**Current mitigations**:
- CoW matching eliminates MEV on the matched portion (matched intents never touch the AMM).
- If the batch has balanced opposing flow, the fall-through leg is small.

**Potential additional mitigations** (not yet implemented — see `06-open-questions.md`):
- Route the fall-through leg through a private RPC / MEV protection relay (e.g., Flashbots Protect on Base, if available). [Likely — Flashbots Protect supports Base, but availability and latency for programmatic use from a hook is unverified]
- Split large fall-through swaps across multiple blocks to reduce per-block impact. [Assumption — adds complexity]
- Accept the exposure and document it honestly as a known limitation for the hackathon scope.

**Verdict**: This is a **known, documented, open risk**. The pitch should state it plainly rather than glossing over it.

### 2. Reveal Front-Running

**The problem**: A `reveal()` transaction contains the plaintext swap parameters (amount, minAmountOut, zeroForOne, poolId, salt). An observer who sees this pending transaction in the mempool can:
- Learn the user's intended swap direction and size.
- Potentially position before `settleBatch()` is called.

**Mitigations**:
- On L2s with a single sequencer (Base, Unichain), there is no public mempool in the traditional sense — the sequencer has FCFS ordering. Front-running requires sequencer collusion. [Likely — standard L2 sequencer assumption, but sequencer MEV extraction is a known concern]
- Reveal and settlement can be batched: a user could call `reveal()` and `settleBatch()` in the same transaction via a helper contract, reducing the window for observation. [Assumption — not yet designed]
- Even if parameters are observed, the batch settlement matches at a protocol-determined price (midpoint), not at the AMM spot price, which limits the usefulness of the leaked information for the matched portion.

**Residual risk**: On L2s where the sequencer extracts MEV or has latency-sensitive ordering, the reveal transaction is a point of information leakage. For the hackathon, we accept this and document it.

### 4. Last-Committer Timing Control

**The problem**: An attacker who commits in the last block of a window has observed all prior `Committed` events for that window. While hashes are opaque, the attacker knows:
- How many commitments exist.
- The bond amounts (which may correlate with swap sizes).
- Their own position relative to the batch.

They can choose to commit (or not) based on this information, gaining a statistical advantage.

**Mitigations**:
- Bond amounts do not directly reveal swap direction or token pair.
- The attacker cannot know the plaintext parameters of other commitments, so their advantage is limited to batch-size-based inferences.
- Possible future mitigation: add a minimum number of blocks before window close during which no new commits are accepted ("commit freeze" period). [Assumption — not currently in the design]

### 5. Accounting-Invariant Bugs

**The problem**: The `unlockCallback` is complex — it performs CoW matching, AMM fallback swaps, bond handling, and keeper fee payment, all within a single `unlock()` session. Any bug that causes currency deltas to not balance will either:
- Revert the entire batch (if the PoolManager catches it — which it will, since nonzero deltas at the end of `unlock()` cause a revert). [Confirmed — Uniswap v4 enforces this]
- Silently lose or duplicate funds (if the bug is in the hook's internal accounting but the net deltas happen to balance by coincidence).

**Mitigations**:
- The PoolManager's hard enforcement of zero-sum deltas is the primary safety net.
- Invariant testing (`sum(currency0 deltas) == 0 ∧ sum(currency1 deltas) == 0`) on every `settleBatch()` call — see `05-testing-plan.md`.
- Build order in `04-build-plan.md` is designed to test each accounting layer in isolation before composing them.

---

*Cross-references: see `01-architecture.md` for mechanism details, `05-testing-plan.md` for how we test these vectors, `06-open-questions.md` for unresolved mitigations.*
