import { ethers } from "ethers";
import { wsManager } from "../websocket/manager.js";
import { IntentOrder, MatcherService } from "./matcher.service.js";

const HOOK_ABI = [
  "event Committed(uint256 indexed commitmentId, address indexed committer, bytes32 intentHash, uint256 windowIndex, uint256 bondAmount)",
  "event Revealed(uint256 indexed commitmentId, uint256 amount, uint256 minAmountOut, bool zeroForOne)",
  "event BatchSettled(uint256 indexed windowIndex, address indexed keeper, uint256 totalRevealed, uint256 totalMatchedPairs, uint256 totalMatched0, uint256 totalMatched1, uint256 totalResidual0, uint256 totalResidual1, uint256 totalKeeperReward)",
  "function currentWindowIndex() external view returns (uint256)",
  "function WINDOW_BLOCKS() external view returns (uint256)",
  "function POOL_ID() external view returns (bytes32)",
  "function getCommitment(uint256 commitmentId) external view returns (tuple(address committer, bytes32 intentHash, uint256 windowIndex, uint256 bondAmount, bool revealed, uint256 amount, uint256 minAmountOut, bool zeroForOne))"
];

class IndexerService {
  private provider: ethers.JsonRpcProvider;
  private hookContract: ethers.Contract | null = null;
  private orders: Map<number, IntentOrder> = new Map();
  private currentBlock: number = 0;
  private windowBlocks: number = 5;
  private lastQueriedBlock: number = 0;

  constructor() {
    const rpcUrl = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.windowBlocks = parseInt(process.env.WINDOW_BLOCKS || "5");
  }

  async start() {
    try {
      this.currentBlock = await this.provider.getBlockNumber();
      console.log(`[Indexer] Connected to Base Sepolia at block #${this.currentBlock}`);

      const hookAddr = process.env.HOOK_ADDRESS;
      if (hookAddr && hookAddr.length === 42 && hookAddr !== ethers.ZeroAddress) {
        this.hookContract = new ethers.Contract(hookAddr, HOOK_ABI, this.provider);
        await this.syncHistoricalEvents();
        this.listenToOnChainEvents();
        console.log(`[Indexer] Subscribed to hook events on ${hookAddr}`);
      }

      // Block poller
      setInterval(async () => {
        try {
          const block = await this.provider.getBlockNumber();
          if (block !== this.currentBlock) {
            const oldWindow = Math.floor(this.currentBlock / this.windowBlocks);
            const newWindow = Math.floor(block / this.windowBlocks);
            this.currentBlock = block;

            if (newWindow > oldWindow) {
              wsManager.emit("window:advanced", {
                block,
                windowIndex: newWindow,
                activeCommitWindow: newWindow,
                activeRevealWindow: newWindow - 1,
                settlementWindow: newWindow - 2
              });
            }
          }
        } catch (err) {
          // Silent catch on transient network RPC blips
        }
      }, 5000);

    } catch (err: any) {
      console.warn("[Indexer] Notice connecting to Base Sepolia RPC:", err.message);
    }
  }

  private async syncHistoricalEvents() {
    if (!this.hookContract) return;
    try {
      const deployBlock = parseInt(process.env.START_BLOCK || "46328890");
      let from = deployBlock;
      const targetBlock = this.currentBlock;
      console.log(`[Indexer] Syncing on-chain history from block ${deployBlock} to ${targetBlock}...`);

      while (from <= targetBlock) {
        const to = Math.min(from + 5000, targetBlock);

        // Sync Committed
        const commitEvents = await this.hookContract.queryFilter("Committed", from, to);
        for (const evt of commitEvents) {
          const args = (evt as any).args;
          const id = Number(args.commitmentId);
          if (!this.orders.has(id)) {
            const order: IntentOrder = {
              id,
              committer: args.committer,
              amount: 0n,
              minAmountOut: 0n,
              zeroForOne: true,
              revealed: false,
              settled: false,
              bondAmount: BigInt(args.bondAmount.toString()),
              windowIndex: Number(args.windowIndex),
              salt: args.intentHash,
              txHash: evt.transactionHash,
              timestamp: new Date().toISOString()
            };
            this.orders.set(order.id, order);
          }
        }

        // Sync Revealed
        const revealEvents = await this.hookContract.queryFilter("Revealed", from, to);
        for (const evt of revealEvents) {
          const args = (evt as any).args;
          const id = Number(args.commitmentId);
          const order = this.orders.get(id);
          if (order) {
            order.revealed = true;
            order.amount = BigInt(args.amount.toString());
            order.minAmountOut = BigInt(args.minAmountOut.toString());
            order.zeroForOne = Boolean(args.zeroForOne);
          }
        }

        // Sync BatchSettled
        const settleEvents = await this.hookContract.queryFilter("BatchSettled", from, to);
        for (const evt of settleEvents) {
          const args = (evt as any).args;
          const windowIndex = Number(args.windowIndex);
          const targetOrders = Array.from(this.orders.values()).filter(o => o.windowIndex === windowIndex);
          targetOrders.forEach(o => o.settled = true);
        }

        from = to + 1;
      }
      this.lastQueriedBlock = targetBlock;
      console.log(`[Indexer] On-chain sync complete. Ingested ${this.orders.size} orders.`);
    } catch (err: any) {
      console.warn("[Indexer] Historical sync notice:", err.message);
    }
  }

