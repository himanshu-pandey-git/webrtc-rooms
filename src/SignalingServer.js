'use strict';

/**
 * @file SignalingServer.js
 * @description Core WebSocket signaling server. Manages the full lifecycle of
 * rooms and peers, including join authentication, graceful reconnection, and
 * server-side administration utilities.
 *
 * @module webrtc-rooms/SignalingServer
 */

const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');
const Peer = require('./Peer');
const Room = require('./Room');

/**
 * The SignalingServer creates and manages a WebSocket server that handles all
 * WebRTC signaling between connected peers.
 *
 * It does **not** touch any media streams — audio and video travel directly
 * between browsers (P2P) or through an attached {@link MediasoupAdapter} (SFU).
 *
 * **Minimal example**
 *
 * ```js
 * const { createServer } = require('webrtc-rooms');
 *
 * const server = createServer({ port: 3000 });
 *
 * server.on('peer:joined', (peer, room) => {
 *   console.log(`${peer.metadata.displayName} joined "${room.id}"`);
 * });
 * ```
 *
 * **Wire protocol — client → server**
 *
 * | Message type      | Required fields              | Description                            |
 * |-------------------|------------------------------|----------------------------------------|
 * | `join`            | `roomId`, `metadata?`        | Enter (or create) a room               |
 * | `reconnect`       | `token`, `roomId`            | Resume a session after a socket drop   |
 * | `offer`           | `target`, `sdp`              | Forward SDP offer to a peer            |
 * | `answer`          | `target`, `sdp`              | Forward SDP answer to a peer           |
 * | `ice-candidate`   | `target`, `candidate`        | Forward ICE candidate to a peer        |
 * | `data`            | `payload`, `target?`         | Relay payload to a peer or the room    |
 * | `metadata`        | `patch`                      | Update own metadata                    |
 * | `leave`           | —                            | Voluntarily exit the room              |
 *
 * **Wire protocol — server → client**
 *
 * | Message type        | Description                                              |
 * |---------------------|----------------------------------------------------------|
 * | `connected`         | Peer ID assigned; sent immediately after WS opens        |
 * | `room:joined`       | Roster + metadata snapshot; sent to the joining peer     |
 * | `room:state`        | Full snapshot sent to a peer after a successful reconnect|
 * | `room:updated`      | Room metadata patch broadcast to all peers               |
 * | `peer:joined`       | Broadcast when a new peer enters the room                |
 * | `peer:left`         | Broadcast when a peer disconnects                        |
 * | `peer:updated`      | Broadcast when a peer's metadata changes                 |
 * | `peer:reconnected`  | Broadcast when a peer resumes after a socket drop        |
 * | `offer`             | Forwarded SDP offer                                      |
 * | `answer`            | Forwarded SDP answer                                     |
 * | `ice-candidate`     | Forwarded ICE candidate                                  |
 * | `data`              | Relayed application payload                              |
 * | `kicked`            | Sent to a peer before their connection is force-closed   |
 * | `error`             | Signaling or protocol error                              |
 *
 * @extends EventEmitter
 *
 * @fires SignalingServer#listening
 * @fires SignalingServer#peer:connected
 * @fires SignalingServer#peer:joined
 * @fires SignalingServer#peer:left
 * @fires SignalingServer#peer:reconnected
 * @fires SignalingServer#room:created
 * @fires SignalingServer#room:destroyed
 * @fires SignalingServer#join:rejected
 */
