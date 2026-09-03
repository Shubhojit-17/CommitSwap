import { Router } from "express";
import { indexerService } from "../services/indexer.service.js";
import { MatcherService } from "../services/matcher.service.js";
import { ethers } from "ethers";

const router = Router();

router.get("/overview", (_req, res) => {
  const allOrders = indexerService.getAllOrders();
  const currentBlock = indexerService.getCurrentBlock();
  const currentWindow = indexerService.getCurrentWindow();

  const totalBondWei = allOrders.reduce((sum, o) => sum + o.bondAmount, 0n);
  const matchResult = MatcherService.matchBatch(allOrders);

  res.json({
    currentBlock,
    currentWindow,
    activeCommitWindow: currentWindow,
    activeRevealWindow: currentWindow - 1,
    settlementWindow: currentWindow - 2,
    totalBondedEth: ethers.formatEther(totalBondWei),
    cowMatchedVolume: matchResult.cowMatchedVolume.toString(),
    ammResidualVolume: matchResult.residualVolume.toString(),
    totalOrdersCount: allOrders.length,
    settledOrdersCount: allOrders.filter(o => o.settled).length,
    pendingRevealsCount: allOrders.filter(o => o.windowIndex === currentWindow - 1 && !o.revealed).length,
    mevSandwichProtectedPct: 100,
    keeperIncentiveCutPct: 5.0,
    recentEvents: allOrders.slice(-10).reverse()
  });
});

export default router;
