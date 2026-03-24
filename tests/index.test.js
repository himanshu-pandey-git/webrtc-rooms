"use strict";

/**
 * @file tests/index.test.js
 * @description Integration and unit test suite for webrtc-rooms.
 *
 * Requires no external test runner — run directly with Node.js:
 *
 *   node tests/index.test.js
 *
 * Coverage:
 *   - Peer     : state machine, metadata, send queue, reconnect token
 *   - Room     : addPeer, broadcast, data relay, metadata sync, getState
 *   - SignalingServer : join flow, beforeJoin auth, reconnect, kick, data relay, stats
 *   - RateLimiter    : connection rate, ban/unban, whitelist, signal rate
 *   - AdminAPI       : health, stats, rooms (CRUD), peers, kick, broadcast
 */

const assert = require("assert");
const http = require("http");
const WebSocket = require("ws");

const { createServer, Room, Peer, RateLimiter, AdminAPI } = require("../src");

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`  \u2713  ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  \u2717  ${name}\n     ${err.message}\n`);
    failures.push({ name, message: err.message });
    failed++;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

/**
 * Opens a WebSocket to the test server and waits for the initial
 * `connected` message.
 *
 * @param {number} port
 * @returns {Promise<{ ws: WebSocket, peerId: string }>}
 */
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("error", reject);
    ws.on("message", function onFirst(raw) {
      const msg = JSON.parse(raw);
      if (msg.type === "connected") {
        ws.removeListener("message", onFirst);
        resolve({ ws, peerId: msg.peerId });
      }
    });
  });
}

/**
 * Waits for the next message from `ws` that satisfies `predicate`.
 *
 * @param {WebSocket} ws
 * @param {Function}  predicate
 * @param {number}    [timeoutMs=3000]
 * @returns {Promise<object>}
 */
function waitFor(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("waitFor timed out")),
      timeoutMs,
    );
    function handler(raw) {
      const msg = JSON.parse(raw);
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(msg);
      }
    }
    ws.on("message", handler);
  });
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Mock peer factory (for unit tests that do not need a real socket)
// ---------------------------------------------------------------------------

