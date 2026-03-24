"use strict";

/**
 * @file RoomToken.js
 * @description Signed JWT permission tokens for webrtc-rooms.
 *
 * Generates short-lived, signed tokens that encode a peer's room access
 * permissions. Tokens are verified automatically by `SignalingServer` when
 * `apiSecret` is configured — developers pass a secret once and never write
 * token-verification logic themselves.
 *
 * Uses HMAC-SHA256 (HS256) via Node.js built-in `crypto`. Zero external
 * dependencies.
 *
 * **Token payload**
 *
 * ```json
 * {
 *   "iss": "webrtc-rooms",
 *   "sub": "alice",
 *   "room": "standup",
 *   "pub": true,
 *   "sub_media": true,
 *   "meta": { "displayName": "Alice", "role": "admin" },
 *   "iat": 1700000000,
 *   "exp": 1700086400,
 *   "nbf": 1700000000
 * }
 * ```
 *
 * @module webrtc-rooms/auth/RoomToken
 *
 * @example
 * const { RoomToken } = require('webrtc-rooms');
 *
 * // Server-side: generate a token
 * const token = new RoomToken(process.env.API_SECRET)
 *   .forRoom('standup')
 *   .forPeer('alice')
 *   .canPublish()
 *   .canSubscribe()
 *   .withMetadata({ displayName: 'Alice', role: 'admin' })
 *   .expires('1h')
 *   .toJWT();
 *
 * // Client-side: send in the join message
 * ws.send(JSON.stringify({
 *   type: 'join',
 *   roomId: 'standup',
 *   metadata: { token },
 * }));
 *
 * // Server-side: verify automatically via createServer({ apiSecret })
 * const server = createServer({
 *   port: 3000,
 *   apiSecret: process.env.API_SECRET,
 * });
 */

const crypto = require("crypto");

/**
 * JWT header — base64url encoded. Constant for all tokens issued by this class.
 * @private
 */
const JWT_HEADER = Buffer.from(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
).toString("base64url");

/**
 * Parses a human-readable duration string into milliseconds.
 *
 * Supported units: `s` (seconds), `m` (minutes), `h` (hours), `d` (days).
 * A plain number is treated as seconds.
 *
 * @private
 * @param {string|number} value
 * @returns {number} Duration in milliseconds.
 * @throws {Error} If the format is unrecognised.
 */
function parseDuration(value) {
  if (typeof value === "number") return value * 1000;

  const match = String(value).match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    throw new Error(
      `[RoomToken] Invalid duration "${value}". ` +
        'Use a number (seconds) or a string like "30s", "15m", "1h", "7d".',
    );
  }

  const n = parseInt(match[1], 10);
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * units[match[2]];
}

/**
 * Encodes a value to base64url format.
 *
 * @private
 * @param {string} str
 * @returns {string}
 */
function base64url(str) {
  return Buffer.from(str).toString("base64url");
}

/**
 * Fluent builder for signed WebRTC room access tokens.
 *
 * @example
 * const token = new RoomToken('my-secret')
 *   .forRoom('engineering')
 *   .forPeer('user-123')
 *   .canPublish()
 *   .canSubscribe()
 *   .expires('8h')
 *   .toJWT();
 */
class RoomToken {
  /**
   * @param {string} apiSecret
   *   The shared secret used to sign and verify tokens. Must be at least
   *   32 characters for adequate security.
   * @throws {Error} If `apiSecret` is missing or too short.
   */
  constructor(apiSecret) {
    if (!apiSecret || typeof apiSecret !== "string") {
      throw new Error(
        "[RoomToken] apiSecret is required and must be a string.",
      );
    }
    if (apiSecret.length < 32) {
      throw new Error(
        "[RoomToken] apiSecret must be at least 32 characters. " +
          'Generate one with: require("crypto").randomBytes(32).toString("hex")',
      );
    }

    /** @private */
    this._secret = apiSecret;

    /** @private */
    this._claims = {
      iss: "webrtc-rooms",
      sub: null,
      room: null,
      pub: false,
      sub_media: false,
      meta: {},
      nbf: null,
    };

    /** @private — duration in ms, null = no expiry */
    this._ttlMs = parseDuration("24h");
  }

  // ---------------------------------------------------------------------------
  // Builder methods
  // ---------------------------------------------------------------------------

  /**
   * Sets the room this token grants access to.
   *
   * @param {string} roomId
   * @returns {this}
   */
  forRoom(roomId) {
    if (!roomId || typeof roomId !== "string") {
      throw new Error("[RoomToken] roomId must be a non-empty string.");
    }
    this._claims.room = roomId;
    return this;
  }

  /**
   * Sets the peer identity (subject) encoded in the token.
   * This value is available as `peer.metadata.tokenSub` after verification.
   *
   * @param {string} peerId
   * @returns {this}
   */
  forPeer(peerId) {
    if (!peerId || typeof peerId !== "string") {
      throw new Error("[RoomToken] peerId must be a non-empty string.");
    }
    this._claims.sub = peerId;
    return this;
  }

  /**
   * Grants publish permission (the peer may send audio/video tracks).
   * @returns {this}
   */
  canPublish() {
    this._claims.pub = true;
    return this;
  }

  /**
   * Grants subscribe permission (the peer may receive audio/video tracks).
   * @returns {this}
   */
  canSubscribe() {
    this._claims.sub_media = true;
    return this;
  }

