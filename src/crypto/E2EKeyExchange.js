'use strict';

/**
 * @file E2EKeyExchange.js
 * @description End-to-end encryption key-exchange helpers for webrtc-rooms.
 *
 * **Overview**
 *
 * WebRTC media is encrypted by DTLS/SRTP at the transport layer, but that
 * encryption terminates at the SFU server when using `MediasoupAdapter`.
 * Applications that require true end-to-end encryption (E2EE) — where the
 * server never has access to plaintext media — need to layer an additional
 * encryption scheme on top.
 *
 * This module provides the signaling infrastructure for E2EE using the
 * **Insertable Streams API** (WebRTC Encoded Transform), which is supported
 * in Chrome, Edge, and Safari TP. Each peer generates an asymmetric key pair,
 * publishes its public key to the room, and derives a shared symmetric key
 * with each other peer using Elliptic Curve Diffie-Hellman (ECDH).
 *
 * **What this module handles (server-side)**
 *
 * - Routing public key announcements between peers through the signaling channel
 * - Key rotation — peers can publish a new public key at any time; the server
 *   forwards the rotation announcement to all room members
 * - Key revocation — when a peer leaves, the server notifies remaining peers
 *   so they can drop the shared key derived from the departing peer's public key
 *
 * **What this module does NOT handle**
 *
 * - Key generation (done in the browser using the Web Crypto API)
 * - ECDH shared-secret derivation (done in the browser)
 * - Media encryption/decryption (done in the browser via Insertable Streams)
 *
 * The server never sees private keys or derived shared secrets. Its only role
 * is authenticated key distribution.
 *
 * **Browser-side flow**
 *
 * ```
 * 1. Browser generates an ECDH key pair (P-256 or X25519).
 * 2. Browser exports the public key as a Base64-encoded SPKI buffer.
 * 3. Browser sends:
 *      { type: 'data', payload: { __e2e: 'key:announce', publicKey: '<base64>' } }
 * 4. Server (this module) validates the message, stores the key, and broadcasts
 *    it to all other peers in the room.
 * 5. Each browser receives the announcement and derives a shared secret with
 *    the new peer using ECDH.
 * 6. Media is encrypted with the shared secret via Insertable Streams before
 *    it reaches the WebRTC stack.
 * ```
 *
 * **Key rotation**
 *
 * ```
 * Browser sends:
 *   { type: 'data', payload: { __e2e: 'key:rotate', publicKey: '<base64-new>' } }
 *
 * Server broadcasts:
 *   { type: 'e2e:key:rotated', peerId, publicKey }
 *
 * Other browsers re-derive shared secrets with the new key.
 * ```
 *
 * @module webrtc-rooms/crypto/E2EKeyExchange
 *
 * @example
 * const { createServer, E2EKeyExchange } = require('webrtc-rooms');
 *
 * const server  = createServer({ port: 3000 });
 * const e2e     = new E2EKeyExchange({ server });
 * e2e.attach();
 *
 * e2e.on('key:announced', ({ peerId, roomId, publicKey }) => {
 *   console.log(`Peer ${peerId} published a public key in room ${roomId}`);
 * });
 */

const { EventEmitter } = require('events');

/**
 * Discriminator field name used to identify E2E messages inside the data relay.
 * @constant {string}
 */
const E2E_TAG = '__e2e';

/**
 * Maximum byte length of a Base64-encoded public key the server will accept.
 * A P-256 SPKI public key is ~124 bytes raw → ~168 Base64 chars.
 * X25519 is 32 bytes raw → ~44 Base64 chars.
 * We allow up to 512 chars to accommodate future curve sizes.
 * @constant {number}
 */
const MAX_PUBLIC_KEY_LENGTH = 512;

/**
 * Handles E2EE key-exchange signaling for a `SignalingServer`.
 *
 * Intercepts data-relay messages tagged with `__e2e`, validates them, stores
 * the peer's current public key, and routes announcements/rotations/revocations
 * to the correct recipients.
 *
 * The server stores public keys in memory only — they are never written to disk
 * or logged. Keys are evicted when the peer leaves the room.
 *
 * @extends EventEmitter
 *
 * @fires E2EKeyExchange#key:announced
 * @fires E2EKeyExchange#key:rotated
 * @fires E2EKeyExchange#key:revoked
 */
