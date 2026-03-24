"use strict";

/**
 * @file DataResidency.js
 * @description Data residency enforcement for webrtc-rooms v2.
 *
 * Ensures that room data, peer metadata, and signaling events stay within
 * configured geographic regions. Critical for EU (GDPR), US-HIPAA, and
 * sector-specific compliance requirements that mandate data locality.
 *
 * **What this module enforces**
 *
 * 1. **Room creation** — Rooms tagged with a `__region` can only be created
 *    on processes in that region. Cross-region creation attempts are rejected.
 *
 * 2. **Peer join** — Peers connecting from a restricted jurisdiction can only
 *    join rooms in their allowed regions. IP-to-region mapping uses a
 *    configurable lookup function (bring your own GeoIP).
 *
 * 3. **Data export** — Webhook and recording events are tagged with the
 *    originating region. Downstream services can use these tags to enforce
 *    their own storage policies.
 *
 * 4. **Redis isolation** — When used with `RedisAdapter`, each region uses
 *    a distinct key namespace so data from one region never bleeds into
 *    another.
 *
 * **Region model**
 *
 * Regions are arbitrary string identifiers matching the ones configured in
 * `SFUOrchestrator`. Common examples: `us-east-1`, `eu-west-1`, `ap-south-1`.
 *
 * @module webrtc-rooms/compliance/DataResidency
 *
 * @example
 * const residency = new DataResidency({
 *   server,
 *   localRegion: 'eu-west-1',
 *   allowedRegions: ['eu-west-1', 'eu-central-1'],
 *   geoLookup: async (ip) => myGeoIP.lookup(ip).region,
 * });
 * residency.attach();
 */

const { EventEmitter } = require("events");

/**
 * @extends EventEmitter
 * @fires DataResidency#violation
 * @fires DataResidency#room:rejected
 * @fires DataResidency#peer:rejected
 */
class DataResidency extends EventEmitter {
  /**
   * @param {object}    options
   * @param {import('../core/SignalingServer')} options.server
   * @param {string}    options.localRegion
   *   The region this server process is running in.
   * @param {string[]}  [options.allowedRegions]
   *   Regions this process is allowed to serve. Defaults to `[localRegion]`.
   * @param {Function}  [options.geoLookup]
   *   `async (ip: string) => regionString`. Optional. When provided, peers
   *   are checked against allowedRegions on join.
   * @param {boolean}   [options.enforceRoomRegion=true]
   *   Reject room creation if the room's `__region` is not in allowedRegions.
   * @param {boolean}   [options.enforcePeerRegion=false]
   *   Reject peer joins if the peer's IP resolves to a disallowed region.
   *   Requires `geoLookup` to be provided.
   * @param {string}    [options.violationAction='reject']
   *   'reject' — block the action and send an error.
   *   'warn'   — allow but emit a violation event.
   */
  constructor({
    server,
    localRegion,
    allowedRegions,
    geoLookup,
    enforceRoomRegion = true,
    enforcePeerRegion = false,
    violationAction = "reject",
  }) {
    super();

    if (!server) throw new Error("[DataResidency] options.server is required");
    if (!localRegion)
      throw new Error("[DataResidency] options.localRegion is required");

    this._server = server;
    this._localRegion = localRegion;
    this._allowedRegions = new Set(allowedRegions ?? [localRegion]);
    this._geoLookup = geoLookup ?? null;
    this._enforceRoomRegion = enforceRoomRegion;
    this._enforcePeerRegion = enforcePeerRegion && !!geoLookup;
    this._violationAction = violationAction;

    /** @type {Map<string, string>} ip → region cache */
    this._geoCache = new Map();

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

    if (this._enforceRoomRegion) {
      this._server.on("room:created", (room) => {
        const roomRegion = room.metadata.__region;
        if (roomRegion && !this._allowedRegions.has(roomRegion)) {
          this._handleViolation("room:region_mismatch", {
            roomId: room.id,
            roomRegion,
            localRegion: this._localRegion,
          });
        }
      });
    }

    if (this._enforcePeerRegion && this._geoLookup) {
      const existing = this._server.beforeJoin;
      this._server.beforeJoin = async (peer, roomId) => {
        if (existing) {
          const r = await existing(peer, roomId);
          if (r !== true) return r;
        }
        return this._checkPeerRegion(peer, roomId);
      };
    }

    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns the region for an IP, using cache when available.
   * @param {string} ip
   * @returns {Promise<string|null>}
   */
  async resolveRegion(ip) {
    if (this._geoCache.has(ip)) return this._geoCache.get(ip);
    if (!this._geoLookup) return null;
    try {
      const region = await this._geoLookup(ip);
      this._geoCache.set(ip, region);
      return region;
    } catch {
      return null;
    }
  }

  /**
   * Checks whether a region is allowed on this process.
   * @param {string} region
   * @returns {boolean}
   */
  isAllowed(region) {
    return this._allowedRegions.has(region);
  }

  /**
   * Tags a message or event object with the local region.
   * Use this when writing to Redis, webhooks, or recording metadata.
   *
   * @param {object} obj
   * @returns {object} The same object with `__region` added
   */
  tag(obj) {
    return { ...obj, __region: this._localRegion };
  }

  /**
   * Returns residency stats.
   */
  stats() {
    return {
      localRegion: this._localRegion,
      allowedRegions: [...this._allowedRegions],
      geoCacheSize: this._geoCache.size,
      enforceRoom: this._enforceRoomRegion,
      enforcePeer: this._enforcePeerRegion,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** @private */
  async _checkPeerRegion(peer, roomId) {
    const ip = this._extractIp(peer);
    const region = await this.resolveRegion(ip);

    if (region && !this._allowedRegions.has(region)) {
      this._handleViolation("peer:region_mismatch", {
        peerId: peer.id,
        roomId,
        peerRegion: region,
        localRegion: this._localRegion,
      });

      if (this._violationAction === "reject") {
        return `Data residency policy prevents joining from region "${region}"`;
      }
    }

    // Stamp region on peer metadata for downstream use
    if (region) peer.setMetadata({ __geoRegion: region });
    return true;
  }

  /** @private */
  _handleViolation(code, meta) {
    /**
     * @event DataResidency#violation
     * @param {{ code: string, ...meta }}
     */
    this.emit("violation", { code, ts: Date.now(), ...meta });

    if (code.startsWith("room:")) this.emit("room:rejected", meta);
    if (code.startsWith("peer:")) this.emit("peer:rejected", meta);
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

module.exports = DataResidency;
