# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

- No entries yet.

## [2.0.0] — 2026-03-22

v2.0.0 is a complete architecture overhaul delivering production-grade
infrastructure for companies and startups building real-time video/audio
products. All additions are new modules — the 1.x signaling core is fully
preserved and backward compatible within the same entry point.

### Breaking changes

- **`package.json` `"type": "commonjs"` is now explicit.** Projects that
  relied on implicit CJS detection may need `"type": "commonjs"` in their
  own `package.json` when using this version.
- **`MediasoupAdapter` is deprecated** in favour of `NativeSFUEngine` +
  `SFUOrchestrator`. The old class is still exported as `MediasoupAdapter`
  for compatibility but will be removed in v2.1.0.
- **`RecordingAdapter` is deprecated** in favour of `RecordingPipeline`.
  Still exported as `RecordingAdapter` until v2.1.0.

### Added

**Native SFU — no external SFU dependency**

- `NativeSFUEngine` — zero-dependency SFU engine built on the Node.js event
  loop. Handles publish/subscribe, simulcast layer selection, and producer
  lifecycle. No mediasoup, no Livekit, no external process.
- `SFUOrchestrator` — manages a fleet of SFU adapters across regions with
  health monitoring (3-tier: healthy/degraded/down), automatic failover,
  and room migration. Supports any number of registered regions.
- `AdaptiveBitrateController` — per-subscriber quality scoring from RTCP
  feedback (PLI, NACK, REMB). Selects simulcast layers with hysteresis to
  prevent oscillation. Mobile-first tuning. Protects active speaker and
  screen-share tracks from downgrade.
- `RegionRouter` — region-aware peer and room assignment with 5 routing
  modes (latency, affinity, residency, load, manual). Emits migration hints.
- `SFUInterface` — abstract base class for custom SFU adapters.

**Session management**

- `SessionManager` — HMAC-SHA256 signed reconnect tokens, cross-process
  session resume via Redis, session migration between regions, and per-session
  outbound message queuing (up to 64 messages during suspension).

**Auth and access control**

- `PolicyEngine` — signed room policy tokens with capability enforcement
  (`publish`, `subscribe`, `kick`, `record`, `moderate`, `data`, `admin`).
  Integrates into `beforeJoin` hook automatically. Zero external dependencies.
- `RoomToken` — short-lived JWT-style room access tokens (HMAC-SHA256).

**Security**

- `ThreatDetector` — 8 threat models: connection flood, signal flood, room
  cycling, SDP spam, data channel abuse, metadata poisoning, idle timeout,
  amplification detection. Four response levels: warn / throttle / kick / ban.
- `AuditLogger` — append-only structured audit log (NDJSON) with ring buffer,
  file sink with automatic rotation, custom async sink, and GDPR-ready IP
  redaction. SOC2/HIPAA-ready.

**Observability**

- `MetricsCollector` — per-room QoS metrics with P50/P95/P99 join latency
  histograms, reconnect success rates, and Prometheus text export
  (`/metrics`).
- `Tracer` — lightweight distributed tracing with OpenTelemetry-compatible
  span model. Buffer, console, and custom exporter modes. Zero SDK dependency.
- `AlertManager` — wires health, threat, SFU, and backpressure events into
  configurable alert channels (console, webhook, custom handler).

**Reliability**

- `EventReplay` — per-room ordered event log with deduplication and sequence
  numbers. Replays missed events to reconnecting peers. Cross-process replay
  via Redis.
- `BackpressureController` — 5 load levels (normal/elevated/high/critical/
  shedding). Gates new joins under critical load. Sheds lowest-priority peers
  when heap exceeds 95%.
- `HealthMonitor` — SLO tracking (join success rate, P95 latency, reconnect
  rate, error rate, memory). Fires `slo:breach` and `slo:recovered` events.

**Recording**

- `RecordingPipeline` — replaces `RecordingAdapter` with a structured session
  model, completion index, search API, and optional async upload hook.

**Moderation**

- `ModerationBus` — structured moderation actions (mute, unmute, kick, warn,
  report abuse, lock/unlock room) with capability checking via `PolicyEngine`
  and a searchable in-memory log.

**Compliance**

- `RetentionPolicy` — data retention record store with legal hold support,
  bulk purge, subject anonymisation, and expiry tracking. SOC2/HIPAA-ready.
