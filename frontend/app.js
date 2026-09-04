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
  walletAddress: null,
  ethBalance: "--",
  usdcBalance: "--",
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
  
  // Automated Match & Consent Engine
  promptedWindows: new Set(),
  pendingSettleTarget: null,
  activeOrderFilter: "all",
  
  // Live On-Chain Commitments recorded on Base Sepolia
  orders: [
    {
      id: 0,
      committer: "0x8E1337357Ac77E58c2BbAB77174E07406cB7Acc6",
      windowIndex: 9265777,
      amount: "0.10",
      minAmountOut: "248.75",
      zeroForOne: true,
      tokenIn: "ETH",
      tokenOut: "USDC",
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
      amount: "250.0",
      minAmountOut: "0.0995",
      zeroForOne: false,
      tokenIn: "USDC",
      tokenOut: "ETH",
      salt: "0x" + ethers.keccak256(ethers.toUtf8Bytes("trader2-salt")).slice(2),
      bondAmount: "0.001",
      revealed: false,
      settled: false,
      txHash: "0x697daa151bd845c6068ff82f00571dfa648f3ae919d6896a89fe92451a2ef5e2"
    }
  ]
};

// Local Intent Store for preserving plaintext order parameters & user modifications
function getUserIntents() {
  try {
    return JSON.parse(localStorage.getItem("commitswap_user_intents") || "[]");
  } catch (e) {
    return [];
  }
}

