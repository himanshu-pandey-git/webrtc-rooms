'use strict';

/**
 * @file RedisAdapter.js
 * @description Redis pub/sub adapter enabling webrtc-rooms to run across
 * multiple Node.js processes or servers while sharing a unified room namespace.
 *
 * **Problem**
 *
 * A single `SignalingServer` process keeps all state in memory. When you run
 * multiple processes behind a load balancer (horizontal scaling, zero-downtime
 * deploys, multi-region) two peers connected to different processes cannot
 * exchange signaling messages because each process only knows about its own
 * local peers.
 *
 * **Solution**
 *
 * `RedisAdapter` bridges processes using Redis pub/sub. Every signaling message
 * that a room cannot route locally (because the target peer lives on a different
 * process) is published to a Redis channel. All processes subscribe to that
 * channel and deliver the message if they hold the target peer.
 *
 * ```
 * Process A                  Redis                   Process B
 *   │  offer → peer-B         │                         │
 *   │  (peer-B not local)     │                         │
 *   ├──── PUBLISH ───────────►│──── SUBSCRIBE ─────────►│
 *   │                         │   (peer-B is local)     │
 *   │                         │                         ├──► peer-B.send(offer)
 * ```
 *
 * **Topology**
 *
 * Each process subscribes to a single broadcast channel (`webrtc-rooms:bus`)
 * and publishes targeted messages to it. Messages include the target peer ID;
 * each subscriber delivers only the messages addressed to its own local peers.
 *
 * **Room awareness**
 *
 * The adapter also maintains a Redis Hash that maps `roomId → Set<peerId>` so
 * any process can determine which peers are in a room without querying every
 * other process. This hash is used by `getRoomPeers()` for cross-process
 * administration.
 *
 * @module webrtc-rooms/adapters/RedisAdapter
 *
 * @example
 * const { createServer, RedisAdapter } = require('webrtc-rooms');
 * const { createClient } = require('redis');
 *
 * const server = createServer({ port: 3000 });
 *
 * // Two separate ioredis / node-redis clients are required:
 * // one for subscribing (blocked in subscribe mode) and one for publishing.
 * const pub = createClient({ url: 'redis://localhost:6379' });
 * const sub = createClient({ url: 'redis://localhost:6379' });
 *
 * await pub.connect();
 * await sub.connect();
 *
 * const adapter = new RedisAdapter({ pub, sub, server });
 * await adapter.init();
 *
 * // The server now participates in the shared room namespace.
 * // Signaling messages for remote peers are routed automatically.
 */

const { EventEmitter } = require('events');

/**
 * Redis channel used for all cross-process signaling messages.
 * @constant {string}
 */
const BUS_CHANNEL = 'webrtc-rooms:bus';

/**
 * Redis key prefix for the room-membership hashes.
 * Full key pattern: `webrtc-rooms:room:<roomId>`
 * @constant {string}
 */
const ROOM_KEY_PREFIX = 'webrtc-rooms:room:';

/**
 * Redis key for the set of all active room IDs across the cluster.
 * @constant {string}
 */
const ROOMS_INDEX_KEY = 'webrtc-rooms:rooms';

/**
 * Process identifier stamped on every published message so a process does not
 * re-deliver its own publications to its own local peers.
 * @constant {string}
 */
const PROCESS_ID = `${process.pid}-${Date.now()}`;

/**
 * Bridges multiple `SignalingServer` processes via Redis pub/sub so they
 * behave as a single logical signaling cluster.
 *
 * @extends EventEmitter
 *
 * @fires RedisAdapter#message:published
 * @fires RedisAdapter#message:received
 * @fires RedisAdapter#error
 */
class RedisAdapter extends EventEmitter {
  /**
   * @param {object}  options
   * @param {object}  options.pub
   *   A connected Redis client used exclusively for publishing and key/hash
   *   operations. Compatible with `ioredis` and `node-redis` v4+.
   * @param {object}  options.sub
   *   A connected Redis client used exclusively for subscribing. Must be a
   *   separate client instance from `pub` because subscribing blocks the
   *   connection for general commands.
   * @param {import('../SignalingServer')} options.server
   *   The local `SignalingServer` instance this adapter attaches to.
   * @param {string}  [options.channel=BUS_CHANNEL]
   *   Override the Redis pub/sub channel name. Useful when running multiple
   *   independent clusters on the same Redis instance.
   * @param {string}  [options.keyPrefix=ROOM_KEY_PREFIX]
   *   Override the Redis key prefix for room membership hashes.
   * @param {number}  [options.peerTtl=300]
   *   Seconds before a peer's Redis entry expires. Prevents ghost entries if a
   *   process crashes without cleaning up. Set to `0` to disable expiry.
   */
  constructor({
    pub,
    sub,
    server,
    channel    = BUS_CHANNEL,
    keyPrefix  = ROOM_KEY_PREFIX,
    peerTtl    = 300,
  }) {
    super();

    if (!pub) throw new Error('[RedisAdapter] options.pub (Redis publish client) is required');
    if (!sub) throw new Error('[RedisAdapter] options.sub (Redis subscribe client) is required');
    if (!server) throw new Error('[RedisAdapter] options.server is required');

    this._pub      = pub;
    this._sub      = sub;
    this._server   = server;
    this._channel  = channel;
    this._keyPrefix = keyPrefix;
    this._peerTtl  = peerTtl;
    this._processId = PROCESS_ID;

    /** @private @type {boolean} */
    this._ready = false;
  }

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to the Redis bus channel and wires up all server-event hooks.
   *
   * Must be called (and awaited) after constructing the adapter and before
   * any peers connect.
   *
   * @returns {Promise<void>}
   */
  async init() {
    await this._subscribeToChannel();
    this._bindServerEvents();
    this._ready = true;
    console.log(`[RedisAdapter] Ready (process: ${this._processId}, channel: ${this._channel})`);
  }

