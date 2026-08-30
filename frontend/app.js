/**
 * CommitSwap — Interactive Web3 Application & CoW Matching Simulator
 * Core JavaScript Engine
 */

// Application State
const STATE = {
  isSimulationMode: true,
  currentBlock: 1024,
  windowBlocks: 5,
  minBondEth: "0.001",
  walletAddress: "0x328809Bc894f92807417D2dAD6b7C998c1aFdac6", // Default simulated Alice
  poolId: "0x285297f9769b37afc4b76e9eed91605e5ea366378ecf77cdd8d1ab3b19b0c9dd",
  currentSalt: null,
  currentHash: null,
  orders: [
    // Pre-seeded demo orders to provide an immediate interactive experience
    {
      id: 0,
      committer: "0x328809Bc894f92807417D2dAD6b7C998c1aFdac6", // Alice
      windowIndex: 202,
      amount: "10.0",
      minAmountOut: "9.0",
      zeroForOne: true,
      salt: "0x128bbf1141f36cbdbf161673b717f06698367eb3a42cef013e50f03f3ca6cf0f",
      bondAmount: "0.001",
      revealed: true,
      settled: false
    },
    {
      id: 1,
      committer: "0x1D96F2f6BeF1202E4Ce1Ff6Dad0c2CB002861d3e", // Bob
      windowIndex: 202,
      amount: "10.0",
      minAmountOut: "9.0",
      zeroForOne: false,
      salt: "0x92f77647d6c695789afad09e435ccac302549e5cb49d89fc74f00ce924992fbb",
      bondAmount: "0.001",
      revealed: true,
      settled: false
    },
    {
      id: 2,
      committer: "0xC3f2c61C4836Afeb9Ae601c91F6FE661df3D634E", // Charlie
      windowIndex: 203,
      amount: "5.0",
      minAmountOut: "4.8",
      zeroForOne: true,
      salt: "0xab57218491d90c91823901bca981290310293810293810293810293810293810",
      bondAmount: "0.001",
      revealed: false,
      settled: false
    }
  ]
};

// Compute current window index
function getWindowIndex(blockNumber) {
  return Math.floor(blockNumber / STATE.windowBlocks);
}

// Generate secure 32-byte cryptographic salt
function generateSalt() {
  const array = new Uint8Array(32);
  window.crypto.getRandomValues(array);
  return "0x" + Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Compute Keccak256 Intent Hash: keccak256(abi.encode(amount, minAmountOut, zeroForOne, poolId, salt, committer))
function computeIntentHash(amountStr, minAmountOutStr, zeroForOne, poolId, salt, committer) {
  try {
    const amountWei = ethers.parseEther(amountStr || "0");
    const minOutWei = ethers.parseEther(minAmountOutStr || "0");
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
      ["uint256", "uint256", "bool", "bytes32", "bytes32", "address"],
      [amountWei, minOutWei, zeroForOne, poolId, salt, committer]
    );
    return ethers.keccak256(encoded);
  } catch (err) {
    console.error("Hash calculation error:", err);
    return "0x0000000000000000000000000000000000000000000000000000000000000000";
  }
}

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
  initSalt();
  setupEventListeners();
  updateUI();
  showToast("CommitSwap initialized in Interactive Simulator mode.", "info");
});

function initSalt() {
  STATE.currentSalt = generateSalt();
  updateIntentHashPreview();
}

function updateIntentHashPreview() {
  const amountIn = document.getElementById("inputAmountIn").value || "0";
  const minAmountOut = document.getElementById("inputMinAmountOut").value || "0";
  const zeroForOne = document.getElementById("selectTokenIn").value === "token0";

  STATE.currentHash = computeIntentHash(
    amountIn,
    minAmountOut,
    zeroForOne,
    STATE.poolId,
    STATE.currentSalt,
    STATE.walletAddress
  );

  document.getElementById("displaySalt").textContent =
    STATE.currentSalt.slice(0, 8) + "..." + STATE.currentSalt.slice(-6);
  document.getElementById("displayIntentHash").textContent =
    STATE.currentHash.slice(0, 10) + "..." + STATE.currentHash.slice(-6);
}

