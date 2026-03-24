"use strict";

/**
 * @file PolicyEngine.js
 * @description Signed room policy enforcement for webrtc-rooms v2.
 *
 * Policies are signed JSON documents that define what a peer is allowed
 * to do in a room. They are issued server-side (e.g. from your API) and
 * verified by the PolicyEngine before any join is allowed.
 *
 * **Policy structure**
 *
 * ```json
 * {
 *   "iss":       "your-app",
 *   "sub":       "user-alice",
 *   "roomId":    "engineering",
 *   "role":      "moderator",
 *   "caps":      ["publish", "subscribe", "kick", "record"],
 *   "maxPeers":  10,
 *   "expiresAt": 1714000000000,
 *   "region":    "us-east-1"
 * }
 * ```
 *
 * **Capabilities (`caps`)**
 *
 * | Cap         | Allows                                           |
 * |-------------|--------------------------------------------------|
 * | `publish`   | Peer can send audio/video into the room          |
 * | `subscribe` | Peer can receive audio/video from others         |
 * | `kick`      | Peer can remove other peers from the room        |
 * | `record`    | Peer can trigger room recording                  |
 * | `moderate`  | Peer can mute/unmute other peers                 |
 * | `data`      | Peer can send data channel messages              |
 * | `admin`     | Full control — implies all other caps            |
 *
 * @module webrtc-rooms/auth/PolicyEngine
 *
 * @example
 * const policy = new PolicyEngine({ secret: process.env.POLICY_SECRET });
 * policy.attach(server);
 *
 * // Issue a policy (typically done in your API, not the signaling server)
 * const token = policy.issue({
 *   sub: user.id, roomId: 'standup', role: 'presenter',
 *   caps: ['publish', 'subscribe', 'data'], expiresIn: 3600_000,
 * });
 *
 * // Browser sends token in join metadata:
 * // { type: 'join', roomId: 'standup', metadata: { policyToken: token } }
 */

const { createHmac, timingSafeEqual } = require("crypto");
const { EventEmitter } = require("events");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_CAPS = new Set([
  "publish",
  "subscribe",
  "kick",
  "record",
  "moderate",
  "data",
  "admin",
]);

const ADMIN_IMPLIES = [
  "publish",
  "subscribe",
  "kick",
  "record",
  "moderate",
  "data",
];

/**
 * @typedef {object} Policy
 * @property {string}    iss       - Issuer (your app name)
 * @property {string}    sub       - Subject (user/peer ID)
 * @property {string}    roomId    - Room this policy applies to. '*' = any room.
 * @property {string}    role      - Semantic role (viewer|presenter|moderator|admin)
 * @property {string[]}  caps      - Capability list
 * @property {number}    expiresAt - Unix ms
 * @property {string}    [region]  - Optional region constraint
 * @property {number}    [maxPeers]- Optional per-room peer cap override
 */

/**
 * @typedef {object} PolicyViolation
 * @property {string} code
 * @property {string} message
 */

/**
 * Signed room policy issuer and enforcer.
 *
 * @extends EventEmitter
 *
 * @fires PolicyEngine#policy:issued
 * @fires PolicyEngine#policy:verified
 * @fires PolicyEngine#policy:violation
 */
class PolicyEngine extends EventEmitter {
  /**
   * @param {object}   options
   * @param {string}   options.secret
   *   HMAC-SHA256 secret used to sign and verify policy tokens.
   *   Must be the same across all server processes.
   * @param {string}   [options.issuer='webrtc-rooms']
   *   Issuer string embedded in issued tokens.
   * @param {boolean}  [options.required=false]
   *   When true, peers without a valid policy token are rejected at join time.
   *   When false, peers without tokens are admitted with a default capability set.
   * @param {string[]} [options.defaultCaps=['subscribe', 'data']]
   *   Capabilities granted to peers that join without a policy token.
   *   Only used when `required` is false.
   * @param {string}   [options.tokenMetadataKey='policyToken']
   *   Key in peer.metadata where the policy token is expected.
   */
  constructor({
    secret,
    issuer = "webrtc-rooms",
    required = false,
    defaultCaps = ["subscribe", "data"],
    tokenMetadataKey = "policyToken",
  }) {
    super();

    if (!secret) throw new Error("[PolicyEngine] options.secret is required");

    this._secret = secret;
    this._issuer = issuer;
    this._required = required;
    this._defaultCaps = defaultCaps;
    this._tokenMetadataKey = tokenMetadataKey;
    this._attached = false;
  }

