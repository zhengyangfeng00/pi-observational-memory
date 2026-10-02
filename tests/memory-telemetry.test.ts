import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { Runtime } from "../src/runtime.js";
import { committedObserverFrontier } from "../src/session-ledger/coverage.js";
import { buildMemorySnapshot, captureBranch, emitMemoryEvent, MEMORY_EVENT, MEMORY_STATE, persistMemoryState, registerMemoryTelemetry } from "../src/telemetry.js";
import { observation, reflectionsRecordedEntry } from "./fixtures/session.js";

function harness() {
	const manager = SessionManager.inMemory();
	const handlers: Record<string, ((event: any, ctx: any) => any)[]> = {};
	const pi = {
		on: (name: string, handler: (event: any, ctx: any) => any) => { (handlers[name] ??= []).push(handler); },
		appendEntry: vi.fn((type, data) => manager.appendCustomEntry(type, data)),
		events: { emit: vi.fn() },
	};
	const runtime = new Runtime();
	runtime.configLoaded = true;
	const ctx = { cwd: "/tmp/test", hasUI: false, sessionManager: manager };
	return { manager, handlers, pi, runtime, ctx };
}

function user(manager: SessionManager, content: string) {
	return manager.appendMessage({ role: "user", content, timestamp: Date.now() });
}
function commit(manager: SessionManager, id: string) {
	manager.appendCustomEntry("om.observations.recorded", {
		observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: [id] })], coversUpToId: id,
		coverage: { version: 1, fromExclusiveId: null, sourceEntryIds: [id], truncatedSourceEntryIds: [] },
	});
}

