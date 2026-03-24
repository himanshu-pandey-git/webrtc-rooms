"use strict";

/**
 * @file TurnCredentials.js
 * @description Short-lived TURN credential generator compatible with coturn's
 * REST API authentication scheme.
 *
 * Generates per-peer HMAC-SHA1 credentials that expire automatically. Works
 * with any coturn-compatible TURN server including coturn, Cloudflare Calls,
 * Metered TURN, and Twilio Network Traversal Service.
 *
 * **How it works**
 *
 * coturn's REST API format uses a time-limited username and an HMAC-SHA1
 * password derived from that username and a shared secret:
 *
 * ```
 * username = "<expiry_unix_timestamp>:<peerId>"
 * password = base64(HMAC-SHA1(secret, username))
 * ```
 *
 * The TURN server independently verifies the password using the same secret.
 * No round-trip to the TURN server is needed — credentials are generated
 * entirely in-process.
 *
 * @module webrtc-rooms/turn/TurnCredentials
 *
 * @example
 * const { createServer, TurnCredentials } = require('webrtc-rooms');
 *
 * const server = createServer({
 *   port: 3000,
 *   turn: {
 *     secret: process.env.TURN_SECRET,
 *     urls:   ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'],
 *     ttl:    86400, // 24 hours (default)
 *   },
 * });
 *
 * // Credentials are injected automatically into room:joined as `iceServers`.
 * // The client passes them straight to RTCPeerConnection:
 * //
 * // ws.onmessage = ({ data }) => {
 * //   const msg = JSON.parse(data);
 * //   if (msg.type === 'room:joined') {
 * //     const pc = new RTCPeerConnection({ iceServers: msg.iceServers });
 * //   }
 * // };
 */

const crypto = require("crypto");

/**
 * Default credential TTL in seconds (24 hours).
 * @constant {number}
 */
const DEFAULT_TTL_SECONDS = 86_400;

/**
 * Generates and validates short-lived TURN credentials using the coturn
 * REST API authentication scheme (HMAC-SHA1).
 */
class TurnCredentials {
  /**
   * @param {object} options
   * @param {string}   options.secret
   *   The TURN shared secret configured on your coturn server
   *   (`static-auth-secret` in coturn.conf).
   * @param {string[]} options.urls
   *   TURN server URLs, e.g. `['turn:turn.example.com:3478', 'turns:turn.example.com:5349']`.
   * @param {number}  [options.ttl=86400]
   *   Credential lifetime in seconds. Defaults to 24 hours.
   *   Should match or be less than coturn's `--userdb-timeout`.
   * @throws {Error} If `secret` or `urls` are missing.
   */
  constructor({ secret, urls, ttl = DEFAULT_TTL_SECONDS }) {
    if (!secret || typeof secret !== "string") {
      throw new Error("[TurnCredentials] options.secret is required.");
    }
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error(
        "[TurnCredentials] options.urls must be a non-empty array.",
      );
    }

    this._secret = secret;
    this._urls = urls;
    this._ttl = ttl;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Generates a fresh set of TURN credentials for a specific peer.
   *
   * The returned object is a valid `RTCIceServer` entry and can be passed
   * directly inside an `iceServers` array to `RTCPeerConnection`.
   *
   * @param {string} peerId - Peer identifier embedded in the username for
   *   auditability on the TURN server side.
   * @returns {{ urls: string[], username: string, credential: string, ttl: number }}
   *
   * @example
   * const creds = turn.generateFor('peer-abc123');
   * // {
   * //   urls:       ['turn:turn.example.com:3478'],
   * //   username:   '1700086400:peer-abc123',
   * //   credential: 'base64-hmac-sha1-string',
   * //   ttl:        86400
   * // }
   */
  generateFor(peerId) {
    const expiry = Math.floor(Date.now() / 1000) + this._ttl;
    const username = `${expiry}:${peerId}`;
    const credential = crypto
      .createHmac("sha1", this._secret)
      .update(username)
      .digest("base64");

    return {
      urls: [...this._urls],
      username,
      credential,
      ttl: this._ttl,
    };
  }

  /**
   * Verifies whether a set of TURN credentials is still valid.
   *
   * Useful for detecting expired credentials on reconnect so fresh ones
   * can be issued without a full re-join.
   *
   * @param {string} username   - The username from a previous `generateFor()` call.
   * @param {string} credential - The credential from the same call.
   * @returns {{ valid: boolean, expired: boolean, peerId: string|null }}
   */
  verify(username, credential) {
    const parts = username.split(":");
    if (parts.length < 2) {
      return { valid: false, expired: false, peerId: null };
    }

    const expiry = parseInt(parts[0], 10);
    const peerId = parts.slice(1).join(":");
    const now = Math.floor(Date.now() / 1000);

    if (isNaN(expiry)) {
      return { valid: false, expired: false, peerId: null };
    }

    const expected = crypto
      .createHmac("sha1", this._secret)
      .update(username)
      .digest("base64");

    // Constant-time comparison prevents timing-based credential forgery.
    let signatureValid = false;
    try {
      signatureValid = crypto.timingSafeEqual(
        Buffer.from(credential, "base64"),
        Buffer.from(expected, "base64"),
      );
    } catch {
      return { valid: false, expired: false, peerId };
    }

    if (!signatureValid) {
      return { valid: false, expired: false, peerId };
    }

    const expired = now >= expiry;
    return { valid: !expired, expired, peerId };
  }

  /**
   * Returns the TURN server URLs configured on this instance.
   * @returns {string[]}
   */
  get urls() {
    return [...this._urls];
  }

  /**
   * Returns the configured credential TTL in seconds.
   * @returns {number}
   */
  get ttl() {
    return this._ttl;
  }
}

module.exports = TurnCredentials;
