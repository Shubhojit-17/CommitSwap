/**
 * CommitSwap — Advanced Web3 Terminal & CoW Matching Engine
 * Built for Uniswap v4 Hookathon • Base Sepolia Live Integration
 */

// ABIs
const COMMIT_SWAP_HOOK_ABI = [
  "function commit(bytes32 intentHash) external payable returns (uint256)",
  "function reveal(uint256 commitmentId, uint256 amount, uint256 minAmountOut, bool zeroForOne, bytes32 poolId, bytes32 salt) external",
  "function settleBatch(uint256 windowIndex, tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) external returns (bytes)",
  "function currentWindowIndex() external view returns (uint256)",
  "function getCommitment(uint256 commitmentId) external view returns (tuple(address committer, bytes32 intentHash, uint256 windowIndex, uint256 bondAmount, bool revealed, uint256 amount, uint256 minAmountOut, bool zeroForOne))",
  "function getWindowCommitIds(uint256 windowIndex) external view returns (uint256[])",
  "function POOL_ID() external view returns (bytes32)",
  "function MIN_BOND() external view returns (uint256)",
  "function WINDOW_BLOCKS() external view returns (uint256)"
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function mint(address to, uint256 amount) external",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

// Protocol State
const STATE = {
  activePage: "overview",
  isWalletConnected: false,
  isWsConnected: false,
  ws: null,
  provider: null,
  signer: null,
  walletAddress: "0x8E1337357Ac77E58c2BbAB77174E07406cB7Acc6",
  ethBalance: "0.0100",
  chainId: 84532,
  
  // Live Deployed Base Sepolia Contracts
  hookAddress: "0x2515d22308d5487207E914a691FacF6488244088",
  poolManagerAddress: "0x8D2287c8da8a2603f7f850b3339d9394fd397127",
  poolId: "0x979c9893d5ba35d5fa3ec1cf3720f53fa5d7b2380ecceb41960daad10bb9acaf",
  token0Address: "0x0fE4C5971c2F83F0647eC927d8CD8D25129425B0",
  token1Address: "0x2e09c1117542076dA6925C6275793b1e5d4132EA",
  
  // Window & Block Timers
  currentBlock: 46328885,
  windowBlocks: 5,
  minBondEth: "0.001",
  gasPriceGwei: "0.006",
  
  // Current Trade Desk Draft
  currentSalt: null,
  currentHash: null,
  slippagePct: 0.5,
  
  // Live On-Chain Commitments recorded on Base Sepolia
  orders: [
    {
      id: 0,
      committer: "0x8E1337357Ac77E58c2BbAB77174E07406cB7Acc6",
      windowIndex: 9265777,
      amount: "10.0",
      minAmountOut: "9.5",
      zeroForOne: true,
      salt: "0x" + ethers.keccak256(ethers.toUtf8Bytes("trader1-salt")).slice(2),
      bondAmount: "0.001",
      revealed: false,
      settled: false,
      txHash: "0x177fc28a3a55eb1cec3581bbfd02b424b88f3ce8973de20bb761f1b6d2d3a39f"
    },
    {
      id: 1,
      committer: "0x8E1337357Ac77E58c2BbAB77174E07406cB7Acc6",
      windowIndex: 9265777,
      amount: "10.0",
      minAmountOut: "9.5",
      zeroForOne: false,
      salt: "0x" + ethers.keccak256(ethers.toUtf8Bytes("trader2-salt")).slice(2),
      bondAmount: "0.001",
      revealed: false,
      settled: false,
      txHash: "0x697daa151bd845c6068ff82f00571dfa648f3ae919d6896a89fe92451a2ef5e2"
    }
  ]
};

// Connect to Backend WebSocket
function connectBackendWebSocket() {
  try {
    const ws = new WebSocket("ws://localhost:3001/ws");
    STATE.ws = ws;

    ws.onopen = () => {
      STATE.isWsConnected = true;
      console.log("[WS] Connected to CommitSwap Protocol Daemon");
      const statusTitle = document.querySelector(".status-title");
      if (statusTitle) statusTitle.textContent = "Daemon Online (WS)";
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        handleIncomingWebSocketEvent(msg);
      } catch (err) {
        console.warn("WS parse error:", err);
      }
    };

    ws.onclose = () => {
      STATE.isWsConnected = false;
      const statusTitle = document.querySelector(".status-title");
      if (statusTitle) statusTitle.textContent = "Base Sepolia (RPC)";
      setTimeout(connectBackendWebSocket, 4000); // Auto-reconnect
    };

    ws.onerror = () => {
      STATE.isWsConnected = false;
    };
  } catch (e) {
    console.warn("WebSocket init exception:", e);
  }
}

