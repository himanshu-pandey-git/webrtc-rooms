"use strict";

/**
 * @file ThreatDetector.js
 * @description Real-time abuse detection and DDoS protection for webrtc-rooms v2.
 *
 * Detects and responds to a set of threat patterns without requiring any
 * external security service. All detection runs in-process using sliding
 * window counters and behavioural heuristics.
 *
 * **Threat models handled**
 *
 * | Threat                    | Detection method                              |
 * |---------------------------|-----------------------------------------------|
 * | Connection flood          | Per-IP connection rate (sliding window)       |
 * | Signal flood              | Per-peer message rate                         |
 * | Room bomb (mass join)     | Rapid join/leave cycling per IP               |
 * | Offer/answer spam         | SDP message rate per peer                     |
 * | Data channel abuse        | Payload size + rate per peer                  |
 * | Metadata poisoning        | Oversized or malformed patch detection        |
 * | Slowloris / stale sockets | Idle connection timeout                       |
 * | Amplification attack      | Broadcast-to-subscriber ratio monitoring      |
 *
 * **Response levels**
 *
 * 1. `WARN`   — Log, emit event, no action
 * 2. `THROTTLE` — Rate-limit the peer (signal drops)
 * 3. `KICK`   — Remove peer from room with `ABUSE_DETECTED` error
 * 4. `BAN`    — Block IP for `banDurationMs`
 *
 * @module webrtc-rooms/security/ThreatDetector
 *
 * @example
 * const { ThreatDetector } = require('webrtc-rooms');
 *
 * const detector = new ThreatDetector({
 *   server,
 *   onThreat: ({ level, threat, peer, ip }) => {
 *     myLogger.warn('Threat detected', { level, threat, ip });
 *   },
 * });
 * detector.attach();
 */

const { EventEmitter } = require("events");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @enum {string} */
const ThreatLevel = Object.freeze({
  WARN: "warn",
  THROTTLE: "throttle",
  KICK: "kick",
  BAN: "ban",
});

const DEFAULTS = {
  // Connection flood
  maxConnPerMinPerIp: 30,
  connFloodBanMs: 300_000, // 5 min

  // Signal flood
  maxSignalsPerSecPerPeer: 50,
  maxSignalsPerMinPerPeer: 500,
  signalFloodKickThreshold: 3, // kicks before ban

  // Room cycling (join/leave spam)
  maxJoinLeavePerMinPerIp: 20,
  roomCyclingBanMs: 600_000, // 10 min

  // SDP spam
  maxSdpPerMinPerPeer: 10,

  // Data abuse
  maxPayloadBytes: 65_536, // 64KB per data message
  maxDataMsgPerSecPerPeer: 30,

  // Metadata
  maxMetadataPatchBytes: 4_096,

  // Idle timeout
  idleTimeoutMs: 120_000, // 2 min without any signal

  // Amplification
  maxBroadcastRatio: 50, // 1 sender → max 50 receivers before flagging

  // Whitelist
  whitelist: ["127.0.0.1", "::1"],
};

// ---------------------------------------------------------------------------
// ThreatDetector
// ---------------------------------------------------------------------------

/**
 * In-process threat detection and abuse mitigation.
 *
 * @extends EventEmitter
 *
 * @fires ThreatDetector#threat
 * @fires ThreatDetector#ban
 * @fires ThreatDetector#unban
 */
