"use strict";

/**
 * @file MediasoupAdapter.js
 * @description mediasoup v3 SFU (Selective Forwarding Unit) adapter for webrtc-rooms.
 *
 * In P2P mesh mode every participant maintains N−1 direct connections, which
 * becomes expensive beyond ~6 peers. This adapter routes all media through
 * the server instead: one upstream per publisher, one downstream per
 * subscriber, regardless of how many people are in the room.
 *
 * **Architecture**
 *
 * ```
 * Browser A ──(upstream WebRTC)──► mediasoup Router ──(downstream WebRTC)──► Browser B
 *                                         │
 *                                  (downstream WebRTC)──► Browser C
 * ```
 *
 * **Prerequisites**
 * - `npm install mediasoup` (v3, optional peer dependency)
 * - Linux is required for production; macOS works for development.
 * - Open the UDP port range `rtcMinPort`–`rtcMaxPort` in your firewall.
 *
 * **Browser-side requirement**
 *
 * Browsers must use `mediasoup-client` instead of raw `RTCPeerConnection` when
 * they receive a `sfu:transport:created` message.
 *
 * @module webrtc-rooms/adapters/MediasoupAdapter
 */

const { EventEmitter } = require("events");
const os = require("os");

// mediasoup is an optional peer dependency — import lazily so the rest of the
// library continues to work in signaling-only deployments.
let mediasoup = null;
try {
  mediasoup = require("mediasoup");
} catch {
  // Will throw a descriptive error in init() if the adapter is actually used.
}

/**
 * Supported media codecs offered in every router.
 * Clients negotiate down to the subset they actually support.
 *
 * @private
 * @type {import('mediasoup').types.RtpCodecCapability[]}
 */
const MEDIA_CODECS = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 },
  },
  {
    kind: "video",
    mimeType: "video/VP9",
    clockRate: 90000,
    parameters: { "profile-id": 2, "x-google-start-bitrate": 1000 },
  },
  {
    kind: "video",
    mimeType: "video/h264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "4d0032",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 1000,
    },
  },
];

/**
 * mediasoup SFU adapter that intercepts the webrtc-rooms peer lifecycle and
 * sets up server-side WebRTC transports for each participant.
 *
 * @extends EventEmitter
 *
 * @example
 * const { createServer, MediasoupAdapter } = require('webrtc-rooms');
 *
 * const server = createServer({ port: 3000 });
 * const sfu = new MediasoupAdapter({
 *   listenIp:    '0.0.0.0',
 *   announcedIp: process.env.PUBLIC_IP,
 * });
 *
 * await sfu.init();   // start mediasoup workers
 * sfu.attach(server); // intercept room/peer lifecycle
 *
 * @fires MediasoupAdapter#worker:died
 */
