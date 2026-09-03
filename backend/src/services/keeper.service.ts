import { ethers } from "ethers";
import { indexerService } from "./indexer.service.js";
import { MatcherService } from "./matcher.service.js";
import { wsManager } from "../websocket/manager.js";

const HOOK_SETTLE_ABI = [
  "function settleBatch(uint256 windowIndex, tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) external returns (bytes)",
  "function isWindowSettled(uint256 windowIndex) external view returns (bool)"
];

export class KeeperService {
  private provider: ethers.JsonRpcProvider;
  private keeperWallet: ethers.Wallet | null = null;
  private isAutoSettleEnabled: boolean = false;
  private settledWindows: Set<number> = new Set();
  private isProcessing: boolean = false;

  constructor() {
    const rpcUrl = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    let pk = (process.env.KEEPER_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();
    if (pk) {
      if (pk.startsWith('"') && pk.endsWith('"')) pk = pk.slice(1, -1);
      if (pk.length === 64) pk = "0x" + pk;
      if (pk.startsWith("0x") && pk.length === 66) {
        this.keeperWallet = new ethers.Wallet(pk, this.provider);
        console.log(`[Keeper] Automated Live On-Chain Keeper Wallet initialized: ${this.keeperWallet.address}`);
      } else {
        console.warn("[Keeper] Invalid private key format provided.");
      }
    } else {
      console.log("[Keeper] No KEEPER_PRIVATE_KEY provided. Operating in observer mode.");
    }

    this.isAutoSettleEnabled = process.env.KEEPER_AUTO_SETTLE === "true";
  }

  start() {
    console.log("[Keeper] Autonomous Keeper Daemon activated.");

    // Evaluation loop runs every 8 seconds
    setInterval(async () => {
      await this.evaluateAndSettle();
    }, 8000);
  }

  async evaluateAndSettle() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const currentWindow = indexerService.getCurrentWindow();
      const targetSettlementWindow = currentWindow - 2;

      if (targetSettlementWindow < 0) {
        this.isProcessing = false;
        return;
      }

      if (this.settledWindows.has(targetSettlementWindow)) {
        this.isProcessing = false;
        return;
      }

      const orders = indexerService.getOrdersByWindow(targetSettlementWindow);
      const pendingOrders = orders.filter(o => !o.settled);

      if (pendingOrders.length === 0) {
        this.isProcessing = false;
        return;
      }

      console.log(`[Keeper] Window W${targetSettlementWindow} is ripe for settlement (${pendingOrders.length} orders pending).`);

      const hookAddr = process.env.HOOK_ADDRESS;
      const isLiveHook = hookAddr && hookAddr.length === 42 && hookAddr !== ethers.ZeroAddress;

      // Real on-chain broadcast if keeper wallet is funded
      if (this.isAutoSettleEnabled && this.keeperWallet && isLiveHook) {
        try {
          const hookContract = new ethers.Contract(hookAddr, HOOK_SETTLE_ABI, this.keeperWallet);

          const poolKey = {
            currency0: process.env.TOKEN0_ADDRESS || ethers.ZeroAddress,
            currency1: process.env.TOKEN1_ADDRESS || ethers.ZeroAddress,
            fee: 3000,
            tickSpacing: 60,
            hooks: hookAddr
          };

          console.log(`[Keeper] Submitting on-chain settleBatch(W${targetSettlementWindow}) to Base Sepolia...`);
          const tx = await hookContract.settleBatch(targetSettlementWindow, poolKey);
          console.log(`[Keeper] Settle tx broadcasted: ${tx.hash}. Awaiting block confirmation...`);
          const receipt = await tx.wait();

          this.settledWindows.add(targetSettlementWindow);
          indexerService.settleWindowOrders(targetSettlementWindow, this.keeperWallet.address, tx.hash);

          console.log(`[Keeper] ✅ Batch Settled on Base Sepolia in block #${receipt.blockNumber}! Tx: ${tx.hash}`);
        } catch (chainErr: any) {
          console.warn("[Keeper] On-chain settlement transaction error:", chainErr.shortMessage || chainErr.message);
        }
      }

    } catch (err: any) {
      console.error("[Keeper] Evaluation loop error:", err.message);
    } finally {
      this.isProcessing = false;
    }
  }

  manualSettle(windowIndex: number, keeperAddress: string) {
    this.settledWindows.add(windowIndex);
    return indexerService.settleWindowOrders(windowIndex, keeperAddress);
  }
}

export const keeperService = new KeeperService();
