"use strict";

/**
 * @file ModerationBus.js
 * @description Real-time moderation event bus for webrtc-rooms v2.
 *
 * Provides a structured, auditable channel for moderation actions — muting,
 * unmuting, kicking, and abuse reporting — that can be triggered by moderator
 * peers, admin API calls, or automated threat detection.
 *
 * **Actions**
 *
 * | Action        | Who can trigger               | Effect                          |
 * |---------------|-------------------------------|---------------------------------|
 * | `mute`        | Moderator peer, admin         | Peer's audio/video paused in SFU|
 * | `unmute`      | Moderator peer, peer self     | Peer's audio/video resumed      |
 * | `kick`        | Moderator peer, admin         | Peer removed from room          |
 * | `warn`        | Moderator peer, admin         | Warning message sent to peer    |
 * | `report:abuse`| Any peer                      | Logged + emitted for review     |
 * | `lock:room`   | Moderator, admin              | No new peers can join           |
 * | `unlock:room` | Moderator, admin              | Re-opens the room               |
 *
 * **Capability check**
 *
 * All actions respect the PolicyEngine capability model. Peers without the
 * `moderate` or `kick` capability cannot trigger those actions. If PolicyEngine
 * is not attached, all peers are treated as having full capabilities.
 *
 * @module webrtc-rooms/moderation/ModerationBus
 *
 * @example
 * const { ModerationBus } = require('webrtc-rooms');
 *
 * const modBus = new ModerationBus({ server });
 * modBus.attach();
 *
 * modBus.on('action', ({ action, actorId, targetId, roomId }) => {
 *   audit.log(`${actorId} ${action} ${targetId} in ${roomId}`);
 * });
 *
 * // Mute a peer programmatically (e.g. from admin API)
 * modBus.mute({ roomId: 'standup', targetId: 'peer-xyz', reason: 'Background noise', actorId: 'system' });
 */

const { EventEmitter } = require("events");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ModerationAction = Object.freeze({
  MUTE: "mute",
  UNMUTE: "unmute",
  KICK: "kick",
  WARN: "warn",
  REPORT_ABUSE: "report:abuse",
  LOCK_ROOM: "lock:room",
  UNLOCK_ROOM: "unlock:room",
});

// Minimum capability required per action
const ACTION_CAPS = {
  [ModerationAction.MUTE]: "moderate",
  [ModerationAction.UNMUTE]: "moderate",
  [ModerationAction.KICK]: "kick",
  [ModerationAction.WARN]: "moderate",
  [ModerationAction.LOCK_ROOM]: "moderate",
  [ModerationAction.UNLOCK_ROOM]: "moderate",
  // report:abuse is available to any peer
};

/**
 * @typedef {object} ModerationEvent
 * @property {string}  action
 * @property {string}  actorId    - peerId or 'system' for programmatic actions
 * @property {string}  [targetId] - peerId target (null for room-level actions)
 * @property {string}  roomId
 * @property {string}  [reason]
 * @property {number}  ts
 */

/**
 * @extends EventEmitter
 * @fires ModerationBus#action
 * @fires ModerationBus#mute
 * @fires ModerationBus#unmute
 * @fires ModerationBus#kick
 * @fires ModerationBus#warn
 * @fires ModerationBus#abuse:reported
 * @fires ModerationBus#room:locked
 * @fires ModerationBus#room:unlocked
 */
class ModerationBus extends EventEmitter {
  /**
   * @param {object}  options
   * @param {import('../core/SignalingServer')} options.server
   * @param {object}  [options.policyEngine]   - PolicyEngine for capability checks
   * @param {boolean} [options.allowSelfUnmute=true] - Peers can unmute themselves
   */
  constructor({ server, policyEngine = null, allowSelfUnmute = true }) {
    super();

    if (!server) throw new Error("[ModerationBus] options.server is required");

    this._server = server;
    this._policy = policyEngine;
    this._allowSelfUnmute = allowSelfUnmute;

    /** @type {Map<string, Set<string>>} roomId → Set of muted peerIds */
    this._mutedPeers = new Map();

    /** @type {Set<string>} Locked room IDs */
    this._lockedRooms = new Set();

    /** @type {ModerationEvent[]} In-memory log */
    this._log = [];

    this._attached = false;
  }

  // ---------------------------------------------------------------------------
  // Attachment
  // ---------------------------------------------------------------------------

