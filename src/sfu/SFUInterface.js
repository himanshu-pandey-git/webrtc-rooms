"use strict";

/**
 * @file SFUInterface.js
 * @description Abstract SFU (Selective Forwarding Unit) contract for webrtc-rooms v2.
 *
 * All SFU adapters (mediasoup, Livekit, etc.) must extend this class and
 * implement every method marked `@abstract`. The SFUOrchestrator and all
 * higher-level systems interact only with this interface — never with
 * adapter internals — so SFU providers are fully interchangeable.
 *
 * **Lifecycle**
 *
 * ```
 * const sfu = new MediasoupAdapter(config);
 * await sfu.init();           // spawn workers, connect to SFU server
 * sfu.attach(signalingServer); // wire up room/peer events
 * // ... run ...
 * await sfu.close();          // graceful shutdown
 * ```
 *
 * **Room model**
 *
 * Each SFU adapter maintains its own internal room model. When a signaling
 * room is created, the SFU creates a corresponding router/room. When a peer
 * joins, the SFU creates a transport for that peer. The adapter is responsible
 * for mapping signaling room IDs → SFU internal room IDs.
 *
 * @module webrtc-rooms/sfu/SFUInterface
 */

const { EventEmitter } = require("events");

/**
 * Supported SFU capability flags. Adapters declare which they support
 * via `capabilities()`. Higher-level code gates features on these flags.
 *
 * @readonly
 * @enum {string}
 */
const SFUCapability = Object.freeze({
  /** Adapter supports simulcast (multiple quality layers per producer). */
  SIMULCAST: "simulcast",

  /** Adapter supports SVC (scalable video coding). */
  SVC: "svc",

  /** Adapter supports data channels through the SFU. */
  DATA_CHANNELS: "data_channels",

  /** Adapter supports end-to-end encryption at the SFU layer. */
  E2EE: "e2ee",

  /** Adapter exposes per-producer statistics (bitrate, RTT, packet loss). */
  PRODUCER_STATS: "producer_stats",

  /** Adapter supports multiple regions / geographic routing. */
  MULTI_REGION: "multi_region",

  /** Adapter supports pausing and resuming individual consumers. */
  CONSUMER_CONTROL: "consumer_control",

  /** Adapter can enforce bandwidth limits per consumer. */
  BANDWIDTH_LIMIT: "bandwidth_limit",
});

/**
 * Abstract base class that all SFU adapters must extend.
 *
 * @abstract
 * @extends EventEmitter
 *
 * @fires SFUInterface#sfu:room:created
 * @fires SFUInterface#sfu:room:closed
 * @fires SFUInterface#sfu:peer:joined
 * @fires SFUInterface#sfu:peer:left
 * @fires SFUInterface#sfu:producer:added
 * @fires SFUInterface#sfu:producer:removed
 * @fires SFUInterface#sfu:consumer:added
 * @fires SFUInterface#sfu:consumer:removed
 * @fires SFUInterface#sfu:worker:died
 * @fires SFUInterface#sfu:stats
 */
class SFUInterface extends EventEmitter {
  /**
   * @param {import('../config/ConfigManager')} config
   */
  constructor(config) {
    super();

    if (new.target === SFUInterface) {
      throw new TypeError(
        "SFUInterface is abstract and cannot be instantiated directly. Use a concrete adapter such as MediasoupAdapter.",
      );
    }

    /** @protected */
    this._config = config;

    /** @protected @type {boolean} */
    this._initialised = false;

    /** @protected @type {boolean} */
    this._closed = false;
  }

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  /**
   * Returns the adapter name. Used in logs, metrics, and error messages.
   *
   * @abstract
   * @returns {string} e.g. 'mediasoup', 'livekit'
   */
  get name() {
    throw new Error(`${this.constructor.name} must implement get name()`);
  }

  /**
   * Returns the adapter version string. Used in health checks and metrics.
   *
   * @abstract
   * @returns {string}
   */
  get version() {
    throw new Error(`${this.constructor.name} must implement get version()`);
  }