  /**
   * Unsubscribes from Redis and removes all internal hooks.
   * Does not close the Redis clients — caller is responsible for that.
   *
   * @returns {Promise<void>}
   */
  async close() {
    try {
      await this._unsubscribeFromChannel();
    } catch {
      // Ignore unsubscribe errors during shutdown.
    }
    this._ready = false;
  }

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to the bus channel using whichever subscribe API the Redis
   * client exposes (`subscribe` for node-redis v4, `subscribe` for ioredis).
   *
   * @private
   */
  async _subscribeToChannel() {
    // node-redis v4 uses subscribe(channel, handler)
    // ioredis uses subscribe(channel) + on('message', handler)
    if (typeof this._sub.subscribe === 'function') {
      if (this._sub.constructor.name === 'Redis') {
        // ioredis
        await this._sub.subscribe(this._channel);
        this._sub.on('message', (_ch, raw) => this._onRedisMessage(raw));
      } else {
        // node-redis v4
        await this._sub.subscribe(this._channel, (raw) => this._onRedisMessage(raw));
      }
    } else {
      throw new Error(
        '[RedisAdapter] The `sub` client does not expose a `subscribe` method. ' +
        'Ensure you are using ioredis or node-redis v4+.',
      );
    }
  }

  /**
   * @private
   */
  async _unsubscribeFromChannel() {
    if (typeof this._sub.unsubscribe === 'function') {
      await this._sub.unsubscribe(this._channel);
    }
  }

  // ---------------------------------------------------------------------------
  // Server event hooks
  // ---------------------------------------------------------------------------

  /**
   * Hooks into the local `SignalingServer` to:
   * - Register/deregister peers in Redis on join/leave.
   * - Intercept the Room's `_routeTo` method to catch undeliverable messages
   *   and forward them to Redis.
   *
   * @private
   */
  _bindServerEvents() {
    this._server.on('peer:joined', (peer, room) => {
      this._registerPeer(peer, room.id).catch((err) => {
        console.error(`[RedisAdapter] Failed to register peer "${peer.id}":`, err.message);
      });
    });

    this._server.on('peer:left', (peer, room) => {
      // The `room` argument is always provided by SignalingServer._onPeerLeft.
      // We use it directly rather than reading peer.roomId, which may already
      // be null by the time this event fires.
      this._deregisterPeer(peer.id, room.id).catch((err) => {
        console.error(`[RedisAdapter] Failed to deregister peer "${peer.id}":`, err.message);
      });
    });

    // Patch every newly created Room to intercept unroutable messages.
    this._server.on('room:created', (room) => this._patchRoom(room));

    // Patch rooms that already exist (if init() is called after rooms were created).
    for (const room of this._server.rooms.values()) {
      this._patchRoom(room);
    }
  }

  /**
   * Patches a Room instance so that `_routeTo` publishes to Redis when the
   * target peer is not found locally.
   *
   * We wrap the original `_routeTo` method rather than monkey-patching the
   * Room class itself, so only rooms on this server instance are affected.
   * A guard flag prevents double-patching if `init()` is called after rooms
   * already exist and a `room:created` event also fires for the same room.
   *
   * @private
   * @param {import('../Room')} room
   */
  _patchRoom(room) {
    if (room.__redisRoutePatchApplied) return;
    room.__redisRoutePatchApplied = true;

    const originalRouteTo = room._routeTo.bind(room);

    room._routeTo = (targetId, msg) => {
      // Check if the target peer lives on this process.
      if (room.peers.has(targetId)) {
        return originalRouteTo(targetId, msg);
      }

      // Target is not local — publish to Redis for other processes to handle.
      this._publish({
        type:     'route',
        targetId,
        roomId:   room.id,
        msg,
      }).catch((err) => {
        console.error(`[RedisAdapter] Failed to publish route to "${targetId}":`, err.message);
      });
    };
  }

  // ---------------------------------------------------------------------------
  // Redis peer registry
  // ---------------------------------------------------------------------------

