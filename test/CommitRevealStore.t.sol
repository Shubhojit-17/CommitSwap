// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CommitRevealStore} from "../src/CommitRevealStore.sol";

/// @title CommitRevealStore Unit & Fuzz Tests
/// @notice Follows the course testing pattern: read the contract top to bottom, write a
///         unit test for every conditional branch, then add fuzz tests on top.
contract CommitRevealStoreTest is Test {
    // ──────────────────────────────────────────────────────────────────────
    // Setup
    // ──────────────────────────────────────────────────────────────────────

    CommitRevealStore store;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");

    /// @dev A dummy v4 poolId used in tests (bytes32, Option A).
    bytes32 constant POOL_ID = bytes32(uint256(0xBEEF));

    /// @dev Default salt for testing.
    bytes32 constant SALT = keccak256("test-salt");

    /// @dev Default minAmountOut for testing.
    uint256 constant DEFAULT_MIN_OUT = 0.9 ether;

    /// @dev Convenience: the minimum bond the contract requires.
    uint256 minBond;

    function setUp() public {
        store = new CommitRevealStore(POOL_ID, 5, 0.001 ether);
        minBond = store.MIN_BOND();

        // Fund test accounts generously.
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(keeper, 100 ether);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────────────

    /// @dev Helper: compute the intent hash off-chain the same way the contract does.
    function _computeHash(
        uint256 amount,
        uint256 minAmountOut,
        bool zeroForOne,
        bytes32 poolId,
        bytes32 salt,
        address committer
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(amount, minAmountOut, zeroForOne, poolId, salt, committer));
    }

    /// @dev Helper: commit as `who` with default parameters, return the commitmentId.
    function _commitAsUser(address who, uint256 amount, uint256 minAmountOut, bool zeroForOne, bytes32 salt)
        internal
        returns (uint256 commitmentId, bytes32 intentHash)
    {
        intentHash = _computeHash(amount, minAmountOut, zeroForOne, POOL_ID, salt, who);
        vm.prank(who);
        commitmentId = store.commit{value: minBond}(intentHash);
    }

    /// @dev Helper: advance the block number to a specific block.
    function _advanceToBlock(uint256 targetBlock) internal {
        vm.roll(targetBlock);
    }

    /// @dev Helper: get the first block of a given window.
    function _windowStart(uint256 windowIndex) internal pure returns (uint256) {
        return windowIndex * 5; // WINDOW_BLOCKS = 5
    }

    // ══════════════════════════════════════════════════════════════════════
    //                       UNIT TESTS — COMMIT
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Happy path: commit succeeds, stores correct state.
    function test_commit_storesCorrectly() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;
        bytes32 intentHash = _computeHash(amount, minOut, zeroForOne, POOL_ID, SALT, alice);

        // Commit in window 0 (blocks 0-4).
        _advanceToBlock(2);

        vm.prank(alice);
        uint256 id = store.commit{value: minBond}(intentHash);

        assertEq(id, 0, "first commitment ID should be 0");

        CommitRevealStore.Commitment memory c = store.getCommitment(id);
        assertEq(c.committer, alice, "committer mismatch");
        assertEq(c.intentHash, intentHash, "intentHash mismatch");
        assertEq(c.windowIndex, 0, "windowIndex mismatch");
        assertEq(c.bondAmount, minBond, "bondAmount mismatch");
        assertEq(c.revealed, false, "revealed should be false");
        assertEq(c.amount, 0, "amount unrevealed should be 0");
        assertEq(c.minAmountOut, 0, "minAmountOut unrevealed should be 0");
        assertEq(c.zeroForOne, false, "zeroForOne unrevealed should be false");

        // Contract should hold the bond.
        assertEq(address(store).balance, minBond, "contract balance mismatch");
    }

    /// @notice Commit auto-increments commitment IDs.
    function test_commit_autoIncrementsId() public {
        bytes32 hash1 = _computeHash(1 ether, DEFAULT_MIN_OUT, true, POOL_ID, SALT, alice);
        bytes32 hash2 = _computeHash(2 ether, DEFAULT_MIN_OUT, false, POOL_ID, SALT, alice);

        vm.startPrank(alice);
        uint256 id1 = store.commit{value: minBond}(hash1);
        uint256 id2 = store.commit{value: minBond}(hash2);
        vm.stopPrank();

        assertEq(id1, 0);
        assertEq(id2, 1);
        assertEq(store.nextCommitmentId(), 2);
    }

    /// @notice Commit emits the Committed event with correct parameters.
    function test_commit_emitsEvent() public {
        bytes32 intentHash = _computeHash(1 ether, DEFAULT_MIN_OUT, true, POOL_ID, SALT, alice);

        _advanceToBlock(3);

        vm.expectEmit(true, true, false, true);
        emit CommitRevealStore.Committed(0, alice, intentHash, 0, minBond);

        vm.prank(alice);
        store.commit{value: minBond}(intentHash);
    }

    /// @notice Commit with excess bond succeeds — the full msg.value is stored.
    function test_commit_excessBond() public {
        bytes32 intentHash = _computeHash(1 ether, DEFAULT_MIN_OUT, true, POOL_ID, SALT, alice);
        uint256 bigBond = 1 ether;

        vm.prank(alice);
        uint256 id = store.commit{value: bigBond}(intentHash);

        CommitRevealStore.Commitment memory c = store.getCommitment(id);
        assertEq(c.bondAmount, bigBond, "should store full msg.value");
    }

    /// @notice Revert: commit with insufficient bond.
    function test_commit_revert_insufficientBond() public {
        bytes32 intentHash = _computeHash(1 ether, DEFAULT_MIN_OUT, true, POOL_ID, SALT, alice);

        vm.prank(alice);
        vm.expectRevert(CommitRevealStore.InsufficientBond.selector);
        store.commit{value: minBond - 1}(intentHash);
    }

    /// @notice Multiple commits per address per window: ALLOWED by design.
    function test_commit_multiplePerAddressPerWindow() public {
        bytes32 hash1 = _computeHash(1 ether, DEFAULT_MIN_OUT, true, POOL_ID, keccak256("s1"), alice);
        bytes32 hash2 = _computeHash(2 ether, DEFAULT_MIN_OUT, false, POOL_ID, keccak256("s2"), alice);

        vm.startPrank(alice);
        uint256 id1 = store.commit{value: minBond}(hash1);
        uint256 id2 = store.commit{value: minBond}(hash2);
        vm.stopPrank();

        // Both should succeed with distinct IDs.
        assertTrue(id1 != id2);

        // Both should be in the same window's commit list.
        uint256[] memory ids = store.getWindowCommitIds(0);
        assertEq(ids.length, 2);
        assertEq(ids[0], id1);
        assertEq(ids[1], id2);
    }

    /// @notice Commit assigns the correct windowIndex across window boundaries.
    function test_commit_windowIndexAssignment() public {
        // Window 0: blocks 0-4
        _advanceToBlock(4);
        bytes32 h0 = _computeHash(1 ether, DEFAULT_MIN_OUT, true, POOL_ID, SALT, alice);
        vm.prank(alice);
        uint256 id0 = store.commit{value: minBond}(h0);

        // Window 1: blocks 5-9
        _advanceToBlock(5);
        bytes32 h1 = _computeHash(2 ether, DEFAULT_MIN_OUT, false, POOL_ID, SALT, alice);
        vm.prank(alice);
        uint256 id1 = store.commit{value: minBond}(h1);

        assertEq(store.getCommitment(id0).windowIndex, 0);
        assertEq(store.getCommitment(id1).windowIndex, 1);
    }

    // ══════════════════════════════════════════════════════════════════════
    //                       UNIT TESTS — REVEAL
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Happy path: reveal succeeds with correct preimage; bond returned; revealed flag set; bondAmount zeroed; plaintext fields persisted.
    function test_reveal_happyPath() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        // Commit in window 0.
        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        uint256 aliceBalBefore = alice.balance;

        // Advance to window 1 (reveal window).
        _advanceToBlock(_windowStart(1));

        vm.prank(alice);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, SALT);

        // Commitment should be marked revealed, bondAmount retained, and plaintext fields persisted.
        CommitRevealStore.Commitment memory c = store.getCommitment(id);
        assertTrue(c.revealed, "should be revealed");
        assertEq(c.bondAmount, minBond, "bondAmount should be retained on reveal");
        assertEq(c.amount, amount, "amount mismatch");
        assertEq(c.minAmountOut, minOut, "minAmountOut mismatch");
        assertEq(c.zeroForOne, zeroForOne, "zeroForOne mismatch");

        // Bond is retained in store until settleBatch
        assertEq(alice.balance, aliceBalBefore, "bond should remain in store until settlement");
        assertEq(address(store).balance, minBond, "contract should retain bond");
    }

    /// @notice Explicit test for Phase 6 bond retention: bondAmount is retained immediately after reveal.
    function test_reveal_retainsBondAmount() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        _advanceToBlock(_windowStart(1));

        vm.prank(alice);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, SALT);

        assertEq(store.getCommitment(id).bondAmount, minBond, "bondAmount must be retained after reveal");
    }

    /// @notice Reveal emits the Revealed event with plaintext parameters.
    function test_reveal_emitsEvent() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        _advanceToBlock(_windowStart(1));

        vm.expectEmit(true, false, false, true);
        emit CommitRevealStore.Revealed(id, amount, minOut, zeroForOne);

        vm.prank(alice);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, SALT);
    }

    /// @notice Revert: reveal with wrong amount (hash mismatch case 1).
    function test_reveal_revert_wrongAmount() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        _advanceToBlock(_windowStart(1));

        vm.prank(alice);
        vm.expectRevert(CommitRevealStore.HashMismatch.selector);
        store.reveal(id, amount + 1, minOut, zeroForOne, POOL_ID, SALT); // wrong amount
    }

    /// @notice Revert: reveal with wrong minAmountOut (hash mismatch case 2).
    function test_reveal_revert_wrongMinAmountOut() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        _advanceToBlock(_windowStart(1));

        vm.prank(alice);
        vm.expectRevert(CommitRevealStore.HashMismatch.selector);
        store.reveal(id, amount, minOut - 1, zeroForOne, POOL_ID, SALT); // wrong minAmountOut
    }

    /// @notice Revert: reveal with wrong salt (hash mismatch case 3).
    function test_reveal_revert_wrongSalt() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        _advanceToBlock(_windowStart(1));

        vm.prank(alice);
        vm.expectRevert(CommitRevealStore.HashMismatch.selector);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, keccak256("wrong-salt")); // wrong salt
    }

    /// @notice Revert: reveal with wrong zeroForOne (hash mismatch case 4).
    function test_reveal_revert_wrongDirection() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        _advanceToBlock(_windowStart(1));

        vm.prank(alice);
        vm.expectRevert(CommitRevealStore.HashMismatch.selector);
        store.reveal(id, amount, minOut, !zeroForOne, POOL_ID, SALT); // wrong direction
    }

    /// @notice Revert: reveal passing a poolId that differs from contract POOL_ID (Change 1).
    function test_reveal_revert_wrongPoolId() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        _advanceToBlock(_windowStart(1));

        vm.prank(alice);
        vm.expectRevert(CommitRevealStore.WrongPool.selector);
        store.reveal(id, amount, minOut, zeroForOne, bytes32(uint256(0xDEAD)), SALT); // wrong poolId
    }

    /// @notice Revert: valid preimage matching a different POOL_ID fails constructor-level check (Change 1).
    function test_reveal_revert_wrongPoolId_immutable() public {
        bytes32 otherPoolId = bytes32(uint256(0x9999));
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        // Hash computed specifically with otherPoolId
        bytes32 intentHash = _computeHash(amount, minOut, zeroForOne, otherPoolId, SALT, alice);

        _advanceToBlock(0);
        vm.prank(alice);
        uint256 id = store.commit{value: minBond}(intentHash);

        _advanceToBlock(_windowStart(1));

        // Revealing with otherPoolId matches preimage, but fails POOL_ID immutable check first
        vm.prank(alice);
        vm.expectRevert(CommitRevealStore.WrongPool.selector);
        store.reveal(id, amount, minOut, zeroForOne, otherPoolId, SALT);
    }

    /// @notice Revert: double-reveal of the same commitment.
    function test_reveal_revert_doubleReveal() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        _advanceToBlock(_windowStart(1));

        vm.prank(alice);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, SALT);

        // Second reveal should revert.
        vm.prank(alice);
        vm.expectRevert(CommitRevealStore.AlreadyRevealed.selector);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, SALT);
    }

    /// @notice Revert: reveal before the commit window closes (same window).
    function test_reveal_revert_sameWindow() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        // Still in window 0 — reveal should fail.
        _advanceToBlock(4); // last block of window 0

        vm.prank(alice);
        vm.expectRevert(CommitRevealStore.RevealWindowNotOpen.selector);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, SALT);
    }

    /// @notice Revert: reveal after the reveal window has closed (too late).
    function test_reveal_revert_tooLate() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        // Advance past window 1 to window 2 (reveal window is W+1 = window 1 only).
        _advanceToBlock(_windowStart(2));

        vm.prank(alice);
        vm.expectRevert(CommitRevealStore.RevealWindowClosed.selector);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, SALT);
    }

    /// @notice Revert: reveal by someone other than the committer.
    function test_reveal_revert_wrongSender() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        _advanceToBlock(_windowStart(1));

        vm.prank(bob);
        vm.expectRevert(CommitRevealStore.NotCommitter.selector);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, SALT);
    }

    /// @notice Revert: reveal for a non-existent commitment.
    function test_reveal_revert_nonexistent() public {
        _advanceToBlock(_windowStart(1));

        vm.prank(alice);
        vm.expectRevert(CommitRevealStore.CommitmentNotFound.selector);
        store.reveal(999, 1 ether, DEFAULT_MIN_OUT, true, POOL_ID, SALT);
    }

    /// @notice Reveal at the exact first block of the reveal window succeeds.
    function test_reveal_exactFirstBlockOfRevealWindow() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        // Reveal at exactly the first block of window 1.
        _advanceToBlock(5); // block 5 = first block of window 1

        vm.prank(alice);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, SALT);

        assertTrue(store.getCommitment(id).revealed);
    }

    /// @notice Reveal at the exact last block of the reveal window succeeds.
    function test_reveal_exactLastBlockOfRevealWindow() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        // Reveal at exactly the last block of window 1.
        _advanceToBlock(9); // block 9 = last block of window 1

        vm.prank(alice);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, SALT);

        assertTrue(store.getCommitment(id).revealed);
    }

    // ══════════════════════════════════════════════════════════════════════
    //                    UNIT TESTS — FORFEITURE
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Happy path: unrevealed commitment past its reveal window can be forfeited.
    function test_forfeitBond_happyPath() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        // Advance past the reveal window (window 2+).
        _advanceToBlock(_windowStart(2));

        uint256 contractBalBefore = address(store).balance;
        store.forfeitBond(id);

        // Bond should be added to forfeitedBonds.
        assertEq(store.forfeitedBonds(), minBond, "forfeited bonds mismatch");

        // Bond amount in commitment should be zeroed.
        assertEq(store.getCommitment(id).bondAmount, 0, "bond should be zeroed");

        // Contract balance should not change (bond stays in contract, just re-categorized).
        assertEq(address(store).balance, contractBalBefore, "contract balance should not change");
    }

    /// @notice Forfeiture boundary test: forfeiture attempt at exact last block of reveal window fails (Change 3).
    function test_forfeitBond_revert_exactLastBlockOfRevealWindow() public {
        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, 1 ether, DEFAULT_MIN_OUT, true, SALT);

        // Block 9 = exact last block of reveal window (window 1)
        _advanceToBlock(9);

        vm.expectRevert(CommitRevealStore.ForfeitureNotReady.selector);
        store.forfeitBond(id);
    }

    /// @notice Forfeiture boundary test: forfeiture attempt at exact first block after reveal window succeeds (Change 3).
    function test_forfeitBond_exactFirstBlockAfterRevealWindow() public {
        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, 1 ether, DEFAULT_MIN_OUT, true, SALT);

        // Block 10 = exact first block of window 2 (after reveal window closes)
        _advanceToBlock(10);

        store.forfeitBond(id);
        assertEq(store.forfeitedBonds(), minBond);
        assertEq(store.getCommitment(id).bondAmount, 0);
    }

    /// @notice Forfeiture emits BondForfeited event.
    function test_forfeitBond_emitsEvent() public {
        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, 1 ether, DEFAULT_MIN_OUT, true, SALT);

        _advanceToBlock(_windowStart(2));

        vm.expectEmit(true, false, false, true);
        emit CommitRevealStore.BondForfeited(id, minBond);
        store.forfeitBond(id);
    }

    /// @notice Revert: cannot forfeit a revealed commitment.
    function test_forfeitBond_revert_alreadyRevealed() public {
        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;

        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, amount, minOut, zeroForOne, SALT);

        _advanceToBlock(_windowStart(1));
        vm.prank(alice);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, SALT);

        _advanceToBlock(_windowStart(2));

        vm.expectRevert(CommitRevealStore.CommitmentRevealed.selector);
        store.forfeitBond(id);
    }

    /// @notice Revert: cannot forfeit before the reveal window closes.
    function test_forfeitBond_revert_tooEarly() public {
        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, 1 ether, DEFAULT_MIN_OUT, true, SALT);

        // Still in the reveal window (window 1).
        _advanceToBlock(_windowStart(1) + 2);

        vm.expectRevert(CommitRevealStore.ForfeitureNotReady.selector);
        store.forfeitBond(id);
    }

    /// @notice Revert: cannot forfeit same commitment twice.
    function test_forfeitBond_revert_doubleForfeit() public {
        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, 1 ether, DEFAULT_MIN_OUT, true, SALT);

        _advanceToBlock(_windowStart(2));
        store.forfeitBond(id);

        vm.expectRevert(CommitRevealStore.AlreadyForfeited.selector);
        store.forfeitBond(id);
    }

    /// @notice Revert: cannot forfeit nonexistent commitment.
    function test_forfeitBond_revert_nonexistent() public {
        _advanceToBlock(_windowStart(2));
        vm.expectRevert(CommitRevealStore.CommitmentNotFound.selector);
        store.forfeitBond(999);
    }

    // ══════════════════════════════════════════════════════════════════════
    //                  UNIT TESTS — withdrawForfeited
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Happy path: withdrawForfeited sweeps all forfeited bonds to the caller.
    function test_withdrawForfeited_happyPath() public {
        // Create two commitments, both unrevealed, and forfeit both.
        _advanceToBlock(0);
        (uint256 id1,) = _commitAsUser(alice, 1 ether, DEFAULT_MIN_OUT, true, keccak256("s1"));
        (uint256 id2,) = _commitAsUser(bob, 2 ether, 1.8 ether, false, keccak256("s2"));

        _advanceToBlock(_windowStart(2));
        store.forfeitBond(id1);
        store.forfeitBond(id2);

        uint256 totalForfeited = store.forfeitedBonds();
        assertEq(totalForfeited, 2 * minBond);

        uint256 keeperBalBefore = keeper.balance;

        vm.prank(keeper);
        store.withdrawForfeited();

        assertEq(keeper.balance, keeperBalBefore + totalForfeited, "keeper did not receive bonds");
        assertEq(store.forfeitedBonds(), 0, "forfeited bonds should be zeroed");
        assertEq(address(store).balance, 0, "contract should have 0 balance");
    }

    /// @notice withdrawForfeited emits event.
    function test_withdrawForfeited_emitsEvent() public {
        _advanceToBlock(0);
        (uint256 id,) = _commitAsUser(alice, 1 ether, DEFAULT_MIN_OUT, true, SALT);

        _advanceToBlock(_windowStart(2));
        store.forfeitBond(id);

        vm.expectEmit(true, false, false, true);
        emit CommitRevealStore.ForfeitedBondsWithdrawn(keeper, minBond);

        vm.prank(keeper);
        store.withdrawForfeited();
    }

    /// @notice Revert: withdrawForfeited when nothing is forfeited.
    function test_withdrawForfeited_revert_nothingToWithdraw() public {
        vm.prank(keeper);
        vm.expectRevert(CommitRevealStore.NoForfeitedBonds.selector);
        store.withdrawForfeited();
    }

    // ══════════════════════════════════════════════════════════════════════
    //                   UNIT TESTS — VIEW HELPERS
    // ══════════════════════════════════════════════════════════════════════

    /// @notice computeIntentHash matches internal computation.
    function test_computeIntentHash() public view {
        uint256 amount = 5 ether;
        uint256 minOut = 4.5 ether;
        bool zeroForOne = false;
        bytes32 salt = keccak256("my-salt");

        bytes32 expected = keccak256(abi.encode(amount, minOut, zeroForOne, POOL_ID, salt, alice));
        bytes32 result = store.computeIntentHash(amount, minOut, zeroForOne, POOL_ID, salt, alice);

        assertEq(result, expected);
    }

    /// @notice getWindowCommitIds returns the correct list.
    function test_getWindowCommitIds() public {
        _advanceToBlock(0);

        vm.startPrank(alice);
        bytes32 h1 = _computeHash(1 ether, DEFAULT_MIN_OUT, true, POOL_ID, keccak256("s1"), alice);
        bytes32 h2 = _computeHash(2 ether, DEFAULT_MIN_OUT, true, POOL_ID, keccak256("s2"), alice);
        store.commit{value: minBond}(h1);
        store.commit{value: minBond}(h2);
        vm.stopPrank();

        uint256[] memory ids = store.getWindowCommitIds(0);
        assertEq(ids.length, 2);
        assertEq(ids[0], 0);
        assertEq(ids[1], 1);

        // Window 1 should be empty.
        uint256[] memory idsW1 = store.getWindowCommitIds(1);
        assertEq(idsW1.length, 0);
    }

    // ══════════════════════════════════════════════════════════════════════
    //               FULL LIFECYCLE — COMMIT + REVEAL + FORFEIT
    // ══════════════════════════════════════════════════════════════════════

    /// @notice End-to-end: two users commit; one reveals (bond returned); one does not
    ///         (bond forfeited); keeper sweeps.
    function test_fullLifecycle_revealAndForfeit() public {
        uint256 amountA = 1 ether;
        uint256 minOutA = 0.9 ether;
        uint256 amountB = 2 ether;
        uint256 minOutB = 1.8 ether;

        // Window 0: both commit.
        _advanceToBlock(0);
        (uint256 idA,) = _commitAsUser(alice, amountA, minOutA, true, keccak256("saltA"));
        (uint256 idB,) = _commitAsUser(bob, amountB, minOutB, false, keccak256("saltB"));

        // Window 1: Alice reveals.
        _advanceToBlock(_windowStart(1));
        uint256 aliceBalBefore = alice.balance;
        vm.prank(alice);
        store.reveal(idA, amountA, minOutA, true, POOL_ID, keccak256("saltA"));
        // Bond is retained in store until settlement
        assertEq(alice.balance, aliceBalBefore, "Alice bond retained in store");

        // Window 2+: Bob's commitment is forfeit-eligible.
        _advanceToBlock(_windowStart(2));
        store.forfeitBond(idB);

        // Keeper sweeps Bob's forfeited bond.
        uint256 keeperBalBefore = keeper.balance;
        vm.prank(keeper);
        store.withdrawForfeited();
        assertEq(keeper.balance, keeperBalBefore + minBond, "Keeper did not receive forfeit");

        // Final state checks.
        assertTrue(store.getCommitment(idA).revealed, "Alice should be revealed");
        assertEq(store.getCommitment(idA).bondAmount, minBond, "Alice bond should remain in store");
        assertEq(store.getCommitment(idA).amount, amountA, "Alice amount persisted");
        assertEq(store.getCommitment(idA).minAmountOut, minOutA, "Alice minAmountOut persisted");
        assertEq(store.getCommitment(idA).zeroForOne, true, "Alice zeroForOne persisted");

        assertFalse(store.getCommitment(idB).revealed, "Bob should NOT be revealed");
        assertEq(store.getCommitment(idB).bondAmount, 0, "Bob bond should be zeroed");
        // Alice's retained bond remains in store
        assertEq(address(store).balance, minBond, "contract should hold Alice's retained bond");
    }

    // ══════════════════════════════════════════════════════════════════════
    //                       FUZZ TESTS
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Fuzz: window-boundary blocks. Commit at various points in a window,
    ///         reveal at various points in the next window — verifying that the cutoffs
    ///         are exactly right. This catches off-by-one errors.
    function testFuzz_windowBoundary_commitAndReveal(
        uint8 commitOffsetInWindow, // offset within the commit window
        uint8 revealOffsetInWindow // offset within the reveal window
    )
        public
    {
        // Bound to valid offsets within a 5-block window (0..4).
        uint256 commitOffset = bound(commitOffsetInWindow, 0, 4);
        uint256 revealOffset = bound(revealOffsetInWindow, 0, 4);

        // Use window 2 to avoid edge cases at block 0.
        uint256 commitWindow = 2;
        uint256 commitBlock = _windowStart(commitWindow) + commitOffset;
        uint256 revealBlock = _windowStart(commitWindow + 1) + revealOffset;

        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;
        bytes32 salt = keccak256(abi.encodePacked(commitOffset, revealOffset));

        bytes32 intentHash = _computeHash(amount, minOut, zeroForOne, POOL_ID, salt, alice);

        // Commit.
        _advanceToBlock(commitBlock);
        vm.prank(alice);
        uint256 id = store.commit{value: minBond}(intentHash);

        // Verify window assignment.
        assertEq(store.getCommitment(id).windowIndex, commitWindow, "wrong window");

        // Reveal in the next window — should always succeed.
        _advanceToBlock(revealBlock);
        vm.prank(alice);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, salt);

        assertTrue(store.getCommitment(id).revealed);
    }

    /// @notice Fuzz: attempting reveal one block BEFORE the reveal window should revert.
    function testFuzz_revealBeforeWindow_reverts(uint8 commitOffsetRaw) public {
        uint256 commitOffset = bound(commitOffsetRaw, 0, 4);

        uint256 commitWindow = 2;
        uint256 commitBlock = _windowStart(commitWindow) + commitOffset;
        // One block before the reveal window opens = last block of the commit window.
        uint256 revealBlock = _windowStart(commitWindow + 1) - 1;

        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;
        bytes32 salt = keccak256(abi.encodePacked("fuzz-before", commitOffset));
        bytes32 intentHash = _computeHash(amount, minOut, zeroForOne, POOL_ID, salt, alice);

        _advanceToBlock(commitBlock);
        vm.prank(alice);
        uint256 id = store.commit{value: minBond}(intentHash);

        _advanceToBlock(revealBlock);

        vm.prank(alice);
        vm.expectRevert(CommitRevealStore.RevealWindowNotOpen.selector);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, salt);
    }

    /// @notice Fuzz: attempting reveal one block AFTER the reveal window should revert.
    function testFuzz_revealAfterWindow_reverts(uint8 commitOffsetRaw) public {
        uint256 commitOffset = bound(commitOffsetRaw, 0, 4);

        uint256 commitWindow = 2;
        uint256 commitBlock = _windowStart(commitWindow) + commitOffset;
        // First block after the reveal window closes.
        uint256 revealBlock = _windowStart(commitWindow + 2);

        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;
        bytes32 salt = keccak256(abi.encodePacked("fuzz-after", commitOffset));
        bytes32 intentHash = _computeHash(amount, minOut, zeroForOne, POOL_ID, salt, alice);

        _advanceToBlock(commitBlock);
        vm.prank(alice);
        uint256 id = store.commit{value: minBond}(intentHash);

        _advanceToBlock(revealBlock);

        vm.prank(alice);
        vm.expectRevert(CommitRevealStore.RevealWindowClosed.selector);
        store.reveal(id, amount, minOut, zeroForOne, POOL_ID, salt);
    }

    /// @notice Fuzz: bond amounts across a reasonable range. Commit with various bond
    ///         amounts, leave some unrevealed, forfeit them, and verify that the
    ///         forfeited-bonds accounting always sums correctly.
    function testFuzz_bondAccounting(uint8 numCommitsRaw, uint8 revealBitmapRaw) public {
        // Bound: 1..8 commitments.
        uint256 numCommits = bound(numCommitsRaw, 1, 8);
        // The reveal bitmap: bit i == 1 means commitment i will be revealed.
        uint256 revealBitmap = uint256(revealBitmapRaw) % (1 << numCommits);

        uint256 totalBonded;
        uint256 totalRetained;
        uint256 totalForfeited;

        uint256[] memory ids = new uint256[](numCommits);

        // Commit all in window 0.
        _advanceToBlock(0);
        for (uint256 i = 0; i < numCommits; i++) {
            uint256 amount = (i + 1) * 1 ether;
            uint256 minOut = amount * 9 / 10;
            bool zeroForOne = (i % 2 == 0);
            bytes32 salt = keccak256(abi.encodePacked("fuzz-bond", i));
            bytes32 intentHash = _computeHash(amount, minOut, zeroForOne, POOL_ID, salt, alice);

            vm.prank(alice);
            ids[i] = store.commit{value: minBond}(intentHash);
            totalBonded += minBond;
        }

        // Reveal window (window 1).
        _advanceToBlock(_windowStart(1));
        for (uint256 i = 0; i < numCommits; i++) {
            if ((revealBitmap >> i) & 1 == 1) {
                uint256 amount = (i + 1) * 1 ether;
                uint256 minOut = amount * 9 / 10;
                bool zeroForOne = (i % 2 == 0);
                bytes32 salt = keccak256(abi.encodePacked("fuzz-bond", i));

                vm.prank(alice);
                store.reveal(ids[i], amount, minOut, zeroForOne, POOL_ID, salt);
                totalRetained += minBond;
            }
        }

        // Forfeiture window (window 2+).
        _advanceToBlock(_windowStart(2));
        for (uint256 i = 0; i < numCommits; i++) {
            if ((revealBitmap >> i) & 1 == 0) {
                // Not revealed — should be forfeit-eligible.
                store.forfeitBond(ids[i]);
                totalForfeited += minBond;
            }
        }

        // Invariant: totalBonded == totalRetained + totalForfeited.
        assertEq(totalBonded, totalRetained + totalForfeited, "bond accounting mismatch");

        // Invariant: forfeitedBonds storage == totalForfeited.
        assertEq(store.forfeitedBonds(), totalForfeited, "forfeited storage mismatch");

        // Invariant: contract balance == totalRetained + totalForfeited (revealed bonds retained,
        // forfeited bonds awaiting sweep).
        assertEq(address(store).balance, totalRetained + totalForfeited, "contract balance mismatch");
    }

    /// @notice Fuzz: bond amounts with variable-size bonds (not just MIN_BOND).
    function testFuzz_variableBondAmounts(uint96 bondAmountRaw) public {
        // Bound to at least MIN_BOND, at most 10 ETH.
        uint256 bondAmount = bound(bondAmountRaw, store.MIN_BOND(), 10 ether);

        uint256 amount = 1 ether;
        uint256 minOut = DEFAULT_MIN_OUT;
        bool zeroForOne = true;
        bytes32 salt = keccak256("variable-bond");
        bytes32 intentHash = _computeHash(amount, minOut, zeroForOne, POOL_ID, salt, alice);

        // Commit with the fuzzed bond amount.
        _advanceToBlock(0);
        vm.prank(alice);
        uint256 id = store.commit{value: bondAmount}(intentHash);

        assertEq(store.getCommitment(id).bondAmount, bondAmount);

        // Do NOT reveal — let it forfeit.
        _advanceToBlock(_windowStart(2));
        store.forfeitBond(id);

        assertEq(store.forfeitedBonds(), bondAmount, "forfeited should equal bond");
        assertEq(address(store).balance, bondAmount, "contract should hold bond");

        // Withdraw.
        uint256 keeperBal = keeper.balance;
        vm.prank(keeper);
        store.withdrawForfeited();
        assertEq(keeper.balance, keeperBal + bondAmount, "keeper should receive full bond");
    }

    /// @notice Fuzz: commit at arbitrary block numbers, verify window assignment is correct.
    function testFuzz_windowAssignment(uint64 blockNumber) public {
        // Avoid block 0 edge weirdness with max.
        uint256 bn = uint256(blockNumber);

        _advanceToBlock(bn);

        bytes32 intentHash = keccak256("fuzz-window-assign");

        vm.prank(alice);
        uint256 id = store.commit{value: minBond}(intentHash);

        uint256 expectedWindow = bn / store.WINDOW_BLOCKS();
        assertEq(store.getCommitment(id).windowIndex, expectedWindow);
    }

    /// @notice Fuzz: the computeIntentHash helper must match manual keccak256 for any inputs.
    function testFuzz_computeIntentHash(
        uint256 amount,
        uint256 minAmountOut,
        bool zeroForOne,
        bytes32 poolId,
        bytes32 salt,
        address committer
    ) public view {
        bytes32 expected = keccak256(abi.encode(amount, minAmountOut, zeroForOne, poolId, salt, committer));
        bytes32 result = store.computeIntentHash(amount, minAmountOut, zeroForOne, poolId, salt, committer);
        assertEq(result, expected);
    }

    // ══════════════════════════════════════════════════════════════════════
    //                 GAS SCALING MEASUREMENT
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Measures per-commit gas when committing N times into the same window.
    function test_gasScaling_commitsInSameWindow() public {
        vm.deal(alice, 1000 ether);

        uint256[3] memory sampleSizes = [uint256(10), uint256(100), uint256(500)];
        bytes32 dummyHash = keccak256("gas-scaling-test");

        _advanceToBlock(0);

        for (uint256 s = 0; s < sampleSizes.length; s++) {
            uint256 targetN = sampleSizes[s];
            uint256 currentCount = store.getWindowCommitIds(0).length;

            // Commit up to targetN
            for (uint256 i = currentCount; i < targetN; i++) {
                uint256 gasBefore = gasleft();
                vm.prank(alice);
                store.commit{value: minBond}(dummyHash);
                uint256 gasUsed = gasBefore - gasleft();

                if (i + 1 == 1 || i + 1 == 10 || i + 1 == 100 || i + 1 == 500) {
                    console.log("Commit #", i + 1, "gas used:", gasUsed);
                }
            }
        }

        assertEq(store.getWindowCommitIds(0).length, 500);
    }

    // ══════════════════════════════════════════════════════════════════════
    //                 EDGE CASE: receive() not defined
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Ensure the contract cannot receive plain ETH transfers (no receive/fallback).
    function test_cannotReceivePlainEth() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(store).call{value: 1 ether}("");
        assertFalse(ok, "should not accept plain ETH");
    }
}