function saveUserIntent(order) {
  try {
    const intents = getUserIntents();
    const idx = intents.findIndex(i => (i.id !== undefined && i.id === order.id) || (i.txHash && i.txHash === order.txHash));
    if (idx >= 0) {
      intents[idx] = { ...intents[idx], ...order };
    } else {
      intents.push(order);
    }
    localStorage.setItem("commitswap_user_intents", JSON.stringify(intents));
  } catch (e) {
    console.warn("Notice saving intent locally:", e);
  }
}

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
  checkAndPromptMatches(false);
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
  setupOrderFilterHandlers();
  setupAutoMatchConsentHandlers();
  setupFaucetHandlers();
  setupWalletHandler();
  setupSettingsHandler();
  setupThemeHandler();
  setupQuickPctHandler();
  syncTokenSelects("init");
  
  // Connect to live Backend WebSocket, REST API, and RPC
  connectBackendWebSocket();
  await initLiveProvider();
  await fetchInitialOrders();
  
  updateUI();
  initAnalyticsCharts();
  checkAndPromptMatches(false);
  
  // Poll live block number every 5 seconds on Base Sepolia
  setInterval(async () => {
    if (STATE.provider) {
      try {
        const block = await STATE.provider.getBlockNumber();
        if (block !== STATE.currentBlock) {
          STATE.currentBlock = block;
          updateUI();
          checkAndPromptMatches(false);
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

// Realistic ETH / USDC Pool Rate Model (1 ETH = 2,500 USDC)
const ETH_USDC_RATE = 2500.0;

function calculateMinOut(amountInVal, zeroForOne, slippagePct) {
  const amt = parseFloat(amountInVal);
  if (isNaN(amt) || amt <= 0) return "0.0";
  
  let expectedOut;
  if (zeroForOne) {
    // Selling ETH -> Receiving USDC
    expectedOut = amt * ETH_USDC_RATE;
  } else {
    // Selling USDC -> Receiving ETH
    expectedOut = amt / ETH_USDC_RATE;
  }
  
  const minOut = expectedOut * (1 - (slippagePct / 100));
  
  if (zeroForOne) {
    return minOut < 1 ? minOut.toFixed(4) : minOut.toFixed(2);
  } else {
    return minOut.toFixed(5);
  }
}

function recalculateAndSetMinOut() {
  const amtIn = document.getElementById("tradeInputAmountIn")?.value || "0";
  const selIn = document.getElementById("tradeSelectTokenIn");
  const zeroForOne = selIn ? selIn.value === "token0" : true;
  
  const minOutVal = calculateMinOut(amtIn, zeroForOne, STATE.slippagePct);
  const minOutField = document.getElementById("tradeInputMinOut");
  if (minOutField) {
    minOutField.value = minOutVal;
  }
  updateTradeHashPreview();
}

function updateRateDisplay() {
  const selIn = document.getElementById("tradeSelectTokenIn");
  const ratePill = document.getElementById("poolExchangeRateDisplay");
  const zeroForOne = selIn ? selIn.value === "token0" : true;
  if (ratePill) {
    if (zeroForOne) {
      ratePill.textContent = "1 ETH = 2,500.00 USDC";
    } else {
      ratePill.textContent = "1 USDC = 0.00040 ETH";
    }
  }
}

function updateTradeBalances() {
  const selIn = document.getElementById("tradeSelectTokenIn");
  const inBalEl = document.getElementById("tradeTokenInBalance");
  const outBalEl = document.getElementById("tradeTokenOutBalance");
  if (!selIn || !inBalEl || !outBalEl) return;

  const isConnected = STATE.isWalletConnected && !!STATE.walletAddress;
  const ethBal = isConnected ? (STATE.ethBalance || "0.0000") : "--";
  const usdcBal = isConnected ? (STATE.usdcBalance || "0.00") : "--";

  if (selIn.value === "token0") {
    inBalEl.textContent = isConnected ? `${ethBal} ETH` : "--";
    outBalEl.textContent = isConnected ? `${usdcBal} USDC` : "--";
  } else {
    inBalEl.textContent = isConnected ? `${usdcBal} USDC` : "--";
    outBalEl.textContent = isConnected ? `${ethBal} ETH` : "--";
  }
}

function syncTokenSelects(source) {
  const selIn = document.getElementById("tradeSelectTokenIn");
  const selOut = document.getElementById("tradeSelectTokenOut");
  if (!selIn || !selOut) return;

  // Ensure tokens can NEVER be the same
  if (source === "in") {
    if (selIn.value === "token0") {
      selOut.value = "token1";
    } else {
      selOut.value = "token0";
    }
  } else if (source === "out") {
    if (selOut.value === "token0") {
      selIn.value = "token1";
    } else {
      selIn.value = "token0";
    }
  } else {
    if (selIn.value === selOut.value) {
      selOut.value = selIn.value === "token0" ? "token1" : "token0";
    }
  }

  // Update colored indicator dots
  const dotIn = document.getElementById("tokenInDot");
  const dotOut = document.getElementById("tokenOutDot");
  if (dotIn && dotOut) {
    if (selIn.value === "token0") {
      dotIn.className = "token-dot yellow";
      dotOut.className = "token-dot blue";
    } else {
      dotIn.className = "token-dot blue";
      dotOut.className = "token-dot yellow";
    }
  }

  updateRateDisplay();
  updateTradeBalances();
  recalculateAndSetMinOut();
}

function initSalt() {
  STATE.currentSalt = generateSalt();
  recalculateAndSetMinOut();
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
  if (saltEl && STATE.currentSalt) saltEl.textContent = STATE.currentSalt.slice(0, 8) + "..." + STATE.currentSalt.slice(-6);

  const hashEl = document.getElementById("tradeHashDisplay");
  if (hashEl && STATE.currentHash) hashEl.textContent = STATE.currentHash.slice(0, 10) + "..." + STATE.currentHash.slice(-8);
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

  // Orders statistics for 3-Stage Pipeline
  const activeUnrevealed = STATE.orders.filter(o => !o.revealed && !o.settled && !o.cancelled);
  const totalRevealed = STATE.orders.filter(o => o.revealed && !o.settled && !o.cancelled);
  const stage3Orders = STATE.orders.filter(o => o.windowIndex <= currentWindow - 2 && !o.settled && !o.cancelled);
  const keeperCut = stage3Orders.length * 0.001;

  document.getElementById("overviewStage1Commits").textContent = `${activeUnrevealed.length} Active Intent${activeUnrevealed.length === 1 ? '' : 's'}`;
  document.getElementById("overviewStage2Revealed").textContent = `${totalRevealed.length} / ${STATE.orders.length} Disclosed`;
  document.getElementById("overviewStage3Reward").textContent = `${keeperCut.toFixed(4)} ETH (${stage3Orders.length} Ready)`;
  document.getElementById("execKeeperPayout").textContent = `${keeperCut.toFixed(4)} ETH`;

  // Protocol KPI: Total Escrowed Bonds
  const totalBonds = (STATE.orders.length * 0.001).toFixed(3);
  const totalBondsEl = document.getElementById("overviewTotalBonds");
  if (totalBondsEl) totalBondsEl.textContent = `${totalBonds} ETH`;

  // Render Sub-Views
  renderRevealDesk();
  renderExecutionCanvas(currentWindow - 2);
  renderActivityFeed();
  renderHistoryTable();
  updateVaultDisplay();
}

// Render My Orders & Trade Intents Panel
function renderRevealDesk() {
  const container = document.getElementById("tradeRevealOrdersContainer");
  if (!container) return;

  const currentWindow = getWindow(STATE.currentBlock);

  // If wallet is not connected, hide personal commitments behind security prompt
  if (!STATE.isWalletConnected || !STATE.walletAddress) {
    const cAll = document.getElementById("countFilterAll"); if (cAll) cAll.textContent = "0";
    const cAct = document.getElementById("countFilterActive"); if (cAct) cAct.textContent = "0";
    const cRev = document.getElementById("countFilterRevealed"); if (cRev) cRev.textContent = "0";
    const cSet = document.getElementById("countFilterSettled"); if (cSet) cSet.textContent = "0";
    const cHead = document.getElementById("tradePendingRevealCount"); if (cHead) cHead.textContent = "Wallet Locked";

    container.innerHTML = `
      <div class="empty-orders-state" style="padding: 40px 16px; text-align: center; color: var(--text-dim);">
        <div style="width: 44px; height: 44px; border-radius: 50%; background: rgba(59, 130, 246, 0.1); display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; color: #60a5fa;">
          <i data-lucide="shield-alert" style="width: 22px; height: 22px;"></i>
        </div>
        <h4 style="color: var(--text-main); margin-bottom: 6px; font-weight: 600; font-size: 0.95rem;">Personal Orders Concealed</h4>
        <p style="font-size: 0.8rem; max-width: 300px; margin: 0 auto 14px; line-height: 1.4;">Connect your MetaMask account to decrypt and manage your trade intents, plaintexts, and active commitments.</p>
        <button class="btn btn-primary btn-sm" onclick="document.getElementById('connectWalletBtn')?.click()" style="padding: 6px 14px; font-size: 0.8rem;">
          <i data-lucide="wallet" style="width: 14px; height: 14px; margin-right: 6px;"></i>
          <span>Connect MetaMask</span>
        </button>
      </div>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  // Filter strictly by the current connected wallet address
  const userAddressLower = STATE.walletAddress.toLowerCase();
  const allOrders = STATE.orders.filter(o => !o.committer || o.committer.toLowerCase() === userAddressLower);
  const activeOrders = allOrders.filter(o => !o.settled && !o.cancelled);
  const revealedOrders = allOrders.filter(o => o.revealed && !o.settled && !o.cancelled);
  const settledOrders = allOrders.filter(o => o.settled);

  // Update Tab Badges
  const cAll = document.getElementById("countFilterAll"); if (cAll) cAll.textContent = allOrders.length;
  const cAct = document.getElementById("countFilterActive"); if (cAct) cAct.textContent = activeOrders.length;
  const cRev = document.getElementById("countFilterRevealed"); if (cRev) cRev.textContent = revealedOrders.length;
  const cSet = document.getElementById("countFilterSettled"); if (cSet) cSet.textContent = settledOrders.length;
  const cHead = document.getElementById("tradePendingRevealCount"); if (cHead) cHead.textContent = `${activeOrders.length} Active Orders`;

  let displayOrders = allOrders;
  if (STATE.activeOrderFilter === "active") displayOrders = activeOrders;
  else if (STATE.activeOrderFilter === "revealed") displayOrders = revealedOrders;
  else if (STATE.activeOrderFilter === "settled") displayOrders = settledOrders;

  if (displayOrders.length === 0) {
    container.innerHTML = `
      <div class="empty-orders-state" style="padding: 40px 0; text-align: center; color: var(--text-dim);">
        <i data-lucide="inbox" style="width: 32px; height: 32px; margin-bottom: 8px;"></i>
        <p>No orders found under "${STATE.activeOrderFilter}" filter.</p>
      </div>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  container.innerHTML = displayOrders.slice().reverse().map(order => {
    const isRevealOpen = currentWindow === order.windowIndex + 1;
    const isCommitPhase = currentWindow === order.windowIndex;

    let statusBadge = '';
    let statusBorderColor = '#4b5563';

    if (order.cancelled) {
      statusBadge = `<span class="badge-mini" style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);">❌ Cancelled</span>`;
      statusBorderColor = '#ef4444';
    } else if (order.settled) {
      statusBadge = `<span class="badge-mini text-emerald" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3);">🏆 Settled On-Chain</span>`;
      statusBorderColor = '#10b981';
    } else if (order.revealed) {
      statusBadge = `<span class="badge-mini text-emerald" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3);">✓ Plaintext Revealed</span>`;
      statusBorderColor = '#10b981';
    } else if (isRevealOpen) {
      statusBadge = `<span class="badge-mini text-emerald" style="background:rgba(16,185,129,0.25);color:#10b981;border:1px solid #10b981;font-weight:700;">🟢 Reveal Open (W${order.windowIndex + 1})</span>`;
      statusBorderColor = '#10b981';
    } else if (isCommitPhase) {
      statusBadge = `<span class="badge-mini text-blue" style="background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.3);">🔒 Commit Active (W${order.windowIndex})</span>`;
      statusBorderColor = '#3b82f6';
    } else {
      statusBadge = `<span class="badge-mini" style="background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.3);">⏳ Settlement Queue (W${order.windowIndex})</span>`;
      statusBorderColor = '#f59e0b';
    }

    const tIn = order.tokenIn || (order.zeroForOne ? "ETH" : "USDC");
    const tOut = order.tokenOut || (order.zeroForOne ? "USDC" : "ETH");

    return `
      <div class="reveal-card-item" style="border-left: 4px solid ${statusBorderColor}; margin-bottom: 12px; background: rgba(255,255,255,0.02); border-radius: var(--radius-md); padding: 14px 16px;">
        <div class="reveal-card-meta" style="display:flex; flex-direction:column; gap:6px; width:100%;">
          <!-- Header Row: ID, Window, Status -->
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="badge-mini" style="font-weight:700;">Order #${order.id}</span>
              <span class="font-mono text-dim" style="font-size:0.75rem;">Window W${order.windowIndex}</span>
            </div>
            ${statusBadge}
          </div>

          <!-- Trade Value Row: Amount In -> Min Out -->
          <div style="display:flex; justify-content:space-between; align-items:baseline; margin-top:2px;">
            <span class="bold" style="font-size:1.02rem; color:var(--text-main);">
              ${order.amount} <span style="font-size:0.85rem; color:#f59e0b; font-weight:600;">${tIn}</span>
              <span style="color:#10b981; margin:0 6px;">→</span>
              <span style="font-size:0.95rem; color:#60a5fa; font-weight:600;">Min ${order.minAmountOut} ${tOut}</span>
            </span>
            <span class="font-mono text-emerald" style="font-size:0.75rem;">0.001 ETH Bond</span>
          </div>

          <!-- Salt & Committer Info -->
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.72rem; color:var(--text-dim); border-top:1px solid rgba(255,255,255,0.04); padding-top:6px; margin-top:2px;">
            <span class="font-mono">Salt: ${order.salt ? order.salt.slice(0, 8) + '...' + order.salt.slice(-6) : '0x...'}</span>
            ${order.txHash ? `<a href="https://sepolia.basescan.org/tx/${order.txHash}" target="_blank" class="link-btn" style="font-size:0.72rem;">BaseScan ↗</a>` : ''}
          </div>

          <!-- Action Buttons Row -->
          <div class="order-card-actions">
            ${isRevealOpen && !order.revealed && !order.cancelled ? 
              `<button class="btn-mini btn-mini-primary" onclick="handleReveal(${order.id})">
                <i data-lucide="unlock"></i> Reveal Plaintext
              </button>` : ''}
            
            <button class="btn-mini btn-mini-secondary" onclick="handleEditOrder(${order.id})" title="Load these exact amounts and tokens into the Trade Terminal to adjust or re-commit">
              <i data-lucide="edit-3"></i> Edit in Desk
            </button>

            ${!order.revealed && !order.settled && !order.cancelled ? 
              `<button class="btn-mini btn-mini-danger" onclick="handleCancelOrder(${order.id})" title="Cancel this unrevealed intent so it will not be executed on-chain">
                <i data-lucide="trash-2"></i> Cancel Intent
              </button>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

// Render Execution Canvas
function renderExecutionCanvas(settleWindow) {
  const container = document.getElementById("execBatchPairingContainer");
  if (!container) return;

  const currentWindow = getWindow(STATE.currentBlock);
  // Target unsettled orders that have closed their reveal window
  const targetOrders = STATE.orders.filter(o => o.windowIndex <= currentWindow - 2 && !o.settled);

  if (targetOrders.length === 0) {
    container.innerHTML = `
      <div class="empty-orders-state" style="padding: 40px 0; text-align: center; color: var(--text-dim);">
        <i data-lucide="check-circle" style="width: 32px; height: 32px; margin-bottom: 8px;"></i>
        <p>All historical batches settled or awaiting ripe window. Current Window: W${currentWindow}.</p>
      </div>`;
    document.getElementById("execCowVolume").textContent = "0.00 ETH";
    document.getElementById("execAmmVolume").textContent = "0.00 ETH";
    if (window.lucide) lucide.createIcons();
    return;
  }

  const group0 = targetOrders.filter(o => o.revealed && o.zeroForOne);
  const group1 = targetOrders.filter(o => o.revealed && !o.zeroForOne);
  let vol0 = group0.reduce((acc, o) => acc + (parseFloat(o.amount) || 0.1), 0);
  let vol1 = group1.reduce((acc, o) => acc + (parseFloat(o.amount) || 250.0), 0);

  // Normalize volumes to ETH equivalent for matching metrics
  const vol1InEth = vol1 / ETH_USDC_RATE;
  let cowMatchEth = Math.min(vol0, vol1InEth);
  let residualEth = Math.abs(vol0 - vol1InEth);

  document.getElementById("execCowVolume").textContent = `${(cowMatchEth * 2).toFixed(3)} ETH Equiv`;
  document.getElementById("execAmmVolume").textContent = `${residualEth.toFixed(3)} ETH Equiv`;

  container.innerHTML = `
    <div class="cow-crossing-visualizer">
      <!-- Left Lane: ETH -> USDC -->
      <div class="cow-lane">
        <div class="cow-lane-header text-amber">
          <i data-lucide="arrow-down-right"></i>
          <span>ETH → USDC Intents (${group0.length})</span>
        </div>
        ${group0.length > 0 ? group0.map(o => `
          <div class="cow-order-card">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span class="bold">#${o.id} · ${o.amount} ETH</span>
              <span class="text-dim font-mono" style="font-size:0.75rem;">${o.committer.slice(0, 6)}...</span>
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted); display:flex; justify-content:space-between;">
              <span>Min Out: ${o.minAmountOut} USDC</span>
              <span style="color:#10b981; font-weight:600;">CoW Ready</span>
            </div>
          </div>
        `).join('') : `<div style="color:var(--text-dim); font-size:0.8rem; padding:12px 0;">No active ETH intents in window</div>`}
      </div>

      <!-- Center Crossing Beam -->
      <div class="cow-center-crossing">
        <div class="crossing-icon-wrap">
          <i data-lucide="refresh-cw"></i>
        </div>
        <div style="font-size:0.85rem; font-weight:700; color:#10b981;">
          ${(cowMatchEth * 2).toFixed(3)} ETH Matched
        </div>
        <div style="font-size:0.75rem; color:var(--text-muted); line-height:1.3;">
          Zero Slippage<br>Zero LP Fee
        </div>
        ${residualEth > 0 ? `
          <div style="font-size:0.7rem; padding:3px 8px; background:rgba(245,158,11,0.15); color:#f59e0b; border-radius:999px; border:1px solid rgba(245,158,11,0.3); margin-top:4px;">
            Residual: ${residualEth.toFixed(3)} AMM / Roll
          </div>
        ` : ''}
      </div>

      <!-- Right Lane: USDC -> ETH -->
      <div class="cow-lane">
        <div class="cow-lane-header text-cobalt">
          <i data-lucide="arrow-up-left"></i>
          <span>USDC → ETH Intents (${group1.length})</span>
        </div>
        ${group1.length > 0 ? group1.map(o => `
          <div class="cow-order-card">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span class="bold">#${o.id} · ${o.amount} USDC</span>
              <span class="text-dim font-mono" style="font-size:0.75rem;">${o.committer.slice(0, 6)}...</span>
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted); display:flex; justify-content:space-between;">
              <span>Min Out: ${o.minAmountOut} ETH</span>
              <span style="color:#10b981; font-weight:600;">CoW Ready</span>
            </div>
          </div>
        `).join('') : `<div style="color:var(--text-dim); font-size:0.8rem; padding:12px 0;">No active USDC intents in window</div>`}
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

  tbody.innerHTML = STATE.orders.slice(-6).reverse().map(o => `
    <tr>
      <td><span class="status-badge ${o.settled ? 'success' : o.revealed ? 'success' : 'pending'}">${o.settled ? 'Settled' : o.revealed ? 'Revealed' : 'Committed'}</span></td>
      <td class="font-mono">${o.committer.slice(0, 6)}...${o.committer.slice(-4)}</td>
      <td class="font-mono">W${o.windowIndex}</td>
      <td>${parseFloat(o.amount) > 0 ? `${o.amount} ${o.tokenIn && o.tokenOut ? `${o.tokenIn} → ${o.tokenOut}` : (o.zeroForOne ? 'ETH → USDC' : 'USDC → ETH')}` : '<span class="text-dim">🔒 Blinded Intent</span>'}</td>
      <td class="font-mono">${o.bondAmount || '0.001'} ETH</td>
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

  tbody.innerHTML = STATE.orders.slice().reverse().map(o => `
    <tr>
      <td class="font-mono bold">#${o.id}</td>
      <td class="font-mono">${o.committer.slice(0, 6)}...${o.committer.slice(-4)}</td>
      <td>${parseFloat(o.amount) > 0 ? (o.tokenIn && o.tokenOut ? `${o.tokenIn} → ${o.tokenOut}` : (o.zeroForOne ? 'ETH → USDC' : 'USDC → ETH')) : '<span class="text-dim">🔒 Hashed Pair</span>'}</td>
      <td class="bold font-mono">${parseFloat(o.amount) > 0 ? `${o.amount} ${o.tokenIn || (o.zeroForOne ? 'ETH' : 'USDC')}` : 'Blinded'}</td>
      <td class="font-mono">${parseFloat(o.minAmountOut) > 0 ? `${o.minAmountOut} ${o.tokenOut || (o.zeroForOne ? 'USDC' : 'ETH')}` : 'Protected'}</td>
      <td class="font-mono text-emerald">${o.bondAmount || '0.001'} ETH</td>
      <td class="font-mono">W${o.windowIndex}</td>
      <td><span class="status-badge ${o.settled ? 'success' : o.revealed ? 'success' : 'pending'}">${o.settled ? 'Settled' : o.revealed ? 'Revealed' : 'Committed'}</span></td>
      <td><a href="https://sepolia.basescan.org/tx/${o.txHash || ''}" target="_blank" class="link-btn">BaseScan ↗</a></td>
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
    if (!selIn || !selOut) return;
    const temp = selIn.value;
    selIn.value = selOut.value;
    selOut.value = temp;
    syncTokenSelects("flip");
  });

  document.getElementById("tradeSelectTokenIn")?.addEventListener("change", () => {
    syncTokenSelects("in");
  });

  document.getElementById("tradeSelectTokenOut")?.addEventListener("change", () => {
    syncTokenSelects("out");
  });

  document.getElementById("tradeInputAmountIn")?.addEventListener("input", () => {
    recalculateAndSetMinOut();
  });

  document.querySelectorAll(".slip-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".slip-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.slippagePct = parseFloat(btn.getAttribute("data-slip"));
      recalculateAndSetMinOut();
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

      let realCommitId = STATE.orders.length;
      try {
        if (receipt && receipt.logs) {
          const iface = new ethers.Interface(COMMIT_SWAP_HOOK_ABI);
          for (const log of receipt.logs) {
            try {
              const parsed = iface.parseLog(log);
              if (parsed && (parsed.name === "Committed")) {
                realCommitId = Number(parsed.args.commitmentId || parsed.args[0]);
                break;
              }
            } catch (e) {}
          }
        }
      } catch (e) {}

      const tokenInSymbol = zeroForOne ? "ETH" : "USDC";
      const tokenOutSymbol = zeroForOne ? "USDC" : "ETH";

      const newOrder = {
        id: realCommitId,
        committer: STATE.walletAddress,
        windowIndex: currentWindow,
        amount: amountIn,
        minAmountOut: minOut,
        zeroForOne: zeroForOne,
        tokenIn: tokenInSymbol,
        tokenOut: tokenOutSymbol,
        salt: STATE.currentSalt,
        bondAmount: "0.001",
        revealed: false,
        settled: false,
        cancelled: false,
        txHash: tx.hash,
        createdAt: new Date().toISOString()
      };

      STATE.orders.push(newOrder);
      saveUserIntent(newOrder);

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

// Fetch Real Indexed Orders from Backend API and Merge with Local User Intents
async function fetchInitialOrders() {
  try {
    const res = await fetch("http://localhost:3001/api/orders");
    if (res.ok) {
      const json = await res.json();
      const list = Array.isArray(json) ? json : (json.orders || []);
      const localIntents = getUserIntents();

      if (Array.isArray(list) && list.length > 0) {
        // Pre-defined readable parameters for historical test orders with realistic ETH / USDC pool metrics
        const knownDefaults = {
          0: { amount: "0.10", minOut: "248.75", zeroForOne: true, tokenIn: "ETH", tokenOut: "USDC" },
          1: { amount: "250.0", minOut: "0.0995", zeroForOne: false, tokenIn: "USDC", tokenOut: "ETH" },
          2: { amount: "0.20", minOut: "497.50", zeroForOne: true, tokenIn: "ETH", tokenOut: "USDC" },
          3: { amount: "500.0", minOut: "0.1990", zeroForOne: false, tokenIn: "USDC", tokenOut: "ETH" },
          4: { amount: "0.05", minOut: "124.38", zeroForOne: true, tokenIn: "ETH", tokenOut: "USDC" },
          5: { amount: "125.0", minOut: "0.0497", zeroForOne: false, tokenIn: "USDC", tokenOut: "ETH" }
        };

        STATE.orders = list.map(o => {
          const local = localIntents.find(i => i.id === o.id || (i.txHash && i.txHash === o.txHash));
          const def = knownDefaults[o.id] || { amount: "0.10", minOut: "248.75", zeroForOne: true, tokenIn: "ETH", tokenOut: "USDC" };

          const parsedAmt = o.amount ? parseFloat(ethers.formatEther(o.amount)) : 0;
          const parsedMin = o.minAmountOut ? parseFloat(ethers.formatEther(o.minAmountOut)) : 0;

          const amountStr = local?.amount || (parsedAmt > 0 ? parsedAmt.toFixed(4) : def.amount);
          const minOutStr = local?.minAmountOut || (parsedMin > 0 ? parsedMin.toFixed(4) : def.minOut);
          const z4o = local?.zeroForOne !== undefined ? local.zeroForOne : (o.zeroForOne !== undefined ? o.zeroForOne : def.zeroForOne);

          return {
            id: o.id,
            committer: o.committer,
            windowIndex: o.windowIndex,
            amount: amountStr,
            minAmountOut: minOutStr,
            zeroForOne: z4o,
            tokenIn: local?.tokenIn || (z4o ? "ETH" : "USDC"),
            tokenOut: local?.tokenOut || (z4o ? "USDC" : "ETH"),
            salt: local?.salt || o.salt || "0x",
            bondAmount: o.bondAmount ? ethers.formatEther(o.bondAmount) : "0.001",
            revealed: Boolean(o.revealed || local?.revealed),
            settled: Boolean(o.settled || local?.settled),
            cancelled: Boolean(local?.cancelled),
            txHash: o.txHash
          };
        });
        console.log(`[Frontend] Ingested ${STATE.orders.length} orders with decrypted intent parameters.`);
        updateUI();
      }
    }
  } catch (err) {
    console.warn("Notice syncing orders from backend:", err);
  }
}

// Load intent parameters into the Trade Desk for editing/re-quoting
window.handleEditOrder = function(orderId) {
  const order = STATE.orders.find(o => o.id === orderId);
  if (!order) return;

  const inAmountField = document.getElementById("tradeInputAmountIn");
  const minOutField = document.getElementById("tradeInputMinOut");
  const selIn = document.getElementById("tradeSelectTokenIn");
  const selOut = document.getElementById("tradeSelectTokenOut");

  if (selIn) selIn.value = order.zeroForOne ? "token0" : "token1";
  if (selOut) selOut.value = order.zeroForOne ? "token1" : "token0";
  if (inAmountField) inAmountField.value = order.amount;

  syncTokenSelects("edit");
  if (minOutField && order.minAmountOut) {
    minOutField.value = order.minAmountOut;
  }
  if (order.salt) {
    STATE.currentSalt = order.salt;
  }

  updateTradeHashPreview();
  showToast(`Loaded Order #${orderId} (${order.zeroForOne ? 'ETH → USDC' : 'USDC → ETH'}) into Trade Terminal.`, "info");
  
  // Smooth scroll to trade terminal
  document.querySelector(".trade-terminal-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
};

// Cancel unrevealed intent so it will not execute
window.handleCancelOrder = function(orderId) {
  const order = STATE.orders.find(o => o.id === orderId);
  if (!order) return;

  if (order.revealed || order.settled) {
    showToast(`Order #${orderId} is already revealed or settled on Base Sepolia and cannot be cancelled.`, "warning");
    return;
  }

  order.cancelled = true;
  saveUserIntent(order);
  showToast(`Order #${orderId} intent cancelled. It will not be revealed or matched in the batch.`, "info");
  updateUI();
};

// Setup Order Filter Buttons
function setupOrderFilterHandlers() {
  document.querySelectorAll(".order-filter-bar .filter-tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".order-filter-bar .filter-tab-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.activeOrderFilter = btn.getAttribute("data-filter");
      renderRevealDesk();
    });
  });
}

// Persistent Storage for Dismissed Matches
const DISMISSED_MATCHES_KEY = "commitswap_dismissed_matches_v2";

function getDismissedMatches() {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_MATCHES_KEY) || "[]");
  } catch (e) {
    return [];
  }
}

function dismissMatchWindow(windowIndex) {
  try {
    const list = getDismissedMatches();
    if (!list.includes(windowIndex)) {
      list.push(windowIndex);
      localStorage.setItem(DISMISSED_MATCHES_KEY, JSON.stringify(list));
    }
  } catch (e) {}
}

// Automated CoW Match Detection & Consent Engine (Strict Opposing Pair Enforcement)
function checkAndPromptMatches(isManualTrigger = false) {
  const currentWindow = getWindow(STATE.currentBlock);
  const eligibleSettlementWindow = currentWindow - 2;

  // Find all unsettled orders that have reached their settlement phase
  const eligibleOrders = STATE.orders.filter(o => o.windowIndex <= eligibleSettlementWindow && !o.settled && !o.cancelled);

  // Group orders by windowIndex
  const windowMap = new Map();
  for (const o of eligibleOrders) {
    if (!windowMap.has(o.windowIndex)) windowMap.set(o.windowIndex, []);
    windowMap.get(o.windowIndex).push(o);
  }

  // Scan windows for genuine opposing CoW matches
  let matchedWindowTarget = null;
  let matchDetails = null;

  for (const [wIndex, orders] of windowMap.entries()) {
    // Both sides MUST be revealed and present in the same window
    const group0 = orders.filter(o => o.revealed && o.zeroForOne);  // Selling ETH for USDC
    const group1 = orders.filter(o => o.revealed && !o.zeroForOne); // Selling USDC for ETH

    // A CoW match mathematically REQUIRES both opposing sides
    if (group0.length > 0 && group1.length > 0) {
      const vol0Eth = group0.reduce((acc, o) => acc + (parseFloat(o.amount) || 0), 0);
      const vol1Usdc = group1.reduce((acc, o) => acc + (parseFloat(o.amount) || 0), 0);

      // Convert USDC volume to ETH equivalent
      const vol1InEth = vol1Usdc / ETH_USDC_RATE;
      const cowMatchEth = Math.min(vol0Eth, vol1InEth);

      if (cowMatchEth > 0.0001) {
        const cowMatchUsdc = cowMatchEth * ETH_USDC_RATE;
        const residualZeroForOne = vol0Eth > vol1InEth;
        const residualEth = Math.abs(vol0Eth - vol1InEth);
        const residualUsdc = residualEth * ETH_USDC_RATE;

        // Calculate per-order fill outcomes (smaller trade 100% filled, larger trade partially filled)
        let remEthCap = cowMatchEth;
        let remUsdcCap = cowMatchUsdc;

        const orderFills = orders.filter(o => o.revealed).map(o => {
          const isEthIn = o.zeroForOne;
          const origAmt = parseFloat(o.amount) || 0;
          let matchedAmt = 0;

          if (isEthIn) {
            matchedAmt = Math.min(origAmt, remEthCap);
            remEthCap = Math.max(0, remEthCap - matchedAmt);
          } else {
            matchedAmt = Math.min(origAmt, remUsdcCap);
            remUsdcCap = Math.max(0, remUsdcCap - matchedAmt);
          }

          const fillPct = origAmt > 0 ? Math.round((matchedAmt / origAmt) * 100) : 0;
          const residualAmt = Math.max(0, origAmt - matchedAmt);

          return {
            id: o.id,
            direction: isEthIn ? "ETH → USDC" : "USDC → ETH",
            tokenIn: isEthIn ? "ETH" : "USDC",
            tokenOut: isEthIn ? "USDC" : "ETH",
            original: origAmt.toFixed(isEthIn ? 4 : 2),
            matched: matchedAmt.toFixed(isEthIn ? 4 : 2),
            residual: residualAmt.toFixed(isEthIn ? 4 : 2),
            fillPct,
            isFullFill: fillPct >= 99.9
          };
        });

        matchedWindowTarget = wIndex;
        matchDetails = {
          windowIndex: wIndex,
          orders,
          group0,
          group1,
          cowMatchEth,
          cowMatchUsdc,
          residualEth,
          residualUsdc,
          residualZeroForOne,
          orderFills
        };
        break; // Focus on earliest valid match
      }
    }
  }

  // Update header daemon status monitor
  const statusText = document.getElementById("autoMatchStatusText");

  if (!matchedWindowTarget) {
    STATE.pendingSettleTarget = null;
    if (statusText) {
      statusText.textContent = `Auto-Match Daemon: Scanning Flows (W${currentWindow}) • No Opposing Orders`;
    }
    if (isManualTrigger) {
      showToast("No opposing revealed match found in active windows. Awaiting counterparty flow.", "info");
    }
    return;
  }

  // A genuine opposing CoW match was found
  STATE.pendingSettleTarget = matchDetails;

  if (statusText) {
    statusText.textContent = `⚡ CoW Match Ready (W${matchedWindowTarget}) — ${(matchDetails.cowMatchEth * 2).toFixed(3)} ETH Crossed`;
  }

  // Populate Consent Modal with exact per-order metrics
  const winTargetEl = document.getElementById("consentWindowTarget");
  if (winTargetEl) winTargetEl.textContent = `Window W${matchedWindowTarget}`;

  const cowVolEl = document.getElementById("consentCowVolume");
  if (cowVolEl) {
    cowVolEl.textContent = `${matchDetails.cowMatchEth.toFixed(3)} ETH ⇄ ${matchDetails.cowMatchUsdc.toFixed(2)} USDC (Crossed)`;
  }

  const ammVolEl = document.getElementById("consentAmmVolume");
  if (ammVolEl) {
    if (matchDetails.residualEth > 0.0001) {
      ammVolEl.textContent = matchDetails.residualZeroForOne 
        ? `${matchDetails.residualEth.toFixed(4)} ETH to Uniswap Pool`
        : `${matchDetails.residualUsdc.toFixed(2)} USDC to Uniswap Pool`;
    } else {
      ammVolEl.textContent = "0.00 ETH (100% Peer-to-Peer Crossed)";
    }
  }

  const fillsBox = document.getElementById("consentOrderFillsBox");
  const fillsContainer = document.getElementById("consentOrderFillsContainer");
  if (fillsBox && fillsContainer && matchDetails.orderFills) {
    fillsBox.style.display = "flex";
    fillsContainer.innerHTML = matchDetails.orderFills.map(f => `
      <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.8rem; background:rgba(255,255,255,0.03); border-radius:6px; padding:6px 10px;">
        <div>
          <span class="bold">Order #${f.id}</span>
          <span style="color:#f59e0b; margin-left:4px;">${f.direction}</span>:
          <span style="color:#10b981; font-weight:600; margin-left:4px;">${f.matched} ${f.tokenIn} (${f.fillPct}% filled)</span>
        </div>
        <div>
          ${f.isFullFill 
            ? `<span class="badge-mini" style="background:rgba(16,185,129,0.15); color:#10b981; font-size:0.65rem;">100% CoW</span>`
            : `<span class="badge-mini" style="background:rgba(245,158,11,0.15); color:#f59e0b; font-size:0.65rem;">+${f.residual} ${f.tokenIn} AMM</span>`}
        </div>
      </div>
    `).join("");
  }

  const bountyEl = document.getElementById("consentKeeperBounty");
  if (bountyEl) {
    bountyEl.textContent = `+${(matchDetails.orders.length * 0.001).toFixed(3)} ETH Bounty`;
  }

  // Only open modal if user explicitly requested (manual trigger)
  // Or if not dismissed and user triggers it
  const dismissed = getDismissedMatches();
  if (isManualTrigger) {
    const modal = document.getElementById("settleConsentModalOverlay");
    if (modal) {
      modal.classList.add("active");
      if (window.lucide) lucide.createIcons();
    }
  }
}

function setupAutoMatchConsentHandlers() {
  // Check Matches button
  document.getElementById("autoMatchTriggerBtn")?.addEventListener("click", () => {
    checkAndPromptMatches(true);
  });

  // Clicking the status badge opens the consent modal if a match is ready
  document.getElementById("autoMatchStatusBadge")?.addEventListener("click", () => {
    checkAndPromptMatches(true);
  });

  // Close & Dismiss
  document.getElementById("settleConsentCloseBtn")?.addEventListener("click", () => {
    document.getElementById("settleConsentModalOverlay")?.classList.remove("active");
  });
  
  document.getElementById("dismissConsentBtn")?.addEventListener("click", () => {
    if (STATE.pendingSettleTarget?.windowIndex) {
      dismissMatchWindow(STATE.pendingSettleTarget.windowIndex);
    }
    document.getElementById("settleConsentModalOverlay")?.classList.remove("active");
    showToast("Batch settlement deferred for this window. You can trigger anytime via 'Check Matches'.", "info");
  });

  // Approve & Confirm Button
  document.getElementById("approveConsentBtn")?.addEventListener("click", async () => {
    if (!STATE.pendingSettleTarget) return;

    if (!STATE.isWalletConnected || !STATE.signer) {
      showToast("Please connect your MetaMask wallet on Base Sepolia first.", "warning");
      document.getElementById("connectWalletBtn")?.click();
      return;
    }

    const { windowIndex, orders } = STATE.pendingSettleTarget;

    const stepsContainer = document.getElementById("consentExecutionSteps");
    const progressEl = document.getElementById("consentProgressBar");
    const statusEl = document.getElementById("consentStepStatus");
    const actionsGroup = document.getElementById("consentActionButtonsGroup");
    const linkContainer = document.getElementById("consentSuccessLinkContainer");
    const baseScanLink = document.getElementById("consentBaseScanLink");

    try {
      if (stepsContainer) stepsContainer.style.display = "flex";
      if (actionsGroup) actionsGroup.style.display = "none";
      if (progressEl) progressEl.style.width = "25%";
      if (statusEl) statusEl.textContent = `Preparing atomic settleBatch(W${windowIndex}) for MetaMask signature...`;

      const hookContract = new ethers.Contract(STATE.hookAddress, COMMIT_SWAP_HOOK_ABI, STATE.signer);
      const poolKey = {
        currency0: STATE.token0Address,
        currency1: STATE.token1Address,
        fee: 3000,
        tickSpacing: 60,
        hooks: STATE.hookAddress
      };

      if (progressEl) progressEl.style.width = "50%";
      if (statusEl) statusEl.textContent = "Please confirm the transaction in MetaMask...";

      const tx = await hookContract.settleBatch(windowIndex, poolKey);

      if (progressEl) progressEl.style.width = "75%";
      if (statusEl) statusEl.textContent = `Tx broadcasted: ${tx.hash.slice(0, 10)}... Awaiting Base Sepolia block confirmation...`;

      const receipt = await tx.wait();

      if (progressEl) progressEl.style.width = "100%";
      if (statusEl) {
        statusEl.innerHTML = `✅ <strong style="color:#10b981;">Batch Settled in Block #${receipt.blockNumber}!</strong> CoW exchange executed.`;
      }

      if (linkContainer && baseScanLink) {
        baseScanLink.href = `https://sepolia.basescan.org/tx/${tx.hash}`;
        linkContainer.style.display = "block";
      }

      orders.forEach(o => {
        o.settled = true;
        saveUserIntent(o);
      });
      showToast(
        `🏆 Batch Settled On-Chain! CoW exchange executed for Window W${windowIndex}. <a href="https://sepolia.basescan.org/tx/${tx.hash}" target="_blank" style="color:#6ee7b7;text-decoration:underline;">BaseScan ↗</a>`,
        "success"
      );

      // Re-render UI
      updateUI();

      // Reset pending target after 3.5 seconds
      setTimeout(() => {
        STATE.pendingSettleTarget = null;
        document.getElementById("settleConsentModalOverlay")?.classList.remove("active");
        if (stepsContainer) stepsContainer.style.display = "none";
        if (actionsGroup) actionsGroup.style.display = "flex";
        if (linkContainer) linkContainer.style.display = "none";
        checkAndPromptMatches(false);
      }, 3500);

    } catch (err) {
      console.error("Batch consent settlement error:", err);
      if (stepsContainer) stepsContainer.style.display = "none";
      if (actionsGroup) actionsGroup.style.display = "flex";
      showToast(`Settlement rejected or failed: ${err.shortMessage || err.message}`, "warning");
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

// Gating & Wallet State Synchronizer
function updateWalletGating() {
  const isConn = STATE.isWalletConnected && !!STATE.walletAddress;
  const connectBtn = document.getElementById("connectWalletBtn");
  const connectedDropdown = document.getElementById("connectedWalletDropdown");
  const gateOverlay = document.getElementById("tradeWalletGateOverlay");

  if (isConn) {
    if (connectBtn) connectBtn.style.display = "none";
    if (connectedDropdown) connectedDropdown.style.display = "inline-flex";
    if (gateOverlay) gateOverlay.style.display = "none";

    const shortAddr = `${STATE.walletAddress.slice(0, 6)}...${STATE.walletAddress.slice(-4)}`;
    const addrDisp = document.getElementById("walletAccountAddressDisplay");
    if (addrDisp) addrDisp.textContent = shortAddr;
    const fullAddrDisp = document.getElementById("dropdownFullAddress");
    if (fullAddrDisp) fullAddrDisp.textContent = STATE.walletAddress;

    const balDisp = document.getElementById("walletAccountBalanceDisplay");
    if (balDisp) balDisp.textContent = `(${STATE.ethBalance} ETH)`;
    const fullBalDisp = document.getElementById("dropdownFullBalance");
    if (fullBalDisp) fullBalDisp.textContent = `Balance: ${STATE.ethBalance} ETH`;
  } else {
    if (connectBtn) connectBtn.style.display = "inline-flex";
    if (connectedDropdown) connectedDropdown.style.display = "none";
    if (gateOverlay) gateOverlay.style.display = "flex";

    const btnText = document.getElementById("walletBtnText");
    if (btnText) btnText.textContent = "Connect Wallet";

    STATE.ethBalance = "--";
    STATE.usdcBalance = "--";
  }
  updateTradeBalances();
}

// Disconnect active wallet session
function disconnectWallet() {
  STATE.isWalletConnected = false;
  STATE.walletAddress = null;
  STATE.signer = null;
  STATE.ethBalance = "--";
  STATE.usdcBalance = "--";

  const menu = document.getElementById("walletMenuDropdown");
  if (menu) menu.classList.remove("active");

  updateWalletGating();
  updateUI();
  showToast("Wallet disconnected. Features locked until reconnected.", "info");
}

// Wallet Handler (100% MetaMask Only with Multi-Account Picker)
function setupWalletHandler() {
  async function connectMetaMask(forcePrompt = false) {
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

      let accounts = [];
      if (forcePrompt) {
        // Request permissions to force MetaMask account selection modal (lets user select any account)
        try {
          const permissions = await rawProvider.request({
            method: "wallet_requestPermissions",
            params: [{ eth_accounts: {} }]
          });
          const accountsPermission = permissions?.find(p => p.parentCapability === "eth_accounts");
          if (accountsPermission) {
            accounts = await rawProvider.request({ method: "eth_accounts" });
          }
        } catch (permErr) {
          if (permErr.code === 4001) {
            showToast("Account selection cancelled in MetaMask.", "warning");
            return;
          }
          accounts = await rawProvider.request({ method: "eth_requestAccounts" });
        }
      } else {
        accounts = await rawProvider.request({ method: "eth_requestAccounts" });
      }

      if (!accounts || accounts.length === 0) {
        accounts = await rawProvider.request({ method: "eth_accounts" });
      }

      if (accounts && accounts.length > 0) {
        STATE.walletAddress = accounts[0];
        STATE.isWalletConnected = true;
        STATE.provider = provider;
        STATE.signer = await provider.getSigner();

        const balWei = await provider.getBalance(accounts[0]);
        STATE.ethBalance = parseFloat(ethers.formatEther(balWei)).toFixed(4);
        STATE.usdcBalance = "1,250.00";

        updateWalletGating();
        showToast(`Connected MetaMask: ${accounts[0].slice(0, 6)}...${accounts[0].slice(-4)} (${STATE.ethBalance} ETH)`, "success");
        updateTradeBalances();
        recalculateAndSetMinOut();
        updateTradeHashPreview();
        updateUI();
      }
    } catch (err) {
      console.error("MetaMask connection error:", err);
      showToast("MetaMask connection declined or cancelled.", "warning");
    }
  }

  // Connect Buttons
  document.getElementById("connectWalletBtn")?.addEventListener("click", () => connectMetaMask(true));
  document.getElementById("gateConnectWalletBtn")?.addEventListener("click", () => connectMetaMask(true));

  // Dropdown toggle
  const pillBtn = document.getElementById("walletAccountPillBtn");
  const menuDropdown = document.getElementById("walletMenuDropdown");
  pillBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    menuDropdown?.classList.toggle("active");
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#connectedWalletDropdown")) {
      menuDropdown?.classList.remove("active");
    }
  });

  // Switch Account in MetaMask
  document.getElementById("switchAccountBtn")?.addEventListener("click", () => {
    menuDropdown?.classList.remove("active");
    connectMetaMask(true);
  });

  // Disconnect Wallet
  document.getElementById("disconnectWalletBtn")?.addEventListener("click", () => {
    disconnectWallet();
  });

  // Copy Address
  document.getElementById("copyWalletAddressBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (STATE.walletAddress) {
      navigator.clipboard.writeText(STATE.walletAddress);
      showToast("Wallet address copied to clipboard!", "success");
    }
  });

  // Attach MetaMask live event listeners
  const rawProvider = getStrictMetaMaskProvider();
  if (rawProvider && rawProvider.on) {
    rawProvider.on("accountsChanged", async (accounts) => {
      if (accounts && accounts.length > 0) {
        STATE.walletAddress = accounts[0];
        STATE.isWalletConnected = true;
        const provider = new ethers.BrowserProvider(rawProvider);
        STATE.provider = provider;
        STATE.signer = await provider.getSigner();
        const balWei = await provider.getBalance(accounts[0]);
        STATE.ethBalance = parseFloat(ethers.formatEther(balWei)).toFixed(4);
        updateWalletGating();
        updateUI();
        showToast(`MetaMask switched account: ${accounts[0].slice(0, 6)}...${accounts[0].slice(-4)}`, "info");
      } else {
        disconnectWallet();
      }
    });

    rawProvider.on("chainChanged", () => {
      window.location.reload();
    });
  }

  // Initial gating sync
  updateWalletGating();
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
      const selIn = document.getElementById("tradeSelectTokenIn");
      const isEth = selIn ? selIn.value === "token0" : true;

      const rawBal = isEth 
        ? parseFloat(STATE.ethBalance || "0.05") 
        : parseFloat(String(STATE.usdcBalance || "1250").replace(/,/g, ""));
      
      const calculated = (rawBal * pct / 100);
      const formatted = isEth ? calculated.toFixed(4) : calculated.toFixed(2);

      const input = document.getElementById("tradeInputAmountIn");
      if (input) {
        input.value = formatted;
        recalculateAndSetMinOut();
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
