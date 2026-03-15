# Contributing to webrtc-rooms

Thank you for your interest in contributing. This document covers how to get
started, the coding standards we follow, and the process for submitting changes.

---

## Getting started

```bash
git clone https://github.com/himanshu-pandey-git/webrtc-rooms.git
cd webrtc-rooms
npm install
node tests/index.test.js   # all tests should pass before you begin
```

---

## Project layout

```
src/
  index.js                 Public entry point; re-exports everything.
  Peer.js                  Per-connection WebSocket wrapper + state machine.
  Room.js                  Multi-peer session; routes all signaling messages.
  SignalingServer.js        WebSocket server; manages rooms and peers.
  AdminAPI.js              REST HTTP admin interface.
  adapters/
    RecordingAdapter.js    ffmpeg-backed media recording.
    MediasoupAdapter.js    mediasoup v3 SFU integration.
  middleware/
    RateLimiter.js         Per-IP connection and per-peer signal rate limiting.
tests/
  index.test.js            Full test suite (no external runner required).
examples/
  basic-server.js          Minimal server example.
  advanced-server.js       Full-featured server with auth, recording, and admin.
  client.html              Browser test client.
```

---

## Running tests

```bash
node tests/index.test.js
```

The suite is self-contained: it boots real WebSocket servers on ephemeral ports,
connects real clients, and tears everything down at the end. No mocking framework,
no test runner dependency.

When adding a feature or fixing a bug, add at least one new test that would have
caught the issue.

---

## Coding standards

- **Style**: `'use strict'` at the top of every file. 2-space indentation.
  Single quotes for strings. Semicolons required.
- **Comments**: Every exported class, method, and event must have a JSDoc block.
  Use `@param`, `@returns`, `@throws`, `@fires`, and `@example` where applicable.
  Internal helpers (`_prefixed`) need a brief one-liner.
- **Error handling**: Never swallow errors silently unless you have a documented
  reason. Prefer `console.warn` for expected edge cases (unknown message type,
  unknown peer ID) and `console.error` for unexpected failures.
- **No external runtime dependencies** beyond `ws` and `uuid`.
  `mediasoup` is an optional peer dependency and must never be `require()`d
  at module load time — import it lazily with a `try/catch`.
- **Backward compatibility**: The public API (everything exported from `src/index.js`)
  follows semantic versioning. Breaking changes require a major version bump.

---

## Submitting changes

1. **Fork** the repository and create a feature branch from `main`.
2. Make your changes with tests and documentation.
3. Run `node tests/index.test.js` — all tests must pass.
4. Open a **pull request** with a clear title and description of what changed
   and why.

For substantial changes (new adapters, protocol changes, security fixes), open
an issue first to discuss the approach before writing code.

---

## Reporting bugs

Open a GitHub issue with:

- Node.js version (`node --version`)
- A minimal reproduction (ideally a single JS file)
- Expected behaviour vs actual behaviour
- Any relevant error output

---

## License

By contributing you agree that your contributions will be licensed under the
[MIT License](./LICENSE).