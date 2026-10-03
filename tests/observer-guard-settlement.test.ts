import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runObserver } from "../src/agents/observer/agent.js";
import * as imageBudget from "../src/image-budget.js";
import { registerConsolidationTrigger } from "../src/hooks/consolidation-trigger.js";
import { Runtime } from "../src/runtime.js";
import { committedObserverFrontier } from "../src/session-ledger/coverage.js";
import { fullProjection, OM_OBSERVATIONS_RECORDED } from "../src/session-ledger/index.js";
import { MEMORY_EVENT } from "../src/telemetry.js";

const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5c8AAAAASUVORK5CYII=" };
const model = (id: string, contextWindow: number) => ({ api: "openai-completions", provider: "test", id, input: ["text", "image"], maxTokens: 8_192, contextWindow }) as any;

/** A real tool turn records an observation and grows the next request budget. */
function providerFor(sourceId: string) {
	const calls = new Map<string, number>();
	return vi.fn((selected: any, context: any) => {
		const attempt = (calls.get(selected.id) ?? 0) + 1;
		calls.set(selected.id, attempt);
		expect(context.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((block: any) => block.type === "image") : [])).toEqual([image]);
		const message = {
			role: "assistant" as const, api: selected.api, provider: selected.provider, model: selected.id, timestamp: Date.now(),
			content: attempt === 1 ? [
				{ type: "text", text: "x".repeat(8_000) },
				{ type: "toolCall", id: `${selected.id}-record`, name: "record_observations", arguments: {
					observations: [{ timestamp: "2026-10-02 10:00", content: `recorded by ${selected.id}`, relevance: "high", sourceEntryIds: [sourceId] }],
				} },
			] : [{ type: "text", text: "complete" }],
			stopReason: attempt === 1 ? "toolUse" : "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: message } as any);
		stream.push({ type: "done", reason: message.stopReason, message } as any);
		stream.end();
		return stream;
	});
}

/** Bound settlement and flush detached-loop microtasks before checking rejections. */
async function settledWithoutUnhandled(work: () => Promise<void>): Promise<void> {
	const unhandled: unknown[] = [];
	const listener = (reason: unknown) => { unhandled.push(reason); };
	process.on("unhandledRejection", listener);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			work(),
			new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("worker did not settle within 2 seconds")), 2_000); }),
		]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(unhandled).toEqual([]);
	} finally {
		if (timer) clearTimeout(timer);
		process.off("unhandledRejection", listener);
	}
}

function consolidation(fallbackWindow?: number) {
	const manager = SessionManager.inMemory();
	const sourceId = manager.appendMessage({ role: "user", content: [image], timestamp: Date.now() });
	const tailId = manager.appendMessage({ role: "user", content: "retained tail", timestamp: Date.now() });
	const primary = model("primary", 45_000);
	const fallback = fallbackWindow === undefined ? undefined : model("fallback", fallbackWindow);
	const provider = providerFor(sourceId);
	const runtime = new Runtime();
	runtime.configLoaded = true;
	Object.assign(runtime.config, { observeAfterTokens: 1, reflectAfterTokens: 1_000_000, observerChunkMaxTokens: 50_000, agentMaxTokens: 8_192, agentMaxTurns: 3, showWorkerNotifications: false });
	if (fallback) runtime.config.fallbackModel = { provider: "test", id: "fallback" };
	runtime.resolveModel = vi.fn(async () => ({ ok: true as const, model: primary, apiKey: "test" }));
	runtime.resolveFallbackModel = vi.fn(async () => fallback
		? { ok: true as const, model: fallback, apiKey: "test", fallbackUsed: true }
		: { ok: false as const, reason: "no fallback" });
	const handlers: Record<string, (event: any, ctx: any) => void> = {};
	const pi = { on: (event: string, handler: any) => { handlers[event] = handler; }, appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data) };
	const ctx = { cwd: "/tmp/observer-guard-settlement", hasUI: false, model: primary, modelRegistry: { streamSimple: provider, find: (_provider: string, id: string) => id === "fallback" ? fallback : primary }, sessionManager: manager };
	registerConsolidationTrigger(pi as any, runtime);
	const observe = async () => {
		handlers.turn_end({}, ctx);
		expect(runtime.consolidationInFlight).toBe(true);
		await runtime.consolidationPromise;
		expect(runtime.consolidationInFlight).toBe(false);
		expect(runtime.consolidationPhase).toBeUndefined();
		expect(runtime.consolidationPromise).toBeNull();
	};
	return { manager, sourceId, tailId, runtime, ctx, provider, observe };
}

