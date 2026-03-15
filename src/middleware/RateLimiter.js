'use strict';

/**
 * @file RateLimiter.js
 * @description Per-IP connection rate limiting and per-peer signal rate
 * limiting for webrtc-rooms.
 *
 * @module webrtc-rooms/middleware/RateLimiter
 */

const { EventEmitter } = require('events');

/**
 * Protects the signaling server from flooding and abuse with two independent
 * rate-limiting layers:
 *
 * 1. **Connection rate** — limits new WebSocket connections per IP per minute.
 *    IPs that exceed the limit are automatically banned for a configurable
 *    duration.
 *
 * 2. **Signal rate** — limits the number of signaling messages a single peer
 *    can send per second and per minute. Peers that exceed the limit receive
 *    an `error` message; their connection is not closed.
 *
 * @extends EventEmitter
 *
 * @example
 * const { createServer, RateLimiter } = require('webrtc-rooms');
 *
 * const server  = createServer({ port: 3000 });
 * const limiter = new RateLimiter({
 *   maxConnPerMin: 20,
 *   maxMsgPerSec:  30,
 *   whitelist:     ['127.0.0.1'],
 * });
 *
 * limiter.attach(server);
 *
 * limiter.on('ip:banned', ({ ip, until }) => {
 *   console.warn(`Banned ${ip} until ${new Date(until).toISOString()}`);
 * });
 *
 * @fires RateLimiter#connection:blocked
 * @fires RateLimiter#signal:blocked
 * @fires RateLimiter#ip:banned
 */
class RateLimiter extends EventEmitter {
  /**
   * @param {object}   [options={}]
   * @param {number}   [options.maxConnPerMin=30]
   *   Maximum new WebSocket connections per IP per 60-second window.
   *   Exceeding this limit triggers an automatic ban.
   * @param {number}   [options.maxMsgPerSec=30]
   *   Maximum signaling messages a peer may send per second.
   * @param {number}   [options.maxMsgPerMin=300]
   *   Maximum signaling messages a peer may send per minute.
   *   Acts as a sustained-rate guard in addition to the per-second limit.
   * @param {number}   [options.banDurationMs=60000]
   *   How long (in ms) a banned IP is blocked before being re-admitted.
   * @param {string[]} [options.whitelist=[]]
   *   IP addresses that bypass all rate limits.
   */
  constructor({
    maxConnPerMin = 30,
    maxMsgPerSec = 30,
    maxMsgPerMin = 300,
    banDurationMs = 60_000,
    whitelist = [],
  } = {}) {
    super();

    this.maxConnPerMin = maxConnPerMin;
    this.maxMsgPerSec = maxMsgPerSec;
    this.maxMsgPerMin = maxMsgPerMin;
    this.banDurationMs = banDurationMs;

    /**
     * Set of IP addresses that bypass all limits.
     * @type {Set<string>}
     */
    this.whitelist = new Set(whitelist);

    /**
     * Per-IP connection sliding windows: ip → { count, start }.
     * @private
     * @type {Map<string, { count: number, start: number }>}
     */
    this._connWindows = new Map();

    /**
     * Per-peer message sliding windows: peerId → { secCount, secStart, minCount, minStart }.
     * @private
     * @type {Map<string, { secCount: number, secStart: number, minCount: number, minStart: number }>}
     */
    this._msgWindows = new Map();

    /**
     * Banned IPs: ip → ban expiry timestamp.
     * @private
     * @type {Map<string, number>}
     */
    this._banned = new Map();

    // Periodically remove expired entries to prevent unbounded memory growth.
    this._cleanupTimer = setInterval(() => this._cleanup(), 60_000);
  }

  // ---------------------------------------------------------------------------
  // Attachment
  // ---------------------------------------------------------------------------

  /**
   * Attaches this rate limiter to a {@link SignalingServer}.
   *
   * Intercepts new WebSocket connections at the transport level (before any
   * Peer is created) and decorates each Peer's `emit` to count signals.
   *
   * @param {import('../SignalingServer')} server
   * @returns {this} Returns `this` for chaining.
   */
  attach(server) {
    // Intercept connections before they reach the server's own handler.
    server.wss.on('connection', (socket, req) => {
      const ip = this._extractIp(req);

      if (!this._allowConnection(ip)) {
        /**
         * @event RateLimiter#connection:blocked
         * @param {{ ip: string }}
         */
        this.emit('connection:blocked', { ip });
        socket.close(1008, 'Rate limited');
      }
    });

    // Decorate each new Peer to intercept its emitted 'signal' events.
    server.on('peer:connected', (peer) => {
      const originalEmit = peer.emit.bind(peer);

      peer.emit = (event, ...args) => {
        if (event === 'signal') {
          const ip = this._extractPeerIp(peer);

          if (!this._allowSignal(peer.id, ip)) {
            /**
             * @event RateLimiter#signal:blocked
             * @param {{ peerId: string }}
             */
            this.emit('signal:blocked', { peerId: peer.id });
            peer.send({ type: 'error', code: 'RATE_LIMITED', message: 'Too many messages. Slow down.' });
            return false;
          }
        }
        return originalEmit(event, ...args);
      };
    });

    return this;
  }