class MediasoupAdapter extends EventEmitter {
  /**
   * @param {object} [options={}]
   * @param {string}  [options.listenIp='127.0.0.1']
   *   IP address that mediasoup WebRTC transports bind to.
   *   Use `'0.0.0.0'` in production so all interfaces are available.
   * @param {string}  [options.announcedIp=null]
   *   Public IP to announce in ICE candidates. Required when the server is
   *   behind NAT (most cloud deployments).
   * @param {number}  [options.rtcMinPort=10000]
   *   Lower bound of the UDP port range allocated to mediasoup.
   * @param {number}  [options.rtcMaxPort=10100]
   *   Upper bound of the UDP port range. Ensure this range is open in your
   *   firewall / security group.
   * @param {number}  [options.numWorkers]
   *   Number of mediasoup Worker processes to spawn.
   *   Defaults to the number of logical CPU cores.
   */
  constructor({
    listenIp = "127.0.0.1",
    announcedIp = null,
    rtcMinPort = 10000,
    rtcMaxPort = 10100,
    numWorkers,
  } = {}) {
    super();

    this.listenIp = listenIp;
    this.announcedIp = announcedIp;
    this.rtcMinPort = rtcMinPort;
    this.rtcMaxPort = rtcMaxPort;
    this.numWorkers = numWorkers ?? os.cpus().length;

    /** @private @type {import('mediasoup').types.Worker[]} */
    this._workers = [];

    /** @private */
    this._workerIndex = 0;

    /**
     * Per-room SFU context objects.
     *
     * @private
     * @type {Map<string, {
     *   router:     import('mediasoup').types.Router,
     *   transports: Map<string, { send: WebRtcTransport, recv: WebRtcTransport }>,
     *   producers:  Map<string, import('mediasoup').types.Producer>,
     *   consumers:  Map<string, import('mediasoup').types.Consumer>,
     * }>}
     */
    this._rooms = new Map();

    /** @private @type {import('../SignalingServer')|null} */
    this._server = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialises mediasoup workers.
   *
   * Must be called (and awaited) before {@link MediasoupAdapter#attach}.
   *
   * @returns {Promise<void>}
   * @throws {Error} If mediasoup is not installed.
   */
  async init() {
    if (!mediasoup) {
      throw new Error(
        "[MediasoupAdapter] mediasoup v3 is required. Install it: npm install mediasoup",
      );
    }

    for (let i = 0; i < this.numWorkers; i++) {
      const worker = await mediasoup.createWorker({
        rtcMinPort: this.rtcMinPort,
        rtcMaxPort: this.rtcMaxPort,
        logLevel: "warn",
      });

      worker.on("died", (err) => {
        console.error(
          `[MediasoupAdapter] Worker PID ${worker.pid} died:`,
          err?.message,
        );
        this._workers = this._workers.filter((w) => w !== worker);
        /**
         * @event MediasoupAdapter#worker:died
         * @param {import('mediasoup').types.Worker} worker
         */
        this.emit("worker:died", worker);
      });

      this._workers.push(worker);
    }

    console.log(`[MediasoupAdapter] ${this._workers.length} worker(s) started`);
  }

  /**
   * Terminates all mediasoup workers and clears internal state.
   *
   * @returns {Promise<void>}
   */
  async close() {
    for (const worker of this._workers) worker.close();
    this._workers = [];
    this._rooms.clear();
  }

  // ---------------------------------------------------------------------------
  // Attachment
  // ---------------------------------------------------------------------------

  /**
   * Attaches this adapter to a {@link SignalingServer}.
   *
   * Hooks into `room:created`, `room:destroyed`, `peer:joined`, and
   * `peer:left` events to manage mediasoup routers and WebRTC transports
   * automatically.
   *
   * SFU-specific client→server messages are sent as data relay messages with
   * a `__sfu` discriminator field (e.g. `{ type: 'data', payload: { __sfu: 'produce', ... } }`).
   *
   * @param {import('../SignalingServer')} server
   * @returns {this} Returns `this` for chaining.
   */
  attach(server) {
    this._server = server;

    server.on("room:created", async (room) => {
      try {
        await this._setupRoom(room.id);
      } catch (err) {
        console.error(
          `[MediasoupAdapter] Failed to set up room "${room.id}":`,
          err.message,
        );
      }
    });

    server.on("room:destroyed", (room) => {
      this._teardownRoom(room.id);
    });

    server.on("peer:joined", async (peer, room) => {
      try {
        await this._setupPeer(peer, room);
      } catch (err) {
        console.error(
          `[MediasoupAdapter] Failed to set up peer "${peer.id}":`,
          err.message,
        );
      }
    });

    server.on("peer:left", (peer) => {
      this._teardownPeer(peer.id);
    });

    // Listen for SFU-specific signals forwarded through the data relay.
    server.rooms.forEach((room) => {
      room.on("data", (fromPeer, _to, payload) => {
        if (payload?.__sfu) {
          this._handleSfuSignal(fromPeer, payload).catch((err) => {
            console.error(
              `[MediasoupAdapter] SFU signal error for peer "${fromPeer.id}":`,
              err.message,
            );
          });
        }
      });
    });

    return this;
  }

  // ---------------------------------------------------------------------------
  // Room management
  // ---------------------------------------------------------------------------

  /**
   * Creates a mediasoup Router for a room.
   *
   * @private
   * @param {string} roomId
   */
  async _setupRoom(roomId) {
    if (this._rooms.has(roomId)) return;

    const worker = this._nextWorker();
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });

    this._rooms.set(roomId, {
      router,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    });

    console.log(
      `[MediasoupAdapter] Router created for room "${roomId}" (worker ${worker.pid})`,
    );
  }

  /**
   * Closes the mediasoup Router for a room and removes all associated context.
   *
   * @private
   * @param {string} roomId
   */
  _teardownRoom(roomId) {
    const ctx = this._rooms.get(roomId);
    if (!ctx) return;
    ctx.router.close();
    this._rooms.delete(roomId);
    console.log(`[MediasoupAdapter] Router closed for room "${roomId}"`);
  }

  // ---------------------------------------------------------------------------
  // Peer management
  // ---------------------------------------------------------------------------

  /**
   * Creates send (upload) and receive (download) WebRTC transports for a peer
   * and sends the transport parameters to the browser via the signaling channel.
   *
   * @private
   * @param {import('../Peer')} peer
   * @param {import('../Room')} room
   */
  async _setupPeer(peer, room) {
    let ctx = this._rooms.get(room.id);
    if (!ctx) {
      await this._setupRoom(room.id);
      ctx = this._rooms.get(room.id);
    }

    const listenInfo = {
      protocol: "udp",
      ip: this.listenIp,
      ...(this.announcedIp ? { announcedIp: this.announcedIp } : {}),
    };

    const transportOptions = {
      listenInfos: [listenInfo],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
    };

    const [sendTransport, recvTransport] = await Promise.all([
      ctx.router.createWebRtcTransport(transportOptions),
      ctx.router.createWebRtcTransport(transportOptions),
    ]);

    ctx.transports.set(peer.id, { send: sendTransport, recv: recvTransport });

    // Send the router's RTP capabilities and both transport parameter objects
    // to the browser so mediasoup-client can connect.
    peer.send({
      type: "sfu:transport:created",
      routerRtpCapabilities: ctx.router.rtpCapabilities,
      sendTransport: this._serializeTransport(sendTransport),
      recvTransport: this._serializeTransport(recvTransport),
    });
  }

