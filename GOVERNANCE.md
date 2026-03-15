# Governance

This document defines how decisions are made and how code is merged for
`webrtc-rooms`.

---

## Roles

### Maintainers

Maintainers are responsible for:

- Reviewing and merging pull requests
- Releasing new versions
- Triaging issues and security reports
- Enforcing project policies

### Contributors

Contributors can:

- Propose changes through pull requests
- Report bugs and request features
- Participate in design discussions

---

## Decision-making

- Prefer consensus through pull request discussion.
- For routine changes, a maintainer approval and passing CI are sufficient.
- For major changes (public API, protocol, architecture), open an issue first.
- If consensus cannot be reached, maintainers make the final decision.

---

## Merge policy

The authoritative merge rules are in [CONTRIBUTING.md](./CONTRIBUTING.md).

At minimum, a change must have:

1. Passing CI
2. Maintainer approval
3. Resolved review conversations
4. No unresolved security concerns

---

## Release policy

- The project follows Semantic Versioning.
- Patch: backwards-compatible bug fixes.
- Minor: backwards-compatible features.
- Major: breaking API or protocol changes.

Breaking changes require migration notes in docs and changelog entries.

---

## Enforcement

Maintainers may close or block pull requests that do not follow repository
policies, including quality, security, and community conduct requirements.
