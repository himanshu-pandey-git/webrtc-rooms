'use strict';

/**
 * @file Room.js
 * @description Multi-peer session that orchestrates WebRTC signaling,
 * data-channel relay, peer metadata synchronisation, and reconnection.
 *
 * @module webrtc-rooms/Room
 */

const { EventEmitter } = require('events');

/**
 * A Room holds a set of {@link Peer} instances and acts as the central message
 * bus for all WebRTC signaling happening between them.
 *
 * **Signaling flow**
 *
 * ```
 * Peer A                       Room                        Peer B
 *   │── { type:'offer',          │                            │
 *         target: B.id, sdp } ──►│── { type:'offer',          │
 *                                │    from: A.id, sdp } ─────►│
 *                                │◄── { type:'answer',        │
 *                                │     target: A.id, sdp } ───│
 *   │◄─ { type:'answer',         │                            │
 *         from: B.id, sdp } ─────│                            │
 *   │◄──────── ICE trickle ──────┼──────── ICE trickle ──────►│
 * ```
 *
 * Beyond signaling, the room also supports:
 * - **Data relay** — server-side broadcast/unicast for apps that need a
 *   fallback when a direct data channel is unavailable.
 * - **Metadata sync** — peers can update their own display name, mute state,
 *   or any other primitive key/value; changes are broadcast as deltas.
 * - **Reconnection** — dropped peers stay in the roster during the grace
 *   period and receive a full state snapshot on return.
 *
 * @extends EventEmitter
 *
 * @fires Room#peer:joined
 * @fires Room#peer:left
 * @fires Room#peer:updated
 * @fires Room#peer:reconnected
 * @fires Room#data
 * @fires Room#offer
 * @fires Room#answer
 * @fires Room#ice-candidate
 */
