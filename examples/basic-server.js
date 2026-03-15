'use strict';

/**
 * @file examples/basic-server.js
 * @description Minimal signaling server example.
 *
 * Starts a WebSocket signaling server on port 3000.
 * Open examples/client.html in two browser tabs and join the same room to
 * establish a peer-to-peer video call.
 *
 * Usage:
 *   node examples/basic-server.js
 */

const { createServer } = require('../src');

const server = createServer({
  port:             3000,
  autoCreateRooms:  true,
  autoDestroyRooms: true,
});

server.on('listening', ({ port }) => {
  console.log(`\nwebrtc-rooms signaling server ready`);
  console.log(`  ws://localhost:${port}\n`);
  console.log(`Open examples/client.html in two browser tabs and join the same room.\n`);
});

server.on('room:created',   (room)        => console.log(`[+] Room created  "${room.id}"`));
server.on('room:destroyed', (room)        => console.log(`[-] Room removed  "${room.id}"`));

server.on('peer:joined', (peer, room) => {
  const name = peer.metadata.displayName ?? peer.id.slice(0, 8);
  console.log(`[→] ${name} joined  "${room.id}"  (${room.size} peer${room.size !== 1 ? 's' : ''})`);
});

server.on('peer:left', (peer, room) => {
  const name = peer.metadata.displayName ?? peer.id.slice(0, 8);
  console.log(`[←] ${name} left    "${room.id}"  (${room.size} peer${room.size !== 1 ? 's' : ''})`);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down…');
  await server.close();
  process.exit(0);
});