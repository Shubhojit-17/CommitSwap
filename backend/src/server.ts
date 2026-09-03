import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import rateLimit from "express-rate-limit";
import { wsManager } from "./websocket/manager.js";
import { indexerService } from "./services/indexer.service.js";
import { keeperService } from "./services/keeper.service.js";

// Routes
import dashboardRoutes from "./routes/dashboard.routes.js";
import orderRoutes from "./routes/order.routes.js";
import executionRoutes from "./routes/execution.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import historyRoutes from "./routes/history.routes.js";

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3001;

// CORS setup
app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: "Too many requests. Please slow down." },
});
app.use("/api/", limiter);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    protocol: "CommitSwap Autonomous Engine",
    chain: "Base Sepolia (84532)",
    timestamp: new Date().toISOString(),
    wsClients: wsManager.getClientCount(),
    currentBlock: indexerService.getCurrentBlock(),
    currentWindow: indexerService.getCurrentWindow(),
  });
});

// Mount Routes
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/execution", executionRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/history", historyRoutes);

// Initialize WebSockets
wsManager.init(server);

// Start Background Services & Server
server.listen(PORT, async () => {
  console.log(`=======================================================`);
  console.log(`CommitSwap Protocol Daemon running on port ${PORT}`);
  console.log(`REST API: http://localhost:${PORT}/api/health`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`Target Chain: Base Sepolia (84532)`);
  console.log(`=======================================================`);

  // Start on-chain event indexer & keeper daemon
  await indexerService.start();
  keeperService.start();
});
