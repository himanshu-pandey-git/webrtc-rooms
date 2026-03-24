"use strict";

/**
 * @file MediasoupAdapter.js
 * @description mediasoup v3 implementation of {@link SFUInterface}.
 *
 * Implements the full SFU contract using mediasoup's worker/router/transport
 * model. Workers are managed in a round-robin pool (one per CPU by default).
 * Each signaling room maps to a mediasoup Router. Each peer gets one WebRtcTransport
 * for sending and one for receiving.
 *
 * **Prerequisites**
 * - `npm install mediasoup` (optional peer dependency)
 * - Ports `rtcMinPort`–`rtcMaxPort` open in the firewall for UDP
 *
 * @module webrtc-rooms/sfu/MediasoupAdapter
 */

const os = require("os");
const SFUInterface = require("./SFUInterface");

/** @type {typeof import('mediasoup')} */
let mediasoup;

/**
 * @implements {SFUInterface}
 */
class MediasoupAdapter extends SFUInterface {
  /**
   * @param {import('../config/ConfigManager')} config
   */
  constructor(config) {
    super(config);

    const sfuCfg = config.get("sfu", {});

    /** @private */
    this._listenIp = sfuCfg.listenIp ?? "0.0.0.0";
    this._announcedIp = sfuCfg.announcedIp ?? null;
    this._rtcMinPort = sfuCfg.rtcMinPort ?? 10000;
    this._rtcMaxPort = sfuCfg.rtcMaxPort ?? 10200;
    this._numWorkers = sfuCfg.numWorkers ?? os.cpus().length;

    /** @private @type {import('mediasoup').types.Worker[]} */
    this._workers = [];

    /** @private @type {number} Round-robin index. */
    this._workerIdx = 0;

    /**
     * Maps roomId → { router, peers: Map<peerId, { sendTransport, recvTransport, producers, consumers }> }
     * @private @type {Map<string, object>}
     */
    this._rooms = new Map();
  }

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  get name() {
    return "mediasoup";
  }

  get version() {
    return mediasoup?.version ?? "unknown";
  }

