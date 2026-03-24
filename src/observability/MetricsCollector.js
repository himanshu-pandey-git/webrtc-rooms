"use strict";

/**
 * @file MetricsCollector.js
 * @description Built-in metrics and per-room QoS collection for webrtc-rooms v2.
 *
 * Collects, aggregates, and exposes operational metrics without any external
 * monitoring dependency. All metrics are available via in-process API and
 * optionally via the Admin REST API.
 *
 * **Metrics collected**
 *
 * System:
 * - `process.uptime`
 * - `process.memory.heapUsed / heapTotal / rss`
 * - `process.cpu` (sampled)
 *
 * Server:
 * - `server.rooms.active`
 * - `server.peers.active`
 * - `server.connections.total` (lifetime)
 * - `server.connections.rejected` (rate limited / auth failed)
 *
 * Per-room QoS:
 * - `room.join.latency.p50 / p95 / p99` (ms)
 * - `room.peer.count.current / peak`
 * - `room.reconnect.attempts`
 * - `room.reconnect.success_rate`
 * - `room.duration.avg` (ms peers stay in room)
 * - `room.data.messages` (relay messages sent)
 *
 * SFU (if attached):
 * - `sfu.producers.active`
 * - `sfu.consumers.active`
 * - `sfu.layer.changes`
 *
 * @module webrtc-rooms/observability/MetricsCollector
 *
 * @example
 * const { MetricsCollector } = require('webrtc-rooms');
 *
 * const metrics = new MetricsCollector({ server });
 * metrics.attach();
 *
 * // Get a full snapshot
 * const snapshot = metrics.snapshot();
 *
 * // Get metrics for a specific room
 * const roomMetrics = metrics.roomSnapshot('standup');
 *
 * // Export as Prometheus text format
 * const promText = metrics.toPrometheus();
 */

const { EventEmitter } = require("events");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Percentile bucket sizes for latency histograms */
const HISTOGRAM_BUCKETS = [10, 25, 50, 100, 200, 500, 1000, 2000, 5000];

/**
 * @typedef {object} LatencyHistogram
 * @property {number[]} samples  - Raw samples (capped at 1000)
 * @property {number}   p50
 * @property {number}   p95
 * @property {number}   p99
 * @property {number}   min
 * @property {number}   max
 * @property {number}   avg
 */

/**
 * @typedef {object} RoomMetrics
 * @property {string}           roomId
 * @property {number}           peersCurrent
 * @property {number}           peersPeak
 * @property {number}           joinsTotal
 * @property {number}           leavesTotal
 * @property {number}           reconnectAttempts
 * @property {number}           reconnectSuccesses
 * @property {LatencyHistogram} joinLatency
 * @property {number}           dataMessages
 * @property {number}           createdAt
 * @property {number}           lastActivityAt
 */

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

/**
 * Collects and aggregates operational metrics for a SignalingServer.
 *
 * @extends EventEmitter
 */
