"use strict";

/**
 * @file SessionManager.js
 * @description Fast reconnect and session resume protocol for webrtc-rooms v2.
 *
 * Manages the full lifecycle of peer sessions across socket drops,
 * process restarts (via Redis), and region migrations. The session layer
 * sits between the raw WebSocket connection and the Room/Peer objects,
 * providing zero-drop reconnection for end users.
 *
 * **Session lifecycle**
 *
 * ```
 * CREATED → ACTIVE → SUSPENDED → RESUMED
 *                  ↘ EXPIRED   (TTL elapsed)
 *                  ↘ MIGRATED  (region move)
 * ```
 *
 * **Fast reconnect flow**
 *
 * 1. Peer connects → session created, token issued (JWT, 15s default TTL)
 * 2. Socket drops → session enters SUSPENDED state, messages queued
 * 3. Peer reconnects with token → session RESUMED, queue flushed
 * 4. TTL expires → session EXPIRED, peer must do a full join
 *
 * **Cross-process resume (Redis)**
 *
 * When a Redis client is provided, session state is written to Redis on
 * suspension and deleted on resume/expiry. This allows a peer to reconnect
 * to a different process behind a load balancer and still resume their session.
 *
 * @module webrtc-rooms/core/SessionManager
 *
 * @example
 * const mgr = new SessionManager({ reconnectTtl: 30_000, redis });
 * mgr.attach(signalingServer);
 */

const { EventEmitter } = require("events");
const { createHmac, randomBytes } = require("crypto");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_KEY_PREFIX = "webrtc-rooms:session:";

/** @enum {string} */
const SessionState = Object.freeze({
  CREATED: "created",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  RESUMED: "resumed",
  EXPIRED: "expired",
  MIGRATED: "migrated",
});

/**
 * @typedef {object} Session
 * @property {string}      id           - Session ID (same as peer ID for simplicity)
 * @property {string}      token        - HMAC-signed reconnect token
 * @property {string}      roomId       - Room the peer belongs to
 * @property {object}      metadata     - Peer metadata snapshot at suspension
 * @property {SessionState} state       - Current lifecycle state
 * @property {number}      createdAt    - Unix ms
 * @property {number}      suspendedAt  - Unix ms, set on socket drop
 * @property {number}      ttl          - Milliseconds before SUSPENDED → EXPIRED
 * @property {object[]}    queue        - Outbound messages buffered during suspension
 * @property {string}      region       - Region identifier this session belongs to
 */

/**
 * Manages peer session lifecycle with fast reconnect, cross-process resume,
 * and region-aware session migration.
 *
 * @extends EventEmitter
 *
 * @fires SessionManager#session:created
 * @fires SessionManager#session:suspended
 * @fires SessionManager#session:resumed
 * @fires SessionManager#session:expired
 * @fires SessionManager#session:migrated
 */
class SessionManager extends EventEmitter {
  /**
   * @param {object}  options
   * @param {number}  [options.reconnectTtl=15000]
   *   Milliseconds a suspended session stays alive. Default 15s.
   * @param {number}  [options.maxQueueSize=64]
   *   Maximum messages buffered per suspended session.
   * @param {string}  [options.secret]
   *   HMAC secret for signing reconnect tokens. Auto-generated if omitted.
   *   In multi-process deployments, all processes must share the same secret.
   * @param {object}  [options.redis]
   *   Optional Redis client for cross-process session resume.
   * @param {string}  [options.region='default']
   *   Region identifier for this process. Used for migration routing.
   * @param {number}  [options.cleanupIntervalMs=5000]
   *   How often to sweep expired sessions from memory.
   */
  constructor({
    reconnectTtl = 15_000,
    maxQueueSize = 64,
    secret,
    redis = null,
    region = "default",
    cleanupIntervalMs = 5_000,
  } = {}) {
    super();

    this._reconnectTtl = reconnectTtl;
    this._maxQueueSize = maxQueueSize;
    this._secret = secret ?? randomBytes(32).toString("hex");
    this._redis = redis;
    this._region = region;

    /** @type {Map<string, Session>} token → session */
    this._byToken = new Map();

    /** @type {Map<string, Session>} peerId → session */
    this._byPeer = new Map();

    /** @type {ReturnType<typeof setInterval>} */
    this._cleanupTimer = setInterval(
      () => this._sweepExpired(),
      cleanupIntervalMs,
    ).unref();

    this._attached = false;
  }

  // ---------------------------------------------------------------------------
  // Attachment
  // ---------------------------------------------------------------------------

