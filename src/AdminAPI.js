"use strict";

/**
 * @file AdminAPI.js
 * @description REST HTTP administration interface for webrtc-rooms.
 *
 * Can be used as a standalone HTTP server or mounted as middleware on any
 * Express-compatible framework.
 *
 * @module webrtc-rooms/AdminAPI
 */

const http = require("http");

/**
 * REST administration API for a {@link SignalingServer}.
 *
 * **Endpoints**
 *
 * | Method   | Path                              | Description                          |
 * |----------|-----------------------------------|--------------------------------------|
 * | `GET`    | `/admin/health`                   | Liveness check                       |
 * | `GET`    | `/admin/stats`                    | Server-wide stats, memory, uptime    |
 * | `GET`    | `/admin/rooms`                    | List all rooms                       |
 * | `POST`   | `/admin/rooms`                    | Create a room `{ roomId?, metadata?}`|
 * | `GET`    | `/admin/rooms/:roomId`            | Room detail + full peer list         |
 * | `PATCH`  | `/admin/rooms/:roomId`            | Update room metadata `{ metadata }`  |
 * | `DELETE` | `/admin/rooms/:roomId`            | Destroy room, kicks all peers        |
 * | `POST`   | `/admin/rooms/:roomId/broadcast`  | Broadcast payload to a room          |
 * | `GET`    | `/admin/peers`                    | List all connected peers             |
 * | `DELETE` | `/admin/peers/:peerId`            | Kick a peer `{ reason? }`            |
 *
 * **Authentication**
 *
 * Set `options.adminSecret` to require an `Authorization: Bearer <secret>`
 * header on every request. Requests without the correct secret receive `401`.
 *
 * @example <caption>Standalone server</caption>
 * const { AdminAPI } = require('webrtc-rooms');
 * const api = new AdminAPI({ server, adminSecret: process.env.ADMIN_SECRET });
 * api.listen(4000);
 *
 * @example <caption>Mount on Express</caption>
 * const { AdminAPI } = require('webrtc-rooms');
 * const api = new AdminAPI({ server, adminSecret: process.env.ADMIN_SECRET });
 * app.use('/admin', api.router());
 */
class AdminAPI {
  /**
   * @param {object} options
   * @param {import('./SignalingServer')} options.server
   *   The SignalingServer instance to administer.
   * @param {string} [options.adminSecret=null]
   *   When set, all requests must include `Authorization: Bearer <adminSecret>`.
   * @param {string} [options.prefix='/admin']
   *   URL prefix used when routing standalone requests.
   */
  constructor({ server, adminSecret = null, prefix = "/admin" } = {}) {
    if (!server) throw new Error("[AdminAPI] options.server is required");

    this._server = server;
    this._secret = adminSecret;
    this._prefix = prefix.replace(/\/$/, "");

    /** @private @type {import('./adapters/RecordingAdapter')|null} */
    this._recorder = null;

    /** @private @type {http.Server|null} */
    this._httpServer = null;
  }

  /**
   * Attaches a `RecordingAdapter` so the `/admin/recordings` endpoint and
   * the Prometheus `/admin/metrics` output can include recording state.
   *
   * @param {import('./adapters/RecordingAdapter')} recorder
   * @returns {this} Returns `this` for chaining.
   *
   * @example
   * const admin    = new AdminAPI({ server });
   * const recorder = new RecordingAdapter({ outputDir: './recordings' });
   * admin.attachRecorder(recorder);
   */
  attachRecorder(recorder) {
    this._recorder = recorder;
    return this;
  }

  // ---------------------------------------------------------------------------
  // Standalone mode
  // ---------------------------------------------------------------------------

  /**
   * Starts a standalone HTTP server for the admin API.
   *
   * @param {number} [port=4000]
   * @returns {http.Server}
   */
  listen(port = 4000) {
    this._httpServer = http.createServer((req, res) =>
      this._dispatch(req, res),
    );
    this._httpServer.listen(port, () => {
      console.log(`[AdminAPI] Listening on port ${port}`);
    });
    return this._httpServer;
  }