  /**
   * Registers a peer in the Redis room-membership hash and adds the room to
   * the global room index.
   *
   * @private
   * @param {import('../Peer')} peer
   * @param {string}            roomId
   */
  async _registerPeer(peer, roomId) {
    const roomKey = this._roomKey(roomId);
    const value   = JSON.stringify({ processId: this._processId, joinedAt: Date.now() });

    // HSET room-key peerId value
    await this._pub.hSet(roomKey, peer.id, value);

    // Add room to the global index.
    await this._pub.sAdd(ROOMS_INDEX_KEY, roomId);

    // Set expiry on the room hash if peerTtl is configured.
    if (this._peerTtl > 0) {
      await this._pub.expire(roomKey, this._peerTtl);
    }

    // Announce to the cluster that a new peer joined.
    await this._publish({
      type:    'peer:joined',
      roomId,
      peer:    peer.toJSON(),
    });
  }

  /**
   * Removes a peer from the Redis room-membership hash.
   *
   * @private
   * @param {string} peerId
   * @param {string} roomId
   */
  async _deregisterPeer(peerId, roomId) {
    const roomKey = this._roomKey(roomId);
    await this._pub.hDel(roomKey, peerId);

    // If the room hash is now empty, remove the room from the index.
    const remaining = await this._pub.hLen(roomKey);
    if (remaining === 0) {
      await this._pub.del(roomKey);
      await this._pub.sRem(ROOMS_INDEX_KEY, roomId);
    }

    await this._publish({ type: 'peer:left', roomId, peerId });
  }

  // ---------------------------------------------------------------------------
  // Publish / receive
  // ---------------------------------------------------------------------------

  /**
   * Publishes a message to the Redis bus channel.
   * Stamps the message with this process's ID so subscribers can ignore
   * their own publications.
   *
   * @private
   * @param {object} payload
   * @returns {Promise<void>}
   */
  async _publish(payload) {
    const envelope = JSON.stringify({ ...payload, _pid: this._processId });
    await this._pub.publish(this._channel, envelope);

    /**
     * @event RedisAdapter#message:published
     * @param {object} payload - The payload that was published.
     */
    this.emit('message:published', payload);
  }

  /**
   * Handles an incoming message from the Redis bus channel.
   *
   * @private
   * @param {string} raw - Raw JSON string received from Redis.
   */
  _onRedisMessage(raw) {
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      console.warn('[RedisAdapter] Received non-JSON message on Redis channel — ignoring.');
      return;
    }

    // Ignore messages published by this same process.
    if (envelope._pid === this._processId) return;

    /**
     * @event RedisAdapter#message:received
     * @param {object} envelope - The parsed message envelope.
     */
    this.emit('message:received', envelope);

    switch (envelope.type) {
      case 'route':
        this._handleRemoteRoute(envelope);
        break;

      case 'peer:joined':
      case 'peer:left':
        // These events are informational — they allow a process to maintain
        // an accurate cross-cluster view of room membership if needed.
        // The local server's own events handle local state; remote events
        // are emitted on the adapter for advanced consumers.
        this.emit(`remote:${envelope.type}`, envelope);
        break;

      default:
        // Unknown message types are ignored silently.
        break;
    }
  }

  /**
   * Delivers a `route` message to a local peer.
   * Called when this process receives a Redis message targeting one of its
   * own local peers.
   *
   * @private
   * @param {object} envelope
   * @param {string} envelope.targetId
   * @param {string} envelope.roomId
   * @param {object} envelope.msg
   */
  _handleRemoteRoute({ targetId, roomId, msg }) {
    const room = this._server.getRoom(roomId);
    if (!room) return;

    const target = room.peers.get(targetId);
    if (!target) return; // Peer is not on this process.

    target.send(msg);
  }

  // ---------------------------------------------------------------------------
  // Cross-cluster queries
  // ---------------------------------------------------------------------------

  /**
   * Returns all peer IDs currently registered in a room across the entire
   * cluster (all processes).
   *
   * Note: This is an eventually-consistent view based on the Redis hash.
   * Peers that crashed without deregistering will appear until their TTL
   * expires.
   *
   * @param {string} roomId
   * @returns {Promise<string[]>} Array of peer IDs.
   */
  async getRoomPeers(roomId) {
    const fields = await this._pub.hKeys(this._roomKey(roomId));
    return fields ?? [];
  }

  /**
   * Returns the IDs of all rooms that have at least one registered peer
   * anywhere in the cluster.
   *
   * @returns {Promise<string[]>}
   */
  async getActiveRooms() {
    const rooms = await this._pub.sMembers(ROOMS_INDEX_KEY);
    return rooms ?? [];
  }

  /**
   * Returns the full peer map for a room, including which process each peer
   * is connected to.
   *
   * @param {string} roomId
   * @returns {Promise<Array<{ peerId: string, processId: string, joinedAt: number }>>}
   */
  async getRoomPeerDetails(roomId) {
    const hash = await this._pub.hGetAll(this._roomKey(roomId));
    if (!hash) return [];
    return Object.entries(hash).map(([peerId, raw]) => {
      try {
        const { processId, joinedAt } = JSON.parse(raw);
        return { peerId, processId, joinedAt };
      } catch {
        return { peerId, processId: 'unknown', joinedAt: 0 };
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * @private
   * @param {string} roomId
   * @returns {string}
   */
  _roomKey(roomId) {
    return `${this._keyPrefix}${roomId}`;
  }
}

module.exports = RedisAdapter;