  /**
   * Embeds arbitrary metadata into the token.
   * After verification, these fields are merged into `peer.metadata`.
   * Only primitive values are accepted (string, number, boolean).
   *
   * @param {Object.<string, string|number|boolean>} metadata
   * @returns {this}
   */
  withMetadata(metadata) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("[RoomToken] metadata must be a plain object.");
    }
    for (const [key, value] of Object.entries(metadata)) {
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw new Error(
          `[RoomToken] metadata value for key "${key}" must be a primitive (string, number, boolean).`,
        );
      }
    }
    this._claims.meta = { ...metadata };
    return this;
  }

  /**
   * Sets the token expiry.
   *
   * @param {string|number} duration
   *   A duration string (`"30s"`, `"15m"`, `"1h"`, `"7d"`) or a number of
   *   seconds. Pass `0` or `null` to create a non-expiring token (not
   *   recommended for production).
   * @returns {this}
   */
  expires(duration) {
    if (duration === 0 || duration === null) {
      this._ttlMs = null;
    } else {
      this._ttlMs = parseDuration(duration);
    }
    return this;
  }

  /**
   * Sets a "not before" time — the token is invalid before this point.
   *
   * @param {Date|number} time - A `Date` object or Unix timestamp in seconds.
   * @returns {this}
   */
  notBefore(time) {
    this._claims.nbf =
      time instanceof Date
        ? Math.floor(time.getTime() / 1000)
        : Math.floor(time);
    return this;
  }

  // ---------------------------------------------------------------------------
  // Token generation
  // ---------------------------------------------------------------------------

  /**
   * Signs and returns the JWT string.
   *
   * @returns {string} A compact JWT (`header.payload.signature`).
   * @throws {Error} If `forRoom()` or `forPeer()` has not been called.
   */
  toJWT() {
    if (!this._claims.room) {
      throw new Error("[RoomToken] Call .forRoom(roomId) before .toJWT().");
    }
    if (!this._claims.sub) {
      throw new Error("[RoomToken] Call .forPeer(peerId) before .toJWT().");
    }

    const now = Math.floor(Date.now() / 1000);

    const payload = {
      iss: this._claims.iss,
      sub: this._claims.sub,
      room: this._claims.room,
      pub: this._claims.pub,
      sub_media: this._claims.sub_media,
      meta: this._claims.meta,
      iat: now,
      ...(this._claims.nbf !== null ? { nbf: this._claims.nbf } : {}),
      ...(this._ttlMs !== null
        ? { exp: now + Math.floor(this._ttlMs / 1000) }
        : {}),
    };

    const encodedPayload = base64url(JSON.stringify(payload));
    const signingInput = `${JWT_HEADER}.${encodedPayload}`;
    const signature = crypto
      .createHmac("sha256", this._secret)
      .update(signingInput)
      .digest("base64url");

    return `${signingInput}.${signature}`;
  }

  // ---------------------------------------------------------------------------
  // Static verification
  // ---------------------------------------------------------------------------

  /**
   * Verifies a JWT and returns its decoded payload.
   *
   * Checks:
   * - HMAC-SHA256 signature
   * - `exp` claim (token not expired)
   * - `nbf` claim (token not used before valid time)
   * - `iss` claim must be `"webrtc-rooms"`
   *
   * @param {string} token      - The compact JWT string.
   * @param {string} apiSecret  - The secret used to sign the token.
   * @returns {{ sub: string, room: string, pub: boolean, sub_media: boolean, meta: object, iat: number, exp?: number }}
   * @throws {Error} If the token is invalid, expired, or tampered with.
   */
  static verify(token, apiSecret) {
    if (!token || typeof token !== "string") {
      throw new Error("[RoomToken] Token must be a non-empty string.");
    }

    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("[RoomToken] Malformed token: expected 3 parts.");
    }

    const [header, payload, signature] = parts;
    const signingInput = `${header}.${payload}`;
    const expectedSig = crypto
      .createHmac("sha256", apiSecret)
      .update(signingInput)
      .digest("base64url");

    // Constant-time comparison to prevent timing attacks.
    // timingSafeEqual requires equal-length buffers — if lengths differ the
    // signature is trivially invalid, but we still avoid an early-exit branch.
    const sigBuf = Buffer.from(signature, "utf8");
    const expBuf = Buffer.from(expectedSig, "utf8");
    const equal =
      sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

    if (!equal) {
      throw new Error("[RoomToken] Invalid signature.");
    }

    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new Error("[RoomToken] Malformed token payload.");
    }

    const now = Math.floor(Date.now() / 1000);

    if (claims.iss !== "webrtc-rooms") {
      throw new Error("[RoomToken] Invalid issuer.");
    }
    if (claims.exp !== undefined && now >= claims.exp) {
      throw new Error("[RoomToken] Token has expired.");
    }
    if (claims.nbf !== undefined && now < claims.nbf) {
      throw new Error("[RoomToken] Token is not yet valid.");
    }

    return claims;
  }

  /**
   * Convenience method: verifies a token and returns `null` instead of
   * throwing on failure. Useful in `beforeJoin` hooks.
   *
   * @param {string} token
   * @param {string} apiSecret
   * @returns {{ sub: string, room: string, pub: boolean, sub_media: boolean, meta: object }|null}
   */
  static verifyOrNull(token, apiSecret) {
    try {
      return RoomToken.verify(token, apiSecret);
    } catch {
      return null;
    }
  }
}

module.exports = RoomToken;