function handleIncomingWebSocketEvent(event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case "order:committed": {
      const order = event.data;
      if (!STATE.orders.some(o => o.id === order.id)) {
        STATE.orders.push({
          id: order.id,
          committer: order.committer,
          windowIndex: order.windowIndex,
          amount: ethers.formatEther(order.amount || "0"),
          minAmountOut: ethers.formatEther(order.minAmountOut || "0"),
          zeroForOne: order.zeroForOne,
          salt: order.salt,
          bondAmount: "0.001",
          revealed: order.revealed,
          settled: order.settled,
          txHash: order.txHash
        });
        showToast(`⚡ New Commitment broadcasted on-chain: Order #${order.id} for Window W${order.windowIndex}!`, "info");
        updateUI();
      }
      break;
    }
    case "order:revealed": {
      const revealedOrder = event.data;
      const target = STATE.orders.find(o => o.id === revealedOrder.id);
      if (target) {
        target.revealed = true;
        target.amount = ethers.formatEther(revealedOrder.amount || "0");
        target.minAmountOut = ethers.formatEther(revealedOrder.minAmountOut || "0");
        showToast(`🔓 Order #${revealedOrder.id} plaintext revealed on-chain!`, "info");
        updateUI();
      }
      break;
    }
    case "batch:settled": {
      const data = event.data;
      const targetOrders = STATE.orders.filter(o => o.windowIndex === data.windowIndex);
      targetOrders.forEach(o => o.settled = true);
      showToast(
        `🏆 Batch Settled on Base Sepolia for Window W${data.windowIndex}! Keeper payout: ${data.keeperRewardEth} ETH. ${data.txHash ? `<a href="https://sepolia.basescan.org/tx/${data.txHash}" target="_blank" style="color:#6ee7b7;text-decoration:underline;">BaseScan ↗</a>` : ''}`,
        "success"
      );
      updateUI();
      break;
    }
    case "window:advanced": {
      STATE.currentBlock = event.data.block;
      updateUI();
      break;
    }
  }
}

// Compute Window
function getWindow(block) {
  return Math.floor(block / STATE.windowBlocks);
}

// Cryptographic Salt
function generateSalt() {
  const array = new Uint8Array(32);
  window.crypto.getRandomValues(array);
  return "0x" + Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

// Compute Keccak256 Intent Hash
function computeIntentHash(amountStr, minOutStr, zeroForOne, poolId, salt, committer) {
  try {
    const amountWei = ethers.parseEther(amountStr || "0");
    const minOutWei = ethers.parseEther(minOutStr || "0");
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
      ["uint256", "uint256", "bool", "bytes32", "bytes32", "address"],
      [amountWei, minOutWei, zeroForOne, poolId, salt, committer]
    );
    return ethers.keccak256(encoded);
  } catch (err) {
    return "0x0000000000000000000000000000000000000000000000000000000000000000";
  }
}

// Initialize Application
document.addEventListener("DOMContentLoaded", async () => {
  initSalt();
  setupNavigation();
  setupTradeHandlers();
  setupExecutionHandlers();
  setupFaucetHandlers();
  setupWalletHandler();
  setupSettingsHandler();
  setupThemeHandler();
  setupQuickPctHandler();
  
  // Connect to live Backend WebSocket, REST API, and RPC
  connectBackendWebSocket();
  await initLiveProvider();
  await fetchInitialOrders();
  
  updateUI();
  initAnalyticsCharts();
  
  // Poll live block number every 5 seconds on Base Sepolia
  setInterval(async () => {
    if (STATE.provider) {
      try {
        const block = await STATE.provider.getBlockNumber();
        if (block !== STATE.currentBlock) {
          STATE.currentBlock = block;
          updateUI();
        }
      } catch (e) {
        // Strict on-chain: do not fabricate simulated increments
      }
    }
  }, 5000);
});

async function initLiveProvider() {
  try {
    // Connect to Base Sepolia public RPC directly
    STATE.provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
    const network = await STATE.provider.getNetwork();
    STATE.currentBlock = await STATE.provider.getBlockNumber();
    
    const feeData = await STATE.provider.getFeeData();
    if (feeData.gasPrice) {
      STATE.gasPriceGwei = (Number(feeData.gasPrice) / 1e9).toFixed(3);
    }
  } catch (err) {
    console.warn("Base Sepolia public RPC connection notice:", err);
  }
}

function initSalt() {
  STATE.currentSalt = generateSalt();
  updateTradeHashPreview();
}

function updateTradeHashPreview() {
  const amountIn = document.getElementById("tradeInputAmountIn")?.value || "0";
  const minOut = document.getElementById("tradeInputMinOut")?.value || "0";
  const zeroForOne = document.getElementById("tradeSelectTokenIn")?.value === "token0";

  STATE.currentHash = computeIntentHash(
    amountIn,
    minOut,
    zeroForOne,
    STATE.poolId,
    STATE.currentSalt,
    STATE.walletAddress
  );

  const saltEl = document.getElementById("tradeSaltDisplay");
  if (saltEl) saltEl.textContent = STATE.currentSalt.slice(0, 8) + "..." + STATE.currentSalt.slice(-6);

  const hashEl = document.getElementById("tradeHashDisplay");
  if (hashEl) hashEl.textContent = STATE.currentHash.slice(0, 10) + "..." + STATE.currentHash.slice(-8);
}

// Navigation Router
function navigateTo(pageId) {
  STATE.activePage = pageId;
  document.querySelectorAll(".page-view").forEach(el => el.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(el => el.classList.remove("active"));

  const targetPage = document.getElementById(`page-${pageId}`);
  if (targetPage) targetPage.classList.add("active");

  const targetNav = document.querySelector(`.nav-item[data-page="${pageId}"]`);
  if (targetNav) targetNav.classList.add("active");

  const titleMap = {
    overview: "Overview Dashboard",
    trade: "Trade & Commit Desk",
    execution: "Batch Execution & Keeper Engine",
    vault: "Liquidity & Vault Desk",
    analytics: "MEV & Protection Analytics",
    history: "On-Chain History & Explorer",
    settings: "Contracts & Network Hub"
  };
  document.getElementById("pageTitleDisplay").textContent = titleMap[pageId] || "Dashboard";
  
  if (pageId === "analytics") {
    setTimeout(initAnalyticsCharts, 100);
  }
}

function setupNavigation() {
  document.querySelectorAll(".sidebar-nav .nav-item").forEach(item => {
    item.addEventListener("click", () => {
      const page = item.getAttribute("data-page");
      navigateTo(page);
    });
  });

  const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener("click", () => {
      document.getElementById("appSidebar").classList.toggle("open");
    });
  }
}

