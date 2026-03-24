"use strict";

/**
 * @file defaults.js
 * @description Single source of truth for all webrtc-rooms v2 default values.
 *
 * Every configurable value in the system has a default here. No default
 * should be hard-coded anywhere else in the codebase — always reference
 * this file so defaults can be audited and changed in one place.
 *
 * @module webrtc-rooms/config/defaults
 */

module.exports = Object.freeze({
  // ---------------------------------------------------------------------------
  // Server
  // ---------------------------------------------------------------------------

  server: {
    /** TCP port the WebSocket server listens on when no http.Server is provided. */
    port: 3000,

    /** Maximum peers allowed per room across all regions. */
    maxPeersPerRoom: 50,

    /** Create rooms automatically on first peer join. */
    autoCreateRooms: true,

    /** Destroy rooms automatically when the last peer leaves. */
    autoDestroyRooms: true,

    /**
     * Milliseconds a disconnected peer's slot is held warm before eviction.
     * Set to 0 to disable reconnection entirely.
     */
    reconnectTtl: 15_000,

    /**
     * WebSocket ping interval in ms. Keeps NAT sessions alive and detects
     * dead connections faster than TCP timeout alone.
     */
    pingInterval: 25_000,

    /** Maximum size in bytes of an inbound WebSocket message. */
    maxMessageSize: 65_536, // 64 KiB
  },

  // ---------------------------------------------------------------------------
  // Region / multi-region
  // ---------------------------------------------------------------------------

  region: {
    /**
     * Identifier for the local region. Used in Redis keys and routing.
     * Override via WEBRTC_ROOMS_REGION env var or config.
     */
    id: process.env.WEBRTC_ROOMS_REGION || "default",

    /**
     * Whether this node participates in multi-region SFU orchestration.
     * Requires RedisAdapter to be attached.
     */
    multiRegion: false,

    /**
     * Milliseconds between region heartbeat publishes to Redis.
     * Other regions use this to detect node failures.
     */
    heartbeatInterval: 5_000,

    /**
     * Milliseconds before a region is considered dead if no heartbeat received.
     */
    heartbeatTtl: 15_000,
  },

  // ---------------------------------------------------------------------------
  // SFU
  // ---------------------------------------------------------------------------

  sfu: {
    /**
     * Default SFU adapter to use. 'mediasoup' | 'livekit' | null (P2P only).
     */
    adapter: null,

    /** IP the SFU listens on for RTP/RTCP. */
    listenIp: "0.0.0.0",

    /** Public IP announced to ICE candidates. Required behind NAT. */
    announcedIp: null,

    /** UDP port range for RTP/RTCP. */
    rtcMinPort: 10000,
    rtcMaxPort: 10200,

    /**
     * Number of mediasoup workers to spawn.
     * Defaults to number of logical CPU cores.
     */
    numWorkers: null, // null = auto (os.cpus().length)

    /**
     * Milliseconds before a failed SFU region is retried for routing.
     */
    failoverCooldownMs: 30_000,

    /**
     * Minimum number of healthy SFU regions required before accepting
     * new room creation. 1 = single-region acceptable.
     */
    minHealthyRegions: 1,
  },

  // ---------------------------------------------------------------------------
  // Security
  // ---------------------------------------------------------------------------

  security: {
    /**
     * Algorithm used to sign room policies and admin tokens.
     * HS256 is the minimum; RS256 recommended for production.
     */
    jwtAlgorithm: "HS256",

    /** Default room policy token TTL in seconds. */
    roomPolicyTtl: 3600, // 1 hour

    /** Default admin token TTL in seconds. */
    adminTokenTtl: 86_400, // 24 hours

    /**
     * Whether to validate room policy signatures on every join.
     * Can be disabled for trusted internal networks.
     */
    enforceRoomPolicies: false,

    /** Scopes available for admin tokens. */
    adminScopes: [
      "rooms:read",
      "rooms:write",
      "peers:read",
      "peers:write",
      "metrics:read",
    ],
  },

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  rateLimit: {
    /** New WebSocket connections per IP per minute before auto-ban. */
    maxConnPerMin: 20,

    /** Signaling messages per peer per second. */
    maxMsgPerSec: 30,

    /** Signaling messages per peer per minute. */
    maxMsgPerMin: 200,

    /** New join requests per room per minute (anti-churn). */
    maxJoinsPerRoomPerMin: 60,

    /** New join requests per tenant per minute. */
    maxJoinsPerTenantPerMin: 500,

    /** How long a banned IP remains banned. */
    banDurationMs: 60_000,

    /** IPs that bypass all rate limiting. */
    whitelist: ["127.0.0.1", "::1"],
  },

  // ---------------------------------------------------------------------------
  // Observability
  // ---------------------------------------------------------------------------

  observability: {
    /** Enable built-in metrics collection. */
    metrics: true,

    /** Enable distributed tracing. */
    tracing: false,

    /** Metrics flush interval in ms. */
    metricsFlushInterval: 10_000,

    /**
     * Latency percentiles to track for join, reconnect, and message delivery.
     */
    latencyPercentiles: [50, 90, 95, 99],

    /** Maximum number of data points kept in memory per metric series. */
    maxDataPoints: 1000,
  },

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  recording: {
    /** Default output directory for recordings. */
    outputDir: "./recordings",

    /** Default container format. */
    format: "webm",

    /** Default video bitrate in kbps. */
    videoKbps: 800,

    /** Default audio bitrate in kbps. */
    audioKbps: 128,

    /**
     * Milliseconds to wait for ffmpeg to flush after stdin close
     * before sending SIGKILL.
     */
    flushTimeoutMs: 5_000,
  },

  // ---------------------------------------------------------------------------
  // Compliance
  // ---------------------------------------------------------------------------

  compliance: {
    /** Default data retention period in days. 0 = retain indefinitely. */
    retentionDays: 0,

    /** Default data residency region. null = no restriction. */
    residencyRegion: null,

    /** Enable audit logging. */
    auditLog: false,

    /** Audit log format. 'json' | 'structured' */
    auditLogFormat: "json",
  },

  // ---------------------------------------------------------------------------
  // Feature flags
  // ---------------------------------------------------------------------------

  features: {
    /** Enable adaptive bitrate control. Requires SFU adapter. */
    adaptiveBitrate: false,

    /** Enable multi-region SFU orchestration. */
    multiRegionSfu: false,

    /** Enable end-to-end encryption key exchange. */
    e2eKeyExchange: false,

    /** Enable moderation event bus. */
    moderationBus: false,

    /** Enable real-time QoS dashboard data. */
    qosDashboard: false,

    /** Enable consent flow enforcement. */
    consentFlow: false,
  },
});
