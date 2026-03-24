"use strict";

/**
 * @file schema.js
 * @description Validation schema for all webrtc-rooms v2 configuration options.
 *
 * Each entry defines the type, allowed values, range, and whether the field
 * is required. The ConfigManager uses this to validate user-supplied config
 * at startup, producing clear error messages instead of cryptic runtime failures.
 *
 * @module webrtc-rooms/config/schema
 */

/**
 * Validates a single value against a field descriptor.
 *
 * @param {string} path     - Dot-notation path for error messages (e.g. 'server.port').
 * @param {*}      value    - The value to validate.
 * @param {object} desc     - Field descriptor from SCHEMA.
 * @returns {string[]} Array of error messages, empty if valid.
 */
function validateField(path, value, desc) {
  const errors = [];

  if (value === undefined || value === null) {
    if (desc.required) errors.push(`"${path}" is required`);
    return errors;
  }

  if (desc.type && typeof value !== desc.type) {
    errors.push(`"${path}" must be of type ${desc.type}, got ${typeof value}`);
    return errors;
  }

  if (desc.oneOf && !desc.oneOf.includes(value)) {
    errors.push(
      `"${path}" must be one of [${desc.oneOf.map((v) => JSON.stringify(v)).join(", ")}], got ${JSON.stringify(value)}`,
    );
  }

  if (desc.min !== undefined && value < desc.min) {
    errors.push(`"${path}" must be >= ${desc.min}, got ${value}`);
  }

  if (desc.max !== undefined && value > desc.max) {
    errors.push(`"${path}" must be <= ${desc.max}, got ${value}`);
  }

  if (desc.pattern && !desc.pattern.test(value)) {
    errors.push(`"${path}" does not match required pattern ${desc.pattern}`);
  }

  return errors;
}

/**
 * Recursively validates a config object against the schema.
 *
 * @param {object} config  - User-supplied config section.
 * @param {object} schema  - Schema section.
 * @param {string} prefix  - Dot-notation prefix for error paths.
 * @returns {string[]} All validation errors found.
 */
function validateSection(config, schema, prefix = "") {
  const errors = [];
  for (const [key, desc] of Object.entries(schema)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = config?.[key];

    if (desc._type === "section") {
      errors.push(...validateSection(value, desc.fields, path));
    } else {
      errors.push(...validateField(path, value, desc));
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Schema definition
// ---------------------------------------------------------------------------

const SCHEMA = {
  server: {
    _type: "section",
    fields: {
      port: { type: "number", min: 1, max: 65535 },
      maxPeersPerRoom: { type: "number", min: 1, max: 10000 },
      autoCreateRooms: { type: "boolean" },
      autoDestroyRooms: { type: "boolean" },
      reconnectTtl: { type: "number", min: 0 },
      pingInterval: { type: "number", min: 1000 },
      maxMessageSize: { type: "number", min: 1024, max: 10_485_760 }, // 1 KiB – 10 MiB
    },
  },

  region: {
    _type: "section",
    fields: {
      id: { type: "string", pattern: /^[a-z0-9-]{1,64}$/ },
      multiRegion: { type: "boolean" },
      heartbeatInterval: { type: "number", min: 1000 },
      heartbeatTtl: { type: "number", min: 1000 },
    },
  },

  sfu: {
    _type: "section",
    fields: {
      adapter: { oneOf: ["mediasoup", "livekit", null] },
      listenIp: { type: "string" },
      rtcMinPort: { type: "number", min: 1024, max: 65535 },
      rtcMaxPort: { type: "number", min: 1024, max: 65535 },
      failoverCooldownMs: { type: "number", min: 0 },
      minHealthyRegions: { type: "number", min: 1 },
    },
  },

  security: {
    _type: "section",
    fields: {
      jwtAlgorithm: {
        type: "string",
        oneOf: [
          "HS256",
          "HS384",
          "HS512",
          "RS256",
          "RS384",
          "RS512",
          "ES256",
          "ES384",
          "ES512",
        ],
      },
      roomPolicyTtl: { type: "number", min: 60 },
      adminTokenTtl: { type: "number", min: 60 },
      enforceRoomPolicies: { type: "boolean" },
    },
  },

  rateLimit: {
    _type: "section",
    fields: {
      maxConnPerMin: { type: "number", min: 1 },
      maxMsgPerSec: { type: "number", min: 1 },
      maxMsgPerMin: { type: "number", min: 1 },
      maxJoinsPerRoomPerMin: { type: "number", min: 1 },
      maxJoinsPerTenantPerMin: { type: "number", min: 1 },
      banDurationMs: { type: "number", min: 0 },
    },
  },

  observability: {
    _type: "section",
    fields: {
      metrics: { type: "boolean" },
      tracing: { type: "boolean" },
      metricsFlushInterval: { type: "number", min: 1000 },
      maxDataPoints: { type: "number", min: 10, max: 100_000 },
    },
  },

  recording: {
    _type: "section",
    fields: {
      outputDir: { type: "string" },
      format: { type: "string", oneOf: ["webm", "mp4"] },
      videoKbps: { type: "number", min: 100, max: 50_000 },
      audioKbps: { type: "number", min: 8, max: 512 },
      flushTimeoutMs: { type: "number", min: 1000 },
    },
  },

  compliance: {
    _type: "section",
    fields: {
      retentionDays: { type: "number", min: 0 },
      auditLog: { type: "boolean" },
      auditLogFormat: { type: "string", oneOf: ["json", "structured"] },
    },
  },
};

module.exports = { SCHEMA, validateSection, validateField };