// Main UI State Synchronizer
function updateUI() {
  const currentWindow = getWindow(STATE.currentBlock);
  const blockInWindow = STATE.currentBlock % STATE.windowBlocks;
  const blocksRemaining = STATE.windowBlocks - blockInWindow;

  // Header Displays
  document.getElementById("sidebarBlockNumber").textContent = `Block #${STATE.currentBlock.toLocaleString()}`;
  document.getElementById("headerWindowIndex").textContent = `W${currentWindow}`;
  document.getElementById("headerGasPrice").textContent = `${STATE.gasPriceGwei} Gwei`;

  // Window Progress Bar
  const progText = document.getElementById("windowRemainingBlocksText");
  if (progText) progText.textContent = `Blocks left: ${blocksRemaining} / ${STATE.windowBlocks}`;

  const progFill = document.getElementById("windowMiniProgressBar");
  if (progFill) progFill.style.width = `${((blockInWindow + 1) / STATE.windowBlocks) * 100}%`;

  // Overview Pipeline
  const st1Win = document.getElementById("overviewStage1Window");
  if (st1Win) st1Win.textContent = `Window W${currentWindow}`;
  const st2Win = document.getElementById("overviewStage2Window");
  if (st2Win) st2Win.textContent = `Window W${currentWindow - 1}`;
  const st3Win = document.getElementById("overviewStage3Window");
  if (st3Win) st3Win.textContent = `Window W${currentWindow - 2}`;

  const tradeWinTag = document.getElementById("tradeActiveWindowTag");
  if (tradeWinTag) tradeWinTag.textContent = `W${currentWindow}`;
  const tradeRevTag = document.getElementById("tradeRevealWindowTag");
  if (tradeRevTag) tradeRevTag.textContent = `W${currentWindow - 1}`;

  // Orders statistics
  const stage1Orders = STATE.orders.filter(o => o.windowIndex === currentWindow);
  document.getElementById("overviewStage1Commits").textContent = `${stage1Orders.length} Order${stage1Orders.length === 1 ? '' : 's'}`;

  const stage2Orders = STATE.orders.filter(o => o.windowIndex === currentWindow - 1);
  const stage2Revealed = stage2Orders.filter(o => o.revealed).length;
  document.getElementById("overviewStage2Revealed").textContent = `${stage2Revealed} / ${stage2Orders.length} Revealed`;

  // Keeper Rewards
  const stage3Orders = STATE.orders.filter(o => o.windowIndex === currentWindow - 2 && !o.settled);
  const revBonds = stage3Orders.filter(o => o.revealed).length * 0.001;
  const forfBonds = stage3Orders.filter(o => !o.revealed).length * 0.001;
  const keeperCut = (revBonds * 0.05) + forfBonds;
  document.getElementById("overviewStage3Reward").textContent = `${keeperCut.toFixed(4)} ETH`;
  document.getElementById("execKeeperPayout").textContent = `${keeperCut.toFixed(4)} ETH`;

  // Render Sub-Views
  renderRevealDesk(currentWindow - 1);
  renderExecutionCanvas(currentWindow - 2);
  renderActivityFeed();
  renderHistoryTable();
  updateVaultDisplay();
}

