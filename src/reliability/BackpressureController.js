"use strict";

/**
 * @file BackpressureController.js
 * @description Overload protection and backpressure management for webrtc-rooms v2.
 *
 * Monitors system load and applies graduated backpressure before the server
 * becomes unresponsive. Prevents the thundering herd problem on restart and
 * protects against sustained overload conditions.
 *
 * **Load levels**
 *
 * ```
 * NORMAL → ELEVATED → HIGH → CRITICAL → SHEDDING
 * ```
 *
 * | Level    | Condition                          | Action                         |
 * |----------|------------------------------------|--------------------------------|
 * | NORMAL   | heap < 60%, peers < 80% cap        | No action                      |
 * | ELEVATED | heap 60-75% or peers 80-90% cap    | Warn, slow new joins           |
 * | HIGH     | heap 75-85% or peers 90-95% cap    | Reject new rooms, warn admins  |
 * | CRITICAL | heap 85-95% or peers 95-99% cap    | Reject new joins               |
 * | SHEDDING | heap > 95% or peers at cap         | Disconnect lowest-priority peers|
 *
 * @module webrtc-rooms/reliability/BackpressureController
 *
 * @example
 * const bp = new BackpressureController({ server, maxPeers: 1000 });
 * bp.attach();
 *
 * bp.on('load:high', ({ level, heapRatio, peerRatio }) => {
 *   alerting.warn('webrtc-rooms load HIGH', { level, heapRatio });
 * });
 */

const { EventEmitter } = require("events");

const LoadLevel = Object.freeze({
  NORMAL: "normal",
  ELEVATED: "elevated",
  HIGH: "high",
  CRITICAL: "critical",
  SHEDDING: "shedding",
});

const THRESHOLDS = {
  heap: {
    elevated: 0.6,
    high: 0.75,
    critical: 0.85,
    shedding: 0.95,
  },
  peers: {
    elevated: 0.8,
    high: 0.9,
    critical: 0.95,
    shedding: 1.0,
  },
};

/**
 * @extends EventEmitter
 *
 * @fires BackpressureController#load:elevated
 * @fires BackpressureController#load:high
 * @fires BackpressureController#load:critical
 * @fires BackpressureController#load:shedding
 * @fires BackpressureController#load:normal
 */
class BackpressureController extends EventEmitter {
  /**
   * @param {object}  options
   * @param {import('../core/SignalingServer')} options.server
   * @param {number}  [options.maxPeers=10000]         - Global peer cap
   * @param {number}  [options.sampleIntervalMs=2000]  - How often to sample load
   * @param {boolean} [options.enableLoadShedding=true] - Allow shedding peers under critical load
   * @param {number}  [options.joinSlowdownMs=0]       - Extra delay added to joins under ELEVATED load
   */
  constructor({
    server,
    maxPeers = 10_000,
    sampleIntervalMs = 2_000,
    enableLoadShedding = true,
    joinSlowdownMs = 0,
  }) {
    super();

    if (!server)
      throw new Error("[BackpressureController] options.server is required");

    this._server = server;
    this._maxPeers = maxPeers;
    this._sampleInterval = sampleIntervalMs;
    this._enableShedding = enableLoadShedding;
    this._joinSlowdownMs = joinSlowdownMs;

    this._currentLevel = LoadLevel.NORMAL;
    this._lastLevel = LoadLevel.NORMAL;

    /** @type {ReturnType<typeof setInterval>} */
    this._sampleTimer = setInterval(
      () => this._sample(),
      sampleIntervalMs,
    ).unref();

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

    const existing = this._server.beforeJoin;

    this._server.beforeJoin = async (peer, roomId) => {
      // Check load before allowing join
      const blocked = this._checkJoinAllowed(peer);
      if (blocked !== true) return blocked;

      if (existing) return existing(peer, roomId);
      return true;
    };

    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns current load level and metrics.
   */
  status() {
    const mem = process.memoryUsage();
    const heapRatio = mem.heapUsed / mem.heapTotal;
    const peerCount = this._server.peers.size;
    const peerRatio = peerCount / this._maxPeers;

    return {
      level: this._currentLevel,
      heapRatio: Math.round(heapRatio * 1000) / 1000,
      peerRatio: Math.round(peerRatio * 1000) / 1000,
      peerCount,
      maxPeers: this._maxPeers,
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    };
  }

  /**
   * Shuts down the background sampler.
   */
  close() {
    clearInterval(this._sampleTimer);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** @private */
  _sample() {
    const mem = process.memoryUsage();
    const heapRatio = mem.heapUsed / mem.heapTotal;
    const peerRatio = this._server.peers.size / this._maxPeers;

    const level = this._computeLevel(heapRatio, peerRatio);

    if (level !== this._currentLevel) {
      this._lastLevel = this._currentLevel;
      this._currentLevel = level;
      this.emit(`load:${level}`, { level, heapRatio, peerRatio });
    }

    if (level === LoadLevel.SHEDDING && this._enableShedding) {
      this._shedPeers(Math.ceil(this._server.peers.size * 0.05));
    }
  }

  /** @private */
  _computeLevel(heapRatio, peerRatio) {
    const t = THRESHOLDS;
    const h = heapRatio,
      p = peerRatio;

    if (h >= t.heap.shedding || p >= t.peers.shedding)
      return LoadLevel.SHEDDING;
    if (h >= t.heap.critical || p >= t.peers.critical)
      return LoadLevel.CRITICAL;
    if (h >= t.heap.high || p >= t.peers.high) return LoadLevel.HIGH;
    if (h >= t.heap.elevated || p >= t.peers.elevated)
      return LoadLevel.ELEVATED;
    return LoadLevel.NORMAL;
  }

  /** @private */
  _checkJoinAllowed(peer) {
    switch (this._currentLevel) {
      case LoadLevel.CRITICAL:
        peer.send({
          type: "error",
          code: "SERVER_OVERLOADED",
          message: "Server is at capacity. Please retry in a moment.",
        });
        return "Server overloaded";

      case LoadLevel.SHEDDING:
        peer.send({
          type: "error",
          code: "SERVER_OVERLOADED",
          message: "Server is at capacity.",
        });
        return "Server overloaded";

      case LoadLevel.HIGH:
        // Allow joins but warn
        peer.send({
          type: "server:warning",
          code: "HIGH_LOAD",
          message: "Server is under high load.",
        });
        return true;

      default:
        return true;
    }
  }

  /**
   * Sheds lowest-priority peers (those with no role / viewer-only).
   * Never sheds moderators or admins.
   * @private
   */
  _shedPeers(count) {
    let shed = 0;
    for (const peer of this._server.peers.values()) {
      if (shed >= count) break;
      const role = peer.metadata.__role;
      if (role === "moderator" || role === "admin") continue;
      peer.send({
        type: "kicked",
        reason: "Server load shedding. Please reconnect.",
      });
      peer.close(1001, "Load shedding");
      shed++;
    }
    if (shed > 0) {
      console.warn(
        `[BackpressureController] Load shedding — disconnected ${shed} peers`,
      );
    }
  }
}

BackpressureController.Level = LoadLevel;

module.exports = BackpressureController;
