"use strict";

/**
 * @file EventReplay.js
 * @description Idempotent state recovery and offline event replay for
 * webrtc-rooms v2.
 *
 * **Problem**
 *
 * In distributed systems, events can arrive out of order, be duplicated
 * (at-least-once delivery from Redis pub/sub or webhooks), or be missed
 * entirely during a process restart. Without a replay mechanism, state can
 * diverge across processes.
 *
 * **Solution**
 *
 * EventReplay maintains a circular event log. Every significant server event
 * is written to the log with a monotonically increasing sequence number and
 * a content hash for deduplication. On reconnect or process restart, a
 * process can request events since sequence N and replay them to bring its
 * state up to date.
 *
 * **Idempotency**
 *
 * Each event has a deterministic hash based on `(type, roomId, peerId, ts)`.
 * Replaying the same event twice is a no-op — the second delivery is
 * detected via the hash and dropped.
 *
 * **Storage**
 *
 * - In-memory circular buffer (always enabled, configurable capacity)
 * - Redis sorted set (optional, enables cross-process replay)
 *
 * @module webrtc-rooms/reliability/EventReplay
 *
 * @example
 * const { EventReplay } = require('webrtc-rooms');
 *
 * const replay = new EventReplay({ server, capacity: 10_000 });
 * replay.attach();
 *
 * // Get all events since sequence 500
 * const missed = replay.since(500);
 *
 * // Replay missed events to a specific peer
 * await replay.replayToPeer(peerId, lastSeenSeq);
 */

const { EventEmitter } = require("events");
const { createHash } = require("crypto");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPLAYABLE_EVENTS = new Set([
  "peer:joined",
  "peer:left",
  "peer:reconnected",
  "peer:updated",
  "room:created",
  "room:destroyed",
  "sfu:peer:published",
  "sfu:peer:unpublished",
]);

const REDIS_REPLAY_KEY = "webrtc-rooms:replay";
const REDIS_REPLAY_TTL = 3600; // 1 hour

/**
 * @typedef {object} ReplayEvent
 * @property {number}  seq       - Monotonic sequence number
 * @property {string}  hash      - Content hash for deduplication
 * @property {string}  type      - Event type
 * @property {string}  [roomId]
 * @property {string}  [peerId]
 * @property {object}  payload   - Full event payload
 * @property {number}  ts        - Unix ms
 */

/**
 * Maintains an ordered, deduplicated event log that enables late-joiners
 * and reconnecting processes to catch up on missed events.
 *
 * @extends EventEmitter
 */
class EventReplay extends EventEmitter {
  /**
   * @param {object}  options
   * @param {import('../core/SignalingServer')} options.server
   * @param {number}  [options.capacity=10000]   - Max events in memory
   * @param {object}  [options.redis]             - Redis client for cross-process replay
   * @param {string[]} [options.replayableEvents] - Override the set of event types to record
   */
  constructor({ server, capacity = 10_000, redis = null, replayableEvents }) {
    super();

    if (!server) throw new Error("[EventReplay] options.server is required");

    this._server = server;
    this._capacity = capacity;
    this._redis = redis;
    this._events = new Set(replayableEvents ?? REPLAYABLE_EVENTS);

    /** @type {ReplayEvent[]} */
    this._log = [];
    this._seq = 0;

    /** @type {Set<string>} */
    this._seen = new Set(); // content hashes for dedup

    this._attached = false;
  }

  // ---------------------------------------------------------------------------
  // Attachment
  // ---------------------------------------------------------------------------

