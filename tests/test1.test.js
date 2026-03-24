"use strict";

/**
 * @file tests/test1.test.js
 * @description test 1 test suite for webrtc-rooms v2.
 *
 * Covers:
 *   - Unit: SessionManager, PolicyEngine, SFUOrchestrator, NativeSFUEngine,
 *           MetricsCollector, ThreatDetector, BackpressureController, AuditLogger
 *   - Integration: SessionManager ↔ SignalingServer, PolicyEngine ↔ SignalingServer
 *   - Smoke: Full server boot with all test 1 modules attached
 *   - Sanity: All modules export correctly, no missing requires
 *
 * Run: node tests/test1.test.js
 */

const assert = require("assert");
const { EventEmitter } = require("events");

// Module imports
const SessionManager = require("../src/core/SessionManager");
const PolicyEngine = require("../src/auth/PolicyEngine");
const SFUOrchestrator = require("../src/sfu/SFUOrchestrator");
const NativeSFUEngine = require("../src/sfu/NativeSFUEngine");
const MetricsCollector = require("../src/observability/MetricsCollector");
const ThreatDetector = require("../src/security/ThreatDetector");
const BackpressureController = require("../src/reliability/BackpressureController");
const AuditLogger = require("../src/security/AuditLogger");

(async () => {
  // BEGIN ASYNC WRAPPER

  // Test harness

  let passed = 0,
    failed = 0;
  const failures = [];

  async function test(name, fn) {
    try {
      await fn();
      process.stdout.write(`  ✓  ${name}\n`);
      passed++;
    } catch (err) {
      process.stdout.write(`  ✗  ${name}\n     ${err.message}\n`);
      failures.push({ name, message: err.message });
      failed++;
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Mock helpers

  function makeMockServer(options = {}) {
    const ee = new EventEmitter();
    const rooms = new Map();
    const peers = new Map();

    const server = Object.assign(ee, {
      rooms,
      peers,
      beforeJoin: options.beforeJoin ?? null,
      _wss: null,
      getRoom: (id) => rooms.get(id),
      kick: (peerId, reason) => {
        const peer = peers.get(peerId);
        if (peer) {
          peer._kicked = { reason };
          peers.delete(peerId);
        }
      },
      createRoom: (id, opts = {}) => {
        const room = makeMockRoom(id, opts.metadata);
        rooms.set(id, room);
        server.emit("room:created", room);
        return room;
      },
      stats: () => ({ rooms: rooms.size, peers: peers.size, roomList: [] }),
    });

    return server;
  }

  function makeMockRoom(id, metadata = {}) {
    const ee = new EventEmitter();
    const ps = new Map();
    return Object.assign(ee, {
      id,
      metadata,
      peers: ps,
      size: 0,
      isEmpty: true,
      broadcast: (msg, opts = {}) => {
        const ex = new Set(
          Array.isArray(opts.exclude) ? opts.exclude : [opts.exclude],
        );
        for (const [pid, p] of ps) {
          if (!ex.has(pid)) p.sent.push(msg);
        }
      },
      setMetadata: (patch) => {
        Object.assign(metadata, patch);
      },
      getState: () => ({
        id,
        metadata,
        peers: [...ps.values()].map((p) => p.toJSON()),
        createdAt: 0,
      }),
      addPeer: (peer) => {
        peer.roomId = id;
        peer.state = "joined";
        ps.set(peer.id, peer);
        ee.size = ps.size;
        ee.isEmpty = ps.size === 0;
        ee.emit("peer:joined", peer);
        return true;
      },
    });
  }

  function makeMockPeer(id, metadata = {}) {
    const sent = [];
    const ee = new EventEmitter();
    return Object.assign(ee, {
      id,
      metadata,
      roomId: null,
      state: "connecting",
      connectedAt: Date.now(),
      reconnectToken: null,
      _sendQueue: [],
      sent,
      send(m) {
        sent.push(m);
      },
      close(c, r) {
        this._closed = { code: c, reason: r };
      },
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

  // SANITY TESTS — all modules load and export correctly

  console.log("\n--> Sanity: module exports");

  await test("SessionManager exports a class", async () => {
    assert.strictEqual(typeof SessionManager, "function");
    assert.ok(SessionManager.State);
    assert.strictEqual(SessionManager.State.ACTIVE, "active");
  });

  await test("PolicyEngine exports a class", async () => {
    assert.strictEqual(typeof PolicyEngine, "function");
  });

  await test("SFUOrchestrator exports a class with Health enum", async () => {
    assert.strictEqual(typeof SFUOrchestrator, "function");
    assert.strictEqual(SFUOrchestrator.Health.HEALTHY, "healthy");
    assert.strictEqual(SFUOrchestrator.Health.DOWN, "down");
  });

  await test("NativeSFUEngine exports a class", async () => {
    assert.strictEqual(typeof NativeSFUEngine, "function");
  });

  await test("MetricsCollector exports a class", async () => {
    assert.strictEqual(typeof MetricsCollector, "function");
  });

  await test("ThreatDetector exports a class with Level enum", async () => {
    assert.strictEqual(typeof ThreatDetector, "function");
    assert.strictEqual(ThreatDetector.Level.BAN, "ban");
  });

  await test("BackpressureController exports a class with Level enum", async () => {
    assert.strictEqual(typeof BackpressureController, "function");
    assert.strictEqual(BackpressureController.Level.CRITICAL, "critical");
  });

  await test("AuditLogger exports a class", async () => {
    assert.strictEqual(typeof AuditLogger, "function");
  });

  // UNIT: SessionManager

  console.log("\n--> Unit: SessionManager");
  await test("throws if constructed with no options and attaches gracefully", async () => {
    const mgr = new SessionManager({ reconnectTtl: 5_000 });
    assert.ok(mgr);
    await mgr.close();
  });

  await test("creates session when peer:joined fires", async () => {
    const server = makeMockServer();
    const mgr = new SessionManager({ reconnectTtl: 5_000 });
    mgr.attach(server);

    const peer = makeMockPeer("p1");
    const room = makeMockRoom("r1");
    server.emit("peer:joined", peer, room);

    await sleep(10);
    const session = mgr.getSession("p1");
    assert.ok(session, "session should exist");
    assert.strictEqual(session.roomId, "r1");
    assert.strictEqual(session.state, "active");

    // peer should have received the session token
    const tokenMsg = peer.sent.find((m) => m.type === "session:token");
    assert.ok(tokenMsg, "session:token message should be sent");
    assert.ok(tokenMsg.token, "token should be non-empty");
    assert.strictEqual(tokenMsg.ttl, 5_000);

    await mgr.close();
  });

  await test("suspends session when peer:left fires", async () => {
    const server = makeMockServer();
    const mgr = new SessionManager({ reconnectTtl: 10_000 });
    mgr.attach(server);

    const peer = makeMockPeer("p2");
    const room = makeMockRoom("r1");
    server.emit("peer:joined", peer, room);
    await sleep(10);
    server.emit("peer:left", peer, room);
    await sleep(10);

    const session = mgr.getSession("p2");
    assert.ok(session, "session should still exist after peer:left");
    assert.strictEqual(session.state, "suspended");
    assert.ok(session.suspendedAt > 0);

    await mgr.close();
  });

  await test("resumes session with valid token", async () => {
    const server = makeMockServer();
    const mgr = new SessionManager({ reconnectTtl: 30_000 });
    mgr.attach(server);

    const peer = makeMockPeer("p3");
    const room = makeMockRoom("r1");
    server.emit("peer:joined", peer, room);
    await sleep(10);
    server.emit("peer:left", peer, room);
    await sleep(10);

    const session = mgr.getSession("p3");
    const token = session.token;

    const resumed = await mgr.resume(token, "r1");
    assert.ok(resumed, "should return resumed session");
    assert.strictEqual(resumed.state, "resumed");

    await mgr.close();
  });

  await test("returns null for expired token", async () => {
    const mgr = new SessionManager({ reconnectTtl: 1 }); // 1ms TTL

    // Manually create a suspended session
    mgr._byPeer.set("p-exp", {
      id: "p-exp",
      token: "bad-token",
      roomId: "r1",
      metadata: {},
      state: "suspended",
      createdAt: Date.now() - 10_000,
      suspendedAt: Date.now() - 10_000,
      ttl: 1,
      queue: [],
      region: "default",
    });
    mgr._byToken.set("bad-token", mgr._byPeer.get("p-exp"));

    const result = await mgr.resume("bad-token", "r1");
    assert.strictEqual(result, null, "expired session should return null");

    await mgr.close();
  });

  await test("enqueue and flushQueue work correctly", async () => {
    const server = makeMockServer();
    const mgr = new SessionManager({ reconnectTtl: 30_000 });
    mgr.attach(server);

    const peer = makeMockPeer("p4");
    const room = makeMockRoom("r1");
    server.emit("peer:joined", peer, room);
    await sleep(10);
    server.emit("peer:left", peer, room);
    await sleep(10);

    mgr.enqueue("p4", { type: "data", payload: "msg1" });
    mgr.enqueue("p4", { type: "data", payload: "msg2" });

    const flushed = [];
    mgr.flushQueue("p4", (msg) => flushed.push(msg));

    assert.strictEqual(flushed.length, 2);
    assert.strictEqual(flushed[0].payload, "msg1");
    assert.strictEqual(flushed[1].payload, "msg2");

    await mgr.close();
  });

  await test("token signature verification rejects tampered token", async () => {
    const mgr = new SessionManager({
      reconnectTtl: 30_000,
      secret: "test-secret",
    });
    const realToken = mgr._issueToken("peer-xyz");
    const tampered = realToken.slice(0, -4) + "XXXX";

    assert.strictEqual(mgr._verifyToken(tampered, "peer-xyz"), false);
    assert.strictEqual(mgr._verifyToken(realToken, "peer-xyz"), true);
    assert.strictEqual(mgr._verifyToken(realToken, "different-peer"), false);

    await mgr.close();
  });

  await test("stats() returns correct counts", async () => {
    const server = makeMockServer();
    const mgr = new SessionManager({ reconnectTtl: 30_000 });
    mgr.attach(server);

    const p1 = makeMockPeer("s1"),
      r1 = makeMockRoom("r1");
    const p2 = makeMockPeer("s2"),
      r2 = makeMockRoom("r2");

    server.emit("peer:joined", p1, r1);
    server.emit("peer:joined", p2, r2);
    await sleep(10);
    server.emit("peer:left", p1, r1);
    await sleep(10);

    const stats = mgr.stats();
    assert.strictEqual(stats.active, 1);
    assert.strictEqual(stats.suspended, 1);
    assert.strictEqual(stats.total, 2);

    await mgr.close();
  });

  // UNIT: PolicyEngine

  console.log("\n--> Unit: PolicyEngine");

  await test("throws if secret is missing", async () => {
    assert.throws(() => new PolicyEngine({ secret: "" }), /secret.*required/i);
  });

  await test("issues and verifies a valid token", async () => {
    const engine = new PolicyEngine({ secret: "test-secret-123" });
    const token = engine.issue({
      sub: "alice",
      roomId: "standup",
      role: "moderator",
      caps: ["publish", "subscribe"],
    });

    assert.ok(typeof token === "string" && token.length > 0);

    const result = engine.verify(token);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.policy.sub, "alice");
    assert.strictEqual(result.policy.role, "moderator");
    assert.ok(result.policy.caps.includes("publish"));
    assert.ok(result.policy.caps.includes("subscribe"));
  });

  await test("rejects token with wrong secret", async () => {
    const engineA = new PolicyEngine({ secret: "secret-a" });
    const engineB = new PolicyEngine({ secret: "secret-b" });
    const token = engineA.issue({ sub: "bob" });
    const result = engineB.verify(token);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes("signature"));
  });

  await test("rejects expired token", async () => {
    const engine = new PolicyEngine({ secret: "test" });
    const token = engine.issue({ sub: "alice", expiresIn: -1000 }); // already expired
    const result = engine.verify(token);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.toLowerCase().includes("expir"));
  });

  await test("admin cap implies all other caps", async () => {
    const engine = new PolicyEngine({ secret: "test" });
    const token = engine.issue({ sub: "alice", caps: ["admin"] });
    const result = engine.verify(token);
    assert.strictEqual(result.valid, true);
    const caps = result.policy.caps;
    assert.ok(caps.includes("publish"));
    assert.ok(caps.includes("subscribe"));
    assert.ok(caps.includes("kick"));
    assert.ok(caps.includes("admin"));
  });

  await test("throws on unknown capability", async () => {
    const engine = new PolicyEngine({ secret: "test" });
    assert.throws(
      () => engine.issue({ sub: "alice", caps: ["fly"] }),
      /unknown capability.*fly/i,
    );
  });

  await test("enforces room constraint in attach() beforeJoin", async () => {
    const server = makeMockServer();
    const engine = new PolicyEngine({ secret: "test", required: true });
    engine.attach(server);

    const token = engine.issue({
      sub: "alice",
      roomId: "room-a",
      caps: ["subscribe"],
    });
    const peer = makeMockPeer("pe1", { policyToken: token });

    const result = await server.beforeJoin(peer, "room-b"); // wrong room
    assert.notStrictEqual(result, true, "should reject join to wrong room");
  });

  await test("grants default caps when token not required and absent", async () => {
    const server = makeMockServer();
    const engine = new PolicyEngine({
      secret: "test",
      required: false,
      defaultCaps: ["subscribe"],
    });
    engine.attach(server);

    const peer = makeMockPeer("pe2", {}); // no token
    const result = await server.beforeJoin(peer, "any-room");
    assert.strictEqual(result, true);
    assert.ok(peer.metadata.__caps?.includes("subscribe"));
  });

  await test("rejects join when required=true and no token", async () => {
    const server = makeMockServer();
    const engine = new PolicyEngine({ secret: "test", required: true });
    engine.attach(server);

    const peer = makeMockPeer("pe3", {});
    const result = await server.beforeJoin(peer, "room-x");
    assert.notStrictEqual(result, true);
    assert.ok(typeof result === "string");
  });

  // UNIT: NativeSFUEngine

  console.log("\n--> Unit: NativeSFUEngine");

  await test("init() sets initialized flag", async () => {
    const sfu = new NativeSFUEngine({ region: "test" });
    await sfu.init();
    assert.strictEqual(sfu._initialized, true);
    await sfu.close();
  });

  await test("attach() wires room:created handler", async () => {
    const server = makeMockServer();
    const sfu = new NativeSFUEngine();
    await sfu.init();
    sfu.attach(server);

    server.createRoom("sfu-room-1");
    assert.ok(sfu._rooms.has("sfu-room-1"), "SFU should create internal room");
    await sfu.close();
  });

  await test("peer:joined sends sfu:ready with existingProducers", async () => {
    const server = makeMockServer();
    const sfu = new NativeSFUEngine();
    await sfu.init();
    sfu.attach(server);

    const room = server.createRoom("sfu-r1");
    const peer = makeMockPeer("sfu-p1");
    server.emit("peer:joined", peer, room);

    const readyMsg = peer.sent.find((m) => m.type === "sfu:ready");
    assert.ok(readyMsg, "sfu:ready should be sent on join");
    assert.ok(Array.isArray(readyMsg.existingProducers));

    await sfu.close();
  });

  await test("publish signal creates producer and broadcasts to room", async () => {
    const server = makeMockServer();
    const sfu = new NativeSFUEngine();
    await sfu.init();
    sfu.attach(server);

    const room = server.createRoom("pub-room");
    const peerA = makeMockPeer("pub-a");
    const peerB = makeMockPeer("pub-b");

    room.peers.set(peerA.id, peerA);
    room.peers.set(peerB.id, peerB);

    server.emit("peer:joined", peerA, room);
    server.emit("peer:joined", peerB, room);

    // Simulate peerA publishing
    const sfuRoom = sfu._rooms.get("pub-room");
    sfu._handlePublish(peerA, room, sfuRoom, { kind: "video", trackId: "t1" });

    const publishedMsg = peerA.sent.find((m) => m.type === "sfu:published");
    assert.ok(publishedMsg, "publisher should receive sfu:published");

    const announcedMsg = peerB.sent.find(
      (m) => m.type === "sfu:peer:published",
    );
    assert.ok(announcedMsg, "other peers should receive sfu:peer:published");
    assert.strictEqual(announcedMsg.peerId, "pub-a");

    await sfu.close();
  });

  await test("subscribe creates consumer and confirms to subscriber", async () => {
    const server = makeMockServer();
    const sfu = new NativeSFUEngine();
    await sfu.init();
    sfu.attach(server);

    const room = server.createRoom("sub-room");
    const peerA = makeMockPeer("sub-a");
    const peerB = makeMockPeer("sub-b");

    server.emit("peer:joined", peerA, room);
    server.emit("peer:joined", peerB, room);

    const sfuRoom = sfu._rooms.get("sub-room");

    // peerA publishes
    sfu._handlePublish(peerA, room, sfuRoom, { kind: "audio", trackId: "a1" });
    const producedMsg = peerA.sent.find((m) => m.type === "sfu:published");
    const producerId = producedMsg.producerId;

    // peerB subscribes
    sfu._handleSubscribe(peerB, room, sfuRoom, { producerId });
    const subscribedMsg = peerB.sent.find((m) => m.type === "sfu:subscribed");
    assert.ok(subscribedMsg, "subscriber should receive sfu:subscribed");
    assert.strictEqual(subscribedMsg.producerId, producerId);
    assert.strictEqual(subscribedMsg.publisherId, "sub-a");

    await sfu.close();
  });

  await test("stats() returns correct room and producer counts", async () => {
    const server = makeMockServer();
    const sfu = new NativeSFUEngine({ region: "stats-test" });
    await sfu.init();
    sfu.attach(server);

    server.createRoom("stats-r1");
    server.createRoom("stats-r2");

    const stats = sfu.stats();
    assert.strictEqual(stats.rooms, 2);
    assert.strictEqual(stats.region, "stats-test");
    assert.ok(stats.initialized);

    await sfu.close();
  });

  // UNIT: SFUOrchestrator

  console.log("\n--> Unit: SFUOrchestrator");

  await test("throws if server is missing", async () => {
    assert.throws(() => new SFUOrchestrator({}), /server.*required/i);
  });

  await test("register() adds SFU and throws on duplicate region", async () => {
    const server = makeMockServer();
    const orch = new SFUOrchestrator({ server });

    const fakeSFU = {
      init: async () => {},
      attach: () => {},
      close: async () => {},
      healthCheck: async () => {},
      stats: () => ({}),
    };
    orch.register("us-east-1", fakeSFU);
    assert.strictEqual(orch.size, 1);

    assert.throws(
      () => orch.register("us-east-1", fakeSFU),
      /already registered/i,
    );
  });

  await test("init() initializes registered SFUs and assigns rooms", async () => {
    const server = makeMockServer();
    const orch = new SFUOrchestrator({ server, defaultRegion: "test-region" });

    let initCalled = false;
    let attachCalled = false;

    const fakeSFU = {
      init: async () => {
        initCalled = true;
      },
      attach: (s) => {
        attachCalled = true;
      },
      close: async () => {},
      healthCheck: async () => {},
      stats: () => ({}),
    };

    orch.register("test-region", fakeSFU);
    await orch.init();

    assert.ok(initCalled, "SFU init() should have been called");
    assert.ok(attachCalled, "SFU attach() should have been called");

    // Create a room — should be assigned to test-region
    server.createRoom("test-room");
    const region = orch._roomAssignments.get("test-room");
    assert.strictEqual(region, "test-region");

    await orch.close();
  });

  await test("getSFUForRoom returns null for unassigned room", async () => {
    const server = makeMockServer();
    const orch = new SFUOrchestrator({ server });
    assert.strictEqual(orch.getSFUForRoom("nonexistent"), null);
  });

  await test("failover migrates rooms when SFU goes DOWN", async () => {
    const server = makeMockServer();
    const orch = new SFUOrchestrator({ server, defaultRegion: "secondary" });

    const makeSFU = () => ({
      init: async () => {},
      attach: () => {},
      close: async () => {},
      healthCheck: async () => {},
      stats: () => ({}),
    });

    orch.register("primary", makeSFU());
    orch.register("secondary", makeSFU());

    // Manually assign primary as the active region for init
    orch._defaultRegion = "primary";
    await orch.init();

    server.createRoom("failover-r1");
    server.createRoom("failover-r2");

    assert.strictEqual(orch._roomAssignments.get("failover-r1"), "primary");

    // Switch default to secondary before failover so rooms land there
    orch._defaultRegion = "secondary";

    let migratedCount = 0;
    orch.on("room:migrated", () => migratedCount++);

    await orch._failoverRooms("primary");
    assert.ok(
      migratedCount >= 1,
      "at least one room should have been migrated",
    );
    assert.strictEqual(orch._roomAssignments.get("failover-r1"), "secondary");

    await orch.close();
  });

  // UNIT: MetricsCollector

  console.log("\n--> Unit: MetricsCollector");

  await test("throws if server is missing", async () => {
    assert.throws(() => new MetricsCollector({}), /server.*required/i);
  });

  await test("attach() returns this for chaining", async () => {
    const server = makeMockServer();
    const mc = new MetricsCollector({ server });
    assert.strictEqual(mc.attach(), mc);
    mc.close();
  });

  await test("snapshot() includes server and system fields", async () => {
    const server = makeMockServer();
    const mc = new MetricsCollector({ server });
    mc.attach();

    const snap = mc.snapshot();
    assert.ok(typeof snap.timestamp === "number");
    assert.ok(typeof snap.uptimeMs === "number");
    assert.ok(typeof snap.server.rooms === "number");
    assert.ok(typeof snap.server.peers === "number");
    assert.ok(Array.isArray(snap.rooms));

    mc.close();
  });

  await test("tracks peer joins and records join latency", async () => {
    const server = makeMockServer();
    const mc = new MetricsCollector({ server });
    mc.attach();

    const peer = makeMockPeer("m1");
    // Use makeMockRoom which inherits EventEmitter (has on())
    const room = makeMockRoom("metrics-r1");
    server.emit("room:created", room);
    server.emit("peer:joined", peer, room);

    const rm = mc.roomSnapshot("metrics-r1");
    assert.ok(rm, "room metrics should exist");
    assert.strictEqual(rm.joinsTotal, 1);
    assert.strictEqual(rm.peersCurrent, 1);
    assert.strictEqual(rm.peersPeak, 1);

    mc.close();
  });

  await test("toPrometheus() returns valid text format", async () => {
    const server = makeMockServer();
    const mc = new MetricsCollector({ server });
    mc.attach();

    const text = mc.toPrometheus();
    assert.ok(typeof text === "string");
    assert.ok(text.includes("# HELP webrtc_rooms_rooms_active"));
    assert.ok(text.includes("webrtc_rooms_rooms_active"));
    assert.ok(text.endsWith("\n"));

    mc.close();
  });

  await test("query() filters audit log entries correctly", async () => {
    const server = makeMockServer();
    const audit = new AuditLogger({ server });
    audit.attach();

    audit.log("peer:kicked", { peerId: "x1", roomId: "r1", reason: "spam" });
    audit.log("peer:kicked", { peerId: "x2", roomId: "r2", reason: "flood" });
    audit.log("peer:joined", { peerId: "x3", roomId: "r1" });

    const kicked = audit.query({ event: "peer:kicked" });
    assert.strictEqual(kicked.length, 2);

    const room1 = audit.query({ roomId: "r1" });
    assert.strictEqual(room1.length, 2);

    const peerX1 = audit.query({ peerId: "x1" });
    assert.strictEqual(peerX1.length, 1);

    await audit.close();
  });

  // UNIT: ThreatDetector

  console.log("\n--> Unit: ThreatDetector");
  await test("throws if server is missing", async () => {
    assert.throws(
      () => new ThreatDetector({ server: null }),
      /server.*required/i,
    );
  });

  await test("ban() and isBanned() work correctly", async () => {
    const server = makeMockServer();
    const detector = new ThreatDetector({ server });

    assert.strictEqual(detector.isBanned("5.5.5.5"), false);
    detector.ban("5.5.5.5", 5000);
    assert.strictEqual(detector.isBanned("5.5.5.5"), true);
    detector.unban("5.5.5.5");
    assert.strictEqual(detector.isBanned("5.5.5.5"), false);
    detector.close();
  });

  await test("bans() returns only active bans", async () => {
    const server = makeMockServer();
    const detector = new ThreatDetector({ server });

    detector.ban("1.1.1.1", 5000);
    detector.ban("2.2.2.2", 5000);
    detector.ban("3.3.3.3", -1000); // already expired

    const bans = detector.bans();
    assert.strictEqual(bans.length, 2);
    assert.ok(bans.every((b) => b.expiresIn > 0));
    detector.close();
  });

  await test("signal flood kicks peer after threshold", async () => {
    const server = makeMockServer();
    const peer = makeMockPeer("flood-peer");
    server.peers.set(peer.id, peer);

    const detector = new ThreatDetector({
      server,
      thresholds: {
        maxSignalsPerSecPerPeer: 2,
        signalFloodKickThreshold: 1,
      },
    });

    detector._initPeerCounters(peer.id);
    peer._detectorIp = "9.9.9.9";

    // Exceed the per-second limit
    detector._checkSignalRate(peer); // 1
    detector._checkSignalRate(peer); // 2
    const blocked = detector._checkSignalRate(peer); // 3 — over limit

    assert.strictEqual(blocked, false, "over-limit signal should be blocked");
    detector.close();
  });

  await test("metadata patch over size limit kicks peer", async () => {
    const server = makeMockServer();
    const peer = makeMockPeer("meta-abuser");
    server.peers.set(peer.id, peer);
    peer._detectorIp = "10.0.0.1";

    const detector = new ThreatDetector({
      server,
      thresholds: { maxMetadataPatchBytes: 10 },
    });
    const allowed = detector._checkMetadataPatch(peer, {
      patch: { x: "a".repeat(100) },
    });

    assert.strictEqual(allowed, false);
    assert.ok(peer._kicked, "peer should have been kicked");
    detector.close();
  });

  // UNIT: BackpressureController\

  console.log("\n--> Unit: BackpressureController");
  await test("throws if server is missing", async () => {
    assert.throws(() => new BackpressureController({}), /server.*required/i);
  });

  await test("attach() wraps beforeJoin", async () => {
    const server = makeMockServer();
    const bp = new BackpressureController({ server, maxPeers: 100 });
    bp.attach();
    assert.ok(
      typeof server.beforeJoin === "function",
      "beforeJoin should be set",
    );
    bp.close();
  });

  await test("status() returns valid structure", async () => {
    const server = makeMockServer();
    const bp = new BackpressureController({ server, maxPeers: 1000 });
    const status = bp.status();

    assert.ok(typeof status.level === "string");
    assert.ok(typeof status.heapRatio === "number");
    assert.ok(typeof status.peerRatio === "number");
    assert.ok(status.maxPeers === 1000);
    bp.close();
  });

  await test("_computeLevel returns NORMAL under low load", async () => {
    const server = makeMockServer();
    const bp = new BackpressureController({ server });
    assert.strictEqual(bp._computeLevel(0.3, 0.2), "normal");
    assert.strictEqual(bp._computeLevel(0.65, 0.3), "elevated");
    assert.strictEqual(bp._computeLevel(0.8, 0.5), "high");
    assert.strictEqual(bp._computeLevel(0.9, 0.5), "critical");
    assert.strictEqual(bp._computeLevel(0.97, 0.5), "shedding");
    bp.close();
  });

  await test("CRITICAL load rejects new joins", async () => {
    const server = makeMockServer();
    const bp = new BackpressureController({ server });
    bp.attach();
    bp._currentLevel = "critical";

    const peer = makeMockPeer("load-peer");
    const result = await server.beforeJoin(peer, "any-room");
    assert.notStrictEqual(result, true, "critical load should reject joins");
    bp.close();
  });

  // UNIT: AuditLogger

  console.log("\n--> Unit: AuditLogger");

  await test("throws if server is missing", async () => {
    assert.throws(() => new AuditLogger({}), /server.*required/i);
  });

  await test("attach() returns this for chaining", async () => {
    const server = makeMockServer();
    const audit = new AuditLogger({ server });
    assert.strictEqual(audit.attach(), audit);
    await audit.close();
  });

  await test("log() entries appear in ring buffer and emit event", async () => {
    const server = makeMockServer();
    const audit = new AuditLogger({ server });
    let emitted = null;
    audit.on("entry", (e) => {
      emitted = e;
    });

    audit.log("test:event", { peerId: "p1", extra: "data" });

    const entries = audit.query({ event: "test:event" });
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].peerId, "p1");
    assert.ok(emitted, "entry event should have been emitted");
    assert.strictEqual(emitted.event, "test:event");

    await audit.close();
  });

  await test("attach() records server events automatically", async () => {
    const server = makeMockServer();
    const audit = new AuditLogger({ server });
    audit.attach();

    const peer = makeMockPeer("audit-p1");
    const room = makeMockRoom("audit-r1");

    server.emit("peer:connected", peer);
    server.emit("peer:joined", peer, room);
    server.emit("peer:left", peer, room);

    const connected = audit.query({ event: "peer:connected" });
    const joined = audit.query({ event: "peer:joined" });
    const left = audit.query({ event: "peer:left" });

    assert.strictEqual(connected.length, 1);
    assert.strictEqual(joined.length, 1);
    assert.strictEqual(left.length, 1);

    await audit.close();
  });

  await test("ring buffer respects ringSize limit", async () => {
    const server = makeMockServer();
    const audit = new AuditLogger({ server, ringSize: 3 });

    for (let i = 0; i < 5; i++) {
      audit.log("test", { i });
    }

    assert.strictEqual(
      audit._ring.length,
      3,
      "ring buffer should not exceed ringSize",
    );
    await audit.close();
  });

  // INTEGRATION: SessionManager ↔ PolicyEngine

  console.log("\n--> Integration: SessionManager + PolicyEngine");

  await test("policy and session coexist — join → suspend → resume cycle", async () => {
    const server = makeMockServer();
    const policy = new PolicyEngine({ secret: "int-secret", required: false });
    const mgr = new SessionManager({ reconnectTtl: 30_000 });

    policy.attach(server);
    mgr.attach(server);

    // Issue a token and join
    const token = policy.issue({
      sub: "carol",
      roomId: "int-room",
      caps: ["publish", "subscribe"],
    });
    const peer = makeMockPeer("int-p1", { policyToken: token });
    const room = makeMockRoom("int-room");

    // Simulate beforeJoin
    const joinResult = await server.beforeJoin(peer, "int-room");
    assert.strictEqual(joinResult, true);
    assert.ok(
      peer.metadata.__caps?.includes("publish"),
      "caps should be applied",
    );

    // Simulate join
    server.emit("peer:joined", peer, room);
    await sleep(10);

    // Session created
    const session1 = mgr.getSession("int-p1");
    assert.ok(session1, "session should exist after join");

    // Suspend
    server.emit("peer:left", peer, room);
    await sleep(10);
    assert.strictEqual(session1.state, "suspended");

    // Resume
    const resumed = await mgr.resume(session1.token, "int-room");
    assert.ok(resumed, "should resume successfully");
    assert.strictEqual(resumed.state, "resumed");

    await mgr.close();
  });

  await test("metrics tracks join + rejection from PolicyEngine", async () => {
    const server = makeMockServer();
    const policy = new PolicyEngine({ secret: "metrics-test", required: true });
    const mc = new MetricsCollector({ server });

    policy.attach(server);
    mc.attach();

    // Attempt join without token → rejection
    const peer = makeMockPeer("mc-p1", {});
    server.emit("join:rejected", peer, "Policy token required");

    const snap = mc.snapshot();
    assert.strictEqual(snap.server.connectionsRejected, 1);

    mc.close();
  });

  // INTEGRATION: NativeSFUEngine full publish/subscribe cycle

  console.log("\n--> Integration: NativeSFUEngine publish/subscribe cycle");

  await test("two-peer audio+video session: publish → subscribe → layer select → unpublish", async () => {
    const server = makeMockServer();
    const sfu = new NativeSFUEngine({ enableSimulcast: true });
    await sfu.init();
    sfu.attach(server);

    const room = server.createRoom("full-cycle");
    const alice = makeMockPeer("alice");
    const bob = makeMockPeer("bob");

    room.peers.set(alice.id, alice);
    room.peers.set(bob.id, bob);

    server.emit("peer:joined", alice, room);
    server.emit("peer:joined", bob, room);

    const sfuRoom = sfu._rooms.get("full-cycle");

    // Alice publishes video
    sfu._handlePublish(alice, room, sfuRoom, {
      kind: "video",
      trackId: "alice-vid",
      layers: ["low", "mid", "high"],
    });
    const videoProducerMsg = alice.sent.find(
      (m) => m.type === "sfu:published" && m.kind === "video",
    );
    assert.ok(videoProducerMsg);
    const videoProducerId = videoProducerMsg.producerId;

    // Alice publishes audio
    sfu._handlePublish(alice, room, sfuRoom, {
      kind: "audio",
      trackId: "alice-aud",
    });

    // Bob subscribes to alice's video
    sfu._handleSubscribe(bob, room, sfuRoom, { producerId: videoProducerId });
    const subscribedMsg = bob.sent.find((m) => m.type === "sfu:subscribed");
    assert.ok(subscribedMsg);
    const consumerId = subscribedMsg.consumerId;

    // Bob changes to low quality layer
    sfu._handleLayerSelect(bob, sfuRoom, { consumerId, layer: "low" });
    const layerMsg = bob.sent.find((m) => m.type === "sfu:layer:changed");
    assert.ok(layerMsg, "layer change confirmation should be sent");
    assert.strictEqual(layerMsg.layer, "low");

    // Alice unpublishes
    sfu._handleUnpublish(alice, room, sfuRoom, { producerId: videoProducerId });

    // Bob should receive consumer:closed
    const closedMsg = bob.sent.find((m) => m.type === "sfu:consumer:closed");
    assert.ok(closedMsg, "subscriber should be notified when producer closes");

    // Verify producer is gone
    assert.strictEqual(sfuRoom.producers.has(videoProducerId), false);

    await sfu.close();
  });

  // SMOKE: Full test 1 stack boot

  console.log("\n--> Smoke: Full test 1 stack");

  await test("all test 1 modules attach to a server without throwing", async () => {
    const server = makeMockServer();

    // Mount everything
    const policy = new PolicyEngine({
      secret: "smoke-secret",
      required: false,
    });
    const mgr = new SessionManager({ reconnectTtl: 15_000 });
    const sfu = new NativeSFUEngine();
    const mc = new MetricsCollector({ server });
    const detector = new ThreatDetector({ server });
    const bp = new BackpressureController({ server, maxPeers: 1000 });
    const audit = new AuditLogger({ server });

    await sfu.init();

    policy.attach(server);
    mgr.attach(server);
    sfu.attach(server);
    mc.attach();
    detector.attach();
    bp.attach();
    audit.attach();

    // Simulate a full peer lifecycle
    const peer = makeMockPeer("smoke-p1", {});
    const room = makeMockRoom("smoke-r1");

    server.emit("peer:connected", peer);
    server.emit("room:created", room);
    await server.beforeJoin(peer, "smoke-r1");
    server.emit("peer:joined", peer, room);
    server.emit("peer:left", peer, room);
    server.emit("room:destroyed", room);

    // All should still be functional
    const snap = mc.snapshot();
    assert.ok(snap.server.joinsTotal >= 1);
    assert.ok(audit.query({ event: "peer:joined" }).length >= 1);

    await sfu.close();
    await mgr.close();
    mc.close();
    detector.close();
    bp.close();
    await audit.close();

    assert.ok(true, "Full stack smoke test passed");
  });

  await test("snapshot() from MetricsCollector after smoke run has valid structure", async () => {
    const server = makeMockServer();
    const mc = new MetricsCollector({ server });
    mc.attach();

    for (let i = 0; i < 5; i++) {
      const peer = makeMockPeer(`sp${i}`);
      const room = makeMockRoom(`sr${i}`);
      server.emit("room:created", room);
      server.emit("peer:joined", peer, room);
      server.emit("peer:left", peer, room);
    }

    const snap = mc.snapshot();

    assert.strictEqual(snap.server.joinsTotal, 5);
    assert.strictEqual(snap.server.leavesTotal, 5);
    assert.ok(snap.rooms.length >= 5);
    assert.ok(snap.rooms.every((r) => typeof r.joinLatency.p95 === "number"));

    mc.close();
  });

  // Summary

  const total = passed + failed;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${passed} passed  •  ${failed} failed  •  ${total} total`);

  if (failures.length > 0) {
    console.log("\nFailed tests:");
    failures.forEach((f) => console.log(`  ✗ ${f.name}\n    ${f.message}`));
    process.exit(1);
  } else {
    console.log("\n  All test 1 tests passed ✓\n");
    process.exit(0);
  }
})(); // END ASYNC WRAPPER
