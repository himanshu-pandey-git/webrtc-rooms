"use strict";

/**
 * @file GovernanceEndpoints.js
 * @description Enterprise governance REST endpoints for webrtc-rooms v2.
 *
 * Extends the base AdminAPI with compliance, audit, and governance endpoints
 * designed for SOC2/HIPAA/GDPR audit requirements. All endpoints require
 * admin authentication.
 *
 * **Endpoints added**
 *
 * | Method | Path                           | Description                            |
 * |--------|--------------------------------|----------------------------------------|
 * | GET    | /admin/audit                   | Query audit log (filter by event/peer) |
 * | GET    | /admin/audit/export            | Stream full audit log as NDJSON        |
 * | GET    | /admin/compliance/consents     | All active consent records             |
 * | GET    | /admin/compliance/consents/:roomId | Room consent status                |
 * | POST   | /admin/compliance/consents/:roomId/:peerId | Grant consent server-side  |
 * | DELETE | /admin/compliance/consents/:roomId/:peerId | Revoke consent             |
 * | GET    | /admin/residency               | Data residency status                  |
 * | GET    | /admin/sessions                | Active session states                  |
 * | DELETE | /admin/sessions/:peerId        | Force-expire a session                 |
 * | GET    | /admin/metrics/prometheus      | Prometheus metrics endpoint            |
 * | GET    | /admin/traces                  | Recent trace spans                     |
 * | GET    | /admin/sfu                     | SFU fleet status                       |
 * | POST   | /admin/sfu/failover            | Trigger manual SFU failover            |
 * | GET    | /admin/threats                 | Active threat bans                     |
 * | DELETE | /admin/threats/bans/:ip        | Lift a ban                             |
 *
 * @module webrtc-rooms/admin/GovernanceEndpoints
 *
 * @example
 * const gov = new GovernanceEndpoints({
 *   server,
 *   adminSecret: process.env.ADMIN_SECRET,
 *   audit, consent, residency, metrics, tracer, sessionMgr, sfuOrchestrator, threatDetector,
 * });
 * gov.listen(4001);
 * // Or: app.use('/admin', gov.router());
 */

const http = require("http");
const { EventEmitter } = require("events");

// ---------------------------------------------------------------------------
// GovernanceEndpoints
// ---------------------------------------------------------------------------

/**
 * @extends EventEmitter
 */
class GovernanceEndpoints extends EventEmitter {
  /**
   * @param {object}  options
   * @param {import('../core/SignalingServer')} options.server
   * @param {string}  [options.adminSecret]
   * @param {import('../security/AuditLogger')}            [options.audit]
   * @param {import('../compliance/ConsentFlow')}          [options.consent]
   * @param {import('../compliance/DataResidency')}        [options.residency]
   * @param {import('../observability/MetricsCollector')}  [options.metrics]
   * @param {import('../observability/Tracer')}            [options.tracer]
   * @param {import('../core/SessionManager')}             [options.sessionMgr]
   * @param {import('../sfu/SFUOrchestrator')}             [options.sfuOrchestrator]
   * @param {import('../security/ThreatDetector')}         [options.threatDetector]
   */
  constructor({
    server,
    adminSecret,
    audit,
    consent,
    residency,
    metrics,
    tracer,
    sessionMgr,
    sfuOrchestrator,
    threatDetector,
  }) {
    super();

    if (!server)
      throw new Error("[GovernanceEndpoints] options.server is required");

    this._server = server;
    this._adminSecret = adminSecret ?? null;
    this._audit = audit ?? null;
    this._consent = consent ?? null;
    this._residency = residency ?? null;
    this._metrics = metrics ?? null;
    this._tracer = tracer ?? null;
    this._sessionMgr = sessionMgr ?? null;
    this._sfu = sfuOrchestrator ?? null;
    this._threatDetector = threatDetector ?? null;

    this._httpServer = null;
  }

  // ---------------------------------------------------------------------------
  // Server mounting
  // ---------------------------------------------------------------------------

  /**
   * Starts a standalone HTTP server on the given port.
   * @param {number} [port=4001]
   * @returns {http.Server}
   */
  listen(port = 4001) {
    this._httpServer = http.createServer((req, res) =>
      this._dispatch(req, res),
    );
    this._httpServer.listen(port, () => {
      console.log(`[GovernanceEndpoints] Listening on port ${port}`);
    });
    return this._httpServer;
  }

  /**
   * Returns an Express-compatible middleware function.
   * @returns {Function}
   */
  router() {
    return (req, res, next) => {
      // Strip prefix if mounted under /admin
      const originalUrl = req.url;
      req.url = req.url.replace(/^\/admin/, "") || "/";
      this._dispatch(req, res, () => {
        req.url = originalUrl;
        if (next) next();
      });
    };
  }

