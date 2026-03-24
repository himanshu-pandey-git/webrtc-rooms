"use strict";

/**
 * @file LivekitAdapter.js
 * @description Livekit implementation of {@link SFUInterface}.
 *
 * Connects to a self-hosted or cloud Livekit server via the Livekit Server SDK.
 * Rooms are managed via the Livekit Room Service API. Peer transports are
 * handled by Livekit natively — the adapter bridges Livekit's participant
 * lifecycle into the webrtc-rooms peer model.
 *
 * **Prerequisites**
 * - `npm install livekit-server-sdk` (optional peer dependency)
 * - A running Livekit server (self-hosted or cloud.livekit.io)
 * - `WEBRTC_ROOMS_LIVEKIT_URL` and `WEBRTC_ROOMS_LIVEKIT_API_KEY`/`API_SECRET`
 *
 * @module webrtc-rooms/sfu/LivekitAdapter
 */

const SFUInterface = require("./SFUInterface");

/** @type {typeof import('livekit-server-sdk')} */
let LivekitSDK;

/**
 * @implements {SFUInterface}
 */
class LivekitAdapter extends SFUInterface {
  /**
   * @param {import('../config/ConfigManager')} config
   * @param {object} [livekitOptions]
   * @param {string} livekitOptions.url       - Livekit server URL e.g. `wss://myapp.livekit.cloud`
   * @param {string} livekitOptions.apiKey    - Livekit API key
   * @param {string} livekitOptions.apiSecret - Livekit API secret
   */
  constructor(config, livekitOptions = {}) {
    super(config);

    this._url = livekitOptions.url ?? process.env.WEBRTC_ROOMS_LIVEKIT_URL;
    this._apiKey =
      livekitOptions.apiKey ?? process.env.WEBRTC_ROOMS_LIVEKIT_API_KEY;
    this._apiSecret =
      livekitOptions.apiSecret ?? process.env.WEBRTC_ROOMS_LIVEKIT_API_SECRET;

    if (!this._url || !this._apiKey || !this._apiSecret) {
      throw new Error(
        "[LivekitAdapter] url, apiKey, and apiSecret are required. " +
          "Pass them as options or set WEBRTC_ROOMS_LIVEKIT_URL, " +
          "WEBRTC_ROOMS_LIVEKIT_API_KEY, and WEBRTC_ROOMS_LIVEKIT_API_SECRET.",
      );
    }

    /** @private */
    this._roomService = null;

    /** @private @type {Map<string, object>} roomId → Livekit room metadata */
    this._rooms = new Map();

    /** @private @type {Map<string, string>} peerId → Livekit access token */
    this._peerTokens = new Map();
  }

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  get name() {
    return "livekit";
  }

  get version() {
    return LivekitSDK?.AccessToken ? "livekit-server-sdk" : "unknown";
  }