  capabilities() {
    return new Set([
      SFUInterface.Capability.SIMULCAST,
      SFUInterface.Capability.SVC,
      SFUInterface.Capability.DATA_CHANNELS,
      SFUInterface.Capability.PRODUCER_STATS,
      SFUInterface.Capability.CONSUMER_CONTROL,
      SFUInterface.Capability.BANDWIDTH_LIMIT,
    ]);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async init() {
    try {
      mediasoup = require("mediasoup");
    } catch {
      throw new Error(
        "[MediasoupAdapter] mediasoup is not installed. Run: npm install mediasoup",
      );
    }

    console.log(`[MediasoupAdapter] Spawning ${this._numWorkers} worker(s)...`);

    for (let i = 0; i < this._numWorkers; i++) {
      const worker = await mediasoup.createWorker({
        rtcMinPort: this._rtcMinPort,
        rtcMaxPort: this._rtcMaxPort,
        logLevel: "warn",
        logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
      });

      worker.on("died", (err) => {
        console.error(
          `[MediasoupAdapter] Worker died — restarting:`,
          err?.message,
        );
        /**
         * @event MediasoupAdapter#sfu:worker:died
         * @param {{ workerId: number, error: Error }}
         */
        this.emit("sfu:worker:died", { workerId: worker.pid, error: err });
        this._replaceWorker(worker);
      });

      this._workers.push(worker);
    }

    this._initialised = true;
    console.log(
      `[MediasoupAdapter] Ready — ${this._numWorkers} worker(s) running`,
    );
  }

  async close() {
    this._closed = true;
    for (const worker of this._workers) {
      worker.close();
    }
    this._workers = [];
    this._rooms.clear();
  }

  // ---------------------------------------------------------------------------
  // Room management
  // ---------------------------------------------------------------------------

  async createRoom(roomId) {
    if (this._rooms.has(roomId)) return this._rooms.get(roomId);

    const worker = this._nextWorker();
    const router = await worker.createRouter({
      mediaCodecs: this._mediaCodecs(),
    });

    const room = { router, peers: new Map() };
    this._rooms.set(roomId, room);
    return room;
  }

  async closeRoom(roomId) {
    const room = this._rooms.get(roomId);
    if (!room) return;

    room.router.close();
    this._rooms.delete(roomId);
  }

  // ---------------------------------------------------------------------------
  // Peer / transport management
  // ---------------------------------------------------------------------------

  async createPeerTransports(peerId, roomId) {
    const room = this._rooms.get(roomId);
    if (!room) throw new Error(`[MediasoupAdapter] Room "${roomId}" not found`);

    const transportOptions = {
      listenIps: [{ ip: this._listenIp, announcedIp: this._announcedIp }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      enableSctp: true, // data channels
      numSctpStreams: { OS: 1024, MIS: 1024 },
    };

    const [sendTransport, recvTransport] = await Promise.all([
      room.router.createWebRtcTransport(transportOptions),
      room.router.createWebRtcTransport(transportOptions),
    ]);

    room.peers.set(peerId, {
      sendTransport,
      recvTransport,
      producers: new Map(),
      consumers: new Map(),
    });

    return {
      routerRtpCapabilities: room.router.rtpCapabilities,
      sendTransport: this._transportParams(sendTransport, "send"),
      recvTransport: this._transportParams(recvTransport, "recv"),
    };
  }

  async connectTransport(peerId, transportId, dtlsParameters) {
    const transport = this._findTransport(peerId, transportId);
    if (!transport)
      throw new Error(
        `[MediasoupAdapter] Transport "${transportId}" not found for peer "${peerId}"`,
      );
    await transport.connect({ dtlsParameters });
  }

  async closePeerTransports(peerId, roomId) {
    const room = this._rooms.get(roomId);
    if (!room) return;

    const peerState = room.peers.get(peerId);
    if (!peerState) return;

    peerState.sendTransport.close();
    peerState.recvTransport.close();
    room.peers.delete(peerId);
  }

  // ---------------------------------------------------------------------------
  // Producer / consumer management
  // ---------------------------------------------------------------------------

  async produce(peerId, roomId, { kind, rtpParameters, appData = {} }) {
    const room = this._rooms.get(roomId);
    if (!room) throw new Error(`[MediasoupAdapter] Room "${roomId}" not found`);

    const peerState = room.peers.get(peerId);
    if (!peerState)
      throw new Error(
        `[MediasoupAdapter] Peer "${peerId}" not found in room "${roomId}"`,
      );

    const producer = await peerState.sendTransport.produce({
      kind,
      rtpParameters,
      appData,
    });
    peerState.producers.set(producer.id, producer);

    producer.on("transportclose", () => {
      peerState.producers.delete(producer.id);
    });

    this.emit("sfu:producer:added", {
      peerId,
      roomId,
      producerId: producer.id,
      kind,
    });

    return { producerId: producer.id };
  }

  async consume(peerId, roomId, producerId, rtpCapabilities) {
    const room = this._rooms.get(roomId);
    if (!room) throw new Error(`[MediasoupAdapter] Room "${roomId}" not found`);

    const peerState = room.peers.get(peerId);
    if (!peerState)
      throw new Error(
        `[MediasoupAdapter] Peer "${peerId}" not found in room "${roomId}"`,
      );

    if (!room.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error(
        `[MediasoupAdapter] Peer "${peerId}" cannot consume producer "${producerId}" — incompatible RTP capabilities`,
      );
    }

    const consumer = await peerState.recvTransport.consume({
      producerId,
      rtpCapabilities,
      paused: true, // always start paused; client resumes explicitly
    });

    peerState.consumers.set(consumer.id, consumer);

    consumer.on("transportclose", () =>
      peerState.consumers.delete(consumer.id),
    );
    consumer.on("producerclose", () => {
      peerState.consumers.delete(consumer.id);
      this.emit("sfu:consumer:removed", {
        peerId,
        roomId,
        consumerId: consumer.id,
      });
    });

    this.emit("sfu:consumer:added", {
      peerId,
      roomId,
      consumerId: consumer.id,
      producerId,
    });

    return {
      consumerId: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      producerId,
    };
  }

  async pauseConsumer(peerId, consumerId) {
    const consumer = this._findConsumer(peerId, consumerId);
    if (consumer) await consumer.pause();
  }

  async resumeConsumer(peerId, consumerId) {
    const consumer = this._findConsumer(peerId, consumerId);
    if (consumer) await consumer.resume();
  }

  // ---------------------------------------------------------------------------
  // Statistics + health
  // ---------------------------------------------------------------------------

  async health() {
    const alive = this._workers.filter((w) => !w.closed).length;
    return {
      healthy: alive > 0,
      workers: alive,
      rooms: this._rooms.size,
      peers: [...this._rooms.values()].reduce(
        (sum, r) => sum + r.peers.size,
        0,
      ),
      load: alive > 0 ? this._rooms.size / alive : Infinity,
    };
  }

  async stats() {
    const rooms = [];
    for (const [roomId, room] of this._rooms) {
      const peers = [];
      for (const [peerId, peerState] of room.peers) {
        peers.push({
          peerId,
          producers: peerState.producers.size,
          consumers: peerState.consumers.size,
        });
      }
      rooms.push({ roomId, peers });
    }
    return { workers: this._workers.length, rooms };
  }

  async producerStats(producerId) {
    this._assertCapability(
      SFUInterface.Capability.PRODUCER_STATS,
      "producerStats",
    );
    for (const room of this._rooms.values()) {
      for (const peerState of room.peers.values()) {
        const producer = peerState.producers.get(producerId);
        if (producer) return producer.getStats();
      }
    }
    throw new Error(`[MediasoupAdapter] Producer "${producerId}" not found`);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** @private */
  _nextWorker() {
    const worker = this._workers[this._workerIdx % this._workers.length];
    this._workerIdx++;
    return worker;
  }

  /** @private */
  async _replaceWorker(deadWorker) {
    const idx = this._workers.indexOf(deadWorker);
    if (idx === -1) return;

    try {
      const newWorker = await mediasoup.createWorker({
        rtcMinPort: this._rtcMinPort,
        rtcMaxPort: this._rtcMaxPort,
        logLevel: "warn",
      });
      newWorker.on("died", (err) => {
        this.emit("sfu:worker:died", { workerId: newWorker.pid, error: err });
        this._replaceWorker(newWorker);
      });
      this._workers[idx] = newWorker;
      console.log(`[MediasoupAdapter] Worker replaced (pid: ${newWorker.pid})`);
    } catch (err) {
      console.error(
        `[MediasoupAdapter] Failed to replace worker:`,
        err.message,
      );
    }
  }

  /** @private */
  _transportParams(transport, direction) {
    return {
      id: transport.id,
      direction,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    };
  }

  /** @private */
  _findTransport(peerId, transportId) {
    for (const room of this._rooms.values()) {
      const peerState = room.peers.get(peerId);
      if (!peerState) continue;
      if (peerState.sendTransport.id === transportId)
        return peerState.sendTransport;
      if (peerState.recvTransport.id === transportId)
        return peerState.recvTransport;
    }
    return null;
  }

  /** @private */
  _findConsumer(peerId, consumerId) {
    for (const room of this._rooms.values()) {
      const peerState = room.peers.get(peerId);
      if (peerState?.consumers.has(consumerId)) {
        return peerState.consumers.get(consumerId);
      }
    }
    return null;
  }

  /** @private */
  _mediaCodecs() {
    return [
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
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
          "packetization-mode": 1,
          "profile-level-id": "4d0032",
          "level-asymmetry-allowed": 1,
          "x-google-start-bitrate": 1000,
        },
      },
    ];
  }
}

module.exports = MediasoupAdapter;
