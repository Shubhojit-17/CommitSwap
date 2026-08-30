# CommitSwap — Prior Art

## Overview

CommitSwap does not exist in a vacuum. This document catalogs the closest prior art, explains what each project does, and sharpens CommitSwap's differentiation. The goal is to preempt "hasn't this been built already?" questions with honest, sourced answers.

---

## 1. Angstrom (Sorella Labs)

**What it is**: A Uniswap v4 hook that internalizes MEV through application-level sequencing. Built by Sorella Labs, backed by the Uniswap Foundation, with a $7.5M raise from Paradigm. [Confirmed — The Block]

**How it works**:

- **On L1 (Ethereum mainnet)**: Angstrom runs an off-chain validator network (an "App-Specific Sequencer" or ASS, staked through EigenLayer) that executes two auctions per block: (1) an ordering/arbitrage auction where CEX-DEX arbitrageurs bid for the right to be the first swap, with proceeds going to LPs; and (2) a uniform-clearing-price batch auction for user swaps, making sandwiching structurally impossible. The bundle is sent to Ethereum builders for inclusion at any position in the block (order-agnostic). [Confirmed — Angstrom docs, Sorella blog post on ASS]
- **On L2 (Base, Unichain)**: Angstrom runs entirely on-chain inside a v4 hook. It uses MEV taxes based on priority fees — the hook reads each swap's `tx.gasprice - block.basefee`, computes a deterministic tax, and redistributes it to LPs. No off-chain batching or validator set. Follows the "priority is all you need" model from Paradigm. [Confirmed — docs.angstrom.xyz/l2/intro]

**Key quote from their docs**: "Ethereum Mainnet (L1): Running the auction on-chain would be prohibitively expensive and faces builder censorship risks, so Angstrom uses an off-chain validator network." And: "Ethereum Layer-2 (L2): On sequencer-led L2s with guaranteed priority ordering and cheaper gas, we move the auction on-chain." [Confirmed — docs.angstrom.xyz]

**What CommitSwap does differently**:
- Angstrom L2 relies on the L2 sequencer's priority ordering guarantee to enforce MEV taxes. CommitSwap does not assume priority ordering — it hides intent via commit-reveal, removing the need for ordering-based protection entirely.
- Angstrom L2 does not batch user swaps on L2 (each swap goes through the hook individually with a tax). CommitSwap explicitly batches revealed intents and performs CoW matching before any AMM interaction.
- Angstrom is a production system with years of development. CommitSwap is a hackathon prototype exploring whether commit-reveal + CoW matching can achieve a similar result with simpler infrastructure.

**Source links**:
- https://docs.angstrom.xyz/
- https://docs.angstrom.xyz/l2/intro
- https://sorellalabs.xyz/writing/a-new-era-of-defi-with-ass
- https://www.uniswapfoundation.org/blog/builder-stories-yuki-yuminaga-on-ass-and-angstrom
- https://www.theblock.co/post/312222/paradigm-sorella-labs-ethereum-mev-problem

---

## 2. Rayls "Private Swaps" (Compliance & Privacy Hook)

**What it is**: A Uniswap v4 hook built during a previous Uniswap Hook Incubator Hookathon by Rayls (formerly focused on institutional DeFi). It implements commit-reveal trading with ZK-SNARK Poseidon-hash commitments. [Confirmed — Rayls blog post]

**How it works**:
1. User defines swap parameters (amount, tokenIn, tokenOut, execution timestamp) and signs an ERC-20 permit.
2. Rayls Middleware generates a ZK-SNARK proof of knowledge of these parameters, producing a Poseidon hash. Optionally, parameters are encrypted with an auditor's public key for compliance.
3. A commitment (Poseidon hash + optional ciphertext + permit) is stored on-chain via `storeCommitment()`.
4. When the execution timestamp arrives, the middleware calls `executeCommitment()` with the ZK proof. The hook verifies the proof, confirms the commitment, checks the permit, and executes the swap through `PoolManager`.
5. An optional auditor can decrypt the ciphertext at any time for compliance oversight.

**What CommitSwap does differently**:
- **No ZK**: CommitSwap uses a simple keccak256 hash rather than ZK-SNARK Poseidon hashes. This is a deliberate trade-off: ZK is more privacy-preserving (the prover never reveals plaintext on-chain) but adds circuit complexity, proof generation cost, and verifier gas cost. For a hackathon scope, keccak256 commit-reveal is sufficient. [Assumption]
- **Batching + CoW matching**: Rayls executes each commitment individually when its timestamp arrives. CommitSwap accumulates commitments over a window and batch-matches them, enabling Coincidence-of-Wants matching that avoids AMM interaction entirely for matched pairs.
- **Economic incentives**: Rayls has no bond or keeper mechanism documented. CommitSwap uses bonds to prevent griefing and keeper fees to make settlement permissionless.
- **No compliance layer**: CommitSwap does not include auditor-key encryption or suitability verification — it's out of scope for the MEV-protection use case.

