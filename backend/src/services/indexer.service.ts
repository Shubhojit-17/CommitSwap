import { ethers } from "ethers";
import { wsManager } from "../websocket/manager.js";
import { IntentOrder, MatcherService } from "./matcher.service.js";

const HOOK_ABI = [
  "event Committed(uint256 indexed id, address indexed committer, bytes32 intentHash, uint256 indexed windowIndex, uint256 bondAmount)",
  "event Revealed(uint256 indexed id, address indexed committer, uint256 amount, uint256 minAmountOut, bool zeroForOne, bytes32 poolId)",
  "event BatchSettled(uint256 indexed windowIndex, address indexed keeper, uint256 keeperReward, uint256 cowMatchedVolume, uint256 ammResidualVolume)",
  "function currentWindowIndex() external view returns (uint256)",
  "function WINDOW_BLOCKS() external view returns (uint256)",
  "function POOL_ID() external view returns (bytes32)"
];

class IndexerService {
  private provider: ethers.JsonRpcProvider;
  private hookContract: ethers.Contract | null = null;
  private orders: Map<number, IntentOrder> = new Map();
  private currentBlock: number = 0;
  private windowBlocks: number = 5;

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

  private listenToOnChainEvents() {
    if (!this.hookContract) return;

    this.hookContract.on("Committed", (id, committer, intentHash, windowIndex, bondAmount, event) => {
      console.log(`[On-Chain] Event Committed: Order #${id} by ${committer} for Window W${windowIndex}`);
      const order: IntentOrder = {
        id: Number(id),
        committer,
        amount: 0n,
        minAmountOut: 0n,
        zeroForOne: true,
        revealed: false,
        settled: false,
        bondAmount: BigInt(bondAmount.toString()),
        windowIndex: Number(windowIndex),
        salt: intentHash,
        txHash: event?.log?.transactionHash,
        timestamp: new Date().toISOString()
      };
      this.orders.set(order.id, order);
      wsManager.emit("order:committed", order);
    });

    this.hookContract.on("Revealed", (id, committer, amount, minAmountOut, zeroForOne, poolId, event) => {
      console.log(`[On-Chain] Event Revealed: Order #${id} by ${committer}`);
      const order = this.orders.get(Number(id));
      if (order) {
        order.revealed = true;
        order.amount = BigInt(amount.toString());
        order.minAmountOut = BigInt(minAmountOut.toString());
        order.zeroForOne = Boolean(zeroForOne);
        wsManager.emit("order:revealed", order);
      }
    });

    this.hookContract.on("BatchSettled", (windowIndex, keeper, keeperReward, cowMatched, ammResidual, event) => {
      console.log(`[On-Chain] Event BatchSettled: Window W${windowIndex} settled by ${keeper}. Reward: ${ethers.formatEther(keeperReward)} ETH`);
      const targetOrders = Array.from(this.orders.values()).filter(o => o.windowIndex === Number(windowIndex));
      targetOrders.forEach(o => o.settled = true);

      wsManager.emit("batch:settled", {
        windowIndex: Number(windowIndex),
        keeper,
        keeperRewardEth: ethers.formatEther(keeperReward),
        cowMatchedVolume: cowMatched.toString(),
        ammResidualVolume: ammResidual.toString(),
        txHash: event?.log?.transactionHash
      });

      wsManager.emit("keeper:paid", {
        keeper,
        rewardEth: ethers.formatEther(keeperReward),
        txHash: event?.log?.transactionHash
      });
    });
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
