'use strict';

/**
 * @file RoomPersistence.js
 * @description Persists room state to Redis so rooms (and their metadata) can
 * be restored automatically after a server restart.
 *
 * **What is persisted**
 *
 * - Room IDs and room-level metadata (`topic`, `name`, custom fields, etc.)
 * - The `maxPeers` limit per room
 * - A timestamp for when the room was originally created
 *
 * **What is NOT persisted**
 *
 * - Peer connections (WebSocket sessions cannot survive a process restart)
 * - Peer metadata (peers must re-join and re-send their metadata on reconnect)
 * - In-flight signaling messages
 *
 * This is intentional: the goal is to restore the *room structure* so that
 * returning peers rejoin the same rooms they were in before the restart,
 * without forcing them to reconfigure room settings.
 *
 * **Snapshotting strategy**
 *
 * The class uses an event-driven approach: every time a room is created or its
 * metadata changes, a snapshot is written to Redis immediately. Rooms are
 * removed from Redis when they are destroyed. Snapshots use a Redis Hash
 * (`webrtc-rooms:snapshot:<roomId>`) so individual fields can be updated
 * without rewriting the entire room object.
 *
 * On `restore()`, all snapshot keys are loaded and the corresponding rooms are
 * re-created on the server.
 *
 * @module webrtc-rooms/adapters/RoomPersistence
 *
 * @example
 * const { createServer, RoomPersistence } = require('webrtc-rooms');
 * const { createClient } = require('redis');
 *
 * const redis  = createClient({ url: 'redis://localhost:6379' });
 * await redis.connect();
 *
 * const server = createServer({ port: 3000, autoCreateRooms: false });
 *
 * const persistence = new RoomPersistence({ redis, server });
 * await persistence.restore();   // recreate rooms from the last snapshot
 * persistence.attach();          // start persisting future changes
 *
 * server.on('listening', () => console.log('Ready'));
 */

const { EventEmitter } = require('events');

/**
 * Redis key prefix for individual room snapshots.
 * Full key pattern: `webrtc-rooms:snapshot:<roomId>`
 * @constant {string}
 */
const SNAPSHOT_KEY_PREFIX = 'webrtc-rooms:snapshot:';

/**
 * Redis Set key that indexes all persisted room IDs.
 * Used by `restore()` to find all snapshots without a full key scan.
 * @constant {string}
 */
const SNAPSHOT_INDEX_KEY = 'webrtc-rooms:snapshot-index';

/**
 * Symbol used to tag rooms whose `setMetadata` has already been patched.
 * A Symbol prevents any possibility of colliding with user-defined properties
 * on the Room object, now or in the future.
 *
 * @private
 */
const PATCH_APPLIED = Symbol('webrtc-rooms:persistence:patched');

/**
 * Persists room state to Redis and restores it after a server restart.
 *
 * @extends EventEmitter
 *
 * @fires RoomPersistence#room:saved
 * @fires RoomPersistence#room:deleted
 * @fires RoomPersistence#restore:complete
 */