// Render Reveal Queue
function renderRevealDesk(revealWindow) {
  const container = document.getElementById("tradeRevealOrdersContainer");
  if (!container) return;

  const eligibleOrders = STATE.orders.filter(o => o.windowIndex === revealWindow);
  document.getElementById("tradePendingRevealCount").textContent = `${eligibleOrders.filter(o => !o.revealed).length} Pending`;

  if (eligibleOrders.length === 0) {
    container.innerHTML = `
      <div class="empty-orders-state" style="padding: 40px 0; text-align: center; color: var(--text-dim);">
        <i data-lucide="inbox" style="width: 32px; height: 32px; margin-bottom: 8px;"></i>
        <p>No orders pending reveal for Window W${revealWindow}.</p>
      </div>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  container.innerHTML = eligibleOrders.map(order => `
    <div class="reveal-card-item">
      <div class="reveal-card-meta">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="badge-mini">#${order.id}</span>
          <span class="bold">${order.amount} ${order.zeroForOne ? 'Token0 → Token1' : 'Token1 → Token0'}</span>
        </div>
        <span class="font-mono text-dim" style="font-size:0.75rem;">Min Out: ${order.minAmountOut} • Salt: ${order.salt.slice(0, 8)}...</span>
        ${order.txHash ? `<a href="https://sepolia.basescan.org/tx/${order.txHash}" target="_blank" class="link-btn" style="font-size:0.75rem;">BaseScan Tx ↗</a>` : ''}
      </div>
      <div>
        ${order.revealed ?
          `<span class="text-emerald bold" style="font-size:0.85rem;">✓ Revealed</span>` :
          `<button class="btn btn-primary" onclick="handleReveal(${order.id})">Reveal Plaintext</button>`}
      </div>
    </div>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

// Render Execution Canvas
function renderExecutionCanvas(settleWindow) {
  const container = document.getElementById("execBatchPairingContainer");
  if (!container) return;

  const targetOrders = STATE.orders.filter(o => o.windowIndex === settleWindow && !o.settled);
  document.getElementById("execTargetWindow").textContent = `Window W${settleWindow}`;

  if (targetOrders.length === 0) {
    container.innerHTML = `
      <div class="empty-orders-state" style="padding: 40px 0; text-align: center; color: var(--text-dim);">
        <i data-lucide="check-circle" style="width: 32px; height: 32px; margin-bottom: 8px;"></i>
        <p>All commitments in Window W${settleWindow} are settled or queue is clear.</p>
      </div>`;
    document.getElementById("execCowVolume").textContent = "0.0 T0/T1";
    document.getElementById("execAmmVolume").textContent = "0.0 T0/T1";
    if (window.lucide) lucide.createIcons();
    return;
  }

  const group0 = targetOrders.filter(o => o.revealed && o.zeroForOne);
  const group1 = targetOrders.filter(o => o.revealed && !o.zeroForOne);
  let vol0 = group0.reduce((acc, o) => acc + parseFloat(o.amount), 0);
  let vol1 = group1.reduce((acc, o) => acc + parseFloat(o.amount), 0);

  let cowMatch = Math.min(vol0, vol1);
  let residual = Math.abs(vol0 - vol1);

  document.getElementById("execCowVolume").textContent = `${(cowMatch * 2).toFixed(1)} T0/T1`;
  document.getElementById("execAmmVolume").textContent = `${residual.toFixed(1)} T0/T1`;

  container.innerHTML = `
    <div class="cow-crossing-visualizer">
      <!-- Left Lane: Token0 -> Token1 -->
      <div class="cow-lane">
        <div class="cow-lane-header text-amber">
          <i data-lucide="arrow-down-right"></i>
          <span>T0 → T1 Intents (${group0.length})</span>
        </div>
        ${group0.length > 0 ? group0.map(o => `
          <div class="cow-order-card">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span class="bold">#${o.id} · ${o.amount} T0</span>
              <span class="text-dim font-mono" style="font-size:0.75rem;">${o.committer.slice(0, 6)}...</span>
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted); display:flex; justify-content:space-between;">
              <span>Min Out: ${o.minAmountOut} T1</span>
              <span style="color:#10b981; font-weight:600;">CoW Ready</span>
            </div>
          </div>
        `).join('') : `<div style="color:var(--text-dim); font-size:0.8rem; padding:12px 0;">No active T0 intents in window</div>`}
      </div>

      <!-- Center Crossing Beam -->
      <div class="cow-center-crossing">
        <div class="crossing-icon-wrap">
          <i data-lucide="refresh-cw"></i>
        </div>
        <div style="font-size:0.85rem; font-weight:700; color:#10b981;">
          ${(cowMatch * 2).toFixed(1)} Matched
        </div>
        <div style="font-size:0.75rem; color:var(--text-muted); line-height:1.3;">
          Zero Slippage<br>Zero LP Fee
        </div>
        ${residual > 0 ? `
          <div style="font-size:0.7rem; padding:3px 8px; background:rgba(245,158,11,0.15); color:#f59e0b; border-radius:999px; border:1px solid rgba(245,158,11,0.3); margin-top:4px;">
            Residual: ${residual.toFixed(1)} AMM / Roll
          </div>
        ` : ''}
      </div>

      <!-- Right Lane: Token1 -> Token0 -->
      <div class="cow-lane">
        <div class="cow-lane-header text-cobalt">
          <i data-lucide="arrow-up-left"></i>
          <span>T1 → T0 Intents (${group1.length})</span>
        </div>
        ${group1.length > 0 ? group1.map(o => `
          <div class="cow-order-card">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span class="bold">#${o.id} · ${o.amount} T1</span>
              <span class="text-dim font-mono" style="font-size:0.75rem;">${o.committer.slice(0, 6)}...</span>
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted); display:flex; justify-content:space-between;">
              <span>Min Out: ${o.minAmountOut} T0</span>
              <span style="color:#10b981; font-weight:600;">CoW Ready</span>
            </div>
          </div>
        `).join('') : `<div style="color:var(--text-dim); font-size:0.8rem; padding:12px 0;">No active T1 intents in window</div>`}
      </div>
    </div>
  `;
  if (window.lucide) lucide.createIcons();
}