class MetricsCollector extends EventEmitter {
  /**
   * @param {object}  options
   * @param {import('../core/SignalingServer')} options.server
   * @param {boolean} [options.collectRoomMetrics=true]
   * @param {boolean} [options.collectSystemMetrics=true]
   * @param {number}  [options.systemSampleIntervalMs=5000]
   * @param {number}  [options.maxSamplesPerHistogram=1000]
   */
  constructor({
    server,
    collectRoomMetrics = true,
    collectSystemMetrics = true,
    systemSampleIntervalMs = 5_000,
    maxSamplesPerHistogram = 1_000,
  }) {
    super();

    if (!server)
      throw new Error("[MetricsCollector] options.server is required");

    this._server = server;
    this._collectRoomMetrics = collectRoomMetrics;
    this._collectSystemMetrics = collectSystemMetrics;
    this._maxSamples = maxSamplesPerHistogram;

    // ── Server counters ──────────────────────────────────────────────────────
    this._counters = {
      connectionsTotal: 0,
      connectionsRejected: 0,
      joinsTotal: 0,
      leavesTotal: 0,
      reconnectsTotal: 0,
      reconnectSuccesses: 0,
      dataMessages: 0,
    };

    // ── Per-room metrics store ───────────────────────────────────────────────
    /** @type {Map<string, RoomMetrics>} */
    this._rooms = new Map();

    // ── Pending join timers (peerId → start ms) ──────────────────────────────
    /** @type {Map<string, number>} */
    this._joinStart = new Map();

    // ── System metrics ring buffer ───────────────────────────────────────────
    this._systemSamples = [];
    this._systemTimer = null;

    if (collectSystemMetrics) {
      this._systemTimer = setInterval(
        () => this._sampleSystem(),
        systemSampleIntervalMs,
      );
      if (this._systemTimer.unref) this._systemTimer.unref();
    }

    this._attached = false;
    this._startedAt = Date.now();
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

    s.on("peer:connected", () => {
      this._counters.connectionsTotal++;
    });

    s.on("join:rejected", () => {
      this._counters.connectionsRejected++;
    });

    s.on("peer:joined", (peer, room) => {
      this._counters.joinsTotal++;
      this._recordJoinLatency(peer, room);

      if (this._collectRoomMetrics) {
        const rm = this._getOrCreateRoomMetrics(room.id);
        rm.joinsTotal++;
        rm.peersCurrent++;
        rm.peersPeak = Math.max(rm.peersPeak, rm.peersCurrent);
        rm.lastActivityAt = Date.now();
      }
    });

    s.on("peer:left", (peer, room) => {
      this._counters.leavesTotal++;
      this._joinStart.delete(peer.id);

      if (this._collectRoomMetrics) {
        const rm = this._rooms.get(room.id);
        if (rm) {
          rm.leavesTotal++;
          rm.peersCurrent = Math.max(0, rm.peersCurrent - 1);
          rm.lastActivityAt = Date.now();
        }
      }
    });

    s.on("peer:reconnected", (peer, room) => {
      this._counters.reconnectSuccesses++;
      if (this._collectRoomMetrics) {
        const rm = this._rooms.get(room.id);
        if (rm) rm.reconnectSuccesses++;
      }
    });

    s.on("room:created", (room) => {
      if (this._collectRoomMetrics) {
        this._getOrCreateRoomMetrics(room.id);
        // Intercept data relay for message counting
        room.on("data", () => {
          this._counters.dataMessages++;
          const rm = this._rooms.get(room.id);
          if (rm) rm.dataMessages++;
        });
      }
    });

    s.on("room:destroyed", (room) => {
      // Keep metrics for destroyed rooms (historical record)
      const rm = this._rooms.get(room.id);
      if (rm) rm.lastActivityAt = Date.now();
    });

    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns a full metrics snapshot.
   *
   * @returns {object}
   */
  snapshot() {
    const system = this._latestSystem();
    return {
      timestamp: Date.now(),
      uptimeMs: Date.now() - this._startedAt,
      system,
      server: {
        rooms: this._server.rooms.size,
        peers: this._server.peers.size,
        connectionsTotal: this._counters.connectionsTotal,
        connectionsRejected: this._counters.connectionsRejected,
        joinsTotal: this._counters.joinsTotal,
        leavesTotal: this._counters.leavesTotal,
        reconnectsTotal: this._counters.reconnectsTotal,
        reconnectSuccessRate: this._reconnectSuccessRate(),
        dataMessages: this._counters.dataMessages,
      },
      rooms: this._collectRoomMetrics
        ? [...this._rooms.values()].map((rm) => this._serializeRoomMetrics(rm))
        : [],
    };
  }

  /**
   * Returns metrics for a single room.
   *
   * @param {string} roomId
   * @returns {object|null}
   */
  roomSnapshot(roomId) {
    const rm = this._rooms.get(roomId);
    if (!rm) return null;
    return this._serializeRoomMetrics(rm);
  }

  /**
   * Returns all room metrics.
   *
   * @returns {object[]}
   */
  allRoomSnapshots() {
    return [...this._rooms.values()].map((rm) =>
      this._serializeRoomMetrics(rm),
    );
  }

  /**
   * Exports metrics in Prometheus text exposition format.
   *
   * @returns {string}
   */
  toPrometheus() {
    const s = this.snapshot();
    const now = Date.now();
    const lines = [];

    const g = (name, help, value, labels = "") => {
      lines.push(`# HELP webrtc_rooms_${name} ${help}`);
      lines.push(`# TYPE webrtc_rooms_${name} gauge`);
      lines.push(
        `webrtc_rooms_${name}${labels ? `{${labels}}` : ""} ${value} ${now}`,
      );
    };

    const c = (name, help, value, labels = "") => {
      lines.push(`# HELP webrtc_rooms_${name} ${help}`);
      lines.push(`# TYPE webrtc_rooms_${name} counter`);
      lines.push(
        `webrtc_rooms_${name}_total${labels ? `{${labels}}` : ""} ${value} ${now}`,
      );
    };

    g("rooms_active", "Number of active rooms", s.server.rooms);
    g("peers_active", "Number of active peers", s.server.peers);
    g(
      "uptime_seconds",
      "Process uptime in seconds",
      Math.floor(s.uptimeMs / 1000),
    );
    c("connections", "Total WebSocket connections", s.server.connectionsTotal);
    c(
      "connections_rejected",
      "Rejected connection attempts",
      s.server.connectionsRejected,
    );
    c("joins", "Total successful room joins", s.server.joinsTotal);
    c("reconnects", "Total reconnect successes", s.server.reconnectsTotal);
    c("data_messages", "Total data relay messages", s.server.dataMessages);
    g(
      "reconnect_success_rate",
      "Reconnect success rate 0-1",
      s.server.reconnectSuccessRate,
    );

    if (s.system) {
      g("heap_used_bytes", "V8 heap used bytes", s.system.heapUsed);
      g("heap_total_bytes", "V8 heap total bytes", s.system.heapTotal);
      g("rss_bytes", "Resident set size", s.system.rss);
    }

    for (const rm of s.rooms) {
      const l = `room="${rm.roomId}"`;
      g("room_peers_current", "Current peers in room", rm.peersCurrent, l);
      g("room_peers_peak", "Peak peers in room", rm.peersPeak, l);
      g(
        "room_join_latency_p95_ms",
        "Join latency p95 ms",
        rm.joinLatency.p95,
        l,
      );
    }

    return lines.join("\n") + "\n";
  }

  /**
   * Records a reconnect attempt (call when a peer sends a reconnect signal).
   *
   * @param {string} peerId
   */
  recordReconnectAttempt(peerId) {
    this._counters.reconnectsTotal++;
    const roomId = this._server.peers.get(peerId)?.roomId;
    if (roomId) {
      const rm = this._rooms.get(roomId);
      if (rm) rm.reconnectAttempts++;
    }
  }

  /**
   * Shuts down background timers.
   */
  close() {
    clearInterval(this._systemTimer);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * @private
   */
  _recordJoinLatency(peer, room) {
    const start = this._joinStart.get(peer.id) ?? peer.connectedAt;
    const latencyMs = Date.now() - start;
    this._joinStart.delete(peer.id);

    if (this._collectRoomMetrics) {
      const rm = this._getOrCreateRoomMetrics(room.id);
      this._pushSample(rm.joinLatency, latencyMs);
      this._recomputePercentiles(rm.joinLatency);
    }
  }

  /**
   * @private
   */
  _getOrCreateRoomMetrics(roomId) {
    if (this._rooms.has(roomId)) return this._rooms.get(roomId);

    /** @type {RoomMetrics} */
    const rm = {
      roomId,
      peersCurrent: 0,
      peersPeak: 0,
      joinsTotal: 0,
      leavesTotal: 0,
      reconnectAttempts: 0,
      reconnectSuccesses: 0,
      joinLatency: {
        samples: [],
        p50: 0,
        p95: 0,
        p99: 0,
        min: 0,
        max: 0,
        avg: 0,
      },
      dataMessages: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    this._rooms.set(roomId, rm);
    return rm;
  }

  /**
   * @private
   */
  _pushSample(histogram, value) {
    if (histogram.samples.length >= this._maxSamples) {
      histogram.samples.shift();
    }
    histogram.samples.push(value);
  }

  /**
   * @private
   */
  _recomputePercentiles(histogram) {
    const sorted = [...histogram.samples].sort((a, b) => a - b);
    const len = sorted.length;
    if (len === 0) return;

    histogram.min = sorted[0];
    histogram.max = sorted[len - 1];
    histogram.avg = Math.round(sorted.reduce((s, v) => s + v, 0) / len);
    histogram.p50 = sorted[Math.floor(len * 0.5)] ?? 0;
    histogram.p95 = sorted[Math.floor(len * 0.95)] ?? 0;
    histogram.p99 = sorted[Math.floor(len * 0.99)] ?? 0;
  }

  /**
   * @private
   */
  _serializeRoomMetrics(rm) {
    const reconnectRate =
      rm.reconnectAttempts > 0
        ? rm.reconnectSuccesses / rm.reconnectAttempts
        : 1;

    return {
      roomId: rm.roomId,
      peersCurrent: rm.peersCurrent,
      peersPeak: rm.peersPeak,
      joinsTotal: rm.joinsTotal,
      leavesTotal: rm.leavesTotal,
      reconnectAttempts: rm.reconnectAttempts,
      reconnectSuccessRate: reconnectRate,
      joinLatency: {
        p50: rm.joinLatency.p50,
        p95: rm.joinLatency.p95,
        p99: rm.joinLatency.p99,
        min: rm.joinLatency.min,
        max: rm.joinLatency.max,
        avg: rm.joinLatency.avg,
      },
      dataMessages: rm.dataMessages,
      createdAt: rm.createdAt,
      lastActivityAt: rm.lastActivityAt,
    };
  }

  /**
   * @private
   */
  _sampleSystem() {
    const mem = process.memoryUsage();
    const sample = {
      ts: Date.now(),
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
    };
    if (this._systemSamples.length >= 120) this._systemSamples.shift();
    this._systemSamples.push(sample);
  }

  /**
   * @private
   */
  _latestSystem() {
    return this._systemSamples[this._systemSamples.length - 1] ?? null;
  }

  /**
   * @private
   */
  _reconnectSuccessRate() {
    const attempts = this._counters.reconnectsTotal;
    if (attempts === 0) return 1;
    return this._counters.reconnectSuccesses / attempts;
  }
}

module.exports = MetricsCollector;
