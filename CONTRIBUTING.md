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

## Code merge rules (maintainers + contributors)

To keep `main` stable, all changes must follow these merge rules:

1. **No direct pushes to `main`**. All changes go through pull requests.
2. **Passing CI is required** before merge (all matrix jobs green).
3. **At least 1 maintainer approval** is required for every PR.
4. **Self-approval is not allowed** for non-trivial changes.
5. **Conversation resolution required**: all blocking review comments must be
   addressed before merge.
6. **Up-to-date branch required**: PR branch must be rebased or merged with the
   latest `main` if requested by maintainers or if CI is outdated.
7. **Squash merge only** (default) to keep history readable and atomic.
8. **Breaking changes** require:

- clear `BREAKING CHANGE:` note in PR description,
- README/API documentation updates,
- Changelog update,
- major version bump in the release plan.

9. **Security-sensitive changes** (auth, rate limit, admin API, recording,
   dependency updates) need explicit maintainer review.

---

## Pull request quality rules

- Keep PRs focused. Prefer one logical change per PR.
- Add or update tests for behaviour changes.
- Update docs (README / API docs / examples) if public behaviour changes.
- Include migration notes for breaking or operational changes.
- Do not include unrelated refactors in bug-fix PRs.
- Keep secrets out of commits, tests, screenshots, and logs.

---

## Commit rules

- Use clear commit messages in imperative mood.
  - Good: `fix(room): reject duplicate peer join during reconnect`
  - Good: `docs: clarify reconnect token TTL behaviour`
- Prefer small, reviewable commits.
- If force-push is needed on your PR branch, mention it in the PR comments.

---

## Repository-wide rules

- **Security disclosures** must follow [SECURITY.md](./SECURITY.md); never open
  public issues for zero-day vulnerabilities.
- **Community behaviour** must follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
- **Support and issue quality** must follow [SUPPORT.md](./SUPPORT.md).
- **Governance and maintainer responsibilities** are defined in
  [GOVERNANCE.md](./GOVERNANCE.md).

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