// Render Activity Feed & History Table
function renderActivityFeed() {
  const tbody = document.getElementById("overviewActivityTableBody");
  if (!tbody) return;

  if (STATE.orders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-dim); padding:24px;">No on-chain activity recorded yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = STATE.orders.slice(-5).reverse().map(o => `
    <tr>
      <td><span class="status-badge ${o.revealed ? 'success' : 'pending'}">${o.revealed ? 'Revealed' : 'Committed'}</span></td>
      <td class="font-mono">${o.committer.slice(0, 6)}...${o.committer.slice(-4)}</td>
      <td class="font-mono">W${o.windowIndex}</td>
      <td>${o.amount} ${o.zeroForOne ? 'T0 → T1' : 'T1 → T0'}</td>
      <td class="font-mono">0.001 ETH</td>
      <td><a href="https://sepolia.basescan.org/tx/${o.txHash || ''}" target="_blank" class="link-btn">BaseScan ↗</a></td>
    </tr>
  `).join('');
}

function renderHistoryTable() {
  const tbody = document.getElementById("historyTableBody");
  if (!tbody) return;

  if (STATE.orders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--text-dim); padding:32px;">No historical orders. Commit an order on the Trade Desk to get started.</td></tr>`;
    return;
  }

  tbody.innerHTML = STATE.orders.map(o => `
    <tr>
      <td class="font-mono">#${o.id}</td>
      <td class="font-mono">${o.committer.slice(0, 6)}...${o.committer.slice(-4)}</td>
      <td>${o.zeroForOne ? 'Token0 → Token1' : 'Token1 → Token0'}</td>
      <td class="bold font-mono">${o.amount}</td>
      <td class="font-mono">${o.minAmountOut}</td>
      <td class="font-mono text-emerald">0.001 ETH</td>
      <td class="font-mono">W${o.windowIndex}</td>
      <td><span class="status-badge ${o.settled ? 'success' : o.revealed ? 'success' : 'pending'}">${o.settled ? 'Settled' : o.revealed ? 'Revealed' : 'Committed'}</span></td>
      <td><a href="https://sepolia.basescan.org/tx/${o.txHash || ''}" target="_blank" class="link-btn">View ↗</a></td>
    </tr>
  `).join('');
}

function updateVaultDisplay() {
  const pId = document.getElementById("vaultPoolIdDisplay");
  if (pId) pId.textContent = STATE.poolId;
  const t0 = document.getElementById("vaultToken0Display");
  if (t0) t0.textContent = STATE.token0Address;
  const t1 = document.getElementById("vaultToken1Display");
  if (t1) t1.textContent = STATE.token1Address;
  const hook = document.getElementById("vaultHookAddressDisplay");
  if (hook) hook.textContent = STATE.hookAddress;
}

// Trade Handlers
function setupTradeHandlers() {
  document.getElementById("tradeRegenSaltBtn")?.addEventListener("click", () => {
    initSalt();
    showToast("Generated fresh 32-byte cryptographic salt.", "info");
  });

  document.getElementById("tradeFlipTokensBtn")?.addEventListener("click", () => {
    const selIn = document.getElementById("tradeSelectTokenIn");
    const selOut = document.getElementById("tradeSelectTokenOut");
    const temp = selIn.value;
    selIn.value = selOut.value;
    selOut.value = temp;
    updateTradeHashPreview();
  });

  document.getElementById("tradeInputAmountIn")?.addEventListener("input", updateTradeHashPreview);
  document.getElementById("tradeInputMinOut")?.addEventListener("input", updateTradeHashPreview);
  document.getElementById("tradeSelectTokenIn")?.addEventListener("change", updateTradeHashPreview);

  document.querySelectorAll(".slip-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".slip-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.slippagePct = parseFloat(btn.getAttribute("data-slip"));
      
      const amt = parseFloat(document.getElementById("tradeInputAmountIn").value || "0");
      if (amt > 0) {
        const minOut = amt * (1 - (STATE.slippagePct / 100));
        document.getElementById("tradeInputMinOut").value = minOut.toFixed(4);
        updateTradeHashPreview();
      }
    });
  });

  // Submit Commit (100% Real On-Chain via MetaMask)
  document.getElementById("tradeSubmitCommitBtn")?.addEventListener("click", async () => {
    const amountIn = document.getElementById("tradeInputAmountIn").value;
    const minOut = document.getElementById("tradeInputMinOut").value;
    const zeroForOne = document.getElementById("tradeSelectTokenIn").value === "token0";
    const currentWindow = getWindow(STATE.currentBlock);

    if (!amountIn || parseFloat(amountIn) <= 0) {
      showToast("Please specify a valid trade amount.", "warning");
      return;
    }

    if (!STATE.isWalletConnected || !STATE.signer) {
      showToast("Please connect your MetaMask wallet on Base Sepolia first.", "warning");
      document.getElementById("connectWalletBtn")?.click();
      return;
    }

    if (STATE.hookAddress === ethers.ZeroAddress || STATE.hookAddress === "0x0000000000000000000000000000000000000088") {
      showToast("Notice: Hook contract must be deployed on Base Sepolia before committing.", "warning");
    }

    try {
      showProofModal();
      updateProofStep(1, 25);
      await new Promise(r => setTimeout(r, 350));
      updateProofStep(2, 45);
      await new Promise(r => setTimeout(r, 300));
      updateProofStep(3, 65);

      const hookContract = new ethers.Contract(STATE.hookAddress, COMMIT_SWAP_HOOK_ABI, STATE.signer);
      
      const tx = await hookContract.commit(STATE.currentHash, {
        value: ethers.parseEther("0.001")
      });

      updateProofStep(4, 85);
      showToast(`Tx broadcasted: ${tx.hash.slice(0, 10)}... Confirming on Base Sepolia...`, "info");
      const receipt = await tx.wait();

      finishProofModal(tx.hash);
      showToast(
        `✅ Commit Confirmed on Base Sepolia! <a href="https://sepolia.basescan.org/tx/${tx.hash}" target="_blank" style="color:#6ee7b7;text-decoration:underline;">BaseScan ↗</a>`,
        "success"
      );

      const newOrder = {
        id: STATE.orders.length,
        committer: STATE.walletAddress,
        windowIndex: currentWindow,
        amount: amountIn,
        minAmountOut: minOut,
        zeroForOne: zeroForOne,
        salt: STATE.currentSalt,
        bondAmount: "0.001",
        revealed: false,
        settled: false,
        txHash: tx.hash
      };

      STATE.orders.push(newOrder);

      // Sync with backend daemon
      try {
        await fetch("http://localhost:3001/api/orders/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            committer: STATE.walletAddress,
            amount: amountIn,
            minAmountOut: minOut,
            zeroForOne: zeroForOne,
            salt: STATE.currentSalt,
            txHash: tx.hash,
            windowIndex: currentWindow
          })
        });
      } catch (err) {
        console.warn("Backend sync notice:", err);
      }

      initSalt();
      updateUI();
    } catch (err) {
      document.getElementById("proofModalOverlay")?.classList.remove("active");
      console.error("On-chain commit error:", err);
      showToast(`Transaction rejected or reverted: ${err.shortMessage || err.message}`, "warning");
    }
  });
}

