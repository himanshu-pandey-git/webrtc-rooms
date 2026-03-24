"use strict";

/**
 * @file WebhookDispatcher.js
 * @description Signed webhook dispatcher for webrtc-rooms server events.
 *
 * Fires HTTP POST requests to configured endpoints when room and peer
 * lifecycle events occur. Each request is signed with an HMAC-SHA256
 * signature so receiving servers can verify authenticity.
 *
 * **Delivery guarantees**
 *
 * - At-least-once delivery with exponential backoff retry (3 attempts).
 * - Failed deliveries after all retries are written to a dead-letter queue
 *   (in-memory ring buffer or Redis list, configurable).
 * - Delivery is fire-and-forget from the event loop perspective — a slow
 *   endpoint never blocks signaling.
 *
 * **Signature format**
 *
 * Each request includes an `X-Webrtc-Rooms-Signature` header:
 * ```
 * X-Webrtc-Rooms-Signature: sha256=<hex>
 * X-Webrtc-Rooms-Timestamp: <unix-ms>
 * ```
 *
 * Verification (receiver side):
 * ```js
 * const sig = crypto
 *   .createHmac('sha256', webhookSecret)
 *   .update(`${timestamp}.${rawBody}`)
 *   .digest('hex');
 * const trusted = `sha256=${sig}` === req.headers['x-webrtc-rooms-signature'];
 * ```
 *
 * @module webrtc-rooms/webhooks/WebhookDispatcher
 *
 * @example
 * const { WebhookDispatcher } = require('webrtc-rooms');
 *
 * const dispatcher = new WebhookDispatcher({
 *   server,
 *   endpoints: ['https://app.example.com/hooks/webrtc'],
 *   secret:    process.env.WEBHOOK_SECRET,
 *   events:    ['peer.joined', 'peer.left', 'recording.stopped'],
 * });
 *
 * dispatcher.on('delivery:failed', ({ event, endpoint, error }) => {
 *   console.error(`Webhook failed: ${event.type} → ${endpoint}`, error.message);
 * });
 */

const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { EventEmitter } = require("events");

/**
 * All event types the dispatcher can fire.
 * @readonly
 * @enum {string}
 */
const WebhookEvent = Object.freeze({
  ROOM_CREATED: "room.created",
  ROOM_DESTROYED: "room.destroyed",
  PEER_JOINED: "peer.joined",
  PEER_LEFT: "peer.left",
  RECORDING_STARTED: "recording.started",
  RECORDING_STOPPED: "recording.stopped",
});

/**
 * Retry delays in milliseconds for each attempt (exponential backoff).
 * @private
 */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

/**
 * Maximum dead-letter entries kept in the in-memory ring buffer.
 * @private
 */
const DLQ_MAX_SIZE = 500;

/**
 * Dispatches signed webhook events to configured HTTP/HTTPS endpoints.
 *
 * @extends EventEmitter
 *
 * @fires WebhookDispatcher#delivery:success
 * @fires WebhookDispatcher#delivery:failed
 * @fires WebhookDispatcher#delivery:retry
 */
class WebhookDispatcher extends EventEmitter {
  /**
   * @param {object}    options
   * @param {import('../SignalingServer')} options.server
   *   The `SignalingServer` instance to listen to.
   * @param {string[]}  options.endpoints
   *   One or more HTTPS URLs to deliver events to.
   * @param {string}   [options.secret]
   *   Shared secret for HMAC-SHA256 request signing. Strongly recommended
   *   for production. If omitted, requests are sent unsigned.
   * @param {string[]} [options.events]
   *   Allowlist of event types to fire. Defaults to all events.
   *   Valid values: `room.created`, `room.destroyed`, `peer.joined`,
   *   `peer.left`, `recording.started`, `recording.stopped`.
   * @param {number}   [options.timeoutMs=5000]
   *   Per-request timeout in milliseconds.
   * @param {object}   [options.dlq]
   *   Dead-letter queue configuration.
   * @param {object}   [options.dlq.redis]
   *   Redis client for persistent DLQ. If omitted, uses in-memory buffer.
   * @param {string}   [options.dlq.redisKey='webrtc-rooms:dlq']
   *   Redis list key for failed deliveries.
   * @param {number}   [options.dlq.maxSize=500]
   *   Maximum in-memory DLQ entries (ignored when Redis is configured).
   */
  constructor({
    server,
    endpoints,
    secret = null,
    events = Object.values(WebhookEvent),
    timeoutMs = 5_000,
    dlq = {},
  }) {
    super();

    if (!server)
      throw new Error("[WebhookDispatcher] options.server is required");
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      throw new Error(
        "[WebhookDispatcher] options.endpoints must be a non-empty array",
      );
    }

