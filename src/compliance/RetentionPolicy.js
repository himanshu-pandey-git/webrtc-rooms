"use strict";

/**
 * @file RetentionPolicy.js
 * @description Data retention controls for webrtc-rooms v2.
 *
 * Enforces configurable retention policies for recordings, audit logs,
 * session data, and room metadata. Provides automated purging and supports
 * legal hold to protect data from deletion when required by law.
 *
 * **GDPR / CCPA / HIPAA alignment**
 *
 * - Right to erasure: `purge(sub)` deletes all data tied to a user identity
 * - Data minimisation: `anonymise(sub)` replaces PII with hashed tokens
 * - Retention limits: automatic expiry of recordings and logs after N days
 * - Legal hold: prevents purge during active investigations
 *
 * @module webrtc-rooms/compliance/RetentionPolicy
 *
 * @example
 * const { RetentionPolicy } = require('webrtc-rooms');
 *
 * const retention = new RetentionPolicy({
 *   recordingRetentionDays: 90,
 *   auditLogRetentionDays:  365,
 *   onExpiry: async ({ type, id, path }) => {
 *     await s3.deleteObject({ Bucket: 'recordings', Key: path });
 *   },
 * });
 */

const { EventEmitter } = require("events");
const { createHash } = require("crypto");
const fs = require("fs");

/**
 * @typedef {object} RetentionRecord
 * @property {string}   id
 * @property {'recording'|'session'|'audit'|'room'} type
 * @property {string}   sub       - User/peer identity (for erasure)
 * @property {number}   expiresAt - Unix ms
 * @property {object}   meta      - Arbitrary metadata (path, roomId, etc.)
 * @property {boolean}  legalHold
 */

/**
 * @extends EventEmitter
 * @fires RetentionPolicy#data:expired
 * @fires RetentionPolicy#data:purged
 * @fires RetentionPolicy#hold:placed
 * @fires RetentionPolicy#hold:released
 */
