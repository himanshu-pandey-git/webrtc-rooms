"use strict";

/**
 * @file SFUOrchestrator.js
 * @description Multi-region SFU coordination, health monitoring, and failover
 * for webrtc-rooms v2.
 *
 * The SFUOrchestrator manages a fleet of SFU adapters across regions. It
 * selects the best SFU for each room based on region affinity, load, and
 * health, and automatically fails rooms over to healthy instances when an
 * SFU becomes unavailable.
 *
 * **Architecture**
 *
 * ```
 * SignalingServer
 *       │
 *       ▼
 * SFUOrchestrator          ← this file
 *   ├── SFUAdapter (us-east-1) ← NativeSFUEngine or any SFUInterface impl
 *   ├── SFUAdapter (eu-west-1)
 *   └── SFUAdapter (ap-south-1)
 * ```
 *
 * **Room assignment**
 *
 * 1. Room created → Orchestrator picks the best regional SFU
 * 2. SFU goes unhealthy → rooms migrate to next-best SFU
 * 3. All SFUs unhealthy → rooms fall back to P2P signaling
 *
 * **Health model**
 *
 * Each registered SFU is pinged every `healthCheckIntervalMs`. Three
 * consecutive failures mark it DEGRADED. Five mark it DOWN. Recovery
 * requires two consecutive successes.
 *
 * @module webrtc-rooms/sfu/SFUOrchestrator
 *
 * @example
 * const { SFUOrchestrator, NativeSFUEngine } = require('webrtc-rooms');
 *
 * const orchestrator = new SFUOrchestrator({ server });
 *
 * orchestrator.register('us-east-1', new NativeSFUEngine({ region: 'us-east-1' }));
 * orchestrator.register('eu-west-1', new NativeSFUEngine({ region: 'eu-west-1' }));
 *
 * await orchestrator.init();
 */

const { EventEmitter } = require("events");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @enum {string} */
const SFUHealth = Object.freeze({
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  DOWN: "down",
});

const DEFAULT_HEALTH_CHECK_INTERVAL = 10_000;
const DEGRADED_THRESHOLD = 3;
const DOWN_THRESHOLD = 5;
const RECOVERY_THRESHOLD = 2;

/**
 * @typedef {object} RegisteredSFU
 * @property {string}      region
 * @property {object}      adapter       - SFUInterface implementation
 * @property {SFUHealth}   health
 * @property {number}      failCount
 * @property {number}      successCount
 * @property {number}      roomCount
 * @property {boolean}     initialized
 */

/**
 * Manages a fleet of SFU adapters with health monitoring and automatic
 * failover across regions.
 *
 * @extends EventEmitter
 *
 * @fires SFUOrchestrator#sfu:registered
 * @fires SFUOrchestrator#sfu:healthy
 * @fires SFUOrchestrator#sfu:degraded
 * @fires SFUOrchestrator#sfu:down
 * @fires SFUOrchestrator#room:assigned
 * @fires SFUOrchestrator#room:migrated
 * @fires SFUOrchestrator#failover
 */