  /**
   * Closes all transports and consumers belonging to a peer.
   *
   * @private
   * @param {string} peerId
   */
  _teardownPeer(peerId) {
    for (const ctx of this._rooms.values()) {
      const transports = ctx.transports.get(peerId);
      if (transports) {
        transports.send.close();
        transports.recv.close();
        ctx.transports.delete(peerId);
      }

      for (const [key, consumer] of ctx.consumers) {
        if (key.startsWith(`${peerId}:`)) {
          consumer.close();
          ctx.consumers.delete(key);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // SFU signaling handler
  // ---------------------------------------------------------------------------

  /**
   * Processes an SFU-specific message forwarded through the data relay channel.
   *
   * Supported `payload.__sfu` values:
   * - `transport:connect`   — complete DTLS handshake for a transport
   * - `produce`             — publish a media track
   * - `consume`             — subscribe to a remote producer
   * - `consumer:resume`     — unpause a consumer after initial setup
   *
   * @private
   * @param {import('../Peer')} peer
   * @param {object}            payload
   */
  async _handleSfuSignal(peer, payload) {
    const room = this._server?.getRoom(peer.roomId);
    if (!room) return;

    const ctx = this._rooms.get(peer.roomId);
    if (!ctx) return;

    switch (payload.__sfu) {
      case "transport:connect": {
        const transports = ctx.transports.get(peer.id);
        if (!transports) return;
        const transport =
          payload.direction === "send" ? transports.send : transports.recv;
        await transport.connect({ dtlsParameters: payload.dtlsParameters });
        peer.send({
          type: "sfu:transport:connected",
          direction: payload.direction,
        });
        break;
      }

      case "produce": {
        const transports = ctx.transports.get(peer.id);
        if (!transports) return;

        const producer = await transports.send.produce({
          kind: payload.kind,
          rtpParameters: payload.rtpParameters,
        });

        ctx.producers.set(producer.id, producer);
        peer.send({ type: "sfu:produced", producerId: producer.id });

        // Notify everyone else about the new producer so they can subscribe.
        room.broadcast(
          {
            type: "sfu:new-producer",
            peerId: peer.id,
            producerId: producer.id,
            kind: payload.kind,
          },
          { exclude: peer.id },
        );
        break;
      }

      case "consume": {
        const producer = ctx.producers.get(payload.producerId);
        if (!producer) return;

        const transports = ctx.transports.get(peer.id);
        if (!transports) return;

        if (
          !ctx.router.canConsume({
            producerId: producer.id,
            rtpCapabilities: payload.rtpCapabilities,
          })
        ) {
          peer.send({
            type: "error",
            code: "SFU_CANNOT_CONSUME",
            producerId: producer.id,
          });
          return;
        }

        const consumer = await transports.recv.consume({
          producerId: producer.id,
          rtpCapabilities: payload.rtpCapabilities,
          paused: true, // browser resumes once it is ready
        });

        ctx.consumers.set(`${peer.id}:${producer.id}`, consumer);

        peer.send({
          type: "sfu:consume",
          consumerId: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
        break;
      }

      case "consumer:resume": {
        const consumer = ctx.consumers.get(`${peer.id}:${payload.producerId}`);
        if (consumer) await consumer.resume();
        break;
      }

      default:
        console.warn(
          `[MediasoupAdapter] Unknown SFU signal "__sfu: ${payload.__sfu}" from peer "${peer.id}"`,
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Round-robins across the available mediasoup workers.
   *
   * @private
   * @returns {import('mediasoup').types.Worker}
   * @throws {Error} If no workers are available.
   */
  _nextWorker() {
    if (this._workers.length === 0) {
      throw new Error(
        "[MediasoupAdapter] No workers available. Did you call init()?",
      );
    }
    const worker = this._workers[this._workerIndex % this._workers.length];
    this._workerIndex++;
    return worker;
  }

  /**
   * Extracts the fields a browser needs to create a matching transport via
   * `mediasoup-client`.
   *
   * @private
   * @param {import('mediasoup').types.WebRtcTransport} transport
   * @returns {{ id, iceParameters, iceCandidates, dtlsParameters }}
   */
  _serializeTransport(transport) {
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  /**
   * Returns a summary of all active SFU rooms and their resource usage.
   *
   * @returns {{ workers: number, rooms: Array<{ roomId, transports, producers, consumers }> }}
   */
  stats() {
    return {
      workers: this._workers.length,
      rooms: [...this._rooms.entries()].map(([roomId, ctx]) => ({
        roomId,
        transports: ctx.transports.size,
        producers: ctx.producers.size,
        consumers: ctx.consumers.size,
      })),
    };
  }
}

module.exports = MediasoupAdapter;
