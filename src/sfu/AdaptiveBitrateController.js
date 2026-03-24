"use strict";

/**
 * @file AdaptiveBitrateController.js
 * @description Network and device-aware adaptive bitrate and simulcast layer
 * controller for webrtc-rooms v2.
 *
 * Tracks RTCP feedback signals (PLI, NACK, REMB) per subscriber, maps them
 * to a quality score, and selects the optimal simulcast layer with hysteresis
 * to prevent oscillation. Active speaker and screen-share tracks are protected
 * from downgrade. Mobile-first tuning starts mobile peers at a lower tier.
 *
 * Browser sends feedback via data relay:
 *   { __sfu: 'feedback', type: 'pli', consumerId }
 *   { __sfu: 'feedback', type: 'remb', consumerId, bitrate: 500000 }
 *   { __sfu: 'feedback', type: 'nack', consumerId, count: 3 }
 *
 * @module webrtc-rooms/sfu/AdaptiveBitrateController
 */

const { EventEmitter } = require("events");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAYERS = ["low", "mid", "high"];

const SCORE_DECAY_INTERVAL_MS = 2_000;
const SCORE_DECAY_FACTOR = 0.02;
const SCORE_PLI_PENALTY = 0.15;
const SCORE_NACK_PENALTY = 0.05;
const SCORE_REMB_BONUS = 0.03;
const SCORE_MAX = 1.0;
const SCORE_MIN = 0.0;

const UPGRADE_THRESHOLD = 0.8;
const UPGRADE_HOLD_MS = 5_000;
const DOWNGRADE_THRESHOLD = 0.5;
const AUDIO_ONLY_THRESHOLD = 0.2;

const INITIAL_SCORE_DESKTOP = 0.9;
const INITIAL_SCORE_MOBILE = 0.55;
const INITIAL_SCORE_DEFAULT = 0.75;

/**
 * @typedef {object} SubscriberState
 * @property {string}  consumerId
 * @property {string}  peerId
 * @property {string}  producerId
 * @property {number}  score
 * @property {string}  currentLayer
 * @property {string}  targetLayer
 * @property {number}  upgradeEligibleAt
 * @property {string}  deviceType
 * @property {boolean} isActiveSpeaker
 * @property {boolean} isScreenShare
 * @property {number}  pliCount
 * @property {number}  nackCount
 * @property {number}  lastFeedbackAt
 */

/**
 * @extends EventEmitter
 * @fires AdaptiveBitrateController#layer:changed
 * @fires AdaptiveBitrateController#score:updated
 * @fires AdaptiveBitrateController#audio:only:hint
 */
class AdaptiveBitrateController extends EventEmitter {
  /**
   * @param {object}  options
   * @param {import('./NativeSFUEngine')} options.sfuEngine
   * @param {number}  [options.upgradeHoldMs=5000]
   * @param {number}  [options.decayIntervalMs=2000]
   * @param {boolean} [options.mobileFirst=true]
   * @param {boolean} [options.protectActiveSpeaker=true]
   * @param {boolean} [options.protectScreenShare=true]
   */
  constructor({
    sfuEngine,
    upgradeHoldMs = UPGRADE_HOLD_MS,
    decayIntervalMs = SCORE_DECAY_INTERVAL_MS,
    mobileFirst = true,
    protectActiveSpeaker = true,
    protectScreenShare = true,
  }) {
    super();
    if (!sfuEngine)
      throw new Error("[AdaptiveBitrateController] sfuEngine is required");

    this._sfu = sfuEngine;
    this._upgradeHoldMs = upgradeHoldMs;
    this._mobileFirst = mobileFirst;
    this._protectActiveSpeaker = protectActiveSpeaker;
    this._protectScreenShare = protectScreenShare;

    /** @type {Map<string, SubscriberState>} */
    this._subscribers = new Map();
    this._activeSpeakers = new Set();
    this._screenShares = new Set();

    this._decayTimer = setInterval(
      () => this._decayAll(),
      decayIntervalMs,
    ).unref();
    this._attached = false;
  }

  // ---------------------------------------------------------------------------
  // Attachment
  // ---------------------------------------------------------------------------

