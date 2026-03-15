# webrtc-rooms

[![npm version](https://img.shields.io/npm/v/webrtc-rooms.svg)](https://www.npmjs.com/package/webrtc-rooms)
[![CI](https://github.com/himanshu-pandey-git/webrtc-rooms/actions/workflows/ci.yml/badge.svg)](https://github.com/himanshu-pandey-git/webrtc-rooms/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/himanshu-pandey-git/webrtc-rooms)](https://github.com/himanshu-pandey-git/webrtc-rooms/releases)
[![license](https://img.shields.io/npm/l/webrtc-rooms.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/webrtc-rooms.svg)](https://nodejs.org)

WebRTC signaling, room management, SFU, recording, and admin API for Node.js.

Built and maintained by [Himanshu Pandey](https://github.com/himanshu-pandey-git).

---

## Overview

Building a video or audio feature requires solving the same set of hard
problems every time: WebSocket signaling, offer/answer routing, ICE trickling,
room lifecycle, authentication, reconnection, and eventually scaling to more
than a handful of peers. **webrtc-rooms** solves all of these in a single
composable library so you can focus on your product.

```
npm install webrtc-rooms
```

Requires Node.js 18 or later.

---

## Quick start

```js
const { createServer } = require('webrtc-rooms');

const server = createServer({ port: 3000 });

server.on('peer:joined', (peer, room) => {
  console.log(`${peer.metadata.displayName} joined "${room.id}"`);
});
```

Open `examples/client.html` in two browser tabs, join the same room, and you
have a working peer-to-peer video call.

---

## How it works

The server routes signaling messages between browsers. Media travels directly
peer-to-peer (P2P) — the server never touches audio or video. For rooms with
many participants, attach the optional `MediasoupAdapter` to route media
through the server instead (SFU mode).

```
Browser A                 webrtc-rooms server              Browser B
    │                           │                               │
    ├── { join, roomId } ──────►│                               │
    │◄─ { room:joined, peers }  │                               │
    │                           │◄────── { join, roomId } ──────┤
    │◄─ { peer:joined }         │──── { room:joined, peers } ──►│
    │                           │                               │
    ├── { offer, target:B } ───►│──── { offer, from:A } ───────►│
    │                           │◄─── { answer, target:A } ─────┤
    │◄─ { answer, from:B } ─────│                               │
    │                           │                               │
    ◄──────────── ICE trickle ──┼──────── ICE trickle ─────────►│
    │                                                            │
    ◄═══════════════ direct P2P media (no server) ══════════════►│
```

---

## Table of contents

- [Installation](#installation)
- [API reference](#api-reference)
  - [createServer](#createserveroptions--signalingserver)
  - [SignalingServer](#signalingserver)
  - [Room](#room)
  - [Peer](#peer)
  - [RecordingAdapter](#recordingadapter)
  - [MediasoupAdapter](#mediasoupadapter)
  - [RateLimiter](#ratelimiter)
  - [AdminAPI](#adminapi)
- [Wire protocol](#wire-protocol)
- [Authentication](#authentication)
- [Reconnection](#reconnection)
- [Recording](#recording)
- [SFU mode](#sfu-mode)
- [Rate limiting](#rate-limiting)
- [Admin REST API](#admin-rest-api)
- [TypeScript](#typescript)
- [Mounting on Express](#mounting-on-express)
- [Contributing](#contributing)
- [License](#license)

---

## Installation

```bash
npm install webrtc-rooms
```

For SFU support, also install the optional peer dependency:

```bash
npm install mediasoup
```

For recording, `ffmpeg` must be installed and available on `PATH`.

---

## API reference

### `createServer(options)` → `SignalingServer`

The recommended entry point. Creates and returns a `SignalingServer`.

```js
const { createServer } = require('webrtc-rooms');

const server = createServer({
  port:             3000,       // port to listen on (ignored if `server` is provided)
  server:           httpServer, // attach to an existing http.Server
  maxPeersPerRoom:  50,         // hard cap on concurrent peers per room
  autoCreateRooms:  true,       // create rooms on first join
  autoDestroyRooms: true,       // destroy empty rooms automatically
  reconnectTtl:     15_000,     // ms a dropped peer's slot stays warm (0 = off)
  beforeJoin:       async (peer, roomId) => { /* see Authentication */ },
});
```

---

### SignalingServer

#### Events

```js
server.on('listening',        ({ port }) => { });
server.on('peer:connected',   (peer) => { });          // raw WS open, before room join
server.on('peer:joined',      (peer, room) => { });
server.on('peer:left',        (peer, room) => { });
server.on('peer:reconnected', (peer, room) => { });
server.on('room:created',     (room) => { });
server.on('room:destroyed',   (room) => { });
server.on('join:rejected',    (peer, reason) => { });
```

#### Methods

```js
// Create a room programmatically (required when autoCreateRooms is false)
server.createRoom('standup', { metadata: { topic: 'Daily standup' } });

// Look up a room
const room = server.getRoom('standup'); // → Room | undefined

// Force-remove a peer
server.kick(peerId, 'Behaviour policy violation');

// Server health snapshot
server.stats(); // → { rooms, peers, roomList }

// Graceful shutdown
await server.close();
```

---

### Room

```js
// Programmatic broadcast (e.g. from a server-side process)
room.broadcast({ type: 'server:notice', text: 'Recording started.' });

// Broadcast excluding specific peers
room.broadcast({ type: 'data', payload: 'hello' }, { exclude: [peer.id] });

// Update room metadata — immediately broadcast to all peers as room:updated
room.setMetadata({ topic: 'New topic', recordingActive: true });

// Full snapshot (used by AdminAPI and reconnecting peers)
room.getState(); // → { id, metadata, peers[], createdAt }

// Properties
room.size;    // number of peers
room.isEmpty; // boolean
```

---

### Peer

```js
peer.id                        // string — UUID v4
peer.state                     // 'connecting' | 'joined' | 'reconnecting' | 'closed'
peer.metadata                  // { displayName, role, userId, ... }
peer.isActive                  // true when state === 'joined'
peer.connectedAt               // Unix timestamp (ms)

// Merge a patch into peer metadata.
// null values remove the key; the updated object is returned.
peer.setMetadata({ displayName: 'Alice', token: null });

// Send any JSON-serialisable message to this peer.
// Queues up to 32 messages if the peer is reconnecting.
peer.send({ type: 'custom:event', data: 'anything' });

// Force-close the connection.
peer.close(1008, 'Policy violation');

// Safe serialised form (excludes reconnectToken).
peer.toJSON(); // → { id, roomId, state, metadata }

// State constants
Peer.State.CONNECTING   // 'connecting'
Peer.State.JOINED       // 'joined'
Peer.State.RECONNECTING // 'reconnecting'
Peer.State.CLOSED       // 'closed'
```

---

### RecordingAdapter

```js
const { RecordingAdapter } = require('webrtc-rooms');

const recorder = new RecordingAdapter({
  outputDir:  './recordings', // required; created automatically
  format:     'webm',         // 'webm' (VP8+Opus) | 'mp4' (H.264+AAC)
  videoKbps:  800,
  audioKbps:  128,
});

recorder.attach(server);  // auto-start/stop on peer events

// Manual control
await recorder.startRoom('my-room');
const files = await recorder.stopRoom('my-room');
// → [{ path: './recordings/my-room/abc12345-2025-…webm', durationMs: 42000 }]

await recorder.startPeer(peerId, roomId);
const { path, durationMs } = await recorder.stopPeer(peerId);

recorder.activeRecordings();
// → [{ peerId, roomId, filePath, durationMs }]
```

**Events**

```js
recorder.on('recording:started',       ({ peerId, roomId, path }) => { });
recorder.on('recording:stopped',       ({ peerId, roomId, path, durationMs }) => { });
recorder.on('recording:error',         ({ peerId, roomId, error }) => { });
recorder.on('recording:progress',      ({ peerId, roomId, line }) => { });   // ffmpeg stderr
recorder.on('recording:room:started',  ({ roomId, peers }) => { });
recorder.on('recording:room:stopped',  ({ roomId, files }) => { });
```

Requires `ffmpeg` on `PATH`. In a `wrtc` (node-webrtc) deployment, replace
the lavfi test-source inputs in `RecordingAdapter._buildFfmpegArgs()` with your
actual RTP source descriptors.

---

### MediasoupAdapter

```js
const { MediasoupAdapter } = require('webrtc-rooms');

const sfu = new MediasoupAdapter({
  listenIp:    '0.0.0.0',
  announcedIp: process.env.PUBLIC_IP,   // required behind NAT
  rtcMinPort:  10000,
  rtcMaxPort:  10200,
});

await sfu.init();   // spawn one worker per CPU; must be awaited before attach()
sfu.attach(server);

sfu.stats();
// → { workers: 4, rooms: [{ roomId, transports, producers, consumers }] }

await sfu.close();
```

When attached, browsers receive a `sfu:transport:created` message on join and
must use `mediasoup-client` instead of a plain `RTCPeerConnection`.

SFU signals are sent through the existing data relay channel using a `__sfu`
discriminator:

```js
// Browser sends these through the normal data relay:
ws.send(JSON.stringify({ type: 'data', payload: { __sfu: 'produce', kind: 'video', rtpParameters: { … } } }));
ws.send(JSON.stringify({ type: 'data', payload: { __sfu: 'consume', producerId, rtpCapabilities } }));
ws.send(JSON.stringify({ type: 'data', payload: { __sfu: 'consumer:resume', producerId } }));
```

---

### RateLimiter

```js
const { RateLimiter } = require('webrtc-rooms');

const limiter = new RateLimiter({
  maxConnPerMin:  20,      // new connections per IP per minute before ban
  maxMsgPerSec:   30,      // signals per peer per second
  maxMsgPerMin:   200,     // signals per peer per minute
  banDurationMs:  60_000,  // how long a banned IP is blocked
  whitelist:      ['127.0.0.1', '::1'],
});

limiter.attach(server);   // must be called after createServer()

limiter.on('ip:banned',        ({ ip, until }) => { });
limiter.on('connection:blocked', ({ ip }) => { });
limiter.on('signal:blocked',    ({ peerId }) => { });

// Manual administration
limiter.ban('1.2.3.4');
limiter.unban('1.2.3.4');
limiter.bans();  // → [{ ip, expiresIn }]

// Clean up the internal interval when shutting down
limiter.destroy();
```

---

### AdminAPI

```js
const { AdminAPI } = require('webrtc-rooms');

// Standalone (its own HTTP server)
const admin = new AdminAPI({ server, adminSecret: process.env.ADMIN_SECRET });
admin.listen(4000);

// Or mount on Express / any compatible framework
app.use('/admin', admin.router());

await admin.close();
```

#### Endpoints

| Method   | Path                              | Description                           |
|----------|-----------------------------------|---------------------------------------|
| `GET`    | `/admin/health`                   | Liveness check (`{ status: 'ok' }`)   |
| `GET`    | `/admin/stats`                    | Rooms, peers, memory, node version    |
| `GET`    | `/admin/rooms`                    | List all rooms                        |
| `POST`   | `/admin/rooms`                    | Create room `{ roomId?, metadata? }`  |
| `GET`    | `/admin/rooms/:id`                | Full room state + peer list           |
| `PATCH`  | `/admin/rooms/:id`                | Update room metadata `{ metadata }`   |
| `DELETE` | `/admin/rooms/:id`                | Destroy room; kicks all its peers     |
| `POST`   | `/admin/rooms/:id/broadcast`      | Send data payload to room             |
| `GET`    | `/admin/peers`                    | List all connected peers              |
| `DELETE` | `/admin/peers/:id`                | Kick a peer `{ reason? }`             |

All routes require `Authorization: Bearer <adminSecret>` when `adminSecret` is set.
Unauthorized requests receive `401 Unauthorized`.

---

## Wire protocol

### Client → server

| Type            | Required fields              | Description                              |
|-----------------|------------------------------|------------------------------------------|
| `join`          | `roomId`, `metadata?`        | Enter (or create) a room                 |
| `reconnect`     | `token`, `roomId`            | Resume a session after socket drop       |
| `offer`         | `target`, `sdp`              | Forward SDP offer to `target` peer       |
| `answer`        | `target`, `sdp`              | Forward SDP answer to `target` peer      |
| `ice-candidate` | `target`, `candidate`        | Forward ICE candidate to `target` peer   |
| `data`          | `payload`, `target?`         | Relay payload; omit `target` to broadcast|
| `metadata`      | `patch`                      | Update own metadata (primitives only)    |
| `leave`         | —                            | Voluntarily exit the room                |

### Server → client

| Type                | Description                                              |
|---------------------|----------------------------------------------------------|
| `connected`         | Assigned peer ID; sent immediately after WS opens        |
| `room:joined`       | Roster + metadata snapshot; sent to the joining peer     |
| `room:state`        | Full snapshot sent after a successful reconnect          |
| `room:updated`      | Room metadata delta broadcast to all peers               |
| `peer:joined`       | Broadcast when a new peer enters the room                |
| `peer:left`         | Broadcast when a peer disconnects                        |
| `peer:updated`      | Broadcast when a peer's metadata changes                 |
| `peer:reconnected`  | Broadcast when a peer resumes after a socket drop        |
| `metadata:updated`  | Confirmation sent to the peer that updated its metadata  |
| `offer`             | Forwarded SDP offer                                      |
| `answer`            | Forwarded SDP answer                                     |
| `ice-candidate`     | Forwarded ICE candidate                                  |
| `data`              | Relayed application payload                              |
| `kicked`            | Sent to a peer before their connection is force-closed   |
| `error`             | Signaling or protocol error `{ code, message? }`         |

---

## Authentication

Implement the `beforeJoin` hook to authenticate peers before they enter any room.
The hook receives the `Peer` instance (with `peer.metadata` already populated from
the `join` message) and the target `roomId`.

```js
const server = createServer({
  port: 3000,
  beforeJoin: async (peer, roomId) => {
    // Read the token the browser sent in the join message
    const user = await db.verifyToken(peer.metadata.token);

    if (!user) return 'Invalid or expired token';

    // Strip the raw token so it is never broadcast to other peers
    peer.setMetadata({
      token:       null,
      userId:      user.id,
      displayName: user.name,
      role:        user.role,
    });

    // Role-based room access
    if (user.role === 'viewer' && roomId !== 'all-hands') {
      return 'Viewers may only join the all-hands room';
    }

    return true; // allow the join
  },
});
```

The browser sends the token in the `join` message:

```js
ws.send(JSON.stringify({
  type:     'join',
  roomId:   'engineering',
  metadata: { token: 'my-jwt-here' },
}));
```

---

## Reconnection

Enable reconnection by setting `reconnectTtl` (milliseconds) on the server.
The browser receives a `reconnectToken` in the `room:joined` message and must
persist it in `sessionStorage` or `localStorage`.

```js
const server = createServer({ port: 3000, reconnectTtl: 15_000 });
```

When the WebSocket drops, the peer's slot is held for 15 seconds. Any messages
sent to the peer during this window are queued (up to 32). The browser
reconnects by sending a `reconnect` message instead of `join`:

```js
// On reconnect:
ws.send(JSON.stringify({
  type:   'reconnect',
  token:  sessionStorage.getItem('reconnectToken'),
  roomId: currentRoomId,
}));
```

On success the server sends `room:state` with the current room snapshot. If
the token has expired or is unknown, the peer falls back to a normal join.

---

## Mounting on Express

```js
const http    = require('http');
const express = require('express');
const { createServer, AdminAPI, RateLimiter } = require('webrtc-rooms');

const app        = express();
const httpServer = http.createServer(app);

// Signaling on the same port as your Express app
const signalingServer = createServer({ server: httpServer });

// Rate limiting
const limiter = new RateLimiter({ maxConnPerMin: 20 });
limiter.attach(signalingServer);

// Admin API mounted under /admin
const admin = new AdminAPI({
  server:      signalingServer,
  adminSecret: process.env.ADMIN_SECRET,
});
app.use('/admin', admin.router());

httpServer.listen(3000);
```

---

## TypeScript

Full type definitions are included. Import types as needed:

```ts
import {
  createServer,
  SignalingServer,
  Room,
  Peer,
  RecordingAdapter,
  MediasoupAdapter,
  RateLimiter,
  AdminAPI,
  // Type aliases
  PeerStateValue,
  MetadataMap,
  BeforeJoinHook,
  ServerMessage,
  ClientSignal,
  ServerStats,
  RoomSnapshot,
} from 'webrtc-rooms';

const server: SignalingServer = createServer({ port: 3000 });

server.on('peer:joined', (peer: Peer, room: Room) => {
  const name: string = peer.metadata.displayName as string;
  console.log(name, peer.state);
});
```

---

## Running tests

```bash
npm install
node tests/index.test.js
```

The suite boots real WebSocket servers on ephemeral ports and tears them down
at the end. No test runner, no mocking framework.

---

## Contributing

See [Contributing.md](./Contributing.md) for setup instructions, coding
standards, and the pull request process.

For security reports, see [SECURITY.md](./SECURITY.md).

For community standards, see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

For support channels and issue guidelines, see [SUPPORT.md](./SUPPORT.md).

---

## Roadmap

- Redis pub/sub adapter for multi-process / multi-server deployments
- Room persistence (restore rooms after server restart from a Redis snapshot)
- End-to-end encryption key-exchange helpers
- `webrtc-rooms-client` npm package — browser SDK with auto-reconnect and
  mediasoup-client integration
- Prometheus metrics endpoint (`/metrics`)

---

## License

[MIT](./LICENSE) © [Himanshu Pandey](https://github.com/himanshu-pandey-git)