  // ---------------------------------------------------------------------------
  // Core allow/deny logic
  // ---------------------------------------------------------------------------

  /**
   * Checks whether a new connection from `ip` should be allowed.
   * Bans the IP if the per-minute limit is exceeded.
   *
   * @param {string} ip
   * @returns {boolean}
   */
  _allowConnection(ip) {
    if (this.whitelist.has(ip)) return true;

    const banExpiry = this._banned.get(ip);
    if (banExpiry) {
      if (Date.now() < banExpiry) return false;
      this._banned.delete(ip); // ban expired — clean up and let them through
    }

    const now = Date.now();
    let window = this._connWindows.get(ip);

    if (!window || now - window.start > 60_000) {
      window = { count: 0, start: now };
    }

    window.count++;
    this._connWindows.set(ip, window);

    if (window.count > this.maxConnPerMin) {
      const until = now + this.banDurationMs;
      this._banned.set(ip, until);
      /**
       * @event RateLimiter#ip:banned
       * @param {{ ip: string, until: number }}
       */
      this.emit('ip:banned', { ip, until });
      console.warn(`[RateLimiter] IP ${ip} banned for ${this.banDurationMs / 1000}s (too many connections)`);
      return false;
    }

    return true;
  }

  /**
   * Checks whether a signal message from `peerId` should be allowed.
   *
   * @param {string} peerId
   * @param {string} _ip   - Reserved for future per-IP signal limiting.
   * @returns {boolean}
   */
  _allowSignal(peerId, _ip) {
    const now = Date.now();
    let w = this._msgWindows.get(peerId);

    if (!w) {
      w = { secCount: 0, secStart: now, minCount: 0, minStart: now };
    }

    if (now - w.secStart > 1_000) { w.secCount = 0; w.secStart = now; }
    if (now - w.minStart > 60_000) { w.minCount = 0; w.minStart = now; }

    w.secCount++;
    w.minCount++;
    this._msgWindows.set(peerId, w);

    return w.secCount <= this.maxMsgPerSec && w.minCount <= this.maxMsgPerMin;
  }

  // ---------------------------------------------------------------------------
  // Administration
  // ---------------------------------------------------------------------------

  /**
   * Immediately bans an IP address.
   *
   * @param {string} ip
   * @param {number} [durationMs] - Defaults to `this.banDurationMs`.
   * @returns {void}
   */
  ban(ip, durationMs = this.banDurationMs) {
    const until = Date.now() + durationMs;
    this._banned.set(ip, until);
    this.emit('ip:banned', { ip, until });
  }

  /**
   * Lifts an active ban on an IP address.
   *
   * @param {string} ip
   * @returns {void}
   */
  unban(ip) {
    this._banned.delete(ip);
  }

  /**
   * Returns all currently active bans.
   *
   * @returns {Array<{ ip: string, expiresIn: number }>}
   *   `expiresIn` is in milliseconds from the moment this method is called.
   */
  bans() {
    const now = Date.now();
    return [...this._banned.entries()]
      .filter(([, expiry]) => expiry > now)
      .map(([ip, expiry]) => ({ ip, expiresIn: expiry - now }));
  }

  /**
   * Stops the internal cleanup timer.
   * Call this when the rate limiter is no longer needed to avoid memory leaks.
   *
   * @returns {void}
   */
  destroy() {
    clearInterval(this._cleanupTimer);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Extracts the remote IP from an HTTP upgrade request, honouring common
   * reverse-proxy headers.
   *
   * @private
   * @param {object} req - `http.IncomingMessage` from the WebSocket upgrade.
   * @returns {string}
   */
  _extractIp(req) {
    return (
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      'unknown'
    );
  }

  /**
   * Attempts to read the remote IP from a Peer's underlying socket.
   *
   * @private
   * @param {import('../Peer')} peer
   * @returns {string}
   */
  _extractPeerIp(peer) {
    try {
      return peer.socket._socket?.remoteAddress ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Removes expired entries from all tracking maps.
   * Runs automatically every 60 seconds.
   *
   * @private
   */
  _cleanup() {
    const now = Date.now();

    for (const [ip, expiry] of this._banned) {
      if (expiry <= now) this._banned.delete(ip);
    }

    for (const [ip, window] of this._connWindows) {
      if (now - window.start > 120_000) this._connWindows.delete(ip);
    }

    for (const [peerId, window] of this._msgWindows) {
      if (now - window.minStart > 120_000) this._msgWindows.delete(peerId);
    }
  }
}

module.exports = RateLimiter;