  /**
   * @returns {this}
   */
  attach() {
    if (this._attached) return this;
    this._attached = true;

    const server = this._server;

    // Intercept data relay for peer-initiated moderation signals
    server.on("room:created", (room) => {
      this._mutedPeers.set(room.id, new Set());

      room.on("data", (peer, _to, payload) => {
        if (payload?.__mod) {
          this._handleModSignal(peer, room, payload).catch((err) => {
            console.error(
              "[ModerationBus] Moderation signal error:",
              err.message,
            );
          });
        }
      });
    });

    server.on("room:destroyed", (room) => {
      this._mutedPeers.delete(room.id);
      this._lockedRooms.delete(room.id);
    });

    // Locked room enforcement
    const existing = server.beforeJoin;
    server.beforeJoin = async (peer, roomId) => {
      if (this._lockedRooms.has(roomId)) {
        return "Room is currently locked by a moderator";
      }
      if (existing) return existing(peer, roomId);
      return true;
    };

    return this;
  }

  // ---------------------------------------------------------------------------
  // Programmatic moderation actions (called by admin API, server code, etc.)
  // ---------------------------------------------------------------------------

  /**
   * Mutes a peer (server-initiated).
   *
   * @param {object} options
   * @param {string} options.roomId
   * @param {string} options.targetId  - Peer ID to mute
   * @param {string} [options.reason]
   * @param {string} [options.actorId='system']
   */
  mute({ roomId, targetId, reason = "", actorId = "system" }) {
    this._applyMute(roomId, targetId, actorId, reason);
  }

  /**
   * Unmutes a peer (server-initiated).
   *
   * @param {object} options
   */
  unmute({ roomId, targetId, reason = "", actorId = "system" }) {
    this._applyUnmute(roomId, targetId, actorId, reason);
  }

  /**
   * Kicks a peer (server-initiated).
   *
   * @param {object} options
   * @param {string} options.roomId
   * @param {string} options.targetId
   * @param {string} [options.reason]
   * @param {string} [options.actorId='system']
   */
  kick({
    roomId,
    targetId,
    reason = "Removed by moderator",
    actorId = "system",
  }) {
    this._applyKick(roomId, targetId, actorId, reason);
  }

  /**
   * Sends a warning message to a peer without removing them from the room.
   *
   * @param {object} options
   * @param {string} options.roomId
   * @param {string} options.targetId
   * @param {string} [options.reason='']
   * @param {string} [options.actorId='system']
   */
  warn({ roomId, targetId, reason = "", actorId = "system" }) {
    this._applyWarn(roomId, targetId, actorId, reason);
  }

  /**
   * Locks a room preventing new peers from joining.
   *
   * @param {string} roomId
   * @param {string} [actorId='system']
   */
  lockRoom(roomId, actorId = "system") {
    this._lockedRooms.add(roomId);
    this._record(ModerationAction.LOCK_ROOM, actorId, null, roomId);
    const room = this._server.getRoom(roomId);
    if (room) room.broadcast({ type: "room:locked", lockedBy: actorId });
    /**
     * @event ModerationBus#room:locked
     */
    this.emit("room:locked", { roomId, actorId });
  }

  /**
   * Unlocks a room.
   *
   * @param {string} roomId
   * @param {string} [actorId='system']
   */
  unlockRoom(roomId, actorId = "system") {
    this._lockedRooms.delete(roomId);
    this._record(ModerationAction.UNLOCK_ROOM, actorId, null, roomId);
    const room = this._server.getRoom(roomId);
    if (room) room.broadcast({ type: "room:unlocked", unlockedBy: actorId });
    /**
     * @event ModerationBus#room:unlocked
     */
    this.emit("room:unlocked", { roomId, actorId });
  }

  /**
   * Returns true if a peer is currently muted in a room.
   * @param {string} roomId
   * @param {string} peerId
   * @returns {boolean}
   */
  isMuted(roomId, peerId) {
    return this._mutedPeers.get(roomId)?.has(peerId) ?? false;
  }

  /**
   * Returns true if a room is locked.
   * @param {string} roomId
   * @returns {boolean}
   */
  isLocked(roomId) {
    return this._lockedRooms.has(roomId);
  }

  /**
   * Returns the moderation log.
   * @param {object} [options]
   * @param {string} [options.roomId]
   * @param {string} [options.actorId]
   * @param {number} [options.limit=100]
   * @returns {ModerationEvent[]}
   */
  log({ roomId, actorId, limit = 100 } = {}) {
    let entries = [...this._log];
    if (roomId) entries = entries.filter((e) => e.roomId === roomId);
    if (actorId) entries = entries.filter((e) => e.actorId === actorId);
    return entries.slice(-limit);
  }

  // ---------------------------------------------------------------------------
  // Signal handler (peer-initiated)
  // ---------------------------------------------------------------------------