describe("observer guard settlement through public agentLoop", () => {
	it("settles continuation overflow without unhandled rejection and discards tool-recorded partial observations", async () => {
		const provider = providerFor("image-source");
		const validations = vi.spyOn(imageBudget, "validateObserverRequest");
		try {
			await settledWithoutUnhandled(async () => {
				// No agentLoop override: exercise runObserver's production public wrapper.
				await expect(runObserver({ model: model("primary", 45_000), priorReflections: [], priorObservations: [], chunk: [{ type: "text", text: "[Source entry id: image-source]" }, image], allowedSourceEntryIds: ["image-source"], maxOutputTokens: 8_192, maxTurns: 3, streamSimple: provider })).rejects.toMatchObject({ name: "ObserverStreamError", stopReason: "error", message: expect.stringContaining("image_budget") });
			});
			// Prove the real record tool accepted a partial observation before
			// the overflowing continuation was rejected and the run discarded.
			expect(validations.mock.calls.some(([_model, context]) => context.messages.some((message: any) =>
				message.role === "toolResult" && message.toolName === "record_observations"
				&& message.content.some((block: any) => block.type === "text" && block.text.startsWith("Recorded 1 new observation"))))).toBe(true);
			expect(provider).toHaveBeenCalledOnce(); // The overflowing continuation never reaches the provider.
		} finally {
			validations.mockRestore();
		}
	});

	it("preserves normal successful public-loop tool recording and continuation", async () => {
		const provider = providerFor("image-source");
		await settledWithoutUnhandled(async () => {
			const result = await runObserver({ model: model("primary", 100_000), priorReflections: [], priorObservations: [], chunk: [{ type: "text", text: "[Source entry id: image-source]" }, image], allowedSourceEntryIds: ["image-source"], maxOutputTokens: 8_192, maxTurns: 3, streamSimple: provider });
			expect(result).toHaveLength(1);
			expect(result?.[0]).toMatchObject({ content: "recorded by primary", sourceEntryIds: ["image-source"] });
		});
		expect(provider).toHaveBeenCalledTimes(2);
	});

	it("leaves committed coverage unchanged, clears consolidation state, and permits a subsequent successful pass", async () => {
		const s = consolidation();
		await settledWithoutUnhandled(s.observe);
		expect(s.provider).toHaveBeenCalledOnce();
		expect(committedObserverFrontier(s.manager.getBranch()).id).toBeNull();
		expect(fullProjection(s.manager.getBranch()).observations).toEqual([]);
		expect(s.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED)).toEqual([]);
		expect(s.runtime.lastObserverError).toContain("image_budget");
		const failed = s.manager.getBranch().find((entry: any) => entry.customType === MEMORY_EVENT && entry.data.type === "memory.observer.failed") as any;
		expect(failed.data.metadata.committed).toBe(false);

		const recoveredProvider = providerFor(s.sourceId);
		s.ctx.modelRegistry.streamSimple = recoveredProvider;
		s.runtime.resolveModel = vi.fn(async () => ({ ok: true as const, model: model("primary", 100_000), apiKey: "test" }));
		await settledWithoutUnhandled(s.observe);
		expect(recoveredProvider).toHaveBeenCalledTimes(2);
		expect(committedObserverFrontier(s.manager.getBranch()).id).toBe(s.tailId);
		expect(s.runtime.lastObserverError).toBeUndefined();
	});

	it.each([100_000, 45_000])("settles primary overflow and fallback at a %i-token window without partial-record leakage", async (fallbackWindow) => {
		const s = consolidation(fallbackWindow);
		await settledWithoutUnhandled(s.observe);
		expect(s.runtime.resolveFallbackModel).toHaveBeenCalledOnce();
		const memory = fullProjection(s.manager.getBranch());
		const expectedSuccess = fallbackWindow === 100_000;
		expect(s.provider.mock.calls.map(([selected]) => selected.id)).toEqual(expectedSuccess ? ["primary", "fallback", "fallback"] : ["primary", "fallback"]);
		expect(memory.observations.map((observation) => observation.content)).toEqual(expectedSuccess ? ["recorded by fallback"] : []);
		expect(committedObserverFrontier(s.manager.getBranch()).id).toBe(expectedSuccess ? s.tailId : null);
		if (expectedSuccess) expect(s.runtime.lastObserverError).toBeUndefined();
		else expect(s.runtime.lastObserverError).toContain("image_budget");
	});
});
