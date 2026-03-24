"use strict";

/**
 * @file cli/commands/simulate.js
 * @description Starts a local multi-process webrtc-rooms cluster for development.
 *
 * Spawns N child processes each running a SignalingServer on consecutive
 * ports. When a Redis URL is provided, all processes share state via
 * RedisAdapter. A supervisor process monitors health and restarts crashed
 * workers.
 *
 * Usage:
 *   webrtc-rooms simulate --processes 3 --port 3000 --redis redis://localhost:6379
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ---------------------------------------------------------------------------
// Worker script (written to a temp file and spawned)
// ---------------------------------------------------------------------------

function workerScript(port, redisUrl, rooms) {
  return `
'use strict';
const { createServer, RedisAdapter, RoomPersistence } = require('${path.resolve(__dirname, "../..")}');
${redisUrl ? `const { createClient } = require('redis');` : ""}

const server = createServer({
  port: ${port},
  autoCreateRooms: true,
  autoDestroyRooms: true,
  reconnectTtl: 15_000,
});

${
  redisUrl
    ? `
(async () => {
  const pub = await createClient({ url: '${redisUrl}' }).connect();
  const sub = await createClient({ url: '${redisUrl}' }).connect();
  const rds = await createClient({ url: '${redisUrl}' }).connect();

  const adapter = new RedisAdapter({ pub, sub, server });
  await adapter.init();

  const persistence = new RoomPersistence({ redis: rds, server });
  await persistence.restore();
  persistence.attach();
  console.log('[process:${port}] Redis adapters connected');
})().catch(console.error);
`
    : ""
}

${
  rooms > 0
    ? `
server.on('listening', () => {
  for (let i = 0; i < ${rooms}; i++) {
    server.createRoom('room-' + i, { metadata: { topic: 'Room ' + i } });
  }
  console.log('[process:${port}] Pre-created ${rooms} rooms');
});
`
    : ""
}

server.on('listening', ({ port: p }) => {
  console.log('[process:' + p + '] Ready ws://localhost:' + p);
});

server.on('peer:joined', (peer, room) => {
  process.stdout.write('[' + Date.now() + '] peer:joined ' + peer.id + ' -> ' + room.id + '\\n');
});

process.on('SIGTERM', async () => {
  await server.close();
  process.exit(0);
});
`.trim();
}

// ---------------------------------------------------------------------------
// simulate command
// ---------------------------------------------------------------------------

module.exports = async function simulate({ flags }) {
  const numProcesses = flags.processes ?? 2;
  const basePort = flags.port ?? 3000;
  const redisUrl = flags.redis ?? null;
  const rooms = flags.rooms ?? 0;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "webrtc-rooms-sim-"));
  const workers = [];

  console.log(`\nwebrtc-rooms simulate`);
  console.log(`  Processes : ${numProcesses}`);
  console.log(`  Ports     : ${basePort}–${basePort + numProcesses - 1}`);
  console.log(`  Redis     : ${redisUrl ?? "disabled (in-process only)"}`);
  console.log(`  Rooms     : ${rooms > 0 ? rooms + " pre-created" : "none"}`);
  console.log(`\nStarting workers…\n`);

  for (let i = 0; i < numProcesses; i++) {
    const port = basePort + i;
    const scriptPath = path.join(tmpDir, `worker-${port}.js`);
    fs.writeFileSync(scriptPath, workerScript(port, redisUrl, rooms));

    const worker = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
      env: { ...process.env, PORT: String(port) },
    });

    worker.on("exit", (code, signal) => {
      if (signal !== "SIGTERM" && code !== 0) {
        console.error(
          `[supervisor] Worker on port ${port} exited (code=${code}). Restarting in 2s…`,
        );
        setTimeout(() => restartWorker(i), 2000);
      }
    });

    workers.push({ port, process: worker, scriptPath });
    console.log(`  [started] worker ${i + 1}/${numProcesses} → port ${port}`);
  }

  function restartWorker(idx) {
    const { port, scriptPath } = workers[idx];
    const worker = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
      env: { ...process.env },
    });
    worker.on("exit", (code, signal) => {
      if (signal !== "SIGTERM" && code !== 0) {
        setTimeout(() => restartWorker(idx), 2000);
      }
    });
    workers[idx].process = worker;
    console.log(`  [restarted] worker on port ${port}`);
  }

  console.log(`\nCluster running. Press Ctrl+C to stop.\n`);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down cluster…");
    for (const w of workers) {
      try {
        w.process.kill("SIGTERM");
      } catch {}
    }
    // Clean up temp files
    setTimeout(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true });
      } catch {}
      process.exit(0);
    }, 1500);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  await new Promise(() => {});
};
