#!/usr/bin/env node
// Opt-in, read-only captured-session replay. No session prompts, tools, or file
// writes are executed. Only the bounded memory worker talks to the provider.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { collectPayloadImages, imageFingerprint, verifyRequestImages } from "./replay-images.mjs";
import { Runtime } from "../src/runtime.ts";
import { runConsolidationPipeline } from "../src/hooks/consolidation-trigger.ts";
import { committedObserverFrontier } from "../src/session-ledger/coverage.ts";
import { fullProjection } from "../src/session-ledger/index.ts";
import { serializeSourceAddressedBranchEntries } from "../src/serialize.ts";

const asUser = process.argv.includes("--as-user");
const [sessionFile, imageEntryId, provider = "openai-codex", modelId = "gpt-6.1-sol"] = process.argv.slice(2).filter((arg) => arg !== "--as-user");
if (!sessionFile || !imageEntryId) throw new Error("usage: node --import tsx scripts/replay-observer.mjs <session.jsonl> <image-entry-id> [provider] [model] [--as-user]");
const sdk = await import(process.env.PI_OBSERVER_REPLAY_SDK ?? "@earendil-works/pi-coding-agent");
const ledger = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const original = ledger.find((entry) => entry.type === "message" && entry.id === imageEntryId);
if (!original) throw new Error("source entry missing");
const images = original.message.content.filter((block) => block.type === "image");
if (!images.length) throw new Error("source entry has no images");
const predecessor = !asUser && original.message.role === "toolResult"
	? ledger.find((entry) => entry.id === original.parentId && entry.message?.role === "assistant") : undefined;
// Explicitly isolate the captured span as a NEW in-memory branch. Advancing this
// frontier is not a claim of coverage for the rest of the captured session.
const entries = structuredClone(predecessor ? [predecessor, original] : [original]);
entries[0].parentId = null;
const replayEntryId = asUser ? `user-replay-${imageEntryId}` : imageEntryId;
if (asUser) {
	entries[0].id = replayEntryId;
	entries[0].message = { role: "user", content: structuredClone(original.message.content), timestamp: original.message.timestamp };
}
const source = serializeSourceAddressedBranchEntries(entries);
const modelRuntime = await sdk.ModelRuntime.create({ refreshOnCreate: false });
const model = modelRuntime.getModel(provider, modelId);
if (!model) throw new Error(`target model missing from selected SDK: ${provider}/${modelId}; PI_OBSERVER_REPLAY_SDK can select the installed Pi dist/index.js`);
if (!model.input?.includes("image")) throw new Error("target lacks image capability");
const resolvedAuth = await modelRuntime.getAuth(model);
const auth = resolvedAuth?.auth;
if (!auth || !(auth.apiKey || Object.keys(auth.headers ?? {}).length)) throw new Error("target auth unavailable (no interactive authentication attempted)");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 90_000);
let requests = 0;
const wireRequests = [];
const registry = {
	find: (p, id) => modelRuntime.getModel(p, id),
	streamSimple: (nextModel, context, options) => {
		if (++requests > 3) throw new Error("replay request cap reached");
		// Register before capture so a missing callback/request cannot pass.
		const request = { request: requests, payloadImages: [] };
		wireRequests.push(request);
		return modelRuntime.streamSimple(nextModel, context, {
			...options, signal: controller.signal,
			onPayload: (payload) => { request.payloadImages.push(collectPayloadImages(payload)); },
		});
	},
};
const runtime = new Runtime();
runtime.configLoaded = true;
Object.assign(runtime.config, { observeAfterTokens: 1, reflectAfterTokens: 1_000_000, observerChunkMaxTokens: 60_000, agentMaxTurns: 2, agentMaxTokens: 2_048, showWorkerNotifications: false });
runtime.resolveModel = async () => ({ ok: true, model, ...auth, env: resolvedAuth.env });
const ctx = { cwd: process.cwd(), hasUI: false, model, modelRegistry: registry, sessionManager: { getBranch: () => entries, getSessionId: () => "isolated-captured-replay" } };
const pi = { appendEntry: (customType, data) => entries.push({ type: "custom", id: randomUUID(), parentId: entries.at(-1)?.id ?? null, customType, data }) };
try {
	await runConsolidationPipeline(pi, runtime, ctx);
	const memory = fullProjection(entries);
	const expected = images.map(imageFingerprint);
	const delivered = wireRequests.length === requests && verifyRequestImages(expected, wireRequests);
	const observedThrough = committedObserverFrontier(entries).id;
	const cited = memory.observations.some((observation) => observation.sourceEntryIds.includes(replayEntryId));
	console.log(JSON.stringify({ model: { provider, id: modelId, contextWindow: model.contextWindow }, scope: asUser ? "user-envelope replay of actual captured image, not a historical user entry" : "isolated captured source span, original session unchanged", capturedImageEntryId: imageEntryId, sourceEntryIds: source.sourceEntryIds, chunkTokens: source.estimatedTokens, originalImages: expected, wireRequests, delivered, requests, responseAllowance: 2_048, maxTurns: 2, timeoutMs: 90_000, observationCount: memory.observations.length, citedImageEntry: cited, observedThrough, failure: runtime.lastObserverError ?? null }, null, 2));
	if (!delivered || !cited || observedThrough !== replayEntryId) process.exitCode = 1;
} finally {
	clearTimeout(timer);
}
