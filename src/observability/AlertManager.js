"use strict";

/**
 * @file AlertManager.js
 * @description Real-time alert hooks and webhook notification dispatch for
 * webrtc-rooms v2.
 *
 * Bridges internal server events and SLO breaches to external notification
 * channels (webhooks, custom handlers). Supports alert suppression to prevent
 * alert storms and alert recovery notifications.
 *
 * **Alert sources**
 *
 * - HealthMonitor SLO breaches
 * - ThreatDetector threat events
 * - BackpressureController load level changes
 * - SFUOrchestrator failover events
 * - Custom alerts via `alert()`
 *
 * @module webrtc-rooms/observability/AlertManager
 *
 * @example
 * const alert = new AlertManager({
 *   channels: [
 *     { type: 'webhook', url: 'https://hooks.slack.com/...', events: ['slo:breach', 'failover'] },
 *     { type: 'handler', fn: async (alert) => pagerduty.trigger(alert) },
 *   ],
 *   suppressionWindowMs: 300_000, // don't re-alert same event within 5 min
 * });
 *
 * alert.attachHealthMonitor(healthMonitor);
 * alert.attachThreatDetector(threatDetector);
 */

const { EventEmitter } = require("events");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AlertSeverity = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  CRITICAL: "critical",
});

/**
 * @typedef {object} Alert
 * @property {string}  id
 * @property {string}  event     - Event type (e.g. 'slo:breach', 'threat', 'failover')
 * @property {string}  severity
 * @property {string}  message
 * @property {object}  context
 * @property {number}  ts
 * @property {boolean} recovered - true if this is a recovery notification
 */

/**
 * @extends EventEmitter
 * @fires AlertManager#alert
 * @fires AlertManager#alert:suppressed
 * @fires AlertManager#delivery:failed
 */
class AlertManager extends EventEmitter {
  /**
   * @param {object}    options
   * @param {object[]}  [options.channels=[]]    - Notification channel configs
   * @param {number}    [options.suppressionWindowMs=300000] - 5 min default
   * @param {number}    [options.maxQueueSize=100] - In-memory alert queue
   */
  constructor({
    channels = [],
    suppressionWindowMs = 300_000,
    maxQueueSize = 100,
  } = {}) {
    super();

    this._channels = channels;
    this._suppression = suppressionWindowMs;
    this._maxQueue = maxQueueSize;

    /** @type {Map<string, number>} event key → last alerted ms */
    this._lastAlerted = new Map();

    /** @type {Alert[]} */
    this._queue = [];

    this._seq = 0;
  }

  // ---------------------------------------------------------------------------
  // Source attachment
  // ---------------------------------------------------------------------------

  /**
   * Subscribes to a HealthMonitor instance.
   * @param {object} healthMonitor
   * @returns {this}
   */
  attachHealthMonitor(healthMonitor) {
    healthMonitor.on("slo:breach", ({ slo, actual, target, severity }) => {
      this.alert({
        event: "slo:breach",
        severity:
          severity === "critical"
            ? AlertSeverity.CRITICAL
            : AlertSeverity.WARNING,
        message: `SLO breach: ${slo} is ${actual} (target: ${severity === ">=" ? ">=" : "<="} ${target})`,
        context: { slo, actual, target },
      });
    });

    healthMonitor.on("slo:recovery", ({ slo, actual }) => {
      this.alert({
        event: "slo:recovery",
        severity: AlertSeverity.INFO,
        message: `SLO recovered: ${slo} is now ${actual}`,
        context: { slo, actual },
        recovered: true,
      });
    });

    return this;
  }

  /**
   * Subscribes to a ThreatDetector instance.
   * @param {object} threatDetector
   * @returns {this}
   */
  attachThreatDetector(threatDetector) {
    threatDetector.on("threat", ({ level, threat, ip }) => {
      const severity =
        level === "ban" || level === "kick"
          ? AlertSeverity.CRITICAL
          : AlertSeverity.WARNING;

      this.alert({
        event: `threat:${threat}`,
        severity,
        message: `Threat detected: ${threat} (level: ${level}, ip: ${ip})`,
        context: { level, threat, ip },
      });
    });

    return this;
  }