- `DataResidency` — region-aware join enforcement with GeoIP lookup hook.
  Tags all outbound events with originating region.
- `ConsentFlow` — GDPR Article 6 / HIPAA-ready consent collection for
  recording, processing, sharing, and analytics. All-party consent mode for
  jurisdictions requiring it.

**Admin**

- `GovernanceEndpoints` — extends `AdminAPI` with 15 compliance and
  observability REST endpoints: audit log query/export, consent management,
  data residency status, session administration, Prometheus metrics, trace
  inspection, SFU fleet control, and threat ban management.

**CLI**

- `webrtc-rooms init [dir] --template <basic|advanced|sfu|enterprise>` —
  scaffolds a new project from a production-ready template.
- `webrtc-rooms simulate --processes N --port N --redis <url>` — starts a
  local multi-process cluster for development.
- `webrtc-rooms benchmark --peers N --rooms N --duration N` — reproducible
  load test harness producing P50/P95/P99 reports.
- `webrtc-rooms health [url] --secret <token>` — checks a running server.

**TypeScript**

- `src/index.d.ts` covering all 36 exported symbols with full option
  interfaces, event maps, and discriminated unions.
  All v2 types: `SessionManager`, `PolicyEngine`, `NativeSFUEngine`,
  `SFUOrchestrator`, `AdaptiveBitrateController`, `RegionRouter`,
  `ThreatDetector`, `MetricsCollector`, `Tracer`, `AlertManager`,
  `EventReplay`, `BackpressureController`, `HealthMonitor`, `ModerationBus`,
  `RetentionPolicy`, `DataResidency`, `ConsentFlow`, `AuditLogger`,
  `RecordingPipeline`, `GovernanceEndpoints`.

**Tests**

- `tests/test1.test.js` — 62 tests: SessionManager, PolicyEngine,
  NativeSFUEngine, SFUOrchestrator, MetricsCollector, ThreatDetector,
  BackpressureController, AuditLogger.
- `tests/test2.test.js` — 55 tests: AdaptiveBitrateController, EventReplay,
  HealthMonitor, ModerationBus, RetentionPolicy, DataResidency, ConsentFlow,
  AlertManager, Tracer, RegionRouter, GovernanceEndpoints.
- `tests/test3.test.js` — 29 tests: CLI init scaffolding, all 36 exports,
  hardening/edge cases, full v2 stack integration, in-process load stress,
  and smoke test.
- **Total: 181 tests across 4 suites, 0 failures.**

### Changed

- `src/index.js` — expanded from 8 exports to 36. All new modules registered.
- `package.json`:
  - Version `1.1.1` → `2.0.0`
  - Added `"bin": { "webrtc-rooms": "./cli/index.js" }` for CLI
  - Added `cli/` to `"files"` array
  - Added `tests/test1.test.js`, `tests/test2.test.js`, `tests/test3.test.js`
    to `"scripts.test"`
  - Added `"test:test1"`, `"test:test2"`, `"test:test3"` convenience scripts
  - Updated `author.url` to `https://github.com/himanshu-pandey-git`
  - Added 9 new keywords: `redis`, `e2e-encryption`, `room-persistence`,
    `observability`, `metrics`, `compliance`, `adaptive-bitrate`,
    `multi-region`, `enterprise`

## [1.1.1] — 2026-03-16

### Fixed

- `Room.js` — use module-level `PeerState` constant for peer state assignment
  in `addPeer` instead of an inline `require('./Peer')` on every call
- `RecordingAdapter` — corrected `FFMPEG_FLUSH_TIMEOUT_MS` comment; it
  describes a flush timeout, not a message buffer count
- `tsconfig.json` — migrate TypeScript module settings to
  `module: "node16"` and `moduleResolution: "node16"` to resolve the
  `moduleResolution: node10` deprecation warning without using suppression

### Changed

- `package.json` — version `1.1.0` to `1.1.1`

## [1.1.0] — 2026-03-16

### Added

**Horizontal scaling and persistence**

- `RedisAdapter` for cross-process signaling via Redis pub/sub.
- `RoomPersistence` for Redis-backed room metadata snapshots and restore.

**End-to-end encryption helpers**

- `E2EKeyExchange` server-side signaling helper for E2EE key announce/rotate/revoke.
- New E2EE message flow support documented in README.

**Testing**

- Added `tests/redis-persistence-e2e.test.js` with focused coverage for:
  - `RedisAdapter`
  - `RoomPersistence`
  - `E2EKeyExchange`

