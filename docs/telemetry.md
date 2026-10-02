# Memory telemetry and safe compaction

The extension works with standalone Pi; no bridge or control-plane service is required.
Telemetry is stored as non-context custom session entries. Consumers read the **active
branch**, not all rows in the session file. Live delivery is optional and is not the
source of truth.

## Persisted integration contract (version 1)

`pi.appendEntry("observational-memory:event", envelope)` persists lifecycle events:

```ts
interface MemoryEvent {
  version: 1;
  type: "memory.observer.started" | "memory.observer.completed" | "memory.observer.failed"
    | "memory.reflector.started" | "memory.reflector.completed" | "memory.reflector.failed"
    | "memory.dropper.completed" | "memory.dropper.failed"
    | "memory.compaction.requested" | "memory.compaction.deferred"
    | "memory.compaction.blocked_on_observer" | "memory.compaction.completed"
    | "memory.compaction.failed";
  timestamp: string; // ISO 8601
  metadata: Record<string, unknown>;
}
```

Metadata includes operationId, sessionId, branchLeafId, source range IDs,
observedThrough/reflectedThrough, model `{provider,id}` (never credentials),
durationMs, itemCount, cutoffs and locally estimated rawTailTokens where applicable.
Worker events include `modelAttempts` identifying primary/fallback attempts;
`model` is the initially resolved model. The started event has an empty attempts
array; completed/failed events contain the actual attempted models.
Failures include `reason` and/or `failure`. A completed worker can have
`committed: false` (empty result); it does not advance coverage. Events never
include full memory text. The matching live bus topic, when available, is
`observational-memory:event` with the same envelope.

`pi.appendEntry("observational-memory:state", snapshot)` persists current derived
memory independently:

```ts
interface MemorySnapshot {
  version: 1;
  reflections: Reflection[]; // id, content, supportingObservationIds, tokenCount
  observations: Observation[]; // id, content, timestamp, relevance, sourceEntryIds, tokenCount
  observedThrough: string | null; // committed source entry ID on this branch
  reflectedThrough: string | null; // committed source entry ID on this branch
  rawTailTokens: number | null; // local estimate of source after observedThrough
  observer: "idle" | "running" | "failed";
  reflector: "idle" | "running" | "failed";
  updatedAt: string; // ISO 8601
}
```

Snapshots are written on worker/compaction transitions, load/navigation and finalized
`turn_end` events, so tail estimates update even when no worker is due.
Snapshots may extend these fields with sessionId, branchLeafId and failures.
The live topic is `observational-memory:state`. On load/navigation the extension
rebuilds memory from the branch-local `om.*` ledger, not from a cached snapshot.
Interrupted running statuses become explicit `failed` / `interrupted` events on reconstruction. Select the latest
snapshot on the active branch for display; coverage in telemetry is descriptive,
not permission to delete source. The ledger is authoritative.

## Coverage and compaction

`coversUpToId` is an inclusive **committed** observer frontier, never an in-flight
target. New observer commits also store a versioned coverage identity with the
previous frontier and ordered source IDs. Commit requires the originating session
and captured branch prefix to still match. Appended turns are allowed; session
replacement or navigation invalidates outstanding work. A new identity has shape
`{ version: 1, fromExclusiveId: string|null, sourceEntryIds: string[], truncatedSourceEntryIds: string[] }`.
The ordered IDs must exactly cover the source range after the previous committed
frontier. Legacy V3 records without this field retain their historical contiguous
`coversUpToId` meaning only when the record and every cited source validate on
this branch; future/dangling/foreign markers never grant coverage.

Excerpt-only observer input does not grant coverage. An oversized source that
cannot fit the configured observer budget fails with `incomplete_source` and
requires raising the budget or using a larger-context memory model. Empty output
also does not grant coverage; this milestone does not introduce coverage-only
empty ledger records.

The hook clamps Pi's desired `firstKeptEntryId` backwards to a valid Pi cut point
at or before the first uncovered source. It never cuts at a tool result. A
boundary with no removable covered source, an unknown ID, an empty rendered
memory, or incompatible prior compaction is cancelled/deferred, **not** delegated
to the native summarizer. This changes the old empty-memory fallback: preserving
unobserved raw history takes priority over context relief. No worker is awaited
inside the hook. Observer failure or deliberate empty output leaves coverage
unchanged; memory can remain blocked until successful observation.

Lifecycle completion for compaction means Pi emitted `session_compact` after
persisting the compaction, not merely that the hook returned a proposal.
Compaction metadata distinguishes the current `observedThrough` from
`coverageUsedThrough` (the committed frontier used by the proposal). Cutoff estimates
`retainedRawTokens` and `desiredRetainedRawTokens` describe the captured preparation,
not provider-exact accounting. Threshold dispatch and hook completion share an
operationId; manual/Pi-native attempts acquire one in the hook.

Workers currently serialize raw source entries, not Pi's `context_edit` replacement
projection. A replacement affecting the prefix to discard therefore blocks with
`context_edited_source`; supporting edit-aware re-observation is future work.
Omitted entries and replacement-edited entries in the retained suffix are allowed.
Outstanding model calls are not aborted on navigation, but cannot commit to another
branch; terminal telemetry for abandoned work is reconstructed as interrupted when
that branch is revisited.

Telemetry is excluded from worker inputs, raw-tail estimates and model context.
Snapshots carry full memory only in the separate state stream.