    this._server = server;
    this._endpoints = endpoints;
    this._secret = secret;
    this._events = new Set(events);
    this._timeoutMs = timeoutMs;

    // Dead-letter queue
    this._dlqRedis = dlq.redis ?? null;
    this._dlqKey = dlq.redisKey ?? "webrtc-rooms:dlq";
    this._dlqMaxSize = dlq.maxSize ?? DLQ_MAX_SIZE;
    this._dlqMemory = []; // in-memory ring buffer when Redis is not configured

    this._bindServerEvents();
  }

  // ---------------------------------------------------------------------------
  // Server event bindings
  // ---------------------------------------------------------------------------

  /**
   * @private
   */
  _bindServerEvents() {
    this._server.on("room:created", (room) => {
      this._dispatch(WebhookEvent.ROOM_CREATED, { room: room.toJSON() });
    });

    this._server.on("room:destroyed", (room) => {
      this._dispatch(WebhookEvent.ROOM_DESTROYED, { room: room.toJSON() });
    });

    this._server.on("peer:joined", (peer, room) => {
      this._dispatch(WebhookEvent.PEER_JOINED, {
        peer: peer.toJSON(),
        room: room.toJSON(),
      });
    });

    this._server.on("peer:left", (peer, room) => {
      this._dispatch(WebhookEvent.PEER_LEFT, {
        peer: peer.toJSON(),
        room: room.toJSON(),
      });
    });
  }

  /**
   * Manually fires a `recording.started` webhook event.
   * Call this from your `RecordingAdapter` event handlers.
   *
   * @param {{ peerId: string, roomId: string, path: string }} info
   */
  recordingStarted(info) {
    this._dispatch(WebhookEvent.RECORDING_STARTED, info);
  }

  /**
   * Manually fires a `recording.stopped` webhook event.
   *
   * @param {{ peerId: string, roomId: string, path: string, durationMs: number }} info
   */
  recordingStopped(info) {
    this._dispatch(WebhookEvent.RECORDING_STOPPED, info);
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  /**
   * Builds the event payload and fires it to all configured endpoints.
   * Returns immediately — delivery is asynchronous.
   *
   * @private
   * @param {string} type
   * @param {object} data
   */
  _dispatch(type, data) {
    if (!this._events.has(type)) return;

    const event = {
      id: crypto.randomUUID(),
      type,
      timestamp: Date.now(),
      data,
    };

    for (const endpoint of this._endpoints) {
      this._deliverWithRetry(endpoint, event, 0);
    }
  }

  /**
   * Attempts to deliver an event to a single endpoint.
   * Retries up to {@link RETRY_DELAYS_MS}.length times with exponential backoff.
   *
   * @private
   * @param {string} endpoint
   * @param {object} event
   * @param {number} attempt  - Zero-based attempt index.
   */
  _deliverWithRetry(endpoint, event, attempt) {
    this._post(endpoint, event)
      .then(() => {
        /**
         * @event WebhookDispatcher#delivery:success
         * @param {{ event: object, endpoint: string, attempt: number }}
         */
        this.emit("delivery:success", { event, endpoint, attempt });
      })
      .catch((err) => {
        const nextAttempt = attempt + 1;

        if (nextAttempt <= RETRY_DELAYS_MS.length) {
          /**
           * @event WebhookDispatcher#delivery:retry
           * @param {{ event: object, endpoint: string, attempt: number, error: Error, retryIn: number }}
           */
          this.emit("delivery:retry", {
            event,
            endpoint,
            attempt: nextAttempt,
            error: err,
            retryIn: RETRY_DELAYS_MS[attempt],
          });

          setTimeout(
            () => this._deliverWithRetry(endpoint, event, nextAttempt),
            RETRY_DELAYS_MS[attempt],
          );
        } else {
          /**
           * @event WebhookDispatcher#delivery:failed
           * @param {{ event: object, endpoint: string, attempts: number, error: Error }}
           */
          this.emit("delivery:failed", {
            event,
            endpoint,
            attempts: nextAttempt,
            error: err,
          });

          this._writeToDlq({
            event,
            endpoint,
            failedAt: Date.now(),
            error: err.message,
          });
        }
      });
  }

  /**
   * Sends a single HTTP/HTTPS POST request with the event payload.
   *
   * @private
   * @param {string} endpoint
   * @param {object} event
   * @returns {Promise<void>} Resolves on 2xx, rejects on error or non-2xx.
   */
  _post(endpoint, event) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(event);
      const timestamp = String(event.timestamp);
      const signature = this._sign(timestamp, body);

      const url = new URL(endpoint);
      const transport = url.protocol === "https:" ? https : http;

      const options = {
        method: "POST",
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Webrtc-Rooms-Timestamp": timestamp,
          "User-Agent": "webrtc-rooms-webhook/1.0",
          ...(signature ? { "X-Webrtc-Rooms-Signature": signature } : {}),
        },
        timeout: this._timeoutMs,
      };

      const req = transport.request(options, (res) => {
        // Drain the response body to free the socket.
        res.resume();
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`HTTP ${res.statusCode} from ${endpoint}`));
          }
        });
      });

      req.on("timeout", () => {
        req.destroy(
          new Error(`Webhook timeout after ${this._timeoutMs}ms: ${endpoint}`),
        );
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Computes the HMAC-SHA256 signature for a request.
   * Returns `null` if no secret is configured.
   *
   * The signing input is `<timestamp>.<body>` — including the timestamp
   * prevents replay attacks.
   *
   * @private
   * @param {string} timestamp - Unix milliseconds as a string.
   * @param {string} body      - Raw JSON body string.
   * @returns {string|null}
   */
  _sign(timestamp, body) {
    if (!this._secret) return null;
    const hex = crypto
      .createHmac("sha256", this._secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    return `sha256=${hex}`;
  }

  // ---------------------------------------------------------------------------
  // Dead-letter queue
  // ---------------------------------------------------------------------------

  /**
   * Writes a failed delivery to the dead-letter queue.
   *
   * @private
   * @param {object} entry
   */
  async _writeToDlq(entry) {
    const raw = JSON.stringify(entry);

    if (this._dlqRedis) {
      try {
        await this._dlqRedis.lPush(this._dlqKey, raw);
        // Trim to a reasonable size to prevent unbounded growth.
        await this._dlqRedis.lTrim(this._dlqKey, 0, this._dlqMaxSize - 1);
      } catch (err) {
        console.error(
          "[WebhookDispatcher] Failed to write to Redis DLQ:",
          err.message,
        );
      }
      return;
    }

    // In-memory ring buffer.
    this._dlqMemory.push(entry);
    if (this._dlqMemory.length > this._dlqMaxSize) {
      this._dlqMemory.shift();
    }
  }

  /**
   * Returns all entries currently in the in-memory dead-letter queue.
   * Always returns `[]` when a Redis DLQ is configured (use Redis commands
   * directly to inspect those entries).
   *
   * @returns {object[]}
   */
  deadLetterQueue() {
    return [...this._dlqMemory];
  }

  /**
   * Clears the in-memory dead-letter queue.
   * @returns {void}
   */
  clearDeadLetterQueue() {
    this._dlqMemory = [];
  }
}

WebhookDispatcher.Event = WebhookEvent;

module.exports = WebhookDispatcher;
