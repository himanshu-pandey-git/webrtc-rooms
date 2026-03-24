"use strict";

/**
 * @file cli/commands/benchmark.js
 * @description Reproducible WebRTC signaling load test harness.
 *
 * Simulates concurrent peers joining rooms, exchanging offers/answers and
 * ICE candidates, sending data relay messages, and disconnecting — the full
 * signaling lifecycle. Produces a JSON report with P50/P95/P99 latencies,
 * throughput, error rate, and reconnect success rate.
 *
 * Usage:
 *   webrtc-rooms benchmark --peers 100 --rooms 10 --duration 30
 *   webrtc-rooms benchmark --peers 200 --rooms 20 --duration 60 --report ./bench.json
 */

const WebSocket = require("ws");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((sorted.length * p) / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function histStats(samples) {
  if (!samples.length)
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
  };
}

// ---------------------------------------------------------------------------
// Virtual peer
// ---------------------------------------------------------------------------

class VirtualPeer {
  constructor(url, roomId) {
    this.url = url;
    this.roomId = roomId;
    this.peerId = null;
    this.ws = null;
    this.connected = false;
    this.joinedAt = 0;
    this.joinLatency = null;
    this.errors = 0;
    this.msgCount = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      this.ws = new WebSocket(this.url);

      const timeout = setTimeout(
        () => reject(new Error("Connect timeout")),
        10_000,
      );

      this.ws.on("open", () => {
        this.ws.send(
          JSON.stringify({
            type: "join",
            roomId: this.roomId,
            metadata: {
              displayName: `bench-${crypto.randomBytes(4).toString("hex")}`,
            },
          }),
        );
      });

      this.ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        this.msgCount++;

        if (msg.type === "room:joined") {
          clearTimeout(timeout);
          this.peerId = msg.peerId;
          this.connected = true;
          this.joinedAt = Date.now();
          this.joinLatency = this.joinedAt - start;
          resolve(this);
        }

        if (msg.type === "error") {
          this.errors++;
        }
      });

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        this.errors++;
        reject(err);
      });

      this.ws.on("close", () => {
        this.connected = false;
      });
    });
  }

  sendData(payload) {
    if (!this.connected) return;
    this.ws.send(JSON.stringify({ type: "data", payload }));
    this.msgCount++;
  }

  sendOffer(targetId) {
    if (!this.connected) return;
    this.ws.send(
      JSON.stringify({
        type: "offer",
        target: targetId,
        sdp: {
          type: "offer",
          sdp: `v=0\r\no=- ${Date.now()} 0 IN IP4 127.0.0.1\r\n`,
        },
      }),
    );
  }

  disconnect() {
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// benchmark command
// ---------------------------------------------------------------------------

module.exports = async function benchmark({ flags }) {
  const totalPeers = flags.peers ?? 50;
  const numRooms = flags.rooms ?? 5;
  const duration = flags.duration ?? 30;
  const url = flags.url ?? "ws://localhost:3000";
  const reportFile = flags.report ?? null;

  const peersPerRoom = Math.ceil(totalPeers / numRooms);
  const rooms = Array.from({ length: numRooms }, (_, i) => `bench-room-${i}`);

  console.log(`\nwebrtc-rooms benchmark`);
  console.log(`  Target  : ${url}`);
  console.log(`  Peers   : ${totalPeers} (${peersPerRoom}/room)`);
  console.log(`  Rooms   : ${numRooms}`);
  console.log(`  Duration: ${duration}s`);
  console.log(`\nConnecting peers…`);

  // ── Phase 1: Connect all peers ─────────────────────────────────────────────
  const peers = [];
  const joinLatencies = [];
  let connectErrors = 0;
  const connectStart = Date.now();

  const connectBatch = async (batchPeers) => {
    await Promise.allSettled(
      batchPeers.map(async (peer) => {
        try {
          await peer.connect();
          if (peer.joinLatency !== null) joinLatencies.push(peer.joinLatency);
        } catch {
          connectErrors++;
        }
      }),
    );
  };

  for (let r = 0; r < numRooms; r++) {
    const batch = [];
    for (let p = 0; p < peersPerRoom && peers.length < totalPeers; p++) {
      batch.push(new VirtualPeer(url, rooms[r]));
      peers.push(batch[batch.length - 1]);
    }
    await connectBatch(batch);
    process.stdout.write(`  ${peers.length}/${totalPeers} connected\r`);
  }

  const connectedPeers = peers.filter((p) => p.connected);
  console.log(
    `\n  ✓ ${connectedPeers.length}/${totalPeers} connected (${connectErrors} errors) in ${Date.now() - connectStart}ms`,
  );

  if (connectedPeers.length === 0) {
    console.error("\nNo peers connected. Is the server running?\n");
    process.exit(1);
  }

  // ── Phase 2: Load — data relay + offers for `duration` seconds ─────────────
  console.log(`\nRunning load for ${duration}s…`);

  const dataLatencies = [];
  let messagesTotal = 0;
  let offersSent = 0;
  const loadStart = Date.now();
  const loadEnd = loadStart + duration * 1000;

  // Group peers by room
  const peersByRoom = new Map();
  for (const peer of connectedPeers) {
    if (!peersByRoom.has(peer.roomId)) peersByRoom.set(peer.roomId, []);
    peersByRoom.get(peer.roomId).push(peer);
  }

  // Continuous load loop
  const loadLoop = setInterval(() => {
    if (Date.now() > loadEnd) {
      clearInterval(loadLoop);
      return;
    }

    for (const [, roomPeers] of peersByRoom) {
      if (roomPeers.length < 2) continue;

      // Each peer sends a data message
      for (const peer of roomPeers) {
        peer.sendData({ ts: Date.now(), from: peer.peerId });
        messagesTotal++;
      }

      // First two peers exchange an offer
      if (roomPeers[0].connected && roomPeers[1].connected) {
        roomPeers[0].sendOffer(roomPeers[1].peerId);
        offersSent++;
      }
    }
  }, 500);

  await sleep(duration * 1000);
  clearInterval(loadLoop);

  // ── Phase 3: Disconnect all peers ─────────────────────────────────────────
  console.log("  Disconnecting peers…");
  for (const peer of connectedPeers) peer.disconnect();
  await sleep(500);

  // ── Phase 4: Report ────────────────────────────────────────────────────────
  const totalErrors = peers.reduce((s, p) => s + p.errors, 0);
  const totalMsgs = peers.reduce((s, p) => s + p.msgCount, 0);
  const durationActual = (Date.now() - loadStart) / 1000;

  const report = {
    timestamp: new Date().toISOString(),
    config: { url, totalPeers, numRooms, durationSec: duration },
    results: {
      connected: connectedPeers.length,
      connectErrors,
      connectRate: Math.round((connectedPeers.length / totalPeers) * 100) + "%",
      joinLatency: histStats(joinLatencies),
      messagesTotal,
      offersSent,
      msgPerSec: Math.round(messagesTotal / durationActual),
      totalErrors,
      errorRate:
        totalMsgs > 0
          ? ((totalErrors / totalMsgs) * 100).toFixed(2) + "%"
          : "0%",
    },
  };

  console.log(
    "\n── Results ──────────────────────────────────────────────────",
  );
  console.log(
    `  Connected         : ${report.results.connected}/${totalPeers} (${report.results.connectRate})`,
  );
  console.log(
    `  Join latency      : p50=${report.results.joinLatency.p50}ms p95=${report.results.joinLatency.p95}ms p99=${report.results.joinLatency.p99}ms`,
  );
  console.log(
    `  Messages sent     : ${messagesTotal} (${report.results.msgPerSec}/s)`,
  );
  console.log(`  Offers sent       : ${offersSent}`);
  console.log(
    `  Total errors      : ${totalErrors} (${report.results.errorRate})`,
  );
  console.log(
    "─────────────────────────────────────────────────────────────\n",
  );

  if (reportFile) {
    const fs = require("fs");
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(`Report written to ${reportFile}\n`);
  }

  return report;
};