  /**
   * Returns the set of capabilities this adapter supports.
   * Callers use this to gate features without try/catch around abstract methods.
   *
   * @abstract
   * @returns {Set<SFUCapability>}
   */
  capabilities() {
    throw new Error(`${this.constructor.name} must implement capabilities()`);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialises the SFU adapter — spawns workers, connects to external
   * services, allocates resource pools.
   *
   * Must be called and awaited before `attach()`.
   *
   * @abstract
   * @returns {Promise<void>}
   */
  async init() {
    throw new Error(`${this.constructor.name} must implement init()`);
  }

  /**
   * Wires the adapter into a `SignalingServer` instance.
   * After this call, the adapter reacts to room and peer events automatically.
   *
   * @param {import('../core/SignalingServer')} server
   * @returns {this}
   */
  attach(server) {
    this._assertInitialised("attach");

    server.on("room:created", (room) => this._onRoomCreated(room));
    server.on("room:destroyed", (room) => this._onRoomDestroyed(room));
    server.on("peer:joined", (peer, room) => this._onPeerJoined(peer, room));
    server.on("peer:left", (peer, room) => this._onPeerLeft(peer, room));

    return this;
  }

  /**
   * Gracefully shuts down the adapter — closes all transports, routers,
   * and worker processes.
   *
   * @abstract
   * @returns {Promise<void>}
   */
  async close() {
    throw new Error(`${this.constructor.name} must implement close()`);
  }

  // ---------------------------------------------------------------------------
  // Room management
  // ---------------------------------------------------------------------------

  /**
   * Creates an SFU room corresponding to a signaling room.
   *
   * @abstract
   * @param {string} roomId
   * @param {object} [options]
   * @returns {Promise<object>} SFU-internal room descriptor.
   */
  async createRoom(roomId, options) {
    // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement createRoom()`);
  }

  /**
   * Closes an SFU room and releases all its resources.
   *
   * @abstract
   * @param {string} roomId
   * @returns {Promise<void>}
   */
  async closeRoom(roomId) {
    // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement closeRoom()`);
  }

  // ---------------------------------------------------------------------------
  // Peer / transport management
  // ---------------------------------------------------------------------------

  /**
   * Creates send and receive transports for a peer joining a room.
   * Returns the transport parameters that the peer's browser needs to
   * connect its `mediasoup-client` or equivalent SDK.
   *
   * @abstract
   * @param {string} peerId
   * @param {string} roomId
   * @returns {Promise<{ sendTransport: object, recvTransport: object, routerRtpCapabilities: object }>}
   */
  async createPeerTransports(peerId, roomId) {
    // eslint-disable-line no-unused-vars
    throw new Error(
      `${this.constructor.name} must implement createPeerTransports()`,
    );
  }

  /**
   * Connects a transport after the browser-side DTLS parameters are known.
   *
   * @abstract
   * @param {string} peerId
   * @param {string} transportId
   * @param {object} dtlsParameters
   * @returns {Promise<void>}
   */
  async connectTransport(peerId, transportId, dtlsParameters) {
    // eslint-disable-line no-unused-vars
    throw new Error(
      `${this.constructor.name} must implement connectTransport()`,
    );
  }

  /**
   * Closes all transports for a peer and removes them from the SFU room.
   *
   * @abstract
   * @param {string} peerId
   * @param {string} roomId
   * @returns {Promise<void>}
   */
  async closePeerTransports(peerId, roomId) {
    // eslint-disable-line no-unused-vars
    throw new Error(
      `${this.constructor.name} must implement closePeerTransports()`,
    );
  }

  // ---------------------------------------------------------------------------
  // Producer / consumer management
  // ---------------------------------------------------------------------------

  /**
   * Creates a producer on the peer's send transport.
   *
   * @abstract
   * @param {string} peerId
   * @param {string} roomId
   * @param {object} produceParams - `{ kind, rtpParameters, appData }`
   * @returns {Promise<{ producerId: string }>}
   */
  async produce(peerId, roomId, produceParams) {
    // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement produce()`);
  }

  /**
   * Creates a consumer on the peer's receive transport for a remote producer.
   *
   * @abstract
   * @param {string} peerId        - The consuming peer.
   * @param {string} roomId
   * @param {string} producerId    - The producer to consume.
   * @param {object} rtpCapabilities - The consuming peer's RTP capabilities.
   * @returns {Promise<{ consumerId: string, kind: string, rtpParameters: object }>}
   */
  async consume(peerId, roomId, producerId, rtpCapabilities) {
    // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement consume()`);
  }

  /**
   * Pauses a consumer (stops forwarding RTP to the consuming peer).
   *
   * @abstract
   * @param {string} peerId
   * @param {string} consumerId
   * @returns {Promise<void>}
   */
  async pauseConsumer(peerId, consumerId) {
    // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement pauseConsumer()`);
  }

  /**
   * Resumes a previously paused consumer.
   *
   * @abstract
   * @param {string} peerId
   * @param {string} consumerId
   * @returns {Promise<void>}
   */
  async resumeConsumer(peerId, consumerId) {
    // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement resumeConsumer()`);
  }

  // ---------------------------------------------------------------------------
  // Statistics + health
  // ---------------------------------------------------------------------------

  /**
   * Returns a health snapshot of the adapter.
   * Used by SFUOrchestrator for failover decisions.
   *
   * @abstract
   * @returns {Promise<{ healthy: boolean, workers: number, rooms: number, peers: number, load: number }>}
   */
  async health() {
    throw new Error(`${this.constructor.name} must implement health()`);
  }

  /**
   * Returns per-room and per-peer statistics.
   *
   * @abstract
   * @returns {Promise<object>}
   */
  async stats() {
    throw new Error(`${this.constructor.name} must implement stats()`);
  }

  /**
   * Returns per-producer statistics (bitrate, RTT, packet loss).
   * Only available if `capabilities()` includes `PRODUCER_STATS`.
   *
   * @param {string} producerId
   * @returns {Promise<object>}
   */
  async producerStats(producerId) {
    // eslint-disable-line no-unused-vars
    this._assertCapability(SFUCapability.PRODUCER_STATS, "producerStats");
  }

  // ---------------------------------------------------------------------------
  // Event hooks (called by attach — override in subclasses if needed)
  // ---------------------------------------------------------------------------

  /** @protected */
  async _onRoomCreated(room) {
    try {
      await this.createRoom(room.id);
      /**
       * @event SFUInterface#sfu:room:created
       * @param {string} roomId
       */
      this.emit("sfu:room:created", room.id);
    } catch (err) {
      this.emit(
        "error",
        new Error(
          `[${this.name}] Failed to create SFU room "${room.id}": ${err.message}`,
        ),
      );
    }
  }

  /** @protected */
  async _onRoomDestroyed(room) {
    try {
      await this.closeRoom(room.id);
      /**
       * @event SFUInterface#sfu:room:closed
       * @param {string} roomId
       */
      this.emit("sfu:room:closed", room.id);
    } catch (err) {
      this.emit(
        "error",
        new Error(
          `[${this.name}] Failed to close SFU room "${room.id}": ${err.message}`,
        ),
      );
    }
  }

  /** @protected */
  async _onPeerJoined(peer, room) {
    try {
      const transports = await this.createPeerTransports(peer.id, room.id);
      peer.send({
        type: "sfu:transport:created",
        ...transports,
      });
      /**
       * @event SFUInterface#sfu:peer:joined
       * @param {{ peerId: string, roomId: string }}
       */
      this.emit("sfu:peer:joined", { peerId: peer.id, roomId: room.id });
    } catch (err) {
      this.emit(
        "error",
        new Error(
          `[${this.name}] Failed to create transports for peer "${peer.id}": ${err.message}`,
        ),
      );
    }
  }

  /** @protected */
  async _onPeerLeft(peer, room) {
    try {
      await this.closePeerTransports(peer.id, room.id);
      /**
       * @event SFUInterface#sfu:peer:left
       * @param {{ peerId: string, roomId: string }}
       */
      this.emit("sfu:peer:left", { peerId: peer.id, roomId: room.id });
    } catch (err) {
      this.emit(
        "error",
        new Error(
          `[${this.name}] Failed to close transports for peer "${peer.id}": ${err.message}`,
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  /**
   * @protected
   * @param {string} method
   */
  _assertInitialised(method) {
    if (!this._initialised) {
      throw new Error(`[${this.name}] Call init() before ${method}()`);
    }
  }

  /**
   * @protected
   * @param {SFUCapability} capability
   * @param {string}        method
   */
  _assertCapability(capability, method) {
    if (!this.capabilities().has(capability)) {
      throw new Error(
        `[${this.name}] ${method}() requires the "${capability}" capability, which this adapter does not support`,
      );
    }
  }
}

SFUInterface.Capability = SFUCapability;

module.exports = SFUInterface;
