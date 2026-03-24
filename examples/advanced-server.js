"use strict";

/**
 * @file examples/advanced-server.js
 * @description Advanced signaling server demonstrating authentication,
 * pre-created rooms, reconnection, rate limiting, recording, and the
 * admin REST API.
 *
 * Usage:
 *   node examples/advanced-server.js
 *
 * Test tokens:
 *   secret        → Himanshu   (admin)
 *   secret2       → Piysuh     (member)
 *   secret3       → Sparsh (member)
 *   guest-token   → Atul   (viewer — all-hands only)
 *
 * Available rooms (require valid token):
 *   engineering, design, all-hands
 *
 * Admin API (requires Authorization: Bearer admin-secret):
 *   GET    http://localhost:3000/admin/stats
 *   GET    http://localhost:3000/admin/rooms
 *   DELETE http://localhost:3000/admin/peers/:peerId
 */

const http = require("http");
const {
  createServer,
  AdminAPI,
  RateLimiter,
  RecordingAdapter,
} = require("../src");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "admin-secret";
const RECORD_DIR = process.env.RECORD_DIR ?? "./recordings";

const PRE_CREATED_ROOMS = [
  { id: "engineering", metadata: { topic: "Sprint planning", maxVideo: 10 } },
  { id: "design", metadata: { topic: "Design review", maxVideo: 6 } },
  { id: "all-hands", metadata: { topic: "All-hands meeting", maxVideo: 50 } },
];

// Simulated token database — replace with a real DB call in production.
const TOKEN_DB = new Map([
  ["secret", { userId: "user-1", displayName: "Alice", role: "admin" }],
  ["secret2", { userId: "user-2", displayName: "Bob", role: "member" }],
  ["secret3", { userId: "user-3", displayName: "Charlie", role: "member" }],
  ["guest-token", { userId: "guest", displayName: "Guest", role: "viewer" }],
]);

// ---------------------------------------------------------------------------
// HTTP server (shared by signaling + admin API)
// ---------------------------------------------------------------------------

const httpServer = http.createServer();

// ---------------------------------------------------------------------------
// Signaling server
// ---------------------------------------------------------------------------

const server = createServer({
  server: httpServer,
  autoCreateRooms: false, // only pre-created rooms are valid
  autoDestroyRooms: false, // keep rooms alive when empty
  reconnectTtl: 15_000, // 15-second reconnect grace period

  /**
   * Authentication hook.
   *
   * The client sends `{ type: 'join', roomId, metadata: { token } }`.
   * We verify the token, attach safe user data to the peer, and strip the
   * raw token so it is never broadcast to other participants.
   */
  async beforeJoin(peer, roomId) {
    const token = peer.metadata.token;
    if (!token) return "Authentication required";

    const user = TOKEN_DB.get(token);
    if (!user) return "Invalid token";

    // Viewers may only join the all-hands room.
    if (user.role === "viewer" && roomId !== "all-hands") {
      return "Viewers may only join the all-hands room";
    }

    // Replace the raw token with safe identity fields.
    peer.setMetadata({
      token: null,
      userId: user.userId,
      displayName: user.displayName,
      role: user.role,
    });

    return true;
  },
});

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

const limiter = new RateLimiter({
  maxConnPerMin: 30,
  maxMsgPerSec: 40,
  whitelist: ["127.0.0.1", "::1"],
});
limiter.attach(server);
limiter.on("ip:banned", ({ ip }) =>
  console.warn(`[security] Banned IP: ${ip}`),
);

// ---------------------------------------------------------------------------
// Recording adapter
// ---------------------------------------------------------------------------

const recorder = new RecordingAdapter({
  outputDir: RECORD_DIR,
  format: "webm",
});
recorder.attach(server);
recorder.on("recording:started", ({ peerId, path }) =>
  console.log(`[rec] Started  ${peerId.slice(0, 8)} → ${path}`),
);
recorder.on("recording:stopped", ({ peerId, durationMs }) =>
  console.log(
    `[rec] Stopped  ${peerId.slice(0, 8)} (${(durationMs / 1000).toFixed(1)}s)`,
  ),
);

// ---------------------------------------------------------------------------
// Admin REST API
// ---------------------------------------------------------------------------

const adminApi = new AdminAPI({
  server,
  adminSecret: ADMIN_SECRET,
  prefix: "/admin",
});
httpServer.on("request", adminApi.router());

// ---------------------------------------------------------------------------
// Pre-create rooms
// ---------------------------------------------------------------------------

for (const { id, metadata } of PRE_CREATED_ROOMS) {
  server.createRoom(id, { metadata });
}

// ---------------------------------------------------------------------------
// Server events
// ---------------------------------------------------------------------------

server.on("peer:joined", (peer, room) => {
  const name = peer.metadata.displayName ?? peer.id.slice(0, 8);
  console.log(
    `[→] ${name} (${peer.metadata.role}) joined "${room.id}" (${room.size} peers)`,
  );
});

server.on("peer:left", (peer, room) => {
  const name = peer.metadata.displayName ?? peer.id.slice(0, 8);
  const state = peer.state === "reconnecting" ? " [reconnecting…]" : "";
  console.log(`[←] ${name} left "${room.id}"${state} (${room.size} peers)`);
});

server.on("peer:reconnected", (peer, room) => {
  const name = peer.metadata.displayName ?? peer.id.slice(0, 8);
  console.log(`[↺] ${name} reconnected to "${room.id}"`);
});

server.on("join:rejected", (peer, reason) => {
  console.log(`[✗] Join rejected: ${reason}`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  console.log("\nwebrtc-rooms (advanced) ready");
  console.log(`  ws://localhost:${PORT}              signaling`);
  console.log(`  http://localhost:${PORT}/admin/stats  admin API`);
  console.log(`\n  Rooms:  ${PRE_CREATED_ROOMS.map((r) => r.id).join(", ")}`);
  console.log(`  Tokens: secret, secret2, secret3, guest-token`);
  console.log(`  Admin:  Authorization: Bearer ${ADMIN_SECRET}\n`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown() {
  console.log("\nShutting down gracefully…");
  await server.close();
  httpServer.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
