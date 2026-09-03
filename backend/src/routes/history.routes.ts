import { Router } from "express";
import { indexerService } from "../services/indexer.service.js";

const router = Router();

router.get("/", (req, res) => {
  const committer = req.query.committer as string;
  let orders = indexerService.getAllOrders();

  if (committer) {
    orders = orders.filter(o => o.committer.toLowerCase() === committer.toLowerCase());
  }

  res.json({
    total: orders.length,
    history: orders.slice().reverse()
  });
});

export default router;
