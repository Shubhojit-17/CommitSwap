# CommitSwap — Open Questions

## Overview

This document tracks design decisions that are not yet resolved. Each question is tagged with its impact on the build plan and a suggested resolution path.

---

## 1. Exact Bond Amount — [RESOLVED]

**Question**: What should the bond amount be?

**Resolution**: Fixed bond of `MIN_BOND = 0.001 ether` in native ETH, configurable at deployment via constructor parameter. A fixed amount was chosen because at commit time the plaintext swap size is unknown (hidden in the hash), so a percentage cannot be enforced.

**Reviewer recommendation (L1 from 07-review.md)**: ✅ Implemented — `MIN_BOND` is now an `immutable` constructor parameter instead of a hardcoded `constant`.

**Impact on build plan**: Phase 1 (commit/reveal/bond). The bond mechanics are isolated, so changing this later is cheap.

---

## 2. Exact Window Length (N) — [RESOLVED]

**Question**: How many blocks should a commit window span?

**Resolution**: `WINDOW_BLOCKS` is now an `immutable` constructor parameter (default: 25 blocks = ~50 seconds on Base). Previously hardcoded as `constant WINDOW_BLOCKS = 5` (~10 seconds), which was too aggressive for production use.

**Reviewer recommendation (M1 from 07-review.md)**: ✅ Implemented — `WINDOW_BLOCKS` is now configurable at deployment. The test suite uses 5 blocks for speed; production deployments should use 25+ blocks.

**Impact on build plan**: Phase 1 (constructor change). The window length is a parameter, not a structural decision.

---

## 3. Should the Fall-Through Leg Route Through a Private Relay?

**Question**: When `settleBatch()` routes unmatched residuals through the AMM, should this swap be submitted via a private relay (e.g., Flashbots Protect on Base) to avoid MEV on the fall-through leg?

**Current assumption**: No — for the hackathon, the fall-through leg is a normal on-chain swap with documented MEV exposure. [Assumption]

**Trade-offs**:
- **Routing via private relay**: Would significantly reduce MEV exposure on the fall-through leg. But: (a) the `settleBatch()` caller would need to use a private relay for the entire transaction, (b) this adds off-chain dependency — undermining the "fully on-chain, no off-chain infra" thesis, (c) Flashbots Protect availability on Base for programmatic use from a hook is unverified. [Likely that Flashbots Protect supports Base, but unverified for this use case]
- **Not routing via relay**: Keeps the system fully on-chain and permissionless, but the fall-through leg is exposed to MEV. The pitch must state this openly.

**Suggested resolution**: For the hackathon, do NOT route through a private relay. Document the exposure plainly in `02-threat-model.md` (already done). In the demo/pitch, frame it as: "The matched portion is MEV-free; the unmatched fall-through inherits standard AMM exposure — we document this as a known limitation and note that private relay routing is a post-hackathon enhancement."

**Impact on build plan**: No impact on the build plan; this is a deployment/operational decision.

---

## 4. Hook Allow-Listing Submission Timing

**Question**: When should we submit the hook for Uniswap allow-listing?

**Context**: CommitSwap uses `beforeSwapReturnDelta`, which requires manual submission to Uniswap. The submission requires: full description, verified hook address, deployed pool address, audit links, and public source code. [Confirmed — user-provided context]

**Trade-offs**:
- **Submit early**: Risk that the hook address changes during development (any code change requires a new deployment address due to the CREATE2 address prefix requirement).
- **Submit late**: Risk of not being allow-listed in time for the hackathon demo.
- **Submit at Phase 4 completion**: By this point, the hook contract interface is stable (commit/reveal/settle/matching/AMM fallback are all wired up). Later phases add keeper fees and optimize, but don't change the hook's address-affecting code.

**Suggested resolution**: Submit for allow-listing after Phase 5 (AMM fallback) is complete and the hook is deployed to Base mainnet/testnet. This gives enough time for review while the hook contract is functionally complete. Phases 6 and 7 are additive and don't change the hook's deployed bytecode.

