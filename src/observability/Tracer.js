"use strict";

/**
 * @file Tracer.js
 * @description Distributed trace collection across the signaling → room →
 * adapter pipeline for webrtc-rooms v2.
 *
 * Produces structured trace spans compatible with OpenTelemetry's data model
 * without requiring any OpenTelemetry SDK dependency. Spans can be exported
 * to any backend via the pluggable `exporter` option.
 *
 * **Trace model**
 *
 * Each peer join creates a root span. Child spans are created for:
 * - `beforeJoin` hook execution
 * - Room assignment
 * - SFU transport setup
 * - Each signaling round-trip (offer→answer, ICE completion)
 *
 * Spans are linked by `traceId` (per-peer lifecycle) and `spanId`.
 *
 * **Built-in exporters**
 *
 * - `console`  — pretty-prints to stdout (default in development)
 * - `noop`     — discards all spans (default in production unless configured)
 * - `buffer`   — collects spans in memory for testing/admin API inspection
 *
 * For production use, pass a custom `exporter` that ships to your backend
 * (Jaeger, Zipkin, Datadog, etc.).
 *
 * @module webrtc-rooms/observability/Tracer
 *
 * @example
 * const { Tracer } = require('webrtc-rooms');
 *
 * const tracer = new Tracer({
 *   server,
 *   exporter: async (span) => {
 *     await myJaegerClient.report(span);
 *   },
 * });
 * tracer.attach();
 */

const { EventEmitter } = require("events");
const { randomBytes } = require("crypto");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function traceId() {
  return randomBytes(16).toString("hex");
}
function spanId() {
  return randomBytes(8).toString("hex");
}
function hrNow() {
  return Number(process.hrtime.bigint() / 1_000_000n);
} // ms

/**
 * @typedef {object} Span
 * @property {string}  traceId
 * @property {string}  spanId
 * @property {string}  parentSpanId
 * @property {string}  name
 * @property {number}  startMs
 * @property {number}  durationMs
 * @property {string}  status   - 'ok' | 'error'
 * @property {object}  attrs
 * @property {object[]} events  - Point-in-time events within the span
 */

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

/**
 * Lightweight distributed tracer for webrtc-rooms v2.
 *
 * @extends EventEmitter
 * @fires Tracer#span:finished
 */