// Reveal Action Handler (100% Real On-Chain via MetaMask)
window.handleReveal = async function(orderId) {
  const order = STATE.orders.find(o => o.id === orderId);
  if (!order) return;

  if (!STATE.isWalletConnected || !STATE.signer) {
    showToast("Please connect your MetaMask wallet on Base Sepolia first.", "warning");
    document.getElementById("connectWalletBtn")?.click();
    return;
  }

  try {
    showToast(`Submitting reveal for Order #${orderId} to MetaMask...`, "info");
    const hookContract = new ethers.Contract(STATE.hookAddress, COMMIT_SWAP_HOOK_ABI, STATE.signer);
    
    const tx = await hookContract.reveal(
      order.id,
      ethers.parseEther(order.amount),
      ethers.parseEther(order.minAmountOut),
      order.zeroForOne,
      STATE.poolId,
      order.salt
    );

    showToast(`Reveal tx: ${tx.hash.slice(0, 10)}... Confirming on Base Sepolia...`, "info");
    await tx.wait();

    order.revealed = true;
    showToast(
      `✅ Revealed Order #${orderId} on Base Sepolia! <a href="https://sepolia.basescan.org/tx/${tx.hash}" target="_blank" style="color:#6ee7b7;text-decoration:underline;">BaseScan ↗</a>`,
      "success"
    );

    // Sync with backend daemon
    try {
      await fetch("http://localhost:3001/api/orders/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: order.id,
          amount: order.amount,
          minAmountOut: order.minAmountOut,
          zeroForOne: order.zeroForOne,
          salt: order.salt
        })
      });
    } catch (err) {
      console.warn("Backend sync notice:", err);
    }

    updateUI();
  } catch (err) {
    console.error("On-chain reveal error:", err);
    showToast(`Reveal error: ${err.shortMessage || err.message}`, "warning");
  }
};

// Fetch Real Indexed Orders from Backend API
async function fetchInitialOrders() {
  try {
    const res = await fetch("http://localhost:3001/api/orders");
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        STATE.orders = data.map(o => ({
          ...o,
          amount: o.amount ? ethers.formatEther(o.amount) : "0.0",
          minAmountOut: o.minAmountOut ? ethers.formatEther(o.minAmountOut) : "0.0",
          bondAmount: o.bondAmount ? ethers.formatEther(o.bondAmount) : "0.001"
        }));
        updateUI();
      }
    }
  } catch (err) {
    console.warn("Notice syncing orders from backend:", err);
  }
}

// Execution & Keeper Handlers
function setupExecutionHandlers() {
  document.getElementById("execSettleBatchBtn")?.addEventListener("click", async () => {
    const settleWindow = getWindow(STATE.currentBlock) - 2;
    const toSettle = STATE.orders.filter(o => o.windowIndex <= settleWindow && !o.settled);

    if (toSettle.length === 0) {
      showToast(`No unsettled orders available in Window W${settleWindow}.`, "warning");
      return;
    }

    if (!STATE.isWalletConnected || !STATE.signer) {
      showToast("Please connect MetaMask on Base Sepolia to broadcast on-chain batch settlement.", "warning");
      return;
    }

    try {
      showToast(`Submitting on-chain settleBatch for Window W${settleWindow}...`, "info");
      const hookContract = new ethers.Contract(STATE.hookAddress, COMMIT_SWAP_HOOK_ABI, STATE.signer);
      
      const poolKey = {
        currency0: STATE.token0Address,
        currency1: STATE.token1Address,
        fee: 3000,
        tickSpacing: 60,
        hooks: STATE.hookAddress
      };

      const tx = await hookContract.settleBatch(settleWindow, poolKey);
      showToast(`Settlement tx broadcasted: ${tx.hash.slice(0, 10)}... Confirming on-chain...`, "info");
      await tx.wait();

      toSettle.forEach(o => o.settled = true);
      showToast(
        `⚡ On-Chain Batch Settled for Window W${settleWindow}! Keeper fee claimed. <a href="https://sepolia.basescan.org/tx/${tx.hash}" target="_blank" style="color:#6ee7b7;text-decoration:underline;">BaseScan ↗</a>`,
        "success"
      );
      updateUI();
    } catch (err) {
      console.error("Settle batch error:", err);
      showToast(`Settlement error: ${err.shortMessage || err.message}`, "warning");
    }
  });
}

// On-Chain Faucet Handlers (MockERC20 Mint)
const ERC20_FAUCET_ABI = [
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address account) external view returns (uint256)"
];

