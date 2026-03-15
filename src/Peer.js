'use strict';

/**
 * @file Peer.js
 * @description Represents a single WebSocket-connected WebRTC peer.
 *
 * Each peer has a state machine, an outbound send queue for resilient
 * reconnection, and a metadata store for arbitrary application-level data
 * such as display names, user IDs, and role flags.
 *
 * @module webrtc-rooms/Peer
 */

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

/**
 * All possible states a peer can be in throughout its lifecycle.
 *
 * @readonly
 * @enum {string}
 */
const PeerState = Object.freeze({
  /** WebSocket is open but the peer has not yet joined a room. */
  CONNECTING: 'connecting',

  /** Peer is inside a room and fully active. */
  JOINED: 'joined',

  /**
   * The peer's socket dropped, but the reconnect grace period is still active.
   * Messages sent during this window are queued and flushed on reconnect.
   */
  RECONNECTING: 'reconnecting',

  /** Peer has permanently disconnected or been kicked. */
  CLOSED: 'closed',
});

/**
 * Maximum number of outbound messages buffered during a reconnect window.
 * Messages beyond this limit are silently dropped to prevent unbounded growth.
 *
 * @constant {number}
 */
const SEND_QUEUE_MAX = 32;

/**
 * Represents a single connected WebRTC peer.
 *
 * @extends EventEmitter
 *
 * @example
 * // Peers are created automatically by SignalingServer on each WebSocket
 * // connection. You typically interact with them through server events.
 *
 * server.on('peer:joined', (peer, room) => {
 *   console.log(peer.id, peer.metadata.displayName);
 *
 *   peer.send({ type: 'welcome', message: 'Hello!' });
 *
 *   peer.on('disconnect', () => {
 *     console.log(peer.id, 'left');
 *   });
 * });
 *
 * @fires Peer#signal
 * @fires Peer#disconnect
 * @fires Peer#reconnected
 */