class SignalingServer extends EventEmitter {
  /**
   * Creates a new SignalingServer.
   *
   * @param {object}    [options={}]
   * @param {number}    [options.port=3000]
   *   Port to listen on. Ignored when `options.server` is provided.
   * @param {object}    [options.server=null]
   *   Attach to an existing `http.Server` (e.g. alongside an Express app).
   * @param {number}    [options.maxPeersPerRoom=50]
   *   Hard cap on concurrent peers per room.
   * @param {boolean}   [options.autoCreateRooms=true]
   *   When `true`, joining a non-existent room creates it automatically.
   *   Set to `false` if you want to pre-create all rooms via `createRoom()`.
   * @param {boolean}   [options.autoDestroyRooms=true]
   *   When `true`, empty rooms are destroyed automatically.
   * @param {number}    [options.pingInterval=30000]
   *   Interval in ms between WebSocket heartbeat pings.
   *   Connections that do not respond are terminated.
   * @param {number}    [options.reconnectTtl=0]
   *   Milliseconds a dropped peer's slot and reconnect token remain valid.
   *   `0` disables the reconnection feature entirely.
   * @param {Function}  [options.beforeJoin=null]
   *   Async hook called before a peer is admitted to a room.
   *   Receives `(peer, roomId)` and must return:
   *   - `true` (or any truthy value) to allow the join,
   *   - `false` to reject silently,
   *   - a `string` to reject with a human-readable reason.
   *
   *   The peer's metadata is already populated when this hook runs, so you
   *   can read `peer.metadata.token` (or any field sent by the client in the
   *   `join` message) for authentication.
   *
   *   @example
   *   beforeJoin: async (peer, roomId) => {
   *     const user = await db.verifyToken(peer.metadata.token);
   *     if (!user) return 'Invalid token';
   *     peer.setMetadata({ userId: user.id, displayName: user.name, token: null });
   *     return true;
   *   }
   */
  constructor({
    port = 3000,
    server = null,
    maxPeersPerRoom = 50,
    autoCreateRooms = true,
    autoDestroyRooms = true,
    pingInterval = 30_000,
    reconnectTtl = 0,
    beforeJoin = null,
  } = {}) {
    super();

    this.maxPeersPerRoom = maxPeersPerRoom;
    this.autoCreateRooms = autoCreateRooms;
    this.autoDestroyRooms = autoDestroyRooms;
    this.reconnectTtl = reconnectTtl;

    /**
     * Optional async auth hook. See constructor JSDoc for details.
     * @type {Function|null}
     */
    this.beforeJoin = beforeJoin;

    /**
     * All active rooms, keyed by room ID.
     * @type {Map<string, Room>}
     */
    this.rooms = new Map();

    /**
     * All connected peers, keyed by peer ID.
     * Peers that are in `RECONNECTING` state remain here during the grace period.
     * @type {Map<string, Peer>}
     */
    this.peers = new Map();

    /**
     * Active reconnect tokens mapped to their Peer instances.
     * Tokens are removed when they are used or when the grace period expires.
     *
     * @private
     * @type {Map<string, Peer>}
     */
    this._reconnectTokens = new Map();

    const wssOptions = server ? { server } : { port };
    this.wss = new WebSocketServer(wssOptions);

    this.wss.on('listening', () => {
      const addr = this.wss.address();
      console.log(`[webrtc-rooms] Signaling server listening on port ${addr.port}`);
      /**
       * @event SignalingServer#listening
       * @param {{ port: number }} address
       */
      this.emit('listening', addr);
    });

    this.wss.on('connection', (socket) => this._onConnection(socket));

    this._pingTimer = setInterval(() => this._heartbeat(), pingInterval);
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Handles a new incoming WebSocket connection.
   *
   * Assigns a fresh Peer, registers a reconnect token if the TTL is non-zero,
   * and waits for the peer's first message (`join` or `reconnect`).
   *
   * @private
   * @param {object} socket - Raw `ws` WebSocket instance.
   */
  _onConnection(socket) {
    const peer = new Peer({ id: uuidv4(), socket, reconnectTtl: this.reconnectTtl });

    this.peers.set(peer.id, peer);

    if (peer.reconnectToken) {
      this._reconnectTokens.set(peer.reconnectToken, peer);
    }

    // Immediately acknowledge the connection with the peer's assigned ID.
    peer.send({ type: 'connected', peerId: peer.id });

    /**
     * @event SignalingServer#peer:connected
     * @param {Peer} peer
     */
    this.emit('peer:connected', peer);

    // The very first message from a new peer must be either 'join' or
    // 'reconnect'. Any other type closes the connection immediately.
    peer.once('signal', (msg) => {
      if (msg.type === 'reconnect') {
        this._handleReconnect(peer, msg);
      } else if (msg.type === 'join') {
        this._handleJoin(peer, msg);
      } else {
        peer.send({
          type: 'error',
          code: 'MUST_JOIN_FIRST',
          message: 'First message must be { type: "join" } or { type: "reconnect" }.',
        });
        peer.close(1008, 'Protocol violation');
      }
    });

    peer.on('disconnect', () => {
      this.peers.delete(peer.id);

      // If the peer entered a reconnect window, keep the token index intact so
      // the grace period can still be exercised. Token cleanup occurs when the
      // TTL timer inside Peer fires and changes state to CLOSED.
      if (peer.state === Peer.State.RECONNECTING) return;

      if (peer.reconnectToken) {
        this._reconnectTokens.delete(peer.reconnectToken);
      }

      if (peer.roomId) {
        const room = this.rooms.get(peer.roomId);
        if (room) this._onPeerLeft(peer, room);
      }
    });

    // Tag the socket for heartbeat tracking.
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
  }

  // ---------------------------------------------------------------------------
  // Join flow
  // ---------------------------------------------------------------------------

  /**
   * Processes a `join` message from a peer, running the `beforeJoin` hook
   * if one is configured before adding the peer to the target room.
   *
   * @private
   * @param {Peer}   peer
   * @param {object} msg  - Parsed `join` signal.
   */
  async _handleJoin(peer, msg) {
    const { roomId } = msg;

    if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
      peer.send({ type: 'error', code: 'INVALID_ROOM_ID' });
      peer.close(1008, 'Invalid roomId');
      return;
    }

    // Populate metadata from the join message before the auth hook runs
    // so the hook can read fields like `token`, `displayName`, etc.
    if (msg.metadata && typeof msg.metadata === 'object' && !Array.isArray(msg.metadata)) {
      peer.setMetadata(msg.metadata);
    }

    if (this.beforeJoin) {
      let result;
      try {
        result = await this.beforeJoin(peer, roomId);
      } catch (err) {
        console.error('[webrtc-rooms] beforeJoin hook threw an error:', err);
        peer.send({ type: 'error', code: 'AUTH_ERROR', message: err.message });
        peer.close(1008, 'Auth error');
        return;
      }

      if (result === false || typeof result === 'string') {
        const reason = typeof result === 'string' ? result : 'Join rejected';
        peer.send({ type: 'error', code: 'JOIN_REJECTED', message: reason });
        /**
         * @event SignalingServer#join:rejected
         * @param {Peer}   peer
         * @param {string} reason
         */
        this.emit('join:rejected', peer, reason);
        peer.close(1008, reason);
        return;
      }
    }

    this._addPeerToRoom(peer, roomId);
  }