class Room extends EventEmitter {
  /**
   * Creates a new Room.
   *
   * @param {object}  options
   * @param {string}  options.id               - Unique room identifier.
   * @param {number}  [options.maxPeers=50]    - Maximum concurrent peers allowed.
   * @param {object}  [options.metadata={}]    - Initial room-level metadata.
   */
  constructor({ id, maxPeers = 50, metadata = {} }) {
    super();

    /**
     * Unique room identifier.
     * @type {string}
     */
    this.id = id;

    /**
     * Maximum number of peers allowed in this room simultaneously.
     * @type {number}
     */
    this.maxPeers = maxPeers;

    /**
     * Room-level metadata (topic, name, settings, etc.).
     * Updated via {@link Room#setMetadata}; changes are broadcast to all peers.
     * @type {Object.<string, *>}
     */
    this.metadata = { ...metadata };

    /**
     * Unix timestamp (ms) of when this room was created.
     * @type {number}
     */
    this.createdAt = Date.now();

    /**
     * All peers currently in this room, keyed by peer ID.
     * @type {Map<string, import('./Peer')>}
     */
    this.peers = new Map();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Delivers a message to a specific peer by ID.
   * Logs a warning if the target peer is not found in this room.
   *
   * @private
   * @param {string} targetId
   * @param {object} msg
   */
  _routeTo(targetId, msg) {
    const target = this.peers.get(targetId);
    if (!target) {
      console.warn(`[webrtc-rooms] Room "${this.id}": routeTo unknown peer "${targetId}"`);
      return;
    }
    target.send(msg);
  }

  /**
   * Attaches all signaling event handlers to a peer after it joins the room.
   *
   * @private
   * @param {import('./Peer')} peer
   */
  _bindPeerSignals(peer) {
    peer.on('signal', (msg) => this._handleSignal(peer, msg));
    peer.on('disconnect', () => this._removePeer(peer));
    peer.on('reconnected', () => this._onPeerReconnected(peer));
  }

  /**
   * Dispatches an incoming signaling message received from a peer.
   *
   * Recognised types:
   * - `offer`         — WebRTC SDP offer; forwarded to `msg.target`
   * - `answer`        — WebRTC SDP answer; forwarded to `msg.target`
   * - `ice-candidate` — ICE candidate; forwarded to `msg.target`
   * - `data`          — application payload; unicast to `msg.target` or
   *                     broadcast to the whole room if no target is set
   * - `metadata`      — peer metadata patch; validated and broadcast as delta
   * - `leave`         — voluntary leave; removes the peer from the room
   *
   * @private
   * @param {import('./Peer')} peer - The originating peer.
   * @param {object}           msg  - Parsed JSON message.
   */
  _handleSignal(peer, msg) {
    switch (msg.type) {

      // -----------------------------------------------------------------------
      // WebRTC signaling — offer / answer / ICE
      // -----------------------------------------------------------------------

      case 'offer': {
        if (!msg.target || !msg.sdp) {
          console.warn(`[webrtc-rooms] Room "${this.id}": malformed offer from "${peer.id}"`);
          return;
        }
        /**
         * @event Room#offer
         * @param {import('./Peer')} from   - Originating peer.
         * @param {string}           to     - Target peer ID.
         * @param {object}           sdp    - RTCSessionDescriptionInit.
         */
        this.emit('offer', peer, msg.target, msg.sdp);
        this._routeTo(msg.target, { type: 'offer', from: peer.id, sdp: msg.sdp });
        break;
      }

      case 'answer': {
        if (!msg.target || !msg.sdp) {
          console.warn(`[webrtc-rooms] Room "${this.id}": malformed answer from "${peer.id}"`);
          return;
        }
        /**
         * @event Room#answer
         * @param {import('./Peer')} from
         * @param {string}           to
         * @param {object}           sdp
         */
        this.emit('answer', peer, msg.target, msg.sdp);
        this._routeTo(msg.target, { type: 'answer', from: peer.id, sdp: msg.sdp });
        break;
      }

      case 'ice-candidate': {
        if (!msg.target || !msg.candidate) {
          console.warn(`[webrtc-rooms] Room "${this.id}": malformed ICE candidate from "${peer.id}"`);
          return;
        }
        /**
         * @event Room#ice-candidate
         * @param {import('./Peer')} from
         * @param {string}           to
         * @param {object}           candidate - RTCIceCandidateInit.
         */
        this.emit('ice-candidate', peer, msg.target, msg.candidate);
        this._routeTo(msg.target, {
          type: 'ice-candidate',
          from: peer.id,
          candidate: msg.candidate,
        });
        break;
      }

      // -----------------------------------------------------------------------
      // Data relay
      //
      // Provides a server-side relay for applications that cannot establish
      // a direct RTCDataChannel, or that prefer the simplicity of server
      // routing for low-frequency messages.
      //
      // Client sends:
      //   { type: 'data', payload: <any>, target?: <peerId> }
      //
      // Recipients receive:
      //   { type: 'data', from: <peerId>, payload: <any> }
      // -----------------------------------------------------------------------

      case 'data': {
        if (msg.payload === undefined) {
          peer.send({ type: 'error', code: 'MISSING_PAYLOAD' });
          return;
        }
        const outbound = { type: 'data', from: peer.id, payload: msg.payload };

        if (msg.target) {
          /**
           * @event Room#data
           * @param {import('./Peer')} from    - Sending peer.
           * @param {string|null}      to      - Target peer ID, or `null` for broadcast.
           * @param {*}                payload - Application payload.
           */
          this.emit('data', peer, msg.target, msg.payload);
          this._routeTo(msg.target, outbound);
        } else {
          this.emit('data', peer, null, msg.payload);
          this.broadcast(outbound, { exclude: peer.id });
        }
        break;
      }

      // -----------------------------------------------------------------------
      // Peer metadata update
      //
      // Allows a peer to update its own metadata (e.g. display name, mute
      // state). The server validates the patch, merges it, confirms back to
      // the sender, and broadcasts the delta to everyone else.
      //
      // Client sends:
      //   { type: 'metadata', patch: { key: value, ... } }
      //
      // Rules:
      //   - Keys must be strings.
      //   - Values must be strings, numbers, booleans, or null (to remove).
      //   - Nested objects are not permitted.
      // -----------------------------------------------------------------------

      case 'metadata': {
        if (!msg.patch || typeof msg.patch !== 'object' || Array.isArray(msg.patch)) {
          peer.send({ type: 'error', code: 'INVALID_METADATA_PATCH' });
          return;
        }

        for (const [key, value] of Object.entries(msg.patch)) {
          if (typeof key !== 'string') {
            peer.send({ type: 'error', code: 'INVALID_METADATA_KEY' });
            return;
          }
          if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
            peer.send({ type: 'error', code: 'INVALID_METADATA_VALUE', key });
            return;
          }
        }

        const updated = peer.setMetadata(msg.patch);
        /**
         * @event Room#peer:updated
         * @param {import('./Peer')} peer  - The peer whose metadata changed.
         * @param {object}           patch - The exact patch that was applied.
         */
        this.emit('peer:updated', peer, msg.patch);

        // Broadcast only the delta to avoid redundant data on large metadata objects.
        this.broadcast(
          { type: 'peer:updated', peerId: peer.id, patch: msg.patch },
          { exclude: peer.id },
        );

        // Confirm the full updated metadata back to the sender.
        peer.send({ type: 'metadata:updated', metadata: updated });
        break;
      }

      // -----------------------------------------------------------------------
      // Voluntary leave
      // -----------------------------------------------------------------------

      case 'leave':
        this._removePeer(peer);
        break;

      default:
        console.warn(
          `[webrtc-rooms] Room "${this.id}": unrecognised signal type "${msg.type}" from "${peer.id}"`,
        );
    }
  }

