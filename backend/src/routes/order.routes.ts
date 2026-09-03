import { Router } from "express";
import { indexerService } from "../services/indexer.service.js";
import { ethers } from "ethers";

const router = Router();

// Get all orders or filter by window
router.get("/", (req, res) => {
  const windowParam = req.query.window;
  if (windowParam !== undefined) {
    const w = parseInt(windowParam as string);
    return res.json({ orders: indexerService.getOrdersByWindow(w) });
  }
  res.json({ orders: indexerService.getAllOrders() });
});

// Commit an order (called by client after or during on-chain submission)
router.post("/commit", (req, res) => {
  const { committer, amount, minAmountOut, zeroForOne, salt, txHash, windowIndex } = req.body;

  const order = indexerService.recordOrder({
    committer: committer || ethers.ZeroAddress,
    amount: amount ? ethers.parseEther(amount.toString()) : 0n,
    minAmountOut: minAmountOut ? ethers.parseEther(minAmountOut.toString()) : 0n,
    zeroForOne: zeroForOne ?? true,
    salt: salt || ethers.ZeroHash,
    txHash,
    windowIndex: windowIndex !== undefined ? parseInt(windowIndex) : undefined
  });

  res.status(201).json({ success: true, order });
});

// Reveal an order
router.post("/reveal", (req, res) => {
  const { id, amount, minAmountOut, zeroForOne, salt } = req.body;

  if (id === undefined) {
    return res.status(400).json({ error: "Order id is required" });
  }

  const updated = indexerService.revealOrder(
    Number(id),
    ethers.parseEther(amount.toString()),
    ethers.parseEther(minAmountOut.toString()),
    Boolean(zeroForOne),
    salt || ethers.ZeroHash
  );

  if (!updated) {
    return res.status(404).json({ error: `Order #${id} not found` });
  }

  res.json({ success: true, order: updated });
});

export default router;