function makeMockPeer(id) {
  const sent = [];
  const ee = new (require("events").EventEmitter)();

  return Object.assign(ee, {
    id,
    roomId: null,
    state: "connecting",
    metadata: {},
    reconnectToken: null,
    _sendQueue: [],
    sent,
    send(msg) {
      sent.push(msg);
    },
    close() {},
    setMetadata(p) {
      Object.assign(this.metadata, p);
      for (const [k, v] of Object.entries(this.metadata)) {
        if (v === null) delete this.metadata[k];
      }
      return this.metadata;
    },
    toJSON() {
      return {
        id: this.id,
        roomId: this.roomId,
        state: this.state,
        metadata: this.metadata,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Peer unit tests
// ---------------------------------------------------------------------------

async function run() {
  console.log("\nPeer");

  await test('initial state is "connecting"', async () => {
    const peer = new Peer({
      id: "p1",
      socket: { readyState: 1, on: () => {} },
    });
    assert.strictEqual(peer.state, "connecting");
    assert.strictEqual(peer.roomId, null);
    assert.strictEqual(peer.isActive, false);
  });

  await test("setMetadata merges patch shallowly", async () => {
    const peer = new Peer({
      id: "p2",
      socket: { readyState: 1, on: () => {} },
      metadata: { name: "Alice" },
    });
    peer.setMetadata({ role: "admin", score: 42 });
    assert.strictEqual(peer.metadata.name, "Alice");
    assert.strictEqual(peer.metadata.role, "admin");
    assert.strictEqual(peer.metadata.score, 42);
  });

  await test("setMetadata removes keys set to null", async () => {
    const peer = new Peer({
      id: "p3",
      socket: { readyState: 1, on: () => {} },
    });
    peer.setMetadata({ token: "secret", role: "admin" });
    peer.setMetadata({ token: null });
    assert.strictEqual(peer.metadata.token, undefined);
    assert.strictEqual(peer.metadata.role, "admin");
  });

  await test("send queues messages while state is RECONNECTING", async () => {
    const sent = [];
    const peer = new Peer({
      id: "p4",
      socket: {
        readyState: 1,
        on: () => {},
        send: (d) => sent.push(JSON.parse(d)),
      },
    });
    peer.state = Peer.State.RECONNECTING;
    peer.send({ type: "a" });
    peer.send({ type: "b" });
    assert.strictEqual(sent.length, 0, "nothing should be sent immediately");
    assert.strictEqual(peer._sendQueue.length, 2);
  });

  await test("reconnectToken is generated when reconnectTtl > 0", async () => {
    const peer = new Peer({
      id: "p5",
      socket: { readyState: 1, on: () => {} },
      reconnectTtl: 5000,
    });
    assert.ok(typeof peer.reconnectToken === "string");
    assert.ok(peer.reconnectToken.length > 8);
  });

  await test("reconnectToken is null when reconnectTtl is 0", async () => {
    const peer = new Peer({
      id: "p6",
      socket: { readyState: 1, on: () => {} },
      reconnectTtl: 0,
    });
    assert.strictEqual(peer.reconnectToken, null);
  });

  await test("toJSON never includes reconnectToken", async () => {
    const peer = new Peer({
      id: "p7",
      socket: { readyState: 1, on: () => {} },
      reconnectTtl: 5000,
      metadata: { displayName: "Bob" },
    });
    const json = peer.toJSON();
    assert.ok(!("reconnectToken" in json));
    assert.strictEqual(json.metadata.displayName, "Bob");
  });

  // ---------------------------------------------------------------------------
  // Room unit tests
  // ---------------------------------------------------------------------------

  console.log("\nRoom");

  await test("isEmpty is true on creation", async () => {
    const room = new Room({ id: "r1" });
    assert.ok(room.isEmpty);
    assert.strictEqual(room.size, 0);
  });

  await test("addPeer sends room:joined to joining peer", async () => {
    const room = new Room({ id: "r2", metadata: { topic: "test" } });
    const peer = makeMockPeer("a");
    room.addPeer(peer);

    const msg = peer.sent.find((m) => m.type === "room:joined");
    assert.ok(msg, "room:joined was not sent");
    assert.strictEqual(msg.roomId, "r2");
    assert.strictEqual(msg.metadata.topic, "test");
    assert.ok(Array.isArray(msg.peers));
  });

  await test("addPeer announces new peer to existing members", async () => {
    const room = new Room({ id: "r3" });
    const peerA = makeMockPeer("a");
    const peerB = makeMockPeer("b");
    room.addPeer(peerA);
    room.addPeer(peerB);

    const announcement = peerA.sent.find((m) => m.type === "peer:joined");
    assert.ok(announcement, "peerA did not receive peer:joined announcement");
    assert.strictEqual(announcement.peer.id, "b");
  });

  await test("addPeer returns false and sends ROOM_FULL when at capacity", async () => {
    const room = new Room({ id: "r4", maxPeers: 2 });
    room.addPeer(makeMockPeer("a"));
    room.addPeer(makeMockPeer("b"));
    const overflow = makeMockPeer("c");
    const result = room.addPeer(overflow);

    assert.strictEqual(result, false);
    assert.ok(overflow.sent.some((m) => m.code === "ROOM_FULL"));
  });

  await test("broadcast delivers to all peers except excluded", async () => {
    const room = new Room({ id: "r5" });
    const [a, b, c] = ["a", "b", "c"].map(makeMockPeer);
    room.addPeer(a);
    room.addPeer(b);
    room.addPeer(c);

    const before = b.sent.length;
    room.broadcast({ type: "ping" }, { exclude: "a" });

    assert.strictEqual(
      a.sent.filter((m) => m.type === "ping").length,
      0,
      "excluded peer received message",
    );
    assert.strictEqual(
      b.sent.slice(before).filter((m) => m.type === "ping").length,
      1,
    );
    assert.strictEqual(c.sent.filter((m) => m.type === "ping").length, 1);
  });

  await test("setMetadata updates metadata and broadcasts room:updated", async () => {
    const room = new Room({ id: "r6" });
    const peer = makeMockPeer("p");
    room.addPeer(peer);

    const before = peer.sent.length;
    room.setMetadata({ topic: "updated" });

    const updates = peer.sent
      .slice(before)
      .filter((m) => m.type === "room:updated");
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].patch.topic, "updated");
    assert.strictEqual(room.metadata.topic, "updated");
  });

  await test("getState returns full room snapshot", async () => {
    const room = new Room({ id: "r7", metadata: { x: 1 } });
    const peer = makeMockPeer("p");
    room.addPeer(peer);

    const state = room.getState();
    assert.strictEqual(state.id, "r7");
    assert.strictEqual(state.metadata.x, 1);
    assert.strictEqual(state.peers.length, 1);
    assert.strictEqual(state.peers[0].id, "p");
    assert.ok(typeof state.createdAt === "number");
  });

  // ---------------------------------------------------------------------------
  // SignalingServer integration tests
  // ---------------------------------------------------------------------------

  console.log("\nSignalingServer");

  const PORT = 13700;
  const server = createServer({
    port: PORT,
    autoCreateRooms: true,
    reconnectTtl: 3000,
  });
  await new Promise((resolve) => server.on("listening", resolve));

  await test("peer receives connected message with a peerId", async () => {
    const { ws, peerId } = await connect(PORT);
    assert.ok(typeof peerId === "string" && peerId.length > 8);
    ws.close();
  });

  await test("join creates room and returns room:joined", async () => {
    const { ws } = await connect(PORT);
    send(ws, { type: "join", roomId: "test-room-1" });
    const msg = await waitFor(ws, (m) => m.type === "room:joined");
    assert.strictEqual(msg.roomId, "test-room-1");
    assert.ok(Array.isArray(msg.peers));
    ws.close();
  });

  await test("second peer receives room:joined with first peer in list", async () => {
    const { ws: wsA } = await connect(PORT);
    send(wsA, { type: "join", roomId: "two-peer-room" });
    await waitFor(wsA, (m) => m.type === "room:joined");

    const { ws: wsB } = await connect(PORT);
    send(wsB, { type: "join", roomId: "two-peer-room" });
    const msg = await waitFor(wsB, (m) => m.type === "room:joined");

    assert.strictEqual(
      msg.peers.length,
      1,
      "second peer should see one existing peer",
    );
    wsA.close();
    wsB.close();
  });

  await test("first peer receives peer:joined when second peer joins", async () => {
    const { ws: wsA } = await connect(PORT);
    send(wsA, { type: "join", roomId: "announce-room" });
    await waitFor(wsA, (m) => m.type === "room:joined");

    const announcedP = waitFor(wsA, (m) => m.type === "peer:joined");

    const { ws: wsB } = await connect(PORT);
    send(wsB, { type: "join", roomId: "announce-room" });
    const announced = await announcedP;

    assert.ok(
      announced.peer.id,
      "peer:joined should include the new peer object",
    );
    wsA.close();
    wsB.close();
  });

  await test("beforeJoin hook rejects peers returning a string reason", async () => {
    const authServer = createServer({
      port: PORT + 1,
      beforeJoin: async (peer) => {
        return peer.metadata.token === "valid" ? true : "Token invalid";
      },
    });
    await new Promise((r) => authServer.on("listening", r));

    const { ws } = await connect(PORT + 1);
    send(ws, { type: "join", roomId: "private", metadata: { token: "bad" } });
    const err = await waitFor(ws, (m) => m.type === "error");
    assert.strictEqual(err.code, "JOIN_REJECTED");
    assert.ok(err.message.includes("Token invalid"));

    await authServer.close();
    ws.close();
  });

  await test("beforeJoin hook allows peers returning true", async () => {
    const authServer = createServer({
      port: PORT + 2,
      beforeJoin: async (peer) =>
        peer.metadata.token === "valid" ? true : "denied",
    });
    await new Promise((r) => authServer.on("listening", r));

    const { ws } = await connect(PORT + 2);
    send(ws, {
      type: "join",
      roomId: "private-2",
      metadata: { token: "valid" },
    });
    const msg = await waitFor(ws, (m) => m.type === "room:joined");
    assert.strictEqual(msg.roomId, "private-2");

    await authServer.close();
    ws.close();
  });

  await test("kick sends kicked message then closes the socket", async () => {
    const { ws, peerId } = await connect(PORT);
    send(ws, { type: "join", roomId: "kick-room" });
    await waitFor(ws, (m) => m.type === "room:joined");

    const kickedP = waitFor(ws, (m) => m.type === "kicked");
    server.kick(peerId, "removed by test");
    const msg = await kickedP;
    assert.strictEqual(msg.reason, "removed by test");
    ws.close();
  });

  await test("data relay broadcasts payload to room", async () => {
    const { ws: wsA } = await connect(PORT);
    const { ws: wsB } = await connect(PORT);
    send(wsA, { type: "join", roomId: "relay-room" });
    await waitFor(wsA, (m) => m.type === "room:joined");
    send(wsB, { type: "join", roomId: "relay-room" });
    await waitFor(wsB, (m) => m.type === "room:joined");

    const dataP = waitFor(wsB, (m) => m.type === "data");
    send(wsA, { type: "data", payload: "hello relay" });
    const data = await dataP;

    assert.strictEqual(data.payload, "hello relay");
    wsA.close();
    wsB.close();
  });

  await test("peer:left is broadcast when a peer disconnects", async () => {
    const { ws: wsA } = await connect(PORT);
    const { ws: wsB, peerId: peerBId } = await connect(PORT);
    try {
      send(wsA, { type: "join", roomId: "leave-room" });
      await waitFor(wsA, (m) => m.type === "room:joined");
      send(wsB, { type: "join", roomId: "leave-room" });
      await waitFor(wsB, (m) => m.type === "room:joined");

      // reconnectTtl is enabled on this server, so `peer:left` can be delayed
      // until the reconnect grace period expires.
      const leftP = waitFor(wsA, (m) => m.type === "peer:left", 5000);
      wsB.terminate();
      const leftMsg = await leftP;
      assert.strictEqual(leftMsg.peerId, peerBId);
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  await test("reconnect token is issued in room:joined", async () => {
    const { ws } = await connect(PORT);
    send(ws, { type: "join", roomId: "reconnect-room" });
    const joined = await waitFor(ws, (m) => m.type === "room:joined");
    assert.ok(
      typeof joined.reconnectToken === "string",
      "reconnect token must be a string",
    );
    ws.terminate();
    await sleep(100);
  });

  await test("reconnect with valid token restores room state", async () => {
    const { ws: ws1 } = await connect(PORT);
    send(ws1, { type: "join", roomId: "reconnect-restore" });
    const joined = await waitFor(ws1, (m) => m.type === "room:joined");
    const token = joined.reconnectToken;

    ws1.terminate();
    await sleep(150);

    const { ws: ws2 } = await connect(PORT);
    send(ws2, { type: "reconnect", token, roomId: "reconnect-restore" });
    const state = await waitFor(ws2, (m) => m.type === "room:state", 4000);
    assert.strictEqual(state.roomId, "reconnect-restore");
    ws2.close();
  });

  await test("stats() returns numeric room and peer counts", async () => {
    const stats = server.stats();
    assert.ok(typeof stats.rooms === "number");
    assert.ok(typeof stats.peers === "number");
    assert.ok(Array.isArray(stats.roomList));
  });

  // ---------------------------------------------------------------------------
  // RateLimiter unit tests
  // ---------------------------------------------------------------------------

  console.log("\nRateLimiter");

  await test("blocks connections after maxConnPerMin is exceeded", async () => {
    const limiter = new RateLimiter({ maxConnPerMin: 3, banDurationMs: 1000 });
    assert.ok(limiter._allowConnection("10.0.0.1"));
    assert.ok(limiter._allowConnection("10.0.0.1"));
    assert.ok(limiter._allowConnection("10.0.0.1"));
    assert.strictEqual(
      limiter._allowConnection("10.0.0.1"),
      false,
      "4th connection should be blocked",
    );
    assert.strictEqual(limiter.bans().length, 1);
    limiter.destroy();
  });

  await test("whitelist IPs bypass all connection limits", async () => {
    const limiter = new RateLimiter({
      maxConnPerMin: 1,
      whitelist: ["127.0.0.1"],
    });
    for (let i = 0; i < 20; i++) {
      assert.ok(
        limiter._allowConnection("127.0.0.1"),
        `attempt ${i + 1} should pass`,
      );
    }
    limiter.destroy();
  });

  await test("ban() adds IP to ban list, unban() removes it", async () => {
    const limiter = new RateLimiter();
    limiter.ban("1.2.3.4", 5000);
    assert.ok(limiter.bans().some((b) => b.ip === "1.2.3.4"));
    limiter.unban("1.2.3.4");
    assert.ok(!limiter.bans().some((b) => b.ip === "1.2.3.4"));
    limiter.destroy();
  });

  await test("_allowSignal blocks after maxMsgPerSec is exceeded", async () => {
    const limiter = new RateLimiter({ maxMsgPerSec: 3 });
    assert.ok(limiter._allowSignal("peer-1", ""));
    assert.ok(limiter._allowSignal("peer-1", ""));
    assert.ok(limiter._allowSignal("peer-1", ""));
    assert.strictEqual(
      limiter._allowSignal("peer-1", ""),
      false,
      "4th signal should be blocked",
    );
    limiter.destroy();
  });

  await test("different peers have independent rate windows", async () => {
    const limiter = new RateLimiter({ maxMsgPerSec: 2 });
    assert.ok(limiter._allowSignal("peer-a", ""));
    assert.ok(limiter._allowSignal("peer-a", ""));
    assert.strictEqual(limiter._allowSignal("peer-a", ""), false);
    // peer-b has a fresh window
    assert.ok(
      limiter._allowSignal("peer-b", ""),
      "peer-b should not be affected",
    );
    limiter.destroy();
  });

  // ---------------------------------------------------------------------------
  // AdminAPI integration tests
  // ---------------------------------------------------------------------------

  console.log("\nAdminAPI");

  const ADMIN_PORT = PORT + 20;
  const ADMIN_SECRET = "test-admin-secret";
  const admin = new AdminAPI({ server, adminSecret: ADMIN_SECRET });
  const adminHttpSrv = admin.listen(ADMIN_PORT);
  await sleep(120);

  /**
   * Performs an HTTP request to the admin API.
   */
  function adminReq(method, path, body) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: "127.0.0.1",
        port: ADMIN_PORT,
        path: `/admin${path}`,
        method,
        headers: {
          Authorization: `Bearer ${ADMIN_SECRET}`,
          "Content-Type": "application/json",
        },
      };
      const req = http.request(opts, (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let parsedBody = {};
          if (raw.trim().length > 0) {
            try {
              parsedBody = JSON.parse(raw);
            } catch {
              parsedBody = { raw };
            }
          }
          resolve({ status: res.statusCode, body: parsedBody });
        });
      });
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  await test('GET /admin/health returns 200 with status "ok"', async () => {
    const { status, body } = await adminReq("GET", "/health");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, "ok");
    assert.ok(typeof body.uptime === "number");
  });

  await test("GET /admin/stats returns rooms and peers counts", async () => {
    const { status, body } = await adminReq("GET", "/stats");
    assert.strictEqual(status, 200);
    assert.ok(typeof body.rooms === "number");
    assert.ok(typeof body.peers === "number");
    assert.ok(Array.isArray(body.roomList));
    assert.ok(typeof body.nodeVersion === "string");
  });

  await test("GET /admin/rooms returns array of rooms", async () => {
    const { status, body } = await adminReq("GET", "/rooms");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.rooms));
  });

  await test("POST /admin/rooms creates a room with metadata", async () => {
    const { status, body } = await adminReq("POST", "/rooms", {
      roomId: "admin-room-1",
      metadata: { topic: "Created by admin" },
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(body.room.id, "admin-room-1");
    assert.ok(
      server.getRoom("admin-room-1"),
      "room should exist on the server",
    );
  });

  await test("GET /admin/rooms/:roomId returns full room state", async () => {
    const { status, body } = await adminReq("GET", "/rooms/admin-room-1");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.id, "admin-room-1");
    assert.strictEqual(body.metadata.topic, "Created by admin");
    assert.ok(Array.isArray(body.peers));
  });

  await test("PATCH /admin/rooms/:roomId updates room metadata", async () => {
    const { status, body } = await adminReq("PATCH", "/rooms/admin-room-1", {
      metadata: { topic: "Updated by admin" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.room.metadata.topic, "Updated by admin");
  });

  await test("GET /admin/rooms/:roomId returns 404 for unknown room", async () => {
    const { status } = await adminReq("GET", "/rooms/does-not-exist");
    assert.strictEqual(status, 404);
  });

  await test("DELETE /admin/rooms/:roomId destroys the room", async () => {
    server.createRoom("room-to-delete");
    const { status, body } = await adminReq("DELETE", "/rooms/room-to-delete");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.destroyed, "room-to-delete");
    assert.ok(!server.getRoom("room-to-delete"), "room should no longer exist");
  });

  await test("GET /admin/peers returns array of connected peers", async () => {
    const { status, body } = await adminReq("GET", "/peers");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.peers));
  });

  await test("DELETE /admin/peers/:peerId kicks the peer", async () => {
    const { ws, peerId } = await connect(PORT);
    send(ws, { type: "join", roomId: "admin-kick-room" });
    await waitFor(ws, (m) => m.type === "room:joined");

    const kickedP = waitFor(ws, (m) => m.type === "kicked");
    const { status, body } = await adminReq("DELETE", `/peers/${peerId}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.kicked, peerId);

    const kicked = await kickedP;
    assert.strictEqual(kicked.reason, "Kicked by admin");
    ws.close();
  });

  await test("POST /admin/rooms/:roomId/broadcast delivers payload to room", async () => {
    server.createRoom("broadcast-room");
    const { ws } = await connect(PORT);
    send(ws, { type: "join", roomId: "broadcast-room" });
    await waitFor(ws, (m) => m.type === "room:joined");

    const dataP = waitFor(
      ws,
      (m) => m.type === "data" && m.from === "__admin__",
    );
    const { status } = await adminReq(
      "POST",
      "/rooms/broadcast-room/broadcast",
      {
        payload: "server announcement",
      },
    );
    assert.strictEqual(status, 200);
    const data = await dataP;
    assert.strictEqual(data.payload, "server announcement");
    ws.close();
  });

  await test("requests with wrong secret receive 401", async () => {
    const res = await new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: ADMIN_PORT,
          path: "/admin/health",
          method: "GET",
          headers: { Authorization: "Bearer wrong-secret" },
        },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode });
        },
      );
      req.end();
    });
    assert.strictEqual(res.status, 401);
  });

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  await admin.close();
  await server.close();

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  const total = passed + failed;
  console.log(`\n${"─".repeat(52)}`);
  console.log(
    `  ${passed} passed  \u2022  ${failed} failed  \u2022  ${total} total`,
  );

  if (failures.length > 0) {
    console.log("\nFailed tests:");
    failures.forEach((f) =>
      console.log(`  \u2717 ${f.name}\n    ${f.message}`),
    );
    process.exit(1);
  } else {
    console.log("\n  All tests passed \u2713\n");
    process.exit(0);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
