// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CommitRevealStore
/// @author CommitSwap — Phase 1 (Updated per Gap Resolution)
/// @notice Standalone commit / reveal / bond-escrow layer for the CommitSwap protocol.
///         This contract has NO dependency on Uniswap v4 — no PoolManager, no hooks, no
///         BaseHook inheritance. It is pool-agnostic and will be wired into the actual hook
///         in a later phase.
///
/// @dev Key design decisions (each references 06-open-questions.md / 00-thesis.md):
///
///   1. WINDOW_BLOCKS = configurable via constructor (default 25 for Base, ~50 seconds).
///      On Base (~2 s/block) this gives a reasonable commit window for users.
///      06-open-questions.md §2 discusses N = 50 for production; the constructor
///      parameter allows tuning per-deployment.
///
///   2. Bond denomination = native ETH, sent as msg.value.
///      06-open-questions.md §6 discusses ETH vs. pool-currency bonds. ETH is chosen
///      because it requires no token approval, simplifies commit() to a single payable
///      call, and the bond is only an anti-griefing deposit — not part of the swap itself.
///
///   3. Bond amount = fixed MIN_BOND (0.001 ether).
///      06-open-questions.md §1 discusses percentage-based vs. fixed. A fixed amount is
///      chosen because at commit time the plaintext swap size is unknown (it is hidden in
///      the hash), so a percentage cannot be enforced.
///
///   4. Commit cutoff = a commit is valid when the tx is mined in a block whose window
///      index matches the commitment's window. There is no "last-block freeze" —
///      06-open-questions.md §4 (last-committer timing) notes this as a known trade-off.
///      A commit is simply assigned to `block.number / WINDOW_BLOCKS`.
///
///   5. Reveal cutoff = the reveal must happen in the window IMMEDIATELY after the
///      commit window (i.e. window W+1). If the committer does not reveal by the end
///      of window W+1, the bond is forfeit. This is a judgment call: 01-architecture.md
///      says "reveal is possible once the window closes" but does not specify a hard
///      deadline. We impose one so that forfeiture is deterministic and does not require
///      an explicit `forfeitBond()` call — any commitment whose reveal window has passed
///      is automatically considered forfeited.
///
///   6. Hash preimage = keccak256(abi.encode(amount, minAmountOut, zeroForOne, poolId, salt, msg.sender)).
///      - Including msg.sender prevents front-running the reveal (02-threat-model.md §6).
///      - Including minAmountOut enables slippage protection on the AMM fallback leg.
///
///   7. Deployment Scope: One CommitRevealStore instance is deployed per pool. POOL_ID is
///      set at construction and enforced on every reveal — a commitment computed for one
///      deployment cannot be replayed against another.
///
///   8. Storage Persistence of Plaintext: Post-reveal, plaintext swap parameters (amount, minAmountOut,
///      zeroForOne) are stored directly inside `commitments[id]`. This allows Phase 3's `settleBatch()`
///      to assemble a window's revealed intents directly from contract storage without requiring the caller
///      to possess special off-chain knowledge, upholding the core thesis of permissionless settlement (00-thesis.md).
///
///   9. Multiple commits per address per window: ALLOWED. A user may have multiple
///      independent swap intents in the same window (e.g. buy ETH and sell DAI).
///      There is no reason to restrict this — each commitment is independently keyed
///      by a unique commitmentId (auto-incrementing counter).
///
///   10. withdrawForfeited() is a PLACEHOLDER keeper-payout mechanism for Phase 1 only.
///      Later phases will replace it with the real keeper-fee logic described in
///      01-architecture.md §"Keeper Fee Mechanics".
contract CommitRevealStore {
    // ──────────────────────────────────────────────────────────────────────
    // Constants & Immutables
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Number of blocks per commit window.
    /// @dev Configurable at deployment. See 06-open-questions.md §2.
    uint256 public immutable WINDOW_BLOCKS;

    /// @notice Minimum bond that must accompany a commit (native ETH).
    /// @dev Configurable at deployment. See 06-open-questions.md §1.
    uint256 public immutable MIN_BOND;

    /// @notice The Uniswap v4 pool identifier associated with this store instance.
    bytes32 public immutable POOL_ID;

    // ──────────────────────────────────────────────────────────────────────
    // Data structures
    // ──────────────────────────────────────────────────────────────────────

    /// @notice A single commitment record.
    struct Commitment {
        /// @notice The committer's address.
        address committer;
        /// @notice keccak256(abi.encode(amount, minAmountOut, zeroForOne, poolId, salt, committer)).
        bytes32 intentHash;
        /// @notice The window index at the time of commit (`block.number / WINDOW_BLOCKS`).
        uint256 windowIndex;
        /// @notice ETH bond amount escrowed with this commitment (0 after reveal or forfeiture).
        uint256 bondAmount;
        /// @notice Whether the commitment has been successfully revealed.
        bool revealed;
        /// @notice Plaintext swap amount offered (populated on reveal).
        uint256 amount;
        /// @notice Plaintext minimum output acceptable for slippage control (populated on reveal).
        uint256 minAmountOut;
        /// @notice Plaintext swap direction: true = token0 for token1, false = token1 for token0 (populated on reveal).
        bool zeroForOne;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Storage
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Auto-incrementing commitment ID counter.
    uint256 public nextCommitmentId;

    /// @notice commitmentId => Commitment.
    mapping(uint256 => Commitment) public commitments;

    /// @notice windowIndex => list of commitment IDs created in that window.
    mapping(uint256 => uint256[]) public windowCommitIds;

    /// @notice Running total of forfeited bond ETH that has not yet been withdrawn.
    /// @dev This is a Phase-1 placeholder. The real keeper-fee logic (01-architecture.md
    ///      §"Keeper Fee Mechanics") will replace this in a later phase.
    uint256 public forfeitedBonds;

    /// @notice Whether a window's batch has been settled (prevents double-settlement).
    /// @dev Added in anticipation of Phase 4's settleBatch(). Once settleBatch() settles a
    ///      window, this flag is set to true, preventing replay.
    mapping(uint256 => bool) public windowSettled;

    // ──────────────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Emitted when a new commitment is created.
    event Committed(
        uint256 indexed commitmentId,
        address indexed committer,
        bytes32 intentHash,
        uint256 windowIndex,
        uint256 bondAmount
    );

    /// @notice Emitted when a commitment is successfully revealed.
    event Revealed(uint256 indexed commitmentId, uint256 amount, uint256 minAmountOut, bool zeroForOne);

    /// @notice Emitted when forfeited bonds are swept.
    event ForfeitedBondsWithdrawn(address indexed recipient, uint256 amount);

    /// @notice Emitted when a specific commitment's bond is marked as forfeited.
    event BondForfeited(uint256 indexed commitmentId, uint256 bondAmount);

    // ──────────────────────────────────────────────────────────────────────
    // Errors
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Bond sent is below MIN_BOND.
    error InsufficientBond();

    /// @notice The reveal's poolId does not match this contract's deployed POOL_ID.
    error WrongPool();

    /// @notice The intent hash does not match the stored commitment.
    error HashMismatch();

    /// @notice The commitment has already been revealed.
    error AlreadyRevealed();

    /// @notice The commitment does not exist (invalid commitmentId).
    error CommitmentNotFound();

    /// @notice Only the original committer may reveal.
    error NotCommitter();

    /// @notice The reveal window for this commitment has not opened yet
    ///         (commit and reveal are in the same window).
    error RevealWindowNotOpen();

    /// @notice The reveal window for this commitment has already closed
    ///         (current window > commitWindow + 1).
    error RevealWindowClosed();

    /// @notice No forfeited bonds available to withdraw.
    error NoForfeitedBonds();

    /// @notice ETH transfer failed.
    error TransferFailed();

    /// @notice The commitment's bond has already been forfeited.
    error AlreadyForfeited();

    /// @notice The commitment was revealed, so it cannot be forfeited.
    error CommitmentRevealed();

    /// @notice The forfeiture window has not arrived yet.
    error ForfeitureNotReady();

    // ──────────────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────────────

    /// @param _poolId       The Uniswap v4 PoolId associated with this deployment.
    /// @param _windowBlocks Number of blocks per commit window (e.g. 25 for ~50s on Base).
    /// @param _minBond      Minimum bond in native ETH (e.g. 0.001 ether).
    constructor(bytes32 _poolId, uint256 _windowBlocks, uint256 _minBond) {
        require(_windowBlocks > 0, "WINDOW_BLOCKS must be > 0");
        require(_minBond > 0, "MIN_BOND must be > 0");
        POOL_ID = _poolId;
        WINDOW_BLOCKS = _windowBlocks;
        MIN_BOND = _minBond;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Core functions
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Commit a hashed swap intent, escrowing a bond in native ETH.
    /// @dev The commitment is assigned to the current window (`block.number / WINDOW_BLOCKS`).
    ///      There is no "last-block" cutoff within a window — any block in the window is
    ///      valid for committing. This is a judgment call; see contract-level docs above.
    ///
    /// @param intentHash  keccak256(abi.encode(amount, minAmountOut, zeroForOne, poolId, salt, msg.sender)).
    ///                    The exact preimage format is pinned here because Phase 2+ will
    ///                    depend on it.
    /// @return commitmentId  The unique ID for this commitment.
    function commit(bytes32 intentHash) external payable returns (uint256 commitmentId) {
        if (msg.value < MIN_BOND) revert InsufficientBond();

        uint256 windowIndex = currentWindowIndex();

        commitmentId = nextCommitmentId++;

        commitments[commitmentId] = Commitment({
            committer: msg.sender,
            intentHash: intentHash,
            windowIndex: windowIndex,
            bondAmount: msg.value,
            revealed: false,
            amount: 0,
            minAmountOut: 0,
            zeroForOne: false
        });

        windowCommitIds[windowIndex].push(commitmentId);

        emit Committed(commitmentId, msg.sender, intentHash, windowIndex, msg.value);
    }

    /// @notice Reveal a previously committed swap intent.
    /// @dev Verifies the hash preimage, checks timing constraints, marks the commitment
    ///      as revealed, persists plaintext parameters, zeros bondAmount, and returns the bond to committer.
    ///
    ///      *** PHASE 1 BOND BEHAVIOR (C1 from 07-review.md) ***
    ///      Currently, the bond is returned immediately on reveal. This means in the happy path
    ///      (all users reveal), the keeper fee pool is empty and `settleBatch()` has no economic
    ///      incentive. Phase 4/6 will change this: bonds will be held until `settleBatch()` settles
    ///      the window, and the keeper will take a small cut (e.g., 5-10%) from ALL bonds (revealed
    ///      or not), returning the remainder to committers. This guarantees keeper payment regardless
    ///      of reveal rate or match rate.
    ///
    ///      Timing rules:
    ///        - The reveal window OPENS when the commit window closes:
    ///            currentWindowIndex() > commitment.windowIndex
    ///        - The reveal window CLOSES at the end of the next window:
    ///            currentWindowIndex() > commitment.windowIndex + 1
    ///        - So the valid reveal window is: currentWindowIndex() == commitment.windowIndex + 1
    ///          (i.e. the window immediately following the commit window).
    ///
    /// @param commitmentId  The ID returned by commit().
    /// @param amount        The swap amount (plaintext).
    /// @param minAmountOut  The minimum acceptable output amount for slippage control (plaintext).
    /// @param zeroForOne    The swap direction (plaintext).
    /// @param poolId        The Uniswap v4 pool identifier (bytes32, plaintext).
    /// @param salt          The random salt used when computing the hash.
    function reveal(
        uint256 commitmentId,
        uint256 amount,
        uint256 minAmountOut,
        bool zeroForOne,
        bytes32 poolId,
        bytes32 salt
    ) external {
        Commitment storage c = commitments[commitmentId];

        // --- Existence check ---
        if (c.committer == address(0)) revert CommitmentNotFound();

        // --- Authorization ---
        if (msg.sender != c.committer) revert NotCommitter();

        // --- Double-reveal guard ---
        if (c.revealed) revert AlreadyRevealed();

        // --- Timing: reveal window must be open ---
        uint256 currentWindow = currentWindowIndex();
        if (currentWindow <= c.windowIndex) revert RevealWindowNotOpen();
        if (currentWindow > c.windowIndex + 1) revert RevealWindowClosed();

        // --- Pool identity enforcement ---
        if (poolId != POOL_ID) revert WrongPool();

        // --- Hash verification ---
        // Preimage: abi.encode(amount, minAmountOut, zeroForOne, poolId, salt, committer).
        // Including the committer in the hash prevents third-party front-running of reveals
        // (see 02-threat-model.md §6).
        bytes32 computedHash = keccak256(abi.encode(amount, minAmountOut, zeroForOne, poolId, salt, c.committer));
        if (computedHash != c.intentHash) revert HashMismatch();

        // --- Effects & Plaintext Persistence ---
        c.revealed = true;
        c.amount = amount;
        c.minAmountOut = minAmountOut;
        c.zeroForOne = zeroForOne;

        emit Revealed(commitmentId, amount, minAmountOut, zeroForOne);
    }

    /// @notice Mark an unrevealed commitment as forfeited and add its bond to the
    ///         claimable forfeited-bonds pool.
    /// @dev Anyone can call this for any commitment whose reveal window has passed
    ///      without a reveal. This is explicit (not automatic) so that gas is paid
    ///      by the caller, not silently during settlement.
    ///
    ///      A commitment is forfeit-eligible when:
    ///        currentWindowIndex() > commitment.windowIndex + 1
    ///        AND commitment.revealed == false
    ///
    /// @param commitmentId  The commitment to forfeit.
    function forfeitBond(uint256 commitmentId) external {
        Commitment storage c = commitments[commitmentId];

        if (c.committer == address(0)) revert CommitmentNotFound();
        if (c.revealed) revert CommitmentRevealed();

        uint256 currentWindow = currentWindowIndex();
        // The reveal window is windowIndex + 1. Forfeiture is possible once we are
        // past that window (i.e. currentWindow > windowIndex + 1).
        if (currentWindow <= c.windowIndex + 1) revert ForfeitureNotReady();

        // We mark forfeiture by zeroing bondAmount and adding to the pool.
        // A second call with bondAmount == 0 would add 0 — harmless but we revert
        // explicitly for clarity.
        uint256 bond = c.bondAmount;
        if (bond == 0) revert AlreadyForfeited();

        c.bondAmount = 0;
        forfeitedBonds += bond;

        emit BondForfeited(commitmentId, bond);
    }

    /// @notice Sweep all forfeited bonds to the caller.
    /// @dev PLACEHOLDER for Phase 1 only. Later phases will replace this with the real
    ///      keeper-fee logic described in 01-architecture.md §"Keeper Fee Mechanics",
    ///      which distributes forfeited bonds to the settleBatch() caller as part of
    ///      the keeper incentive.
    function withdrawForfeited() external {
        uint256 amount = forfeitedBonds;
        if (amount == 0) revert NoForfeitedBonds();

        forfeitedBonds = 0;

        emit ForfeitedBondsWithdrawn(msg.sender, amount);

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ──────────────────────────────────────────────────────────────────────
    // View helpers
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Returns the current window index based on `block.number`.
    /// @dev windowIndex = block.number / WINDOW_BLOCKS.
    function currentWindowIndex() public view returns (uint256) {
        return block.number / WINDOW_BLOCKS;
    }

    /// @notice Returns all commitment IDs for a given window.
    function getWindowCommitIds(uint256 windowIndex) external view returns (uint256[] memory) {
        return windowCommitIds[windowIndex];
    }

    /// @notice Returns the full Commitment struct for a given ID.
    /// @dev The auto-generated getter from `public` mapping returns a tuple; this
    ///      helper returns the struct for easier off-chain consumption.
    function getCommitment(uint256 commitmentId) external view returns (Commitment memory) {
        return commitments[commitmentId];
    }

    /// @notice Computes the intent hash for a given set of parameters.
    /// @dev Provided as a convenience so that off-chain callers can compute the hash
    ///      in exactly the same way the contract does, avoiding preimage-format mismatches.
    /// @param amount       The swap amount.
    /// @param minAmountOut The minimum output amount for slippage control.
    /// @param zeroForOne   The swap direction.
    /// @param poolId       The Uniswap v4 pool identifier (bytes32).
    /// @param salt         A random salt.
    /// @param committer    The address that will call commit().
    /// @return The keccak256 hash.
    function computeIntentHash(
        uint256 amount,
        uint256 minAmountOut,
        bool zeroForOne,
        bytes32 poolId,
        bytes32 salt,
        address committer
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(amount, minAmountOut, zeroForOne, poolId, salt, committer));
    }
}