// UI State Updater
function updateUI() {
  const currentWindow = getWindowIndex(STATE.currentBlock);
  const blockInWindow = STATE.currentBlock % STATE.windowBlocks;
  const blocksRemaining = STATE.windowBlocks - blockInWindow;

  // Header Displays
  document.getElementById("currentBlockDisplay").textContent = STATE.currentBlock.toLocaleString();
  document.getElementById("currentWindowDisplay").textContent = `W${currentWindow}`;

  // Window Pipeline Progress
  document.getElementById("windowProgressText").textContent = `${blocksRemaining} block${blocksRemaining === 1 ? '' : 's'} left in Window`;
  const progressPercent = ((blockInWindow + 1) / STATE.windowBlocks) * 100;
  document.getElementById("windowProgressBar").style.width = `${progressPercent}%`;

  // Pipeline Stage Tags
  document.getElementById("activeCommitWindowTag").textContent = `Window ${currentWindow}`;
  document.getElementById("activeRevealWindowTag").textContent = `Window ${currentWindow - 1}`;
  document.getElementById("activeSettleWindowTag").textContent = `Window ${currentWindow - 2}`;

  // Pipeline Stats
  const activeCommits = STATE.orders.filter(o => o.windowIndex === currentWindow).length;
  document.getElementById("commitCountDisplay").textContent = `${activeCommits} Order${activeCommits === 1 ? '' : 's'}`;

  const revealWindowOrders = STATE.orders.filter(o => o.windowIndex === currentWindow - 1);
  const revealedOrders = revealWindowOrders.filter(o => o.revealed).length;
  document.getElementById("revealCountDisplay").textContent =
    `${revealedOrders} / ${revealWindowOrders.length} Revealed`;

  document.getElementById("revealWindowIndexRef").textContent = `W${currentWindow - 1}`;
  document.getElementById("settleWindowRef").textContent = `${currentWindow - 2}`;

  // Update Pending Reveal Badge
  const myPendingReveals = STATE.orders.filter(
    o => o.committer.toLowerCase() === STATE.walletAddress.toLowerCase() &&
         o.windowIndex === currentWindow - 1 &&
         !o.revealed
  );
  document.getElementById("pendingRevealBadge").textContent = myPendingReveals.length;

  renderRevealOrdersList();
  renderOrderHistory();
  renderKeeperMatchingPreview(currentWindow - 2);
}

// Render Orders Available to Reveal
function renderRevealOrdersList() {
  const container = document.getElementById("savedOrdersList");
  const currentWindow = getWindowIndex(STATE.currentBlock);
  const eligibleOrders = STATE.orders.filter(o => o.windowIndex === currentWindow - 1);

  if (eligibleOrders.length === 0) {
    container.innerHTML = `
      <div class="empty-orders-state">
        <span class="empty-icon">📭</span>
        <p>No orders in reveal window (Window ${currentWindow - 1}).</p>
      </div>`;
    return;
  }

  container.innerHTML = eligibleOrders.map(order => `
    <div class="order-item-card">
      <div class="order-item-meta">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="order-badge">#${order.id}</span>
          <span class="bold">${order.amount} ${order.zeroForOne ? 'Token0 → Token1' : 'Token1 → Token0'}</span>
        </div>
        <span class="text-dim mono-text" style="font-size:0.75rem;">Min Out: ${order.minAmountOut} • Salt: ${order.salt.slice(0, 8)}...</span>
      </div>
      <div>
        ${order.revealed ?
          `<span class="text-green bold" style="font-size:0.85rem;">✓ Revealed</span>` :
          `<button class="btn btn-primary" onclick="handleReveal(${order.id})">Reveal Plaintext</button>`}
      </div>
    </div>
  `).join('');
}

