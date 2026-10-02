import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const agents = vi.hoisted(() => ({ observer: vi.fn() }));
vi.mock("../src/agents/observer/agent.js", async (original) => ({
	...(await original<typeof import("../src/agents/observer/agent.js")>()), runObserver: agents.observer,
}));
import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import { committedObserverFrontier, hasLegacyObservationBacklog } from "../src/session-ledger/coverage.js";
import { realTokensSinceAnchor, OM_OBSERVATIONS_RECORDED } from "../src/session-ledger/index.js";
import { serializeSourceAddressedBranchEntries } from "../src/serialize.js";
import { legacyExcerptFixture } from "./fixtures/legacy-excerpt.js";
import { observation } from "./fixtures/session.js";

beforeEach(() => { agents.observer.mockReset(); });

function harness(manager: SessionManager) {
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	const pi = { on: (name: string, handler: any) => { handlers[name] = handler; }, appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data) };
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config.observeAfterTokens = 1;
	runtime.config.reflectAfterTokens = 1_000_000;
	runtime.config.observerChunkMaxTokens = 8_000;
	runtime.resolveModel = vi.fn(async () => ({ ok: true as const, model: { provider: "test", id: "memory" }, apiKey: "key" }));
	const ctx = { cwd: "/tmp/source-safety", hasUI: false, sessionManager: manager, model: {}, modelRegistry: {} };
	registerConsolidationTrigger(pi as any, runtime);
	registerCompactionHook(pi as any, runtime);
	return { runtime, ctx, handlers,
		observe: async () => { handlers.turn_end({}, ctx); await runtime.consolidationPromise; },
		compact: async (boundary: string) => {
			const result = await handlers.session_before_compact({ reason: "manual", branchEntries: manager.getBranch(), preparation: { firstKeptEntryId: boundary, tokensBefore: 1_000 } }, ctx);
			if (result?.compaction) {
				const c = result.compaction;
				const id = manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
				handlers.session_compact({ compactionEntry: manager.getEntry(id) }, ctx);
			}
			return result;
		},
	};
}

function contextText(manager: SessionManager): string {
	return JSON.stringify(convertToLlm(manager.buildSessionContext().messages));
}