class SFUOrchestrator extends EventEmitter {
  /**
   * @param {object}  options
   * @param {import('../core/SignalingServer')} options.server
   * @param {number}  [options.healthCheckIntervalMs=10000]
   * @param {number}  [options.maxRoomsPerSFU=500]
   *   Soft limit — Orchestrator prefers less-loaded SFUs but exceeds
   *   this limit before triggering failover.
   * @param {string}  [options.defaultRegion='default']
   *   Preferred region when no room-level region is specified.
   * @param {boolean} [options.fallbackToP2P=true]
   *   When true, rooms fall back to P2P signaling if no SFU is healthy.
   */
  constructor({
    server,
    healthCheckIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL,
    maxRoomsPerSFU = 500,
    defaultRegion = "default",
    fallbackToP2P = true,
  }) {
    super();

    if (!server)
      throw new Error("[SFUOrchestrator] options.server is required");

    this._server = server;
    this._healthCheckInterval = healthCheckIntervalMs;
    this._maxRoomsPerSFU = maxRoomsPerSFU;
    this._defaultRegion = defaultRegion;
    this._fallbackToP2P = fallbackToP2P;

    /** @type {Map<string, RegisteredSFU>} region → entry */
    this._sfus = new Map();

    /** @type {Map<string, string>} roomId → region */
    this._roomAssignments = new Map();

    /** @type {ReturnType<typeof setInterval>|null} */
    this._healthTimer = null;

    this._initialized = false;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Registers an SFU adapter for a region.
   * Can be called before or after `init()`.
   *
   * @param {string} region    - Region identifier (e.g. 'us-east-1')
   * @param {object} adapter   - Any object implementing SFUInterface
   * @returns {this}
   */
  register(region, adapter) {
    if (this._sfus.has(region)) {
      throw new Error(
        `[SFUOrchestrator] Region "${region}" is already registered`,
      );
    }

    /** @type {RegisteredSFU} */
    const entry = {
      region,
      adapter,
      health: SFUHealth.HEALTHY,
      failCount: 0,
      successCount: 0,
      roomCount: 0,
      initialized: false,
    };

    this._sfus.set(region, entry);

    /**
     * @event SFUOrchestrator#sfu:registered
     * @param {string} region
     */
    this.emit("sfu:registered", region);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialises all registered SFU adapters and starts health checking.
   *
   * @returns {Promise<void>}
   */
  async init() {
    const inits = [...this._sfus.entries()].map(async ([region, entry]) => {
      try {
        await entry.adapter.init();
        entry.initialized = true;
        entry.adapter.attach(this._server);
        console.log(`[SFUOrchestrator] SFU "${region}" initialized`);
      } catch (err) {
        console.error(
          `[SFUOrchestrator] SFU "${region}" failed to initialize:`,
          err.message,
        );
        entry.health = SFUHealth.DOWN;
      }
    });

    await Promise.allSettled(inits);

    this._bindServerEvents();
    this._startHealthChecks();
    this._initialized = true;
  }

  /**
   * Gracefully shuts down all SFU adapters and stops health checks.
   *
   * @returns {Promise<void>}
   */
  async close() {
    clearInterval(this._healthTimer);

    const closes = [...this._sfus.values()].map(async (entry) => {
      if (entry.initialized && typeof entry.adapter.close === "function") {
        try {
          await entry.adapter.close();
        } catch (err) {
          console.error(
            `[SFUOrchestrator] Error closing SFU "${entry.region}":`,
            err.message,
          );
        }
      }
    });

    await Promise.allSettled(closes);
  }

  // ---------------------------------------------------------------------------
  // Room assignment
  // ---------------------------------------------------------------------------

  /**
   * Returns the SFU adapter currently assigned to a room.
   * Returns null if the room is in P2P fallback mode.
   *
   * @param {string} roomId
   * @returns {object|null}
   */
  getSFUForRoom(roomId) {
    const region = this._roomAssignments.get(roomId);
    if (!region) return null;
    return this._sfus.get(region)?.adapter ?? null;
  }

  /**
   * Manually migrates a room to a different SFU region.
   * Triggers `room:migrated` and notifies all peers in the room.
   *
   * @param {string} roomId
   * @param {string} targetRegion
   * @returns {Promise<boolean>}
   */
  async migrateRoom(roomId, targetRegion) {
    const target = this._sfus.get(targetRegion);
    if (!target || target.health === SFUHealth.DOWN) return false;

    const fromRegion = this._roomAssignments.get(roomId);
    if (fromRegion) {
      const from = this._sfus.get(fromRegion);
      if (from) from.roomCount = Math.max(0, from.roomCount - 1);
    }

    this._roomAssignments.set(roomId, targetRegion);
    target.roomCount++;

    const room = this._server.getRoom(roomId);
    if (room) {
      room.broadcast({
        type: "sfu:migrated",
        region: targetRegion,
        message: "Your session is being migrated to a new server.",
      });
    }

    /**
     * @event SFUOrchestrator#room:migrated
     * @param {string} roomId
     * @param {string} fromRegion
     * @param {string} targetRegion
     */
    this.emit("room:migrated", roomId, fromRegion, targetRegion);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  /**
   * Returns health and load stats for all registered SFUs.
   *
   * @returns {object[]}
   */
  stats() {
    return [...this._sfus.values()].map((entry) => ({
      region: entry.region,
      health: entry.health,
      roomCount: entry.roomCount,
      failCount: entry.failCount,
      initialized: entry.initialized,
      adapterStats:
        typeof entry.adapter.stats === "function"
          ? entry.adapter.stats()
          : null,
    }));
  }

  /**
   * Returns the number of registered SFUs.
   * @returns {number}
   */
  get size() {
    return this._sfus.size;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * @private
   */
  _bindServerEvents() {
    this._server.on("room:created", (room) => {
      const region = room.metadata.__region ?? this._defaultRegion;
      const assigned = this._assignSFU(room.id, region);
      if (assigned) {
        /**
         * @event SFUOrchestrator#room:assigned
         */
        this.emit("room:assigned", room.id, assigned);
      }
    });

    this._server.on("room:destroyed", (room) => {
      const region = this._roomAssignments.get(room.id);
      if (region) {
        const entry = this._sfus.get(region);
        if (entry) entry.roomCount = Math.max(0, entry.roomCount - 1);
        this._roomAssignments.delete(room.id);
      }
    });
  }

  /**
   * Selects the best available SFU for a room.
   * Preference order: preferred region → least loaded healthy → degraded.
   *
   * @private
   * @param {string} roomId
   * @param {string} preferredRegion
   * @returns {string|null} Assigned region, or null if fallback to P2P
   */
  _assignSFU(roomId, preferredRegion) {
    // Try preferred region first
    const preferred = this._sfus.get(preferredRegion);
    if (
      preferred &&
      preferred.health !== SFUHealth.DOWN &&
      preferred.initialized
    ) {
      this._roomAssignments.set(roomId, preferredRegion);
      preferred.roomCount++;
      return preferredRegion;
    }

    // Find least-loaded healthy SFU
    let best = null;
    let bestLoad = Infinity;

    for (const [region, entry] of this._sfus) {
      if (!entry.initialized) continue;
      if (entry.health === SFUHealth.DOWN) continue;
      const load = entry.roomCount / this._maxRoomsPerSFU;
      if (load < bestLoad) {
        best = region;
        bestLoad = load;
      }
    }

    if (best) {
      this._roomAssignments.set(roomId, best);
      this._sfus.get(best).roomCount++;
      return best;
    }

    // No healthy SFU — P2P fallback
    if (this._fallbackToP2P) {
      console.warn(
        `[SFUOrchestrator] No healthy SFU available for room "${roomId}" — falling back to P2P`,
      );
    }
    return null;
  }

  /**
   * Starts periodic health checks for all registered SFUs.
   * @private
   */
  _startHealthChecks() {
    this._healthTimer = setInterval(async () => {
      for (const entry of this._sfus.values()) {
        await this._checkHealth(entry);
      }
    }, this._healthCheckInterval);

    if (this._healthTimer.unref) this._healthTimer.unref();
  }

  /**
   * Runs a health check for a single SFU entry.
   * @private
   */
  async _checkHealth(entry) {
    try {
      if (typeof entry.adapter.healthCheck === "function") {
        await entry.adapter.healthCheck();
      }
      // Success
      entry.failCount = 0;
      entry.successCount++;

      const wasDown = entry.health !== SFUHealth.HEALTHY;
      if (
        entry.successCount >= RECOVERY_THRESHOLD &&
        entry.health !== SFUHealth.HEALTHY
      ) {
        entry.health = SFUHealth.HEALTHY;
        /**
         * @event SFUOrchestrator#sfu:healthy
         */
        this.emit("sfu:healthy", entry.region);
        if (wasDown) {
          // Rebalance rooms back to this recovered SFU
          this._rebalance(entry.region);
        }
      }
    } catch {
      entry.failCount++;
      entry.successCount = 0;

      if (
        entry.failCount >= DOWN_THRESHOLD &&
        entry.health !== SFUHealth.DOWN
      ) {
        entry.health = SFUHealth.DOWN;
        this.emit("sfu:down", entry.region);
        await this._failoverRooms(entry.region);
      } else if (
        entry.failCount >= DEGRADED_THRESHOLD &&
        entry.health === SFUHealth.HEALTHY
      ) {
        entry.health = SFUHealth.DEGRADED;
        /**
         * @event SFUOrchestrator#sfu:degraded
         */
        this.emit("sfu:degraded", entry.region);
      }
    }
  }

  /**
   * Migrates all rooms from a failed SFU to the next-best healthy one.
   * @private
   */
  async _failoverRooms(failedRegion) {
    const affectedRooms = [];
    for (const [roomId, region] of this._roomAssignments) {
      if (region === failedRegion) affectedRooms.push(roomId);
    }

    if (affectedRooms.length === 0) return;

    console.warn(
      `[SFUOrchestrator] SFU "${failedRegion}" is DOWN — failing over ${affectedRooms.length} rooms`,
    );

    /**
     * @event SFUOrchestrator#failover
     */
    this.emit("failover", failedRegion, affectedRooms);

    for (const roomId of affectedRooms) {
      // Remove current assignment so _assignSFU picks a new one
      this._roomAssignments.delete(roomId);
      const newRegion = this._assignSFU(roomId, this._defaultRegion);
      if (newRegion && newRegion !== failedRegion) {
        this.emit("room:migrated", roomId, failedRegion, newRegion);
        const room = this._server.getRoom(roomId);
        if (room) {
          room.broadcast({
            type: "sfu:failover",
            region: newRegion,
            message: "Reconnecting to a healthy server.",
          });
        }
      }
    }
  }

  /**
   * Rebalances rooms back to a recovered SFU.
   * @private
   */
  _rebalance(recoveredRegion) {
    // For now, newly created rooms will prefer the recovered region.
    // Active room migration on recovery is opt-in to avoid disruption.
    console.log(
      `[SFUOrchestrator] SFU "${recoveredRegion}" recovered — new rooms will prefer it`,
    );
  }
}

SFUOrchestrator.Health = SFUHealth;

module.exports = SFUOrchestrator;