**Source link**:
- https://www.rayls.com/blog/our-uniswap-hook-incubator-hookathon

---

## 3. OnyxProtocol (Personal Prior Art)

**What it is**: Shubh's own prior project, implementing a commit-reveal-settle pattern using Pedersen hashes on Starknet. [Stated by project author — not independently verified]

**Relevance**: Demonstrates that Shubh has shipped this pattern before in a different execution environment. The Starknet implementation used Pedersen commitments (which are algebraically structured, enabling certain ZK-friendly operations), whereas CommitSwap uses keccak256 on an EVM L2.

**What CommitSwap does differently**:
- EVM-native (Solidity on Base) rather than Cairo on Starknet.
- Integrated with Uniswap v4's hook system and flash accounting, rather than a standalone DEX.
- Adds CoW matching and keeper incentives on top of the base commit-reveal pattern.

---

## 4. CoW Protocol (CoW Swap)

**What it is**: An intent-based DEX protocol that uses off-chain "solvers" to find Coincidence-of-Wants matches and optimal execution paths for user swap intents. Users sign intent messages (not transactions); solvers compete to provide the best execution. [Confirmed — well-known protocol]

**How it works**:
1. Users sign EIP-712 typed intent messages specifying their swap parameters.
2. Solvers collect these intents, attempt CoW matching, and fill any residual via on-chain liquidity (Uniswap, etc.).
3. The winning solver submits a settlement transaction on-chain.

**What CommitSwap does differently**:
- **No off-chain solvers**: CommitSwap's matching logic runs on-chain inside the hook. CoW Protocol relies on a competitive off-chain solver market, which is more capital-efficient but introduces trust/liveness dependencies on solvers.
- **Integrated with Uniswap v4**: CommitSwap is a v4 hook, meaning it can use the pool's own liquidity for the AMM fallback directly via return-delta, rather than routing through external DEXes.
- **Commit-reveal**: CoW Protocol intents are plaintext (visible to solvers). CommitSwap hides intent until the reveal phase.

---

## 5. General v4 MEV-Hook Landscape

Several other Uniswap v4 hooks address MEV in various ways. For context:

| Hook | Approach | Differentiation from CommitSwap |
|---|---|---|
| **Detox Hook** | Reroutes swaps through private channels / MEV-aware routing | Does not batch or hide intent; relies on routing infrastructure |
| **SSR (Sequencer-Specific Routing)** | Uses sequencer ordering guarantees for MEV protection | Relies on sequencer behavior; CommitSwap is sequencer-agnostic |
| **MEV Auction Hook** | Auctions off MEV rights to the highest bidder, redistributing to LPs | Auction-based (similar to Angstrom); CommitSwap uses commit-reveal |
| **PureFi** | Compliance-focused hook (KYC/AML checks) | Different problem domain (compliance, not MEV) |

**Source links**:
- https://github.com/fewwwww/awesome-uniswap-hooks
- https://github.com/johnsonstephan/awesome-uniswap-v4-hooks

---

## Summary Table

| Project | Commit-Reveal | CoW Matching | On-Chain | No Off-Chain Infra | Bond/Incentive | Status |
|---|---|---|---|---|---|---|
| **CommitSwap** | ✓ (keccak256) | ✓ (midpoint price) | ✓ (L2) | ✓ | ✓ | Hackathon prototype |
| **Angstrom L1** | ✗ | ✓ (uniform clearing) | ✗ (off-chain ASS) | ✗ | EigenLayer stake | Production |
| **Angstrom L2** | ✗ | ✗ (no batching) | ✓ | ✓ | MEV tax | Production |
| **Rayls** | ✓ (ZK Poseidon) | ✗ | ✓ | Middleware | Permit-based | Hookathon |
| **OnyxProtocol** | ✓ (Pedersen) | ✗ | ✓ (Starknet) | ✓ | — | Prior project |
| **CoW Protocol** | ✗ | ✓ | ✗ (off-chain solvers) | ✗ | — | Production |

---

*Cross-references: see `00-thesis.md` for positioning, `01-architecture.md` for how CommitSwap works, `references.md` for all source links.*