describe("standalone Pi session persistence and projection", () => {
	it("actually retains the unobserved raw suffix in Pi's rebuilt context", async () => {
		const s = harness();
		const first = user(s.manager, "covered text");
		commit(s.manager, first);
		const unobserved = user(s.manager, "unobserved text that must remain raw");
		const desired = user(s.manager, "recent text");
		registerCompactionHook(s.pi as any, s.runtime);
		const result = await s.handlers.session_before_compact[0]({ reason: "manual", branchEntries: s.manager.getBranch(), preparation: { firstKeptEntryId: desired, tokensBefore: 100 } }, s.ctx);
		expect(result.compaction.firstKeptEntryId).toBe(unobserved);
		const c = result.compaction;
		const compactionId = s.manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
		await s.handlers.session_compact[0]({ compactionEntry: s.manager.getEntry(compactionId) }, s.ctx);
		const messages = s.manager.buildSessionContext().messages;
		expect(messages.map((message) => (message as any).content)).toContain("unobserved text that must remain raw");
		expect(messages.map((message) => (message as any).content)).not.toContain("covered text");
		expect(messages.map((message) => message.role)).toContain("compactionSummary");
		expect(messages.some((message) => (message as any).customType === MEMORY_EVENT || (message as any).customType === MEMORY_STATE)).toBe(false);
		expect(buildMemorySnapshot(s.ctx).observedThrough).toBe(first);
	});

	it("cancels a stale Pi preparation rather than using another branch's coverage", async () => {
		const s = harness();
		const root = user(s.manager, "root");
		commit(s.manager, root);
		const oldBoundary = user(s.manager, "left branch");
		const oldEntries = s.manager.getBranch();
		s.manager.branch(root);
		user(s.manager, "right branch");
		registerCompactionHook(s.pi as any, s.runtime);
		const result = await s.handlers.session_before_compact[0]({ branchEntries: oldEntries, preparation: { firstKeptEntryId: oldBoundary, tokensBefore: 100 } }, s.ctx);
		expect(result).toEqual({ cancel: true });
		expect(s.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not inherit abandoned branch coverage or state", () => {
		const s = harness();
		const root = user(s.manager, "root");
		const left = user(s.manager, "left branch");
		// Valid legacy coverage illustrates historical branch-local records.
		s.manager.appendCustomEntry("om.observations.recorded", { observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: [root, left] })], coversUpToId: left });
		persistMemoryState(s.pi as any, s.ctx);
		expect(buildMemorySnapshot(s.ctx).observedThrough).toBe(left);
		s.manager.branch(root);
		user(s.manager, "right branch");
		const snapshot = buildMemorySnapshot(s.ctx);
		expect(snapshot.observedThrough).toBeNull();
		expect(snapshot.observations).toEqual([]);
		expect(committedObserverFrontier(s.manager.getBranch()).id).toBeNull();
	});

	it("reconstructs interrupted running state as explicit failure on session start", async () => {
		const s = harness();
		user(s.manager, "source");
		emitMemoryEvent(s.pi as any, s.ctx, "memory.observer.started", { operationId: "prior-process" });
		expect(buildMemorySnapshot(s.ctx).observer).toBe("running");
		registerMemoryTelemetry(s.pi as any, s.runtime);
		await s.handlers.session_start[0]({}, s.ctx);
		expect(buildMemorySnapshot(s.ctx)).toMatchObject({ observer: "failed", observedThrough: null, failures: { observer: "worker interrupted by session lifecycle" } });
		expect(s.pi.appendEntry).toHaveBeenCalledWith(MEMORY_EVENT, expect.objectContaining({ type: "memory.observer.failed", metadata: expect.objectContaining({ reason: "interrupted" }) }));
		expect(s.pi.appendEntry).toHaveBeenCalledWith(MEMORY_STATE, expect.objectContaining({ observer: "failed" }));
	});

	it("invalidates work even when tree navigation returns to the same IDs", async () => {
		const s = harness();
		user(s.manager, "source");
		registerMemoryTelemetry(s.pi as any, s.runtime);
		const current = captureBranch(s.runtime, s.ctx);
		expect(current()).toBe(true);
		s.runtime.observerEmptyBackoff = { sessionIdentity: s.manager.getSessionId(), coverageId: undefined, tokensAtEmpty: 50 };
		await s.handlers.session_before_tree[0]({}, s.ctx);
		expect(current()).toBe(false);
		expect(s.runtime.observerEmptyBackoff).toBeUndefined();
	});

	it("updates raw-tail snapshots on ordinary turns without running a worker", async () => {
		const s = harness();
		registerMemoryTelemetry(s.pi as any, s.runtime);
		await s.handlers.session_start[0]({}, s.ctx);
		expect(buildMemorySnapshot(s.ctx).rawTailTokens).toBe(0);
		user(s.manager, "new raw source");
		await s.handlers.turn_end[0]({}, s.ctx);
		const snapshot = s.pi.appendEntry.mock.calls.filter(([type]) => type === MEMORY_STATE).at(-1)![1];
		expect(snapshot).toMatchObject({ observer: "idle", observedThrough: null, observations: [] });
		expect(snapshot.rawTailTokens).toBeGreaterThan(0);
	});

	it("shares threshold-dispatch operation identity with hook completion", async () => {
		const s = harness();
		const first = user(s.manager, "source"); commit(s.manager, first);
		const boundary = user(s.manager, "tail");
		s.runtime.memoryCompactionRequest = { operationId: "request-id", startedAt: Date.now(), current: captureBranch(s.runtime, s.ctx), metadata: { threshold: 10 } };
		emitMemoryEvent(s.pi as any, s.ctx, "memory.compaction.requested", { operationId: "request-id" });
		registerCompactionHook(s.pi as any, s.runtime);
		await s.handlers.session_before_compact[0]({ branchEntries: s.manager.getBranch(), preparation: { firstKeptEntryId: boundary, tokensBefore: 100 } }, s.ctx);
		await s.handlers.session_compact[0]({ compactionEntry: { id: "cmp", firstKeptEntryId: boundary } }, s.ctx);
		const events = s.pi.appendEntry.mock.calls.filter(([type]) => type === MEMORY_EVENT).map(([, data]) => data);
		expect(events.filter((event) => event.type === "memory.compaction.requested")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "memory.compaction.completed", metadata: { operationId: "request-id", threshold: 10, coverageUsedThrough: first } });
	});

	it("persists telemetry even if the optional live bridge throws", () => {
		const s = harness();
		user(s.manager, "source");
		s.pi.events.emit.mockImplementation(() => { throw Error("bridge down"); });
		expect(() => emitMemoryEvent(s.pi as any, s.ctx, "memory.observer.failed", { failure: "worker down" })).not.toThrow();
		expect(buildMemorySnapshot(s.ctx)).toMatchObject({ observer: "failed", failures: { observer: "worker down" } });
	});

	it("does not advance reflection frontier for nonexistent supporting memory", () => {
		const s = harness();
		const first = user(s.manager, "source");
		commit(s.manager, first);
		const record = reflectionsRecordedEntry("unused", { reflections: [{ id: "bbbbbbbbbbbb", content: "unsupported", supportingObservationIds: ["foreign"], tokenCount: 1 }], coversUpToId: first });
		s.manager.appendCustomEntry(record.customType!, record.data);
		expect(buildMemorySnapshot(s.ctx).reflectedThrough).toBeNull();
	});
});