  /**
   * Wires the SessionManager into a SignalingServer instance.
   * Must be called before any peers connect.
   *
   * @param {import('./SignalingServer')} server
   * @returns {this}
   */
  attach(server) {
    if (this._attached) return this;
    this._attached = true;
    this._server = server;

    server.on("peer:joined", (peer, room) => {
      this._createSession(peer, room);
    });

    server.on("peer:left", (peer, room) => {
      this._suspendSession(peer, room);
    });

    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Attempts to resume a session using a reconnect token.
   *
   * First checks the local in-memory store. If not found and Redis is
   * configured, checks Redis (cross-process resume).
   *
   * @param {string} token   - Reconnect token from the client
   * @param {string} roomId  - Room the peer is trying to resume into
   * @returns {Promise<Session|null>} The resumed session, or null if not found/expired
   */
  async resume(token, roomId) {
    if (!token) return null;

    // 1. Local lookup first (fastest path)
    let session = this._byToken.get(token);

    // 2. Redis lookup (cross-process)
    if (!session && this._redis) {
      session = await this._loadFromRedis(token);
    }

    if (!session) return null;
    if (session.state !== SessionState.SUSPENDED) return null;
    if (Date.now() > session.suspendedAt + session.ttl) {
      this._expireSession(session);
      return null;
    }
    if (!this._verifyToken(token, session.id)) return null;

    // Mark resumed
    session.state = SessionState.RESUMED;
    if (this._redis) await this._deleteFromRedis(token);

    /**
     * @event SessionManager#session:resumed
     * @param {Session} session
     */
    this.emit("session:resumed", session);
    return session;
  }

  /**
   * Queues a message for a suspended session.
   * Called by Room when it tries to send to a RECONNECTING peer.
   *
   * @param {string} peerId
   * @param {object} msg
   * @returns {boolean} true if queued, false if session not found or queue full
   */
  enqueue(peerId, msg) {
    const session = this._byPeer.get(peerId);
    if (!session || session.state !== SessionState.SUSPENDED) return false;
    if (session.queue.length >= this._maxQueueSize) return false;
    session.queue.push(msg);
    return true;
  }

  /**
   * Flushes queued messages for a resumed session to a send function.
   *
   * @param {string}   peerId
   * @param {Function} sendFn  - Called with each queued message
   * @returns {number} Number of messages flushed
   */
  flushQueue(peerId, sendFn) {
    const session = this._byPeer.get(peerId);
    if (!session) return 0;
    const msgs = session.queue.splice(0);
    for (const msg of msgs) sendFn(msg);
    return msgs.length;
  }

  /**
   * Returns session info for a peer.
   *
   * @param {string} peerId
   * @returns {Session|undefined}
   */
  getSession(peerId) {
    return this._byPeer.get(peerId);
  }

  /**
   * Returns aggregate stats.
   *
   * @returns {{ active: number, suspended: number, total: number }}
   */
  stats() {
    let active = 0,
      suspended = 0;
    for (const s of this._byPeer.values()) {
      if (s.state === SessionState.ACTIVE || s.state === SessionState.RESUMED)
        active++;
      else if (s.state === SessionState.SUSPENDED) suspended++;
    }
    return { active, suspended, total: this._byPeer.size };
  }

  /**
   * Migrates a session to a new region. Updates Redis so the target region
   * can resume it.
   *
   * @param {string} peerId
   * @param {string} targetRegion
   * @returns {Promise<boolean>}
   */
  async migrateSession(peerId, targetRegion) {
    const session = this._byPeer.get(peerId);
    if (!session) return false;

    session.state = SessionState.MIGRATED;
    session.region = targetRegion;

    if (this._redis) {
      await this._saveToRedis(session);
    }

    /**
     * @event SessionManager#session:migrated
     * @param {Session} session
     * @param {string}  targetRegion
     */
    this.emit("session:migrated", session, targetRegion);
    return true;
  }

  /**
   * Gracefully shuts down the SessionManager.
   * Clears timers and saves all suspended sessions to Redis.
   *
   * @returns {Promise<void>}
   */
  async close() {
    clearInterval(this._cleanupTimer);

    if (this._redis) {
      const saves = [];
      for (const session of this._byPeer.values()) {
        if (session.state === SessionState.SUSPENDED) {
          saves.push(this._saveToRedis(session));
        }
      }
      await Promise.allSettled(saves);
    }
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle (private)
  // ---------------------------------------------------------------------------

  /**
   * @private
   */
  _createSession(peer, room) {
    const token = this._issueToken(peer.id);

    /** @type {Session} */
    const session = {
      id: peer.id,
      token,
      roomId: room.id,
      metadata: { ...peer.metadata },
      state: SessionState.ACTIVE,
      createdAt: Date.now(),
      suspendedAt: 0,
      ttl: this._reconnectTtl,
      queue: [],
      region: this._region,
    };

    this._byToken.set(token, session);
    this._byPeer.set(peer.id, session);

    // Give the token to the peer so the browser can persist it
    peer.send({ type: "session:token", token, ttl: this._reconnectTtl });

    /**
     * @event SessionManager#session:created
     * @param {Session} session
     */
    this.emit("session:created", session);
  }

  /**
   * @private
   */
  _suspendSession(peer, room) {
    const session = this._byPeer.get(peer.id);
    if (!session) return;

    session.state = SessionState.SUSPENDED;
    session.suspendedAt = Date.now();
    session.metadata = { ...peer.metadata }; // snapshot at suspension

    if (this._redis) {
      this._saveToRedis(session).catch((err) => {
        console.error(
          `[SessionManager] Failed to save session ${session.id} to Redis:`,
          err.message,
        );
      });
    }

    /**
     * @event SessionManager#session:suspended
     * @param {Session} session
     * @param {Room}    room
     */
    this.emit("session:suspended", session, room);
  }

  /**
   * @private
   */
  _expireSession(session) {
    session.state = SessionState.EXPIRED;
    this._byToken.delete(session.token);
    this._byPeer.delete(session.id);

    if (this._redis) {
      this._deleteFromRedis(session.token).catch(() => {});
    }

    /**
     * @event SessionManager#session:expired
     * @param {Session} session
     */
    this.emit("session:expired", session);
  }

  /**
   * Sweep expired suspended sessions from memory.
   * @private
   */
  _sweepExpired() {
    const now = Date.now();
    for (const session of this._byPeer.values()) {
      if (
        session.state === SessionState.SUSPENDED &&
        now > session.suspendedAt + session.ttl
      ) {
        this._expireSession(session);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Token issuing and verification
  // ---------------------------------------------------------------------------

  /**
   * Issues an HMAC-SHA256 signed reconnect token.
   *
   * Format: `<peerId>.<timestamp>.<hmac>`
   *
   * @private
   * @param {string} peerId
   * @returns {string}
   */
  _issueToken(peerId) {
    const ts = Date.now().toString(36);
    const payload = `${peerId}.${ts}`;
    const sig = createHmac("sha256", this._secret)
      .update(payload)
      .digest("base64url");
    return `${payload}.${sig}`;
  }

  /**
   * Verifies a reconnect token was issued by this SessionManager.
   *
   * @private
   * @param {string} token
   * @param {string} expectedPeerId
   * @returns {boolean}
   */
  _verifyToken(token, expectedPeerId) {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return false;
      const [peerId, ts, sig] = parts;
      if (peerId !== expectedPeerId) return false;
      const payload = `${peerId}.${ts}`;
      const expected = createHmac("sha256", this._secret)
        .update(payload)
        .digest("base64url");
      // Constant-time comparison to prevent timing attacks
      return this._safeEqual(sig, expected);
    } catch {
      return false;
    }
  }

  /**
   * Constant-time string comparison.
   * @private
   */
  _safeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  // ---------------------------------------------------------------------------
  // Redis persistence
  // ---------------------------------------------------------------------------

  /**
   * @private
   */
  async _saveToRedis(session) {
    const key = `${SESSION_KEY_PREFIX}${session.token}`;
    const ttlSec = Math.ceil(session.ttl / 1000);
    await this._redis.set(
      key,
      JSON.stringify({
        id: session.id,
        token: session.token,
        roomId: session.roomId,
        metadata: session.metadata,
        state: session.state,
        createdAt: session.createdAt,
        suspendedAt: session.suspendedAt,
        ttl: session.ttl,
        region: session.region,
        queue: session.queue,
      }),
    );
    await this._redis.expire(key, ttlSec);
  }

  /**
   * @private
   */
  async _loadFromRedis(token) {
    const key = `${SESSION_KEY_PREFIX}${token}`;
    let raw;
    try {
      raw = await this._redis.get(key);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      const session = { ...data, queue: data.queue ?? [] };
      // Register in local maps so subsequent lookups hit memory
      this._byToken.set(token, session);
      this._byPeer.set(session.id, session);
      return session;
    } catch {
      return null;
    }
  }

  /**
   * @private
   */
  async _deleteFromRedis(token) {
    await this._redis.del(`${SESSION_KEY_PREFIX}${token}`);
  }
}

SessionManager.State = SessionState;

module.exports = SessionManager;