  // ---------------------------------------------------------------------------
  // Attachment
  // ---------------------------------------------------------------------------

  /**
   * Wires the PolicyEngine into a SignalingServer as a `beforeJoin` guard.
   *
   * If the server already has a `beforeJoin` hook, the PolicyEngine wraps it
   * so both run in sequence.
   *
   * @param {import('../core/SignalingServer')} server
   * @returns {this}
   */
  attach(server) {
    if (this._attached) return this;
    this._attached = true;

    const existing = server.beforeJoin;

    server.beforeJoin = async (peer, roomId) => {
      // Run existing hook first
      if (existing) {
        const result = await existing(peer, roomId);
        if (result !== true) return result;
      }

      return this._enforcePolicy(peer, roomId);
    };

    return this;
  }

  // ---------------------------------------------------------------------------
  // Token issuance
  // ---------------------------------------------------------------------------

  /**
   * Issues a signed policy token.
   *
   * @param {object}   options
   * @param {string}   options.sub         - Subject (user/peer identifier)
   * @param {string}   [options.roomId='*']- Room this policy applies to
   * @param {string}   [options.role='viewer'] - Semantic role
   * @param {string[]} [options.caps]      - Capability list. Defaults to defaultCaps.
   * @param {number}   [options.expiresIn=3600000] - TTL in ms from now
   * @param {string}   [options.region]    - Optional region constraint
   * @param {number}   [options.maxPeers]  - Optional room peer cap override
   * @returns {string} Signed policy token (base64url encoded)
   *
   * @example
   * const token = engine.issue({
   *   sub: 'user-123',
   *   roomId: 'standup',
   *   role: 'moderator',
   *   caps: ['publish', 'subscribe', 'kick', 'data'],
   *   expiresIn: 7200_000,
   * });
   */
  issue({
    sub,
    roomId = "*",
    role = "viewer",
    caps,
    expiresIn = 3_600_000,
    region,
    maxPeers,
  }) {
    if (!sub) throw new Error("[PolicyEngine] sub is required");

    const resolvedCaps = this._resolveCaps(caps ?? this._defaultCaps);

    /** @type {Policy} */
    const policy = {
      iss: this._issuer,
      sub,
      roomId,
      role,
      caps: resolvedCaps,
      expiresAt: Date.now() + expiresIn,
      ...(region !== undefined && { region }),
      ...(maxPeers !== undefined && { maxPeers }),
    };

    const token = this._sign(policy);

    /**
     * @event PolicyEngine#policy:issued
     * @param {Policy} policy
     */
    this.emit("policy:issued", policy);
    return token;
  }

  // ---------------------------------------------------------------------------
  // Verification
  // ---------------------------------------------------------------------------

  /**
   * Verifies and decodes a policy token.
   *
   * @param {string} token
   * @returns {{ valid: true, policy: Policy } | { valid: false, reason: string }}
   */
  verify(token) {
    if (!token || typeof token !== "string") {
      return { valid: false, reason: "Token is missing or not a string" };
    }

    let payload, sig;
    try {
      const lastDot = token.lastIndexOf(".");
      if (lastDot === -1) return { valid: false, reason: "Malformed token" };
      payload = token.slice(0, lastDot);
      sig = token.slice(lastDot + 1);
    } catch {
      return { valid: false, reason: "Malformed token" };
    }

    // Verify signature
    const expected = createHmac("sha256", this._secret)
      .update(payload)
      .digest("base64url");
    if (!this._safeEqual(sig, expected)) {
      return { valid: false, reason: "Invalid signature" };
    }

    // Decode policy
    let policy;
    try {
      policy = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return { valid: false, reason: "Malformed payload" };
    }

    // Expiry check
    if (Date.now() > policy.expiresAt) {
      return { valid: false, reason: "Token expired" };
    }

    return { valid: true, policy };
  }

