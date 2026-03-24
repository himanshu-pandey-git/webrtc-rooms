"use strict";

/**
 * @file index.js
 * @description Public entry point for webrtc-rooms v2.
 *
 * All classes are exported individually so consumers can tree-shake or
 * import only what they need.
 *
 * @example
 * const {
 *   createServer,
 *   NativeSFUEngine, SFUOrchestrator,
 *   PolicyEngine, SessionManager,
 *   RedisAdapter, RoomPersistence,
 *   MetricsCollector, Tracer,
 * } = require('webrtc-rooms');
 */

// ── Core ──────────────────────────────────────────────────────────────────────
const SignalingServer = require("./SignalingServer");
const Room = require("./Room");
const Peer = require("./Peer");

// ── Session ───────────────────────────────────────────────────────────────────
const SessionManager = require("./core/SessionManager");

// ── Config ────────────────────────────────────────────────────────────────────
const ConfigManager = require("./config/ConfigManager");
const FeatureFlags = require("./config/FeatureFlags");

// ── SFU ───────────────────────────────────────────────────────────────────────
const NativeSFUEngine = require("./sfu/NativeSFUEngine");
const SFUOrchestrator = require("./sfu/SFUOrchestrator");
const AdaptiveBitrateController = require("./sfu/AdaptiveBitrateController");
const RegionRouter = require("./sfu/RegionRouter");
const SFUInterface = require("./sfu/SFUInterface");

// ── Auth ──────────────────────────────────────────────────────────────────────
const PolicyEngine = require("./auth/PolicyEngine");
const RoomToken = require("./auth/RoomToken");

// ── Security ──────────────────────────────────────────────────────────────────
const ThreatDetector = require("./security/ThreatDetector");
const AuditLogger = require("./security/AuditLogger");

// ── Observability ─────────────────────────────────────────────────────────────
const MetricsCollector = require("./observability/MetricsCollector");
const Tracer = require("./observability/Tracer");
const AlertManager = require("./observability/AlertManager");

// ── Reliability ───────────────────────────────────────────────────────────────
const EventReplay = require("./reliability/EventReplay");
const BackpressureController = require("./reliability/BackpressureController");
const HealthMonitor = require("./reliability/HealthMonitor");

// ── Recording ─────────────────────────────────────────────────────────────────
const RecordingPipeline = require("./recording/RecordingPipeline");

// ── Moderation ────────────────────────────────────────────────────────────────
const ModerationBus = require("./moderation/ModerationBus");

// ── Compliance ────────────────────────────────────────────────────────────────
const RetentionPolicy = require("./compliance/RetentionPolicy");
const DataResidency = require("./compliance/DataResidency");
const ConsentFlow = require("./compliance/ConsentFlow");

// ── Crypto / E2EE ─────────────────────────────────────────────────────────────
const E2EKeyExchange = require("./crypto/E2EKeyExchange");

// ── Adapters (1.x compat + v2) ────────────────────────────────────────────────
const RedisAdapter = require("./adapters/RedisAdapter");
const RoomPersistence = require("./adapters/RoomPersistence");
const RecordingAdapter = require("./adapters/RecordingAdapter"); // deprecated → RecordingPipeline

// ── Middleware ────────────────────────────────────────────────────────────────
const RateLimiter = require("./middleware/RateLimiter");

// ── TURN ──────────────────────────────────────────────────────────────────────
const TurnCredentials = require("./turn/TurnCredentials");

// ── Webhooks ──────────────────────────────────────────────────────────────────
const WebhookDispatcher = require("./webhooks/WebhookDispatcher");

// ── Admin ─────────────────────────────────────────────────────────────────────
const AdminAPI = require("./AdminAPI");
const GovernanceEndpoints = require("./admin/GovernanceEndpoints");

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns a new {@link SignalingServer}.
 * This is the recommended entry point for all applications.
 *
 * @param {object} [options={}]
 * @returns {SignalingServer}
 *
 * @example
 * const { createServer } = require('webrtc-rooms');
 * const server = createServer({ port: 3000 });
 */
function createServer(options = {}) {
  return new SignalingServer(options);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Factory
  createServer,

  // Core
  SignalingServer,
  Room,
  Peer,
  SessionManager,

  // Config
  ConfigManager,
  FeatureFlags,

  // SFU
  NativeSFUEngine,
  SFUOrchestrator,
  AdaptiveBitrateController,
  RegionRouter,
  SFUInterface,

  // Auth
  PolicyEngine,
  RoomToken,

  // Security
  ThreatDetector,
  AuditLogger,

  // Observability
  MetricsCollector,
  Tracer,
  AlertManager,

  // Reliability
  EventReplay,
  BackpressureController,
  HealthMonitor,

  // Recording
  RecordingPipeline,
  RecordingAdapter, // deprecated alias

  // Moderation
  ModerationBus,

  // Compliance
  RetentionPolicy,
  DataResidency,
  ConsentFlow,

  // Crypto / E2EE
  E2EKeyExchange,

  // Adapters
  RedisAdapter,
  RoomPersistence,

  // Middleware
  RateLimiter,

  // TURN
  TurnCredentials,

  // Webhooks
  WebhookDispatcher,

  // Admin
  AdminAPI,
  GovernanceEndpoints,
};
