# webrtc-rooms

[![npm version](https://img.shields.io/npm/v/webrtc-rooms.svg)](https://www.npmjs.com/package/webrtc-rooms)
[![CI](https://github.com/himanshu-pandey-git/webrtc-rooms/actions/workflows/ci.yml/badge.svg)](https://github.com/himanshu-pandey-git/webrtc-rooms/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/himanshu-pandey-git/webrtc-rooms)](https://github.com/himanshu-pandey-git/webrtc-rooms/releases)
[![license](https://img.shields.io/npm/l/webrtc-rooms.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/webrtc-rooms.svg)](https://nodejs.org)

WebRTC signaling, proprietary SFU, adaptive bitrate, multi-region orchestration,
E2EE, compliance, observability, and enterprise administration for Node.js.

Built and maintained by [Himanshu Pandey](https://github.com/himanshu-pandey-git).

---

## Overview

**webrtc-rooms** is a complete real-time video/audio platform in a single npm
package. It gives you a production signaling server, a native zero-dependency SFU with simulcast and adaptive bitrate, multi-region orchestration with automatic failover,
HMAC-signed session persistence, Redis pub/sub scaling, end-to-end encryption,
SOC2/HIPAA audit logging, GDPR consent and data residency enforcement, distributed
tracing, Prometheus metrics, SLO health monitoring, threat detection,
backpressure-aware load shedding, structured moderation, signed webhooks, and a CLI
that scaffolds any of it in under a minute.

```bash
npm install webrtc-rooms
```

Requires Node.js 18 or later. No mandatory external dependencies beyond `ws` and `uuid`.

---

## What's in the box

| Layer | Modules |
|---|---|
| **Signaling core** | `SignalingServer`, `Room`, `Peer`, `createServer` |
| **Session management** | `SessionManager` — HMAC-signed reconnect, cross-process resume |
| **Proprietary SFU** | `NativeSFUEngine`, `SFUOrchestrator`, `AdaptiveBitrateController`, `RegionRouter` |
| **Auth** | `PolicyEngine` — signed capability tokens · `RoomToken` |
| **Security** | `ThreatDetector` — 8 threat models · `AuditLogger` — SOC2/HIPAA |
| **Observability** | `MetricsCollector` + Prometheus · `Tracer` · `AlertManager` · `HealthMonitor` |
| **Reliability** | `EventReplay` · `BackpressureController` · `HealthMonitor` |
| **Scaling** | `RedisAdapter` · `RoomPersistence` |
| **Compliance** | `ConsentFlow` · `DataResidency` · `RetentionPolicy` |
| **Moderation** | `ModerationBus` |
| **Recording** | `RecordingPipeline` |
| **E2EE** | `E2EKeyExchange` — ECDH key distribution |
| **Admin** | `AdminAPI` · `GovernanceEndpoints` — 15 compliance endpoints |
| **CLI** | `webrtc-rooms init` · `simulate` · `benchmark` · `health` |

---

## Quick start

```js
const { createServer } = require("webrtc-rooms");

const server = createServer({ port: 3000 });

server.on("peer:joined", (peer, room) => {
  console.log(`${peer.metadata.displayName} joined "${room.id}"`);
});
```

For a production setup with all v2 features, scaffold a project:

```bash
npx webrtc-rooms init my-app --template enterprise
cd my-app && npm install && node server.js
```

---

## How it works

```
Browser A                 webrtc-rooms v2 server           Browser B
    │                           │                               │
    ├── { join, roomId } ──────►│                               │
    │◄─ { room:joined, peers }  │                               │
    │                           │◄────── { join, roomId } ──────┤
    │◄─ { peer:joined }         │──── { room:joined, peers } ──►│
    │                           │                               │
    ├── { offer, target:B } ───►│──── { offer, from:A } ───────►│
    │◄─ { answer, from:B } ─────│◄─── { answer, target:A } ─────┤
    │                           │                               │
    ◄──────────── ICE trickle ──┼──────── ICE trickle ─────────►│
    │                                                           │
    ◄═══════════ direct P2P media (P2P) or via NativeSFUEngine ►│
```

In P2P mode the server only routes signaling — media never touches it. Attach
`NativeSFUEngine` for rooms with many participants; the SFU receives and selectively
forwards tracks, while `AdaptiveBitrateController` picks the right simulcast layer
for each subscriber based on live network conditions.

---

## Table of contents

- [Installation](#installation)
- [CLI](#cli)
- [API reference](#api-reference)
  - [createServer](#createserveroptions--signalingserver)
  - [SignalingServer](#signalingserver)
  - [Room](#room)
  - [Peer](#peer)
  - [SessionManager](#sessionmanager)
  - [PolicyEngine](#policyengine)
  - [NativeSFUEngine](#nativesfuengine)
  - [SFUOrchestrator](#sfuorchestrator)
  - [AdaptiveBitrateController](#adaptivebitratecontroller)
  - [RegionRouter](#regionrouter)
  - [ThreatDetector](#threatdetector)
  - [AuditLogger](#auditlogger)
  - [MetricsCollector](#metricscollector)
  - [Tracer](#tracer)
  - [AlertManager](#alertmanager)
  - [HealthMonitor](#healthmonitor)
  - [EventReplay](#eventreplay)
  - [BackpressureController](#backpressurecontroller)
  - [ModerationBus](#moderationbus)
  - [RecordingPipeline](#recordingpipeline)
  - [ConsentFlow](#consentflow)
  - [DataResidency](#dataresidency)
  - [RetentionPolicy](#retentionpolicy)
  - [E2EKeyExchange](#e2ekeyexchange)
  - [RedisAdapter](#redisadapter)
  - [RoomPersistence](#roompersistence)
  - [RateLimiter](#ratelimiter)
  - [AdminAPI](#adminapi)
  - [GovernanceEndpoints](#governanceendpoints)
- [Wire protocol](#wire-protocol)
- [Authentication](#authentication)
- [Reconnection](#reconnection)
- [Multi-server scaling](#multi-server-scaling)
- [Room persistence](#room-persistence)
- [SFU mode](#sfu-mode)
- [Adaptive bitrate](#adaptive-bitrate)
- [End-to-end encryption](#end-to-end-encryption)
- [Observability](#observability)
- [Security](#security)
- [Compliance](#compliance)
- [Moderation](#moderation)
- [TypeScript](#typescript)
- [Mounting on Express](#mounting-on-express)
- [Running tests](#running-tests)
- [Contributing](#contributing)
- [License](#license)

---

## Installation

```bash
npm install webrtc-rooms
```

Optional peer dependencies — install only what you use:

```bash
npm install redis        # or: npm install ioredis   — for RedisAdapter / RoomPersistence
npm install mediasoup    # legacy SFU adapter (NativeSFUEngine needs no extra install)
```

For recording, `ffmpeg` must be on `PATH`.

---

## CLI

```bash
# Scaffold a new project
npx webrtc-rooms init my-app
npx webrtc-rooms init my-app --template enterprise   # full stack

# Start a local multi-process cluster for development
npx webrtc-rooms simulate --processes 3 --redis redis://localhost:6379

# Run a reproducible load test
npx webrtc-rooms benchmark --peers 200 --rooms 20 --duration 60

# Check a running server
npx webrtc-rooms health http://localhost:4000/admin/health --secret my-token
```

**Templates**

| Template     | What's included                                                       |
| ------------ | --------------------------------------------------------------------- |
| `basic`      | Minimal signaling server — 30 lines                                   |
| `advanced`   | Auth + rate limiting + admin API + metrics                            |
| `sfu`        | NativeSFUEngine + SFUOrchestrator + AdaptiveBitrateController         |
| `enterprise` | Full stack — SFU, Redis, persistence, E2EE, compliance, observability |

---

## API reference

### `createServer(options)` → `SignalingServer`

```js
const { createServer } = require("webrtc-rooms");

const server = createServer({
  port: 3000,
  server: httpServer, // attach to an existing http.Server
  maxPeersPerRoom: 50,
  autoCreateRooms: true,
  autoDestroyRooms: true,
  reconnectTtl: 15_000, // ms (0 = off)
  beforeJoin: async (peer, roomId) => {
    /* see Authentication */
  },
});
```

---

### SignalingServer

```js
// Events
server.on("listening", ({ port }) => {});
server.on("peer:connected", (peer) => {});
server.on("peer:joined", (peer, room) => {});
server.on("peer:left", (peer, room) => {});
server.on("peer:reconnected", (peer, room) => {});
server.on("room:created", (room) => {});
server.on("room:destroyed", (room) => {});
server.on("join:rejected", (peer, reason) => {});

// Methods
server.createRoom("standup", { metadata: { topic: "Daily standup" } });
const room = server.getRoom("standup");
server.kick(peerId, "Policy violation");
server.stats(); // → { rooms, peers, roomList }
await server.close();
```

---

### Room

```js
room.broadcast({ type: "server:notice", text: "Recording started." });
room.broadcast({ type: "data", payload: "hello" }, { exclude: [peer.id] });
room.setMetadata({ topic: "New topic", recordingActive: true });
room.getState(); // → { id, metadata, peers[], createdAt }
room.size; // number of peers
room.isEmpty; // boolean
```

---

### Peer

```js
peer.id; // UUID v4
peer.state; // 'connecting' | 'joined' | 'reconnecting' | 'closed'
peer.metadata; // { displayName, role, userId, ... }
peer.isActive; // true when state === 'joined'
peer.connectedAt; // Unix timestamp ms

peer.setMetadata({ displayName: "Alice", token: null }); // null removes the key
peer.send({ type: "custom:event", data: "anything" });
peer.close(1008, "Policy violation");
peer.toJSON(); // → { id, roomId, state, metadata }

Peer.State.CONNECTING; // 'connecting'
Peer.State.JOINED; // 'joined'
Peer.State.RECONNECTING; // 'reconnecting'
Peer.State.CLOSED; // 'closed'
```

---

### SessionManager

HMAC-SHA256 signed reconnect tokens with cross-process Redis resume and session
migration between regions.

```js
const { SessionManager } = require("webrtc-rooms");

const sessions = new SessionManager({
  reconnectTtl: 30_000, // ms session stays alive after socket drop
  maxQueueSize: 64, // messages buffered during suspension
  secret: process.env.SESSION_SECRET, // shared across processes
  redis, // optional — enables cross-process resume
  region: "ap-south-1",
});

sessions.attach(server);

// Manual resume (called automatically on peer:reconnected)
const resumed = await sessions.resume(token, roomId);

// Events
sessions.on("session:created", (session) => {});
sessions.on("session:suspended", (session, room) => {});
sessions.on("session:resumed", (session) => {});
sessions.on("session:expired", (session) => {});
sessions.on("session:migrated", (session, targetRegion) => {});
```

---

### PolicyEngine

Signed room policy tokens with capability enforcement. Integrates into
`beforeJoin` automatically — no custom hook needed.

```js
const { PolicyEngine } = require("webrtc-rooms");

const policy = new PolicyEngine({
  secret: process.env.POLICY_SECRET,
  required: true, // reject peers without a valid token
  defaultCaps: ["subscribe", "data"],
});

policy.attach(server);

// Issue a token (typically in your API layer, not the signaling server)
const token = policy.issue({
  sub: user.id,
  roomId: "engineering",
  role: "moderator",
  caps: ["publish", "subscribe", "kick", "data"],
  expiresIn: 7_200_000,
});

// Browser sends token in join metadata:
// ws.send(JSON.stringify({ type: 'join', roomId, metadata: { policyToken: token } }))

// Check capabilities on a peer
policy.hasCap(peer, "kick"); // → boolean

policy.on("policy:violation", ({ peer, roomId, code }) => {
  console.warn("Policy violation", code, "from", peer.id);
});
```

**Capabilities**: `publish` · `subscribe` · `kick` · `record` · `moderate` · `data` · `admin`

(`admin` implies all others)

---

### NativeSFUEngine

Proprietary SFU engine — zero external SFU dependencies. Handles
publish/subscribe, simulcast layer selection, and full producer/consumer
lifecycle inside the Node.js process.

```js
const { NativeSFUEngine } = require("webrtc-rooms");

const sfu = new NativeSFUEngine({
  region: process.env.REGION || "default",
  listenIp: "0.0.0.0",
  announcedIp: process.env.PUBLIC_IP,
  rtcMinPort: 10000,
  rtcMaxPort: 59999,
  enableSimulcast: true,
});

await sfu.init();
sfu.attach(server);

sfu.stats();
// → { region, rooms, totalProducers, totalConsumers, totalTransports, initialized }
```

**Browser signals** (sent through the data relay using `__sfu` discriminator):

```js
// Publish a track
ws.send(
  JSON.stringify({
    type: "data",
    payload: { __sfu: "publish", kind: "video", trackId: "v1" },
  }),
);

// Subscribe to a remote producer
ws.send(
  JSON.stringify({ type: "data", payload: { __sfu: "subscribe", producerId } }),
);

// Select simulcast layer
ws.send(
  JSON.stringify({
    type: "data",
    payload: { __sfu: "layers", consumerId, layer: "high" },
  }),
);

// Pause / resume
ws.send(
  JSON.stringify({ type: "data", payload: { __sfu: "pause", producerId } }),
);
ws.send(
  JSON.stringify({ type: "data", payload: { __sfu: "resume", producerId } }),
);
```

**Server → client SFU messages**: `sfu:ready` · `sfu:published` · `sfu:subscribed` ·
`sfu:peer:published` · `sfu:peer:unpublished` · `sfu:consumer:closed` ·
`sfu:layer:changed` · `sfu:paused` · `sfu:resumed`

---

### SFUOrchestrator

Manages a fleet of `NativeSFUEngine` instances across regions with health
monitoring, automatic failover, and room migration.

```js
const { SFUOrchestrator, NativeSFUEngine } = require("webrtc-rooms");

const orchestrator = new SFUOrchestrator({
  server,
  defaultRegion: "ap-south-1",
  healthCheckIntervalMs: 10_000,
  maxRoomsPerSFU: 500,
  fallbackToP2P: true, // P2P if all SFUs down
});

orchestrator.register(
  "ap-south-1",
  new NativeSFUEngine({ region: "ap-south-1" }),
);
orchestrator.register(
  "eu-west-1",
  new NativeSFUEngine({ region: "eu-west-1" }),
);

await orchestrator.init();

// Manual room migration
await orchestrator.migrateRoom("room-123", "eu-west-1");

orchestrator.stats();
// → [{ region, health, roomCount, failCount, initialized, adapterStats }]

orchestrator.on("sfu:down", (region) => {
  /* alert */
});
orchestrator.on("failover", (region, rooms) => {});
orchestrator.on("room:migrated", (roomId, from, to) => {});
```

Health states: `healthy` · `degraded` · `down`

---

### AdaptiveBitrateController

Per-subscriber simulcast layer selection driven by live RTCP feedback signals.
Protects active speakers and screen-share tracks. Mobile-first tuning.

```js
const { AdaptiveBitrateController } = require("webrtc-rooms");

const abc = new AdaptiveBitrateController({
  sfuEngine: sfu,
  upgradeHoldMs: 5_000, // hysteresis — hold before upgrading
  mobileFirst: true, // mobile peers start at lower tier
  protectActiveSpeaker: true, // never downgrade active speaker below mid
  protectScreenShare: true,
});

abc.attach(server);

// Mark a producer as active speaker (e.g. from VAD detection)
abc.setActiveSpeaker(producerId);
abc.clearActiveSpeaker(producerId);
abc.markScreenShare(producerId);

abc.stats();
// → [{ consumerId, peerId, score, currentLayer, targetLayer, deviceType, pliCount, nackCount }]

abc.on("layer:changed", ({ consumerId, peerId, from, to, score }) => {});
abc.on("audio:only:hint", ({ consumerId, peerId, score }) => {});
```

**Browser sends feedback** via data relay:

```js
ws.send(
  JSON.stringify({
    type: "data",
    payload: { __sfu: "feedback", type: "pli", consumerId },
  }),
);
ws.send(
  JSON.stringify({
    type: "data",
    payload: { __sfu: "feedback", type: "remb", consumerId, bitrate: 800000 },
  }),
);
ws.send(
  JSON.stringify({
    type: "data",
    payload: { __sfu: "feedback", type: "nack", consumerId, count: 2 },
  }),
);
```

---

### RegionRouter

Assigns peers and rooms to regions using latency, affinity, residency, load,
or manual strategies. Emits migration hints when a peer would be better served
by a different region.

```js
const { RegionRouter } = require("webrtc-rooms");

const router = new RegionRouter({
  server,
  localRegion: "us-east-1",
  regions: ["us-east-1", "eu-west-1", "ap-south-1"],
  mode: "affinity", // latency | affinity | residency | load | manual
});

router.attach();

router.assignRoomRegion("my-room", "eu-west-1");
router.getPeerRegion(peerId); // → 'eu-west-1'
router.getRoomRegion(roomId); // → 'eu-west-1'

router.on("peer:should:migrate", ({ peerId, currentRegion, targetRegion }) => {
  // Send a reconnect hint to the peer's browser
});
```

---

### ThreatDetector

Real-time in-process abuse detection across 8 threat models. No external
service required.

```js
const { ThreatDetector } = require("webrtc-rooms");

const detector = new ThreatDetector({
  server,
  whitelist: ["127.0.0.1", "::1"],
  thresholds: {
    maxConnPerMinPerIp: 30,
    maxSignalsPerSecPerPeer: 50,
    maxPayloadBytes: 65_536,
  },
});

detector.attach();

detector.on("threat", ({ level, threat, peer, ip, ts }) => {
  myLogger.warn("[threat]", level, threat, ip);
});

// Manual ban management
detector.ban("1.2.3.4", 300_000);
detector.unban("1.2.3.4");
detector.bans(); // → [{ ip, expiresIn }]
```

**Threat levels**: `warn` · `throttle` · `kick` · `ban`

**Threat models**: connection flood · signal flood · room cycling · SDP spam ·
data abuse · metadata poisoning · idle timeout · amplification

---

### AuditLogger

Append-only structured audit log. Writes NDJSON with automatic file rotation.
SOC2/HIPAA-ready with optional IP redaction.

```js
const { AuditLogger } = require("webrtc-rooms");

const audit = new AuditLogger({
  server,
  filePath: "./logs/audit.ndjson",
  maxFileSizeBytes: 100 * 1024 * 1024, // 100 MB then rotate
  ringSize: 10_000, // in-memory entries
  redactIp: false, // true for GDPR-compliant logging
  sink: async (entry) => {
    // custom async sink
    await myLogPlatform.ingest(entry);
  },
});

audit.attach();

// Query the in-memory ring buffer
audit.query({ event: "peer:joined", roomId: "standup", limit: 50 });
audit.query({ peerId: "abc-123", since: Date.now() - 3600_000 });

// Manual entries (e.g. from PolicyEngine, AdminAPI)
audit.log("room:policy:changed", { roomId, actorId, change });

audit.on("entry", (entry) => {});
```

**Auto-logged events**: `peer:connected` · `peer:joined` · `peer:left` ·
`peer:reconnected` · `join:rejected` · `room:created` · `room:destroyed`

---

### MetricsCollector

Per-room QoS metrics with P50/P95/P99 latency histograms and Prometheus export.

```js
const { MetricsCollector } = require("webrtc-rooms");

const metrics = new MetricsCollector({ server });
metrics.attach();

// Full snapshot
const snap = metrics.snapshot();
// → { timestamp, uptimeMs, system, server: { rooms, peers, joinsTotal, ... }, rooms: [...] }

// Per-room QoS
const rm = metrics.roomSnapshot("standup");
// → { peersCurrent, peersPeak, joinsTotal, reconnectSuccessRate, joinLatency: { p50, p95, p99 }, ... }

// Prometheus text format (serve on /metrics)
app.get("/metrics", (req, res) => {
  res.type("text/plain").send(metrics.toPrometheus());
});
```

---

### Tracer

Lightweight distributed tracing with OpenTelemetry-compatible span model.
Zero SDK dependency.

```js
const { Tracer } = require("webrtc-rooms");

const tracer = new Tracer({
  server,
  mode: "buffer", // 'console' | 'buffer' | 'noop'
  exporter: async (span) => {
    await jaeger.report(span);
  },
});

tracer.attach();

// Manual span
const span = tracer.startSpan("db.query", traceId, { table: "users" });
span.addEvent("cache:miss");
span.end("ok");

// Query buffered spans
tracer.getSpans({ limit: 100, name: "peer.join" });
tracer.getTraceId(peerId); // → traceId string
```

---

### AlertManager

Wires health, threat, SFU, and backpressure events into configurable channels.

```js
const { AlertManager } = require("webrtc-rooms");

const alerts = new AlertManager({
  channels: [
    { type: "console" },
    { type: "webhook", url: "https://hooks.slack.com/..." },
    { type: "custom", handler: async (alert) => myPagerDuty.trigger(alert) },
  ],
  suppressionWindowMs: 60_000, // deduplicate repeat alerts
});

alerts.attachHealthMonitor(health);
alerts.attachThreatDetector(threats);
alerts.attachSFUOrchestrator(orchestrator);
alerts.attachBackpressure(bp);

// Manual alert
alerts.alert({
  event: "custom:event",
  severity: "warning",
  message: "Disk filling up",
});

alerts.recent(20); // last N alerts
```

---

### HealthMonitor

SLO tracking against configurable targets. Fires breach and recovery events.

```js
const { HealthMonitor } = require("webrtc-rooms");

const health = new HealthMonitor({ server, metrics });
health.attach();

health.report(); // → { healthy, breaches: [{ slo, current, target }] }
health.isHealthy(); // → boolean
health.breaches(); // → array of active breaches

health.on("slo:breach", ({ slo, current, target }) => {});
health.on("slo:recovered", ({ slo }) => {});
```

**Default SLOs**: join success ≥ 99.5% · P95 join latency ≤ 500ms ·
reconnect success ≥ 95% · heap ≤ 85%

---

### EventReplay

Per-room ordered event log. Replays missed events to reconnecting peers with
sequence-number deduplication.

```js
const { EventReplay } = require("webrtc-rooms");

const replay = new EventReplay({
  server,
  capacity: 10_000, // max events in memory
  replayTtlMs: 300_000, // events older than this not replayed
  replayOnReconnect: true, // automatic replay on peer:reconnected
});

replay.attach();

// Manual replay
const count = replay.replayToPeer(peerId, lastSeenSeq);

// Query the log
replay.roomEvents("standup", afterSeq);
replay.stats(); // → { size, seq, oldestSeq }

replay.on("replayed", ({ peerId, roomId, count, fromSeq, toSeq }) => {});
```

The client stores `__seq` from each broadcast message and sends `lastSeenSeq`
in the `reconnect` message. The server replays everything the client missed.

---

### BackpressureController

Graduated load protection across 5 levels. Gates joins and sheds peers under
critical memory pressure.

```js
const { BackpressureController } = require("webrtc-rooms");

const bp = new BackpressureController({
  server,
  maxPeers: 10_000,
  sampleIntervalMs: 2_000,
  enableLoadShedding: true,
});

bp.attach();

bp.status();
// → { level, heapRatio, peerRatio, peerCount, maxPeers, heapUsedMb, heapTotalMb }

bp.on("load:elevated", (info) => {});
bp.on("load:high", (info) => {});
bp.on("load:critical", (info) => {});
bp.on("load:shedding", (info) => {});
```

**Load levels**: `normal` → `elevated` → `high` → `critical` → `shedding`

At `critical`: new joins are rejected with `SERVER_OVERLOADED`.
At `shedding`: lowest-priority peers (viewers, no role) are disconnected.

---

### ModerationBus

Structured moderation actions with capability enforcement and searchable log.

```js
const { ModerationBus } = require("webrtc-rooms");

const modbus = new ModerationBus({ server, policyEngine: policy });
modbus.attach();

// Actions
modbus.mute({ roomId, targetId, actorId, reason });
modbus.unmute({ roomId, targetId, actorId });
modbus.kick({ roomId, targetId, actorId, reason });
modbus.warn({ roomId, targetId, actorId, reason });
modbus.lockRoom(roomId, actorId);
modbus.unlockRoom(roomId, actorId);

// State
modbus.isMuted(roomId, peerId); // → boolean
modbus.isLocked(roomId); // → boolean
modbus.log({ roomId, limit: 50 }); // → ModerationEvent[]

modbus.on("muted", (info) => {});
modbus.on("kicked", (info) => {});
modbus.on("room:locked", (info) => {});
modbus.on("abuse:reported", (info) => {});
```

Peers without the `moderate` capability cannot mute or kick others when
`policyEngine` is attached.

---

### RecordingPipeline

Structured recording with session tracking, completion index, search, and
optional cloud upload hook.

```js
const { RecordingPipeline } = require("webrtc-rooms");

const pipeline = new RecordingPipeline({
  outputDir: "./recordings",
  format: "webm", // 'webm' | 'mp4'
  autoRecord: true, // auto-start on peer:joined
  onUpload: async (session) => {
    await s3.upload(session.filePath, session.roomId);
  },
});

pipeline.attach(server);

pipeline.active(); // → currently recording sessions
pipeline.index(); // → all completed recordings
pipeline.search({ roomId: "standup", since: Date.now() - 86_400_000 });

pipeline.on("recording:started", (info) => {});
pipeline.on("recording:stopped", (info) => {});
pipeline.on("recording:uploaded", (info) => {});
```

---

### ConsentFlow

GDPR Article 6 / HIPAA-ready consent collection with optional enforcement.

```js
const { ConsentFlow } = require("webrtc-rooms");

const consent = new ConsentFlow({
  server,
  required: ["recording"], // kick peers who don't consent within timeout
  allParty: true, // all-party consent before recording starts
  consentVersion: "v2024-05",
  consentTimeoutMs: 30_000,
});

consent.attach();

// Check before starting recording
if (!consent.roomHasConsent("standup", "recording")) {
  return "Not all peers have consented to recording";
}

// Grant consent server-side (e.g. consent obtained in your web app)
consent.recordConsent(roomId, peerId, ["recording", "processing"]);

consent.on("consent:granted", (record) => {});
consent.on("consent:withdrawn", ({ peerId, roomId, types }) => {});
consent.on("room:consent:complete", ({ roomId, type }) => {
  /* all peers consented */
});
```

**Browser sends consent** via data relay:

```js
ws.send(
  JSON.stringify({
    type: "data",
    payload: { __consent: "grant", types: ["recording"] },
  }),
);
ws.send(
  JSON.stringify({
    type: "data",
    payload: { __consent: "withdraw", types: ["recording"] },
  }),
);
```

---

### DataResidency

Region-aware join enforcement and event tagging for GDPR / data locality laws.

```js
const { DataResidency } = require("webrtc-rooms");

const residency = new DataResidency({
  server,
  localRegion: "ap-south-1",
  allowedRegions: ["eu-west-1", "ap-south-1"],
  enforceRoomRegion: true,
  geoLookup: async (ip) => myGeoIP.lookup(ip).region,
});

residency.attach();

residency.isAllowed("eu-west-1"); // → true
residency.tag({ roomId: "r1" }); // → { roomId: 'r1', __region: 'ap-south-1' }

residency.on("violation", ({ code, roomId, peerRegion }) => {});
```

---

### RetentionPolicy

Data retention record store with legal hold, bulk purge, and subject anonymisation.

```js
const { RetentionPolicy } = require("webrtc-rooms");

const retention = new RetentionPolicy({
  recordingRetentionDays: 90,
  auditLogRetentionDays: 365,
  sessionRetentionDays: 30,
});

// Register a data item for tracking
retention.register({
  id: sessionId,
  type: "recording",
  sub: userId,
  meta: { roomId },
});

// Legal hold — prevents purge regardless of retention period
retention.placeLegalHold(userId);
retention.releaseLegalHold(userId);

// Purge expired records
const { purged, held, skipped } = retention.purge();

// GDPR right-to-erasure
retention.anonymise(userId); // → count of records anonymised

// Audit queries
retention.recordsFor(userId);
retention.expiringWithin(7 * 86_400_000); // records expiring in 7 days

retention.on("record:purged", (record) => {});
retention.on("purge:complete", ({ purged, held }) => {});
```

---

### E2EKeyExchange

Server-side ECDH public-key distribution for true end-to-end encryption via
the browser's Insertable Streams API. Private keys and derived secrets never
leave the browser.

```js
const { E2EKeyExchange } = require("webrtc-rooms");

const e2e = new E2EKeyExchange({
  server,
  requireKeyOnJoin: true, // enforce E2EE — kick peers that don't announce
  keyAnnouncementTimeoutMs: 10_000,
  allowedCurves: ["P-256", "X25519"],
});

e2e.attach();

e2e.getPeerKey(roomId, peerId); // → { publicKey, curve, version, announcedAt }
e2e.getRoomKeys(roomId); // → [{ peerId, publicKey, curve, version }]

e2e.on("key:announced", ({ peerId, roomId, publicKey, curve }) => {});
e2e.on("key:rotated", ({ peerId, roomId, version }) => {});
e2e.on("key:revoked", ({ peerId, roomId }) => {});
```

**Browser-side flow**:

```js
// 1. Generate key pair
const kp = await crypto.subtle.generateKey(
  { name: "ECDH", namedCurve: "P-256" },
  true,
  ["deriveKey"],
);

// 2. Export and announce
const raw = await crypto.subtle.exportKey("spki", kp.publicKey);
const b64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
ws.send(
  JSON.stringify({
    type: "data",
    payload: { __e2e: "key:announce", publicKey: b64, curve: "P-256" },
  }),
);

// 3. Derive shared secret when you receive another peer's key
const theirKey = await crypto.subtle.importKey(
  "spki",
  base64ToBuffer(theirPubKey),
  { name: "ECDH", namedCurve: "P-256" },
  false,
  [],
);
const shared = await crypto.subtle.deriveKey(
  { name: "ECDH", public: theirKey },
  kp.privateKey,
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt", "decrypt"],
);

// 4. Use shared key to encrypt media via Insertable Streams
```

**Key rotation** (forward secrecy):

```js
ws.send(
  JSON.stringify({
    type: "data",
    payload: { __e2e: "key:rotate", publicKey: newB64, curve: "P-256" },
  }),
);
```

---

### RedisAdapter

Cross-process signaling bridge via Redis pub/sub. Required for horizontal
scaling behind a load balancer.

```js
const { RedisAdapter } = require("webrtc-rooms");
const { createClient } = require("redis");

const pub = await createClient({ url: process.env.REDIS_URL }).connect();
const sub = await createClient({ url: process.env.REDIS_URL }).connect();

const adapter = new RedisAdapter({ pub, sub, server });
await adapter.init();

// Cross-cluster queries
await adapter.getRoomPeers("standup"); // → ['peer-uuid-1', ...]
await adapter.getActiveRooms(); // → ['standup', 'engineering']
await adapter.getRoomPeerDetails("standup"); // → [{ peerId, processId, joinedAt }]
```

---

### RoomPersistence

Snapshots room structure to Redis and restores it on restart. Peer connections
are not persisted (they can't survive a restart), but room IDs and metadata are.

```js
const { RoomPersistence } = require("webrtc-rooms");
const { createClient } = require("redis");

const redis = await createClient({ url: process.env.REDIS_URL }).connect();
const server = createServer({ port: 3000, autoCreateRooms: false });

const persistence = new RoomPersistence({ redis, server });

// Step 1: restore before accepting connections
const { restored, skipped } = await persistence.restore();
console.log(`Restored ${restored.length} rooms`);

// Step 2: persist future changes
persistence.attach();

// Inspect snapshots
const snapshots = await persistence.listSnapshots();
// → [{ roomId, metadata, maxPeers, createdAt, savedAt }]
```

---

### RateLimiter

Per-IP connection rate limiting and per-peer signal rate limiting.

```js
const { RateLimiter } = require("webrtc-rooms");

const limiter = new RateLimiter({
  maxConnPerMin: 30,
  maxMsgPerSec: 50,
  maxMsgPerMin: 500,
  banDurationMs: 60_000,
  whitelist: ["127.0.0.1", "::1"],
});

limiter.attach(server);

limiter.ban("1.2.3.4");
limiter.unban("1.2.3.4");
limiter.bans(); // → [{ ip, expiresIn }]
limiter.destroy();

limiter.on("ip:banned", ({ ip, until }) => {});
limiter.on("connection:blocked", ({ ip }) => {});
limiter.on("signal:blocked", ({ peerId }) => {});
```

---

### AdminAPI

HTTP administration REST API — standalone or Express-mountable.

```js
const { AdminAPI } = require("webrtc-rooms");

const admin = new AdminAPI({ server, adminSecret: process.env.ADMIN_SECRET });
admin.listen(4000); // standalone
app.use("/admin", admin.router()); // or mount on Express
await admin.close();
```

| Method             | Path                         | Description          |
| ------------------ | ---------------------------- | -------------------- |
| `GET`              | `/admin/health`              | Liveness check       |
| `GET`              | `/admin/stats`               | Rooms, peers, memory |
| `GET/POST`         | `/admin/rooms`               | List / create rooms  |
| `GET/PATCH/DELETE` | `/admin/rooms/:id`           | Room CRUD            |
| `POST`             | `/admin/rooms/:id/broadcast` | Send to room         |
| `GET`              | `/admin/peers`               | List peers           |
| `DELETE`           | `/admin/peers/:id`           | Kick peer            |

All routes require `Authorization: Bearer <adminSecret>` when `adminSecret` is set.

---

### GovernanceEndpoints

15 additional compliance and observability endpoints.

```js
const { GovernanceEndpoints } = require("webrtc-rooms");

const gov = new GovernanceEndpoints({
  server,
  adminSecret: process.env.ADMIN_SECRET,
  audit,
  consent,
  residency,
  metrics,
  tracer,
  sessionMgr,
  sfuOrchestrator,
  threatDetector,
});

gov.listen(4001);
```

| Method            | Path                                   | Description                 |
| ----------------- | -------------------------------------- | --------------------------- |
| `GET`             | `/audit`                               | Query audit log             |
| `GET`             | `/audit/export`                        | Stream full log as NDJSON   |
| `GET`             | `/compliance/consents`                 | All active consent records  |
| `GET/POST/DELETE` | `/compliance/consents/:roomId/:peerId` | Consent CRUD                |
| `GET`             | `/residency`                           | Data residency status       |
| `GET`             | `/sessions`                            | Active session states       |
| `DELETE`          | `/sessions/:peerId`                    | Force-expire a session      |
| `GET`             | `/metrics/prometheus`                  | Prometheus text export      |
| `GET`             | `/traces`                              | Recent trace spans          |
| `GET`             | `/sfu`                                 | SFU fleet status            |
| `POST`            | `/sfu/failover`                        | Trigger manual SFU failover |
| `GET`             | `/threats`                             | Active bans                 |
| `DELETE`          | `/threats/bans/:ip`                    | Lift a ban                  |

---

## Wire protocol

### Client → server

| Type | Required fields | Description |
|---|---|---|
| `join` | `roomId`, `metadata?` | Enter (or create) a room |
| `reconnect` | `token`, `roomId`, `lastSeenSeq?` | Resume a session |
| `offer` | `target`, `sdp` | Forward SDP offer |
| `answer` | `target`, `sdp` | Forward SDP answer |
| `ice-candidate` | `target`, `candidate` | Forward ICE candidate |
| `data` | `payload`, `target?` | Relay payload (also used for SFU/E2EE/consent signals) |
| `metadata` | `patch` | Update own metadata |
| `leave` | — | Voluntarily exit the room |

### Server → client

| Type | Description |
|---|---|
| `connected` | Peer ID assigned |
| `session:token` | Reconnect token + TTL (from SessionManager) |
| `room:joined` | Roster + metadata snapshot |
| `room:state` | Full snapshot after reconnect |
| `room:updated` | Room metadata delta |
| `peer:joined` / `peer:left` / `peer:updated` / `peer:reconnected` | Roster events |
| `offer` / `answer` / `ice-candidate` | Forwarded WebRTC signals |
| `data` | Relayed application payload |
| `kicked` | Peer force-closed |
| `error` | Protocol error `{ code, message? }` |
| `sfu:ready` | SFU transport info on join |
| `sfu:published` / `sfu:subscribed` / `sfu:layer:auto` | SFU state events |
| `e2e:key:snapshot` / `e2e:key:announced` / `e2e:key:rotated` / `e2e:key:revoked` | E2EE key events |
| `consent:required` / `consent:confirmed` | Consent flow |
| `region:hint` | Migration hint from RegionRouter |
| `replay:start` / `replay:end` | Event replay envelope |
| `server:warning` | Backpressure / load warnings |

---

## Authentication

```js
const server = createServer({
  port: 3000,
  beforeJoin: async (peer, roomId) => {
    const user = await db.verifyToken(peer.metadata.token);
    if (!user) return "Invalid token";

    peer.setMetadata({
      token: null, // strip raw token — never broadcast to other peers
      userId: user.id,
      displayName: user.name,
      role: user.role,
    });

    return true;
  },
});
```

For policy-based access control with capability enforcement, use `PolicyEngine`
instead of a raw `beforeJoin` hook — it handles token signing, verification,
and capability injection automatically.

---

## Reconnection

```js
const server = createServer({ port: 3000, reconnectTtl: 15_000 });
```

On socket drop the peer's slot is held for 15 seconds. The browser reconnects:

```js
ws.send(
  JSON.stringify({
    type: "reconnect",
    token: sessionStorage.getItem("reconnectToken"),
    roomId: currentRoomId,
    lastSeenSeq: parseInt(sessionStorage.getItem("lastSeenSeq") || "-1", 10),
  }),
);
```

`SessionManager` provides cross-process resume — the peer can reconnect to a
different process behind a load balancer and still resume their session.

---

## Multi-server scaling

```js
const { RedisAdapter, SessionManager } = require("webrtc-rooms");
const { createClient } = require("redis");

const [pub, sub, rds] = await Promise.all([
  createClient({ url: REDIS_URL }).connect(),
  createClient({ url: REDIS_URL }).connect(),
  createClient({ url: REDIS_URL }).connect(),
]);

// Cross-process signaling
const adapter = new RedisAdapter({ pub, sub, server });
await adapter.init();

// Cross-process session resume
const sessions = new SessionManager({ reconnectTtl: 30_000, redis: rds });
sessions.attach(server);
```

---

## Room persistence

```js
const { RoomPersistence } = require("webrtc-rooms");

const persistence = new RoomPersistence({ redis, server });
await persistence.restore(); // before clients connect
persistence.attach(); // persist future changes
```

---

## SFU mode

```js
const { NativeSFUEngine, SFUOrchestrator } = require("webrtc-rooms");

const sfu = new NativeSFUEngine({
  region: "ap-south-1",
  enableSimulcast: true,
});
const orch = new SFUOrchestrator({ server });
orch.register("ap-south-1", sfu);
await orch.init();
```

Browsers use `{ __sfu: 'publish' }` and `{ __sfu: 'subscribe' }` signals
through the data relay. No extra client library required.

---

## Adaptive bitrate

```js
const { AdaptiveBitrateController } = require("webrtc-rooms");

const abc = new AdaptiveBitrateController({
  sfuEngine: sfu,
  mobileFirst: true,
});
abc.attach(server);
```

Browsers send RTCP feedback signals (`pli`, `nack`, `remb`) through the data
relay. The controller automatically adjusts each subscriber's simulcast layer
independently.

---

## End-to-end encryption

```js
const { E2EKeyExchange } = require("webrtc-rooms");

const e2e = new E2EKeyExchange({ server, requireKeyOnJoin: true });
e2e.attach();
```

The server distributes ECDH public keys. Browsers derive shared secrets and
encrypt media using the Insertable Streams API. See the
[E2EKeyExchange](#e2ekeyexchange) section for the full browser-side flow.

---

## Observability

```js
const {
  MetricsCollector,
  Tracer,
  AlertManager,
  HealthMonitor,
} = require("webrtc-rooms");

const metrics = new MetricsCollector({ server });
const tracer = new Tracer({ server, mode: "buffer" });
const health = new HealthMonitor({ server, metrics });
const alerts = new AlertManager({ channels: [{ type: "console" }] });

metrics.attach();
tracer.attach();
health.attach();
alerts.attachHealthMonitor(health);

// Prometheus
app.get("/metrics", (req, res) =>
  res.type("text/plain").send(metrics.toPrometheus()),
);
```

---

## Security

```js
const { ThreatDetector, AuditLogger, PolicyEngine } = require("webrtc-rooms");

const threats = new ThreatDetector({ server });
const audit = new AuditLogger({ server, filePath: "./logs/audit.ndjson" });
const policy = new PolicyEngine({
  secret: process.env.POLICY_SECRET,
  required: true,
});

threats.attach();
audit.attach();
policy.attach(server);

threats.on("threat", ({ level, threat, ip }) => {
  if (level === "ban") alerting.critical(`Banned ${ip} for ${threat}`);
});
```

---

## Compliance

```js
const { ConsentFlow, DataResidency, RetentionPolicy } = require("webrtc-rooms");

// Consent before recording
const consent = new ConsentFlow({
  server,
  required: ["recording"],
  allParty: true,
});
consent.attach();

// Data locality
const residency = new DataResidency({
  server,
  localRegion: "ap-south-1",
  allowedRegions: ["ap-south-1"],
});
residency.attach();

// Retention and right-to-erasure
const retention = new RetentionPolicy({ recordingRetentionDays: 90 });
retention.register({ id: recordingId, type: "recording", sub: userId });
```

---

## Moderation

```js
const { ModerationBus } = require("webrtc-rooms");

const modbus = new ModerationBus({ server, policyEngine: policy });
modbus.attach();

// Moderator actions (require 'moderate' capability via PolicyEngine)
modbus.mute({ roomId, targetId: offenderPeerId, actorId: moderatorPeerId });
modbus.lockRoom(roomId, actorId);

// Abuse reporting from browser:
// ws.send(JSON.stringify({ type: 'data', payload: { __mod: 'report:abuse', targetId, reason } }))
```

---

## Mounting on Express

```js
const http = require("http");
const express = require("express");
const {
  createServer,
  AdminAPI,
  RateLimiter,
  MetricsCollector,
  GovernanceEndpoints,
} = require("webrtc-rooms");

const app = express();
const httpServer = http.createServer(app);
const server = createServer({ server: httpServer });

new RateLimiter({ maxConnPerMin: 30 }).attach(server);

const metrics = new MetricsCollector({ server });
metrics.attach();

const admin = new AdminAPI({ server, adminSecret: process.env.ADMIN_SECRET });
app.use("/admin", admin.router());

app.get("/metrics", (req, res) =>
  res.type("text/plain").send(metrics.toPrometheus()),
);

httpServer.listen(3000);
```

---

## TypeScript

Full type definitions included for all 36 exports:

```ts
import {
  createServer,
  SignalingServer,
  Room,
  Peer,
  SessionManager,
  PolicyEngine,
  NativeSFUEngine,
  SFUOrchestrator,
  AdaptiveBitrateController,
  RegionRouter,
  ThreatDetector,
  AuditLogger,
  MetricsCollector,
  Tracer,
  AlertManager,
  HealthMonitor,
  EventReplay,
  BackpressureController,
  ModerationBus,
  RecordingPipeline,
  ConsentFlow,
  DataResidency,
  RetentionPolicy,
  E2EKeyExchange,
  RedisAdapter,
  RoomPersistence,
  RateLimiter,
  AdminAPI,
  GovernanceEndpoints,
  // Type aliases
  PeerStateValue,
  MetadataMap,
  BeforeJoinHook,
  ServerMessage,
  ClientSignal,
  ServerStats,
  RoomSnapshot,
  Session,
  Policy,
  Capability,
  SFUHealthValue,
  LoadLevelValue,
  ConsentType,
  PersistedRoomSnapshot,
  RestoreResult,
  PublicKeyEntry,
  RoomKeyEntry,
} from "webrtc-rooms";

const server: SignalingServer = createServer({ port: 3000 });

server.on("peer:joined", (peer: Peer, room: Room) => {
  console.log(peer.metadata.displayName, peer.state);
});
```

---

## Running tests

```bash
npm install
npm test

node tests/index.test.js              # core signaling — 43 tests
node tests/features.test.js           # 1.x features — 41 tests
node tests/redis-persistence-e2e.test.js  # Redis + E2EE — 35 tests
node tests/test1.test.js               # Test 1 modules — 62 tests
node tests/test2.test.js               # Test 2 modules — 55 tests
node tests/test3.test.js               # Test 3 + CLI + load — 29 tests
```

All suites use in-process mocks. No live Redis, no SFU server, no external
test runner required. Run directly with `node`.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup instructions, coding
standards, pull request process, and code merge rules.

For project governance, see [GOVERNANCE.md](./GOVERNANCE.md).
For security reports, see [SECURITY.md](./SECURITY.md).
For community standards, see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
For support channels, see [SUPPORT.md](./SUPPORT.md).

---

## Roadmap

- [x] Redis pub/sub adapter for multi-process deployments
- [x] Room persistence across restarts
- [x] End-to-end encryption key-exchange
- [x] Native SFU (NativeSFUEngine) — zero external SFU dependency
- [x] Multi-region SFU orchestration and failover
- [x] Adaptive bitrate with simulcast layer control
- [x] Enterprise compliance toolkit (ConsentFlow, DataResidency, RetentionPolicy)
- [x] Production observability (MetricsCollector, Tracer, AlertManager, HealthMonitor)
- [x] Developer CLI (init, simulate, benchmark, health)
- [ ] `webrtc-rooms-client` — browser SDK with auto-reconnect and typed signaling

---

## License

[MIT](./LICENSE) © [Himanshu Pandey](https://github.com/himanshu-pandey-git)
