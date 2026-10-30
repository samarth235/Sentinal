import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type { BusEvent } from "../types.js";
import type { SentinelBus } from "./bus.js";
import { maskDeep } from "./masking.js";

const RING_SIZE = 500;

/**
 * Bridges the bus to the browser. Every BusEvent goes out as "sentinel:event"; a client that
 * (re)connects gets the last 500 as "sentinel:snapshot". Events are masked first (PAN/phone/
 * account numbers). Masking is length-preserving, so evidence offsets still line up, and it
 * never touches email addresses — the attacker's address in R4 evidence stays visible.
 */
export function attachSocketBridge(server: HttpServer, bus: SentinelBus, origin: string | string[]) {
  const io = new Server(server, { cors: { origin } });
  const ring: BusEvent[] = [];

  const off = bus.on("event", (event) => {
    const safe = maskDeep(event);
    ring.push(safe);
    if (ring.length > RING_SIZE) ring.shift();
    io.emit("sentinel:event", safe);
  });

  io.on("connection", (socket) => {
    socket.emit("sentinel:snapshot", ring);
  });

  return {
    io,
    /** Forget buffered events (after /api/reset) and tell clients to clear. */
    clear() {
      ring.length = 0;
      io.emit("sentinel:snapshot", []);
    },
    close() {
      off();
      io.close();
    },
  };
}