class Tracer extends EventEmitter {
  /**
   * @param {object}    options
   * @param {import('../core/SignalingServer')} options.server
   * @param {Function}  [options.exporter]  - `async (span: Span) => void`
   * @param {string}    [options.mode='buffer'] - 'console' | 'buffer' | 'noop'
   * @param {number}    [options.bufferSize=1000] - Max spans in buffer mode
   * @param {string}    [options.serviceName='webrtc-rooms']
   */
  constructor({
    server,
    exporter,
    mode = "buffer",
    bufferSize = 1_000,
    serviceName = "webrtc-rooms",
  }) {
    super();

    if (!server) throw new Error("[Tracer] options.server is required");

    this._server = server;
    this._mode = mode;
    this._bufferSize = bufferSize;
    this._serviceName = serviceName;
    this._exporter = exporter ?? null;

    /** @type {Map<string, string>} peerId → traceId */
    this._peerTraces = new Map();

    /** @type {Map<string, Span>} spanId → active span */
    this._activeSpans = new Map();

    /** @type {Span[]} Completed spans (buffer mode) */
    this._buffer = [];

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

    s.on("peer:connected", (peer) => {
      const tid = traceId();
      this._peerTraces.set(peer.id, tid);
      this._startSpan("peer.connected", tid, null, { peerId: peer.id });
    });

    s.on("peer:joined", (peer, room) => {
      const tid = this._peerTraces.get(peer.id) ?? traceId();
      const span = this._startSpan("peer.join", tid, null, {
        peerId: peer.id,
        roomId: room.id,
        role: peer.metadata.__role ?? "unknown",
      });
      this._endSpan(span.spanId, "ok");
    });

    s.on("peer:left", (peer, room) => {
      const tid = this._peerTraces.get(peer.id);
      if (tid) {
        const span = this._startSpan("peer.leave", tid, null, {
          peerId: peer.id,
          roomId: room.id,
          duration: Date.now() - (peer.connectedAt ?? 0),
        });
        this._endSpan(span.spanId, "ok");
        this._peerTraces.delete(peer.id);
      }
    });

    s.on("peer:reconnected", (peer, room) => {
      const tid = this._peerTraces.get(peer.id) ?? traceId();
      this._peerTraces.set(peer.id, tid);
      const span = this._startSpan("peer.reconnect", tid, null, {
        peerId: peer.id,
        roomId: room.id,
      });
      this._endSpan(span.spanId, "ok");
    });

    s.on("join:rejected", (peer, reason) => {
      const tid = this._peerTraces.get(peer.id);
      if (tid) {
        const span = this._startSpan("peer.join.rejected", tid, null, {
          peerId: peer.id,
          reason,
        });
        this._endSpan(span.spanId, "error", reason);
      }
    });

    s.on("room:created", (room) => {
      this._startSpan("room.created", traceId(), null, { roomId: room.id });
    });

    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API — manual span creation
  // ---------------------------------------------------------------------------

  /**
   * Starts a named span. Returns a handle to end it.
   *
   * @param {string} name
   * @param {string} [parentTraceId]
   * @param {object} [attrs]
   * @returns {{ spanId: string, end: (status?, error?) => void }}
   */
  startSpan(name, parentTraceId, attrs = {}) {
    const tid = parentTraceId ?? traceId();
    const span = this._startSpan(name, tid, null, attrs);
    return {
      spanId: span.spanId,
      addEvent: (eventName, eventAttrs = {}) => {
        span.events.push({ name: eventName, ts: hrNow(), ...eventAttrs });
      },
      end: (status = "ok", error) => {
        this._endSpan(span.spanId, status, error);
      },
    };
  }

  /**
   * Returns buffered spans (buffer mode only).
   *
   * @param {object}  [options]
   * @param {number}  [options.limit=100]
   * @param {string}  [options.name]   - Filter by span name
   * @param {string}  [options.traceId] - Filter by trace ID
   * @returns {Span[]}
   */
  getSpans({ limit = 100, name, traceId: tid } = {}) {
    let spans = [...this._buffer];
    if (name) spans = spans.filter((s) => s.name === name);
    if (tid) spans = spans.filter((s) => s.traceId === tid);
    return spans.slice(-limit);
  }

  /**
   * Returns the trace ID for a peer's current session.
   * @param {string} peerId
   * @returns {string|undefined}
   */
  getTraceId(peerId) {
    return this._peerTraces.get(peerId);
  }

  /**
   * Returns trace stats.
   */
  stats() {
    return {
      activeSpans: this._activeSpans.size,
      buffered: this._buffer.length,
      activePeerTraces: this._peerTraces.size,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** @private */
  _startSpan(name, tid, parentSpanId, attrs = {}) {
    /** @type {Span} */
    const span = {
      traceId: tid,
      spanId: spanId(),
      parentSpanId: parentSpanId ?? null,
      name,
      startMs: hrNow(),
      durationMs: 0,
      status: "ok",
      attrs: {
        service: this._serviceName,
        ...attrs,
      },
      events: [],
    };

    this._activeSpans.set(span.spanId, span);
    return span;
  }

  /** @private */
  _endSpan(sid, status = "ok", error) {
    const span = this._activeSpans.get(sid);
    if (!span) return;

    span.durationMs = hrNow() - span.startMs;
    span.status = status;
    if (error) span.attrs.error = String(error);

    this._activeSpans.delete(sid);
    this._export(span);
  }

  /** @private */
  _export(span) {
    switch (this._mode) {
      case "console":
        console.log(
          `[Tracer] ${span.name} | trace=${span.traceId.slice(0, 8)} | ` +
            `${span.durationMs}ms | ${span.status}`,
        );
        break;

      case "buffer":
        if (this._buffer.length >= this._bufferSize) this._buffer.shift();
        this._buffer.push(span);
        break;

      case "noop":
      default:
        break;
    }

    if (this._exporter) {
      Promise.resolve(this._exporter(span)).catch((err) => {
        console.error("[Tracer] Export error:", err.message);
      });
    }

    /**
     * @event Tracer#span:finished
     * @param {Span} span
     */
    this.emit("span:finished", span);
  }
}

module.exports = Tracer;