  /**
   * Looks up or creates the target room and adds the peer to it.
   *
   * @private
   * @param {Peer}   peer
   * @param {string} roomId
   */
  _addPeerToRoom(peer, roomId) {
    let room = this.rooms.get(roomId);

    if (!room) {
      if (!this.autoCreateRooms) {
        peer.send({ type: 'error', code: 'ROOM_NOT_FOUND', roomId });
        peer.close(1008, 'Room not found');
        return;
      }
      room = this._createRoom(roomId);
    }

    const joined = room.addPeer(peer);
    if (!joined) return; // Room full — the peer was already notified.

    /**
     * @event SignalingServer#peer:joined
     * @param {Peer} peer
     * @param {Room} room
     */
    this.emit('peer:joined', peer, room);
  }

  // ---------------------------------------------------------------------------
  // Reconnection flow
  // ---------------------------------------------------------------------------

  /**
   * Handles a `reconnect` message from a fresh socket.
   *
   * If the token is valid and the grace period is still active, the new
   * socket is spliced into the existing Peer without removing it from the
   * room. If the token is invalid or has expired, the peer falls back to a
   * normal join.
   *
   * @private
   * @param {Peer}   tempPeer - The newly created Peer wrapping the fresh socket.
   * @param {object} msg      - Parsed `reconnect` signal.
   */
  _handleReconnect(tempPeer, msg) {
    const { token, roomId } = msg;

    if (!token) {
      return this._handleJoin(tempPeer, { ...msg, type: 'join' });
    }

    const existingPeer = this._reconnectTokens.get(token);

    if (!existingPeer || existingPeer.state !== Peer.State.RECONNECTING) {
      tempPeer.send({ type: 'error', code: 'RECONNECT_TOKEN_INVALID' });
      return this._handleJoin(tempPeer, { ...msg, type: 'join' });
    }

    const room = this.rooms.get(existingPeer.roomId || roomId);
    if (!room) {
      tempPeer.send({ type: 'error', code: 'ROOM_GONE' });
      return this._handleJoin(tempPeer, { ...msg, type: 'join' });
    }

    // Discard the temporary peer that wrapped the new socket.
    this._reconnectTokens.delete(token);
    this.peers.delete(tempPeer.id);
    // Re-register the existing peer (it may have been removed from this.peers
    // by the disconnect handler between socket drop and reconnect).
    this.peers.set(existingPeer.id, existingPeer);

    // Transfer the new socket to the existing peer.
    room.resumePeer(existingPeer, tempPeer.socket);

    /**
     * @event SignalingServer#peer:reconnected
     * @param {Peer} peer
     * @param {Room} room
     */
    this.emit('peer:reconnected', existingPeer, room);
  }

