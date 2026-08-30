# CommitSwap — Thesis

## Problem Statement

When a user submits a swap on any public blockchain, the transaction's calldata — amount, direction, token pair, and slippage tolerance — is visible in the mempool before execution. This transparency is structurally exploitable: a sandwich bot can observe the pending swap, front-run it to move the price, let the victim's swap execute at the worse price, and back-run to pocket the difference. The user receives fewer tokens than they should; the bot captures the surplus. This is not an edge case — it is the dominant source of MEV on Ethereum and its L2s. [Confirmed — well-documented across Flashbots Protect data, MEV Explore, and academic literature]

The fundamental issue is that **swap intent is revealed before execution**. Any mitigation that preserves plaintext swap parameters in the mempool is, at best, a partial fix.

## Thesis

> Angstrom proves batch-auction MEV protection works, but requires an off-chain validator network staked through EigenLayer to be economical on L1. On L2s with cheap gas, Angstrom's own documentation confirms they move the MEV auction fully on-chain (via priority-fee-based MEV taxes, no off-chain sequencer). CommitSwap asks a different question: **on a cheap L2, can a commit → reveal → batch-settle lifecycle — where swap intent is cryptographically hidden until a window closes — live fully on-chain with no off-chain sequencer, no priority-ordering assumption, and no trusted keeper set?** Permissionless by construction, not by staking incentive.

Key distinction: Angstrom L2 relies on the L2 sequencer's priority ordering to enforce MEV taxes (the "priority is all you need" model from Paradigm). [Confirmed — Angstrom L2 docs explicitly state this] CommitSwap does not assume priority ordering — it hides intent entirely via commit-reveal, then settles a batch after the window closes. This is a fundamentally different trust model. [Assumption — this is our design choice]

## Elevator Pitch

CommitSwap is a Uniswap v4 hook that makes sandwich attacks structurally impossible by hiding swap intent behind a commit-reveal scheme. Users post a hashed commitment with a small bond; after a fixed block window, they reveal their plaintext parameters. A permissionless `settleBatch()` function — callable by anyone, incentivized by a keeper fee funded from forfeited bonds — matches opposing intents at the midpoint price (Coincidence-of-Wants) and routes unmatched residuals through the underlying AMM via return-delta. The entire lifecycle is on-chain on an L2. No off-chain sequencer. No validator network. No trust assumptions beyond the EVM.

## Differentiation

### vs. Angstrom (Sorella Labs)

Angstrom is the closest and most important prior art. It is backed by the Uniswap Foundation and funded by a $7.5M round from Paradigm. [Confirmed — The Block reporting]

| Dimension | Angstrom L1 | Angstrom L2 | CommitSwap |
|---|---|---|---|
| MEV protection mechanism | Off-chain batch auction via ASS validator network | On-chain MEV tax via priority fee | On-chain commit-reveal + CoW batch matching |
| Off-chain dependency | Yes — EigenLayer-staked validator set | No — relies on L2 sequencer priority ordering | No — relies only on EVM execution |
| Sandwich protection | Uniform clearing price makes sandwiching structurally impossible | MEV tax makes sandwiching unprofitable (but not impossible) | Intent hidden until reveal; matched intents never touch the AMM |
| Trust model | Cryptoeconomic (staking/slashing) | Sequencer priority ordering guarantee | None beyond EVM — permissionless by construction |
| Maturity | Production (deployed on Ethereum mainnet) | Production (deployed on Base, Unichain) | Hackathon prototype |

**The load-bearing fact**: Angstrom's own documentation states that on L1, running the auction on-chain "would be prohibitively expensive" — hence the off-chain validator network. On L2s, they move the auction on-chain. [Confirmed — docs.angstrom.xyz] CommitSwap takes the "fully on-chain on L2" premise but uses a different mechanism (commit-reveal + CoW matching) rather than priority-fee-based MEV taxes.

**Honest caveat**: CommitSwap's fall-through-to-AMM leg for unmatched residuals is itself a normal on-chain swap and inherits ordinary MEV exposure unless routed through a private relay. See `02-threat-model.md` for the full analysis.

### vs. Rayls "Private Swaps"

Rayls built a commit-reveal hook for Uniswap v4 using ZK-SNARK Poseidon-hash commitments, revealed at a predefined execution timestamp, with ERC-20 permit for token access and optional auditor-key encryption for compliance. [Confirmed — Rayls blog post]

| Dimension | Rayls | CommitSwap |
|---|---|---|
| Commitment scheme | ZK-SNARK Poseidon hash | Simple keccak256 (no ZK) |
| Reveal trigger | Predefined timestamp | Block window (deterministic: `block.number / N`) |
| Batch matching | None — each commitment executes individually | CoW matching at midpoint price across the batch |
| Bond/incentive | None documented | Bond on commit; keeper fee for batch settlement |
| MEV on execution | Middleware executes privately (trusted) | Fall-through leg exposed; mitigation via private relay TBD |
| Compliance | Auditor key encryption | Not in scope |

CommitSwap differs from Rayls primarily in that it **batches and matches** revealed intents rather than executing them individually, and uses a simpler commitment scheme (no ZK overhead) with an economic disincentive layer (bonds + keeper fees). The ZK approach is more privacy-preserving but adds circuit complexity and gas cost that may not be justified for a hackathon prototype. [Assumption — we are choosing simplicity over ZK for the hackathon scope]

---

*Cross-references: see `01-architecture.md` for the full lifecycle, `02-threat-model.md` for attack vectors, `03-prior-art.md` for detailed comparisons.*
