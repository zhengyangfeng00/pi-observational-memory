import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.js";
import { committedObserverFrontier, committedReflectionFrontier } from "./session-ledger/coverage.js";
import { fullProjection, rawTokensAfterIndex, type Entry, type Observation, type Reflection } from "./session-ledger/index.js";

export const MEMORY_EVENT = "observational-memory:event";
export const MEMORY_STATE = "observational-memory:state";
export type WorkerStatus = "idle" | "running" | "failed";
export type MemoryEvent = {
	version: 1;
	type: `memory.${"observer" | "reflector"}.${"started" | "completed" | "failed"}`
		| `memory.dropper.${"completed" | "failed"}`
		| `memory.compaction.${"requested" | "deferred" | "blocked_on_observer" | "completed" | "failed"}`;
	timestamp: string;
	metadata: Record<string, unknown>;
};
export type MemorySnapshot = {
	version: 1;
	reflections: Reflection[];
	observations: Observation[];
	observedThrough: string | null;
	reflectedThrough: string | null;
	rawTailTokens: number | null;
	observer: WorkerStatus;
	reflector: WorkerStatus;
	updatedAt: string;
	sessionId: string | null;
	branchLeafId: string | null;
	failures: { observer: string | null; reflector: string | null };
};
export type MemoryContext = {
	sessionManager: { getBranch: () => unknown; getSessionId?: () => string; getSessionFile?: () => string | undefined };
};

export function operationId(): string {
	return `memory-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

export function contextMetadata(ctx: MemoryContext): Record<string, unknown> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observed = committedObserverFrontier(entries);
	return {
		sessionId: ctx.sessionManager.getSessionId?.() ?? null,
		branchLeafId: entries.at(-1)?.id ?? null,
		observedThrough: observed.id,
		reflectedThrough: committedReflectionFrontier(entries),
		rawTailTokens: rawTokensAfterIndex(entries, observed.index),
	};
}

/** Best-effort observability must not turn a safe cancellation into native fallback. */
function persist(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
	try { pi.events?.emit(customType, data); } catch { /* live consumers cannot undo persistence */ }
}

export function emitMemoryEvent(pi: ExtensionAPI, ctx: MemoryContext, type: MemoryEvent["type"], metadata: Record<string, unknown> = {}): void {
	const envelope: MemoryEvent = { version: 1, type, timestamp: new Date().toISOString(), metadata: { ...contextMetadata(ctx), ...metadata } };
	// Freeze the serialized value, not shared arrays later filled by fallback attempts.
	persist(pi, MEMORY_EVENT, JSON.parse(JSON.stringify(envelope)));
}

export function buildMemorySnapshot(ctx: MemoryContext): MemorySnapshot {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const memory = fullProjection(entries);
	const metadata = contextMetadata(ctx);
	const statuses: Record<"observer" | "reflector", WorkerStatus> = { observer: "idle", reflector: "idle" };
	const failures = { observer: null as string | null, reflector: null as string | null };
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MEMORY_EVENT) continue;
		const event = entry.data as MemoryEvent | undefined;
		if (event?.version !== 1) continue;
		for (const worker of ["observer", "reflector"] as const) {
			if (event.type === `memory.${worker}.started`) { statuses[worker] = "running"; failures[worker] = null; }
			if (event.type === `memory.${worker}.completed`) statuses[worker] = "idle";
			if (event.type === `memory.${worker}.failed`) {
				statuses[worker] = "failed";
				failures[worker] = String(event.metadata?.failure ?? event.metadata?.reason ?? "worker_failed");
			}
		}
	}
	return { version: 1, ...memory, ...metadata, ...statuses, failures, updatedAt: new Date().toISOString() } as MemorySnapshot;
}

export function persistMemoryState(pi: ExtensionAPI, ctx: MemoryContext): void {
	persist(pi, MEMORY_STATE, buildMemorySnapshot(ctx));
}

/** Capture the originating branch, allowing append-only growth but never navigation or replacement. */
export function captureBranch(runtime: Runtime, ctx: MemoryContext, expectedEntries?: Entry[]): () => boolean {
	const epoch = runtime.memoryEpoch ?? 0;
	const manager = ctx.sessionManager;
	const session = manager.getSessionId?.() ?? manager.getSessionFile?.();
	const entries = expectedEntries ?? manager.getBranch() as Entry[];
	const ids = entries.map((entry) => entry.id);
	return () => {
		try {
			if ((runtime.memoryEpoch ?? 0) !== epoch || ctx.sessionManager !== manager
				|| (manager.getSessionId?.() ?? manager.getSessionFile?.()) !== session) return false;
			const current = manager.getBranch() as Entry[];
			return ids.every((id, index) => current[index]?.id === id)
				&& !current.slice(ids.length).some((entry) => entry.type === "context_edit"
					&& ids.includes((entry as Entry & { targetId: string }).targetId));
		} catch { return false; }
	};
}

export function registerMemoryTelemetry(pi: ExtensionAPI, runtime: Runtime): void {
	const invalidate = () => {
		runtime.memoryEpoch = (runtime.memoryEpoch ?? 0) + 1;
		runtime.observerEmptyBackoff = undefined;
	};
	pi.on("session_before_switch", invalidate);
	pi.on("session_before_fork", invalidate);
	pi.on("session_before_tree", invalidate);
	pi.on("session_shutdown", invalidate);
	const refresh = (_event: unknown, ctx: MemoryContext) => {
		invalidate();
		// A persisted started event from a prior process/navigation is not a live worker.
		const snapshot = buildMemorySnapshot(ctx);
		for (const worker of ["observer", "reflector"] as const) {
			if (snapshot[worker] === "running") emitMemoryEvent(pi, ctx, `memory.${worker}.failed`, { reason: "interrupted", failure: "worker interrupted by session lifecycle" });
		}
		persistMemoryState(pi, ctx);
	};
	pi.on("session_start", refresh);
	pi.on("session_tree", refresh);
	pi.on("turn_end", (_event, ctx) => persistMemoryState(pi, ctx));
}
