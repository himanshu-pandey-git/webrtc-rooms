"use strict";

/**
 * @file FeatureFlags.js
 * @description Per-room and per-tenant feature flag evaluation.
 *
 * Feature flags in webrtc-rooms v2 work at three levels of granularity,
 * evaluated in priority order:
 *
 * 1. **Room-level override** — set via `room.setFlag(flag, value)`. Highest priority.
 * 2. **Tenant-level override** — set at server startup for a tenantId.
 * 3. **Global default** — from the config system (`config.features`).
 *
 * This allows a platform operator to enable adaptive bitrate globally but
 * disable it for a specific room that has legacy browser constraints, or
 * enable E2EE only for paid tenants without touching global config.
 *
 * @module webrtc-rooms/config/FeatureFlags
 *
 * @example
 * const flags = new FeatureFlags({ adaptiveBitrate: true });
 *
 * flags.setTenantFlag('tenant-123', 'adaptiveBitrate', false);
 * flags.setRoomFlag('room-abc', 'e2eKeyExchange', true);
 *
 * flags.isEnabled('adaptiveBitrate', { roomId: 'room-abc', tenantId: 'tenant-123' });
 * // → true (room override wins — room-abc doesn't have adaptiveBitrate set,
 * //          tenant-123 has it false, but global is true... wait:
 * //          room-abc has e2eKeyExchange=true, adaptiveBitrate not set →
 * //          falls to tenant: false)
 * // → false  (tenant wins over global for adaptiveBitrate)
 */

const { EventEmitter } = require("events");

class FeatureFlags extends EventEmitter {
  /**
   * @param {object} [globalDefaults={}]
   *   Global feature flag defaults. Usually comes from `config.features`.
   */
  constructor(globalDefaults = {}) {
    super();

    /** @private @type {Map<string, boolean>} */
    this._global = new Map(Object.entries(globalDefaults));

    /** @private @type {Map<string, Map<string, boolean>>} tenantId → flag → value */
    this._tenant = new Map();

    /** @private @type {Map<string, Map<string, boolean>>} roomId → flag → value */
    this._room = new Map();
  }

  // ---------------------------------------------------------------------------
  // Global flags
  // ---------------------------------------------------------------------------

  /**
   * Sets a global feature flag default. Applies to all rooms and tenants
   * unless overridden at a lower level.
   *
   * @param {string}  flag
   * @param {boolean} value
   */
  setGlobalFlag(flag, value) {
    this._global.set(flag, Boolean(value));
    this.emit("flag:changed", { level: "global", flag, value });
  }

  // ---------------------------------------------------------------------------
  // Tenant flags
  // ---------------------------------------------------------------------------

  /**
   * Sets a feature flag for a specific tenant.
   *
   * @param {string}  tenantId
   * @param {string}  flag
   * @param {boolean} value
   */
  setTenantFlag(tenantId, flag, value) {
    if (!this._tenant.has(tenantId)) {
      this._tenant.set(tenantId, new Map());
    }
    this._tenant.get(tenantId).set(flag, Boolean(value));
    this.emit("flag:changed", { level: "tenant", tenantId, flag, value });
  }

  /**
   * Removes all flag overrides for a tenant, falling back to global defaults.
   *
   * @param {string} tenantId
   */
  clearTenantFlags(tenantId) {
    this._tenant.delete(tenantId);
    this.emit("flag:cleared", { level: "tenant", tenantId });
  }

  // ---------------------------------------------------------------------------
  // Room flags
  // ---------------------------------------------------------------------------

  /**
   * Sets a feature flag for a specific room.
   *
   * @param {string}  roomId
   * @param {string}  flag
   * @param {boolean} value
   */
  setRoomFlag(roomId, flag, value) {
    if (!this._room.has(roomId)) {
      this._room.set(roomId, new Map());
    }
    this._room.get(roomId).set(flag, Boolean(value));
    this.emit("flag:changed", { level: "room", roomId, flag, value });
  }

  /**
   * Removes all flag overrides for a room (called automatically on room destroy).
   *
   * @param {string} roomId
   */
  clearRoomFlags(roomId) {
    this._room.delete(roomId);
    this.emit("flag:cleared", { level: "room", roomId });
  }

  // ---------------------------------------------------------------------------
  // Evaluation
  // ---------------------------------------------------------------------------

  /**
   * Evaluates a feature flag for a given context.
   *
   * Evaluation order: room → tenant → global → false.
   *
   * @param {string} flag
   * @param {object} [context={}]
   * @param {string} [context.roomId]
   * @param {string} [context.tenantId]
   * @returns {boolean}
   */
  isEnabled(flag, { roomId, tenantId } = {}) {
    // 1. Room-level override
    if (roomId && this._room.has(roomId)) {
      const roomFlags = this._room.get(roomId);
      if (roomFlags.has(flag)) return roomFlags.get(flag);
    }

    // 2. Tenant-level override
    if (tenantId && this._tenant.has(tenantId)) {
      const tenantFlags = this._tenant.get(tenantId);
      if (tenantFlags.has(flag)) return tenantFlags.get(flag);
    }

    // 3. Global default
    if (this._global.has(flag)) return this._global.get(flag);

    // 4. Safe default: disabled
    return false;
  }

  /**
   * Returns a snapshot of all flags resolved for a given context.
   * Useful for debugging and admin tooling.
   *
   * @param {object} [context={}]
   * @param {string} [context.roomId]
   * @param {string} [context.tenantId]
   * @returns {object}
   */
  resolve(context = {}) {
    // Collect all known flag names across all levels.
    const allFlags = new Set([
      ...this._global.keys(),
      ...(context.tenantId
        ? (this._tenant.get(context.tenantId)?.keys() ?? [])
        : []),
      ...(context.roomId ? (this._room.get(context.roomId)?.keys() ?? []) : []),
    ]);

    const result = {};
    for (const flag of allFlags) {
      result[flag] = this.isEnabled(flag, context);
    }
    return result;
  }

  /**
   * Returns a serialisable stats snapshot for admin tooling.
   *
   * @returns {{ globalFlags: object, tenantOverrides: number, roomOverrides: number }}
   */
  stats() {
    return {
      globalFlags: Object.fromEntries(this._global),
      tenantOverrides: this._tenant.size,
      roomOverrides: this._room.size,
    };
  }
}

module.exports = FeatureFlags;