class E2EKeyExchange extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('../SignalingServer')} options.server
   *   The `SignalingServer` instance to attach to.
   * @param {boolean} [options.requireKeyOnJoin=false]
   *   When `true`, peers that do not send a `key:announce` within
   *   `keyAnnouncementTimeoutMs` after joining are kicked with an
   *   `E2E_KEY_REQUIRED` error. Use this to enforce E2EE in all rooms.
   * @param {number}  [options.keyAnnouncementTimeoutMs=10000]
   *   How long (ms) a peer has to announce its public key when
   *   `requireKeyOnJoin` is `true`. Ignored if `requireKeyOnJoin` is `false`.
   * @param {string[]} [options.allowedCurves=['P-256', 'X25519']]
   *   Allowed curve identifiers declared in key announcements. The server
   *   validates this field but does not verify the key cryptographically —
   *   browsers perform their own ECDH. Extend to add future curves.
   */
  constructor({
    server,
    requireKeyOnJoin            = false,
    keyAnnouncementTimeoutMs    = 10_000,
    allowedCurves               = ['P-256', 'X25519'],
  }) {
    super();

    if (!server) throw new Error('[E2EKeyExchange] options.server is required');

    this._server                     = server;
    this._requireKeyOnJoin           = requireKeyOnJoin;
    this._keyAnnouncementTimeoutMs   = keyAnnouncementTimeoutMs;
    this._allowedCurves              = new Set(allowedCurves);

    /**
     * In-memory public key store.
     * Structure: `Map<roomId, Map<peerId, PublicKeyEntry>>`
     *
     * Keys are scoped to a room so the same peer in different rooms can hold
     * different key pairs (though in practice most clients use one key pair).
     *
     * @private
     * @type {Map<string, Map<string, { publicKey: string, curve: string, announcedAt: number, version: number }>>}
     */
    this._roomKeys = new Map();

    /**
     * Pending enforcement timers: `peerId → NodeJS.Timeout`
     * Active only when `requireKeyOnJoin` is `true`.
     *
     * @private
     * @type {Map<string, ReturnType<typeof setTimeout>>}
     */
    this._enforcementTimers = new Map();

    /** @private */
    this._attached = false;
  }

  // ---------------------------------------------------------------------------
  // Attachment
  // ---------------------------------------------------------------------------

  /**
   * Attaches this adapter to the server.
   *
   * Hooks into:
   * - `peer:joined`  — optionally starts enforcement timer; sends existing
   *                    room keys to the new peer
   * - `peer:left`    — revokes the peer's key and notifies room members
   * - `room:created` — initialises the key store for the new room
   * - `room:destroyed`— clears the key store for the room
   * - Room `data` events — intercepts `__e2e` tagged payloads
   *
   * @returns {this} Returns `this` for chaining.
   */
  attach() {
    if (this._attached) return this;
    this._attached = true;

    this._server.on('room:created', (room) => {
      this._roomKeys.set(room.id, new Map());
      this._bindRoomDataEvent(room);
    });

    this._server.on('room:destroyed', (room) => {
      this._roomKeys.delete(room.id);
    });

    this._server.on('peer:joined', (peer, room) => {
      this._onPeerJoined(peer, room);
    });

    this._server.on('peer:left', (peer, room) => {
      this._onPeerLeft(peer, room);
    });

    // Attach to rooms that already exist.
    for (const room of this._server.rooms.values()) {
      if (!this._roomKeys.has(room.id)) {
        this._roomKeys.set(room.id, new Map());
      }
      this._bindRoomDataEvent(room);
    }

    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns the current public key entry for a peer in a specific room.
   *
   * @param {string} roomId
   * @param {string} peerId
   * @returns {{ publicKey: string, curve: string, announcedAt: number, version: number }|undefined}
   */
  getPeerKey(roomId, peerId) {
    return this._roomKeys.get(roomId)?.get(peerId);
  }

  /**
   * Returns all current public keys in a room as an array.
   * Useful for building a full key-set snapshot for late joiners.
   *
   * @param {string} roomId
   * @returns {Array<{ peerId: string, publicKey: string, curve: string, announcedAt: number, version: number }>}
   */
  getRoomKeys(roomId) {
    const store = this._roomKeys.get(roomId);
    if (!store) return [];
    return [...store.entries()].map(([peerId, entry]) => ({ peerId, ...entry }));
  }

  /**
   * Returns a summary of key-exchange state for all rooms.
   * Useful for admin tooling.
   *
   * @returns {Array<{ roomId: string, peerCount: number }>}
   */
  stats() {
    return [...this._roomKeys.entries()].map(([roomId, store]) => ({
      roomId,
      peerCount: store.size,
    }));
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  /**
   * @private
   */
  _onPeerJoined(peer, room) {
    // Send the joining peer a snapshot of all currently held public keys in the room.
    const existingKeys = this.getRoomKeys(room.id);
    if (existingKeys.length > 0) {
      peer.send({
        type:    'e2e:key:snapshot',
        roomId:  room.id,
        keys:    existingKeys,
      });
    }

    // Optionally enforce key announcement within a timeout.
    if (this._requireKeyOnJoin) {
      const timer = setTimeout(() => {
        const store = this._roomKeys.get(room.id);
        if (!store?.has(peer.id)) {
          peer.send({ type: 'error', code: 'E2E_KEY_REQUIRED', message: 'End-to-end encryption key is required.' });
          this._server.kick(peer.id, 'E2E key not announced in time');
        }
        this._enforcementTimers.delete(peer.id);
      }, this._keyAnnouncementTimeoutMs);

      this._enforcementTimers.set(peer.id, timer);
    }
  }

  /**
   * @private
   */
  _onPeerLeft(peer, room) {
    clearTimeout(this._enforcementTimers.get(peer.id));
    this._enforcementTimers.delete(peer.id);

    const store = this._roomKeys.get(room.id);
    if (!store?.has(peer.id)) return;

    const entry = store.get(peer.id);
    store.delete(peer.id);

    // Notify remaining room members so they can invalidate derived secrets.
    const remainingRoom = this._server.getRoom(room.id);
    if (remainingRoom) {
      remainingRoom.broadcast({
        type:    'e2e:key:revoked',
        roomId:  room.id,
        peerId:  peer.id,
      }, { exclude: peer.id });
    }

    /**
     * @event E2EKeyExchange#key:revoked
     * @param {{ peerId: string, roomId: string, entry: object }}
     */
    this.emit('key:revoked', { peerId: peer.id, roomId: room.id, entry });
  }

  /**
   * Listens to the Room's `data` event and routes `__e2e` tagged payloads.
   * A guard flag prevents double-binding if `attach()` is called multiple
   * times or if the room appears in both the `room:created` event and the
   * initial `rooms` scan.
   *
   * @private
   * @param {import('../Room')} room
   */
  _bindRoomDataEvent(room) {
    if (room.__e2eListenerAttached) return;
    room.__e2eListenerAttached = true;

    room.on('data', (fromPeer, _to, payload) => {
      if (!payload || payload[E2E_TAG] === undefined) return;
      this._handleE2EMessage(fromPeer, room, payload).catch((err) => {
        console.error(`[E2EKeyExchange] Error handling ${payload[E2E_TAG]} from "${fromPeer.id}":`, err.message);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Message dispatch
  // ---------------------------------------------------------------------------

  /**
   * Dispatches an E2E-tagged message to the appropriate handler.
   *
   * Recognised `__e2e` values:
   * - `key:announce` — peer is publishing its public key for the first time
   * - `key:rotate`   — peer is replacing its current public key with a new one
   * - `key:request`  — peer is requesting the current public key of another peer
   *
   * @private
   * @param {import('../Peer')} fromPeer
   * @param {import('../Room')} room
   * @param {object}            payload
   */
  async _handleE2EMessage(fromPeer, room, payload) {
    switch (payload[E2E_TAG]) {
      case 'key:announce':
        await this._handleKeyAnnounce(fromPeer, room, payload);
        break;

      case 'key:rotate':
        await this._handleKeyRotate(fromPeer, room, payload);
        break;

      case 'key:request':
        this._handleKeyRequest(fromPeer, room, payload);
        break;

      default:
        fromPeer.send({
          type:    'error',
          code:    'E2E_UNKNOWN_ACTION',
          message: `Unknown E2E action: "${payload[E2E_TAG]}"`,
        });
    }
  }

  /**
   * Handles `key:announce` — a peer publishing its public key for the first time.
   *
   * Validates the payload, stores the key, cancels any pending enforcement
   * timer, and broadcasts the announcement to all other room members.
   *
   * Expected payload:
   * ```json
   * { "__e2e": "key:announce", "publicKey": "<base64-spki>", "curve": "P-256" }
   * ```
   *
   * @private
   */
  async _handleKeyAnnounce(peer, room, payload) {
    const validation = this._validateKeyPayload(payload);
    if (!validation.valid) {
      peer.send({ type: 'error', code: 'E2E_INVALID_KEY', message: validation.reason });
      return;
    }

    const store = this._roomKeys.get(room.id);
    if (!store) return;

    if (store.has(peer.id)) {
      peer.send({ type: 'error', code: 'E2E_KEY_ALREADY_ANNOUNCED', message: 'Use key:rotate to replace an existing key.' });
      return;
    }

    const entry = {
      publicKey:   payload.publicKey,
      curve:       payload.curve ?? 'P-256',
      announcedAt: Date.now(),
      version:     1,
    };

    store.set(peer.id, entry);

    // Cancel enforcement timer if running.
    clearTimeout(this._enforcementTimers.get(peer.id));
    this._enforcementTimers.delete(peer.id);

    // Confirm to the announcing peer.
    peer.send({ type: 'e2e:key:confirmed', action: 'announced', version: 1 });

    // Broadcast to the room (excluding the sender — they already have their own key).
    room.broadcast({
      type:      'e2e:key:announced',
      roomId:    room.id,
      peerId:    peer.id,
      publicKey: entry.publicKey,
      curve:     entry.curve,
      version:   entry.version,
    }, { exclude: peer.id });

    /**
     * @event E2EKeyExchange#key:announced
     * @param {{ peerId: string, roomId: string, publicKey: string, curve: string }}
     */
    this.emit('key:announced', {
      peerId:    peer.id,
      roomId:    room.id,
      publicKey: entry.publicKey,
      curve:     entry.curve,
    });
  }

  /**
   * Handles `key:rotate` — a peer replacing its current public key.
   *
   * Key rotation is used when a peer wants to re-establish forward secrecy
   * (e.g. after a reconnect, on a fixed schedule, or after detecting a
   * potential compromise).
   *
   * Expected payload:
   * ```json
   * { "__e2e": "key:rotate", "publicKey": "<base64-spki-new>", "curve": "P-256" }
   * ```
   *
   * @private
   */
  async _handleKeyRotate(peer, room, payload) {
    const validation = this._validateKeyPayload(payload);
    if (!validation.valid) {
      peer.send({ type: 'error', code: 'E2E_INVALID_KEY', message: validation.reason });
      return;
    }

    const store = this._roomKeys.get(room.id);
    if (!store) return;

    const existing = store.get(peer.id);
    if (!existing) {
      peer.send({ type: 'error', code: 'E2E_KEY_NOT_ANNOUNCED', message: 'Announce an initial key with key:announce first.' });
      return;
    }

    const newVersion = existing.version + 1;
    const entry = {
      publicKey:   payload.publicKey,
      curve:       payload.curve ?? existing.curve,
      announcedAt: Date.now(),
      version:     newVersion,
    };

    store.set(peer.id, entry);

    peer.send({ type: 'e2e:key:confirmed', action: 'rotated', version: newVersion });

    room.broadcast({
      type:      'e2e:key:rotated',
      roomId:    room.id,
      peerId:    peer.id,
      publicKey: entry.publicKey,
      curve:     entry.curve,
      version:   newVersion,
    }, { exclude: peer.id });

    /**
     * @event E2EKeyExchange#key:rotated
     * @param {{ peerId: string, roomId: string, publicKey: string, curve: string, version: number }}
     */
    this.emit('key:rotated', {
      peerId:    peer.id,
      roomId:    room.id,
      publicKey: entry.publicKey,
      curve:     entry.curve,
      version:   newVersion,
    });
  }

  /**
   * Handles `key:request` — a peer requesting the public key of a specific
   * other peer (useful when joining after keys have already been exchanged).
   *
   * Expected payload:
   * ```json
   * { "__e2e": "key:request", "targetPeerId": "<peerId>" }
   * ```
   *
   * @private
   */
  _handleKeyRequest(peer, room, payload) {
    const { targetPeerId } = payload;

    if (!targetPeerId || typeof targetPeerId !== 'string') {
      peer.send({ type: 'error', code: 'E2E_INVALID_REQUEST', message: 'targetPeerId is required.' });
      return;
    }

    const store = this._roomKeys.get(room.id);
    const entry = store?.get(targetPeerId);

    if (!entry) {
      peer.send({
        type:         'e2e:key:not-found',
        targetPeerId,
        message:      'The requested peer has not announced a public key.',
      });
      return;
    }

    peer.send({
      type:         'e2e:key:response',
      targetPeerId,
      publicKey:    entry.publicKey,
      curve:        entry.curve,
      version:      entry.version,
      announcedAt:  entry.announcedAt,
    });
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Validates the `publicKey` and `curve` fields in an announce or rotate
   * payload. Does not perform cryptographic verification — that is the
   * browser's responsibility.
   *
   * @private
   * @param {object} payload
   * @returns {{ valid: boolean, reason?: string }}
   */
  _validateKeyPayload(payload) {
    if (!payload.publicKey || typeof payload.publicKey !== 'string') {
      return { valid: false, reason: 'publicKey must be a non-empty string.' };
    }

    if (payload.publicKey.length > MAX_PUBLIC_KEY_LENGTH) {
      return { valid: false, reason: `publicKey exceeds maximum length of ${MAX_PUBLIC_KEY_LENGTH} characters.` };
    }

    // Validate that the value is valid Base64 (standard or URL-safe).
    const base64Re = /^[A-Za-z0-9+/\-_]+=*$/;
    if (!base64Re.test(payload.publicKey)) {
      return { valid: false, reason: 'publicKey must be a Base64-encoded string.' };
    }

    if (payload.curve && !this._allowedCurves.has(payload.curve)) {
      return {
        valid:  false,
        reason: `Unsupported curve "${payload.curve}". Allowed: ${[...this._allowedCurves].join(', ')}.`,
      };
    }

    return { valid: true };
  }
}

module.exports = E2EKeyExchange;