  /**
   * Stops the standalone HTTP server.
   *
   * @returns {Promise<void>}
   */
  close() {
    return new Promise((resolve, reject) => {
      if (!this._httpServer) return resolve();
      this._httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }

  // ---------------------------------------------------------------------------
  // Express / middleware mode
  // ---------------------------------------------------------------------------

  /**
   * Returns a middleware function compatible with `express.use()`, Koa mount,
   * Fastify `addHook`, or any framework that passes `(req, res, next)`.
   *
   * When mounted, the prefix is stripped from the path automatically.
   *
   * @returns {Function}
   *
   * @example
   * app.use('/admin', adminApi.router());
   */
  router() {
    return (req, res, next) => {
      req.url = req.url || "/";
      this._dispatch(req, res, next);
    };
  }

  // ---------------------------------------------------------------------------
  // Internal dispatch
  // ---------------------------------------------------------------------------

  /**
   * Authenticates the request then dispatches to the route handler.
   *
   * @private
   */
  _dispatch(req, res, next) {
    if (this._secret) {
      const authHeader = req.headers["authorization"] ?? "";
      if (authHeader !== `Bearer ${this._secret}`) {
        return this._send(res, 401, { error: "Unauthorized" });
      }
    }

    this._readBody(req)
      .then((body) => {
        req.body = body;
        this._route(req, res, next);
      })
      .catch(() => this._send(res, 400, { error: "Invalid JSON body" }));
  }

  /**
   * Pattern-matches the request method and URL, then calls the appropriate
   * handler. Falls through to `next()` (Express) or `404` (standalone) when
   * no route matches.
   *
   * @private
   */
  _route(req, res, next) {
    const method = req.method;
    const url = (req.url || "/").split("?")[0].replace(this._prefix, "") || "/";

    // GET /health
    if (method === "GET" && url === "/health") {
      return this._send(res, 200, {
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    }

    // GET /stats
    if (method === "GET" && url === "/stats") {
      return this._send(res, 200, {
        ...this._server.stats(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        nodeVersion: process.version,
        timestamp: new Date().toISOString(),
      });
    }

    // GET /rooms
    if (method === "GET" && url === "/rooms") {
      return this._send(res, 200, {
        rooms: [...this._server.rooms.values()].map((r) => r.toJSON()),
      });
    }

    // POST /rooms
    if (method === "POST" && url === "/rooms") {
      const { roomId, metadata } = req.body ?? {};
      const room = this._server.createRoom(roomId, { metadata });
      return this._send(res, 201, { room: room.toJSON() });
    }

    // GET|PATCH|DELETE /rooms/:roomId
    const roomMatch = url.match(/^\/rooms\/([^/]+)$/);
    if (roomMatch) {
      const roomId = decodeURIComponent(roomMatch[1]);
      const room = this._server.getRoom(roomId);

      if (method === "GET") {
        if (!room) return this._send(res, 404, { error: "Room not found" });
        return this._send(res, 200, room.getState());
      }

      if (method === "PATCH") {
        if (!room) return this._send(res, 404, { error: "Room not found" });
        const { metadata } = req.body ?? {};
        if (metadata) room.setMetadata(metadata);
        return this._send(res, 200, { room: room.toJSON() });
      }

      if (method === "DELETE") {
        if (!room) return this._send(res, 404, { error: "Room not found" });
        for (const peerId of room.peers.keys()) {
          this._server.kick(peerId, "Room destroyed by admin");
        }
        this._server.rooms.delete(roomId);
        return this._send(res, 200, { destroyed: roomId });
      }
    }

    // POST /rooms/:roomId/broadcast
    const broadcastMatch = url.match(/^\/rooms\/([^/]+)\/broadcast$/);
    if (broadcastMatch && method === "POST") {
      const roomId = decodeURIComponent(broadcastMatch[1]);
      const room = this._server.getRoom(roomId);
      if (!room) return this._send(res, 404, { error: "Room not found" });
      const { payload, exclude } = req.body ?? {};
      room.broadcast({ type: "data", from: "__admin__", payload }, { exclude });
      return this._send(res, 200, { sent: room.size });
    }

    // POST /rooms/:roomId/mute-all
    // Broadcasts a metadata patch to every peer in the room setting
    // audioMuted: true. The client is responsible for honouring this.
    const muteMatch = url.match(/^\/rooms\/([^/]+)\/mute-all$/);
    if (muteMatch && method === "POST") {
      const roomId = decodeURIComponent(muteMatch[1]);
      const room = this._server.getRoom(roomId);
      if (!room) return this._send(res, 404, { error: "Room not found" });
      room.broadcast({ type: "admin:mute-all", roomId });
      return this._send(res, 200, { muted: room.size });
    }

    // GET /metrics  — Prometheus-compatible text format
    if (method === "GET" && url === "/metrics") {
      const stats = this._server.stats();
      const totalPeers = stats.peers;
      const lines = [
        "# HELP webrtc_rooms_active Number of active rooms",
        "# TYPE webrtc_rooms_active gauge",
        `webrtc_rooms_active ${stats.rooms}`,
        "# HELP webrtc_peers_total Number of connected peers",
        "# TYPE webrtc_peers_total gauge",
        `webrtc_peers_total ${totalPeers}`,
      ];
      for (const room of this._server.rooms.values()) {
        lines.push(`webrtc_room_peers{room="${room.id}"} ${room.size}`);
      }
      // Recording stats if a RecordingAdapter is attached
      if (this._recorder) {
        const active = this._recorder.activeRecordings().length;
        lines.push(
          "# HELP webrtc_active_recordings Number of in-progress recordings",
        );
        lines.push("# TYPE webrtc_active_recordings gauge");
        lines.push(`webrtc_active_recordings ${active}`);
      }
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      return res.end(lines.join("\n") + "\n");
    }

    // GET /recordings — list active recordings (requires RecordingAdapter)
    if (method === "GET" && url === "/recordings") {
      if (!this._recorder) {
        return this._send(res, 501, {
          error:
            "RecordingAdapter is not attached. Call adminApi.attachRecorder(recorder) first.",
        });
      }
      return this._send(res, 200, {
        recordings: this._recorder.activeRecordings(),
      });
    }

    // GET /peers
    if (method === "GET" && url === "/peers") {
      return this._send(res, 200, {
        peers: [...this._server.peers.values()].map((p) => p.toJSON()),
      });
    }

    // DELETE /peers/:peerId
    const peerMatch = url.match(/^\/peers\/([^/]+)$/);
    if (peerMatch && method === "DELETE") {
      const peerId = decodeURIComponent(peerMatch[1]);
      const peer = this._server.peers.get(peerId);
      if (!peer) return this._send(res, 404, { error: "Peer not found" });
      // Accept reason from query string (preferred for DELETE) or body.
      const rawUrl = req.url || "/";
      const qs = rawUrl.includes("?")
        ? new URLSearchParams(rawUrl.split("?")[1])
        : new URLSearchParams();
      const reason = qs.get("reason") ?? req.body?.reason ?? "Kicked by admin";
      this._server.kick(peerId, reason);
      return this._send(res, 200, { kicked: peerId, reason });
    }

    // No route matched
    if (next) return next();
    this._send(res, 404, { error: "Not found" });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Writes a JSON response.
   *
   * @private
   * @param {http.ServerResponse} res
   * @param {number}              status
   * @param {object}              body
   */
  _send(res, status, body) {
    const json = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(json);
  }

  /**
   * Reads and parses the request body as JSON.
   * Returns an empty object for requests with no body (GET, DELETE, etc.).
   *
   * @private
   * @param {http.IncomingMessage} req
   * @returns {Promise<object>}
   */
  _readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString();
          // Only attempt JSON parse for methods that conventionally carry a body.
          // For other methods (GET, DELETE, HEAD) we still drain the stream to
          // keep the socket clean, but always resolve with an empty object.
          if (["POST", "PATCH", "PUT"].includes(req.method)) {
            resolve(raw ? JSON.parse(raw) : {});
          } else {
            resolve({});
          }
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });
  }
}

module.exports = AdminAPI;