  // ---------------------------------------------------------------------------
  // Room lifecycle
  // ---------------------------------------------------------------------------

  /**
   * @private
   * @param {Peer} peer
   * @param {Room} room
   */
  _onPeerLeft(peer, room) {
    /**
     * @event SignalingServer#peer:left
     * @param {Peer} peer
     * @param {Room} room
     */
    this.emit('peer:left', peer, room);

    if (this.autoDestroyRooms && room.isEmpty) {
      this._destroyRoom(room);
    }
  }

  /**
   * Instantiates a Room, wires up event bubbling, and registers it.
   *
   * @private
   * @param {string} id
   * @param {object} [opts={}]
   * @param {object} [opts.metadata={}]
   * @returns {Room}
   */
  _createRoom(id, { metadata = {} } = {}) {
    const room = new Room({ id, maxPeers: this.maxPeersPerRoom, metadata });

    room.on('peer:left', (peer) => this._onPeerLeft(peer, room));
    room.on('peer:reconnected', (peer) => this.emit('peer:reconnected', peer, room));

    this.rooms.set(id, room);
    /**
     * @event SignalingServer#room:created
     * @param {Room} room
     */
    this.emit('room:created', room);
    console.log(`[webrtc-rooms] Room created: "${id}"`);
    return room;
  }

  /**
   * @private
   * @param {Room} room
   */
  _destroyRoom(room) {
    this.rooms.delete(room.id);
    /**
     * @event SignalingServer#room:destroyed
     * @param {Room} room
     */
    this.emit('room:destroyed', room);
    console.log(`[webrtc-rooms] Room destroyed: "${room.id}"`);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Creates a room programmatically.
   *
   * If a room with the given ID already exists, the existing instance is
   * returned without modification.
   *
   * @param {string} [roomId]          - Custom ID. Auto-generated if omitted.
   * @param {object} [options={}]
   * @param {object} [options.metadata={}] - Initial room-level metadata.
   * @returns {Room}
   *
   * @example
   * const room = server.createRoom('standup', { metadata: { topic: 'Daily standup' } });
   */
  createRoom(roomId = uuidv4(), options = {}) {
    if (this.rooms.has(roomId)) return this.rooms.get(roomId);
    return this._createRoom(roomId, options);
  }

  /**
   * Returns the Room instance for the given ID, or `undefined` if it does
   * not exist.
   *
   * @param {string} roomId
   * @returns {Room|undefined}
   */
  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  /**
   * Forcibly removes a peer from their room and closes their connection.
   *
   * The peer receives a `kicked` message with the provided reason before
   * the socket is closed.
   *
   * @param {string} peerId
   * @param {string} [reason='Kicked by server']
   * @returns {void}
   *
   * @example
   * server.kick(peer.id, 'Behaviour policy violation');
   */
  kick(peerId, reason = 'Kicked by server') {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    peer.send({ type: 'kicked', reason });
    peer.close(1008, reason);

    if (peer.roomId) {
      const room = this.rooms.get(peer.roomId);
      if (room) room.removePeer(peerId);
    }
  }

  /**
   * Returns a lightweight snapshot of the server's current state.
   * Intended for health checks and admin dashboards.
   *
   * @returns {{ rooms: number, peers: number, roomList: object[] }}
   *
   * @example
   * app.get('/health', (req, res) => res.json(server.stats()));
   */
  stats() {
    return {
      rooms: this.rooms.size,
      peers: this.peers.size,
      roomList: [...this.rooms.values()].map((r) => r.toJSON()),
    };
  }

  /**
   * Gracefully closes the signaling server.
   *
   * Sends a `1001 Going Away` close frame to every connected peer, then
   * shuts down the underlying WebSocketServer.
   *
   * @returns {Promise<void>}
   */
  close() {
    clearInterval(this._pingTimer);
    for (const peer of this.peers.values()) {
      peer.close(1001, 'Server shutting down');
    }
    return new Promise((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  /**
   * Sends a WebSocket ping to every client.
   * Clients that do not respond with a pong before the next interval are
   * terminated.
   *
   * @private
   */
  _heartbeat() {
    for (const socket of this.wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }
}

module.exports = SignalingServer;