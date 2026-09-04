import { Router } from "express";
import { indexerService } from "../services/indexer.service.js";
import { MatcherService } from "../services/matcher.service.js";
import { keeperService } from "../services/keeper.service.js";
import { ethers } from "ethers";

const router = Router();

// Get batch execution preview for a target window
router.get("/preview/:windowIndex", (req, res) => {
  const windowIndex = parseInt(req.params.windowIndex);
  const orders = indexerService.getOrdersByWindow(windowIndex);
  const matchResult = MatcherService.matchBatch(orders);

  res.json({
    windowIndex,
    totalOrders: orders.length,
    revealedCount: orders.filter(o => o.revealed).length,
    unrevealedCount: orders.filter(o => !o.revealed).length,
    hasMatch: matchResult.hasMatch,
    cowMatchedVolume: matchResult.cowMatchedVolume.toString(),
    cowMatchedVolumeEth: matchResult.cowMatchedVolumeEth,
    cowMatchedVolumeUsdc: matchResult.cowMatchedVolumeUsdc,
    residualVolume: matchResult.residualVolume.toString(),
    residualVolumeStr: matchResult.residualVolumeStr,
    residualZeroForOne: matchResult.residualZeroForOne,
    keeperCutEth: ethers.formatEther(matchResult.keeperCutEth),
    matchedPairs: matchResult.matchedPairs,
    orderFills: matchResult.orderFills,
    forfeitedOrderIds: matchResult.forfeitedOrders
  });
});

// Manual Settle Batch endpoint
router.post("/settle", async (req, res) => {
  const { windowIndex, keeperAddress } = req.body;
  if (windowIndex === undefined) {
    return res.status(400).json({ error: "windowIndex is required" });
  }

  const result = keeperService.manualSettle(
    parseInt(windowIndex),
    keeperAddress || ethers.ZeroAddress
  );

  res.json({
    success: true,
    windowIndex: parseInt(windowIndex),
    settled: true,
    result
  });
});

export default router;
