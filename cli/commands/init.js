"use strict";

/**
 * @file cli/commands/init.js
 * @description Scaffolds a new webrtc-rooms project.
 *
 * Templates:
 *   basic       — Minimal signaling server (30 lines)
 *   advanced    — Auth + rate limiting + admin API
 *   sfu         — SFU with NativeSFUEngine + AdaptiveBitrateController
 *   enterprise  — Full stack: SFU + Redis + persistence + E2EE + compliance + metrics
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const TEMPLATES = {
  basic: {
    "package.json": (name) =>
      JSON.stringify(
        {
          name,
          version: "1.0.0",
          description: "WebRTC signaling server",
          main: "server.js",
          scripts: { start: "node server.js", dev: "node --watch server.js" },
          dependencies: { "webrtc-rooms": "*" },
          engines: { node: ">=18.0.0" },
        },
        null,
        2,
      ),

    "server.js": () => `'use strict';

const { createServer } = require('webrtc-rooms');

const server = createServer({
  port:             3000,
  maxPeersPerRoom:  50,
  autoCreateRooms:  true,
  autoDestroyRooms: true,
  reconnectTtl:     15_000,
  beforeJoin: async (peer, roomId) => {
    // Add authentication here
    return true;
  },
});

server.on('peer:joined', (peer, room) => {
  console.log(\`[\${new Date().toISOString()}] \${peer.id} joined "\${room.id}"\`);
});

server.on('peer:left', (peer, room) => {
  console.log(\`[\${new Date().toISOString()}] \${peer.id} left "\${room.id}"\`);
});

server.on('listening', ({ port }) => {
  console.log(\`webrtc-rooms listening on ws://localhost:\${port}\`);
});
`,

    ".env.example": () => `PORT=3000
ADMIN_SECRET=change-me
`,

    ".gitignore": () => `node_modules/
.env
*.log
`,

    "README.md": (name) => `# ${name}

WebRTC signaling server built with [webrtc-rooms](https://www.npmjs.com/package/webrtc-rooms).

## Quick start

\`\`\`bash
npm install
node server.js
\`\`\`

Open \`examples/client.html\` in two browser tabs, join the same room.
`,
  },

  advanced: {
    "package.json": (name) =>
      JSON.stringify(
        {
          name,
          version: "1.0.0",
          description: "WebRTC signaling server — advanced setup",
          main: "server.js",
          scripts: { start: "node server.js", dev: "node --watch server.js" },
          dependencies: { "webrtc-rooms": "*" },
          engines: { node: ">=18.0.0" },
        },
        null,
        2,
      ),

    "server.js": () => `'use strict';

require('dotenv').config();

const http    = require('http');
const express = require('express');
const {
  createServer, RateLimiter, AdminAPI,
  PolicyEngine, SessionManager,
  MetricsCollector, AuditLogger, ThreatDetector,
} = require('webrtc-rooms');

const app        = express();
const httpServer = http.createServer(app);

// ── Signaling server ────────────────────────────────────────────────────────
const server = createServer({
  server:           httpServer,
  maxPeersPerRoom:  50,
  autoCreateRooms:  true,
  autoDestroyRooms: true,
  reconnectTtl:     15_000,
});

// ── Policy / auth ───────────────────────────────────────────────────────────
const policy = new PolicyEngine({
  secret:   process.env.POLICY_SECRET || 'change-me',
  required: false,         // set true to enforce tokens
  defaultCaps: ['publish', 'subscribe', 'data'],
});
policy.attach(server);

// ── Session management ──────────────────────────────────────────────────────
const sessions = new SessionManager({ reconnectTtl: 15_000 });
sessions.attach(server);

// ── Rate limiting ───────────────────────────────────────────────────────────
const limiter = new RateLimiter({ maxConnPerMin: 30, maxMsgPerSec: 50 });
limiter.attach(server);

// ── Threat detection ────────────────────────────────────────────────────────
const threats = new ThreatDetector({ server });
threats.attach();
threats.on('threat', ({ level, threat, ip }) => {
  console.warn(\`[threat] \${level} \${threat} from \${ip}\`);
});

// ── Metrics ─────────────────────────────────────────────────────────────────
const metrics = new MetricsCollector({ server });
metrics.attach();

// ── Audit log ───────────────────────────────────────────────────────────────
const audit = new AuditLogger({ server, filePath: './logs/audit.ndjson' });
audit.attach();

// ── Admin API ───────────────────────────────────────────────────────────────
const admin = new AdminAPI({ server, adminSecret: process.env.ADMIN_SECRET });
app.use('/admin', admin.router());

// Prometheus metrics
app.get('/metrics', (_req, res) => {
  res.type('text/plain').send(metrics.toPrometheus());
});

// ── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(process.env.PORT || 3000, () => {
  console.log(\`Server listening on port \${process.env.PORT || 3000}\`);
});
`,

    ".env.example": () => `PORT=3000
ADMIN_SECRET=change-me-admin
POLICY_SECRET=change-me-policy
`,

    ".gitignore": () => `node_modules/
.env
logs/
*.log
`,
  },

  sfu: {
    "package.json": (name) =>
      JSON.stringify(
        {
          name,
          version: "1.0.0",
          description: "WebRTC SFU server",
          main: "server.js",
          scripts: { start: "node server.js" },
          dependencies: { "webrtc-rooms": "*" },
          engines: { node: ">=18.0.0" },
        },
        null,
        2,
      ),

    "server.js": () => `'use strict';

const {
  createServer,
  NativeSFUEngine,
  SFUOrchestrator,
  AdaptiveBitrateController,
  MetricsCollector,
} = require('webrtc-rooms');

const server = createServer({ port: 3000 });

// ── SFU ──────────────────────────────────────────────────────────────────────
const sfuEngine = new NativeSFUEngine({
  region:           process.env.REGION || 'default',
  listenIp:         '0.0.0.0',
  announcedIp:      process.env.PUBLIC_IP || null,
  rtcMinPort:       10000,
  rtcMaxPort:       59999,
  enableSimulcast:  true,
});

const orchestrator = new SFUOrchestrator({ server });
orchestrator.register(process.env.REGION || 'default', sfuEngine);

// ── Adaptive bitrate ──────────────────────────────────────────────────────────
const abc = new AdaptiveBitrateController({ sfuEngine, mobileFirst: true });
abc.attach(server);

// ── Metrics ───────────────────────────────────────────────────────────────────
const metrics = new MetricsCollector({ server });
metrics.attach();

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  await orchestrator.init();
  console.log('SFU server ready on ws://localhost:3000');
})();
`,

    ".env.example": () => `PORT=3000
REGION=us-east-1
PUBLIC_IP=
`,

    ".gitignore": () => `node_modules/\n.env\n`,
  },

  enterprise: {
    "package.json": (name) =>
      JSON.stringify(
        {
          name,
          version: "1.0.0",
          description: "Enterprise WebRTC platform",
          main: "server.js",
          scripts: { start: "node server.js", dev: "node --watch server.js" },
          dependencies: { "webrtc-rooms": "*", redis: "^4.0.0" },
          engines: { node: ">=18.0.0" },
        },
        null,
        2,
      ),

    "server.js": () => `'use strict';

require('dotenv').config();

const http = require('http');
const {
  createServer,
  // Core
  RateLimiter, PolicyEngine, SessionManager,
  // SFU
  NativeSFUEngine, SFUOrchestrator, AdaptiveBitrateController,
  // Scaling
  RedisAdapter, RoomPersistence,
  // Security
  ThreatDetector, AuditLogger,
  // Compliance
  ConsentFlow, DataResidency, RetentionPolicy,
  // Crypto
  E2EKeyExchange,
  // Observability
  MetricsCollector, Tracer, AlertManager, HealthMonitor,
  // Reliability
  EventReplay, BackpressureController,
  // Moderation
  ModerationBus,
  // Admin
  AdminAPI, GovernanceEndpoints,
} = require('webrtc-rooms');
const { createClient } = require('redis');

async function bootstrap() {
  const httpServer = http.createServer();
  const server     = createServer({ server: httpServer, reconnectTtl: 30_000 });

  // ── Redis ──────────────────────────────────────────────────────────────────
  let redisAdapter, persistence;
  if (process.env.REDIS_URL) {
    const pub = await createClient({ url: process.env.REDIS_URL }).connect();
    const sub = await createClient({ url: process.env.REDIS_URL }).connect();
    const rds = await createClient({ url: process.env.REDIS_URL }).connect();

    redisAdapter = new RedisAdapter({ pub, sub, server });
    await redisAdapter.init();

    persistence = new RoomPersistence({ redis: rds, server });
    await persistence.restore();
    persistence.attach();
  }

  // ── SFU ────────────────────────────────────────────────────────────────────
  const sfuEngine   = new NativeSFUEngine({ region: process.env.REGION || 'default' });
  const orchestrator = new SFUOrchestrator({ server });
  orchestrator.register(process.env.REGION || 'default', sfuEngine);
  await orchestrator.init();

  new AdaptiveBitrateController({ sfuEngine, mobileFirst: true }).attach(server);

  // ── Auth + sessions ─────────────────────────────────────────────────────────
  new PolicyEngine({ secret: process.env.POLICY_SECRET, required: true }).attach(server);
  new SessionManager({ reconnectTtl: 30_000 }).attach(server);

  // ── Security ────────────────────────────────────────────────────────────────
  const threats = new ThreatDetector({ server });
  threats.attach();

  // ── Observability ───────────────────────────────────────────────────────────
  const metrics = new MetricsCollector({ server });
  const tracer  = new Tracer({ server, mode: 'buffer' });
  const health  = new HealthMonitor({ server, metrics });
  const alerts  = new AlertManager({ channels: [{ type: 'console' }] });
  metrics.attach();
  tracer.attach();
  health.attach();
  alerts.attachHealthMonitor(health);
  alerts.attachThreatDetector(threats);
  alerts.attachSFUOrchestrator(orchestrator);

  // ── Reliability ─────────────────────────────────────────────────────────────
  new EventReplay({ server }).attach();
  new BackpressureController({ server, maxPeers: 10_000 }).attach();

  // ── Compliance ──────────────────────────────────────────────────────────────
  new ConsentFlow({ server, required: ['recording'] }).attach();
  new DataResidency({ server, localRegion: process.env.REGION || 'default' }).attach();
  new RetentionPolicy().attach(server);

  // ── E2EE ────────────────────────────────────────────────────────────────────
  new E2EKeyExchange({ server }).attach();

  // ── Moderation ──────────────────────────────────────────────────────────────
  new ModerationBus({ server }).attach();

  // ── Rate limiting ────────────────────────────────────────────────────────────
  new RateLimiter({ maxConnPerMin: 30 }).attach(server);

  // ── Admin ────────────────────────────────────────────────────────────────────
  const admin = new AdminAPI({ server, adminSecret: process.env.ADMIN_SECRET });
  const gov   = new GovernanceEndpoints({
    server, adminSecret: process.env.ADMIN_SECRET,
    metrics, tracer, threatDetector: threats,
  });
  gov.listen(Number(process.env.ADMIN_PORT) || 4000);

  // ── Start ─────────────────────────────────────────────────────────────────────
  httpServer.listen(process.env.PORT || 3000, () => {
    console.log(\`Enterprise server on port \${process.env.PORT || 3000}\`);
    console.log(\`Admin API on port \${process.env.ADMIN_PORT || 4000}\`);
  });
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
`,

    ".env.example": () => `PORT=3000
ADMIN_PORT=4000
REGION=us-east-1
REDIS_URL=redis://localhost:6379
POLICY_SECRET=change-me-policy
ADMIN_SECRET=change-me-admin
PUBLIC_IP=
`,

    ".gitignore": () => `node_modules/\n.env\nlogs/\n*.log\n`,
  },
};

// ---------------------------------------------------------------------------
// init command
// ---------------------------------------------------------------------------

module.exports = async function init({ pos, flags }) {
  const dir = pos[0] || ".";
  const template = flags.template || "basic";
  const name = path.basename(dir === "." ? process.cwd() : path.resolve(dir));
  const target = path.resolve(dir);

  if (!TEMPLATES[template]) {
    console.error(
      `Unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(", ")}`,
    );
    process.exit(1);
  }

  // Create directory
  if (dir !== ".") {
    if (fs.existsSync(target)) {
      console.error(`Directory "${dir}" already exists.`);
      process.exit(1);
    }
    fs.mkdirSync(target, { recursive: true });
  }

  const files = TEMPLATES[template];
  const written = [];

  for (const [filename, contentFn] of Object.entries(files)) {
    const filePath = path.join(target, filename);
    const dirPath = path.dirname(filePath);

    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

    const content = contentFn(name);
    fs.writeFileSync(filePath, content, "utf8");
    written.push(filename);
  }

  console.log(
    `\n✓ Created ${template} project in ${dir === "." ? "current directory" : dir}/\n`,
  );
  written.forEach((f) => console.log(`  ${f}`));
  console.log(`
Next steps:
  ${dir !== "." ? `cd ${dir}\n  ` : ""}npm install
  ${dir !== "." ? "" : ""}node server.js
`);
};