  /**
   * Subscribes to an SFUOrchestrator instance.
   * @param {object} orchestrator
   * @returns {this}
   */
  attachSFUOrchestrator(orchestrator) {
    orchestrator.on("sfu:down", (region) => {
      this.alert({
        event: "sfu:down",
        severity: AlertSeverity.CRITICAL,
        message: `SFU region "${region}" is DOWN`,
        context: { region },
      });
    });

    orchestrator.on("failover", (region, rooms) => {
      this.alert({
        event: "sfu:failover",
        severity: AlertSeverity.WARNING,
        message: `Failover triggered for ${rooms.length} rooms from region "${region}"`,
        context: { region, roomCount: rooms.length },
      });
    });

    orchestrator.on("sfu:healthy", (region) => {
      this.alert({
        event: "sfu:recovered",
        severity: AlertSeverity.INFO,
        message: `SFU region "${region}" recovered`,
        context: { region },
        recovered: true,
      });
    });

    return this;
  }

  /**
   * Subscribes to a BackpressureController instance.
   * @param {object} bp
   * @returns {this}
   */
  attachBackpressure(bp) {
    bp.on("load:critical", ({ heapRatio, peerRatio }) => {
      this.alert({
        event: "load:critical",
        severity: AlertSeverity.CRITICAL,
        message: `Server load CRITICAL — heap: ${Math.round(heapRatio * 100)}%, peers: ${Math.round(peerRatio * 100)}%`,
        context: { heapRatio, peerRatio },
      });
    });

    bp.on("load:normal", () => {
      this.alert({
        event: "load:recovered",
        severity: AlertSeverity.INFO,
        message: "Server load returned to NORMAL",
        context: {},
        recovered: true,
      });
    });

    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fires an alert. Respects the suppression window.
   *
   * @param {object}  options
   * @param {string}  options.event
   * @param {string}  options.severity
   * @param {string}  options.message
   * @param {object}  [options.context={}]
   * @param {boolean} [options.recovered=false]
   * @returns {Alert|null} null if suppressed
   */
  alert({ event, severity, message, context = {}, recovered = false }) {
    const suppressKey = `${event}:${JSON.stringify(context).slice(0, 64)}`;
    const now = Date.now();

    if (!recovered) {
      const last = this._lastAlerted.get(suppressKey);
      if (last && now - last < this._suppression) {
        this.emit("alert:suppressed", { event, suppressKey });
        return null;
      }
      this._lastAlerted.set(suppressKey, now);
    }

    /** @type {Alert} */
    const alert = {
      id: `alert-${++this._seq}`,
      event,
      severity,
      message,
      context,
      ts: now,
      recovered,
    };

    if (this._queue.length >= this._maxQueue) this._queue.shift();
    this._queue.push(alert);

    this.emit("alert", alert);
    this._dispatch(alert);

    return alert;
  }

  /**
   * Returns recent alerts.
   * @param {number} [limit=50]
   * @returns {Alert[]}
   */
  recent(limit = 50) {
    return this._queue.slice(-limit);
  }

  /**
   * Clears the suppression cache (useful in tests or after resolving an outage).
   */
  clearSuppression() {
    this._lastAlerted.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal dispatch
  // ---------------------------------------------------------------------------

  /** @private */
  _dispatch(alert) {
    for (const channel of this._channels) {
      if (channel.events && !channel.events.includes(alert.event)) continue;

      if (channel.type === "handler" && typeof channel.fn === "function") {
        Promise.resolve(channel.fn(alert)).catch((err) => {
          this.emit("delivery:failed", { channel, alert, error: err.message });
        });
      } else if (channel.type === "webhook" && channel.url) {
        this._deliverWebhook(channel, alert);
      }
    }
  }

  /** @private */
  _deliverWebhook(channel, alert) {
    const body = JSON.stringify(alert);
    const url = new URL(channel.url);

    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "webrtc-rooms-alert/2.0",
      },
    };

    const lib = url.protocol === "https:" ? require("https") : require("http");

    const req = lib.request(opts, (res) => {
      if (res.statusCode >= 400) {
        this.emit("delivery:failed", {
          channel,
          alert,
          error: `HTTP ${res.statusCode}`,
        });
      }
      res.resume(); // drain
    });

    req.on("error", (err) => {
      this.emit("delivery:failed", { channel, alert, error: err.message });
    });

    req.setTimeout(10_000, () => {
      req.destroy();
      this.emit("delivery:failed", {
        channel,
        alert,
        error: "Webhook timeout",
      });
    });

    req.write(body);
    req.end();
  }
}

AlertManager.Severity = AlertSeverity;

module.exports = AlertManager;
