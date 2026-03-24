"use strict";

/**
 * @file ConsentFlow.js
 * @description Consent tracking and management for webrtc-rooms v2.
 *
 * Tracks informed consent for recording, data processing, and third-party
 * integrations. Designed to satisfy GDPR Article 6 (lawful basis), HIPAA
 * authorisation requirements, and general recording consent laws (which
 * vary by jurisdiction — some require all-party consent).
 *
 * **Consent types**
 *
 * | Type         | What it covers                                        |
 * |--------------|-------------------------------------------------------|
 * | `recording`  | Audio/video recording of the session                  |
 * | `processing` | Server-side processing (transcription, AI features)   |
 * | `sharing`    | Sharing session data with third-party integrations    |
 * | `analytics`  | Aggregated usage analytics                            |
 *
 * **Flow**
 *
 * 1. Server emits `consent:required` to a peer on join (when configured).
 * 2. Peer sends `{ type: 'data', payload: { __consent: 'grant', types: ['recording'] } }`.
 * 3. Server records the consent with timestamp and version.
 * 4. For room-wide operations (e.g. recording), ConsentFlow checks all active
 *    peers have consented before allowing the operation.
 *
 * **Withdrawal**
 *
 * Peers can withdraw consent at any time:
 * `{ __consent: 'withdraw', types: ['recording'] }`
 *
 * Withdrawal triggers `consent:withdrawn` events so integrations (e.g.
 * RecordingPipeline) can react appropriately.
 *
 * @module webrtc-rooms/compliance/ConsentFlow
 *
 * @example
 * const consent = new ConsentFlow({
 *   server,
 *   required:     ['recording'],
 *   allParty:     true,   // all peers must consent before recording starts
 *   consentVersion: 'v2024-05',
 * });
 * consent.attach();
 *
 * // Check before starting recording:
 * if (!consent.roomHasConsent('my-room', 'recording')) {
 *   console.warn('Not all peers have consented to recording');
 * }
 */

const { EventEmitter } = require("events");

const CONSENT_TAG = "__consent";

const VALID_TYPES = new Set([
  "recording",
  "processing",
  "sharing",
  "analytics",
]);

/**
 * @typedef {object} ConsentRecord
 * @property {string}   peerId
 * @property {string}   roomId
 * @property {string[]} types       - Consent types granted
 * @property {string}   version     - Consent version string
 * @property {number}   grantedAt
 * @property {string}   ip
 */

/**
 * @extends EventEmitter
 *
 * @fires ConsentFlow#consent:granted
 * @fires ConsentFlow#consent:withdrawn
 * @fires ConsentFlow#consent:required
 * @fires ConsentFlow#room:consent:complete
 */