### Changed

- Package version bumped from `1.0.0` to `1.1.0`.
- CI matrix expanded to include Node.js 24.
- `npm test` now runs both the core suite and Redis/Persistence/E2E suite.
- Policy/document file names standardized to uppercase:
  - `CONTRIBUTING.md`
  - `CHANGELOG.md`
- Packaging metadata hardened for npm release quality:
  - Added explicit `type` and `exports` fields in `package.json`.
  - Added `LICENSE` file and normalized repository URL format.
  - Reduced published footprint by excluding `tests/` from tarball.
  - Added `ioredis` and `redis` as optional peer dependencies.
  - Added `@types/node` and `@types/ws` to devDependencies.
  - Added `typecheck` script backed by `tsconfig.json`.
- Added publish automation with npm provenance via GitHub Actions:
  - `.github/workflows/npm-publish.yml`
  - Publish command uses `npm publish --provenance --access public`.

## [1.0.0] — 2026-03-15

### Added

**Core signaling**

- `SignalingServer` — WebSocket signaling server with full offer/answer/ICE routing.
- `Room` — Multi-peer session managing signaling, data relay, metadata sync, and reconnection.
- `Peer` — WebSocket wrapper with a `connecting → joined → reconnecting → closed` state machine.
- `createServer(options)` — Factory function; recommended entry point.

**Authentication**

- `beforeJoin` async hook on `SignalingServer` — return `true` to allow, `false` or a string
  to reject. Peer metadata is available when the hook runs so token-based auth is straightforward.

**Reconnection**

- `reconnectTtl` option on `SignalingServer` — dropped peers hold their slot for the configured
  duration. The browser receives a `reconnectToken` and can resume within the grace period.
- Outbound message queue in `Peer` (up to 32 messages) flushed automatically on reconnect.

**Data relay**

- `{ type: 'data', payload, target? }` signal — broadcast to the room or unicast to a specific peer
  through the signaling connection. Useful as a fallback when a direct `RTCDataChannel` is unavailable.

**Peer metadata**

- `{ type: 'metadata', patch }` signal — peers can update their own display name, mute state,
  or any other primitive key/value at any time. Changes are broadcast to the room as deltas.
- Room-level metadata via `room.setMetadata(patch)` — broadcast to all peers as `room:updated`.

**Recording**

- `RecordingAdapter` — ffmpeg-backed per-peer and per-room recording to `.webm` or `.mp4`.
- Auto-start/stop on `peer:joined` / `peer:left` when attached to a server.
- `startPeer(peerId, roomId)` / `stopPeer(peerId)` for manual control.
- `startRoom(roomId)` / `stopRoom(roomId)` for room-level recording.
- Events: `recording:started`, `recording:stopped`, `recording:error`, `recording:progress`,
  `recording:room:started`, `recording:room:stopped`.

**SFU**

- `MediasoupAdapter` — mediasoup v3 integration for rooms with 10+ peers.
- Round-robin worker pool (one worker per CPU by default).
- Intercepts `room:created`, `peer:joined`, and `peer:left` to manage routers and transports.
- SFU signals (`transport:connect`, `produce`, `consume`, `consumer:resume`) forwarded through
  the existing data relay channel using a `__sfu` discriminator field.

**Rate limiting**

- `RateLimiter` — per-IP connection rate limiting with automatic banning.
- Per-peer signal rate limiting (per-second and per-minute windows).
- `whitelist` for trusted IPs (e.g. load-balancer health checks).
- `ban(ip)` / `unban(ip)` / `bans()` for manual administration.

**Admin REST API**

- `AdminAPI` — HTTP administration interface, standalone or mountable on Express.
- Endpoints: health, stats, rooms (CRUD), room broadcast, peers, peer kick.
- Optional `adminSecret` for `Authorization: Bearer` authentication.

**TypeScript**

- Full type definitions in `src/index.d.ts` covering all classes, events, and wire protocol
  message types.

**Tests**

- 40+ unit and integration tests in `tests/index.test.js`.
- No external test runner required — run directly with `node tests/index.test.js`.

**Examples**

- `examples/basic-server.js` — minimal 30-line server.
- `examples/advanced-server.js` — auth, reconnection, rate limiting, recording, admin API.
- `examples/client.html` — browser test client with peer list, data relay chat, and reconnect UI.