function setupFaucetHandlers() {
  document.getElementById("vaultMintT0Btn")?.addEventListener("click", async () => {
    if (!STATE.isWalletConnected || !STATE.signer) {
      showToast("Please connect MetaMask to mint test tokens on Base Sepolia.", "warning");
      return;
    }
    try {
      showToast("Minting 1,000 T0 on Base Sepolia...", "info");
      const t0 = new ethers.Contract(STATE.token0Address, ERC20_FAUCET_ABI, STATE.signer);
      const tx = await t0.mint(STATE.walletAddress, ethers.parseEther("1000"));
      showToast(`Mint tx broadcasted: ${tx.hash.slice(0, 10)}... Confirming...`, "info");
      await tx.wait();
      showToast(`✅ Successfully minted 1,000 T0! <a href="https://sepolia.basescan.org/tx/${tx.hash}" target="_blank" style="color:#6ee7b7;text-decoration:underline;">BaseScan ↗</a>`, "success");
    } catch (err) {
      console.error("Mint T0 error:", err);
      showToast(`Mint failed: ${err.shortMessage || err.message}`, "warning");
    }
  });

  document.getElementById("vaultMintT1Btn")?.addEventListener("click", async () => {
    if (!STATE.isWalletConnected || !STATE.signer) {
      showToast("Please connect MetaMask to mint test tokens on Base Sepolia.", "warning");
      return;
    }
    try {
      showToast("Minting 1,000 T1 on Base Sepolia...", "info");
      const t1 = new ethers.Contract(STATE.token1Address, ERC20_FAUCET_ABI, STATE.signer);
      const tx = await t1.mint(STATE.walletAddress, ethers.parseEther("1000"));
      showToast(`Mint tx broadcasted: ${tx.hash.slice(0, 10)}... Confirming...`, "info");
      await tx.wait();
      showToast(`✅ Successfully minted 1,000 T1! <a href="https://sepolia.basescan.org/tx/${tx.hash}" target="_blank" style="color:#6ee7b7;text-decoration:underline;">BaseScan ↗</a>`, "success");
    } catch (err) {
      console.error("Mint T1 error:", err);
      showToast(`Mint failed: ${err.shortMessage || err.message}`, "warning");
    }
  });
}

// EIP-6963 Multi-Wallet Announcer (MetaMask Specific)
let detectedMetaMaskProvider = null;
window.addEventListener("eip6963:announceProvider", (event) => {
  const info = event.detail.info;
  if (info.rdns === "io.metamask" || info.name.toLowerCase().includes("metamask")) {
    detectedMetaMaskProvider = event.detail.provider;
    console.log("[Wallet] EIP-6963 MetaMask captured:", info.name);
  }
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

function getStrictMetaMaskProvider() {
  if (detectedMetaMaskProvider) return detectedMetaMaskProvider;

  if (typeof window.ethereum !== "undefined") {
    if (window.ethereum.providers && Array.isArray(window.ethereum.providers)) {
      const mm = window.ethereum.providers.find(p => p.isMetaMask && !p.isOkxWallet && !p.isPhantom);
      if (mm) return mm;
      const mmFallback = window.ethereum.providers.find(p => p.isMetaMask && !p.isOkxWallet);
      if (mmFallback) return mmFallback;
    }

    if (window.ethereum.isMetaMask && !window.ethereum.isOkxWallet) {
      return window.ethereum;
    }
  }
  return null;
}

// Wallet Handler (100% MetaMask Only)
function setupWalletHandler() {
  document.getElementById("connectWalletBtn")?.addEventListener("click", async () => {
    const rawProvider = getStrictMetaMaskProvider();

    if (!rawProvider) {
      if (typeof window.ethereum !== "undefined" && window.ethereum.isOkxWallet) {
        showToast("⚠️ OKX Wallet detected as default! Please set MetaMask as default in your extension settings.", "warning");
      } else {
        showToast("MetaMask extension not detected. Please install and unlock MetaMask.", "warning");
      }
      return;
    }

    try {
      showToast("Connecting to MetaMask...", "info");
      const provider = new ethers.BrowserProvider(rawProvider);
      const network = await provider.getNetwork();
      STATE.chainId = Number(network.chainId);

      // Switch or Add Base Sepolia (84532)
      if (STATE.chainId !== 84532) {
        try {
          await rawProvider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x14a34" }]
          });
        } catch (switchErr) {
          if (switchErr.code === 4902) {
            await rawProvider.request({
              method: "wallet_addEthereumChain",
              params: [{
                chainId: "0x14a34",
                chainName: "Base Sepolia",
                nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://sepolia.base.org"],
                blockExplorerUrls: ["https://sepolia.basescan.org"]
              }]
            });
          }
        }
      }

      const accounts = await rawProvider.request({ method: "eth_requestAccounts" });
      if (accounts && accounts.length > 0) {
        STATE.walletAddress = accounts[0];
        STATE.isWalletConnected = true;
        STATE.provider = provider;
        STATE.signer = await provider.getSigner();

        const balWei = await provider.getBalance(accounts[0]);
        STATE.ethBalance = parseFloat(ethers.formatEther(balWei)).toFixed(4);

        document.getElementById("walletBtnText").textContent =
          `${accounts[0].slice(0, 6)}...${accounts[0].slice(-4)} (${STATE.ethBalance} ETH)`;
        
        showToast(`Connected MetaMask on Base Sepolia: ${accounts[0].slice(0, 6)}...`, "success");
        updateTradeHashPreview();
        updateUI();
      }
    } catch (err) {
      console.error("MetaMask connection error:", err);
      showToast("MetaMask connection declined or cancelled.", "warning");
    }
  });
}

