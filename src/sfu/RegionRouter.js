"use strict";

/**
 * @file RegionRouter.js
 * @description Region-aware peer routing for webrtc-rooms v2.
 *
 * Determines the optimal region for each peer and room based on geography,
 * load, and room affinity. Works with `SFUOrchestrator` and `DataResidency`
 * to route peers to the most appropriate process/region.
 *
 * **Routing modes**
 *
 * | Mode        | Description                                           |
 * |-------------|-------------------------------------------------------|
 * | `latency`   | Route to lowest-latency region (via ping measurement) |
 * | `affinity`  | Route peers to the region where their room lives      |
 * | `residency` | Route based on data residency rules                   |
 * | `load`      | Route to least-loaded healthy region                  |
 * | `manual`    | No automatic routing — regions set by application     |
 *
 * **How routing decisions are used**
 *
 * The RegionRouter does not redirect TCP connections — WebSocket connections
 * are already established by the time routing runs. Instead, it:
 *
 * 1. Tags peers and rooms with their assigned region
 * 2. Advises the SFUOrchestrator which region to assign to new rooms
 * 3. Emits `peer:should:migrate` when a peer is on the wrong region,
 *    allowing the application to issue a reconnect hint to the browser
 *
 * @module webrtc-rooms/sfu/RegionRouter
 *
 * @example
 * const router = new RegionRouter({
 *   server,
 *   localRegion: 'us-east-1',
 *   regions: ['us-east-1', 'eu-west-1', 'ap-south-1'],
 *   mode: 'affinity',
 * });
 * router.attach();
 */

const { EventEmitter } = require("events");

/**
 * @extends EventEmitter
 * @fires RegionRouter#peer:routed
 * @fires RegionRouter#room:routed
 * @fires RegionRouter#peer:should:migrate
 */