// Render Order History
function renderOrderHistory() {
  const container = document.getElementById("orderHistoryList");
  const settledOrders = STATE.orders.filter(o => o.settled);

  if (settledOrders.length === 0) {
    container.innerHTML = `
      <div class="empty-orders-state">
        <p>No settled orders yet.</p>
      </div>`;
    return;
  }

  container.innerHTML = settledOrders.map(order => `
    <div class="order-item-card">
      <div class="order-item-meta">
        <span class="bold">Order #${order.id} (Window ${order.windowIndex})</span>
        <span class="text-dim" style="font-size:0.8rem;">Swapped ${order.amount} ${order.zeroForOne ? 'T0' : 'T1'}</span>
      </div>
      <span class="text-green bold" style="font-size:0.85rem;">✓ Settled</span>
    </div>
  `).join('');
}

// Greedy Two-Pointer CoW Match Preview Simulator
function renderKeeperMatchingPreview(settleWindowIndex) {
  const settleOrders = STATE.orders.filter(o => o.windowIndex === settleWindowIndex && !o.settled);
  const visualList = document.getElementById("batchOrdersVisual");

  if (settleOrders.length === 0) {
    visualList.innerHTML = `
      <div class="empty-orders-state" style="padding: 20px 0;">
        <p>No unsettled commitments in Window ${settleWindowIndex}.</p>
      </div>`;
    document.getElementById("cowVolumeDisplay").textContent = "0.0 Token";
    document.getElementById("ammVolumeDisplay").textContent = "0.0 Token";
    document.getElementById("keeperPayoutDisplay").textContent = "0.0000 ETH";
    return;
  }

  const group0 = settleOrders.filter(o => o.revealed && o.zeroForOne);
  const group1 = settleOrders.filter(o => o.revealed && !o.zeroForOne);
  const unrevealed = settleOrders.filter(o => !o.revealed);

  let totalT0 = group0.reduce((acc, o) => acc + parseFloat(o.amount), 0);
  let totalT1 = group1.reduce((acc, o) => acc + parseFloat(o.amount), 0);

  // At 1:1 demo spot price
  let matchedVol = Math.min(totalT0, totalT1);
  let residualVol = Math.abs(totalT0 - totalT1);

  // Keeper Payout = 5% fee on revealed bonds + 100% on forfeited bonds
  let revealedBondsTotal = settleOrders.filter(o => o.revealed).length * parseFloat(STATE.minBondEth);
  let forfeitedBondsTotal = unrevealed.length * parseFloat(STATE.minBondEth);
  let keeperEstReward = (revealedBondsTotal * 0.05) + forfeitedBondsTotal;

  document.getElementById("cowVolumeDisplay").textContent = `${(matchedVol * 2).toFixed(1)} Token`;
  document.getElementById("ammVolumeDisplay").textContent = `${residualVol.toFixed(1)} Token`;
  document.getElementById("keeperPayoutDisplay").textContent = `${keeperEstReward.toFixed(4)} ETH`;
  document.getElementById("keeperRewardEstimate").textContent = `${keeperEstReward.toFixed(4)} ETH`;

  visualList.innerHTML = settleOrders.map(order => `
    <div class="order-match-row ${order.revealed ? 'matched' : 'residual'}">
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="order-badge">#${order.id}</span>
        <span>${order.amount} ${order.zeroForOne ? 'Token0 → Token1' : 'Token1 → Token0'}</span>
      </div>
      <div>
        ${order.revealed ?
          `<span class="text-green font-mono" style="font-size:0.8rem;">CoW Matched (5% Fee)</span>` :
          `<span class="text-yellow font-mono" style="font-size:0.8rem;">Unrevealed (100% Forfeited)</span>`}
      </div>
    </div>
  `).join('');
}

// User Actions
window.handleReveal = function(orderId) {
  const order = STATE.orders.find(o => o.id === orderId);
  if (!order) return;

  order.revealed = true;
  showToast(`Revealed Order #${orderId}! Plaintext published.`, "success");
  updateUI();
};

