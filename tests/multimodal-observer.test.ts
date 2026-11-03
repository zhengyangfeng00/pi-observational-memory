import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import { runObserver, ObserverStreamError } from "../src/agents/observer/agent.js";
import { estimateImageTokens, validateObserverRequest } from "../src/image-budget.js";
import { serializeSourceAddressedBranchEntries } from "../src/serialize.js";
import { pngWithDimensions } from "./fixtures/images.js";

// Declares 2048 x 2048 pixels: the largest image cost after provider downscaling.
const image = pngWithDimensions(2048, 2048);
const model = { input: ["text", "image"], contextWindow: 100_000, maxTokens: 8_192 } as any;
const entries = [
	{ type: "message", id: "user-image", message: { role: "user", content: [{ type: "text", text: "before user" }, image, { type: "text", text: "after user" }], timestamp: 0 } },
	{ type: "message", id: "tool-image", message: { role: "toolResult", toolName: "read", toolCallId: "read-1", isError: false, content: [{ type: "text", text: "before tool" }, image, { type: "text", text: "after tool" }], timestamp: 0 } },
];

function loopWith(handler: (prompts: any[], context: any, config: any, stream: any) => Promise<void> | void, events: any[] = []): any {
	return (prompts: any[], context: any, config: any, _signal: any, stream: any) => ({
		async *[Symbol.asyncIterator]() { yield* events; },
		result: async () => { await handler(prompts, context, config, stream); },
	});
}

const args = { model, priorReflections: [], priorObservations: [], allowedSourceEntryIds: ["user-image", "tool-image"] };

