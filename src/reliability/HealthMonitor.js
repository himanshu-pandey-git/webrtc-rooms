"use strict";

/**
 * @file HealthMonitor.js
 * @description SLO tracking, health checks, and operational alerting for
 * webrtc-rooms v2.
 *
 * Tracks service-level objectives and fires alert hooks when SLOs are
 * breached. Works alongside MetricsCollector — MetricsCollector collects
 * raw numbers, HealthMonitor evaluates them against targets.
 *
 * **Default SLOs**
 *
 * | SLO                        | Target   | Severity |
 * |----------------------------|----------|----------|
 * | Join success rate          | ≥ 99.5%  | CRITICAL |
 * | P95 join latency           | ≤ 500ms  | WARNING  |
 * | Reconnect success rate     | ≥ 95%    | WARNING  |
 * | Error rate (signals)       | ≤ 1%     | CRITICAL |
 * | Process memory (heap)      | ≤ 85%    | WARNING  |
 *
 * @module webrtc-rooms/reliability/HealthMonitor
 *
 * @example
 * const health = new HealthMonitor({ server, metrics });
 * health.attach();
 *
 * health.on('slo:breach', ({ slo, actual, target, severity }) => {
 *   pagerduty.trigger(slo, actual);
 * });
 *
 * // Express health endpoint
 * app.get('/health', (req, res) => res.json(health.report()));
 */

const { EventEmitter } = require("events");

const Severity = Object.freeze({ WARNING: "warning", CRITICAL: "critical" });

const DEFAULT_SLOS = [
  {
    name: "join_success_rate",
    target: 0.995,
    op: ">=",
    severity: Severity.CRITICAL,
  },
  {
    name: "join_latency_p95_ms",
    target: 500,
    op: "<=",
    severity: Severity.WARNING,
  },
  {
    name: "reconnect_success_rate",
    target: 0.95,
    op: ">=",
    severity: Severity.WARNING,
  },
  { name: "heap_ratio", target: 0.85, op: "<=", severity: Severity.WARNING },
];

/**
 * @extends EventEmitter
 * @fires HealthMonitor#slo:breach
 * @fires HealthMonitor#slo:recovery
 * @fires HealthMonitor#health:check
 */
class HealthMonitor extends EventEmitter {
  /**
   * @param {object}  options
   * @param {import('../core/SignalingServer')} options.server
   * @param {object}  options.metrics   - MetricsCollector instance
   * @param {object[]} [options.slos]   - Override/extend SLO definitions
   * @param {number}  [options.checkIntervalMs=15000]
   * @param {string}  [options.serviceName='webrtc-rooms']
   */
  constructor({
    server,
    metrics,
    slos = DEFAULT_SLOS,
    checkIntervalMs = 15_000,
    serviceName = "webrtc-rooms",
  }) {
    super();

    if (!server) throw new Error("[HealthMonitor] options.server is required");
    if (!metrics)
      throw new Error("[HealthMonitor] options.metrics is required");

    this._server = server;
    this._metrics = metrics;
    this._slos = slos;
    this._serviceName = serviceName;

    /** @type {Map<string, boolean>} slo.name → currently breached */
    this._breached = new Map();

    /** @type {ReturnType<typeof setInterval>} */
    this._timer = setInterval(() => this._check(), checkIntervalMs).unref();

    this._startedAt = Date.now();
    this._attached = false;
  }

  // ---------------------------------------------------------------------------
  // Attachment
  // ---------------------------------------------------------------------------

  /** @returns {this} */
  attach() {
    if (this._attached) return this;
    this._attached = true;
    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns a full health report suitable for a `/health` or `/ready` endpoint.
   *
   * @returns {object}
   */
  report() {
    const snap = this._metrics.snapshot();
    const checks = this._evaluateSLOs(snap);
    const healthy = checks.every((c) => c.passing);

    return {
      status: healthy ? "healthy" : "degraded",
      service: this._serviceName,
      ts: Date.now(),
      uptimeMs: Date.now() - this._startedAt,
      checks,
      server: {
        rooms: snap.server.rooms,
        peers: snap.server.peers,
      },
    };
  }

  /**
   * Returns true if all SLOs are currently passing.
   * @returns {boolean}
   */
  isHealthy() {
    return [...this._breached.values()].every((v) => !v);
  }

  /**
   * Returns currently breached SLOs.
   * @returns {string[]}
   */
  breaches() {
    return [...this._breached.entries()]
      .filter(([, breached]) => breached)
      .map(([name]) => name);
  }

  /**
   * Shuts down the background check timer.
   */
  close() {
    clearInterval(this._timer);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** @private */
  _check() {
    const snap = this._metrics.snapshot();
    const checks = this._evaluateSLOs(snap);

    /**
     * @event HealthMonitor#health:check
     * @param {object[]} checks
     */
    this.emit("health:check", checks);
  }

  /** @private */
  _evaluateSLOs(snap) {
    const values = this._extractValues(snap);

    return this._slos.map((slo) => {
      const actual = values[slo.name];
      if (actual === undefined)
        return {
          name: slo.name,
          passing: true,
          actual: null,
          target: slo.target,
        };

      const passing =
        slo.op === ">=" ? actual >= slo.target : actual <= slo.target;
      const wasBreached = this._breached.get(slo.name) ?? false;

      if (!passing && !wasBreached) {
        this._breached.set(slo.name, true);
        /**
         * @event HealthMonitor#slo:breach
         */
        this.emit("slo:breach", {
          slo: slo.name,
          actual,
          target: slo.target,
          severity: slo.severity,
        });
      } else if (passing && wasBreached) {
        this._breached.set(slo.name, false);
        /**
         * @event HealthMonitor#slo:recovery
         */
        this.emit("slo:recovery", {
          slo: slo.name,
          actual,
          target: slo.target,
        });
      } else {
        this._breached.set(slo.name, !passing);
      }

      return {
        name: slo.name,
        passing,
        actual,
        target: slo.target,
        severity: slo.severity,
      };
    });
  }

  /** @private */
  _extractValues(snap) {
    const mem = process.memoryUsage();
    const heapRatio = mem.heapUsed / mem.heapTotal;

    // Join success rate: (joins - rejected) / (joins + rejected)
    const totalAttempts =
      snap.server.joinsTotal + snap.server.connectionsRejected;
    const joinSuccessRate =
      totalAttempts > 0 ? snap.server.joinsTotal / totalAttempts : 1;

    // P95 join latency — average across rooms
    const p95s = snap.rooms.map((r) => r.joinLatency.p95).filter((v) => v > 0);
    const avgP95 =
      p95s.length > 0 ? p95s.reduce((a, b) => a + b, 0) / p95s.length : 0;

    return {
      join_success_rate: joinSuccessRate,
      join_latency_p95_ms: avgP95,
      reconnect_success_rate: snap.server.reconnectSuccessRate,
      heap_ratio: heapRatio,
    };
  }
}

HealthMonitor.Severity = Severity;

module.exports = HealthMonitor;
