"use strict";

/**
 * @file cli/commands/health.js
 * @description Checks a running webrtc-rooms server's health and stats.
 */

const https = require("https");
const http = require("http");

module.exports = async function health({ pos, flags }) {
  const url = pos[0] ?? "http://localhost:4000/admin/health";
  const secret = flags.secret ?? null;

  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : http;

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    timeout: 5000,
  };

  return new Promise((resolve, reject) => {
    const req = client.request(options, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        if (res.statusCode === 401) {
          console.error("❌  Unauthorized — use --secret <token>");
          process.exit(1);
        }
        try {
          const data = JSON.parse(body);
          if (res.statusCode === 200) {
            console.log(`✓  ${url}`);
            if (data.status) console.log(`   status : ${data.status}`);
            if (data.rooms !== undefined)
              console.log(`   rooms  : ${data.rooms}`);
            if (data.peers !== undefined)
              console.log(`   peers  : ${data.peers}`);
            if (data.uptime !== undefined)
              console.log(`   uptime : ${Math.round(data.uptime)}s`);
            resolve(data);
          } else {
            console.error(
              `❌  HTTP ${res.statusCode}: ${JSON.stringify(data)}`,
            );
            process.exit(1);
          }
        } catch {
          console.log(`✓  ${url} → HTTP ${res.statusCode}`);
          resolve({});
        }
      });
    });

    req.on("error", (err) => {
      console.error(`❌  Could not reach ${url}: ${err.message}`);
      process.exit(1);
    });

    req.on("timeout", () => {
      req.destroy();
      console.error(`❌  Timeout reaching ${url}`);
      process.exit(1);
    });

    req.end();
  });
};
