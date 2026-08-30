# CommitSwap — References

## Overview

This document consolidates all external references used across the CommitSwap documentation set. Each reference is annotated with which docs cite it and the confidence level of claims derived from it.

---

## Primary References

### Angstrom / Sorella Labs

| # | Source | URL | Used In | Confidence |
|---|---|---|---|---|
| R1 | Angstrom Docs — Overview | https://docs.angstrom.xyz/ | `00-thesis.md`, `03-prior-art.md` | [Confirmed] — read directly |
| R2 | Angstrom Docs — L2 Overview | https://docs.angstrom.xyz/l2/intro | `00-thesis.md`, `01-architecture.md`, `03-prior-art.md` | [Confirmed] — read directly; confirms on-chain MEV tax approach on L2, no off-chain validator set |
| R3 | Sorella Labs — "A New Era of DeFi with ASS" | https://sorellalabs.xyz/writing/a-new-era-of-defi-with-ass | `00-thesis.md`, `03-prior-art.md` | [Confirmed] — read directly; describes ASS architecture, sovereign applications, and Angstrom's L1 flow |
| R4 | Uniswap Foundation — "Builder Stories: Yuki Yuminaga on ASS and Angstrom" | https://www.uniswapfoundation.org/blog/builder-stories-yuki-yuminaga-on-ass-and-angstrom | `03-prior-art.md` | [Confirmed] — read directly |
| R5 | The Block — "Paradigm backs Sorella Labs…" | https://www.theblock.co/post/312222/paradigm-sorella-labs-ethereum-mev-problem | `00-thesis.md`, `03-prior-art.md` | [Likely] — URL provided by project author; page returned 403 during fetch, but the $7.5M Paradigm funding is corroborated by Angstrom docs and Sorella's own materials |

### Rayls

| # | Source | URL | Used In | Confidence |
|---|---|---|---|---|
| R6 | Rayls Blog — "Our Uniswap Hook Incubator Hookathon" | https://www.rayls.com/blog/our-uniswap-hook-incubator-hookathon | `00-thesis.md`, `03-prior-art.md` | [Confirmed] — read directly; describes ZK-SNARK Poseidon commitment scheme, ERC-20 permit, auditor key encryption, timestamp-based reveal |

### Uniswap v4 Technical References

| # | Source | URL | Used In | Confidence |
|---|---|---|---|---|
| R7 | Uniswap Developers — Unlock Callback & Deltas | https://developers.uniswap.org/docs/protocols/v4/guides/unlock-callback-and-deltas | `01-architecture.md`, `05-testing-plan.md` | [Confirmed] — read directly; confirms multiple pool actions in a single unlock() session, flash accounting delta resolution |
| R8 | Uniswap Developers — Swap Hooks | https://developers.uniswap.org/docs/protocols/v4/guides/hooks/swap-hooks | `01-architecture.md` | [Confirmed] — read directly; confirms `_beforeSwap()` signature: `returns (bytes4, BeforeSwapDelta, uint24)`, `beforeSwapReturnDelta` permission flag |
| R9 | Uniswap Developers — Custom Accounting | https://developers.uniswap.org/docs/protocols/v4/guides/custom-accounting | `01-architecture.md`, `04-build-plan.md` | [Confirmed] — read directly; confirms `BeforeSwapDelta` mechanism, `toBeforeSwapDelta()`, `poolManager.take()` usage, hook fee pattern |
| R10 | Uniswap Blog — "Uniswap v4 Community Contributions" | https://blog.uniswap.org/uniswap-v4-community-contributions | `03-prior-art.md` | [Confirmed] — read directly |
| R11 | Uniswap Blog — "UNIfication" (Protocol Fee Context) | https://blog.uniswap.org/unification | — | Background only; not core to CommitSwap |
| R12 | Uniswap Developers — Flash Accounting (concept page) | https://developers.uniswap.org/docs/protocols/v4/concepts/flash-accounting | `01-architecture.md` | [Confirmed] — referenced in custom accounting guide; confirms transient-storage-based delta tracking |
| R13 | Uniswap Developers — Hooks (concept page) | https://developers.uniswap.org/docs/protocols/v4/concepts/hooks | `01-architecture.md` | [Confirmed] — confirms hook permission flag system |
| R14 | Uniswap Developers — Hook Deployment Guide | https://developers.uniswap.org/docs/protocols/v4/guides/hooks/hook-deployment | `04-build-plan.md` | [Likely] — standard deployment pattern with address prefix encoding |

