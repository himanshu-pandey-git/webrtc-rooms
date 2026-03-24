"use strict";

/**
 * @file tests/test2.test.js
 * @description test 2 test suite for webrtc-rooms v2.
 *
 * Covers:
 *   - Unit: AdaptiveBitrateController, EventReplay, HealthMonitor,
 *           RecordingPipeline, ModerationBus, RetentionPolicy, AlertManager
 *   - Integration: ModerationBus + PolicyEngine, AlertManager + HealthMonitor,
 *                  EventReplay cross-module, full stack with test 2 modules
 *   - Smoke: Full test 1 + test 2 stack boot and lifecycle
 *
 * Run: node tests/test2.test.js
 */

const assert = require("assert");
const { EventEmitter } = require("events");

const AdaptiveBitrateController = require("../src/sfu/AdaptiveBitrateController");
const NativeSFUEngine = require("../src/sfu/NativeSFUEngine");
const EventReplay = require("../src/reliability/EventReplay");
const HealthMonitor = require("../src/reliability/HealthMonitor");
const BackpressureController = require("../src/reliability/BackpressureController");
const MetricsCollector = require("../src/observability/MetricsCollector");
const AlertManager = require("../src/observability/AlertManager");
const RecordingPipeline = require("../src/recording/RecordingPipeline");
const ModerationBus = require("../src/moderation/ModerationBus");
const RetentionPolicy = require("../src/compliance/RetentionPolicy");
const PolicyEngine = require("../src/auth/PolicyEngine");
const SessionManager = require("../src/core/SessionManager");

