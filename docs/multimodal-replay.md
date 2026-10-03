# Multimodal observer replay

## Captured evidence

The bounded replay used session `01a0fdb6-a6d3-7277-a1eb-5c6bee0e2607`, image-bearing `read` result `3c6044e4`, and its preceding assistant tool-call entry `d7d8cf0f`. The PNG is 2000 × 338 pixels with 129124 base64 characters. No captured session entries were changed and no conversation tools were executed.

Both runs used the installed Pi 1.0.0 composed model runtime with `openai-codex/gpt-6.1-sol` (272000-token context window). The repository's Pi 0.87.0 development dependency does not contain this target model. Existing non-interactive authentication was used; no login, Slack access, or configuration activation occurred.

| Replay | Source | Requests | Result |
|---|---|---|---|
| [Captured tool result](replays/captured-tool-result.json) | Original tool call/result IDs | 2 | One observation cites `3c6044e4`; isolated replay frontier reaches `3c6044e4`. |
| [User envelope](replays/captured-image-user-envelope.json) | Actual captured image/text rewrapped as user source `user-replay-3c6044e4` | 2 | One observation cites that user source; isolated frontier advances. This is not a historical user entry in the captured ledger. |

Each run allowed at most two worker turns, three provider requests, 2048 response tokens per request, and a 90-second provider timeout. The composed provider's `onPayload` hook captured each request separately. Every captured payload must contain the exact ordered list of original MIME types and decoded-image SHA-256 hashes, including repeated occurrences; missing capture, later image loss, reordering, extra images, or duplicate loss fails verification. Both reruns preserved the complete image list in each of their two outgoing requests. Successful attributed observations and committed coverage demonstrate provider acceptance; this is not merely an assertion about the serializer. The artifacts contain per-request image hashes and aggregate results, never image data, credentials, or observation prose.

These are deliberately isolated source-span replays, not claims that the entire captured session was observed or compacted. Deterministic tests cover contiguous prefix construction, user/tool/custom input, rejected payloads, budgets including normalized tool schemas on real agent-loop continuations, incompatible fallbacks, native-compaction resume/fork behavior, unchanged textual reflector/dropper input, and strict per-request image verification.

## Reproduce

Use Node 22.19+ or Node 24 and install development dependencies with `npm ci --ignore-scripts`. The script reads the captured JSONL, isolates the selected image entry and its immediately preceding tool call when applicable, and uses the current extension pipeline in memory. It never writes back to the captured session.

```bash
node --import tsx scripts/replay-observer.mjs <session.jsonl> <image-entry-id> openai-codex gpt-6.1-sol
node --import tsx scripts/replay-observer.mjs <session.jsonl> <image-entry-id> openai-codex gpt-6.1-sol --as-user
```

When the development SDK lacks the target catalog entry, set `PI_OBSERVER_REPLAY_SDK` to the installed Pi coding-agent `dist/index.js` module before running either command. Missing models/auth, worker failures, incomplete or mismatched ordered image lists in any request payload, missing attribution, or an unchanged replay frontier fail the check. Authentication must already be available; do not start interactive login from this script.

The local image allowance is a conservative estimate, not exact provider accounting. The replay does not establish compatibility with every provider, animated-image interpretation, or arbitrary summary-only session imports.

## Host integration and packaging

- The host's disabled setting must exclude the extension from resource loading, including package/explicit extension sources. Passive mode still intercepts compaction and is not suitable for disabling.
- The host owns default-enabled durable session settings, reserved-turn snapshots, and documented resume/fork inheritance. Child runs remain extension-free. Historical memory inspection and timeline filtering do not require loading the extension.
- Re-enable requires the intact raw Pi ancestor branch; native summaries never grant coverage. Recovery can incur additional model calls before coverage catches up. Missing-source imports remain blocked; restore the original session or start fresh.
- `<nixos-config>/hm/packages/pi-observational-memory.nix` packages `package.json`, `src`, `README.md`, and `docs` directly from the `zhengyangfeng00/pi-observational-memory` fork. Its current pin is `5ba8e4f5ab176e3b6b85aeb6561e0cecc7d98bd1`. After review/delivery, update `rev`, source hash, and version suffix to the delivered revision. No package pin or Home Manager activation is performed here.