  attach(server) {
    if (this._attached) return this;
    this._attached = true;
    this._server = server;

    this._sfu.on("consumer:created", (consumer, producer) => {
      this._registerSubscriber(consumer, producer);
    });

    this._sfu.on("consumer:closed", (consumer) => {
      this._subscribers.delete(consumer.id);
    });

    server.on("room:created", (room) => {
      room.on("data", (peer, _to, payload) => {
        if (payload?.__sfu === "feedback") this._handleFeedback(peer, payload);
        if (payload?.__sfu === "active-speaker")
          this._handleActiveSpeaker(payload);
      });
    });

    return this;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  setActiveSpeaker(producerId) {
    this._activeSpeakers.add(producerId);
    for (const state of this._subscribers.values()) {
      if (state.producerId === producerId) {
        state.isActiveSpeaker = true;
        this._applyLayerChange(state, "high");
      }
    }
  }

  clearActiveSpeaker(producerId) {
    this._activeSpeakers.delete(producerId);
    for (const state of this._subscribers.values()) {
      if (state.producerId === producerId) state.isActiveSpeaker = false;
    }
  }

  markScreenShare(producerId) {
    this._screenShares.add(producerId);
    for (const state of this._subscribers.values()) {
      if (state.producerId === producerId) state.isScreenShare = true;
    }
  }

  stats() {
    return [...this._subscribers.values()].map((s) => ({
      consumerId: s.consumerId,
      peerId: s.peerId,
      score: Math.round(s.score * 100) / 100,
      currentLayer: s.currentLayer,
      targetLayer: s.targetLayer,
      deviceType: s.deviceType,
      isActiveSpeaker: s.isActiveSpeaker,
      pliCount: s.pliCount,
      nackCount: s.nackCount,
    }));
  }

  close() {
    clearInterval(this._decayTimer);
  }

  // ---------------------------------------------------------------------------
  // Feedback handling
  // ---------------------------------------------------------------------------

  _handleFeedback(peer, payload) {
    const { type, consumerId, bitrate, count = 1 } = payload;
    const state = this._subscribers.get(consumerId);
    if (!state || state.peerId !== peer.id) return;

    state.lastFeedbackAt = Date.now();

    switch (type) {
      case "pli":
        state.pliCount++;
        this._adjustScore(state, -(SCORE_PLI_PENALTY * count));
        break;
      case "nack":
        state.nackCount++;
        this._adjustScore(state, -(SCORE_NACK_PENALTY * count));
        break;
      case "remb":
        if (typeof bitrate === "number") {
          this._adjustScore(
            state,
            bitrate > 1_000_000 ? SCORE_REMB_BONUS * 2 : SCORE_REMB_BONUS,
          );
        }
        break;
      case "good":
        this._adjustScore(state, SCORE_REMB_BONUS);
        break;
      default:
        return;
    }

    this._evaluateLayer(state);
  }

  _handleActiveSpeaker(payload) {
    if (payload.active) this.setActiveSpeaker(payload.producerId);
    else this.clearActiveSpeaker(payload.producerId);
  }

  // ---------------------------------------------------------------------------
  // Score management
  // ---------------------------------------------------------------------------

  _adjustScore(state, delta) {
    state.score = Math.min(SCORE_MAX, Math.max(SCORE_MIN, state.score + delta));
    this.emit("score:updated", {
      consumerId: state.consumerId,
      peerId: state.peerId,
      score: state.score,
    });
  }

  _decayAll() {
    for (const state of this._subscribers.values()) {
      if (
        Date.now() - state.lastFeedbackAt > 3_000 &&
        state.score < SCORE_MAX
      ) {
        this._adjustScore(state, SCORE_DECAY_FACTOR);
        this._evaluateLayer(state);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Layer selection
  // ---------------------------------------------------------------------------

  _evaluateLayer(state) {
    const score = state.score;
    let target;

    if (score >= UPGRADE_THRESHOLD) target = "high";
    else if (score >= DOWNGRADE_THRESHOLD) target = "mid";
    else if (score >= AUDIO_ONLY_THRESHOLD) target = "low";
    else {
      this.emit("audio:only:hint", {
        consumerId: state.consumerId,
        peerId: state.peerId,
        score,
      });
      target = "low";
    }

    target = this._applyProtections(state, target);
    if (target === state.currentLayer) return;

    const isUpgrade =
      LAYERS.indexOf(target) > LAYERS.indexOf(state.currentLayer);

    if (isUpgrade) {
      if (!state.upgradeEligibleAt) {
        state.upgradeEligibleAt = Date.now() + this._upgradeHoldMs;
        return;
      }
      if (Date.now() < state.upgradeEligibleAt) return;
      state.upgradeEligibleAt = 0;
    } else {
      state.upgradeEligibleAt = 0;
    }

    this._applyLayerChange(state, target);
  }

  _applyProtections(state, target) {
    if (this._protectActiveSpeaker && state.isActiveSpeaker && target === "low")
      return "mid";
    if (this._protectScreenShare && state.isScreenShare && target === "low")
      return "mid";
    return target;
  }

  _applyLayerChange(state, newLayer) {
    const prev = state.currentLayer;
    state.currentLayer = newLayer;
    state.targetLayer = newLayer;

    const peer = this._server?.peers?.get(state.peerId);
    if (peer) {
      peer.send({
        type: "sfu:layer:auto",
        consumerId: state.consumerId,
        layer: newLayer,
        reason: "adaptive",
        score: Math.round(state.score * 100) / 100,
      });
    }

    this.emit("layer:changed", {
      consumerId: state.consumerId,
      peerId: state.peerId,
      from: prev,
      to: newLayer,
      toLayer: newLayer, // alias for backward compatibility
      score: state.score,
    });
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  _registerSubscriber(consumer, producer) {
    const peer = this._server?.peers?.get(consumer.subscriberPeerId);
    const deviceType = this._detectDeviceType(peer);
    const initialScore = this._mobileFirst
      ? deviceType === "mobile"
        ? INITIAL_SCORE_MOBILE
        : deviceType === "desktop"
          ? INITIAL_SCORE_DESKTOP
          : INITIAL_SCORE_DEFAULT
      : INITIAL_SCORE_DEFAULT;

    this._subscribers.set(consumer.id, {
      consumerId: consumer.id,
      peerId: consumer.subscriberPeerId,
      producerId: consumer.producerId,
      score: initialScore,
      currentLayer: this._scoreToLayer(initialScore),
      targetLayer: this._scoreToLayer(initialScore),
      upgradeEligibleAt: 0,
      deviceType,
      isActiveSpeaker: this._activeSpeakers.has(consumer.producerId),
      isScreenShare: this._screenShares.has(consumer.producerId),
      pliCount: 0,
      nackCount: 0,
      lastFeedbackAt: Date.now(),
    });
  }

  _detectDeviceType(peer) {
    if (!peer) return "unknown";
    const ua = peer.metadata?.userAgent ?? "";
    if (/mobile|android|iphone|ipad/i.test(ua)) return "mobile";
    if (/windows|macintosh|linux/i.test(ua)) return "desktop";
    return peer.metadata?.deviceType ?? "unknown";
  }

  /**
   * Maps a quality score to a simulcast layer name.
   * Accepts both 0.0–1.0 (new) and 0–100 (legacy) scales.
   * @param {number} score
   * @returns {'high'|'mid'|'low'}
   */
  _scoreToLayer(score) {
    // Normalise legacy 0–100 scale to 0.0–1.0
    const normalised = score > 1 ? score / 100 : score;
    if (normalised >= UPGRADE_THRESHOLD) return "high";
    if (normalised >= DOWNGRADE_THRESHOLD) return "mid";
    return "low";
  }

  // ---------------------------------------------------------------------------
  // Legacy / compatibility API (maps old method names to new implementation)
  // ---------------------------------------------------------------------------

  /**
   * Legacy score computation (rtt, jitter, packetLossRatio → 0–100).
   * @param {number} rtt           - Round-trip time ms (0 = perfect)
   * @param {number} jitter        - Jitter ms (0 = perfect)
   * @param {number} lossRatio     - Packet loss ratio 0.0–1.0 (0 = perfect)
   * @returns {number} Score 0–100
   */
  _computeScore(rtt, jitter, lossRatio) {
    const rttScore = Math.max(0, 1 - rtt / 500);
    const jitterScore = Math.max(0, 1 - jitter / 100);
    const lossScore = Math.max(0, 1 - lossRatio);
    return Math.round(
      (rttScore * 0.5 + jitterScore * 0.25 + lossScore * 0.25) * 100,
    );
  }

  /**
   * Legacy: manually register a consumer for tracking.
   * In the new API this happens automatically via `consumer:created` event.
   * @param {object} consumer
   * @param {object} room
   */
  _trackConsumer(consumer, room) {
    if (this._subscribers.has(consumer.id)) return;
    const peer = this._server?.peers?.get(consumer.subscriberPeerId);
    this._registerSubscriber(consumer, { id: consumer.producerId });
  }

  /**
   * Legacy: handle a stats report from the browser.
   * Maps old `{ rtt, jitter, packetsLost, packetsSent }` format to the
   * new feedback model.
   * @param {object} peer
   * @param {object} room
   * @param {object} report
   */
  _handleStatsReport(peer, room, report) {
    const {
      consumerId,
      rtt = 0,
      jitter = 0,
      packetsLost = 0,
      packetsSent = 1,
    } = report;
    const state = this._subscribers.get(consumerId);
    if (!state || state.peerId !== peer.id) return;

    state.lastFeedbackAt = Date.now();
    const lossRatio = packetsLost / Math.max(1, packetsSent);
    const rawScore = this._computeScore(rtt, jitter, lossRatio);
    // Map 0–100 score to 0.0–1.0 and set directly (bypasses incremental adjustment)
    state.score = rawScore / 100;
    this.emit("score:updated", {
      consumerId,
      peerId: peer.id,
      score: state.score,
    });
    this._evaluateLayer(state);
  }

  /**
   * Manually force a consumer to a specific layer, bypassing adaptive logic.
   * @param {string} consumerId
   * @param {string} layer
   * @returns {boolean}
   */
  forceLayer(consumerId, layer) {
    const state = this._subscribers.get(consumerId);
    if (!state) return false;
    if (!["low", "mid", "high"].includes(layer)) return false;

    const prev = state.currentLayer;
    state.currentLayer = layer;
    state.targetLayer = layer;

    const peer = this._server?.peers?.get(state.peerId);
    if (peer) {
      peer.send({
        type: "sfu:layer:auto",
        consumerId,
        layer,
        reason: "forced",
      });
    }

    this.emit("layer:changed", {
      consumerId,
      peerId: state.peerId,
      fromLayer: prev,
      toLayer: layer,
      from: prev,
      to: layer,
      reason: "forced",
      score: state.score,
    });

    return true;
  }
}

module.exports = AdaptiveBitrateController;