// Settings Handler
function setupSettingsHandler() {
  document.getElementById("settingsSaveContractsBtn")?.addEventListener("click", () => {
    STATE.hookAddress = document.getElementById("settingsHookAddress").value.trim();
    STATE.poolManagerAddress = document.getElementById("settingsPoolManagerAddress").value.trim();
    STATE.poolId = document.getElementById("settingsPoolId").value.trim();
    updateVaultDisplay();
    showToast("Contract configurations updated successfully.", "success");
  });
}

// Analytics Charts (Chart.js)
let volumeChartInstance = null;
let gasChartInstance = null;

function initAnalyticsCharts() {
  const volCtx = document.getElementById("volumeRoutingChart");
  if (volCtx) {
    if (volumeChartInstance) volumeChartInstance.destroy();
    volumeChartInstance = new Chart(volCtx, {
      type: "doughnut",
      data: {
        labels: ["Peer-to-Peer CoW Crossing", "Uniswap v4 AMM Fallback"],
        datasets: [{
          data: [84.2, 15.8],
          backgroundColor: ["#2563eb", "#f59e0b"],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: "bottom", labels: { color: "#94a3b8", font: { family: 'Inter' } } }
        }
      }
    });
  }

  const gasCtx = document.getElementById("gasSavingsChart");
  if (gasCtx) {
    if (gasChartInstance) gasChartInstance.destroy();
    gasChartInstance = new Chart(gasCtx, {
      type: "bar",
      data: {
        labels: ["Single Uniswap Swap", "Batch Settle (CoW)", "Batch Settle (AMM Fallback)"],
        datasets: [{
          label: "Gas Units",
          data: [135000, 48000, 78000],
          backgroundColor: ["#ef4444", "#10b981", "#6366f1"],
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: { ticks: { color: "#94a3b8" }, grid: { display: false } },
          y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(255,255,255,0.05)" } }
        }
      }
    });
  }
}

// Toast System
function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${type === 'success' ? '✅' : type === 'warning' ? '⚠️' : 'ℹ️'}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// ──── Onyx Cryptographic Proof Modal Engine ────
function showProofModal() {
  const overlay = document.getElementById("proofModalOverlay");
  const bar = document.getElementById("proofProgressBar");
  const linkBox = document.getElementById("proofModalTxLinkContainer");
  if (!overlay) return;
  overlay.classList.add("active");
  if (linkBox) linkBox.style.display = "none";
  if (bar) bar.style.width = "20%";
  for (let i = 1; i <= 5; i++) {
    const el = document.getElementById(`proofStep${i}`);
    if (el) {
      el.className = "proof-step-item" + (i === 1 ? " active" : "");
    }
  }
}

function updateProofStep(step, pct) {
  const bar = document.getElementById("proofProgressBar");
  if (bar) bar.style.width = `${pct}%`;
  for (let i = 1; i <= 5; i++) {
    const el = document.getElementById(`proofStep${i}`);
    if (el) {
      if (i < step) el.className = "proof-step-item done";
      else if (i === step) el.className = "proof-step-item active";
      else el.className = "proof-step-item";
    }
  }
}

function finishProofModal(txHash) {
  updateProofStep(5, 100);
  const step5 = document.getElementById("proofStep5");
  if (step5) step5.className = "proof-step-item done";
  const linkBox = document.getElementById("proofModalTxLinkContainer");
  const link = document.getElementById("proofModalBaseScanLink");
  if (linkBox && link) {
    link.href = `https://sepolia.basescan.org/tx/${txHash}`;
    linkBox.style.display = "block";
  }
}

// ──── Onyx Theme Switcher Engine ────
function setupThemeHandler() {
  const themes = ["obsidian", "shadow", "cobalt"];
  let currentTheme = localStorage.getItem("commitswap_theme") || "obsidian";
  
  function applyTheme(theme) {
    const label = document.getElementById("themeToggleLabel");
    if (theme === "obsidian") {
      document.documentElement.removeAttribute("data-design-theme");
      if (label) label.textContent = "Obsidian";
    } else if (theme === "shadow") {
      document.documentElement.setAttribute("data-design-theme", "shadow");
      if (label) label.textContent = "Shadow";
    } else if (theme === "cobalt") {
      document.documentElement.setAttribute("data-design-theme", "cobalt");
      if (label) label.textContent = "Cobalt";
    }
    localStorage.setItem("commitswap_theme", theme);
  }

  applyTheme(currentTheme);

  document.getElementById("themeToggleBtn")?.addEventListener("click", () => {
    const nextIdx = (themes.indexOf(currentTheme) + 1) % themes.length;
    currentTheme = themes[nextIdx];
    applyTheme(currentTheme);
    showToast(`Onyx theme switched to: ${currentTheme.toUpperCase()}`, "info");
  });
}

// ──── Onyx Quick Percent Buttons & Modal Closer ────
function setupQuickPctHandler() {
  document.querySelectorAll(".pct-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const pct = parseFloat(btn.getAttribute("data-pct"));
      const balance = 1000.0;
      const calculated = ((balance * pct) / 100).toFixed(1);
      const input = document.getElementById("tradeInputAmountIn");
      if (input) {
        input.value = calculated;
        updateTradeHashPreview();
      }
    });
  });

  document.getElementById("proofModalCloseBtn")?.addEventListener("click", () => {
    document.getElementById("proofModalOverlay")?.classList.remove("active");
  });

  document.getElementById("proofModalOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "proofModalOverlay") {
      document.getElementById("proofModalOverlay").classList.remove("active");
    }
  });
}