  /** @private */
  async _handleModSignal(actor, room, payload) {
    const { __mod: action, targetId, reason = "" } = payload;

    // self-unmute is always allowed when configured
    if (
      action === ModerationAction.UNMUTE &&
      targetId === actor.id &&
      this._allowSelfUnmute
    ) {
      this._applyUnmute(room.id, actor.id, actor.id, "self-unmute");
      return;
    }

    // report:abuse is open to any peer
    if (action === ModerationAction.REPORT_ABUSE) {
      this._handleAbuseReport(actor, room, payload);
      return;
    }

    // Capability check
    const requiredCap = ACTION_CAPS[action];
    if (requiredCap && !this._hasCap(actor, requiredCap)) {
      actor.send({ type: "error", code: "MOD_UNAUTHORIZED", action });
      return;
    }

    switch (action) {
      case ModerationAction.MUTE:
        this._applyMute(room.id, targetId, actor.id, reason);
        break;
      case ModerationAction.UNMUTE:
        this._applyUnmute(room.id, targetId, actor.id, reason);
        break;
      case ModerationAction.KICK:
        this._applyKick(room.id, targetId, actor.id, reason);
        break;
      case ModerationAction.WARN:
        this._applyWarn(room.id, targetId, actor.id, reason);
        break;
      case ModerationAction.LOCK_ROOM:
        this.lockRoom(room.id, actor.id);
        break;
      case ModerationAction.UNLOCK_ROOM:
        this.unlockRoom(room.id, actor.id);
        break;
      default:
        actor.send({ type: "error", code: "MOD_UNKNOWN_ACTION", action });
    }
  }

  // ---------------------------------------------------------------------------
  // Action implementations
  // ---------------------------------------------------------------------------

  /** @private */
  _applyMute(roomId, targetId, actorId, reason) {
    const muted = this._mutedPeers.get(roomId);
    if (muted) muted.add(targetId);

    const target = this._server.peers.get(targetId);
    if (target) target.send({ type: "mod:muted", by: actorId, reason });

    const room = this._server.getRoom(roomId);
    if (room)
      room.broadcast(
        { type: "mod:peer:muted", peerId: targetId, by: actorId },
        { exclude: targetId },
      );

    this._record(ModerationAction.MUTE, actorId, targetId, roomId, reason);
    this.emit("mute", { roomId, targetId, actorId, reason });
    this.emit("action", this._log[this._log.length - 1]);
  }

  /** @private */
  _applyUnmute(roomId, targetId, actorId, reason) {
    const muted = this._mutedPeers.get(roomId);
    if (muted) muted.delete(targetId);

    const target = this._server.peers.get(targetId);
    if (target) target.send({ type: "mod:unmuted", by: actorId, reason });

    this._record(ModerationAction.UNMUTE, actorId, targetId, roomId, reason);
    this.emit("unmute", { roomId, targetId, actorId, reason });
    this.emit("action", this._log[this._log.length - 1]);
  }

  /** @private */
  _applyKick(roomId, targetId, actorId, reason) {
    const target = this._server.peers.get(targetId);
    if (target) target.send({ type: "kicked", reason, by: actorId });

    this._server.kick(targetId, reason);
    this._record(ModerationAction.KICK, actorId, targetId, roomId, reason);
    this.emit("kick", { roomId, targetId, actorId, reason });
    this.emit("action", this._log[this._log.length - 1]);
  }

  /** @private */
  _applyWarn(roomId, targetId, actorId, reason) {
    const target = this._server.peers.get(targetId);
    if (target) target.send({ type: "mod:warned", reason, by: actorId });

    this._record(ModerationAction.WARN, actorId, targetId, roomId, reason);
    this.emit("warn", { roomId, targetId, actorId, reason });
    this.emit("action", this._log[this._log.length - 1]);
  }

  /** @private */
  _handleAbuseReport(reporter, room, payload) {
    const report = {
      reporterId: reporter.id,
      targetId: payload.targetId,
      roomId: room.id,
      category: payload.category ?? "unspecified",
      detail: payload.detail ?? "",
      ts: Date.now(),
    };

    this._record(
      ModerationAction.REPORT_ABUSE,
      reporter.id,
      payload.targetId,
      room.id,
      payload.detail,
    );
    /**
     * @event ModerationBus#abuse:reported
     */
    this.emit("abuse:reported", report);
    this.emit("action", this._log[this._log.length - 1]);

    reporter.send({ type: "mod:report:received" });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** @private */
  _hasCap(peer, cap) {
    if (!this._policy) return true; // no policy engine = open
    return this._policy.hasCap(peer, cap);
  }

  /** @private */
  _record(action, actorId, targetId, roomId, reason = "") {
    /** @type {ModerationEvent} */
    const entry = {
      action,
      actorId,
      targetId: targetId ?? null,
      roomId,
      reason,
      ts: Date.now(),
    };
    if (this._log.length >= 10_000) this._log.shift();
    this._log.push(entry);
  }
}

ModerationBus.Action = ModerationAction;

module.exports = ModerationBus;