class RoomPersistence extends EventEmitter {
  /**
   * @param {object}  options
   * @param {object}  options.redis
   *   A connected Redis client (ioredis or node-redis v4+).
   *   This client is used for all read and write operations.
   * @param {import('../SignalingServer')} options.server
   *   The `SignalingServer` instance to persist.
   * @param {string}  [options.keyPrefix=SNAPSHOT_KEY_PREFIX]
   *   Override the Redis key prefix for room snapshots.
   * @param {string}  [options.indexKey=SNAPSHOT_INDEX_KEY]
   *   Override the Redis Set key used to index room IDs.
   * @param {number}  [options.snapshotTtl=0]
   *   Optional TTL in seconds for room snapshot keys. When non-zero, room
   *   snapshots expire automatically after this many seconds of inactivity.
   *   Set to `0` (the default) to keep snapshots indefinitely.
   */
  constructor({
    redis,
    server,
    keyPrefix   = SNAPSHOT_KEY_PREFIX,
    indexKey    = SNAPSHOT_INDEX_KEY,
    snapshotTtl = 0,
  }) {
    super();

    if (!redis)  throw new Error('[RoomPersistence] options.redis is required');
    if (!server) throw new Error('[RoomPersistence] options.server is required');

    this._redis       = redis;
    this._server      = server;
    this._keyPrefix   = keyPrefix;
    this._indexKey    = indexKey;
    this._snapshotTtl = snapshotTtl;

    /** @private @type {boolean} */
    this._attached = false;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Restores all rooms from Redis snapshots and creates them on the server.
   *
   * Rooms that already exist on the server (e.g. pre-created in config) are
   * skipped — the existing instance takes precedence.
   *
   * Call this **before** `server.on('listening', ...)` and before any peers
   * connect, but after the server is constructed.
   *
   * @returns {Promise<{ restored: string[], skipped: string[] }>}
   *   `restored` — room IDs that were recreated from snapshots.
   *   `skipped`  — room IDs whose snapshots were found but rooms already existed.
   *
   * @fires RoomPersistence#restore:complete
   *
   * @example
   * const { restored, skipped } = await persistence.restore();
   * console.log(`Restored ${restored.length} room(s)`, restored);
   */
  async restore() {
    const roomIds = await this._getSnapshotIndex();
    const restored = [];
    const skipped  = [];

    for (const roomId of roomIds) {
      const snapshot = await this._loadSnapshot(roomId);

      if (!snapshot) {
        // Snapshot key missing — clean up the stale index entry.
        await this._redis.sRem(this._indexKey, roomId);
        continue;
      }

      if (this._server.rooms.has(roomId)) {
        skipped.push(roomId);
        continue;
      }

      this._server.createRoom(roomId, {
        metadata: snapshot.metadata ?? {},
      });

      // Preserve the original createdAt timestamp on the Room object.
      const room = this._server.getRoom(roomId);
      if (room && snapshot.createdAt) {
        room.createdAt = snapshot.createdAt;
      }

      restored.push(roomId);
    }

    /**
     * @event RoomPersistence#restore:complete
     * @param {{ restored: string[], skipped: string[] }}
     */
    this.emit('restore:complete', { restored, skipped });

    console.log(
      `[RoomPersistence] Restore complete — ${restored.length} restored, ${skipped.length} skipped`,
    );

    return { restored, skipped };
  }

  /**
   * Starts listening to server events and persisting room changes.
   *
   * - `room:created`   → writes a snapshot to Redis
   * - `room:destroyed` → deletes the snapshot from Redis
   *
   * Room metadata changes (`room.setMetadata()`) are also persisted because
   * `setMetadata` broadcasts `room:updated`, which the adapter tracks by
   * patching each created room.
   *
   * @returns {this} Returns `this` for chaining.
   */
  attach() {
    if (this._attached) return this;
    this._attached = true;

    this._server.on('room:created', (room) => {
      this._persistRoom(room).catch((err) => {
        console.error(`[RoomPersistence] Failed to persist room "${room.id}":`, err.message);
      });
      // Patch setMetadata so every metadata change is saved immediately.
      this._patchRoomMetadata(room);
    });

    this._server.on('room:destroyed', (room) => {
      this._deleteSnapshot(room.id).catch((err) => {
        console.error(`[RoomPersistence] Failed to delete snapshot for "${room.id}":`, err.message);
      });
    });

    // Patch rooms that already exist (restored ones or pre-created rooms).
    for (const room of this._server.rooms.values()) {
      this._patchRoomMetadata(room);
    }

    return this;
  }

  /**
   * Saves a room snapshot to Redis immediately, outside the normal event flow.
   * Useful if you update room metadata programmatically and want to ensure
   * the snapshot is current.
   *
   * @param {string} roomId
   * @returns {Promise<void>}
   */
  async saveRoom(roomId) {
    const room = this._server.getRoom(roomId);
    if (!room) throw new Error(`[RoomPersistence] Room "${roomId}" not found`);
    await this._persistRoom(room);
  }

  /**
   * Deletes the snapshot for a room from Redis.
   * Does not affect the live room on the server.
   *
   * @param {string} roomId
   * @returns {Promise<void>}
   */
  async deleteSnapshot(roomId) {
    await this._deleteSnapshot(roomId);
  }

  /**
   * Returns all room snapshots currently stored in Redis.
   * Useful for debugging and admin tooling.
   *
   * @returns {Promise<Array<{ roomId: string, metadata: object, maxPeers: number, createdAt: number, savedAt: number }>>}
   */
  async listSnapshots() {
    const roomIds = await this._getSnapshotIndex();
    const snapshots = [];

    for (const roomId of roomIds) {
      const snapshot = await this._loadSnapshot(roomId);
      if (snapshot) snapshots.push({ roomId, ...snapshot });
    }

    return snapshots;
  }

  // ---------------------------------------------------------------------------
  // Internal persistence helpers
  // ---------------------------------------------------------------------------

  /**
   * Writes a room snapshot to Redis as a Hash.
   *
   * Fields written:
   * - `metadata` (JSON string)
   * - `maxPeers`
   * - `createdAt`
   * - `savedAt`
   *
   * @private
   * @param {import('../Room')} room
   */
  async _persistRoom(room) {
    const key = this._snapshotKey(room.id);

    const fields = {
      metadata:  JSON.stringify(room.metadata),
      maxPeers:  String(room.maxPeers),
      createdAt: String(room.createdAt),
      savedAt:   String(Date.now()),
    };

    // hSet accepts an object of field→value pairs in node-redis v4 and ioredis.
    await this._redis.hSet(key, fields);

    // Ensure the room is in the index.
    await this._redis.sAdd(this._indexKey, room.id);

    if (this._snapshotTtl > 0) {
      await this._redis.expire(key, this._snapshotTtl);
    }

    /**
     * @event RoomPersistence#room:saved
     * @param {{ roomId: string, key: string }}
     */
    this.emit('room:saved', { roomId: room.id, key });
  }

  /**
   * Loads a room snapshot from Redis and returns it as a plain object.
   *
   * @private
   * @param {string} roomId
   * @returns {Promise<{ metadata: object, maxPeers: number, createdAt: number, savedAt: number }|null>}
   */
  async _loadSnapshot(roomId) {
    const key  = this._snapshotKey(roomId);
    const hash = await this._redis.hGetAll(key);

    // hGetAll returns null (ioredis) or {} (node-redis) when the key is absent.
    if (!hash || Object.keys(hash).length === 0) return null;

    let metadata = {};
    try {
      metadata = JSON.parse(hash.metadata ?? '{}');
    } catch {
      // Corrupt metadata field — restore with empty object.
    }

    return {
      metadata,
      maxPeers:  parseInt(hash.maxPeers ?? '50', 10),
      createdAt: parseInt(hash.createdAt ?? '0', 10),
      savedAt:   parseInt(hash.savedAt   ?? '0', 10),
    };
  }

  /**
   * Deletes a room's snapshot hash and removes it from the index.
   *
   * @private
   * @param {string} roomId
   */
  async _deleteSnapshot(roomId) {
    const key = this._snapshotKey(roomId);
    await this._redis.del(key);
    await this._redis.sRem(this._indexKey, roomId);

    /**
     * @event RoomPersistence#room:deleted
     * @param {{ roomId: string }}
     */
    this.emit('room:deleted', { roomId });
  }

  /**
   * Retrieves the full list of room IDs from the snapshot index.
   *
   * @private
   * @returns {Promise<string[]>}
   */
  async _getSnapshotIndex() {
    const members = await this._redis.sMembers(this._indexKey);
    return members ?? [];
  }

  /**
   * Wraps a Room's `setMetadata` method so every metadata update is
   * automatically persisted to Redis.
   *
   * @private
   * @param {import('../Room')} room
   */
  _patchRoomMetadata(room) {
    if (room[PATCH_APPLIED]) return;
    room[PATCH_APPLIED] = true;

    const originalSetMetadata = room.setMetadata.bind(room);

    room.setMetadata = (patch) => {
      originalSetMetadata(patch);
      this._persistRoom(room).catch((err) => {
        console.error(
          `[RoomPersistence] Failed to persist metadata change for room "${room.id}":`,
          err.message,
        );
      });
    };
  }

  /**
   * @private
   * @param {string} roomId
   * @returns {string}
   */
  _snapshotKey(roomId) {
    return `${this._keyPrefix}${roomId}`;
  }
}

module.exports = RoomPersistence;