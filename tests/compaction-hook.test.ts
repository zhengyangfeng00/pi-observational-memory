import { describe, expect, it, vi } from "vitest";
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { committedObserverFrontier, safeCompactionCut } from "../src/session-ledger/coverage.js";
import { MEMORY_EVENT, MEMORY_STATE } from "../src/telemetry.js";
import { compactionEntry, memoryDetails, observation, observationsRecordedEntry, observationsDroppedEntry,
	reflection, reflectionsRecordedEntry, rawMessage, textCustomMessage, type TestEntry } from "./fixtures/session.js";

function recorded(end = "raw-1", ids = ["raw-1"], overrides: Record<string, unknown> = {}) {
	return observationsRecordedEntry("observed", { observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ids })], coversUpToId: end },
		{ data: { observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ids })], coversUpToId: end,
			coverage: { version: 1, fromExclusiveId: null, sourceEntryIds: ids, truncatedSourceEntryIds: [] }, ...overrides } });
}

function setup(initial: TestEntry[], poolMax = 20_000) {
	let entries = initial;
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	const pi = { on: vi.fn((name, cb) => { handlers[name] = cb; }),
		appendEntry: vi.fn((customType, data) => { entries = [...entries, { type: "custom", id: `telemetry-${pi.appendEntry.mock.calls.length}`, parentId: null, timestamp: "", customType, data }]; }),
		events: { emit: vi.fn() } };
	const runtime = { config: { observationsPoolMaxTokens: poolMax }, compactHookInFlight: false, memoryEpoch: 0,
		ensureConfig: vi.fn(), resolveModel: vi.fn(() => { throw Error("no model calls in hook"); }) };
	const ctx = { cwd: "/tmp/project", hasUI: true, ui: { notify: vi.fn() }, sessionManager: { getBranch: () => entries, getSessionId: () => "session" } };
	registerCompactionHook(pi as any, runtime as any);
	return { pi, runtime, ctx, handlers,
		run: (firstKeptEntryId: string) => handlers.session_before_compact({ preparation: { firstKeptEntryId, tokensBefore: 123 }, branchEntries: entries, reason: "manual" }, ctx) };
}