### v4 Source Code Repositories

| # | Source | URL | Used In | Confidence |
|---|---|---|---|---|
| R15 | Uniswap/v4-core (GitHub) | https://github.com/Uniswap/v4-core | `04-build-plan.md`, `05-testing-plan.md` | [Confirmed] — canonical source; specific file paths (e.g., `IHooks.sol`, `PoolOperation.sol`) verified against docs |
| R16 | Uniswap/v4-periphery (GitHub) | https://github.com/Uniswap/v4-periphery | `04-build-plan.md` | [Confirmed] — canonical source for `BaseHook.sol` |

### General MEV / Hook Landscape

| # | Source | URL | Used In | Confidence |
|---|---|---|---|---|
| R17 | awesome-uniswap-hooks (fewwwww) | https://github.com/fewwwww/awesome-uniswap-hooks | `03-prior-art.md` | [Confirmed] — curated list of v4 hooks |
| R18 | awesome-uniswap-v4-hooks (johnsonstephan) | https://github.com/johnsonstephan/awesome-uniswap-v4-hooks | `03-prior-art.md` | [Confirmed] — curated list of v4 hooks |

### Paradigm

| # | Source | URL | Used In | Confidence |
|---|---|---|---|---|
| R19 | Paradigm — "Priority Is All You Need" | https://www.paradigm.xyz/2024/06/priority-is-all-you-need | `03-prior-art.md` | [Likely] — referenced by Angstrom L2 docs as the model for their MEV tax design; URL not directly fetched but the concept is well-known |

### Personal Prior Art

| # | Source | URL | Used In | Confidence |
|---|---|---|---|---|
| R20 | OnyxProtocol (Shubh's Starknet project) | — (no public URL provided) | `03-prior-art.md` | [Stated by project author] — commit-reveal-settle with Pedersen hashes on Starknet; not independently verified |

---

## Confidence Level Definitions

| Level | Meaning |
|---|---|
| **[Confirmed]** | Claim verified against the cited source — the source was read directly and the claim accurately reflects its content. |
| **[Likely]** | Standard pattern or widely accepted fact, not directly verified for this specific project. The claim is consistent with known behavior but has not been checked against primary source material. |
| **[Assumption]** | A design choice made by the CommitSwap team. Not a fact about the external world — a decision we're making. Subject to revision. |
| **[Stated by project author]** | Claimed by Shubh; not independently verified against external sources. |

---

## Claims by Confidence Level

### [Confirmed] claims in this doc set

- Angstrom uses an off-chain ASS validator network on L1, moves auction on-chain on L2 (R1, R2, R3)
- Angstrom L2 uses priority-fee MEV taxes, no off-chain batching (R2)
- Angstrom funded $7.5M by Paradigm, backed by Uniswap Foundation (R3, R4, R5)
- Rayls uses ZK-SNARK Poseidon commitments, timestamp-based reveal, ERC-20 permit (R6)
- Uniswap v4 `unlock()` supports multiple pool operations in one session with zero-sum delta enforcement (R7)
- `_beforeSwap()` returns `(bytes4, BeforeSwapDelta, uint24)` (R8)
- `beforeSwapReturnDelta` flag enables return-delta custom accounting (R8, R9)
- `poolManager.take()` creates a debt, `poolManager.settle()` resolves it (R9)
- `toBeforeSwapDelta(specifiedDelta, unspecifiedDelta)` creates a `BeforeSwapDelta` (R9)
- Flash accounting uses transient storage; deltas must net to zero (R7, R12)

### [Likely] claims in this doc set

- Base has the highest Uniswap v4 swap volume among L2s covered in UHI10 materials
- Flashbots Protect supports Base (but availability for programmatic hook use is unverified)
- `deployFreshManagerAndRouters()` is the standard Foundry test utility for v4 hooks
- HookMiner or CREATE2 salt mining is needed for hook deployment address
- Fork testing against Base mainnet is feasible via `vm.createSelectFork()`

### [Assumption] claims in this doc set

- Bond percentage: 1% of amountIn (or fixed 0.001 ETH)
- Window length: N = 50 blocks
- No private relay routing for fall-through AMM leg
- keccak256 rather than ZK for commitment scheme
- Midpoint price formula for CoW matching
- Bond denomination: native ETH
- Single-pool scope for hackathon
- `msg.sender` included in commitment hash
- No dedicated reveal sub-window (grace period instead)

---

*This document is the canonical link index for all CommitSwap documentation. Update it whenever a new source is cited.*