class Peer extends EventEmitter {
  /**
   * Creates a new Peer instance.
   *
   * @param {object}    options
   * @param {string}    options.id              - Unique peer ID (UUID v4).
   * @param {object}    options.socket          - Raw `ws` WebSocket instance.
   * @param {string}    [options.roomId=null]   - Room the peer belongs to; set on join.
   * @param {object}    [options.metadata={}]   - Initial application-level metadata.
   * @param {number}    [options.reconnectTtl=0]
   *   Milliseconds the reconnect token remains valid after a socket drop.
   *   `0` disables reconnection support entirely.
   */
  constructor({ id, socket, roomId = null, metadata = {}, reconnectTtl = 0 }) {
    super();

    /**
     * Unique peer identifier (UUID v4).
     * @type {string}
     */
    this.id = id;

    /**
     * The underlying `ws` WebSocket instance.
     * @type {object}
     */
    this.socket = socket;

    /**
     * ID of the room this peer currently occupies, or `null` if not in a room.
     * @type {string|null}
     */
    this.roomId = roomId;

    /**
     * Unix timestamp (ms) of when this peer first connected.
     * @type {number}
     */
    this.connectedAt = Date.now();

    /**
     * Current lifecycle state of this peer.
     * @type {PeerState}
     */
    this.state = PeerState.CONNECTING;

    /**
     * Arbitrary application-level key/value data.
     * Only primitive values (`string`, `number`, `boolean`) are allowed.
     * Set `null` for a key to remove it.
     *
     * @type {Object.<string, string|number|boolean>}
     *
     * @example
     * peer.setMetadata({ displayName: 'Alice', role: 'moderator', score: 100 });
     */
    this.metadata = { ...metadata };

    /**
     * One-time token issued to this peer so it can resume a session after an
     * unexpected disconnect. `null` when reconnection is disabled.
     *
     * This value is sent to the browser in the `room:joined` message and must
     * never be logged or broadcast to other peers.
     *
     * @type {string|null}
     */
    this.reconnectToken = reconnectTtl > 0 ? uuidv4() : null;

    /** @private */
    this._reconnectTtl = reconnectTtl;

    /** @private @type {ReturnType<typeof setTimeout>|null} */
    this._reconnectTimer = null;

    /** @private @type {object[]} */
    this._sendQueue = [];

    this._bindSocketEvents();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Wires up the three core WebSocket event handlers.
   * Called once on construction and again after `replaceSocket()`.
   *
   * @private
   */
  _bindSocketEvents() {
    this.socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        // Non-JSON frames are silently ignored to keep the stream clean.
        return;
      }
      /**
       * Emitted when a raw signaling message arrives from the remote peer.
       *
       * @event Peer#signal
       * @type {object} msg - Parsed JSON message from the peer.
       */
      this.emit('signal', msg);
    });

    this.socket.on('close', () => {
      if (this.state === PeerState.CLOSED) return;

      if (this.reconnectToken && this._reconnectTtl > 0) {
        // Enter the reconnect grace period.
        // The peer stays in the room roster and messages are queued.
        this.state = PeerState.RECONNECTING;
        this._reconnectTimer = setTimeout(() => {
          this.reconnectToken = null;
          this.state = PeerState.CLOSED;
          /**
           * Emitted when the peer is permanently disconnected — either
           * because the socket closed with no reconnect TTL, or the grace
           * period expired without a successful reconnect.
           *
           * @event Peer#disconnect
           */
          this.emit('disconnect');
        }, this._reconnectTtl);
      } else {
        this.state = PeerState.CLOSED;
        this.emit('disconnect');
      }
    });

    this.socket.on('error', (err) => {
      // Surface the error and let the close handler manage state transitions.
      this.emit('error', err);
      this.socket.terminate?.();
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Sends a JSON-serialisable message to this peer.
   *
   * - If the socket is open, the message is sent immediately.
   * - If the peer is in `RECONNECTING` state, the message is queued
   *   and flushed automatically once the peer reconnects (up to
   *   {@link SEND_QUEUE_MAX} messages).
   * - In all other states the message is silently dropped.
   *
   * @param {object} msg - Must be JSON-serialisable.
   * @returns {void}
   */
  send(msg) {
    if (this.state === PeerState.RECONNECTING) {
      if (this._sendQueue.length < SEND_QUEUE_MAX) {
        this._sendQueue.push(msg);
      }
      return;
    }

    if (this.socket.readyState !== 1 /* WebSocket.OPEN */) return;

    try {
      this.socket.send(JSON.stringify(msg));
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Swaps in a fresh WebSocket after a successful reconnect.
   *
   * Clears the grace-period timer, rebinds socket event handlers, transitions
   * state back to `JOINED`, and flushes all queued messages.
   *
   * This method is called by {@link Room#resumePeer} and should not normally
   * be called directly.
   *
   * @param {object} newSocket - A freshly opened `ws` WebSocket instance.
   * @returns {void}
   *
   * @fires Peer#reconnected
   */
  replaceSocket(newSocket) {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this.socket = newSocket;
    this.state = PeerState.JOINED;
    this._bindSocketEvents();

    const queued = this._sendQueue.splice(0);
    for (const msg of queued) this.send(msg);

    /**
     * Emitted after `replaceSocket()` completes and all queued messages
     * have been flushed.
     *
     * @event Peer#reconnected
     */
    this.emit('reconnected');
  }

  /**
   * Merges a patch object into this peer's metadata.
   *
   * Rules:
   * - Existing keys are overwritten by the patch.
   * - Setting a key to `null` removes it entirely.
   * - Only `string`, `number`, and `boolean` values are accepted.
   *   Pass-through validation of value types is the caller's responsibility;
   *   this method does not throw on invalid types.
   *
   * @param {Object.<string, string|number|boolean|null>} patch
   * @returns {Object.<string, string|number|boolean>} The updated metadata object.
   *
   * @example
   * peer.setMetadata({ displayName: 'Alice', role: 'admin' });
   * peer.setMetadata({ role: null }); // removes 'role' key
   */
  setMetadata(patch) {
    Object.assign(this.metadata, patch);
    for (const [key, value] of Object.entries(this.metadata)) {
      if (value === null) delete this.metadata[key];
    }
    return this.metadata;
  }

  /**
   * Closes the underlying WebSocket connection permanently.
   *
   * Cancels any pending reconnect timer and sets state to `CLOSED`.
   *
   * @param {number} [code=1000]   - WebSocket close code.
   * @param {string} [reason='']  - Optional human-readable close reason.
   * @returns {void}
   */
  close(code = 1000, reason = '') {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this.reconnectToken = null;
    this.state = PeerState.CLOSED;
    this.socket.close(code, reason);
  }

  /**
   * `true` when the peer is in the `JOINED` state (inside a room and active).
   *
   * @type {boolean}
   * @readonly
   */
  get isActive() {
    return this.state === PeerState.JOINED;
  }

  /**
   * Returns a plain-object representation of this peer safe to serialise and
   * send to other peers over the wire.
   *
   * The `reconnectToken` is deliberately excluded.
   *
   * @returns {{ id: string, roomId: string|null, state: string, metadata: object }}
   */
  toJSON() {
    return {
      id: this.id,
      roomId: this.roomId,
      state: this.state,
      metadata: { ...this.metadata },
    };
  }
}

/**
 * Peer state constants, exposed as a static property for convenient use.
 *
 * @type {PeerState}
 * @static
 *
 * @example
 * if (peer.state === Peer.State.RECONNECTING) { ... }
 */
Peer.State = PeerState;

module.exports = Peer;