  private listenToOnChainEvents() {
    if (!this.hookContract) return;

    setInterval(async () => {
      if (!this.hookContract) return;
      try {
        const toBlock = this.currentBlock;
        if (toBlock <= this.lastQueriedBlock) return;

        const fromBlock = this.lastQueriedBlock + 1;

        // Query Committed events
        const commitEvents = await this.hookContract.queryFilter("Committed", fromBlock, toBlock);
        for (const evt of commitEvents) {
          const args = (evt as any).args;
          const id = Number(args.commitmentId);
          if (!this.orders.has(id)) {
            const order: IntentOrder = {
              id,
              committer: args.committer,
              amount: 0n,
              minAmountOut: 0n,
              zeroForOne: true,
              revealed: false,
              settled: false,
              bondAmount: BigInt(args.bondAmount.toString()),
              windowIndex: Number(args.windowIndex),
              salt: args.intentHash,
              txHash: evt.transactionHash,
              timestamp: new Date().toISOString()
            };
            this.orders.set(order.id, order);
            console.log(`[On-Chain] Ingested Event Committed: Order #${id} for Window W${order.windowIndex}`);
            wsManager.emit("order:committed", order);
          }
        }

        // Query Revealed events
        const revealEvents = await this.hookContract.queryFilter("Revealed", fromBlock, toBlock);
        for (const evt of revealEvents) {
          const args = (evt as any).args;
          const id = Number(args.commitmentId);
          const order = this.orders.get(id);
          if (order && !order.revealed) {
            order.revealed = true;
            order.amount = BigInt(args.amount.toString());
            order.minAmountOut = BigInt(args.minAmountOut.toString());
            order.zeroForOne = Boolean(args.zeroForOne);
            console.log(`[On-Chain] Ingested Event Revealed: Order #${id}`);
            wsManager.emit("order:revealed", order);
          }
        }

        // Query BatchSettled events
        const settleEvents = await this.hookContract.queryFilter("BatchSettled", fromBlock, toBlock);
        for (const evt of settleEvents) {
          const args = (evt as any).args;
          const windowIndex = Number(args.windowIndex);
          const targetOrders = Array.from(this.orders.values()).filter(o => o.windowIndex === windowIndex);
          targetOrders.forEach(o => o.settled = true);

          console.log(`[On-Chain] Ingested Event BatchSettled: Window W${windowIndex}`);
          wsManager.emit("batch:settled", {
            windowIndex,
            keeper: args.keeper,
            keeperRewardEth: ethers.formatEther(args.totalKeeperReward || 0n),
            cowMatchedVolume: (args.totalMatched0 || 0n).toString(),
            ammResidualVolume: (args.totalResidual0 || 0n).toString(),
            txHash: evt.transactionHash
          });
        }

        this.lastQueriedBlock = toBlock;
      } catch (err: any) {
        // Silent catch on transient RPC rate limit
      }
    }, 6000);
  }

  // Local/API Order submission handler
  recordOrder(order: Partial<IntentOrder>): IntentOrder {
    const id = order.id ?? this.orders.size;
    const fullOrder: IntentOrder = {
      id,
      committer: order.committer || ethers.ZeroAddress,
      amount: order.amount || 0n,
      minAmountOut: order.minAmountOut || 0n,
      zeroForOne: order.zeroForOne ?? true,
      revealed: order.revealed ?? false,
      settled: order.settled ?? false,
      bondAmount: order.bondAmount || ethers.parseEther("0.001"),
      windowIndex: order.windowIndex ?? Math.floor(this.currentBlock / this.windowBlocks),
      salt: order.salt || ethers.ZeroHash,
      txHash: order.txHash,
      timestamp: new Date().toISOString()
    };
    this.orders.set(id, fullOrder);
    wsManager.emit("order:committed", fullOrder);
    return fullOrder;
  }

  revealOrder(id: number, amount: bigint, minAmountOut: bigint, zeroForOne: boolean, salt: string): IntentOrder | null {
    const order = this.orders.get(id);
    if (!order) return null;
    order.revealed = true;
    order.amount = amount;
    order.minAmountOut = minAmountOut;
    order.zeroForOne = zeroForOne;
    order.salt = salt;
    wsManager.emit("order:revealed", order);
    return order;
  }

  settleWindowOrders(windowIndex: number, keeper: string, txHash?: string) {
    const windowOrders = Array.from(this.orders.values()).filter(o => o.windowIndex === windowIndex && !o.settled);
    const match = MatcherService.matchBatch(windowOrders);
    windowOrders.forEach(o => o.settled = true);

    wsManager.emit("batch:settled", {
      windowIndex,
      keeper,
      keeperRewardEth: ethers.formatEther(match.keeperCutEth),
      cowMatchedVolume: match.cowMatchedVolume.toString(),
      residualVolume: match.residualVolume.toString(),
      txHash
    });
    return match;
  }

  getAllOrders(): IntentOrder[] {
    return Array.from(this.orders.values());
  }

  getOrdersByWindow(windowIndex: number): IntentOrder[] {
    return Array.from(this.orders.values()).filter(o => o.windowIndex === windowIndex);
  }

  getCurrentBlock(): number {
    return this.currentBlock;
  }

  getCurrentWindow(): number {
    return Math.floor(this.currentBlock / this.windowBlocks);
  }
}

export const indexerService = new IndexerService();