**Impact on build plan**: No impact on code — this is a logistics/timeline item.

---

## 5. Midpoint Price Formula for CoW Matching

**Question**: How exactly is the settlement price calculated for CoW-matched intents?

**Current assumption**: Arithmetic mean of the AMM's current spot price and the implied crossing price of the two matched intents. [Assumption]

**Options**:
- **AMM spot price**: Simple, but if the AMM price is stale or manipulated, the match price is bad.
- **Arithmetic midpoint of the two intents' limit prices**: Independent of AMM state, but may not reflect true market price.
- **AMM spot price at settlement time**: Most accurate, but can be manipulated by a preceding transaction in the same block.
- **Geometric mean**: More robust to outliers than arithmetic mean, but adds complexity.
- **TWAP**: Requires oracle data; adds complexity and dependency.

**Suggested resolution**: For the hackathon, use the AMM's current spot price (read from `pool.slot0()` at settlement time) as the settlement price for CoW matches. This is the simplest option and avoids the need for a custom pricing formula. The risk of manipulation is documented in `02-threat-model.md` but is acceptable for a prototype.

**Impact on build plan**: Phase 3 (matching logic). The price formula is encapsulated in the matching library.

---

## 6. Bond Denomination

**Question**: Should bonds be posted in native ETH, or in the pool's `currency0`/`currency1`?

**Current assumption**: Native ETH (sent as `msg.value`). [Assumption]

**Trade-offs**:
- **Native ETH**: Simple; universally available; no token approval needed. But: if the pool is a non-ETH pair (e.g., USDC/DAI), the bond is in a different currency than the swap, complicating accounting.
- **Pool currency**: Bonds are in the same currency as the swap, simplifying accounting. But: requires token approval before committing, which adds a transaction and complicates the UX.

**Suggested resolution**: Use native ETH for the hackathon. The bond is small and used only for incentive/anti-griefing purposes — it doesn't need to be in the same currency as the swap.

**Impact on build plan**: Phase 1 (commit/reveal/bond). The bond denomination affects the `commit()` function signature.

---

## 7. Reveal Window Sub-Period

**Question**: Should there be a dedicated reveal-only sub-window between the commit window closing and settlement becoming available?

**Current assumption**: No — reveal and settlement are both possible as soon as the commit window closes. [Assumption]

**Trade-offs**:
- **Dedicated reveal sub-window**: Gives users time to reveal before anyone can trigger settlement. Ensures maximum batch participation. But: adds delay and complexity.
- **No sub-window**: Simpler. But: a fast keeper could call `settleBatch()` immediately after the window closes, before most users have revealed. This would settle a nearly-empty batch (mostly bond forfeitures), which wastes the matching opportunity.

**Suggested resolution**: For the hackathon, add a simple delay: `settleBatch()` requires `block.number >= (windowId + 1) * N + REVEAL_GRACE_BLOCKS`, where `REVEAL_GRACE_BLOCKS` is a small constant (e.g., 10 blocks ≈ 20 seconds on Base). This gives users time to reveal without adding a separate phase.

**Impact on build plan**: Phase 4 (settlement integration). Adds one additional `require` check.

---

## 8. Multi-Token-Pair Support

**Question**: Should CommitSwap support commitments across multiple token pairs within the same window, or only a single pool?

**Current assumption**: Single pool. The hook is deployed on a specific pool, and all commitments are for that pool's token pair. [Assumption]

**Trade-offs**:
- **Single pool**: Simpler. All matching is within one pair. But: limits adoption to one pool per hook deployment.
- **Multi-pool**: More useful, but significantly more complex — matching must be done per-pair, and the `unlockCallback` must interact with multiple pools.

**Suggested resolution**: Single pool for the hackathon. This is sufficient for the proof-of-concept. Multi-pool support is a post-hackathon enhancement.

**Impact on build plan**: Architectural. Single-pool is assumed throughout the current design docs.

---

*Cross-references: see `01-architecture.md` for how these decisions affect the design, `04-build-plan.md` for build-phase impacts.*