describe("complete observer source safety", () => {
	it("fails closed on legacy excerpt coverage and re-observes original history despite zero provider growth", async () => {
		const f = legacyExcerptFixture();
		const s = harness(f.manager);
		s.runtime.config.observeAfterTokens = 1_000_000;
		s.runtime.config.observerChunkMaxTokens = 256;
		(s.ctx as any).getContextUsage = () => ({ tokens: 10 });
		expect(realTokensSinceAnchor(f.manager.getBranch(), OM_OBSERVATIONS_RECORDED, 10)).toBe(0);
		expect(committedObserverFrontier(f.manager.getBranch()).id).toBeNull();
		expect(hasLegacyObservationBacklog(f.manager.getBranch())).toBe(true);
		const historicalExcerpt = serializeSourceAddressedBranchEntries([f.manager.getEntry(f.sourceId)!], { maxTokens: 256 });
		expect(historicalExcerpt.truncatedSourceEntryIds).toEqual([f.sourceId]);
		expect(historicalExcerpt.text).not.toContain(f.middleFact);
		expect(await s.compact(f.boundary)).toEqual({ cancel: true });
		await s.observe();
		expect(agents.observer).not.toHaveBeenCalled();
		expect(s.runtime.lastObserverError).toContain("incomplete_source");
		expect(committedObserverFrontier(f.manager.getBranch()).id).toBeNull();

		s.runtime.config.observerChunkMaxTokens = 8_000;
		agents.observer.mockImplementationOnce(async (input) => {
			expect(input.chunk).toContain(f.originalText);
			expect(input.allowedSourceEntryIds).toContain(f.sourceId);
			return [observation("bbbbbbbbbbbb", { sourceEntryIds: [f.sourceId], content: `Full observation preserves ${f.middleFact}` })];
		});
		await s.observe();
		expect(agents.observer).toHaveBeenCalledTimes(1);
		expect(committedObserverFrontier(f.manager.getBranch()).id).toBe(f.boundary);
		expect(hasLegacyObservationBacklog(f.manager.getBranch())).toBe(false);
		expect((await s.compact(f.boundary)).compaction.firstKeptEntryId).toBe(f.boundary);
		expect(contextText(f.manager)).toContain(f.middleFact);
		await s.observe(); // Upgrade override stops once legacy spans have complete evidence.
		expect(agents.observer).toHaveBeenCalledTimes(1);
	});

	it("drains legacy recovery in full-entry chunks even below ordinary thresholds", async () => {
		const manager = SessionManager.inMemory();
		const first = manager.appendMessage({ role: "user", content: "a".repeat(700), timestamp: Date.now() });
		const second = manager.appendMessage({ role: "user", content: "b".repeat(700), timestamp: Date.now() });
		manager.appendCustomEntry("om.observations.recorded", { observations: [observation("aaaaaaaaaaaa", { sourceEntryIds: [first, second] })], coversUpToId: second });
		const s = harness(manager);
		s.runtime.config.observeAfterTokens = 1_000_000;
		s.runtime.config.observerChunkMaxTokens = 256;
		agents.observer.mockImplementation(async (input) => [observation(input.allowedSourceEntryIds[0] === first ? "bbbbbbbbbbbb" : "cccccccccccc", { sourceEntryIds: input.allowedSourceEntryIds })]);
		await s.observe();
		expect(committedObserverFrontier(manager.getBranch()).id).toBe(first);
		expect(hasLegacyObservationBacklog(manager.getBranch())).toBe(true);
		await s.observe();
		expect(committedObserverFrontier(manager.getBranch()).id).toBe(second);
		expect(hasLegacyObservationBacklog(manager.getBranch())).toBe(false);
		expect(agents.observer.mock.calls.map(([input]) => input.allowedSourceEntryIds)).toEqual([[first], [second]]);
	});

	it("preserves bash command/output through worker input and consecutive actual Pi compactions", async () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
		const bash = { role: "bashExecution" as const, command: "printf DISTINCT_COMMAND_301", output: "DISTINCT_OUTPUT_301\nsecond line", exitCode: 7, cancelled: false, truncated: true, fullOutputPath: "/tmp/full-output-301", timestamp: Date.now() };
		const bashId = manager.appendMessage(bash);
		const firstBoundary = manager.appendMessage({ role: "user", content: "retain first tail", timestamp: Date.now() });
		const s = harness(manager);
		agents.observer.mockImplementation(async (input) => {
			const first = input.allowedSourceEntryIds.includes(bashId);
			if (first) {
				expect(input.chunk).toContain((convertToLlm([bash])[0].content as any[])[0].text);
				expect(input.chunk).toContain("DISTINCT_COMMAND_301");
				expect(input.chunk).toContain("DISTINCT_OUTPUT_301");
			}
			return [observation(first ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb", { sourceEntryIds: input.allowedSourceEntryIds, content: first ? `${bash.command}; output ${bash.output.replace(/\n/g, " ")}; exit 7; full /tmp/full-output-301` : "second turn observed" })];
		});
		await s.observe();
		expect((await s.compact(firstBoundary)).compaction.firstKeptEntryId).toBe(firstBoundary);
		expect(contextText(manager)).toContain("DISTINCT_COMMAND_301");
		expect(contextText(manager)).toContain("DISTINCT_OUTPUT_301");
		const secondBoundary = manager.appendMessage({ role: "user", content: "retain second tail", timestamp: Date.now() });
		await s.observe();
		expect((await s.compact(secondBoundary)).compaction.firstKeptEntryId).toBe(secondBoundary);
		expect(contextText(manager)).toContain("DISTINCT_COMMAND_301");
		expect(contextText(manager)).toContain("DISTINCT_OUTPUT_301");
		expect(contextText(manager)).toContain("retain second tail");
	});

	it.each([
		{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "binary" }] },
		{ role: "newUnknownRole", hiddenPayload: "must not disappear" },
	])("fails explicitly rather than covering unsupported payload %j", async (message) => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(message as any);
		const boundary = manager.appendMessage({ role: "user", content: "tail", timestamp: Date.now() });
		const s = harness(manager);
		await s.observe();
		expect(agents.observer).not.toHaveBeenCalled();
		expect(s.runtime.lastObserverError).toContain("unsupported_source");
		expect(committedObserverFrontier(manager.getBranch()).id).toBeNull();
		expect(await s.compact(boundary)).toEqual({ cancel: true });
	});
});
