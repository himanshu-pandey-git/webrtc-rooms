'use strict';

/**
 * @file index.js
 * @description Public entry point for webrtc-rooms.
 *
 * @example
 * const {
 *   createServer,
 *   SignalingServer,
 *   Room,
 *   Peer,
 *   RecordingAdapter,
 *   MediasoupAdapter,
 *   RateLimiter,
 *   AdminAPI,
 * } = require('webrtc-rooms');
 */

const SignalingServer  = require('./SignalingServer');
const Room             = require('./Room');
const Peer             = require('./Peer');
const AdminAPI         = require('./AdminAPI');
const RecordingAdapter = require('./adapters/RecordingAdapter');
const MediasoupAdapter = require('./adapters/MediasoupAdapter');
const RedisAdapter     = require('./adapters/RedisAdapter');
const RoomPersistence  = require('./adapters/RoomPersistence');
const RateLimiter      = require('./middleware/RateLimiter');
const E2EKeyExchange   = require('./crypto/E2EKeyExchange');

/**
 * Creates and returns a new {@link SignalingServer} instance.
 *
 * This is the recommended entry point for most applications.
 *
 * @param {import('./SignalingServer').SignalingServerOptions} [options={}]
 * @returns {SignalingServer}
 *
 * @example
 * const { createServer } = require('webrtc-rooms');
 *
 * const server = createServer({
 *   port: 3000,
 *   beforeJoin: async (peer, roomId) => {
 *     const user = await db.verifyToken(peer.metadata.token);
 *     if (!user) return 'Invalid token';
 *     peer.setMetadata({ userId: user.id, displayName: user.name, token: null });
 *     return true;
 *   },
 * });
 *
 * server.on('peer:joined', (peer, room) => {
 *   console.log(`${peer.metadata.displayName} joined "${room.id}"`);
 * });
 */
function createServer(options = {}) {
  return new SignalingServer(options);
}

module.exports = {
  // Factory
  createServer,

  // Core classes (exposed for advanced use / extension)
  SignalingServer,
  Room,
  Peer,

  // Adapters
  RecordingAdapter,
  MediasoupAdapter,
  RedisAdapter,
  RoomPersistence,

  // Middleware
  RateLimiter,

  // Crypto
  E2EKeyExchange,

  // Admin
  AdminAPI,
};