  // ---------------------------------------------------------------------------
  // Capability checks
  // ---------------------------------------------------------------------------

  /**
   * Returns true if a peer has a specific capability.
   *
   * @param {import('../core/Peer')} peer
   * @param {string} cap
   * @returns {boolean}
   */
  hasCap(peer, cap) {
    const caps = peer.metadata.__caps;
    if (!Array.isArray(caps)) return false;
    return caps.includes("admin") || caps.includes(cap);
  }

  /**
   * Returns the capabilities assigned to a peer.
   *
   * @param {import('../core/Peer')} peer
   * @returns {string[]}
   */
  getCaps(peer) {
    return peer.metadata.__caps ?? [];
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  /**
   * @returns {{ required: boolean, issuer: string, defaultCaps: string[] }}
   */
  stats() {
    return {
      required: this._required,
      issuer: this._issuer,
      defaultCaps: this._defaultCaps,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal enforcement
  // ---------------------------------------------------------------------------

  /**
   * @private
   */
  async _enforcePolicy(peer, roomId) {
    const token = peer.metadata[this._tokenMetadataKey];

    if (!token) {
      if (this._required) {
        /**
         * @event PolicyEngine#policy:violation
         */
        this.emit("policy:violation", {
          peer,
          roomId,
          code: "POLICY_REQUIRED",
        });
        return "A valid policy token is required to join this room";
      }
      // Grant default capabilities
      peer.setMetadata({
        [this._tokenMetadataKey]: null,
        __caps: this._defaultCaps,
        __role: "viewer",
        __sub: null,
      });
      return true;
    }

    const result = this.verify(token);

    if (!result.valid) {
      this.emit("policy:violation", {
        peer,
        roomId,
        code: "POLICY_INVALID",
        reason: result.reason,
      });
      return `Policy token rejected: ${result.reason}`;
    }

    const { policy } = result;

    // Room constraint check
    if (policy.roomId !== "*" && policy.roomId !== roomId) {
      this.emit("policy:violation", {
        peer,
        roomId,
        code: "POLICY_ROOM_MISMATCH",
      });
      return `This token is not valid for room "${roomId}"`;
    }

    // Apply policy to peer metadata (strip raw token, attach resolved caps)
    peer.setMetadata({
      [this._tokenMetadataKey]: null,
      __caps: policy.caps,
      __role: policy.role,
      __sub: policy.sub,
      __region: policy.region ?? null,
    });

    /**
     * @event PolicyEngine#policy:verified
     * @param {Policy} policy
     * @param {import('../core/Peer')} peer
     */
    this.emit("policy:verified", policy, peer);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Token signing
  // ---------------------------------------------------------------------------

  /**
   * @private
   */
  _sign(policy) {
    const payload = Buffer.from(JSON.stringify(policy)).toString("base64url");
    const sig = createHmac("sha256", this._secret)
      .update(payload)
      .digest("base64url");
    return `${payload}.${sig}`;
  }

  /**
   * @private
   */
  _resolveCaps(caps) {
    const resolved = new Set();
    for (const cap of caps) {
      if (!ALL_CAPS.has(cap)) {
        throw new Error(
          `[PolicyEngine] Unknown capability: "${cap}". Valid: ${[...ALL_CAPS].join(", ")}`,
        );
      }
      if (cap === "admin") {
        for (const implied of ADMIN_IMPLIES) resolved.add(implied);
      }
      resolved.add(cap);
    }
    return [...resolved];
  }

  /**
   * Constant-time string comparison.
   * @private
   */
  _safeEqual(a, b) {
    try {
      return timingSafeEqual(Buffer.from(a), Buffer.from(b));
    } catch {
      return false;
    }
  }
}

module.exports = PolicyEngine;