  capabilities() {
    return new Set([
      SFUInterface.Capability.SIMULCAST,
      SFUInterface.Capability.SVC,
      SFUInterface.Capability.DATA_CHANNELS,
      SFUInterface.Capability.E2EE,
      SFUInterface.Capability.PRODUCER_STATS,
      SFUInterface.Capability.CONSUMER_CONTROL,
      SFUInterface.Capability.MULTI_REGION,
    ]);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async init() {
    try {
      LivekitSDK = require("livekit-server-sdk");
    } catch {
      throw new Error(
        "[LivekitAdapter] livekit-server-sdk is not installed. Run: npm install livekit-server-sdk",
      );
    }

    this._roomService = new LivekitSDK.RoomServiceClient(
      this._url,
      this._apiKey,
      this._apiSecret,
    );

    // Verify connectivity.
    try {
      await this._roomService.listRooms([]);
    } catch (err) {
      throw new Error(
        `[LivekitAdapter] Cannot connect to Livekit server at ${this._url}: ${err.message}`,
      );
    }

    this._initialised = true;
    console.log(`[LivekitAdapter] Connected to Livekit server at ${this._url}`);
  }

  async close() {
    this._closed = true;
    // Livekit rooms are managed server-side; we just clear local state.
    this._rooms.clear();
    this._peerTokens.clear();
    this._roomService = null;
  }

  // ---------------------------------------------------------------------------
  // Room management
  // ---------------------------------------------------------------------------

  async createRoom(roomId, options = {}) {
    if (this._rooms.has(roomId)) return this._rooms.get(roomId);

    const room = await this._roomService.createRoom({
      name: roomId,
      emptyTimeout: options.emptyTimeout ?? 300, // 5 min
      maxParticipants: options.maxParticipants ?? 100,
    });

    this._rooms.set(roomId, room);
    return room;
  }

  async closeRoom(roomId) {
    try {
      await this._roomService.deleteRoom(roomId);
    } catch {
      // Room may already be gone on Livekit side — not an error.
    }
    this._rooms.delete(roomId);
  }

  // ---------------------------------------------------------------------------
  // Peer / transport management
  //
  // In Livekit's model, transport is handled by the Livekit client SDK on
  // the browser side. The server's role is to issue a signed access token
  // that the browser uses to connect directly to the Livekit server.
  //
  // We return the token as the "transport params" that the peer's browser needs.
  // ---------------------------------------------------------------------------

  async createPeerTransports(peerId, roomId) {
    const at = new LivekitSDK.AccessToken(this._apiKey, this._apiSecret, {
      identity: peerId,
      name: peerId,
      ttl: "4h",
    });

    at.addGrant({
      roomJoin: true,
      room: roomId,
      canPublish: true,
      canSubscribe: true,
    });

    const token = at.toJwt();
    this._peerTokens.set(peerId, token);

    // For the abstract interface we return a structure compatible with our
    // SFU signal format. The browser detects adapter: 'livekit' and uses
    // the token to connect via livekit-client instead of mediasoup-client.
    return {
      adapter: "livekit",
      serverUrl: this._url,
      token,
      // Satisfies the SFUInterface contract shape — Livekit does not use
      // WebRTC transport params in the same way as mediasoup.
      routerRtpCapabilities: null,
      sendTransport: null,
      recvTransport: null,
    };
  }

  async connectTransport(peerId, transportId, dtlsParameters) {
    // eslint-disable-line no-unused-vars
    // Livekit handles transport connection client-side.
    // This is a no-op for Livekit but must exist to satisfy the interface.
  }

  async closePeerTransports(peerId, roomId) {
    // eslint-disable-line no-unused-vars
    try {
      await this._roomService.removeParticipant(roomId, peerId);
    } catch {
      // Participant may already be gone.
    }
    this._peerTokens.delete(peerId);
  }

  // ---------------------------------------------------------------------------
  // Producer / consumer management
  //
  // Livekit handles publishing/subscribing natively. These methods exist to
  // satisfy the interface but are no-ops or thin wrappers in most cases.
  // ---------------------------------------------------------------------------

  async produce(peerId, roomId, { kind, appData = {} }) {
    // eslint-disable-line no-unused-vars
    // Livekit participants publish directly — server cannot initiate.
    // Return a placeholder producerId derived from the peer for tracking.
    const producerId = `livekit-${peerId}-${kind}`;
    this.emit("sfu:producer:added", { peerId, roomId, producerId, kind });
    return { producerId };
  }

  async consume(peerId, roomId, producerId, rtpCapabilities) {
    // eslint-disable-line no-unused-vars
    // Livekit subscriptions are client-initiated.
    return {
      consumerId: `livekit-consumer-${peerId}-${producerId}`,
      kind: "video",
      rtpParameters: {},
    };
  }

  async pauseConsumer(peerId, consumerId) {
    // eslint-disable-line no-unused-vars
    // Livekit: mute participant track via API
    // this._roomService.mutePublishedTrack(...)
    // Stubbed — actual implementation depends on Livekit track SID.
  }

  async resumeConsumer(peerId, consumerId) {
    // eslint-disable-line no-unused-vars
    // Livekit: unmute participant track via API
  }

  // ---------------------------------------------------------------------------
  // Statistics + health
  // ---------------------------------------------------------------------------

  async health() {
    try {
      const rooms = await this._roomService.listRooms([]);
      return {
        healthy: true,
        workers: 1, // Livekit manages its own workers
        rooms: rooms.length,
        peers: rooms.reduce((sum, r) => sum + (r.numParticipants ?? 0), 0),
        load: rooms.length,
      };
    } catch {
      return { healthy: false, workers: 0, rooms: 0, peers: 0, load: Infinity };
    }
  }

  async stats() {
    const rooms = await this._roomService.listRooms([]);
    return {
      workers: 1,
      rooms: rooms.map((r) => ({
        roomId: r.name,
        peers: r.numParticipants,
        publishers: r.numPublishers,
        activeRecording: r.activeRecording,
      })),
    };
  }
}

module.exports = LivekitAdapter;