class ConsentFlow extends EventEmitter {
  /**
   * @param {object}    options
   * @param {import('../core/SignalingServer')} options.server
   * @param {string[]}  [options.required=[]]
   *   Consent types that must be granted before a peer can fully participate.
   *   Empty array = consent is optional (collected but not enforced).
   * @param {boolean}   [options.allParty=false]
   *   When true, room-level operations (like recording) require ALL active
   *   peers to have consented, not just those who haven't explicitly declined.
   * @param {string}    [options.consentVersion='v1']
   *   Consent document version. Changing this invalidates old consents.
   * @param {number}    [options.consentTimeoutMs=30000]
   *   How long to wait for consent before timing out (if required).
   */
  constructor({
    server,
    required = [],
    allParty = false,
    consentVersion = "v1",
    consentTimeoutMs = 30_000,
  }) {
    super();

    if (!server) throw new Error("[ConsentFlow] options.server is required");

    this._server = server;
    this._required = new Set(required);
    this._allParty = allParty;
    this._consentVersion = consentVersion;
    this._consentTimeout = consentTimeoutMs;

    /** @type {Map<string, Map<string, ConsentRecord>>} roomId → peerId → record */
    this._consents = new Map();

    /** @type {Map<string, ReturnType<typeof setTimeout>>} peerId → timeout */
    this._timeouts = new Map();

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

    const s = this._server;

    s.on("room:created", (room) => {
      this._consents.set(room.id, new Map());
    });

    s.on("room:destroyed", (room) => {
      this._consents.delete(room.id);
    });

    s.on("peer:joined", (peer, room) => {
      this._onPeerJoined(peer, room);
    });

    s.on("peer:left", (peer, room) => {
      this._onPeerLeft(peer, room);
    });

    // Intercept data signals for consent messages
    s.on("room:created", (room) => {
      room.on("data", (peer, _to, payload) => {
        if (payload?.[CONSENT_TAG]) {
          this._handleConsentSignal(peer, room, payload);
        }
      });
    });

    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns the consent record for a peer in a room.
   *
   * @param {string} roomId
   * @param {string} peerId
   * @returns {ConsentRecord|null}
   */
  getConsent(roomId, peerId) {
    return this._consents.get(roomId)?.get(peerId) ?? null;
  }

  /**
   * Returns true if a peer has consented to a specific type.
   *
   * @param {string} roomId
   * @param {string} peerId
   * @param {string} type
   * @returns {boolean}
   */
  hasConsented(roomId, peerId, type) {
    const record = this.getConsent(roomId, peerId);
    return record?.types.includes(type) ?? false;
  }

  /**
   * Returns true if ALL active peers in a room have consented to a type.
   * Use this before starting a room-wide operation.
   *
   * @param {string} roomId
   * @param {string} type
   * @returns {boolean}
   */
  roomHasConsent(roomId, type) {
    const room = this._server.getRoom(roomId);
    if (!room) return false;

    for (const peerId of room.peers.keys()) {
      if (!this.hasConsented(roomId, peerId, type)) return false;
    }
    return room.peers.size > 0;
  }

  /**
   * Returns all consent records for a room.
   *
   * @param {string} roomId
   * @returns {ConsentRecord[]}
   */
  getRoomConsents(roomId) {
    const store = this._consents.get(roomId);
    if (!store) return [];
    return [...store.values()];
  }

  /**
   * Records server-side consent on behalf of a peer (e.g. when consent was
   * obtained outside the WebRTC session — via a web form before joining).
   *
   * @param {string}   roomId
   * @param {string}   peerId
   * @param {string[]} types
   */
  recordConsent(roomId, peerId, types) {
    const peer = this._server.rooms.get(roomId)?.peers.get(peerId);
    this._grantConsent(roomId, peerId, types, peer?._ip ?? "server-granted");
  }

  /**
   * Returns consent statistics across all rooms.
   */
  stats() {
    const result = [];
    for (const [roomId, store] of this._consents) {
      const room = this._server.getRoom(roomId);
      result.push({
        roomId,
        totalPeers: room?.peers.size ?? 0,
        consented: store.size,
        allConsented: room ? store.size === room.peers.size : false,
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** @private */
  _onPeerJoined(peer, room) {
    if (!this._consents.has(room.id)) {
      this._consents.set(room.id, new Map());
    }

    if (this._required.size > 0) {
      // Notify peer that consent is required
      peer.send({
        type: "consent:required",
        types: [...this._required],
        version: this._consentVersion,
        timeoutMs: this._consentTimeout,
      });

      /**
       * @event ConsentFlow#consent:required
       */
      this.emit("consent:required", {
        peerId: peer.id,
        roomId: room.id,
        types: [...this._required],
      });

      // Start enforcement timeout
      if (this._consentTimeout > 0) {
        const timer = setTimeout(() => {
          if (!this._hasAllRequired(room.id, peer.id)) {
            peer.send({
              type: "error",
              code: "CONSENT_TIMEOUT",
              message: "Consent not provided in time.",
            });
            this._server.kick(peer.id, "Consent timeout");
          }
          this._timeouts.delete(peer.id);
        }, this._consentTimeout);

        this._timeouts.set(peer.id, timer);
      }
    }
  }

  /** @private */
  _onPeerLeft(peer, room) {
    clearTimeout(this._timeouts.get(peer.id));
    this._timeouts.delete(peer.id);

    const store = this._consents.get(room.id);
    if (store) store.delete(peer.id);
  }

  /** @private */
  _handleConsentSignal(peer, room, payload) {
    const action = payload[CONSENT_TAG];
    const types = payload.types ?? [];

    if (!Array.isArray(types) || types.some((t) => !VALID_TYPES.has(t))) {
      peer.send({ type: "error", code: "CONSENT_INVALID_TYPE" });
      return;
    }

    if (action === "grant") {
      this._grantConsent(room.id, peer.id, types, this._extractIp(peer));
      clearTimeout(this._timeouts.get(peer.id));
      this._timeouts.delete(peer.id);
      peer.send({
        type: "consent:confirmed",
        types,
        version: this._consentVersion,
      });

      // Check if all room peers now have consent (for allParty scenarios)
      if (this._allParty && types.length > 0) {
        for (const type of types) {
          if (this.roomHasConsent(room.id, type)) {
            /**
             * @event ConsentFlow#room:consent:complete
             */
            this.emit("room:consent:complete", { roomId: room.id, type });
          }
        }
      }
    } else if (action === "withdraw") {
      this._withdrawConsent(room.id, peer.id, types);
      peer.send({ type: "consent:withdrawn", types });
    } else {
      peer.send({ type: "error", code: "CONSENT_UNKNOWN_ACTION", action });
    }
  }

  /** @private */
  _grantConsent(roomId, peerId, types, ip = "unknown") {
    const store = this._consents.get(roomId);
    if (!store) return;

    const existing = store.get(peerId);
    const merged = new Set([...(existing?.types ?? []), ...types]);

    /** @type {ConsentRecord} */
    const record = {
      peerId,
      roomId,
      types: [...merged],
      version: this._consentVersion,
      grantedAt: Date.now(),
      ip,
    };

    store.set(peerId, record);

    /**
     * @event ConsentFlow#consent:granted
     */
    this.emit("consent:granted", record);
  }

  /** @private */
  _withdrawConsent(roomId, peerId, types) {
    const store = this._consents.get(roomId);
    const record = store?.get(peerId);
    if (!record) return;

    record.types = record.types.filter((t) => !types.includes(t));

    if (record.types.length === 0) store.delete(peerId);
    else store.set(peerId, record);

    /**
     * @event ConsentFlow#consent:withdrawn
     */
    this.emit("consent:withdrawn", {
      peerId,
      roomId,
      types,
      remaining: record.types,
    });
  }

  /** @private */
  _hasAllRequired(roomId, peerId) {
    for (const type of this._required) {
      if (!this.hasConsented(roomId, peerId, type)) return false;
    }
    return true;
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

module.exports = ConsentFlow;