class RegionRouter extends EventEmitter {
  /**
   * @param {object}    options
   * @param {import('../core/SignalingServer')} options.server
   * @param {string}    options.localRegion  - Region this process is in
   * @param {string[]}  options.regions      - All known regions
   * @param {string}    [options.mode='affinity']
   * @param {Function}  [options.loadFn]
   *   `async (region: string) => number` — returns current load 0.0–1.0.
   *   Required for `load` mode.
   * @param {Function}  [options.latencyFn]
   *   `async (ip: string, region: string) => number` — returns RTT ms.
   *   Required for `latency` mode.
   * @param {boolean}   [options.emitMigrationHints=true]
   *   Emit `peer:should:migrate` when a peer would be better served by a
   *   different region.
   */
  constructor({
    server,
    localRegion,
    regions,
    mode = "affinity",
    loadFn,
    latencyFn,
    emitMigrationHints = true,
  }) {
    super();

    if (!server) throw new Error("[RegionRouter] options.server is required");
    if (!localRegion)
      throw new Error("[RegionRouter] options.localRegion is required");
    if (!regions || regions.length === 0)
      throw new Error("[RegionRouter] options.regions is required");

    this._server = server;
    this._localRegion = localRegion;
    this._regions = new Set(regions);
    this._mode = mode;
    this._loadFn = loadFn ?? null;
    this._latencyFn = latencyFn ?? null;
    this._emitMigrationHints = emitMigrationHints;

    /** @type {Map<string, string>} peerId → assignedRegion */
    this._peerRegions = new Map();

    /** @type {Map<string, string>} roomId → assignedRegion */
    this._roomRegions = new Map();

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

    this._server.on("peer:connected", (peer) => {
      this._routePeer(peer).catch((err) => {
        console.error("[RegionRouter] Peer routing error:", err.message);
      });
    });

    this._server.on("peer:joined", (peer, room) => {
      this._routeRoom(peer, room).catch((err) => {
        console.error("[RegionRouter] Room routing error:", err.message);
      });
    });

    this._server.on("peer:left", (peer) => {
      this._peerRegions.delete(peer.id);
    });

    this._server.on("room:destroyed", (room) => {
      this._roomRegions.delete(room.id);
    });

    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns the assigned region for a peer.
   * @param {string} peerId
   * @returns {string|undefined}
   */
  getPeerRegion(peerId) {
    return this._peerRegions.get(peerId);
  }

  /**
   * Returns the assigned region for a room.
   * @param {string} roomId
   * @returns {string|undefined}
   */
  getRoomRegion(roomId) {
    return this._roomRegions.get(roomId);
  }

  /**
   * Manually assigns a region to a room.
   * @param {string} roomId
   * @param {string} region
   */
  assignRoomRegion(roomId, region) {
    if (!this._regions.has(region)) {
      throw new Error(`[RegionRouter] Unknown region: "${region}"`);
    }
    this._roomRegions.set(roomId, region);
    const room = this._server.getRoom(roomId);
    if (room) room.setMetadata({ __region: region });
  }

  /**
   * Returns routing stats.
   */
  stats() {
    return {
      localRegion: this._localRegion,
      mode: this._mode,
      regions: [...this._regions],
      peerRoutes: this._peerRegions.size,
      roomRoutes: this._roomRegions.size,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal routing
  // ---------------------------------------------------------------------------

  /** @private */
  async _routePeer(peer) {
    let region = this._localRegion;

    switch (this._mode) {
      case "load":
        region = await this._leastLoadedRegion();
        break;
      case "latency":
        region = await this._lowestLatencyRegion(peer);
        break;
      case "affinity":
      case "residency":
      case "manual":
      default:
        region = peer.metadata.__region ?? this._localRegion;
    }

    this._peerRegions.set(peer.id, region);

    // Tag peer with region for downstream use
    peer.setMetadata({ __assignedRegion: region });

    if (region !== this._localRegion && this._emitMigrationHints) {
      /**
       * @event RegionRouter#peer:should:migrate
       * @param {{ peerId, currentRegion, targetRegion }}
       */
      this.emit("peer:should:migrate", {
        peerId: peer.id,
        currentRegion: this._localRegion,
        targetRegion: region,
      });

      peer.send({
        type: "region:hint",
        targetRegion: region,
        message: "A lower-latency server is available. Consider reconnecting.",
      });
    }

    /**
     * @event RegionRouter#peer:routed
     */
    this.emit("peer:routed", { peerId: peer.id, region });
  }

  /** @private */
  async _routeRoom(peer, room) {
    if (this._roomRegions.has(room.id)) return; // already assigned

    const region = this._peerRegions.get(peer.id) ?? this._localRegion;
    this._roomRegions.set(room.id, region);

    room.setMetadata({ __region: region });

    /**
     * @event RegionRouter#room:routed
     */
    this.emit("room:routed", { roomId: room.id, region });
  }

  /** @private */
  async _leastLoadedRegion() {
    if (!this._loadFn) return this._localRegion;

    let best = this._localRegion;
    let bestLoad = Infinity;

    for (const region of this._regions) {
      try {
        const load = await this._loadFn(region);
        if (load < bestLoad) {
          bestLoad = load;
          best = region;
        }
      } catch {
        // Skip unreachable regions
      }
    }

    return best;
  }

  /** @private */
  async _lowestLatencyRegion(peer) {
    if (!this._latencyFn) return this._localRegion;

    const ip = this._extractIp(peer);
    if (!ip || ip === "unknown") return this._localRegion;

    let best = this._localRegion;
    let bestRtt = Infinity;

    for (const region of this._regions) {
      try {
        const rtt = await this._latencyFn(ip, region);
        if (rtt < bestRtt) {
          bestRtt = rtt;
          best = region;
        }
      } catch {
        // Skip
      }
    }

    return best;
  }

  /** @private */
  _extractIp(peer) {
    try {
      return peer?.socket?._socket?.remoteAddress ?? "unknown";
    } catch {
      return "unknown";
    }
  }
}

module.exports = RegionRouter;