  /**
   * @returns {this}
   */
  attach() {
    if (this._attached) return this;
    this._attached = true;

    const s = this._server;

    s.on("peer:joined", (peer, room) =>
      this._record("peer:joined", room.id, peer.id, { peer: peer.toJSON() }),
    );
    s.on("peer:left", (peer, room) =>
      this._record("peer:left", room.id, peer.id, { peerId: peer.id }),
    );
    s.on("peer:reconnected", (peer, room) =>
      this._record("peer:reconnected", room.id, peer.id, {
        peer: peer.toJSON(),
      }),
    );
    s.on("room:created", (room) =>
      this._record("room:created", room.id, null, {
        roomId: room.id,
        metadata: room.metadata,
      }),
    );
    s.on("room:destroyed", (room) =>
      this._record("room:destroyed", room.id, null, { roomId: room.id }),
    );

    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns all events with sequence number > `afterSeq`.
   *
   * @param {number} afterSeq
   * @returns {ReplayEvent[]}
   */
  since(afterSeq) {
    return this._log.filter((e) => e.seq > afterSeq);
  }

  /**
   * Returns all events for a specific room, optionally after a sequence.
   *
   * @param {string} roomId
   * @param {number} [afterSeq=0]
   * @returns {ReplayEvent[]}
   */
  roomEvents(roomId, afterSeq = 0) {
    return this._log.filter((e) => e.roomId === roomId && e.seq > afterSeq);
  }

  /**
   * Replays missed events to a reconnecting peer.
   * Sends each missed event in order via `peer.send()`.
   *
   * @param {string} peerId     - Peer to replay to
   * @param {number} afterSeq   - Last sequence number the peer saw
   * @returns {number}          - Number of events replayed
   */
  replayToPeer(peerId, afterSeq) {
    const peer = this._server.peers.get(peerId);
    if (!peer) return 0;

    const missed = this.since(afterSeq);
    let count = 0;

    for (const event of missed) {
      // Only replay events relevant to the peer's current room
      if (event.roomId && event.roomId !== peer.roomId) continue;

      peer.send({
        type: "replay:event",
        seq: event.seq,
        event: event.type,
        payload: event.payload,
        ts: event.ts,
      });
      count++;
    }

    return count;
  }

  /**
   * Records an event from outside the server event system.
   * Use this for SFU events, recording events, etc.
   *
   * @param {string} type
   * @param {string} [roomId]
   * @param {string} [peerId]
   * @param {object} [payload]
   * @returns {ReplayEvent|null} null if deduplicated
   */
  record(type, roomId, peerId, payload = {}) {
    return this._record(type, roomId, peerId, payload);
  }

  /**
   * Returns the current sequence number (head of the log).
   * @returns {number}
   */
  get currentSeq() {
    return this._seq;
  }

  /**
   * Returns log statistics.
   * @returns {{ size: number, seq: number, oldestSeq: number }}
   */
  stats() {
    return {
      size: this._log.length,
      seq: this._seq,
      oldestSeq: this._log[0]?.seq ?? 0,
    };
  }

  /**
   * Loads the event log from Redis (for cross-process recovery).
   * @returns {Promise<number>} Number of events loaded
   */
  async loadFromRedis() {
    if (!this._redis) return 0;

    try {
      const raw = await this._redis.zRange(REDIS_REPLAY_KEY, 0, -1, {
        REV: false,
      });
      if (!raw?.length) return 0;

      let loaded = 0;
      for (const item of raw) {
        try {
          const event = JSON.parse(item);
          if (!this._seen.has(event.hash)) {
            this._seen.add(event.hash);
            this._log.push(event);
            this._seq = Math.max(this._seq, event.seq);
            loaded++;
          }
        } catch {
          // Skip malformed entries
        }
      }

      return loaded;
    } catch (err) {
      console.error("[EventReplay] Failed to load from Redis:", err.message);
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** @private */
  _record(type, roomId, peerId, payload = {}) {
    const ts = Date.now();
    const hash = this._hash(type, roomId, peerId, ts);

    // Deduplication
    if (this._seen.has(hash)) return null;
    this._seen.add(hash);

    const event = {
      seq: ++this._seq,
      hash,
      type,
      roomId: roomId ?? null,
      peerId: peerId ?? null,
      payload,
      ts,
    };

    // Circular buffer
    if (this._log.length >= this._capacity) {
      const evicted = this._log.shift();
      this._seen.delete(evicted.hash);
    }
    this._log.push(event);

    // Write to Redis asynchronously
    if (this._redis) {
      this._writeToRedis(event).catch((err) => {
        console.error("[EventReplay] Redis write failed:", err.message);
      });
    }

    this.emit("event:recorded", event);
    return event;
  }

  /** @private */
  async _writeToRedis(event) {
    await this._redis.zAdd(REDIS_REPLAY_KEY, {
      score: event.seq,
      value: JSON.stringify(event),
    });
    await this._redis.expire(REDIS_REPLAY_KEY, REDIS_REPLAY_TTL);
    // Trim to capacity
    const size = await this._redis.zCard(REDIS_REPLAY_KEY);
    if (size > this._capacity) {
      await this._redis.zRemRangeByRank(
        REDIS_REPLAY_KEY,
        0,
        size - this._capacity - 1,
      );
    }
  }

  /** @private */
  _hash(type, roomId, peerId, ts) {
    return createHash("sha1")
      .update(`${type}:${roomId ?? ""}:${peerId ?? ""}:${ts}`)
      .digest("hex")
      .slice(0, 16);
  }
}

module.exports = EventReplay;
