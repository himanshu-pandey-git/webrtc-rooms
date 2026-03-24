"use strict";

/**
 * @file ConfigManager.js
 * @description Unified configuration system for webrtc-rooms v2.
 *
 * Merges configuration from four sources in priority order (highest wins):
 *
 * 1. Runtime overrides   — passed programmatically via `set(path, value)`.
 * 2. User config         — supplied to `createServer(options)`.
 * 3. Environment vars    — `WEBRTC_ROOMS_*` prefixed variables.
 * 4. Defaults            — `config/defaults.js`.
 *
 * Validates the merged config against `config/schema.js` at startup and
 * throws a descriptive error listing every invalid field rather than
 * failing at the first one.
 *
 * @module webrtc-rooms/config/ConfigManager
 *
 * @example
 * const config = new ConfigManager({
 *   server: { port: 4000, maxPeersPerRoom: 100 },
 *   features: { adaptiveBitrate: true },
 * });
 *
 * config.get('server.port');      // → 4000
 * config.get('server.pingInterval'); // → 25000 (default)
 * config.set('server.maxPeersPerRoom', 200);
 */

const { EventEmitter } = require("events");
const defaults = require("./defaults");
const { SCHEMA, validateSection } = require("./schema");
const FeatureFlags = require("./FeatureFlags");

/**
 * Environment variable prefix.
 * @constant {string}
 */
const ENV_PREFIX = "WEBRTC_ROOMS_";

/**
 * Maps environment variable suffixes to config dot-paths.
 * Extend this map to expose more options via env vars.
 *
 * @type {Map<string, string>}
 */
const ENV_MAP = new Map([
  ["PORT", "server.port"],
  ["MAX_PEERS", "server.maxPeersPerRoom"],
  ["RECONNECT_TTL", "server.reconnectTtl"],
  ["REGION", "region.id"],
  ["MULTI_REGION", "region.multiRegion"],
  ["SFU_ADAPTER", "sfu.adapter"],
  ["SFU_LISTEN_IP", "sfu.listenIp"],
  ["SFU_ANNOUNCED_IP", "sfu.announcedIp"],
  ["JWT_SECRET", "security.jwtSecret"],
  ["JWT_ALGORITHM", "security.jwtAlgorithm"],
  ["ENFORCE_POLICIES", "security.enforceRoomPolicies"],
  ["AUDIT_LOG", "compliance.auditLog"],
  ["RETENTION_DAYS", "compliance.retentionDays"],
  ["METRICS", "observability.metrics"],
  ["TRACING", "observability.tracing"],
]);

class ConfigManager extends EventEmitter {
  /**
   * @param {object} [userConfig={}] - User-supplied configuration.
   */
  constructor(userConfig = {}) {
    super();

    /** @private */
    this._config = this._merge(defaults, this._fromEnv(), userConfig);

    /** @private @type {Map<string, *>} */
    this._overrides = new Map();

    const errors = validateSection(this._config, SCHEMA);
    if (errors.length > 0) {
      throw new Error(
        `[ConfigManager] Invalid configuration:\n${errors.map((e) => `  • ${e}`).join("\n")}`,
      );
    }

    /**
     * Feature flag subsystem, initialised with global defaults from config.
     * @type {FeatureFlags}
     */
    this.flags = new FeatureFlags(this._config.features ?? {});
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Gets a config value by dot-notation path.
   *
   * @param {string} path - e.g. `'server.port'` or `'sfu.rtcMinPort'`.
   * @param {*} [fallback] - Returned if the path does not exist.
   * @returns {*}
   *
   * @example
   * config.get('server.port');      // → 3000
   * config.get('missing.key', 42); // → 42
   */
  get(path, fallback = undefined) {
    // Runtime overrides take highest priority.
    if (this._overrides.has(path)) return this._overrides.get(path);

    return this._resolvePath(this._config, path, fallback);
  }

  /**
   * Returns the full merged config object (snapshot, not live reference).
   *
   * @returns {object}
   */
  all() {
    return JSON.parse(JSON.stringify(this._config));
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Sets a runtime config override by dot-notation path.
   * Fires a `config:changed` event.
   *
   * @param {string} path
   * @param {*}      value
   */
  set(path, value) {
    const previous = this.get(path);
    this._overrides.set(path, value);

    /**
     * @event ConfigManager#config:changed
     * @param {{ path: string, value: *, previous: * }}
     */
    this.emit("config:changed", { path, value, previous });
  }

  /**
   * Removes a runtime override, reverting to the merged config value.
   *
   * @param {string} path
   */
  unset(path) {
    this._overrides.delete(path);
    this.emit("config:changed", {
      path,
      value: this.get(path),
      previous: undefined,
    });
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Deep-merges multiple config objects. Later objects win over earlier ones.
   * Only plain objects are merged — all other value types are replaced.
   *
   * @private
   * @param {...object} sources
   * @returns {object}
   */
  _merge(...sources) {
    const result = {};
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      for (const [key, value] of Object.entries(source)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          result[key] = this._merge(result[key] ?? {}, value);
        } else if (value !== undefined) {
          result[key] = value;
        }
      }
    }
    return result;
  }

  /**
   * Reads all `WEBRTC_ROOMS_*` environment variables and maps them to
   * dot-notation config paths.
   *
   * @private
   * @returns {object}
   */
  _fromEnv() {
    const env = {};

    for (const [suffix, path] of ENV_MAP) {
      const envKey = `${ENV_PREFIX}${suffix}`;
      const raw = process.env[envKey];
      if (raw === undefined) continue;

      // Coerce booleans and numbers.
      let value;
      if (raw === "true") value = true;
      else if (raw === "false") value = false;
      else if (!isNaN(Number(raw)) && raw.trim() !== "") value = Number(raw);
      else value = raw;

      this._setPath(env, path, value);
    }

    return env;
  }

  /**
   * Resolves a dot-notation path against an object.
   *
   * @private
   * @param {object} obj
   * @param {string} path
   * @param {*}      fallback
   * @returns {*}
   */
  _resolvePath(obj, path, fallback) {
    const parts = path.split(".");
    let current = obj;
    for (const part of parts) {
      if (current === undefined || current === null) return fallback;
      current = current[part];
    }
    return current === undefined ? fallback : current;
  }

  /**
   * Sets a dot-notation path on an object, creating intermediate objects.
   *
   * @private
   * @param {object} obj
   * @param {string} path
   * @param {*}      value
   */
  _setPath(obj, path, value) {
    const parts = path.split(".");
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part] || typeof current[part] !== "object") {
        current[part] = {};
      }
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
  }
}

module.exports = ConfigManager;
