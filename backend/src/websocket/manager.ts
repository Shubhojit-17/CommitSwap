import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";

export type WSEventType =
  | "connected"
  | "order:committed"
  | "order:revealed"
  | "batch:settled"
  | "keeper:paid"
  | "window:advanced"
  | "bond:forfeited";

export interface WSEvent {
  type: WSEventType;
  data: unknown;
  timestamp: string;
}

class WebSocketManager {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();

  init(server: Server) {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      console.log(`[WS] Frontend client connected. Active: ${this.clients.size}`);

      ws.on("close", () => {
        this.clients.delete(ws);
        console.log(`[WS] Frontend client disconnected. Active: ${this.clients.size}`);
      });

      ws.on("error", (err) => {
        console.error("[WS] Client socket error:", err.message);
        this.clients.delete(ws);
      });

      // Send greeting handshake
      ws.send(
        JSON.stringify({
          type: "connected",
          data: { message: "Connected to CommitSwap Real-Time Protocol Engine" },
          timestamp: new Date().toISOString(),
        })
      );
    });

    console.log("[WS] WebSocket Engine initialized on /ws");
  }

  broadcast(event: WSEvent) {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  emit(type: WSEventType, data: unknown) {
    this.broadcast({
      type,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  getClientCount(): number {
    return this.clients.size;
  }
}

export const wsManager = new WebSocketManager();