describe("safe committed observer compaction", () => {
	it("cancels empty/unobserved memory without native summarization or waiting", async () => {
		const s = setup([textCustomMessage("raw-1", "aaa"), textCustomMessage("raw-2", "bbb")]);
		await expect(s.run("raw-2")).resolves.toEqual({ cancel: true });
		expect(s.runtime.resolveModel).not.toHaveBeenCalled();
		expect(s.pi.appendEntry).toHaveBeenCalledWith(MEMORY_EVENT, expect.objectContaining({ type: "memory.compaction.blocked_on_observer", metadata: expect.objectContaining({ reason: "no_committed_observer_coverage" }) }));
	});
	it("clamps Pi's later desired cutoff to the first unobserved source", async () => {
		const s = setup([textCustomMessage("raw-1", "aaa"), recorded(), textCustomMessage("raw-2", "bbb"), textCustomMessage("raw-3", "ccc")]);
		const result = await s.run("raw-3");
		expect(result.compaction.firstKeptEntryId).toBe("raw-2");
		expect(result.compaction.summary).toContain("aaaaaaaaaaaa");
		expect(s.runtime.compactHookInFlight).toBe(false);
	});
	it("includes a committed batch spanning beyond Pi's earlier desired cutoff", async () => {
		const s = setup([textCustomMessage("raw-1", "a"), textCustomMessage("raw-2", "b"), textCustomMessage("raw-3", "c"), recorded("raw-3", ["raw-1", "raw-2", "raw-3"])]);
		const result = await s.run("raw-2");
		expect(result.compaction.firstKeptEntryId).toBe("raw-2");
		expect(result.compaction.details.observations).toHaveLength(1);
	});
	it("backs up from an uncovered tool result to its assistant call", () => {
		const entries = [rawMessage("raw-1", "a"), rawMessage("call", "b", { message: { role: "assistant", content: [{ type: "toolCall", id: "tool" }] } }),
			recorded("call", ["raw-1", "call"]), rawMessage("tool", "", { message: { role: "toolResult", toolCallId: "tool" } }), rawMessage("next", "c")];
		expect(safeCompactionCut(entries, "next")).toMatchObject({ ok: true, firstKeptEntryId: "call", clamped: true });
	});
	it("does not cut away the assistant when doing so would split an uncovered tool result", () => {
		const entries = [rawMessage("call", "b", { message: { role: "assistant" } }), recorded("call", ["call"]), rawMessage("tool", "", { message: { role: "toolResult" } }), rawMessage("next", "c")];
		expect(safeCompactionCut(entries, "next")).toMatchObject({ ok: false, reason: "no_removable_covered_source" });
	});
	it.each(["missing", "raw-1"])("cancels unknown/no-progress desired boundary %s", async (desired) => {
		const s = setup([textCustomMessage("raw-1", "a"), recorded(), textCustomMessage("raw-2", "b")]);
		await expect(s.run(desired)).resolves.toEqual({ cancel: true });
	});
	it("does not trust a running observer's target or unrelated telemetry snapshot", async () => {
		const s = setup([textCustomMessage("raw-1", "a"), { type: "custom", id: "state", parentId: null, timestamp: "", customType: MEMORY_STATE, data: { observedThrough: "raw-1" } }, textCustomMessage("raw-2", "b")]);
		(s.runtime as any).consolidationInFlight = true;
		await expect(s.run("raw-2")).resolves.toEqual({ cancel: true });
	});
	it("uses newly committed observer coverage on the next attempt", async () => {
		const entries = [textCustomMessage("raw-1", "a"), textCustomMessage("raw-2", "b")];
		const s = setup(entries);
		await expect(s.run("raw-2")).resolves.toEqual({ cancel: true });
		// The hook reads a fresh branch snapshot each time, not an in-flight cache.
		const ready = setup([...entries, recorded()]);
		expect((await ready.run("raw-2")).compaction.firstKeptEntryId).toBe("raw-2");
	});
	it("preserves normal and full-fold reflection/drop behavior", async () => {
		const obs = observation("aaaaaaaaaaaa");
		const ref = reflection("eeeeeeeeeeee", [obs.id]);
		const entries = [textCustomMessage("raw-1", "a"), recorded(), reflectionsRecordedEntry("ref", { reflections: [ref], coversUpToId: "raw-1" }),
			textCustomMessage("raw-2", "b")];
		expect((await setup(entries, 100).run("raw-2")).compaction.details.reflections).toEqual([]);
		const full = await setup(entries, 1).run("raw-2");
		expect(full.compaction.details).toMatchObject({ fullFold: true, reflections: [ref] });
		const empty = setup([...entries, observationsDroppedEntry("drop", { observationIds: [obs.id], coversUpToId: "raw-1" })], 1);
		expect((await empty.run("raw-2")).compaction.summary).toContain("eeeeeeeeeeee");
	});
	it("cancels when projection is empty even though observer coverage exists", async () => {
		const entries = [textCustomMessage("raw-1", "a"), recorded(), observationsDroppedEntry("drop", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-1" }), textCustomMessage("raw-2", "b")];
		await expect(setup(entries, 1).run("raw-2")).resolves.toEqual({ cancel: true });
	});
	it("blocks replacement-edited prefixes but permits edited retained source and later omission", () => {
		const base = [textCustomMessage("raw-1", "a"), recorded(), textCustomMessage("raw-2", "b")];
		const edit = { type: "context_edit", id: "edit", targetId: "raw-1", replacement: "new text" };
		expect(safeCompactionCut([...base, edit], "raw-2")).toMatchObject({ ok: false, reason: "context_edited_source" });
		expect(safeCompactionCut([...base, { ...edit, targetId: "raw-2" }], "raw-2")).toMatchObject({ ok: true });
		expect(safeCompactionCut([...base, edit, { ...edit, id: "omit", replacement: null }], "raw-2")).toMatchObject({ ok: true });
	});

	it("refuses a boundary that would resurrect already compacted uncovered source", () => {
		const entries = [textCustomMessage("raw-1", "a"), recorded(), textCustomMessage("raw-2", "b"), textCustomMessage("raw-3", "c"), compactionEntry("cmp", { firstKeptEntryId: "raw-3", details: memoryDetails() })];
		expect(safeCompactionCut(entries, "raw-3")).toMatchObject({ ok: false, reason: "incompatible_previous_boundary" });
	});
	it("persists completion only after Pi commits, with no memory in event payload", async () => {
		const s = setup([textCustomMessage("raw-1", "a"), recorded(), textCustomMessage("raw-2", "b")]);
		await s.run("raw-2");
		expect(s.pi.appendEntry.mock.calls.some(([, data]) => data.type === "memory.compaction.completed")).toBe(false);
		s.handlers.session_compact({ compactionEntry: { id: "cmp", firstKeptEntryId: "raw-2" } }, s.ctx);
		const completed = s.pi.appendEntry.mock.calls.find(([, data]) => data.type === "memory.compaction.completed")![1];
		expect(completed).toMatchObject({ version: 1, timestamp: expect.any(String), metadata: { firstKeptEntryId: "raw-2", observedThrough: "raw-1", durationMs: expect.any(Number) } });
		expect(JSON.stringify(completed)).not.toContain("Observation aaaaaaaaaaaa");
		expect(s.pi.appendEntry).toHaveBeenCalledWith(MEMORY_STATE, expect.objectContaining({ observations: [observation("aaaaaaaaaaaa")], observedThrough: "raw-1", observer: "idle" }));
		expect(s.pi.events.emit).toHaveBeenCalledWith(MEMORY_EVENT, completed);
	});
	it("persists explicit compaction failure rather than completion", async () => {
		const s = setup([textCustomMessage("raw-1", "a"), recorded(), textCustomMessage("raw-2", "b")]);
		await s.run("raw-2");
		s.handlers.session_compact_failed({ errorMessage: "disk error", aborted: false }, s.ctx);
		expect(s.pi.appendEntry).toHaveBeenCalledWith(MEMORY_EVENT, expect.objectContaining({ type: "memory.compaction.failed", metadata: expect.objectContaining({ failure: "disk error" }) }));
	});
	it("fails closed on persistence errors and cancels duplicate hooks", async () => {
		const s = setup([textCustomMessage("raw-1", "a"), recorded(), textCustomMessage("raw-2", "b")]);
		s.pi.appendEntry.mockImplementation(() => { throw Error("disk error"); });
		await expect(s.run("raw-2")).resolves.toEqual({ cancel: true });
		s.runtime.compactHookInFlight = true;
		await expect(s.run("raw-2")).resolves.toEqual({ cancel: true });
	});
});

describe("observer coverage identity", () => {
	it.each([
		{ coversUpToId: "missing" },
		{ observations: [] },
		{ observations: [{ content: "invalid" }] },
		{ coverage: null },
		{ coverage: "invalid" },
		{ coverage: { version: 1, fromExclusiveId: "wrong", sourceEntryIds: ["raw-1"], truncatedSourceEntryIds: [] } },
		{ coverage: { version: 1, fromExclusiveId: null, sourceEntryIds: ["foreign"], truncatedSourceEntryIds: [] } },
		{ coverage: { version: 1, fromExclusiveId: null, sourceEntryIds: ["raw-1"], truncatedSourceEntryIds: ["raw-1"] } },
		{ observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: ["foreign"] })] },
	])("ignores invalid coverage %j", (overrides) => {
		expect(committedObserverFrontier([textCustomMessage("raw-1", "a"), recorded("raw-1", ["raw-1"], overrides)]).id).toBeNull();
	});
	it("rejects future markers and ambiguous duplicate entry IDs", () => {
		expect(committedObserverFrontier([recorded(), textCustomMessage("raw-1", "a")]).id).toBeNull();
		expect(committedObserverFrontier([textCustomMessage("raw-1", "a"), recorded(), textCustomMessage("raw-1", "b")]).id).toBeNull();
	});
	it("advances only a contiguous chain and keeps prior good coverage on bad later commits", () => {
		const first = recorded();
		const second = recorded("raw-2", ["raw-2"], { coverage: { version: 1, fromExclusiveId: "raw-1", sourceEntryIds: ["raw-2"], truncatedSourceEntryIds: [] } });
		second.id = "second";
		const entries = [textCustomMessage("raw-1", "a"), first, textCustomMessage("raw-2", "b"), second];
		expect(committedObserverFrontier(entries).id).toBe("raw-2");
		(second.data as any).coverage.fromExclusiveId = null;
		expect(committedObserverFrontier(entries).id).toBe("raw-1");
	});
});
