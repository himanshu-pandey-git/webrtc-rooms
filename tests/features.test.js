"use strict";

/**
 * @file tests/features.test.js
 * @description Tests for RoomToken, TurnCredentials, WebhookDispatcher,
 * AdminAPI extensions (mute-all, metrics, recordings), and
 * SignalingServer apiSecret + turn integration.
 *
 * Run: node tests/features.test.js
 */

const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");
const { EventEmitter } = require("events");

const {
  RoomToken,
  TurnCredentials,
  WebhookDispatcher,
  AdminAPI,
  createServer,
  Room,
  Peer,
} = require("../src");

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0,
    failed = 0;
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
    return new Promise((r) => setTimeout(r, ms));
  }

  function connect(port) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      ws.on("error", reject);
      ws.on("message", function f(raw) {
        const msg = JSON.parse(raw);
        if (msg.type === "connected") {
          ws.removeListener("message", f);
          resolve({ ws, peerId: msg.peerId });
        }
      });
    });
  }

  function waitFor(ws, pred, ms = 3000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("waitFor timeout")), ms);
      function h(raw) {
        const msg = JSON.parse(raw);
        if (pred(msg)) {
          clearTimeout(t);
          ws.removeListener("message", h);
          resolve(msg);
        }
      }
      ws.on("message", h);
    });
  }

  const API_SECRET = crypto.randomBytes(32).toString("hex");

  // ---------------------------------------------------------------------------
  // RoomToken
  // ---------------------------------------------------------------------------

  console.log("\nRoomToken");

  await test("throws if apiSecret is missing", async () => {
    assert.throws(() => new RoomToken(), /apiSecret/);
  });

  await test("throws if apiSecret is too short", async () => {
    assert.throws(() => new RoomToken("short"), /32 characters/);
  });

  await test("throws if forRoom() not called before toJWT()", async () => {
    assert.throws(
      () => new RoomToken(API_SECRET).forPeer("alice").toJWT(),
      /forRoom/,
    );
  });

  await test("throws if forPeer() not called before toJWT()", async () => {
    assert.throws(
      () => new RoomToken(API_SECRET).forRoom("standup").toJWT(),
      /forPeer/,
    );
  });

  await test("toJWT() produces a valid 3-part JWT", async () => {
    const token = new RoomToken(API_SECRET)
      .forRoom("standup")
      .forPeer("alice")
      .toJWT();
    const parts = token.split(".");
    assert.strictEqual(parts.length, 3, "JWT must have 3 parts");
    // Header must decode to { alg: HS256, typ: JWT }
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    assert.strictEqual(header.alg, "HS256");
    assert.strictEqual(header.typ, "JWT");
  });

  await test("verify() decodes a valid token", async () => {
    const token = new RoomToken(API_SECRET)
      .forRoom("standup")
      .forPeer("alice")
      .canPublish()
      .canSubscribe()
      .withMetadata({ displayName: "Alice", role: "admin" })
      .toJWT();

    const claims = RoomToken.verify(token, API_SECRET);
    assert.strictEqual(claims.room, "standup");
    assert.strictEqual(claims.sub, "alice");
    assert.strictEqual(claims.pub, true);
    assert.strictEqual(claims.sub_media, true);
    assert.strictEqual(claims.meta.displayName, "Alice");
    assert.strictEqual(claims.meta.role, "admin");
  });

  await test("verify() rejects tampered signature", async () => {
    const token = new RoomToken(API_SECRET).forRoom("r").forPeer("p").toJWT();
    const parts = token.split(".");
    const bad = parts[0] + "." + parts[1] + ".invalidsignature";
    assert.throws(() => RoomToken.verify(bad, API_SECRET), /Invalid signature/);
  });

  await test("verify() rejects expired token", async () => {
    const token = new RoomToken(API_SECRET)
      .forRoom("r")
      .forPeer("p")
      .expires("1s")
      .toJWT();
    await sleep(1100);
    assert.throws(() => RoomToken.verify(token, API_SECRET), /expired/);
  });

  await test("verify() rejects token with wrong issuer", async () => {
    // Manually craft a token with wrong iss
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "other",
        sub: "p",
        room: "r",
        iat: Math.floor(Date.now() / 1000),
      }),
    ).toString("base64url");
    const sig = crypto
      .createHmac("sha256", API_SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    const token = `${header}.${payload}.${sig}`;
    assert.throws(() => RoomToken.verify(token, API_SECRET), /Invalid issuer/);
  });

  await test("verifyOrNull() returns null on invalid token", async () => {
    const result = RoomToken.verifyOrNull("not.a.token", API_SECRET);
    assert.strictEqual(result, null);
  });

  await test("verifyOrNull() returns claims on valid token", async () => {
    const token = new RoomToken(API_SECRET).forRoom("r").forPeer("p").toJWT();
    const claims = RoomToken.verifyOrNull(token, API_SECRET);
    assert.ok(claims !== null);
    assert.strictEqual(claims.sub, "p");
  });

  await test("notBefore() rejects token used too early", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = new RoomToken(API_SECRET)
      .forRoom("r")
      .forPeer("p")
      .notBefore(future)
      .toJWT();
    assert.throws(() => RoomToken.verify(token, API_SECRET), /not yet valid/);
  });

  await test("expires(0) creates a non-expiring token", async () => {
    const token = new RoomToken(API_SECRET)
      .forRoom("r")
      .forPeer("p")
      .expires(0)
      .toJWT();
    const claims = RoomToken.verify(token, API_SECRET);
    assert.strictEqual(
      claims.exp,
      undefined,
      "non-expiring token should have no exp claim",
    );
  });

  // ---------------------------------------------------------------------------
  // TurnCredentials
  // ---------------------------------------------------------------------------

  console.log("\nTurnCredentials");

  const TURN_SECRET = "test-turn-secret-for-unit-tests";
  const TURN_URLS = [
    "turn:turn.example.com:3478",
    "turns:turn.example.com:5349",
  ];

  await test("throws if secret is missing", async () => {
    assert.throws(() => new TurnCredentials({ urls: TURN_URLS }), /secret/);
  });

  await test("throws if urls is empty", async () => {
    assert.throws(
      () => new TurnCredentials({ secret: TURN_SECRET, urls: [] }),
      /urls/,
    );
  });

  await test("generateFor() returns correct structure", async () => {
    const turn = new TurnCredentials({ secret: TURN_SECRET, urls: TURN_URLS });
    const creds = turn.generateFor("peer-123");

    assert.ok(Array.isArray(creds.urls));
    assert.deepStrictEqual(creds.urls, TURN_URLS);
    assert.ok(typeof creds.username === "string");
    assert.ok(typeof creds.credential === "string");
    assert.ok(typeof creds.ttl === "number");
    assert.ok(creds.ttl > 0);
  });

  await test("generateFor() embeds peerId in username", async () => {
    const turn = new TurnCredentials({ secret: TURN_SECRET, urls: TURN_URLS });
    const creds = turn.generateFor("peer-abc");
    assert.ok(
      creds.username.endsWith(":peer-abc"),
      `username should end with :peer-abc, got ${creds.username}`,
    );
  });

  await test("generateFor() sets expiry in the future", async () => {
    const turn = new TurnCredentials({
      secret: TURN_SECRET,
      urls: TURN_URLS,
      ttl: 3600,
    });
    const creds = turn.generateFor("p1");
    const expiry = parseInt(creds.username.split(":")[0], 10);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(expiry > now, "expiry should be in the future");
    assert.ok(
      expiry <= now + 3600 + 5,
      "expiry should not exceed ttl + small buffer",
    );
  });

  await test("verify() confirms valid credentials", async () => {
    const turn = new TurnCredentials({ secret: TURN_SECRET, urls: TURN_URLS });
    const creds = turn.generateFor("peer-verify");
    const result = turn.verify(creds.username, creds.credential);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.expired, false);
    assert.strictEqual(result.peerId, "peer-verify");
  });

  await test("verify() detects tampered credential", async () => {
    const turn = new TurnCredentials({ secret: TURN_SECRET, urls: TURN_URLS });
    const creds = turn.generateFor("peer-tamper");
    const result = turn.verify(creds.username, "tampered==");
    assert.strictEqual(result.valid, false);
  });

  await test("verify() detects expired credentials", async () => {
    const turn = new TurnCredentials({
      secret: TURN_SECRET,
      urls: TURN_URLS,
      ttl: 1,
    });
    const creds = turn.generateFor("peer-exp");
    await sleep(1100);
    const result = turn.verify(creds.username, creds.credential);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.expired, true);
  });

  await test("urls and ttl getters return correct values", async () => {
    const turn = new TurnCredentials({
      secret: TURN_SECRET,
      urls: TURN_URLS,
      ttl: 7200,
    });
    assert.deepStrictEqual(turn.urls, TURN_URLS);
    assert.strictEqual(turn.ttl, 7200);
  });

  // ---------------------------------------------------------------------------
  // WebhookDispatcher
  // ---------------------------------------------------------------------------

  console.log("\nWebhookDispatcher");

  await test("throws if server is missing", async () => {
    assert.throws(
      () => new WebhookDispatcher({ endpoints: ["http://localhost"] }),
      /server/,
    );
  });

  await test("throws if endpoints is empty", async () => {
    const mockServer = { on: () => {} };
    assert.throws(
      () => new WebhookDispatcher({ server: mockServer, endpoints: [] }),
      /endpoints/,
    );
  });

  await test("dispatches room.created event to endpoint", async () => {
    let received = null;
    const srv = http
      .createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          received = JSON.parse(body);
          res.end();
        });
      })
      .listen(0);

    await new Promise((r) => srv.on("listening", r));
    const port = srv.address().port;

    const serverEvents = new EventEmitter();
    const mockServer = { on: (ev, cb) => serverEvents.on(ev, cb) };
    const dispatcher = new WebhookDispatcher({
      server: mockServer,
      endpoints: [`http://localhost:${port}`],
    });

    const room = new Room({ id: "wh-room" });
    serverEvents.emit("room:created", room);
    await sleep(200);

    assert.ok(received, "webhook should have been received");
    assert.strictEqual(received.type, "room.created");
    assert.strictEqual(received.data.room.id, "wh-room");

    srv.close();
  });

  await test("event filter respects events allowlist", async () => {
    let hitCount = 0;
    const srv = http
      .createServer((req, res) => {
        req.resume();
        hitCount++;
        res.end();
      })
      .listen(0);
    await new Promise((r) => srv.on("listening", r));

    const serverEvents = new EventEmitter();
    const mockServer = { on: (ev, cb) => serverEvents.on(ev, cb) };

    new WebhookDispatcher({
      server: mockServer,
      endpoints: [`http://localhost:${srv.address().port}`],
      events: ["room.created"], // only room.created — peer events should be filtered
    });

    const room = new Room({ id: "filter-room" });
    serverEvents.emit("room:created", room);
    serverEvents.emit("room:destroyed", room); // should be filtered
    await sleep(200);

    assert.strictEqual(
      hitCount,
      1,
      "only room.created should have been delivered",
    );
    srv.close();
  });

  await test("request includes X-Webrtc-Rooms-Signature when secret is set", async () => {
    let sigHeader = null;
    let body = "";
    let timestamp = null;

    const srv = http
      .createServer((req, res) => {
        sigHeader = req.headers["x-webrtc-rooms-signature"];
        timestamp = req.headers["x-webrtc-rooms-timestamp"];
        req.on("data", (c) => (body += c));
        req.on("end", () => res.end());
      })
      .listen(0);
    await new Promise((r) => srv.on("listening", r));

    const WHSECRET = "webhook-test-secret-value-here";
    const serverEvents = new EventEmitter();
    const mockServer = { on: (ev, cb) => serverEvents.on(ev, cb) };

    new WebhookDispatcher({
      server: mockServer,
      endpoints: [`http://localhost:${srv.address().port}`],
      secret: WHSECRET,
    });

    serverEvents.emit("room:created", new Room({ id: "sig-room" }));
    await sleep(200);

    assert.ok(sigHeader, "signature header should be present");
    assert.ok(
      sigHeader.startsWith("sha256="),
      "signature should start with sha256=",
    );

    // Verify the signature ourselves
    const expectedSig =
      "sha256=" +
      crypto
        .createHmac("sha256", WHSECRET)
        .update(`${timestamp}.${body}`)
        .digest("hex");
    assert.strictEqual(
      sigHeader,
      expectedSig,
      "signature should be verifiable",
    );

    srv.close();
  });

  await test("adds failed events to dead-letter queue after all retries", async () => {
    // Endpoint that always rejects
    const srv = http
      .createServer((req, res) => {
        req.resume();
        res.writeHead(500);
        res.end();
      })
      .listen(0);
    await new Promise((r) => srv.on("listening", r));

    const serverEvents = new EventEmitter();
    const mockServer = { on: (ev, cb) => serverEvents.on(ev, cb) };
    const dispatcher = new WebhookDispatcher({
      server: mockServer,
      endpoints: [`http://localhost:${srv.address().port}`],
    });

    let failed = false;
    dispatcher.on("delivery:failed", () => {
      failed = true;
    });

    serverEvents.emit("room:created", new Room({ id: "dlq-room" }));

    // Wait for all 3 retry delays (2+4+8 = 14s) — use a shorter delay by
    // directly calling _deliverWithRetry at the final attempt
    dispatcher._deliverWithRetry(
      `http://localhost:${srv.address().port}`,
      {
        id: "test",
        type: "room.created",
        timestamp: Date.now(),
        data: {},
      },
      3,
    ); // attempt 3 = final attempt, goes straight to DLQ

    await sleep(500);

    const dlq = dispatcher.deadLetterQueue();
    assert.ok(dlq.length > 0, "dead-letter queue should contain failed event");
    assert.ok(dlq[0].endpoint, "DLQ entry should have endpoint");

    dispatcher.clearDeadLetterQueue();
    assert.strictEqual(dispatcher.deadLetterQueue().length, 0);
    srv.close();
  });

  await test("recordingStarted() and recordingStopped() fire correct event types", async () => {
    const received = [];
    const srv = http
      .createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          received.push(JSON.parse(b));
          res.end();
        });
      })
      .listen(0);
    await new Promise((r) => srv.on("listening", r));

    const serverEvents = new EventEmitter();
    const mockServer = { on: (ev, cb) => serverEvents.on(ev, cb) };
    const dispatcher = new WebhookDispatcher({
      server: mockServer,
      endpoints: [`http://localhost:${srv.address().port}`],
    });

    dispatcher.recordingStarted({
      peerId: "p1",
      roomId: "r1",
      path: "/tmp/rec.webm",
    });
    dispatcher.recordingStopped({
      peerId: "p1",
      roomId: "r1",
      path: "/tmp/rec.webm",
      durationMs: 5000,
    });
    await sleep(300);

    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[0].type, "recording.started");
    assert.strictEqual(received[1].type, "recording.stopped");
    srv.close();
  });

  // ---------------------------------------------------------------------------
  // SignalingServer apiSecret integration
  // ---------------------------------------------------------------------------

  console.log("\nSignalingServer apiSecret integration");

  const PORT = 14000;
  const authServer = createServer({
    port: PORT,
    apiSecret: API_SECRET,
    autoCreateRooms: true,
  });
  await new Promise((r) => authServer.on("listening", r));

  await test("rejects peer with no token when apiSecret is set", async () => {
    const { ws } = await connect(PORT);
    const errP = waitFor(ws, (m) => m.type === "error");
    ws.send(JSON.stringify({ type: "join", roomId: "secret-room" }));
    const err = await errP;
    assert.strictEqual(err.code, "TOKEN_REQUIRED");
    ws.close();
  });

  await test("rejects peer with invalid token", async () => {
    const { ws } = await connect(PORT);
    const errP = waitFor(ws, (m) => m.type === "error");
    ws.send(
      JSON.stringify({
        type: "join",
        roomId: "secret-room",
        metadata: { token: "bad.token.here" },
      }),
    );
    const err = await errP;
    assert.strictEqual(err.code, "TOKEN_INVALID");
    ws.close();
  });

  await test("rejects peer with token for wrong room", async () => {
    const token = new RoomToken(API_SECRET)
      .forRoom("other-room")
      .forPeer("alice")
      .toJWT();
    const { ws } = await connect(PORT);
    const errP = waitFor(ws, (m) => m.type === "error");
    ws.send(
      JSON.stringify({
        type: "join",
        roomId: "secret-room",
        metadata: { token },
      }),
    );
    const err = await errP;
    assert.strictEqual(err.code, "TOKEN_ROOM_MISMATCH");
    ws.close();
  });

  await test("admits peer with valid token and merges claims into metadata", async () => {
    const token = new RoomToken(API_SECRET)
      .forRoom("secret-room")
      .forPeer("alice")
      .canPublish()
      .withMetadata({ displayName: "Alice", role: "admin" })
      .toJWT();

    const { ws } = await connect(PORT);
    const joinedP = waitFor(ws, (m) => m.type === "room:joined");
    ws.send(
      JSON.stringify({
        type: "join",
        roomId: "secret-room",
        metadata: { token },
      }),
    );
    const msg = await joinedP;

    assert.strictEqual(msg.roomId, "secret-room");

    // Verify metadata was merged on the server-side peer
    const peer = [...authServer.peers.values()].find(
      (p) => p.roomId === "secret-room",
    );
    assert.ok(peer, "peer should be in server.peers");
    assert.strictEqual(peer.metadata.tokenSub, "alice");
    assert.strictEqual(peer.metadata.canPublish, true);
    assert.strictEqual(peer.metadata.displayName, "Alice");
    assert.strictEqual(
      peer.metadata.token,
      undefined,
      "raw token must be stripped",
    );

    ws.close();
  });

  await authServer.close();

  // ---------------------------------------------------------------------------
  // SignalingServer turn integration
  // ---------------------------------------------------------------------------

  console.log("\nSignalingServer turn integration");

  const turnServer = createServer({
    port: PORT + 1,
    autoCreateRooms: true,
    turn: {
      secret: TURN_SECRET,
      urls: TURN_URLS,
      ttl: 3600,
    },
  });
  await new Promise((r) => turnServer.on("listening", r));

  await test("room:joined includes iceServers with TURN credentials", async () => {
    const { ws } = await connect(PORT + 1);
    const joinedP = waitFor(ws, (m) => m.type === "room:joined");
    ws.send(JSON.stringify({ type: "join", roomId: "turn-room" }));
    const msg = await joinedP;

    assert.ok(Array.isArray(msg.iceServers), "iceServers should be an array");
    assert.strictEqual(msg.iceServers.length, 1);

    const creds = msg.iceServers[0];
    assert.ok(Array.isArray(creds.urls));
    assert.ok(
      creds.urls.every((u) => TURN_URLS.includes(u)),
      "URLs should match configured TURN urls",
    );
    assert.ok(
      typeof creds.username === "string",
      "username should be a string",
    );
    assert.ok(
      typeof creds.credential === "string",
      "credential should be a string",
    );
    assert.strictEqual(creds.ttl, 3600);

    ws.close();
  });

  await test("TURN credentials are verifiable with the shared secret", async () => {
    const { ws, peerId } = await connect(PORT + 1);
    const joinedP = waitFor(ws, (m) => m.type === "room:joined");
    ws.send(JSON.stringify({ type: "join", roomId: "turn-verify" }));
    const msg = await joinedP;

    const { username, credential } = msg.iceServers[0];
    const turn = new TurnCredentials({ secret: TURN_SECRET, urls: TURN_URLS });
    const result = turn.verify(username, credential);

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.peerId, peerId);
    ws.close();
  });

  await turnServer.close();

  // ---------------------------------------------------------------------------
  // AdminAPI extensions
  // ---------------------------------------------------------------------------

  console.log("\nAdminAPI extensions");

  const ADMIN_PORT = PORT + 10;
  const ADMIN_SECRET_VAL = "admin-test-secret";
  const adminServer = createServer({ port: PORT + 20, autoCreateRooms: true });
  await new Promise((r) => adminServer.on("listening", r));

  adminServer.createRoom("admin-test-room");

  const adminApi = new AdminAPI({
    server: adminServer,
    adminSecret: ADMIN_SECRET_VAL,
  });
  const adminHttp = adminApi.listen(ADMIN_PORT);
  await sleep(100);

  function adminReq(method, path, body) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: "127.0.0.1",
        port: ADMIN_PORT,
        path: `/admin${path}`,
        method,
        headers: {
          Authorization: `Bearer ${ADMIN_SECRET_VAL}`,
          "Content-Type": "application/json",
        },
      };
      const req = http.request(opts, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(raw) }),
        );
      });
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  function adminReqRaw(method, path) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: "127.0.0.1",
        port: ADMIN_PORT,
        path: `/admin${path}`,
        method,
        headers: { Authorization: `Bearer ${ADMIN_SECRET_VAL}` },
      };
      const req = http.request(opts, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: raw,
            contentType: res.headers["content-type"],
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  }

  await test("POST /admin/rooms/:id/mute-all returns 200 with muted count", async () => {
    const { status, body } = await adminReq(
      "POST",
      "/rooms/admin-test-room/mute-all",
    );
    assert.strictEqual(status, 200);
    assert.ok(typeof body.muted === "number");
  });

  await test("POST /admin/rooms/:id/mute-all returns 404 for unknown room", async () => {
    const { status } = await adminReq("POST", "/rooms/ghost-room/mute-all");
    assert.strictEqual(status, 404);
  });

  await test("GET /admin/metrics returns Prometheus text format", async () => {
    const { status, body, contentType } = await adminReqRaw("GET", "/metrics");
    assert.strictEqual(status, 200);
    assert.ok(
      contentType.includes("text/plain"),
      "content-type should be text/plain",
    );
    assert.ok(
      body.includes("webrtc_rooms_active"),
      "should include rooms metric",
    );
    assert.ok(
      body.includes("webrtc_peers_total"),
      "should include peers metric",
    );
  });

  await test("GET /admin/recordings returns 501 when no recorder attached", async () => {
    const { status, body } = await adminReq("GET", "/recordings");
    assert.strictEqual(status, 501);
    assert.ok(body.error.includes("RecordingAdapter"));
  });

  await test("attachRecorder() enables /admin/recordings endpoint", async () => {
    // Mock recorder with activeRecordings()
    const mockRecorder = {
      activeRecordings: () => [
        {
          peerId: "p1",
          roomId: "r1",
          filePath: "/tmp/test.webm",
          durationMs: 5000,
        },
      ],
    };
    adminApi.attachRecorder(mockRecorder);

    const { status, body } = await adminReq("GET", "/recordings");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.recordings));
    assert.strictEqual(body.recordings.length, 1);
    assert.strictEqual(body.recordings[0].peerId, "p1");

    // Detach for isolation
    adminApi.attachRecorder(null);
  });

  await test("GET /admin/metrics includes recording count when recorder attached", async () => {
    const mockRecorder = {
      activeRecordings: () => [
        {
          peerId: "p1",
          roomId: "r1",
          filePath: "/tmp/t.webm",
          durationMs: 1000,
        },
      ],
    };
    adminApi.attachRecorder(mockRecorder);

    const { body } = await adminReqRaw("GET", "/metrics");
    assert.ok(
      body.includes("webrtc_active_recordings"),
      "should include recording metric when recorder attached",
    );
    assert.ok(
      body.includes("webrtc_active_recordings 1"),
      "recording count should be 1",
    );

    adminApi.attachRecorder(null);
  });

  await adminApi.close();
  await adminServer.close();

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
})();
