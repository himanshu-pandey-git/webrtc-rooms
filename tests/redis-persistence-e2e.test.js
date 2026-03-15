'use strict';

/**
 * @file tests/redis-persistence-e2e.test.js
 * @description Unit and integration tests for:
 *   - RedisAdapter  (pub/sub multi-process routing)
 *   - RoomPersistence (Redis-backed room snapshots)
 *   - E2EKeyExchange (end-to-end encryption key exchange)
 *
 * These tests use in-memory mocks for Redis clients and do not require a
 * live Redis instance. Integration tests that need a real Redis connection
 * are clearly marked and skipped automatically when `REDIS_URL` is not set.
 *
 * Run:
 *   node tests/redis-persistence-e2e.test.js
 *   REDIS_URL=redis://localhost:6379 node tests/redis-persistence-e2e.test.js
 */

const assert = require('assert');
const { EventEmitter } = require('events');

const { RedisAdapter, RoomPersistence, E2EKeyExchange, createServer, Room, Peer } = require('../src');

// Wrap the entire test suite in an async IIFE so top-level await works in CJS.
(async () => { // BEGIN ASYNC WRAPPER

// ---------------------------------------------------------------------------
// Minimal test harness (same pattern as the main test suite)
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

function skip(name) {
  process.stdout.write(`  \u25CB  ${name} (skipped — REDIS_URL not set)\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Mock Redis client
//
// Implements the subset of the node-redis v4 API used by RedisAdapter and
// RoomPersistence: publish, subscribe, hSet, hGet, hGetAll, hKeys, hLen, hDel,
// del, sAdd, sRem, sMembers, expire.
// ---------------------------------------------------------------------------

class MockRedis extends EventEmitter {
  constructor(name = 'redis') {
    super();
    this.name    = name;
    this._store  = new Map();   // key → { type: 'hash'|'set', data }
    this._subs   = new Map();   // channel → handler[]
    this.publishedMessages = [];
  }

  // --- Pub/Sub ---

  async subscribe(channel, handler) {
    if (!this._subs.has(channel)) this._subs.set(channel, []);
    if (handler) this._subs.get(channel).push(handler);
    this.emit('subscribed', channel);
  }

  async unsubscribe(channel) {
    this._subs.delete(channel);
  }

  async publish(channel, message) {
    this.publishedMessages.push({ channel, message });
    // Deliver to subscribed handlers on THIS instance (simulates round-trip).
    const handlers = this._subs.get(channel) ?? [];
    for (const h of handlers) h(message);
    return handlers.length;
  }

  // Simulate receiving a message from another process (for cross-process tests).
  simulateIncoming(channel, message) {
    const handlers = this._subs.get(channel) ?? [];
    for (const h of handlers) h(message);
  }

  // --- Hash operations ---

  async hSet(key, fieldOrObject, value) {
    if (!this._store.has(key)) this._store.set(key, { type: 'hash', data: new Map() });
    const hash = this._store.get(key).data;
    if (typeof fieldOrObject === 'object') {
      for (const [f, v] of Object.entries(fieldOrObject)) hash.set(f, String(v));
    } else {
      hash.set(fieldOrObject, String(value));
    }
    return 1;
  }

  async hGet(key, field) {
    return this._store.get(key)?.data?.get(field) ?? null;
  }

  async hGetAll(key) {
    const entry = this._store.get(key);
    if (!entry || entry.type !== 'hash') return {};
    return Object.fromEntries(entry.data);
  }

  async hKeys(key) {
    return [...(this._store.get(key)?.data?.keys() ?? [])];
  }

  async hLen(key) {
    return this._store.get(key)?.data?.size ?? 0;
  }

  async hDel(key, field) {
    this._store.get(key)?.data?.delete(field);
    return 1;
  }

  async del(key) {
    this._store.delete(key);
    return 1;
  }

  // --- Set operations ---

  async sAdd(key, member) {
    if (!this._store.has(key)) this._store.set(key, { type: 'set', data: new Set() });
    this._store.get(key).data.add(member);
    return 1;
  }

  async sRem(key, member) {
    this._store.get(key)?.data?.delete(member);
    return 1;
  }

  async sMembers(key) {
    return [...(this._store.get(key)?.data ?? [])];
  }

  // --- TTL (no-op in mock) ---

  async expire() { return 1; }
}

// ---------------------------------------------------------------------------
// Mock peer factory (reused from main tests)
// ---------------------------------------------------------------------------

function makeMockPeer(id) {
  const sent = [];
  const ee   = new EventEmitter();
  return Object.assign(ee, {
    id,
    roomId:         null,
    state:          'joining',
    metadata:       {},
    reconnectToken: null,
    _sendQueue:     [],
    sent,
    send(msg)       { sent.push(msg); },
    close(code, reason) { this._closed = { code, reason }; },
    setMetadata(p)  {
      Object.assign(this.metadata, p);
      for (const [k, v] of Object.entries(this.metadata)) {
        if (v === null) delete this.metadata[k];
      }
      return this.metadata;
    },
    toJSON() {
      return { id: this.id, roomId: this.roomId, state: this.state, metadata: this.metadata };
    },
  });
}

// ---------------------------------------------------------------------------
// RedisAdapter tests
// ---------------------------------------------------------------------------

console.log('\nRedisAdapter');

await test('throws if pub client is missing', async () => {
  assert.throws(
    () => new RedisAdapter({ sub: new MockRedis(), server: {} }),
    /pub.*required/i,
  );
});

await test('throws if sub client is missing', async () => {
  assert.throws(
    () => new RedisAdapter({ pub: new MockRedis(), server: {} }),
    /sub.*required/i,
  );
});

await test('throws if server is missing', async () => {
  assert.throws(
    () => new RedisAdapter({ pub: new MockRedis(), sub: new MockRedis() }),
    /server.*required/i,
  );
});

await test('init() subscribes to the bus channel', async () => {
  const pub    = new MockRedis('pub');
  const sub    = new MockRedis('sub');
  const server = createServer({ port: 0 });

  // Make the server not actually listen (port 0 still opens a real socket).
  // We need a minimal server-like object for constructor tests.
  const mockServer = {
    on:    () => {},
    rooms: new Map(),
    peers: new Map(),
    getRoom: () => undefined,
  };

  const adapter = new RedisAdapter({ pub, sub, server: mockServer });
  await adapter.init();

  assert.ok(sub._subs.has('webrtc-rooms:bus'), 'should have subscribed to the bus channel');
  await adapter.close();
});

await test('_publish stamps processId on every message', async () => {
  const pub = new MockRedis('pub');
  const sub = new MockRedis('sub');
  const mockServer = { on: () => {}, rooms: new Map(), peers: new Map(), getRoom: () => undefined };

  const adapter = new RedisAdapter({ pub, sub, server: mockServer });
  await adapter.init();
  await adapter._publish({ type: 'test', data: 'hello' });

  assert.strictEqual(pub.publishedMessages.length, 1);
  const envelope = JSON.parse(pub.publishedMessages[0].message);
  assert.strictEqual(envelope.type, 'test');
  assert.strictEqual(typeof envelope._pid, 'string');
  assert.ok(envelope._pid.length > 0);
  await adapter.close();
});

await test('_onRedisMessage ignores messages from own process', async () => {
  const pub = new MockRedis('pub');
  const sub = new MockRedis('sub');
  const mockServer = { on: () => {}, rooms: new Map(), peers: new Map(), getRoom: () => undefined };

  const adapter = new RedisAdapter({ pub, sub, server: mockServer });
  await adapter.init();

  let received = false;
  adapter.on('message:received', () => { received = true; });

  // Simulate a message that came from this same process.
  const selfMessage = JSON.stringify({ type: 'route', _pid: adapter._processId });
  sub.simulateIncoming('webrtc-rooms:bus', selfMessage);

  assert.strictEqual(received, false, 'should not emit message:received for own messages');
  await adapter.close();
});

await test('_onRedisMessage emits message:received for foreign messages', async () => {
  const pub = new MockRedis('pub');
  const sub = new MockRedis('sub');
  const mockServer = { on: () => {}, rooms: new Map(), peers: new Map(), getRoom: () => undefined };

  const adapter = new RedisAdapter({ pub, sub, server: mockServer });
  await adapter.init();

  let receivedEnvelope = null;
  adapter.on('message:received', (env) => { receivedEnvelope = env; });

  const foreignMessage = JSON.stringify({ type: 'route', targetId: 'p1', roomId: 'r1', msg: { type: 'offer' }, _pid: 'other-process' });
  sub.simulateIncoming('webrtc-rooms:bus', foreignMessage);

  assert.ok(receivedEnvelope, 'should have emitted message:received');
  assert.strictEqual(receivedEnvelope.type, 'route');
  await adapter.close();
});

await test('_handleRemoteRoute delivers message to a local peer', async () => {
  const pub  = new MockRedis('pub');
  const sub  = new MockRedis('sub');
  const room = new Room({ id: 'test-room' });
  const peer = makeMockPeer('local-peer');
  room.addPeer(peer);

  const mockServer = {
    on:      () => {},
    rooms:   new Map([['test-room', room]]),
    peers:   new Map([['local-peer', peer]]),
    getRoom: (id) => id === 'test-room' ? room : undefined,
  };

  const adapter = new RedisAdapter({ pub, sub, server: mockServer });
  await adapter.init();

  const msg = { type: 'offer', sdp: { type: 'offer' } };
  adapter._handleRemoteRoute({ targetId: 'local-peer', roomId: 'test-room', msg });

  const delivered = peer.sent.find((m) => m.type === 'offer');
  assert.ok(delivered, 'message should have been delivered to local peer');
  await adapter.close();
});

await test('getRoomPeers returns peer IDs from Redis hash', async () => {
  const pub = new MockRedis('pub');
  const sub = new MockRedis('sub');
  const mockServer = { on: () => {}, rooms: new Map(), peers: new Map(), getRoom: () => undefined };

  const adapter = new RedisAdapter({ pub, sub, server: mockServer });
  await adapter.init();

  // Manually insert entries into the mock Redis.
  await pub.hSet('webrtc-rooms:room:r1', 'peer-a', JSON.stringify({ processId: 'p1', joinedAt: 1 }));
  await pub.hSet('webrtc-rooms:room:r1', 'peer-b', JSON.stringify({ processId: 'p2', joinedAt: 2 }));

  const peers = await adapter.getRoomPeers('r1');
  assert.strictEqual(peers.length, 2);
  assert.ok(peers.includes('peer-a'));
  assert.ok(peers.includes('peer-b'));
  await adapter.close();
});

await test('getActiveRooms returns room IDs from Redis set', async () => {
  const pub = new MockRedis('pub');
  const sub = new MockRedis('sub');
  const mockServer = { on: () => {}, rooms: new Map(), peers: new Map(), getRoom: () => undefined };

  const adapter = new RedisAdapter({ pub, sub, server: mockServer });
  await adapter.init();

  await pub.sAdd('webrtc-rooms:rooms', 'room-alpha');
  await pub.sAdd('webrtc-rooms:rooms', 'room-beta');

  const rooms = await adapter.getActiveRooms();
  assert.ok(rooms.includes('room-alpha'));
  assert.ok(rooms.includes('room-beta'));
  await adapter.close();
});

// ---------------------------------------------------------------------------
// RoomPersistence tests
// ---------------------------------------------------------------------------

console.log('\nRoomPersistence');

await test('throws if redis is missing', async () => {
  assert.throws(() => new RoomPersistence({ server: {} }), /redis.*required/i);
});

await test('throws if server is missing', async () => {
  assert.throws(() => new RoomPersistence({ redis: new MockRedis() }), /server.*required/i);
});

await test('restore() returns empty arrays when no snapshots exist', async () => {
  const redis  = new MockRedis();
  const mockServer = {
    on:         () => {},
    rooms:      new Map(),
    peers:      new Map(),
    getRoom:    () => undefined,
    createRoom: () => {},
  };

  const p = new RoomPersistence({ redis, server: mockServer });
  const { restored, skipped } = await p.restore();

  assert.strictEqual(restored.length, 0);
  assert.strictEqual(skipped.length, 0);
});

await test('restore() recreates rooms from Redis snapshots', async () => {
  const redis = new MockRedis();
  const createdRooms = [];

  const mockServer = {
    on:         () => {},
    rooms:      new Map(),
    getRoom:    () => undefined,
    createRoom: (id, opts) => {
      createdRooms.push({ id, opts });
      const room = new Room({ id, metadata: opts?.metadata ?? {} });
      mockServer.rooms.set(id, room);
      return room;
    },
  };

  // Simulate existing snapshots in Redis.
  await redis.hSet('webrtc-rooms:snapshot:room-1', { metadata: JSON.stringify({ topic: 'Standup' }), maxPeers: '10', createdAt: '1000000', savedAt: '1000001' });
  await redis.hSet('webrtc-rooms:snapshot:room-2', { metadata: JSON.stringify({ topic: 'Design' }),  maxPeers: '5',  createdAt: '2000000', savedAt: '2000001' });
  await redis.sAdd('webrtc-rooms:snapshot-index', 'room-1');
  await redis.sAdd('webrtc-rooms:snapshot-index', 'room-2');

  const p = new RoomPersistence({ redis, server: mockServer });
  const { restored, skipped } = await p.restore();

  assert.strictEqual(restored.length, 2, 'should restore 2 rooms');
  assert.ok(restored.includes('room-1'));
  assert.ok(restored.includes('room-2'));
  assert.strictEqual(skipped.length, 0);

  assert.strictEqual(createdRooms[0].opts.metadata.topic, 'Standup');
  assert.strictEqual(createdRooms[1].opts.metadata.topic, 'Design');
});

await test('restore() skips rooms that already exist on the server', async () => {
  const redis = new MockRedis();
  const existingRoom = new Room({ id: 'existing' });
  let createCalled = false;

  const mockServer = {
    on:         () => {},
    rooms:      new Map([['existing', existingRoom]]),
    getRoom:    (id) => mockServer.rooms.get(id),
    createRoom: () => { createCalled = true; },
  };

  await redis.hSet('webrtc-rooms:snapshot:existing', { metadata: '{}', maxPeers: '50', createdAt: '1', savedAt: '2' });
  await redis.sAdd('webrtc-rooms:snapshot-index', 'existing');

  const p = new RoomPersistence({ redis, server: mockServer });
  const { restored, skipped } = await p.restore();

  assert.strictEqual(createCalled, false, 'createRoom should not be called for existing rooms');
  assert.strictEqual(skipped.length, 1);
  assert.ok(skipped.includes('existing'));
  assert.strictEqual(restored.length, 0);
});

await test('attach() persists a room when it is created', async () => {
  const redis = new MockRedis();
  const serverEvents = new EventEmitter();
  const room = new Room({ id: 'new-room', metadata: { topic: 'Test' } });

  const mockServer = {
    on:   (event, cb) => serverEvents.on(event, cb),
    rooms: new Map(),
    getRoom: () => room,
  };

  const p = new RoomPersistence({ redis, server: mockServer });
  p.attach();

  // Simulate room:created event.
  serverEvents.emit('room:created', room);
  await sleep(50); // allow async persist to complete

  const snapshot = await redis.hGetAll('webrtc-rooms:snapshot:new-room');
  assert.ok(Object.keys(snapshot).length > 0, 'snapshot should have been written');
  assert.strictEqual(JSON.parse(snapshot.metadata).topic, 'Test');
});

await test('attach() deletes snapshot when room is destroyed', async () => {
  const redis = new MockRedis();
  const serverEvents = new EventEmitter();
  const room = new Room({ id: 'dying-room' });

  // Pre-populate snapshot.
  await redis.hSet('webrtc-rooms:snapshot:dying-room', { metadata: '{}', maxPeers: '50', createdAt: '1', savedAt: '2' });
  await redis.sAdd('webrtc-rooms:snapshot-index', 'dying-room');

  const mockServer = {
    on:    (event, cb) => serverEvents.on(event, cb),
    rooms: new Map(),
    getRoom: () => room,
  };

  const p = new RoomPersistence({ redis, server: mockServer });
  p.attach();

  serverEvents.emit('room:destroyed', room);
  await sleep(50);

  const snapshot = await redis.hGetAll('webrtc-rooms:snapshot:dying-room');
  assert.strictEqual(Object.keys(snapshot).length, 0, 'snapshot should have been deleted');
});

await test('listSnapshots() returns all snapshots from Redis', async () => {
  const redis = new MockRedis();
  await redis.hSet('webrtc-rooms:snapshot:r1', { metadata: JSON.stringify({ x: 1 }), maxPeers: '50', createdAt: '100', savedAt: '200' });
  await redis.hSet('webrtc-rooms:snapshot:r2', { metadata: JSON.stringify({ x: 2 }), maxPeers: '10', createdAt: '300', savedAt: '400' });
  await redis.sAdd('webrtc-rooms:snapshot-index', 'r1');
  await redis.sAdd('webrtc-rooms:snapshot-index', 'r2');

  const p = new RoomPersistence({ redis, server: { on: () => {}, rooms: new Map() } });
  const snapshots = await p.listSnapshots();

  assert.strictEqual(snapshots.length, 2);
  assert.ok(snapshots.some((s) => s.roomId === 'r1' && s.metadata.x === 1));
  assert.ok(snapshots.some((s) => s.roomId === 'r2' && s.metadata.x === 2));
});

// ---------------------------------------------------------------------------
// E2EKeyExchange tests
// ---------------------------------------------------------------------------

console.log('\nE2EKeyExchange');

// A valid Base64-encoded P-256 public key (SPKI format, truncated for test).
const VALID_KEY_P256 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEValidKeyBase64PaddedToCorrectLength==';
const VALID_KEY_X25519 = 'MCowBQYDK2VuAyEAX25519ValidKeyBase64Padded=';

await test('throws if server is missing', async () => {
  assert.throws(() => new E2EKeyExchange({}), /server.*required/i);
});

await test('attach() returns this for chaining', async () => {
  const mockServer = {
    on:    () => {},
    rooms: new Map(),
  };
  const e2e = new E2EKeyExchange({ server: mockServer });
  const result = e2e.attach();
  assert.strictEqual(result, e2e);
});

await test('getPeerKey returns undefined for unknown peer', async () => {
  const mockServer = { on: () => {}, rooms: new Map() };
  const e2e = new E2EKeyExchange({ server: mockServer });
  assert.strictEqual(e2e.getPeerKey('room-x', 'peer-x'), undefined);
});

await test('getRoomKeys returns empty array for unknown room', async () => {
  const mockServer = { on: () => {}, rooms: new Map() };
  const e2e = new E2EKeyExchange({ server: mockServer });
  assert.deepStrictEqual(e2e.getRoomKeys('no-room'), []);
});

await test('_validateKeyPayload rejects missing publicKey', async () => {
  const mockServer = { on: () => {}, rooms: new Map() };
  const e2e = new E2EKeyExchange({ server: mockServer });
  const result = e2e._validateKeyPayload({});
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('publicKey'));
});

await test('_validateKeyPayload rejects keys that exceed MAX_PUBLIC_KEY_LENGTH', async () => {
  const mockServer = { on: () => {}, rooms: new Map() };
  const e2e = new E2EKeyExchange({ server: mockServer });
  const longKey = 'A'.repeat(600);
  const result = e2e._validateKeyPayload({ publicKey: longKey });
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('maximum length'));
});

await test('_validateKeyPayload rejects non-Base64 publicKey', async () => {
  const mockServer = { on: () => {}, rooms: new Map() };
  const e2e = new E2EKeyExchange({ server: mockServer });
  const result = e2e._validateKeyPayload({ publicKey: 'this is not base64!!!' });
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('Base64'));
});

await test('_validateKeyPayload rejects unsupported curve', async () => {
  const mockServer = { on: () => {}, rooms: new Map() };
  const e2e = new E2EKeyExchange({ server: mockServer });
  const result = e2e._validateKeyPayload({ publicKey: 'validBase64Key==', curve: 'secp521r1' });
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('secp521r1'));
});

await test('_validateKeyPayload accepts valid P-256 key', async () => {
  const mockServer = { on: () => {}, rooms: new Map() };
  const e2e = new E2EKeyExchange({ server: mockServer });
  const result = e2e._validateKeyPayload({ publicKey: 'validBase64Key==', curve: 'P-256' });
  assert.strictEqual(result.valid, true);
});

await test('key:announce stores key and broadcasts to room', async () => {
  const room  = new Room({ id: 'e2e-room' });
  const peerA = makeMockPeer('peer-a');
  const peerB = makeMockPeer('peer-b');
  room.addPeer(peerA);
  room.addPeer(peerB);

  const serverEvents = new EventEmitter();
  const mockServer = {
    on:      (ev, cb) => serverEvents.on(ev, cb),
    rooms:   new Map([['e2e-room', room]]),
    getRoom: (id) => id === 'e2e-room' ? room : undefined,
    kick:    () => {},
  };

  const e2e = new E2EKeyExchange({ server: mockServer });
  e2e.attach();
  serverEvents.emit('room:created', room);
  serverEvents.emit('peer:joined', peerA, room);
  serverEvents.emit('peer:joined', peerB, room);

  let announced = null;
  e2e.on('key:announced', (info) => { announced = info; });

  // Simulate peerA sending a key:announce through the data relay.
  room.emit('data', peerA, null, { __e2e: 'key:announce', publicKey: 'validBase64Key==', curve: 'P-256' });
  await sleep(20);

  // peerA should receive a confirmation.
  const confirm = peerA.sent.find((m) => m.type === 'e2e:key:confirmed');
  assert.ok(confirm, 'confirming peer should receive e2e:key:confirmed');
  assert.strictEqual(confirm.action, 'announced');
  assert.strictEqual(confirm.version, 1);

  // peerB should receive the announcement.
  const broadcast = peerB.sent.find((m) => m.type === 'e2e:key:announced');
  assert.ok(broadcast, 'other peers should receive e2e:key:announced');
  assert.strictEqual(broadcast.peerId, 'peer-a');

  // Adapter event.
  assert.ok(announced, 'key:announced event should have been emitted');
  assert.strictEqual(announced.peerId, 'peer-a');

  // Key should be stored.
  const entry = e2e.getPeerKey('e2e-room', 'peer-a');
  assert.ok(entry, 'key should be stored');
  assert.strictEqual(entry.curve, 'P-256');
  assert.strictEqual(entry.version, 1);
});

await test('key:announce rejects duplicate announcement', async () => {
  const room  = new Room({ id: 'dup-room' });
  const peer  = makeMockPeer('peer-dup');
  room.addPeer(peer);

  const serverEvents = new EventEmitter();
  const mockServer = {
    on:      (ev, cb) => serverEvents.on(ev, cb),
    rooms:   new Map([['dup-room', room]]),
    getRoom: (id) => id === 'dup-room' ? room : undefined,
    kick:    () => {},
  };

  const e2e = new E2EKeyExchange({ server: mockServer });
  e2e.attach();
  serverEvents.emit('room:created', room);
  serverEvents.emit('peer:joined', peer, room);

  room.emit('data', peer, null, { __e2e: 'key:announce', publicKey: 'firstKey==', curve: 'P-256' });
  await sleep(10);
  const beforeCount = peer.sent.length;
  room.emit('data', peer, null, { __e2e: 'key:announce', publicKey: 'secondKey==', curve: 'P-256' });
  await sleep(10);

  const errors = peer.sent.slice(beforeCount).filter((m) => m.type === 'error');
  assert.ok(errors.some((e) => e.code === 'E2E_KEY_ALREADY_ANNOUNCED'));
});

await test('key:rotate replaces key and increments version', async () => {
  const room  = new Room({ id: 'rotate-room' });
  const peer  = makeMockPeer('peer-rotate');
  const other = makeMockPeer('peer-other');
  room.addPeer(peer);
  room.addPeer(other);

  const serverEvents = new EventEmitter();
  const mockServer = {
    on:      (ev, cb) => serverEvents.on(ev, cb),
    rooms:   new Map([['rotate-room', room]]),
    getRoom: (id) => id === 'rotate-room' ? room : undefined,
    kick:    () => {},
  };

  const e2e = new E2EKeyExchange({ server: mockServer });
  e2e.attach();
  serverEvents.emit('room:created', room);
  serverEvents.emit('peer:joined', peer, room);
  serverEvents.emit('peer:joined', other, room);

  // Announce first key.
  room.emit('data', peer, null, { __e2e: 'key:announce', publicKey: 'firstKey==', curve: 'P-256' });
  await sleep(10);

  const announcedVersion = e2e.getPeerKey('rotate-room', 'peer-rotate').version;
  assert.strictEqual(announcedVersion, 1, 'announced version should be 1');

  let rotated = null;
  e2e.on('key:rotated', (info) => { rotated = info; });

  // Rotate to a new key.
  room.emit('data', peer, null, { __e2e: 'key:rotate', publicKey: 'newKey===', curve: 'P-256' });
  await sleep(10);

  const confirm = peer.sent.find((m) => m.type === 'e2e:key:confirmed' && m.action === 'rotated');
  assert.ok(confirm, 'rotating peer should receive rotated confirmation');
  assert.strictEqual(confirm.version, 2);

  const rotateMsg = other.sent.find((m) => m.type === 'e2e:key:rotated');
  assert.ok(rotateMsg, 'other peers should receive rotation announcement');
  assert.strictEqual(rotateMsg.version, 2);

  // The stored entry should now be version 2 with the new key.
  const storedKey = e2e.getPeerKey('rotate-room', 'peer-rotate');
  assert.strictEqual(storedKey.version, 2);
  assert.strictEqual(storedKey.publicKey, 'newKey===');

  assert.ok(rotated, 'key:rotated event should have fired');
  assert.strictEqual(rotated.version, 2);
});

await test('key:revoked is broadcast and key is removed when peer leaves', async () => {
  const room  = new Room({ id: 'revoke-room' });
  const peerA = makeMockPeer('peer-revoke-a');
  const peerB = makeMockPeer('peer-revoke-b');
  room.addPeer(peerA);
  room.addPeer(peerB);

  const serverEvents = new EventEmitter();
  const mockServer = {
    on:      (ev, cb) => serverEvents.on(ev, cb),
    rooms:   new Map([['revoke-room', room]]),
    getRoom: (id) => id === 'revoke-room' ? room : undefined,
    kick:    () => {},
  };

  const e2e = new E2EKeyExchange({ server: mockServer });
  e2e.attach();
  serverEvents.emit('room:created', room);
  serverEvents.emit('peer:joined', peerA, room);
  serverEvents.emit('peer:joined', peerB, room);

  room.emit('data', peerA, null, { __e2e: 'key:announce', publicKey: 'keyToRevoke==', curve: 'P-256' });
  await sleep(10);

  let revoked = null;
  e2e.on('key:revoked', (info) => { revoked = info; });

  serverEvents.emit('peer:left', peerA, room);
  await sleep(10);

  assert.ok(revoked, 'key:revoked event should have fired');
  assert.strictEqual(revoked.peerId, 'peer-revoke-a');

  const revokeMsg = peerB.sent.find((m) => m.type === 'e2e:key:revoked');
  assert.ok(revokeMsg, 'remaining peer should receive e2e:key:revoked');

  assert.strictEqual(e2e.getPeerKey('revoke-room', 'peer-revoke-a'), undefined, 'key should be removed from store');
});

await test('key:request returns stored key to requesting peer', async () => {
  const room  = new Room({ id: 'request-room' });
  const peerA = makeMockPeer('peer-req-a');
  const peerB = makeMockPeer('peer-req-b');
  room.addPeer(peerA);
  room.addPeer(peerB);

  const serverEvents = new EventEmitter();
  const mockServer = {
    on:      (ev, cb) => serverEvents.on(ev, cb),
    rooms:   new Map([['request-room', room]]),
    getRoom: (id) => id === 'request-room' ? room : undefined,
    kick:    () => {},
  };

  const e2e = new E2EKeyExchange({ server: mockServer });
  e2e.attach();
  serverEvents.emit('room:created', room);
  serverEvents.emit('peer:joined', peerA, room);
  serverEvents.emit('peer:joined', peerB, room);

  room.emit('data', peerA, null, { __e2e: 'key:announce', publicKey: 'requestableKey==', curve: 'P-256' });
  await sleep(10);

  room.emit('data', peerB, null, { __e2e: 'key:request', targetPeerId: 'peer-req-a' });
  await sleep(10);

  const response = peerB.sent.find((m) => m.type === 'e2e:key:response');
  assert.ok(response, 'requesting peer should receive key response');
  assert.strictEqual(response.targetPeerId, 'peer-req-a');
  assert.strictEqual(response.publicKey, 'requestableKey==');
});

await test('key:request returns not-found when target has no key', async () => {
  const room = new Room({ id: 'nf-room' });
  const peer = makeMockPeer('requester');
  room.addPeer(peer);

  const serverEvents = new EventEmitter();
  const mockServer = {
    on:      (ev, cb) => serverEvents.on(ev, cb),
    rooms:   new Map([['nf-room', room]]),
    getRoom: () => room,
    kick:    () => {},
  };

  const e2e = new E2EKeyExchange({ server: mockServer });
  e2e.attach();
  serverEvents.emit('room:created', room);
  serverEvents.emit('peer:joined', peer, room);

  room.emit('data', peer, null, { __e2e: 'key:request', targetPeerId: 'ghost-peer' });
  await sleep(10);

  const notFound = peer.sent.find((m) => m.type === 'e2e:key:not-found');
  assert.ok(notFound, 'should receive not-found response');
  assert.strictEqual(notFound.targetPeerId, 'ghost-peer');
});

await test('snapshot is sent to late-joining peer', async () => {
  const room  = new Room({ id: 'snapshot-room' });
  const peerA = makeMockPeer('peer-snap-a');
  room.addPeer(peerA);

  const serverEvents = new EventEmitter();
  const mockServer = {
    on:      (ev, cb) => serverEvents.on(ev, cb),
    rooms:   new Map([['snapshot-room', room]]),
    getRoom: () => room,
    kick:    () => {},
  };

  const e2e = new E2EKeyExchange({ server: mockServer });
  e2e.attach();
  serverEvents.emit('room:created', room);
  serverEvents.emit('peer:joined', peerA, room);

  // peerA announces its key.
  room.emit('data', peerA, null, { __e2e: 'key:announce', publicKey: 'existingKey==', curve: 'P-256' });
  await sleep(10);

  // Now peerB joins later.
  const peerB = makeMockPeer('peer-snap-b');
  room.addPeer(peerB);
  serverEvents.emit('peer:joined', peerB, room);

  const snapshot = peerB.sent.find((m) => m.type === 'e2e:key:snapshot');
  assert.ok(snapshot, 'late-joining peer should receive key snapshot');
  assert.ok(Array.isArray(snapshot.keys));
  assert.ok(snapshot.keys.some((k) => k.peerId === 'peer-snap-a'));
});

await test('stats() returns per-room key counts', async () => {
  const room = new Room({ id: 'stats-room' });
  const peer = makeMockPeer('stats-peer');
  room.addPeer(peer);

  const serverEvents = new EventEmitter();
  const mockServer = {
    on:      (ev, cb) => serverEvents.on(ev, cb),
    rooms:   new Map([['stats-room', room]]),
    getRoom: () => room,
    kick:    () => {},
  };

  const e2e = new E2EKeyExchange({ server: mockServer });
  e2e.attach();
  serverEvents.emit('room:created', room);
  serverEvents.emit('peer:joined', peer, room);
  room.emit('data', peer, null, { __e2e: 'key:announce', publicKey: 'statsKey===', curve: 'P-256' });
  await sleep(10);

  const stats = e2e.stats();
  const roomStat = stats.find((s) => s.roomId === 'stats-room');
  assert.ok(roomStat, 'stats should include the room');
  assert.strictEqual(roomStat.peerCount, 1);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = passed + failed;
console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${passed} passed  \u2022  ${failed} failed  \u2022  ${total} total`);

if (failures.length > 0) {
  console.log('\nFailed tests:');
  failures.forEach((f) => console.log(`  \u2717 ${f.name}\n    ${f.message}`));
  process.exit(1);
} else {
  console.log('\n  All tests passed \u2713\n');
  process.exit(0);
}

})(); // END ASYNC WRAPPER