  /**
   * @returns {Promise<void>}
   */
  close() {
    return new Promise((resolve, reject) => {
      if (!this._httpServer) {
        resolve();
        return;
      }
      this._httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // ---------------------------------------------------------------------------
  // Request dispatch
  // ---------------------------------------------------------------------------

  /** @private */
  async _dispatch(req, res, next) {
    if (!this._authenticate(req, res)) return;

    let body = null;
    if (req.method === "POST" || req.method === "PATCH") {
      body = await this._readBody(req);
    }

    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    try {
      // Audit
      if (method === "GET" && path === "/audit") {
        const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
        const event = url.searchParams.get("event") ?? undefined;
        const peerId = url.searchParams.get("peerId") ?? undefined;
        const roomId = url.searchParams.get("roomId") ?? undefined;
        const since = url.searchParams.get("since")
          ? parseInt(url.searchParams.get("since"), 10)
          : undefined;

        const entries =
          this._audit?.query({ limit, event, peerId, roomId, since }) ?? [];
        return this._json(res, 200, { entries, count: entries.length });
      }

      if (method === "GET" && path === "/audit/export") {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        const all = this._audit?.query({ limit: 100_000 }) ?? [];
        for (const e of all) res.write(JSON.stringify(e) + "\n");
        return res.end();
      }

      // Consent
      if (method === "GET" && path === "/compliance/consents") {
        const stats = this._consent?.stats() ?? [];
        return this._json(res, 200, { rooms: stats });
      }

      const consentRoomMatch = path.match(/^\/compliance\/consents\/([^/]+)$/);
      if (consentRoomMatch) {
        const roomId = consentRoomMatch[1];
        if (method === "GET") {
          const records = this._consent?.getRoomConsents(roomId) ?? [];
          return this._json(res, 200, { roomId, records });
        }
      }

      const consentPeerMatch = path.match(
        /^\/compliance\/consents\/([^/]+)\/([^/]+)$/,
      );
      if (consentPeerMatch) {
        const [, roomId, peerId] = consentPeerMatch;
        if (method === "POST") {
          const types = body?.types ?? [];
          this._consent?.recordConsent(roomId, peerId, types);
          return this._json(res, 200, { granted: true, roomId, peerId, types });
        }
        if (method === "DELETE") {
          const record = this._consent?.getConsent(roomId, peerId);
          if (record) {
            // Withdraw all
            const store = this._consent?._consents?.get(roomId);
            if (store) store.delete(peerId);
          }
          return this._json(res, 200, { revoked: true, roomId, peerId });
        }
      }

      // Data Residency
      if (method === "GET" && path === "/residency") {
        return this._json(
          res,
          200,
          this._residency?.stats() ?? { message: "DataResidency not attached" },
        );
      }

      // Sessions
      if (method === "GET" && path === "/sessions") {
        return this._json(
          res,
          200,
          this._sessionMgr?.stats() ?? {
            message: "SessionManager not attached",
          },
        );
      }

      const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
      if (sessionMatch && method === "DELETE") {
        const peerId = sessionMatch[1];
        const session = this._sessionMgr?.getSession(peerId);
        if (!session)
          return this._json(res, 404, { error: "Session not found" });
        this._sessionMgr._expireSession(session);
        return this._json(res, 200, { expired: true, peerId });
      }

      // Prometheus metrics
      if (method === "GET" && path === "/metrics/prometheus") {
        if (!this._metrics)
          return this._json(res, 503, {
            error: "MetricsCollector not attached",
          });
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
        return res.end(this._metrics.toPrometheus());
      }

      // Traces
      if (method === "GET" && path === "/traces") {
        const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
        const name = url.searchParams.get("name") ?? undefined;
        const spans = this._tracer?.getSpans({ limit, name }) ?? [];
        return this._json(res, 200, { spans, count: spans.length });
      }

      // SFU fleet
      if (method === "GET" && path === "/sfu") {
        return this._json(res, 200, { sfus: this._sfu?.stats() ?? [] });
      }

      if (method === "POST" && path === "/sfu/failover") {
        const { fromRegion, toRegion } = body ?? {};
        if (!fromRegion)
          return this._json(res, 400, { error: "fromRegion required" });
        await this._sfu?.migrateRoom(fromRegion, toRegion ?? "default");
        return this._json(res, 200, { triggered: true, fromRegion, toRegion });
      }

      // Threat detection
      if (method === "GET" && path === "/threats") {
        return this._json(res, 200, {
          bans: this._threatDetector?.bans() ?? [],
          stats: this._threatDetector?.stats() ?? {},
        });
      }

      const banMatch = path.match(/^\/threats\/bans\/(.+)$/);
      if (banMatch && method === "DELETE") {
        const ip = banMatch[1];
        this._threatDetector?.unban(ip);
        return this._json(res, 200, { unbanned: true, ip });
      }

      // Not found / fallthrough
      if (next) return next();
      return this._json(res, 404, { error: "Not found" });
    } catch (err) {
      console.error("[GovernanceEndpoints] Request error:", err.message);
      return this._json(res, 500, { error: "Internal server error" });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** @private */
  _authenticate(req, res) {
    if (!this._adminSecret) return true;
    const authHeader = req.headers["authorization"] ?? "";
    if (authHeader === `Bearer ${this._adminSecret}`) return true;
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }

  /** @private */
  _json(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  /** @private */
  _readBody(req) {
    return new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({});
        }
      });
    });
  }
}

module.exports = GovernanceEndpoints;