function setupEventListeners() {
  // Tabs
  document.getElementById("tabCommitBtn").addEventListener("click", () => switchTab("tabCommitContent", "tabCommitBtn"));
  document.getElementById("tabRevealBtn").addEventListener("click", () => switchTab("tabRevealContent", "tabRevealBtn"));
  document.getElementById("tabMyOrdersBtn").addEventListener("click", () => switchTab("tabMyOrdersContent", "tabMyOrdersBtn"));

  // Direction Switch
  document.getElementById("switchDirectionBtn").addEventListener("click", () => {
    const selIn = document.getElementById("selectTokenIn");
    const selOut = document.getElementById("selectTokenOut");
    const temp = selIn.value;
    selIn.value = selOut.value;
    selOut.value = temp;
    updateIntentHashPreview();
  });

  // Salt Regen
  document.getElementById("regenSaltBtn").addEventListener("click", () => {
    initSalt();
    showToast("Generated new cryptographic salt.", "info");
  });

  // Inputs
  document.getElementById("inputAmountIn").addEventListener("input", updateIntentHashPreview);
  document.getElementById("inputMinAmountOut").addEventListener("input", updateIntentHashPreview);
  document.getElementById("selectTokenIn").addEventListener("change", updateIntentHashPreview);

  // Submit Commit
  document.getElementById("submitCommitBtn").addEventListener("click", () => {
    const amountIn = document.getElementById("inputAmountIn").value;
    const minOut = document.getElementById("inputMinAmountOut").value;
    const zeroForOne = document.getElementById("selectTokenIn").value === "token0";
    const currentWindow = getWindowIndex(STATE.currentBlock);

    if (!amountIn || parseFloat(amountIn) <= 0) {
      showToast("Please specify a valid swap amount.", "warning");
      return;
    }

    const newOrder = {
      id: STATE.orders.length,
      committer: STATE.walletAddress,
      windowIndex: currentWindow,
      amount: amountIn,
      minAmountOut: minOut,
      zeroForOne: zeroForOne,
      salt: STATE.currentSalt,
      bondAmount: STATE.minBondEth,
      revealed: false,
      settled: false
    };

    STATE.orders.push(newOrder);
    showToast(`Committed ${amountIn} tokens with 0.001 ETH bond for Window ${currentWindow}!`, "success");
    initSalt();
    updateUI();
  });

  // Advance Block
  document.getElementById("advanceBlockBtn").addEventListener("click", () => {
    STATE.currentBlock += 1;
    updateUI();
    showToast(`Advanced to Block #${STATE.currentBlock} (Window ${getWindowIndex(STATE.currentBlock)})`, "info");
  });

  // Settle Batch
  document.getElementById("settleBatchBtn").addEventListener("click", () => {
    const settleWindow = getWindowIndex(STATE.currentBlock) - 2;
    const toSettle = STATE.orders.filter(o => o.windowIndex <= settleWindow && !o.settled);

    if (toSettle.length === 0) {
      showToast(`No unsettled orders available in Window ${settleWindow}.`, "warning");
      return;
    }

    toSettle.forEach(o => o.settled = true);
    showToast(`⚡ Settled Batch for Window ${settleWindow}! Keeper payout distributed.`, "success");
    updateUI();
  });

  // Connect Wallet
  document.getElementById("connectWalletBtn").addEventListener("click", async () => {
    if (window.ethereum) {
      try {
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        if (accounts.length > 0) {
          STATE.walletAddress = accounts[0];
          document.getElementById("walletBtnText").textContent =
            accounts[0].slice(0, 6) + "..." + accounts[0].slice(-4);
          showToast(`Connected wallet: ${accounts[0].slice(0, 6)}...`, "success");
          updateIntentHashPreview();
          updateUI();
        }
      } catch (err) {
        showToast("Wallet connection declined.", "warning");
      }
    } else {
      showToast("MetaMask / Web3 browser wallet not detected. Running in simulator mode.", "info");
    }
  });
}

function switchTab(contentId, btnId) {
  document.querySelectorAll(".tab-content").forEach(el => el.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach(el => el.classList.remove("active"));
  document.getElementById(contentId).classList.add("active");
  document.getElementById(btnId).classList.add("active");
}

function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${type === 'success' ? '✅' : type === 'warning' ? '⚠️' : 'ℹ️'}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
