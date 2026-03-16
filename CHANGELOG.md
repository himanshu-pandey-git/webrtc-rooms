# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

- No entries yet.

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