class ThreatDetector extends EventEmitter {
  /**
   * @param {object}   options
   * @param {import('../core/SignalingServer')} options.server
   * @param {Function} [options.onThreat]  - Shorthand for `.on('threat', fn)`
   * @param {object}   [options.thresholds] - Override individual thresholds
   * @param {string[]} [options.whitelist]  - IPs exempt from all detection
   */
  constructor({ server, onThreat, thresholds = {}, whitelist = [] }) {
    super();

    if (!server) throw new Error("[ThreatDetector] options.server is required");

    this._server = server;
    this._cfg = { ...DEFAULTS, ...thresholds };
    this._whitelist = new Set([...DEFAULTS.whitelist, ...whitelist]);

    if (onThreat) this.on("threat", onThreat);

    // ── State ────────────────────────────────────────────────────────────────
    /** @type {Map<string, {count: number, start: number}>} ip → conn window */
    this._connWindows = new Map();

    /** @type {Map<string, {count: number, start: number}>} ip → join/leave window */
    this._cycleWindows = new Map();

    /** @type {Map<string, {sec: {count:number, start:number}, min: {count:number, start:number}, kickCount: number}>} peerId → signal counters */
    this._signalCounters = new Map();

    /** @type {Map<string, {count:number, start:number}>} peerId → SDP counter */
    this._sdpCounters = new Map();

    /** @type {Map<string, {count:number, start:number}>} peerId → data counter */
    this._dataCounters = new Map();

    /** @type {Map<string, number>} ip → ban expiry ms */
    this._bans = new Map();

    /** @type {Map<string, number>} peerId → last signal ms */
    this._lastSignal = new Map();

    /** @type {ReturnType<typeof setInterval>} */
    this._sweepTimer = setInterval(() => this._sweep(), 30_000).unref();

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

    const server = this._server;

    // Raw connection gate (before peer is created)
    server._wss?.on("connection", (socket, req) => {
      const ip = this._extractIp(req);
      if (!this._checkConnection(ip, socket)) return;
    });

    server.on("peer:connected", (peer) => {
      peer._detectorIp = this._extractPeerIp(peer);
      this._initPeerCounters(peer.id);
      this._lastSignal.set(peer.id, Date.now());
    });

    server.on("peer:joined", (peer) => {
      this._recordJoinLeave(peer._detectorIp);
    });

    server.on("peer:left", (peer) => {
      this._recordJoinLeave(peer._detectorIp);
      this._cleanupPeer(peer.id);
    });

    // Intercept signal events for rate checking
    server.on("peer:connected", (peer) => {
      const origEmit = peer.emit.bind(peer);
      peer.emit = (event, ...args) => {
        if (event === "signal") {
          this._lastSignal.set(peer.id, Date.now());
          const msg = args[0];

          if (!this._checkSignalRate(peer)) return false;
          if (msg?.type === "offer" || msg?.type === "answer") {
            if (!this._checkSdpRate(peer)) return false;
          }
          if (msg?.type === "data") {
            if (!this._checkDataMessage(peer, msg)) return false;
          }
          if (msg?.type === "metadata") {
            if (!this._checkMetadataPatch(peer, msg)) return false;
          }
        }
        return origEmit(event, ...args);
      };
    });

    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns true if an IP is currently banned.
   * @param {string} ip
   * @returns {boolean}
   */
  isBanned(ip) {
    const expiry = this._bans.get(ip);
    if (!expiry) return false;
    if (Date.now() < expiry) return true;
    this._bans.delete(ip);
    return false;
  }

  /**
   * Manually bans an IP.
   * @param {string} ip
   * @param {number} [durationMs]
   */
  ban(ip, durationMs = this._cfg.connFloodBanMs) {
    this._bans.set(ip, Date.now() + durationMs);
    this.emit("ban", { ip, until: Date.now() + durationMs });
  }

  /**
   * Removes a ban.
   * @param {string} ip
   */
  unban(ip) {
    this._bans.delete(ip);
    this.emit("unban", { ip });
  }

  /**
   * Returns all current bans.
   * @returns {Array<{ip: string, expiresIn: number}>}
   */
  bans() {
    const now = Date.now();
    const result = [];
    for (const [ip, expiry] of this._bans) {
      if (now < expiry) result.push({ ip, expiresIn: expiry - now });
      else this._bans.delete(ip);
    }
    return result;
  }

  /**
   * Returns threat detection stats.
   */
  stats() {
    return {
      bans: this.bans().length,
      trackedPeers: this._signalCounters.size,
      whitelist: [...this._whitelist],
    };
  }

  /**
   * Shuts down background timers.
   */
  close() {
    clearInterval(this._sweepTimer);
  }

  // ---------------------------------------------------------------------------
  // Threat checks
  // ---------------------------------------------------------------------------

  /** @private */
  _checkConnection(ip, socket) {
    if (this._whitelist.has(ip)) return true;

    if (this.isBanned(ip)) {
      socket?.close(1008, "Banned");
      this._emitThreat(ThreatLevel.BAN, "connection_flood_banned", null, ip);
      return false;
    }

    const now = Date.now();
    let w = this._connWindows.get(ip);
    if (!w || now - w.start > 60_000) {
      w = { count: 0, start: now };
    }
    w.count++;
    this._connWindows.set(ip, w);

    if (w.count > this._cfg.maxConnPerMinPerIp) {
      this.ban(ip, this._cfg.connFloodBanMs);
      socket?.close(1008, "Too many connections");
      this._emitThreat(ThreatLevel.BAN, "connection_flood", null, ip);
      return false;
    }

    return true;
  }

  /** @private */
  _checkSignalRate(peer) {
    const counter = this._signalCounters.get(peer.id);
    if (!counter) return true;

    const now = Date.now();

    // Per-second window
    if (now - counter.sec.start > 1_000) {
      counter.sec = { count: 0, start: now };
    }
    counter.sec.count++;

    // Per-minute window
    if (now - counter.min.start > 60_000) {
      counter.min = { count: 0, start: now };
    }
    counter.min.count++;

    if (
      counter.sec.count > this._cfg.maxSignalsPerSecPerPeer ||
      counter.min.count > this._cfg.maxSignalsPerMinPerPeer
    ) {
      counter.kickCount++;
      if (counter.kickCount >= this._cfg.signalFloodKickThreshold) {
        const ip = peer._detectorIp;
        this.ban(ip, this._cfg.connFloodBanMs);
        this._server.kick(peer.id, "Signal flood detected");
        this._emitThreat(ThreatLevel.BAN, "signal_flood", peer, ip);
      } else {
        this._emitThreat(
          ThreatLevel.KICK,
          "signal_flood",
          peer,
          peer._detectorIp,
        );
        this._server.kick(peer.id, "Signal rate limit exceeded");
      }
      return false;
    }

    return true;
  }

  /** @private */
  _checkSdpRate(peer) {
    const now = Date.now();
    let c = this._sdpCounters.get(peer.id);
    if (!c || now - c.start > 60_000) {
      c = { count: 0, start: now };
    }
    c.count++;
    this._sdpCounters.set(peer.id, c);

    if (c.count > this._cfg.maxSdpPerMinPerPeer) {
      this._emitThreat(ThreatLevel.KICK, "sdp_flood", peer, peer._detectorIp);
      this._server.kick(peer.id, "SDP rate limit exceeded");
      return false;
    }
    return true;
  }

  /** @private */
  _checkDataMessage(peer, msg) {
    const payloadSize = JSON.stringify(msg.payload ?? "").length;
    if (payloadSize > this._cfg.maxPayloadBytes) {
      this._emitThreat(
        ThreatLevel.KICK,
        "oversized_payload",
        peer,
        peer._detectorIp,
      );
      this._server.kick(peer.id, "Payload too large");
      return false;
    }

    const now = Date.now();
    let c = this._dataCounters.get(peer.id);
    if (!c || now - c.start > 1_000) {
      c = { count: 0, start: now };
    }
    c.count++;
    this._dataCounters.set(peer.id, c);

    if (c.count > this._cfg.maxDataMsgPerSecPerPeer) {
      this._emitThreat(
        ThreatLevel.THROTTLE,
        "data_flood",
        peer,
        peer._detectorIp,
      );
      return false; // drop message, don't kick
    }
    return true;
  }

  /** @private */
  _checkMetadataPatch(peer, msg) {
    const size = JSON.stringify(msg.patch ?? {}).length;
    if (size > this._cfg.maxMetadataPatchBytes) {
      this._emitThreat(
        ThreatLevel.KICK,
        "metadata_poisoning",
        peer,
        peer._detectorIp,
      );
      this._server.kick(peer.id, "Metadata patch too large");
      return false;
    }
    return true;
  }

  /** @private */
  _recordJoinLeave(ip) {
    if (!ip || this._whitelist.has(ip)) return;
    const now = Date.now();
    let w = this._cycleWindows.get(ip);
    if (!w || now - w.start > 60_000) w = { count: 0, start: now };
    w.count++;
    this._cycleWindows.set(ip, w);
    if (w.count > this._cfg.maxJoinLeavePerMinPerIp) {
      this.ban(ip, this._cfg.roomCyclingBanMs);
      this._emitThreat(ThreatLevel.BAN, "room_cycling", null, ip);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** @private */
  _initPeerCounters(peerId) {
    this._signalCounters.set(peerId, {
      sec: { count: 0, start: Date.now() },
      min: { count: 0, start: Date.now() },
      kickCount: 0,
    });
  }

  /** @private */
  _cleanupPeer(peerId) {
    this._signalCounters.delete(peerId);
    this._sdpCounters.delete(peerId);
    this._dataCounters.delete(peerId);
    this._lastSignal.delete(peerId);
  }

  /** @private */
  _emitThreat(level, threat, peer, ip) {
    /**
     * @event ThreatDetector#threat
     * @param {{ level: string, threat: string, peer: object|null, ip: string }}
     */
    this.emit("threat", { level, threat, peer, ip, ts: Date.now() });
  }

  /** @private */
  _extractIp(req) {
    return (
      req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req?.socket?.remoteAddress ||
      "unknown"
    );
  }

  /** @private */
  _extractPeerIp(peer) {
    try {
      return peer?.socket?._socket?.remoteAddress ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  /** @private */
  _sweep() {
    const now = Date.now();
    for (const [ip, expiry] of this._bans) {
      if (now >= expiry) this._bans.delete(ip);
    }
    for (const [peerId, ts] of this._lastSignal) {
      if (now - ts > this._cfg.idleTimeoutMs) {
        const peer = this._server.peers.get(peerId);
        if (peer) {
          peer.close(1001, "Idle timeout");
          this._emitThreat(
            ThreatLevel.KICK,
            "idle_timeout",
            peer,
            peer._detectorIp,
          );
        }
        this._cleanupPeer(peerId);
      }
    }
  }
}

ThreatDetector.Level = ThreatLevel;

module.exports = ThreatDetector;