class RetentionPolicy extends EventEmitter {
  /**
   * @param {object}    options
   * @param {number}    [options.recordingRetentionDays=90]
   * @param {number}    [options.auditLogRetentionDays=365]
   * @param {number}    [options.sessionRetentionDays=30]
   * @param {Function}  [options.onExpiry]    - async ({ type, id, meta }) => void
   * @param {Function}  [options.onPurge]     - async ({ sub, records }) => void
   * @param {number}    [options.sweepIntervalMs=3600000] - Default: 1 hour
   */
  constructor({
    recordingRetentionDays = 90,
    auditLogRetentionDays = 365,
    sessionRetentionDays = 30,
    onExpiry = null,
    onPurge = null,
    sweepIntervalMs = 3_600_000,
  } = {}) {
    super();

    this._retentionMs = {
      recording: recordingRetentionDays * 86_400_000,
      audit: auditLogRetentionDays * 86_400_000,
      session: sessionRetentionDays * 86_400_000,
      room: sessionRetentionDays * 86_400_000,
    };

    this._onExpiry = onExpiry;
    this._onPurge = onPurge;

    /** @type {Map<string, RetentionRecord>} id → record */
    this._records = new Map();

    /** @type {Set<string>} sub identities under legal hold */
    this._legalHolds = new Set();

    this._sweepTimer = setInterval(
      () => this._sweep(),
      sweepIntervalMs,
    ).unref();
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Registers a data item for retention tracking.
   *
   * @param {object}  options
   * @param {string}  options.id     - Unique record ID
   * @param {'recording'|'session'|'audit'|'room'} options.type
   * @param {string}  options.sub    - Subject identity (userId, peerId)
   * @param {object}  [options.meta] - Path, roomId, or other context
   * @returns {RetentionRecord}
   */
  register({ id, type, sub, meta = {} }) {
    const ttl = this._retentionMs[type] ?? this._retentionMs.session;

    /** @type {RetentionRecord} */
    const record = {
      id,
      type,
      sub,
      expiresAt: Date.now() + ttl,
      meta,
      legalHold: this._legalHolds.has(sub),
    };

    this._records.set(id, record);
    return record;
  }

  // ---------------------------------------------------------------------------
  // Legal hold
  // ---------------------------------------------------------------------------

  /**
   * Places all data for a subject under legal hold.
   * Held records are excluded from automatic and manual purges.
   *
   * @param {string} sub
   */
  placeLegalHold(sub) {
    this._legalHolds.add(sub);
    for (const record of this._records.values()) {
      if (record.sub === sub) record.legalHold = true;
    }
    this.emit("hold:placed", { sub });
  }

  /**
   * Releases legal hold for a subject.
   *
   * @param {string} sub
   */
  releaseLegalHold(sub) {
    this._legalHolds.delete(sub);
    for (const record of this._records.values()) {
      if (record.sub === sub) record.legalHold = false;
    }
    this.emit("hold:released", { sub });
  }

  // ---------------------------------------------------------------------------
  // Erasure (right to be forgotten)
  // ---------------------------------------------------------------------------

  /**
   * Purges all records tied to a subject identity.
   * Respects legal hold — held records are not deleted.
   *
   * @param {string} sub
   * @returns {Promise<{ purged: number, held: number }>}
   */
  async purge(sub) {
    const toDelete = [];
    const held = [];

    for (const record of this._records.values()) {
      if (record.sub !== sub) continue;
      if (record.legalHold) {
        held.push(record);
        continue;
      }
      toDelete.push(record);
    }

    for (const record of toDelete) {
      await this._expireRecord(record, "purge");
      this._records.delete(record.id);
    }

    if (this._onPurge) {
      await this._onPurge({ sub, records: toDelete }).catch((err) => {
        console.error("[RetentionPolicy] onPurge hook failed:", err.message);
      });
    }

    this.emit("data:purged", {
      sub,
      purged: toDelete.length,
      held: held.length,
    });
    return { purged: toDelete.length, held: held.length };
  }

  /**
   * Anonymises all records for a subject by replacing the `sub` field with
   * a one-way hash. The data remains but is no longer linkable to the user.
   *
   * @param {string} sub
   * @returns {number} Number of records anonymised
   */
  anonymise(sub) {
    const hashed =
      "anon:" + createHash("sha256").update(sub).digest("hex").slice(0, 16);
    let count = 0;
    for (const record of this._records.values()) {
      if (record.sub === sub && !record.legalHold) {
        record.sub = hashed;
        count++;
      }
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Returns all records for a subject.
   * @param {string} sub
   * @returns {RetentionRecord[]}
   */
  recordsFor(sub) {
    return [...this._records.values()].filter((r) => r.sub === sub);
  }

  /**
   * Returns all records expiring within the next N milliseconds.
   * @param {number} withinMs
   * @returns {RetentionRecord[]}
   */
  expiringWithin(withinMs) {
    const cutoff = Date.now() + withinMs;
    return [...this._records.values()].filter(
      (r) => r.expiresAt <= cutoff && !r.legalHold,
    );
  }

  /**
   * Returns retention statistics.
   */
  stats() {
    let expired = 0,
      held = 0;
    const now = Date.now();
    for (const r of this._records.values()) {
      if (r.legalHold) held++;
      else if (r.expiresAt <= now) expired++;
    }
    return {
      total: this._records.size,
      expired,
      held,
      active: this._records.size - expired - held,
      legalHoldSubjects: this._legalHolds.size,
    };
  }

  /**
   * Shuts down the sweep timer.
   */
  close() {
    clearInterval(this._sweepTimer);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** @private */
  async _sweep() {
    const now = Date.now();
    for (const record of [...this._records.values()]) {
      if (record.legalHold) continue;
      if (record.expiresAt <= now) {
        await this._expireRecord(record, "expiry");
        this._records.delete(record.id);
      }
    }
  }

  /** @private */
  async _expireRecord(record, reason) {
    // Delete local file if it's a recording
    if (record.type === "recording" && record.meta?.path) {
      try {
        if (fs.existsSync(record.meta.path)) fs.unlinkSync(record.meta.path);
      } catch (err) {
        console.error(
          `[RetentionPolicy] Failed to delete file ${record.meta.path}:`,
          err.message,
        );
      }
    }

    if (this._onExpiry) {
      await this._onExpiry({
        type: record.type,
        id: record.id,
        meta: record.meta,
        reason,
      }).catch((err) => {
        console.error("[RetentionPolicy] onExpiry hook failed:", err.message);
      });
    }

    /**
     * @event RetentionPolicy#data:expired
     */
    this.emit("data:expired", {
      id: record.id,
      type: record.type,
      sub: record.sub,
      reason,
    });
  }
}

module.exports = RetentionPolicy;