describe("multimodal observer", () => {
	it("delivers ordered user/tool image payloads, headers, MIME types and attributable source IDs intact", async () => {
		const source = serializeSourceAddressedBranchEntries(entries);
		expect(source.sourceEntryIds).toEqual(args.allowedSourceEntryIds);
		expect(source.truncatedSourceEntryIds).toEqual([]);
		expect(source.content.filter((block) => block.type === "image")).toEqual([image, image]);
		const observed = await runObserver({ ...args, chunk: source.content, agentLoop: loopWith(async (prompts, context) => {
			const blocks = prompts[0].content;
			expect(blocks.filter((block: any) => block.type === "image")).toEqual([image, image]);
			const first = blocks.findIndex((block: any) => block.type === "image");
			expect(blocks.slice(0, first).map((b: any) => b.text).join("")).toContain("[Source entry id: user-image]\n[User");
			expect(blocks.slice(0, first).map((b: any) => b.text).join("")).toContain("before user");
			const second = blocks.findIndex((b: any, i: number) => i > first && b.type === "image");
			const middle = blocks.slice(first + 1, second).map((b: any) => b.text).join("");
			expect(middle).toContain("after user");
			expect(middle).toContain("[Source entry id: tool-image]\n[Tool result for read");
			expect(middle).toContain("before tool");
			expect(blocks.slice(second + 1).map((b: any) => b.text).join("")).toContain("after tool\n[Tool call id: read-1; error: false]");
			await context.tools[0].execute("record", { observations: [{ timestamp: "2026-10-02 10:00", content: "Image shows a memory panel", relevance: "high", sourceEntryIds: ["tool-image"] }] });
		}) });
		expect(observed?.[0].sourceEntryIds).toEqual(["tool-image"]);
	});

	it.each([
		{ type: "custom_message", id: "custom-source", customType: "note", content: [{ type: "text", text: "before" }, image, { type: "text", text: "after" }] },
		{ type: "message", id: "custom-source", message: { role: "custom", customType: "note", content: [{ type: "text", text: "before" }, image, { type: "text", text: "after" }] } },
	])("preserves custom-message image input %j", (entry) => {
		const source = serializeSourceAddressedBranchEntries([entry]);
		expect(source.sourceEntryIds).toEqual(["custom-source"]);
		expect(source.content.filter((block) => block.type === "image")).toEqual([image]);
		const text = source.content.filter((block) => block.type === "text").map((block) => block.text).join("");
		expect(text).toContain("[Source entry id: custom-source]");
		expect(text).toContain("Custom (note)");
		expect(text).toContain("before\n\nafter");
	});

	it("estimates image cost from pixel dimensions, not encoded payload size", () => {
		const small = pngWithDimensions(2000, 660);
		const padded = { ...small, data: Buffer.concat([Buffer.from(small.data, "base64"), Buffer.alloc(1_000_000)]).toString("base64") };
		expect(estimateImageTokens(padded)).toBe(estimateImageTokens(small));
		expect(estimateImageTokens(pngWithDimensions(2000, 1460))).toBeGreaterThan(estimateImageTokens(small));
	});

	it("caps image cost at the provider downscaled size so one screenshot fits a default chunk", () => {
		const max = estimateImageTokens(pngWithDimensions(2048, 2048));
		expect(estimateImageTokens(pngWithDimensions(8192, 8192))).toBe(max);
		expect(estimateImageTokens(pngWithDimensions(65_535, 1))).toBeLessThanOrEqual(max);
		// Default chunk cap: 20% of a 128k-token vision model's context window.
		const source = serializeSourceAddressedBranchEntries([{ type: "custom_message", id: "shot", content: [pngWithDimensions(4026, 1328)] }], { maxTokens: 25_600 });
		expect(source.sourceEntryIds).toEqual(["shot"]);
	});

	it("never excerpts image entries that exceed the chunk budget", () => {
		const full = serializeSourceAddressedBranchEntries(entries.slice(0, 1));
		expect(full.estimatedTokens).toBeGreaterThan(estimateImageTokens(image));
		const blocked = serializeSourceAddressedBranchEntries(entries, { maxTokens: full.estimatedTokens - 1 });
		expect(blocked.sourceEntryIds).toEqual([]);
		expect(blocked.content).toEqual([]);
		expect(blocked.truncatedSourceEntryIds).toEqual(["user-image"]);
		const prefix = serializeSourceAddressedBranchEntries(entries, { maxTokens: full.estimatedTokens });
		expect(prefix.sourceEntryIds).toEqual(["user-image"]);
		expect(prefix.content.filter((b) => b.type === "image")).toEqual([image]);
	});

	it.each([
		{ type: "audio", data: "unknown" },
		{ ...image, mimeType: "image/svg+xml" },
		{ ...image, data: "not base64" },
		{ ...image, data: "aGVsbG8=" },
	])("fails closed on unknown or invalid payload %j", (block) => {
		const result = serializeSourceAddressedBranchEntries([{ type: "message", id: "bad", message: { role: "user", content: [block] } }, ...entries]);
		expect(result.incompleteSourceEntryIds).toEqual(["bad"]);
		expect(result.sourceEntryIds).toEqual([]);
	});

	it.each([
		[{ input: ["text"], contextWindow: 100_000 }, "unsupported_model"],
		[{ input: ["text", "image"] }, "image_budget"],
		[{ ...model, contextWindow: 20_000 }, "image_budget"],
	])("rejects unsupported/unbudgeted models before invoking the loop", async (selected, error) => {
		const loop = vi.fn();
		await expect(runObserver({ ...args, model: selected as any, chunk: serializeSourceAddressedBranchEntries(entries).content, agentLoop: loop })).rejects.toThrow(error as string);
		expect(loop).not.toHaveBeenCalled();
	});

	it("includes prior memory, tools, system, UTF-8 text, response allowance and loop growth in budgets", async () => {
		const source = serializeSourceAddressedBranchEntries(entries.slice(0, 1)).content;
		const loop = vi.fn();
		await expect(runObserver({ ...args, priorObservations: ["漢".repeat(40_000)], chunk: source, agentLoop: loop })).rejects.toThrow("image_budget");
		expect(loop).not.toHaveBeenCalled();
		const provider = vi.fn();
		await runObserver({ ...args, chunk: source, streamSimple: provider, agentLoop: loopWith(async (_prompts, _context, _config, stream) => {
			const failed = stream(model, { systemPrompt: "s".repeat(50_000), messages: [{ role: "user", content: source, timestamp: 0 }], tools: [{ name: "huge", parameters: { payload: "t".repeat(40_000) } }] }, { maxTokens: 8_192 });
			expect(await failed.result()).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("image_budget"), content: [], usage: { totalTokens: 0 } });
			const events = [];
			for await (const event of failed) events.push(event);
			expect(events).toHaveLength(1);
			expect(events[0].type).toBe("error");
			expect(provider).not.toHaveBeenCalled();
		}) });
	});

	it("budgets normalized tool declarations on real agent-loop continuations", async () => {
		const selected = { ...model, provider: "test", api: "test", id: "vision", contextWindow: 63_000 };
		const schema = Type.Object({ value: Type.String({ description: "s".repeat(32_000) }) });
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }], details: undefined }));
		const tool = { name: "schema_tool", label: "Schema tool", description: "exercise schema budgeting", parameters: schema, execute };
		const prompts = [{ role: "user" as const, content: [image], timestamp: 0 }];
		const context = { messages: [{ role: "system" as const, content: "system", sections: { rules: "metadata instructions" }, timestamp: 0 }], tools: [tool] };
		const config = { model: selected, maxTokens: 8_192, convertToLlm: (messages: any[]) => messages, toolExecution: "sequential" as const };
		// The initial raw preflight still supports the legacy Context.tools field.
		expect(() => validateObserverRequest(selected, { messages: [...context.messages, ...prompts], tools: [tool] }, config.maxTokens)).not.toThrow();
		const requests: any[] = [];
		const provider = vi.fn(() => {
			const firstRequest = provider.mock.calls.length === 1;
			const message = {
				role: "assistant" as const, api: "test", provider: "test", model: "vision", timestamp: 0,
				content: firstRequest
					? [{ type: "text", text: "x".repeat(3_000) }, { type: "toolCall", id: "call", name: "schema_tool", arguments: { value: "ok" } }]
					: [{ type: "text", text: "done" }],
				stopReason: firstRequest ? "toolUse" : "stop",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message } as any);
			stream.push({ type: "done", reason: message.stopReason, message } as any);
			return stream;
		});
		await expect(runAgentLoop(prompts, context, config as any, async () => {}, undefined, (nextModel, nextContext, options) => {
			requests.push(nextContext);
			validateObserverRequest(nextModel, nextContext, options?.maxTokens ?? config.maxTokens);
			return provider();
		})).rejects.toThrow("image_budget");
		expect(execute).toHaveBeenCalledOnce();
		expect(provider).toHaveBeenCalledOnce(); // First request fit; continuation was blocked before dispatch.
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request.tools).toBeUndefined();
			expect(request.messages.flatMap((message: any) => message.toolsAdded ?? [])[0].parameters).toEqual(schema);
		}
		// Without normalized schemas the very same continuation would fit.
		const withoutSchemas = { messages: requests[1].messages.map((message: any) => {
			const { toolsAdded: _toolsAdded, ...rest } = message;
			return rest;
		}) };
		expect(() => validateObserverRequest(selected, withoutSchemas, config.maxTokens)).not.toThrow();
	});

	it("counts complete normalized system metadata, not only toolsAdded", () => {
		const context = { messages: [
			{ role: "system", content: "", sections: { instructions: "漢".repeat(30_000) }, toolsAdded: [], toolsRemoved: [{ name: "removed" }], timestamp: 0 },
			{ role: "user", content: [image], timestamp: 0 },
		] } as any;
		expect(() => validateObserverRequest(model, context, 8_192)).toThrow("image_budget");
		context.messages[0].sections = {};
		context.messages[0].futureMetadata = { declaration: "x".repeat(100_000) };
		expect(() => validateObserverRequest(model, context, 8_192)).toThrow("image_budget");
	});

	it.each([
		{ images: { maxPerMessage: 1 } },
		{ images: { maxPerRequest: 1 } },
		{ maxRequestBytes: 1 },
	])("enforces declared hard request limits %j", (limits) => {
		expect(() => validateObserverRequest({ ...model, inputLimits: limits }, { messages: [{ role: "user", content: [image, image], timestamp: 0 }] }, 8_192)).toThrow("image_budget");
	});

	it("rejects unknown direct worker input even when no text/image block is present", async () => {
		const loop = vi.fn();
		await expect(runObserver({ ...args, chunk: [{ type: "audio", data: "unknown" }] as any, agentLoop: loop })).rejects.toThrow("unsupported_source");
		expect(loop).not.toHaveBeenCalled();
	});

	it("does not commit partial image observations following a stream failure", async () => {
		const loop = loopWith(async (_p, ctx) => {
			await ctx.tools[0].execute("record", { observations: [{ timestamp: "2026-10-02 10:00", content: "partial", relevance: "high", sourceEntryIds: ["user-image"] }] });
		}, [{ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" } }]);
		await expect(runObserver({ ...args, chunk: serializeSourceAddressedBranchEntries(entries).content, agentLoop: loop })).rejects.toBeInstanceOf(ObserverStreamError);
	});
});