  /**
   * Removes a peer from the room, notifies all remaining peers, and emits
   * the `peer:left` event on the room.
   *
   * @private
   * @param {import('./Peer')} peer
   */
  _removePeer(peer) {
    if (!this.peers.has(peer.id)) return;

    this.peers.delete(peer.id);
    peer.roomId = null;

    this.broadcast({ type: 'peer:left', peerId: peer.id });

    /**
     * @event Room#peer:left
     * @param {import('./Peer')} peer - The peer that left.
     */
    this.emit('peer:left', peer);
  }

  /**
   * Called when a peer successfully reconnects within the grace period.
   * Sends the rejoining peer a full state snapshot and notifies other peers.
   *
   * @private
   * @param {import('./Peer')} peer
   */
  _onPeerReconnected(peer) {
    // Send the reconnecting peer a complete snapshot of the current room state.
    peer.send({
      type: 'room:state',
      roomId: this.id,
      peers: [...this.peers.values()]
        .filter((p) => p.id !== peer.id)
        .map((p) => p.toJSON()),
      metadata: this.metadata,
    });

    // Notify everyone else that this peer is back.
    this.broadcast(
      { type: 'peer:reconnected', peer: peer.toJSON() },
      { exclude: peer.id },
    );

    /**
     * @event Room#peer:reconnected
     * @param {import('./Peer')} peer - The peer that reconnected.
     */
    this.emit('peer:reconnected', peer);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Adds a peer to this room.
   *
   * Sends the joining peer a `room:joined` message containing the current
   * roster and room metadata, and announces the new peer to all existing
   * members via `peer:joined`.
   *
   * @param {import('./Peer')} peer - The peer to add.
   * @returns {boolean} `false` if the room is at capacity; `true` on success.
   */
  addPeer(peer) {
    if (this.peers.size >= this.maxPeers) {
      peer.send({ type: 'error', code: 'ROOM_FULL', roomId: this.id });
      return false;
    }

    peer.roomId = this.id;
    peer.state = require('./Peer').State.JOINED;

    peer.send({
      type: 'room:joined',
      roomId: this.id,
      peerId: peer.id,
      peers: [...this.peers.values()].map((p) => p.toJSON()),
      metadata: this.metadata,
      // Reconnect token is included so the client can persist it locally.
      ...(peer.reconnectToken ? { reconnectToken: peer.reconnectToken } : {}),
    });

    // Announce to existing members before adding to the map so the new peer
    // does not receive its own join announcement.
    this.broadcast({ type: 'peer:joined', peer: peer.toJSON() });

    this.peers.set(peer.id, peer);
    this._bindPeerSignals(peer);

    /**
     * @event Room#peer:joined
     * @param {import('./Peer')} peer - The peer that joined.
     */
    this.emit('peer:joined', peer);
    return true;
  }

  /**
   * Resumes a peer that is in the `RECONNECTING` state by swapping in a
   * fresh WebSocket. The peer's position in the room roster is preserved.
   *
   * Called internally by {@link SignalingServer} after a successful reconnect
   * token handshake. You should not normally need to call this directly.
   *
   * @param {import('./Peer')} peer      - The existing peer object (still in the map).
   * @param {object}           newSocket - The new `ws` WebSocket instance.
   * @returns {void}
   */
  resumePeer(peer, newSocket) {
    // replaceSocket() transitions state → JOINED, flushes the send queue,
    // rebinds socket events, and fires the 'reconnected' event on the peer,
    // which this room listens to via _bindPeerSignals.
    peer.replaceSocket(newSocket);
  }

  /**
   * Removes a peer from this room by ID.
   *
   * @param {string} peerId
   * @returns {void}
   */
  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) this._removePeer(peer);
  }

  /**
   * Sends a message to every peer in the room, optionally excluding one or
   * more peers by ID.
   *
   * @param {object}                              msg
   * @param {object}                              [options={}]
   * @param {string|string[]}                     [options.exclude=[]]
   *   A peer ID or array of peer IDs to skip.
   * @returns {void}
   *
   * @example
   * // Broadcast to everyone
   * room.broadcast({ type: 'server:announcement', text: 'Recording started.' });
   *
   * // Broadcast to everyone except the sender
   * room.broadcast({ type: 'data', from: peer.id, payload }, { exclude: peer.id });
   */
  broadcast(msg, { exclude = [] } = {}) {
    const excluded = new Set(Array.isArray(exclude) ? exclude : [exclude]);
    for (const peer of this.peers.values()) {
      if (!excluded.has(peer.id)) peer.send(msg);
    }
  }

  /**
   * Updates room-level metadata and immediately broadcasts a `room:updated`
   * message containing only the changed keys to all peers.
   *
   * @param {object} patch - Key/value pairs to merge into `this.metadata`.
   * @returns {void}
   *
   * @example
   * room.setMetadata({ topic: 'Q3 planning', recordingActive: true });
   */
  setMetadata(patch) {
    Object.assign(this.metadata, patch);
    this.broadcast({ type: 'room:updated', patch });
  }

  /**
   * Returns a complete snapshot of this room, including all current peers
   * and metadata. Useful for reconnecting peers and admin endpoints.
   *
   * @returns {{ id: string, metadata: object, peers: object[], createdAt: number }}
   */
  getState() {
    return {
      id: this.id,
      metadata: { ...this.metadata },
      peers: [...this.peers.values()].map((p) => p.toJSON()),
      createdAt: this.createdAt,
    };
  }

  /**
   * Number of peers currently in this room.
   * @type {number}
   * @readonly
   */
  get size() {
    return this.peers.size;
  }

  /**
   * `true` when the room has no peers.
   * @type {boolean}
   * @readonly
   */
  get isEmpty() {
    return this.peers.size === 0;
  }

  /**
   * Returns a concise serialisable representation of this room.
   * @returns {{ id: string, peerCount: number, createdAt: number, metadata: object }}
   */
  toJSON() {
    return {
      id: this.id,
      peerCount: this.peers.size,
      createdAt: this.createdAt,
      metadata: { ...this.metadata },
    };
  }
}

module.exports = Room;