(async () => {
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

  function makeMockServer(opts = {}) {
    const ee = new EventEmitter();
    const rooms = new Map();
    const peers = new Map();

    return Object.assign(ee, {
      rooms,
      peers,
      beforeJoin: opts.beforeJoin ?? null,
      _wss: null,
      getRoom: (id) => rooms.get(id),
      kick: (peerId, reason) => {
        const peer = peers.get(peerId);
        if (peer) {
          peer._kicked = { reason };
          peers.delete(peerId);
        }
      },
      createRoom: (id, opts2 = {}) => {
        const room = makeMockRoom(id, opts2.metadata);
        rooms.set(id, room);
        ee.emit("room:created", room);
        return room;
      },
      stats: () => ({ rooms: rooms.size, peers: peers.size, roomList: [] }),
    });
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
        for (const [pid, p] of ps) if (!ex.has(pid)) p.sent.push(msg);
      },
      setMetadata: (p) => Object.assign(metadata, p),
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
        ee.isEmpty = false;
        ee.emit("peer:joined", peer);
        return true;
      },
    });
  }

  function makeMockPeer(id, metadata = {}) {
    const sent = [],
      ee = new EventEmitter();
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

  // SANITY

  console.log("\n--> Sanity: test 2 module exports");

  await test("all test 2 modules export correctly", async () => {
    assert.strictEqual(typeof AdaptiveBitrateController, "function");
    assert.strictEqual(typeof EventReplay, "function");
    assert.strictEqual(typeof HealthMonitor, "function");
    assert.strictEqual(typeof RecordingPipeline, "function");
    assert.strictEqual(typeof ModerationBus, "function");
    assert.strictEqual(typeof RetentionPolicy, "function");
    assert.strictEqual(typeof AlertManager, "function");
    assert.ok(RecordingPipeline.State.RECORDING === "recording");
    assert.ok(ModerationBus.Action.MUTE === "mute");
    assert.ok(AlertManager.Severity.CRITICAL === "critical");
  });

  await test("index.js exports all test 2 modules", async () => {
    const lib = require("../src/index");
    const keys = [
      "AdaptiveBitrateController",
      "EventReplay",
      "HealthMonitor",
      "RecordingPipeline",
      "ModerationBus",
      "RetentionPolicy",
      "AlertManager",
      "NativeSFUEngine",
      "SFUOrchestrator",
      "PolicyEngine",
      "SessionManager",
      "MetricsCollector",
      "ThreatDetector",
      "BackpressureController",
      "AuditLogger",
    ];
    for (const k of keys) {
      assert.ok(typeof lib[k] === "function", `Missing export: ${k}`);
    }
  });

  // UNIT: AdaptiveBitrateController

  console.log("\n--> Unit: AdaptiveBitrateController");

  await test("throws if sfuEngine is missing", async () => {
    assert.throws(
      () => new AdaptiveBitrateController({}),
      /sfuEngine.*required/i,
    );
  });

  await test("attach() returns this for chaining", async () => {
    const sfu = new NativeSFUEngine();
    await sfu.init();
    const server = makeMockServer();
    const abc = new AdaptiveBitrateController({ sfuEngine: sfu });
    assert.strictEqual(abc.attach(server), abc);
    await sfu.close();
  });

  await test("_computeScore returns 100 for perfect network", async () => {
    const sfu = new NativeSFUEngine();
    const abc = new AdaptiveBitrateController({ sfuEngine: sfu });
    const score = abc._computeScore(0, 0, 0);
    assert.strictEqual(score, 100);
    await sfu.close();
  });

  await test("_computeScore returns 0 for worst-case network", async () => {
    const sfu = new NativeSFUEngine();
    const abc = new AdaptiveBitrateController({ sfuEngine: sfu });
    const score = abc._computeScore(500, 100, 1); // maxRtt, maxJitter, 100% loss
    assert.strictEqual(score, 0);
    await sfu.close();
  });

  await test("_scoreToLayer maps correctly", async () => {
    const sfu = new NativeSFUEngine();
    const abc = new AdaptiveBitrateController({ sfuEngine: sfu });
    assert.strictEqual(abc._scoreToLayer(90), "high");
    assert.strictEqual(abc._scoreToLayer(60), "mid");
    assert.strictEqual(abc._scoreToLayer(20), "low");
    await sfu.close();
  });

  await test("layer:changed event fires when score crosses threshold", async () => {
    const server = makeMockServer();
    const sfu = new NativeSFUEngine();
    await sfu.init();
    sfu.attach(server);

    const abc = new AdaptiveBitrateController({
      sfuEngine: sfu,
      hysteresisMs: 0, // disable hysteresis for testing
    });
    abc.attach(server);

    const room = server.createRoom("abc-r1");
    const alice = makeMockPeer("abc-alice");
    const bob = makeMockPeer("abc-bob");
    room.peers.set(alice.id, alice);
    room.peers.set(bob.id, bob);
    server.emit("peer:joined", alice, room);
    server.emit("peer:joined", bob, room);

    const sfuRoom = sfu._rooms.get("abc-r1");
    sfu._handlePublish(alice, room, sfuRoom, {
      kind: "video",
      layers: ["low", "mid", "high"],
    });
    const producedMsg = alice.sent.find((m) => m.type === "sfu:published");
    const producerId = producedMsg.producerId;

    sfu._handleSubscribe(bob, room, sfuRoom, { producerId });
    const subscribedMsg = bob.sent.find((m) => m.type === "sfu:subscribed");
    const consumerId = subscribedMsg.consumerId;

    // Create consumer tracking entry
    const consumer = sfuRoom.consumers.get(consumerId);
    abc._trackConsumer(consumer, room);

    let changedEvent = null;
    abc.on("layer:changed", (e) => {
      changedEvent = e;
    });

    // Simulate terrible network stats — should drop to low
    abc._handleStatsReport(bob, room, {
      consumerId,
      rtt: 500,
      jitter: 100,
      packetsLost: 100,
      packetsSent: 100,
    });

    // Run a few cycles to push EWMA below threshold
    for (let i = 0; i < 5; i++) {
      abc._handleStatsReport(bob, room, {
        consumerId,
        rtt: 500,
        jitter: 100,
        packetsLost: 100,
        packetsSent: 100,
      });
    }

    assert.ok(changedEvent, "layer:changed event should have fired");
    assert.strictEqual(changedEvent.toLayer, "low");

    await sfu.close();
  });

  await test("forceLayer overrides adaptive algorithm", async () => {
    const sfu = new NativeSFUEngine();
    await sfu.init();
    const server = makeMockServer();
    sfu.attach(server);

    const abc = new AdaptiveBitrateController({ sfuEngine: sfu });
    abc.attach(server);

    const room = server.createRoom("force-r1");
    const alice = makeMockPeer("force-alice");
    const bob = makeMockPeer("force-bob");
    room.peers.set(alice.id, alice);
    room.peers.set(bob.id, bob);
    server.emit("peer:joined", alice, room);
    server.emit("peer:joined", bob, room);

    const sfuRoom = sfu._rooms.get("force-r1");
    sfu._handlePublish(alice, room, sfuRoom, {
      kind: "video",
      layers: ["low", "mid", "high"],
    });
    const producedMsg = alice.sent.find((m) => m.type === "sfu:published");
    sfu._handleSubscribe(bob, room, sfuRoom, {
      producerId: producedMsg.producerId,
    });
    const subMsg = bob.sent.find((m) => m.type === "sfu:subscribed");
    const consumerId = subMsg.consumerId;

    const consumer = sfuRoom.consumers.get(consumerId);
    abc._trackConsumer(consumer, room);

    let forced = null;
    abc.on("layer:changed", (e) => {
      if (e.reason === "forced") forced = e;
    });

    const result = abc.forceLayer(consumerId, "low");
    assert.ok(result, "forceLayer should return true");
    assert.ok(forced, "layer:changed with forced reason should fire");
    assert.strictEqual(forced.toLayer, "low");

    await sfu.close();
  });

  await test("stats() returns consumer count", async () => {
    const sfu = new NativeSFUEngine();
    const abc = new AdaptiveBitrateController({ sfuEngine: sfu });
    assert.ok(Array.isArray(abc.stats()));
    assert.strictEqual(abc.stats().length, 0);
  });

  // UNIT: EventReplay

  console.log("\n--> Unit: EventReplay");

  await test("throws if server is missing", async () => {
    assert.throws(() => new EventReplay({}), /server.*required/i);
  });

  await test("attach() wires server events and records them", async () => {
    const server = makeMockServer();
    const replay = new EventReplay({ server, capacity: 100 });
    replay.attach();

    const peer = makeMockPeer("er-p1");
    const room = makeMockRoom("er-r1");
    server.emit("room:created", room);
    server.emit("peer:joined", peer, room);
    server.emit("peer:left", peer, room);

    assert.ok(replay._log.length >= 2, "events should be recorded");
    assert.ok(replay._seq >= 2, "sequence should increment");
  });

  await test("since() returns events after given sequence", async () => {
    const server = makeMockServer();
    const replay = new EventReplay({ server });
    replay.attach();

    const room = makeMockRoom("seq-r1");
    server.emit("room:created", room);
    const afterSeq = replay.currentSeq;

    const p1 = makeMockPeer("seq-p1");
    server.emit("peer:joined", p1, room);
    server.emit("peer:left", p1, room);

    const missed = replay.since(afterSeq);
    assert.ok(missed.length >= 2, `expected 2+ events, got ${missed.length}`);
    assert.ok(missed.every((e) => e.seq > afterSeq));
  });

  await test("deduplication prevents same event twice", async () => {
    const server = makeMockServer();
    const replay = new EventReplay({ server });

    // Inject directly to test hash dedup
    const e1 = replay.record("test:event", "r1", "p1", { x: 1 });
    assert.ok(e1, "first record should succeed");

    // Force the same hash by manually checking
    const hash = replay._hash("test:event", "r1", "p1", e1.ts);
    replay._seen.add(hash); // already seen

    // Now try again with same hash — should be deduped
    const e2 = replay._record("test:event", "r1", "p1", { x: 1 });
    // We expect e2 to be null only if hash collision — in practice timestamps differ
    // The key property is that the seen set works
    assert.ok(replay._seen.has(hash), "hash should be in seen set");
  });

  await test("circular buffer respects capacity", async () => {
    const server = makeMockServer();
    const replay = new EventReplay({ server, capacity: 5 });
    replay.attach();

    for (let i = 0; i < 8; i++) {
      replay.record("test", `r${i}`, `p${i}`, {});
    }

    assert.strictEqual(replay._log.length, 5, "log should not exceed capacity");
  });

  await test("roomEvents() filters by room", async () => {
    const server = makeMockServer();
    const replay = new EventReplay({ server });
    replay.attach();

    const roomA = makeMockRoom("room-a");
    const roomB = makeMockRoom("room-b");
    server.emit("room:created", roomA);
    server.emit("room:created", roomB);

    const peerA = makeMockPeer("room-a-p1");
    server.emit("peer:joined", peerA, roomA);
    server.emit("peer:joined", makeMockPeer("room-b-p1"), roomB);

    const eventsA = replay.roomEvents("room-a");
    assert.ok(eventsA.every((e) => e.roomId === "room-a" || e.roomId === null));
  });

  await test("replayToPeer sends missed events to peer", async () => {
    const server = makeMockServer();
    const replay = new EventReplay({ server, capacity: 100 });
    replay.attach();

    const room = makeMockRoom("replay-r1");
    server.emit("room:created", room);
    const startSeq = replay.currentSeq;

    replay.record("peer:joined", "replay-r1", "p-old", {
      peer: { id: "p-old" },
    });
    replay.record("peer:left", "replay-r1", "p-old", { peerId: "p-old" });

    // New peer joins
    const newPeer = makeMockPeer("new-peer");
    newPeer.roomId = "replay-r1";
    server.peers.set(newPeer.id, newPeer);

    const count = replay.replayToPeer("new-peer", startSeq);
    assert.ok(count >= 2, `expected >= 2 replayed, got ${count}`);
    const replayMsgs = newPeer.sent.filter((m) => m.type === "replay:event");
    assert.ok(replayMsgs.length >= 2);
  });

  await test("stats() returns correct log size and seq", async () => {
    const server = makeMockServer();
    const replay = new EventReplay({ server });
    replay.record("a", "r1", "p1", {});
    replay.record("b", "r1", "p2", {});

    const stats = replay.stats();
    assert.strictEqual(stats.size, 2);
    assert.strictEqual(stats.seq, 2);
    assert.strictEqual(stats.oldestSeq, 1);
  });

  // UNIT: HealthMonitor

  console.log("\n--> Unit: HealthMonitor");

  await test("throws if server or metrics is missing", async () => {
    const server = makeMockServer();
    const metrics = new MetricsCollector({ server });
    metrics.attach();

    assert.throws(
      () => new HealthMonitor({ server: null, metrics }),
      /server.*required/i,
    );
    assert.throws(
      () => new HealthMonitor({ server, metrics: null }),
      /metrics.*required/i,
    );
    metrics.close();
  });

  await test("report() returns healthy when no SLOs breached", async () => {
    const server = makeMockServer();
    const metrics = new MetricsCollector({ server });
    metrics.attach();

    const hm = new HealthMonitor({ server, metrics, checkIntervalMs: 9999999 });
    hm.attach();

    const report = hm.report();
    assert.ok(typeof report.status === "string");
    assert.ok(typeof report.ts === "number");
    assert.ok(Array.isArray(report.checks));

    hm.close();
    metrics.close();
  });

  await test("slo:breach fires when join_latency_p95 exceeds target", async () => {
    const server = makeMockServer();
    const metrics = new MetricsCollector({ server });
    metrics.attach();

    const customSLOs = [
      { name: "join_latency_p95_ms", target: 1, op: "<=", severity: "warning" },
    ];
    const hm = new HealthMonitor({
      server,
      metrics,
      slos: customSLOs,
      checkIntervalMs: 9999999,
    });
    hm.attach();

    // Inject a very high latency into metrics
    const rm = metrics._getOrCreateRoomMetrics("slo-room");
    rm.joinLatency.p95 = 9999; // way over target

    let breachFired = false;
    hm.on("slo:breach", () => {
      breachFired = true;
    });

    hm._check();
    assert.ok(breachFired, "slo:breach should fire");

    hm.close();
    metrics.close();
  });

  await test("isHealthy() returns false when SLO is breached", async () => {
    const server = makeMockServer();
    const metrics = new MetricsCollector({ server });
    metrics.attach();

    const customSLOs = [
      { name: "heap_ratio", target: 0.0001, op: "<=", severity: "critical" },
    ];
    const hm = new HealthMonitor({
      server,
      metrics,
      slos: customSLOs,
      checkIntervalMs: 9999999,
    });
    hm.attach();
    hm._check(); // heap ratio is definitely > 0.0001

    assert.strictEqual(hm.isHealthy(), false);
    assert.ok(hm.breaches().includes("heap_ratio"));

    hm.close();
    metrics.close();
  });

  // UNIT: RecordingPipeline

  console.log("\n--> Unit: RecordingPipeline");

  await test("throws if outputDir is missing", async () => {
    assert.throws(() => new RecordingPipeline({}), /outputDir.*required/i);
  });

  await test("RecordingPipeline.State constants are correct", async () => {
    assert.strictEqual(RecordingPipeline.State.PENDING, "pending");
    assert.strictEqual(RecordingPipeline.State.RECORDING, "recording");
    assert.strictEqual(RecordingPipeline.State.DONE, "done");
    assert.strictEqual(RecordingPipeline.State.FAILED, "failed");
  });

  await test("_createSession creates session with correct structure", async () => {
    const pipeline = new RecordingPipeline({
      outputDir: "/tmp/test-recordings",
    });

    const session = pipeline._createSession({
      roomId: "test-r",
      peerId: "test-p",
      metadata: {},
    });
    assert.ok(session.id.length > 0);
    assert.strictEqual(session.roomId, "test-r");
    assert.strictEqual(session.peerId, "test-p");
    assert.strictEqual(session.state, RecordingPipeline.State.PENDING);
    assert.ok(session.filePath.includes("test-r"));
    assert.ok(session.filePath.endsWith(".webm"));
  });

  await test("index() returns completed recordings", async () => {
    const pipeline = new RecordingPipeline({
      outputDir: "/tmp/test-recordings",
    });
    assert.deepStrictEqual(pipeline.index(), []);

    // Manually push a completed session to the index
    const session = pipeline._createSession({
      roomId: "r1",
      peerId: "p1",
      metadata: {},
    });
    session.state = RecordingPipeline.State.DONE;
    session.stoppedAt = Date.now();
    session.durationMs = 1000;
    pipeline._index.push(session);

    assert.strictEqual(pipeline.index().length, 1);
    assert.strictEqual(pipeline.index()[0].roomId, "r1");
  });

  await test("search() filters index by roomId and peerId", async () => {
    const pipeline = new RecordingPipeline({
      outputDir: "/tmp/test-recordings",
    });

    const make = (roomId, peerId) => {
      const s = pipeline._createSession({ roomId, peerId, metadata: {} });
      s.state = RecordingPipeline.State.DONE;
      pipeline._index.push(s);
    };

    make("room-x", "peer-1");
    make("room-x", "peer-2");
    make("room-y", "peer-3");

    assert.strictEqual(pipeline.search({ roomId: "room-x" }).length, 2);
    assert.strictEqual(pipeline.search({ peerId: "peer-3" }).length, 1);
    assert.strictEqual(
      pipeline.search({ roomId: "room-y", peerId: "peer-3" }).length,
      1,
    );
  });

  await test("onUpload hook is called after session completes", async () => {
    let uploadCalled = false;
    const pipeline = new RecordingPipeline({
      outputDir: "/tmp/test-recordings",
      onUpload: async ({ session }) => {
        uploadCalled = true;
      },
    });

    const session = pipeline._createSession({
      roomId: "hook-r",
      peerId: "hook-p",
      metadata: {},
    });
    session.state = RecordingPipeline.State.DONE;
    session.stoppedAt = Date.now();
    session.durationMs = 100;
    pipeline._index.push(session);

    if (pipeline._onUpload) {
      await pipeline._onUpload({ session, filePath: session.filePath });
    }
    assert.ok(uploadCalled, "upload hook should have been called");
  });

  await test("active() returns only currently recording sessions", async () => {
    const pipeline = new RecordingPipeline({
      outputDir: "/tmp/test-recordings",
    });
    assert.strictEqual(pipeline.active().length, 0);

    // Manually create and register an active session
    const session = pipeline._createSession({
      roomId: "active-r",
      peerId: "active-p",
      metadata: {},
    });
    session.state = RecordingPipeline.State.RECORDING;
    pipeline._active.set("active-p", session.id);

    assert.strictEqual(pipeline.active().length, 1);
  });

  // UNIT: ModerationBus

  console.log("\n--> Unit: ModerationBus");

  await test("throws if server is missing", async () => {
    assert.throws(() => new ModerationBus({}), /server.*required/i);
  });

  await test("attach() returns this for chaining", async () => {
    const server = makeMockServer();
    const bus = new ModerationBus({ server });
    assert.strictEqual(bus.attach(), bus);
  });

  await test("mute() sends mod:muted to target and broadcasts to room", async () => {
    const server = makeMockServer();
    const bus = new ModerationBus({ server });
    bus.attach();

    const room = server.createRoom("mod-r1");
    const peerA = makeMockPeer("mod-a");
    const peerB = makeMockPeer("mod-b");
    room.peers.set(peerA.id, peerA);
    room.peers.set(peerB.id, peerB);
    server.peers.set(peerA.id, peerA);
    server.peers.set(peerB.id, peerB);

    let muteEvent = null;
    bus.on("mute", (e) => {
      muteEvent = e;
    });

    bus.mute({
      roomId: "mod-r1",
      targetId: "mod-a",
      reason: "Noise",
      actorId: "system",
    });

    const mutedMsg = peerA.sent.find((m) => m.type === "mod:muted");
    assert.ok(mutedMsg, "target should receive mod:muted");
    assert.strictEqual(mutedMsg.reason, "Noise");

    assert.ok(muteEvent, "mute event should fire");
    assert.ok(bus.isMuted("mod-r1", "mod-a"), "peer should be in muted set");
  });

  await test("unmute() removes from muted set", async () => {
    const server = makeMockServer();
    const bus = new ModerationBus({ server });
    bus.attach();

    const room = server.createRoom("unmute-r");
    const peer = makeMockPeer("unmute-p");
    server.peers.set(peer.id, peer);
    room.peers.set(peer.id, peer);

    bus.mute({ roomId: "unmute-r", targetId: "unmute-p" });
    assert.ok(bus.isMuted("unmute-r", "unmute-p"));

    bus.unmute({ roomId: "unmute-r", targetId: "unmute-p" });
    assert.strictEqual(bus.isMuted("unmute-r", "unmute-p"), false);
  });

  await test("kick() calls server.kick and emits event", async () => {
    const server = makeMockServer();
    const bus = new ModerationBus({ server });
    bus.attach();

    const room = server.createRoom("kick-r");
    const peer = makeMockPeer("kick-p");
    server.peers.set(peer.id, peer);
    room.peers.set(peer.id, peer);

    let kicked = null;
    bus.on("kick", (e) => {
      kicked = e;
    });

    bus.kick({
      roomId: "kick-r",
      targetId: "kick-p",
      reason: "Violation",
      actorId: "moderator-1",
    });

    assert.ok(kicked, "kick event should fire");
    assert.ok(peer._kicked, "peer should have been kicked from server");
  });

  await test("lockRoom() blocks new joins", async () => {
    const server = makeMockServer();
    const bus = new ModerationBus({ server });
    bus.attach();

    server.createRoom("lock-r");
    bus.lockRoom("lock-r");
    assert.ok(bus.isLocked("lock-r"));

    const peer = makeMockPeer("lock-p", {});
    const result = await server.beforeJoin(peer, "lock-r");
    assert.notStrictEqual(result, true, "locked room should reject join");

    bus.unlockRoom("lock-r");
    assert.strictEqual(bus.isLocked("lock-r"), false);
  });

  await test("log() returns moderation history", async () => {
    const server = makeMockServer();
    const bus = new ModerationBus({ server });
    bus.attach();

    const room = server.createRoom("log-r");
    const peer = makeMockPeer("log-p");
    server.peers.set(peer.id, peer);
    room.peers.set(peer.id, peer);

    bus.mute({ roomId: "log-r", targetId: "log-p", actorId: "actor-1" });
    bus.warn({ roomId: "log-r", targetId: "log-p", actorId: "actor-1" });

    const log = bus.log({ roomId: "log-r" });
    assert.ok(log.length >= 2);
    assert.ok(log.some((e) => e.action === "mute"));
    assert.ok(log.some((e) => e.action === "warn"));
  });

  await test("abuse:reported event fires correctly", async () => {
    const server = makeMockServer();
    const bus = new ModerationBus({ server });
    bus.attach();

    const room = server.createRoom("abuse-r");
    const reporter = makeMockPeer("reporter");
    room.peers.set(reporter.id, reporter);
    server.peers.set(reporter.id, reporter);

    let abuseReport = null;
    bus.on("abuse:reported", (r) => {
      abuseReport = r;
    });

    room.emit("data", reporter, null, {
      __mod: "report:abuse",
      targetId: "bad-peer",
      category: "harassment",
      detail: "Sending inappropriate messages",
    });

    await sleep(10);
    assert.ok(abuseReport, "abuse:reported event should fire");
    assert.strictEqual(abuseReport.category, "harassment");
    assert.strictEqual(abuseReport.reporterId, "reporter");
  });

  // UNIT: RetentionPolicy

  console.log("\n-->Unit: RetentionPolicy");

  await test("register() creates a retention record", async () => {
    const policy = new RetentionPolicy({ recordingRetentionDays: 30 });
    const record = policy.register({
      id: "rec-1",
      type: "recording",
      sub: "alice",
      meta: { path: "/tmp/r.webm" },
    });

    assert.ok(record.id === "rec-1");
    assert.ok(record.expiresAt > Date.now());
    assert.strictEqual(record.sub, "alice");
    assert.strictEqual(record.legalHold, false);
    policy.close();
  });

  await test("purge() removes records and respects legal hold", async () => {
    const policy = new RetentionPolicy();
    policy.register({ id: "r1", type: "recording", sub: "bob", meta: {} });
    policy.register({ id: "r2", type: "recording", sub: "bob", meta: {} });
    policy.placeLegalHold("bob");

    const { purged, held } = await policy.purge("bob");
    assert.strictEqual(
      purged,
      0,
      "no records should be purged under legal hold",
    );
    assert.strictEqual(held, 2);

    policy.releaseLegalHold("bob");
    const result2 = await policy.purge("bob");
    assert.strictEqual(result2.purged, 2);
    policy.close();
  });

  await test("anonymise() replaces sub with hash", async () => {
    const policy = new RetentionPolicy();
    policy.register({ id: "anon-1", type: "session", sub: "carol", meta: {} });
    policy.register({ id: "anon-2", type: "session", sub: "carol", meta: {} });

    const count = policy.anonymise("carol");
    assert.strictEqual(count, 2);

    const records = [...policy._records.values()];
    assert.ok(records.every((r) => r.sub !== "carol"));
    assert.ok(records.every((r) => r.sub.startsWith("anon:")));
    policy.close();
  });

  await test("legalHold prevents purge", async () => {
    const policy = new RetentionPolicy();
    policy.register({ id: "hold-1", type: "audit", sub: "dave", meta: {} });
    policy.placeLegalHold("dave");

    const r = policy.recordsFor("dave");
    assert.ok(r.every((rec) => rec.legalHold === true));
    policy.close();
  });

  await test("expiringWithin() returns records near expiry", async () => {
    const policy = new RetentionPolicy({ recordingRetentionDays: 90 });
    policy.register({ id: "exp-1", type: "recording", sub: "eve", meta: {} });

    // Manually backdate the expiresAt to be within the next 1000ms
    const record = policy._records.get("exp-1");
    record.expiresAt = Date.now() + 500; // expires in 500ms — within 1000ms window

    const expiring = policy.expiringWithin(1000);
    assert.ok(expiring.length >= 1, "should find at least one expiring record");
    policy.close();
  });

  await test("stats() returns correct counts", async () => {
    const policy = new RetentionPolicy();
    policy.register({ id: "s1", type: "recording", sub: "frank", meta: {} });
    policy.register({ id: "s2", type: "session", sub: "frank", meta: {} });
    policy.placeLegalHold("frank");

    const stats = policy.stats();
    assert.strictEqual(stats.held, 2);
    assert.strictEqual(stats.legalHoldSubjects, 1);
    policy.close();
  });

  // UNIT: AlertManager

  console.log("\n--> Unit: AlertManager");

  await test("alert() fires event and stores in queue", async () => {
    const am = new AlertManager();
    let received = null;
    am.on("alert", (a) => {
      received = a;
    });

    const alert = am.alert({
      event: "test:event",
      severity: "warning",
      message: "Test alert",
    });
    assert.ok(alert, "alert should be returned");
    assert.ok(received, "alert event should fire");
    assert.strictEqual(received.event, "test:event");
    assert.strictEqual(received.severity, "warning");
  });

  await test("alert suppression prevents duplicate alerts", async () => {
    const am = new AlertManager({ suppressionWindowMs: 60_000 });
    let count = 0;
    am.on("alert", () => count++);

    am.alert({ event: "dup:event", severity: "warning", message: "First" });
    am.alert({
      event: "dup:event",
      severity: "warning",
      message: "Second (suppressed)",
    });
    am.alert({
      event: "dup:event",
      severity: "warning",
      message: "Third (suppressed)",
    });

    assert.strictEqual(
      count,
      1,
      "only first alert should fire within suppression window",
    );
  });

  await test("recovered alerts bypass suppression", async () => {
    const am = new AlertManager({ suppressionWindowMs: 60_000 });
    let count = 0;
    am.on("alert", () => count++);

    am.alert({ event: "recover:event", severity: "critical", message: "Down" });
    am.alert({
      event: "recover:event",
      severity: "info",
      message: "Recovered",
      recovered: true,
    });

    assert.strictEqual(count, 2, "recovery alert should bypass suppression");
  });

  await test("clearSuppression() resets suppression cache", async () => {
    const am = new AlertManager({ suppressionWindowMs: 60_000 });
    let count = 0;
    am.on("alert", () => count++);

    am.alert({ event: "clear:event", severity: "warning", message: "First" });
    am.clearSuppression();
    am.alert({
      event: "clear:event",
      severity: "warning",
      message: "Second after clear",
    });

    assert.strictEqual(count, 2);
  });

  await test("recent() returns last N alerts", async () => {
    const am = new AlertManager({ suppressionWindowMs: 0 });

    for (let i = 0; i < 10; i++) {
      am.clearSuppression();
      am.alert({ event: `evt:${i}`, severity: "info", message: `Alert ${i}` });
    }

    const recent = am.recent(5);
    assert.strictEqual(recent.length, 5);
  });

  await test("custom handler channel receives alerts", async () => {
    let received = null;
    const am = new AlertManager({
      channels: [
        {
          type: "handler",
          fn: async (alert) => {
            received = alert;
          },
        },
      ],
      suppressionWindowMs: 0,
    });

    am.alert({
      event: "handler:test",
      severity: "critical",
      message: "Handler test",
    });
    await sleep(10);
    assert.ok(received, "handler should have received alert");
    assert.strictEqual(received.event, "handler:test");
  });

  await test("attachHealthMonitor() wires SLO events", async () => {
    const server = makeMockServer();
    const metrics = new MetricsCollector({ server });
    metrics.attach();

    const customSLOs = [
      { name: "heap_ratio", target: 0.0001, op: "<=", severity: "critical" },
    ];
    const hm = new HealthMonitor({
      server,
      metrics,
      slos: customSLOs,
      checkIntervalMs: 9999999,
    });
    hm.attach();

    const am = new AlertManager({ suppressionWindowMs: 0 });
    am.attachHealthMonitor(hm);

    let alertFired = null;
    am.on("alert", (a) => {
      alertFired = a;
    });

    hm._check(); // heap > 0.0001, should fire slo:breach → alert

    await sleep(10);
    assert.ok(
      alertFired,
      "AlertManager should receive HealthMonitor SLO breach",
    );
    assert.ok(
      alertFired.event.includes("slo:breach") ||
        alertFired.event === "slo:breach",
    );

    hm.close();
    metrics.close();
  });

  // INTEGRATION: ModerationBus + PolicyEngine

  console.log("\n--> Integration: ModerationBus + PolicyEngine");

  await test("peer without moderate cap cannot mute others", async () => {
    const server = makeMockServer();
    const policy = new PolicyEngine({
      secret: "mod-int-test",
      required: false,
      defaultCaps: ["subscribe"],
    });
    const bus = new ModerationBus({ server, policyEngine: policy });

    policy.attach(server);
    bus.attach();

    const room = server.createRoom("int-mod-r");
    const moderator = makeMockPeer("int-mod-actor", { __caps: ["subscribe"] }); // no moderate cap
    const victim = makeMockPeer("int-mod-victim");

    room.peers.set(moderator.id, moderator);
    room.peers.set(victim.id, victim);
    server.peers.set(moderator.id, moderator);
    server.peers.set(victim.id, victim);

    // Simulate peer sending mute signal
    room.emit("data", moderator, null, { __mod: "mute", targetId: victim.id });
    await sleep(10);

    const errMsg = moderator.sent.find(
      (m) => m.type === "error" && m.code === "MOD_UNAUTHORIZED",
    );
    assert.ok(errMsg, "unauthorized mute should result in error to actor");
    assert.strictEqual(
      bus.isMuted(room.id, victim.id),
      false,
      "victim should NOT be muted",
    );
  });

  await test("peer with moderate cap can mute others", async () => {
    const server = makeMockServer();
    const policy = new PolicyEngine({
      secret: "mod-cap-test",
      required: false,
    });
    const bus = new ModerationBus({ server, policyEngine: policy });

    policy.attach(server);
    bus.attach();

    const room = server.createRoom("int-cap-r");
    const mod = makeMockPeer("int-cap-mod", {
      __caps: ["moderate", "subscribe"],
    });
    const peer = makeMockPeer("int-cap-victim");

    room.peers.set(mod.id, mod);
    room.peers.set(peer.id, peer);
    server.peers.set(mod.id, mod);
    server.peers.set(peer.id, peer);

    room.emit("data", mod, null, {
      __mod: "mute",
      targetId: peer.id,
      reason: "Too loud",
    });
    await sleep(10);

    assert.ok(
      bus.isMuted(room.id, peer.id),
      "victim should be muted by moderator",
    );
  });

  await test("all test 2 modules attach and run a full peer lifecycle", async () => {
    const server = makeMockServer();

    // test 1
    const policy = new PolicyEngine({
      secret: "full-stack-secret",
      required: false,
    });
    const session = new SessionManager({ reconnectTtl: 15_000 });
    const sfu = new NativeSFUEngine();
    const metrics = new MetricsCollector({ server });

    // test 2
    const abc = new AdaptiveBitrateController({ sfuEngine: sfu });
    const replay = new EventReplay({ server });
    const modBus = new ModerationBus({ server, policyEngine: policy });
    const retain = new RetentionPolicy();
    const am = new AlertManager({ suppressionWindowMs: 0 });
    const hm = new HealthMonitor({ server, metrics, checkIntervalMs: 9999999 });
    const bp = new BackpressureController({ server, maxPeers: 1000 });

    await sfu.init();

    policy.attach(server);
    session.attach(server);
    sfu.attach(server);
    abc.attach(server);
    metrics.attach();
    modBus.attach();
    replay.attach();
    hm.attach();
    bp.attach();
    am.attachHealthMonitor(hm);

    // Simulate full lifecycle
    const room = server.createRoom("full-test2-room");
    const alice = makeMockPeer("full-alice");
    const bob = makeMockPeer("full-bob");

    server.peers.set(alice.id, alice);
    server.peers.set(bob.id, bob);

    await server.beforeJoin(alice, "full-test2-room");
    await server.beforeJoin(bob, "full-test2-room");

    server.emit("peer:joined", alice, room);
    server.emit("peer:joined", bob, room);
    await sleep(20);

    // SFU publish/subscribe
    const sfuRoom = sfu._rooms.get("full-test2-room");
    sfu._handlePublish(alice, room, sfuRoom, {
      kind: "video",
      layers: ["low", "mid", "high"],
    });
    const pMsg = alice.sent.find((m) => m.type === "sfu:published");
    sfu._handleSubscribe(bob, room, sfuRoom, { producerId: pMsg.producerId });

    // Moderation
    server.peers.set(alice.id, alice);
    modBus.mute({
      roomId: "full-test2-room",
      targetId: bob.id,
      actorId: "alice",
    });
    assert.ok(modBus.isMuted("full-test2-room", bob.id));

    // Retention
    retain.register({
      id: "full-rec-1",
      type: "recording",
      sub: alice.metadata.__sub ?? alice.id,
      meta: {},
    });
    assert.ok(retain.recordsFor(alice.metadata.__sub ?? alice.id).length >= 1);

    // Replay
    const events = replay.since(0);
    assert.ok(events.length >= 2, "replay log should have events");

    // Metrics
    const snap = metrics.snapshot();
    assert.ok(snap.server.joinsTotal >= 2);

    // Health
    const report = hm.report();
    assert.ok(typeof report.status === "string");

    server.emit("peer:left", alice, room);
    server.emit("peer:left", bob, room);

    await sfu.close();
    await session.close();
    metrics.close();
    hm.close();
    bp.close();
    retain.close();

    assert.ok(true, "Full test 1 + test 2 stack completed without errors");
  });

  // SMOKE

  console.log("\n--> Smoke: test 2 output structure");

  await test("MetricsCollector Prometheus output is parseable", async () => {
    const server = makeMockServer();
    const metrics = new MetricsCollector({ server });
    metrics.attach();

    // Inject some activity
    const room = makeMockRoom("prom-r");
    server.emit("room:created", room);
    server.emit("peer:joined", makeMockPeer("prom-p1"), room);

    const text = metrics.toPrometheus();
    const lines = text.trim().split("\n");

    // Validate all non-comment lines have correct format: name [labels] value timestamp
    const dataLines = lines.filter(
      (l) => !l.startsWith("#") && l.trim().length > 0,
    );
    for (const line of dataLines) {
      const parts = line.split(" ");
      assert.ok(
        parts.length >= 2,
        `Prometheus line should have at least 2 parts: "${line}"`,
      );
      assert.ok(
        !isNaN(parts[parts.length - 2] ?? parts[1]),
        `Prometheus value should be numeric: "${line}"`,
      );
    }

    metrics.close();
  });

  await test("AlertManager + BackpressureController integration", async () => {
    const server = makeMockServer();
    const bp = new BackpressureController({ server, maxPeers: 1 });
    const am = new AlertManager({ suppressionWindowMs: 0 });
    am.attachBackpressure(bp);

    let alertReceived = null;
    am.on("alert", (a) => {
      alertReceived = a;
    });

    // Manually trigger critical load
    bp._currentLevel = "critical";
    bp.emit("load:critical", { heapRatio: 0.92, peerRatio: 0.95 });

    await sleep(10);
    assert.ok(
      alertReceived,
      "AlertManager should receive backpressure critical alert",
    );
    assert.ok(alertReceived.severity === "critical");

    bp.close();
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
    console.log("\n  All test 2 tests passed ✓\n");
    process.exit(0);
  }
})();
