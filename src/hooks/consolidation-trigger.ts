import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runDropper } from "../agents/dropper/agent.js";
import { observationPoolMetrics } from "../agents/dropper/pool.js";
import { runObserver } from "../agents/observer/agent.js";
import { runReflector } from "../agents/reflector/agent.js";
import { debugLog, withDebugLogContext } from "../debug-log.js";
import { resolveObserverChunkMaxTokens } from "../config.js";
import type { ConsolidationPhase, ResolveCtx, ResolveResult, Runtime } from "../runtime.js";
import { serializeSourceAddressedBranchEntries } from "../serialize.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	buildObservationsDroppedData,
	buildObservationsRecordedData,
	buildReflectionsRecordedData,
	earlierCoverageMarkerId,
	foldLedger,
	fullProjection,
	isSourceEntry,
	latestCoverageIndex,
	latestCoverageMarkerId,
	observationToSummaryLine,
	realTokensSinceAnchor,
	rawTokensSinceObservationCoverage,
	rawTokensSinceReflectionCoverage,
	reflectionToSummaryLine,
	type Entry,
	type Observation,
	type Reflection,
	type V3MemoryCustomType,
} from "../session-ledger/index.js";

import { committedObserverFrontier, hasCompactedObservationBacklog, hasLegacyObservationBacklog, unavailableSourceHistory } from "../session-ledger/coverage.js";
import { captureBranch, emitMemoryEvent, operationId, persistMemoryState } from "../telemetry.js";

type ResolvedModel = Extract<ResolveResult, { ok: true }>;

async function trackedWorker<T>(
	pi: ExtensionAPI, ctx: ConsolidationCtx, stage: ConsolidationPhase,
	current: () => boolean, metadata: Record<string, unknown>,
	work: (commit: (customType: string, data: unknown) => void) => Promise<T>,
): Promise<T> {
	if (!current()) throw new Error("stale worker branch before start");
	const startedAt = Date.now();
	const details = { operationId: operationId(), ...metadata };
	if (stage !== "dropper") emitMemoryEvent(pi, ctx, `memory.${stage}.started`, details);
	persistMemoryState(pi, ctx);
	let committed = false;
	let itemCount = 0;
	try {
		const result = await work((customType, data) => {
			if (!current()) throw new Error("stale worker branch; result discarded");
			appendEntry(pi, customType, data);
			committed = true;
			const record = data as { observations?: unknown[]; reflections?: unknown[]; observationIds?: unknown[] };
			itemCount += (record.observations ?? record.reflections ?? record.observationIds ?? []).length;
		});
		if (!current()) throw new Error("stale worker branch; result discarded");
		emitMemoryEvent(pi, ctx, `memory.${stage}.completed`, { ...details, committed, itemCount, reason: committed ? "recorded" : "empty_result", durationMs: Date.now() - startedAt });
		persistMemoryState(pi, ctx);
		return result;
	} catch (error) {
		if (current()) {
			emitMemoryEvent(pi, ctx, `memory.${stage}.failed`, { ...details, committed, durationMs: Date.now() - startedAt, failure: error instanceof Error ? error.message : String(error) });
			persistMemoryState(pi, ctx);
		}
		throw error;
	}
}

function workerMetadata(resolved: ResolvedModel): Record<string, unknown> {
	const model = resolved.model as { provider?: string; id?: string };
	return { model: { provider: model.provider ?? null, id: model.id ?? null }, fallbackUsed: resolved.fallbackUsed === true };
}

type ConsolidationCtx = {
	cwd: string;
	hasUI: boolean;
	ui?: { notify: (message: string, type?: "warning" | "info" | "error") => void };
	model: unknown;
	modelRegistry: any;
	getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined;
	sessionManager: {
		getBranch: () => unknown;
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
	};
};

type StageOutcome = "continue" | "abort";

type ReflectorStageResult = {
	outcome: StageOutcome;
	sameRunReflections: Reflection[];
	effectiveReflectionCoverageId?: string;
};

function sourceEntriesAfter(entries: Entry[], index: number): Entry[] {
	return entries.slice(index + 1).filter(isSourceEntry);
}

function appendEntry(pi: ExtensionAPI, customType: string, data: unknown): void {
	pi.appendEntry(customType, data);
}

function mergeReflections(existing: Reflection[], additional: Reflection[]): Reflection[] {
	const seen = new Set(existing.map((reflection) => reflection.id));
	const merged = [...existing];
	for (const reflection of additional) {
		if (seen.has(reflection.id)) continue;
		seen.add(reflection.id);
		merged.push(reflection);
	}
	return merged;
}

/**
 * Real current context tokens from the session (provider-reported usage, the
 * same basis the footer percentage uses). Falls back to undefined when the
 * host pi lacks getContextUsage or the count is unknown (e.g. right after a
 * compaction, before the next valid assistant response).
 */
function realContextTokens(ctx: ConsolidationCtx): number | undefined {
	const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
	const tokens = usage?.tokens;
	return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined;
}

function stageDue(
	entries: Entry[],
	runtime: Runtime,
	currentTokens: number | undefined,
	customType: V3MemoryCustomType,
	rawEstimateFn: (entries: Entry[]) => number,
	threshold: number,
): boolean {
	if (currentTokens !== undefined) {
		const real = realTokensSinceAnchor(entries, customType, currentTokens);
		if (real !== undefined) return real >= threshold;
	}
	// Real delta unmeasurable (no usage baseline, or accounting basis changed) or
	// old pi host without getContextUsage — fall back to the raw estimate, which
	// self-limits after coverage and cannot over-fire or starve.
	return rawEstimateFn(entries) >= threshold;
}

function anyStageDue(entries: Entry[], runtime: Runtime, currentTokens: number | undefined): boolean {
	return hasCompactedObservationBacklog(entries) || hasLegacyObservationBacklog(entries)
		|| stageDue(entries, runtime, currentTokens, OM_OBSERVATIONS_RECORDED, rawTokensSinceObservationCoverage, runtime.config.observeAfterTokens)
		|| stageDue(entries, runtime, currentTokens, OM_REFLECTIONS_RECORDED, rawTokensSinceReflectionCoverage, runtime.config.reflectAfterTokens);
}

function shouldNotifyWorker(runtime: Runtime, ctx: ConsolidationCtx): boolean {
	return runtime.config.showWorkerNotifications && ctx.hasUI;
}

function workerHeadersFor(ctx: ConsolidationCtx, resolved: ResolvedModel): ResolvedModel {
	// Console Go (opencode.ai) rejects requests without x-opencode-session
	// (400 MissingSessionID). Mirror pi's own session headers on worker calls.
	const model = (resolved.model ?? {}) as { provider?: string; baseUrl?: string };
	if (
		model.provider !== "opencode"
		&& model.provider !== "opencode-go"
		&& !(typeof model.baseUrl === "string" && model.baseUrl.includes("opencode.ai"))
	) {
		return resolved;
	}
	const sessionId = ctx.sessionManager.getSessionId?.();
	if (!sessionId) return resolved;
	return {
		...resolved,
		headers: {
			...(resolved.headers ?? {}),
			"x-opencode-session": sessionId,
			"x-opencode-client": "pi",
		},
	};
}

/** Thinking level for the worker call: the fallback's own setting wins when the fallback is active. */
function workerThinkingLevel(runtime: Runtime, resolved: ResolvedModel) {
	if (resolved.fallbackUsed === true) {
		return runtime.config.fallbackModel?.thinking ?? runtime.config.model?.thinking ?? "low";
	}
	return runtime.config.model?.thinking ?? "low";
}

/**
 * Context window the observer chunk is sized against. The chunk is serialized
 * once and reused verbatim if the run falls back mid-call, so cap it to the
 * smaller of the primary and fallback windows: otherwise a large-context primary
 * plus a small-context fallback would send the fallback an over-context chunk and
 * make the retry fail for a reason the fallback cannot fix. When no fallback is
 * configured this is exactly the primary model's window.
 */
function observerChunkContextWindow(runtime: Runtime, ctx: ConsolidationCtx, resolved: ResolvedModel): number | undefined {
	const primary = (resolved.model as { contextWindow?: number } | undefined)?.contextWindow;
	const fallback = runtime.config.fallbackModel;
	if (!fallback) return primary;
	const fallbackModel = ctx.modelRegistry.find?.(fallback.provider, fallback.id) as { contextWindow?: number } | undefined;
	const usablePrimary = typeof primary === "number" && primary > 0 ? primary : undefined;
	const fallbackWindow = fallbackModel?.contextWindow;
	const usableFallback = typeof fallbackWindow === "number" && fallbackWindow > 0 ? fallbackWindow : undefined;
	if (usablePrimary === undefined) return usableFallback;
	if (usableFallback === undefined) return usablePrimary;
	return Math.min(usablePrimary, usableFallback);
}

type ModelResolver = {
	failureReason: () => string | undefined;
	resolve: (stage: ConsolidationPhase) => Promise<ResolvedModel | undefined>;
	/** Resolve the configured fallback, caching it for the rest of the pass. */
	resolveFallback: (stage: ConsolidationPhase) => Promise<ResolvedModel | undefined>;
};

function makeModelResolver(runtime: Runtime, ctx: ConsolidationCtx): ModelResolver {
	let cached: ResolveResult | undefined;
	// Once the fallback proves usable, keep it for the rest of the pass so later
	// stages do not re-pay a known-broken primary.
	let fallbackActive: ResolvedModel | undefined;

	const resolve = async (stage: ConsolidationPhase): Promise<ResolvedModel | undefined> => {
		if (fallbackActive) {
			runtime.resolveFailureNotified = false;
			return fallbackActive;
		}
		cached ??= await runtime.resolveModel({
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		});
		if (cached.ok) {
			runtime.resolveFailureNotified = false;
			return workerHeadersFor(ctx, cached);
		}
		debugLog(`${stage}.model_unavailable`, { reason: cached.reason });
		if (!runtime.resolveFailureNotified && ctx.hasUI && ctx.ui) {
			ctx.ui.notify(`Observational memory: ${stage} skipped — ${cached.reason}`, "warning");
			runtime.resolveFailureNotified = true;
		}
		return undefined;
	};

	const resolveFallback = async (stage: ConsolidationPhase): Promise<ResolvedModel | undefined> => {
		if (fallbackActive) return fallbackActive;
		const resolveFallbackModel = runtime.resolveFallbackModel;
		if (typeof resolveFallbackModel !== "function") {
			debugLog(`${stage}.fallback_unavailable`, { reason: "runtime exposes no resolveFallbackModel" });
			return undefined;
		}
		const resolvedCtx: ResolveCtx = {
			model: ctx.model,
			modelRegistry: ctx.modelRegistry,
			hasUI: ctx.hasUI,
			ui: ctx.ui,
		};
		const result = await resolveFallbackModel.call(runtime, resolvedCtx);
		if (!result.ok) {
			debugLog(`${stage}.fallback_unavailable`, { reason: result.reason });
			return undefined;
		}
		const resolved = workerHeadersFor(ctx, { ...result, fallbackUsed: true });
		fallbackActive = resolved;
		debugLog(`${stage}.fallback_active`, {
			provider: (resolved.model as { provider?: string })?.provider,
			id: (resolved.model as { id?: string })?.id,
		});
		return resolved;
	};

	return { resolve, resolveFallback, failureReason: () => cached && !cached.ok ? cached.reason : undefined };
}

/**
 * Run one worker stage against the resolved primary model, retrying once with the
 * configured fallback model when the call throws. A stage that already resolved
 * through the fallback (resolution-time fallback) is not retried again — its error
 * is final. The last error thrown is what the caller sees, so the existing
 * stream-error classification and failure recording stay intact.
 */
async function runStageWithFallback<T>(
	ctx: ConsolidationCtx,
	stage: ConsolidationPhase,
	resolved: ResolvedModel,
	resolver: ModelResolver,
	work: (model: ResolvedModel) => Promise<T>,
	modelAttempts: Record<string, unknown>[],
): Promise<T> {
	modelAttempts.push(workerMetadata(resolved));
	try {
		return await work(resolved);
	} catch (primaryError) {
		if (resolved.fallbackUsed === true) throw primaryError;
		const fallback = await resolver.resolveFallback(stage);
		if (!fallback) throw primaryError;
		const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
		debugLog(`${stage}.fallback_retry`, {
			primaryError: message,
			provider: (fallback.model as { provider?: string })?.provider,
			id: (fallback.model as { id?: string })?.id,
		});
		if (ctx.hasUI && ctx.ui) {
			ctx.ui.notify(
				`Observational memory: ${stage} failed (${message}); retrying with fallback model`,
				"warning",
			);
		}
		modelAttempts.push(workerMetadata(fallback));
		return await work(fallback);
	}
}

export function registerConsolidationTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	const launch = (_event: unknown, ctx: ConsolidationCtx) => {
		maybeLaunchConsolidation(pi, runtime, ctx);
	};
	pi.on("agent_start", launch);
	pi.on("turn_end", launch);
}

function debugSessionMetadata(ctx: ConsolidationCtx): { sessionId?: string; sessionFile?: string } {
	try {
		return {
			sessionId: ctx.sessionManager.getSessionId?.(),
			sessionFile: ctx.sessionManager.getSessionFile?.(),
		};
	} catch {
		return {};
	}
}

function maybeLaunchConsolidation(pi: ExtensionAPI, runtime: Runtime, ctx: ConsolidationCtx): void {
	runtime.ensureConfig(ctx.cwd);
	if (runtime.config.passive === true) return;
	if (runtime.consolidationInFlight) return;

	const entries = ctx.sessionManager.getBranch() as Entry[];
	if (!anyStageDue(entries, runtime, realContextTokens(ctx))) return;

	const runId = `consolidation-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
	const consolidationCtx: ConsolidationCtx = {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		ui: ctx.ui,
		model: ctx.model,
		modelRegistry: ctx.modelRegistry,
		getContextUsage: ctx.getContextUsage,
		sessionManager: ctx.sessionManager,
	};

	const sessionMetadata = debugSessionMetadata(ctx);
	void runtime.launchConsolidationTask(ctx, async () => withDebugLogContext({
		enabled: runtime.config.debugLog === true,
		cwd: ctx.cwd,
		...sessionMetadata,
		runId,
	}, async () => {
		await runConsolidationPipeline(pi, runtime, consolidationCtx);
	}));
}

export async function runConsolidationPipeline(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
): Promise<void> {
	const resolver = makeModelResolver(runtime, ctx);
	const currentPipeline = captureBranch(runtime, ctx);

	runtime.consolidationPhase = "observer";
	try {
		const observerOutcome = await runObserverStage(pi, runtime, ctx, resolver);
		if (observerOutcome === "abort") return;
	} catch (error) {
		if (!currentPipeline()) return;
		debugLog("observer.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "observer", error) });
		return;
	}

	runtime.consolidationPhase = "reflector";
	let reflectorResult: ReflectorStageResult;
	try {
		reflectorResult = await runReflectorStage(pi, runtime, ctx, resolver);
		if (reflectorResult.outcome === "abort") return;
	} catch (error) {
		if (!currentPipeline()) return;
		debugLog("reflector.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "reflector", error) });
		return;
	}

	runtime.consolidationPhase = "dropper";
	try {
		await runDropperStage(pi, runtime, ctx, resolver, reflectorResult.sameRunReflections, reflectorResult.effectiveReflectionCoverageId);
	} catch (error) {
		if (!currentPipeline()) return;
		debugLog("dropper.error", { errorMessage: runtime.recordConsolidationStageError(ctx, "dropper", error) });
	}
}

async function runObserverStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
): Promise<StageOutcome> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const currentTokens = realContextTokens(ctx);
	const recoveringSource = hasLegacyObservationBacklog(entries) || hasCompactedObservationBacklog(entries);
	const real = !recoveringSource && currentTokens !== undefined ? realTokensSinceAnchor(entries, OM_OBSERVATIONS_RECORDED, currentTokens) : undefined;
	const tokens = real !== undefined ? real : rawTokensSinceObservationCoverage(entries);
	if (!recoveringSource && tokens < runtime.config.observeAfterTokens) return "continue";

	const currentBranch = captureBranch(runtime, ctx);
	const sessionMetadata = debugSessionMetadata(ctx);
	const sessionIdentity = sessionMetadata.sessionId ?? sessionMetadata.sessionFile;
	const coverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);

	// Deliberate-empty backoff (#23): an intentional "nothing to record" verdict
	// must not re-fire the observer every turn over the same span. Retry only
	// after another observeAfterTokens worth of new source tokens arrives, and
	// drop the backoff as soon as coverage advances.
	const backoff = runtime.observerEmptyBackoff;
	if (backoff) {
		if (
			sessionIdentity !== backoff.sessionIdentity
			|| coverageId !== backoff.coverageId
			|| tokens >= backoff.tokensAtEmpty + runtime.config.observeAfterTokens
		) {
			runtime.observerEmptyBackoff = undefined;
		} else {
			debugLog("observer.empty_backoff", { tokens, resumeAtTokens: backoff.tokensAtEmpty + runtime.config.observeAfterTokens });
			return "continue";
		}
	}

	// Resolve the model before building the chunk: the default chunk cap
	// derives from the resolved model's context window.
	const resolved = await resolver.resolve("observer");
	if (!currentBranch()) return "abort";
	if (!resolved) {
		emitMemoryEvent(pi, ctx, "memory.observer.failed", { operationId: operationId(), reason: "model_unavailable", failure: resolver.failureReason() });
		persistMemoryState(pi, ctx);
		return "abort";
	}

	if (unavailableSourceHistory(entries)) {
		const failure = "unavailable_source_history: resume requires an intact raw session branch";
		emitMemoryEvent(pi, ctx, "memory.observer.failed", { operationId: operationId(), ...workerMetadata(resolved), failure });
		persistMemoryState(pi, ctx);
		throw new Error(failure);
	}
	const lastCoverageIdx = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
	const backlogEntries = sourceEntriesAfter(entries, lastCoverageIdx);

	// Budget ordered text plus actual image payloads. Complete entries are
	// atomic; text excerpts and unfit image entries never grant coverage.
	// runObserver additionally checks complete requests against each worker's
	// context/input limits, including prior memory, tools and output allowance.
	const contextWindow = observerChunkContextWindow(runtime, ctx, resolved);
	const maxChunkTokens = resolveObserverChunkMaxTokens(runtime.config, contextWindow);
	const {
		text: chunkText,
		content: chunkContent,
		sourceEntryIds,
		estimatedTokens: chunkTokens,
		truncatedSourceEntryIds,
		incompleteSourceEntryIds,
	} = serializeSourceAddressedBranchEntries(backlogEntries, { maxTokens: maxChunkTokens });
	if (incompleteSourceEntryIds.length > 0) {
		const failure = "unsupported_source: source payload cannot be completely represented for the observer";
		emitMemoryEvent(pi, ctx, "memory.observer.failed", { operationId: operationId(), ...workerMetadata(resolved), incompleteSourceEntryIds, failure });
		persistMemoryState(pi, ctx);
		throw new Error(failure);
	}
	if (truncatedSourceEntryIds.length > 0 && sourceEntryIds.length === 0) {
		const failure = "image_budget: image-bearing source entry cannot fit intact in observerChunkMaxTokens";
		emitMemoryEvent(pi, ctx, "memory.observer.failed", { operationId: operationId(), ...workerMetadata(resolved), truncatedSourceEntryIds, failure });
		persistMemoryState(pi, ctx);
		throw new Error(failure);
	}
	const hasImages = chunkContent.some((block) => block.type === "image");
	const chunk = hasImages ? chunkContent : chunkText;
	if (!chunkText.trim() || sourceEntryIds.length === 0) return "continue";
	const coversUpToId = sourceEntryIds.at(-1);
	if (!coversUpToId) return "continue";

	if (sourceEntryIds.length < backlogEntries.length || truncatedSourceEntryIds.length > 0) {
		debugLog("observer.chunk_capped", {
			maxChunkTokens,
			backlogEntries: backlogEntries.length,
			backlogTokens: tokens,
			chunkEntries: sourceEntryIds.length,
			chunkTokens,
			truncatedSourceEntryIds,
		});
	}

	const memory = fullProjection(entries);
	const priorReflections = memory.reflections.map(reflectionToSummaryLine);
	const priorObservations = memory.observations.map(observationToSummaryLine);

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: observer running on ~${chunkTokens.toLocaleString()}-token chunk`,
		"info",
	);
	debugLog("observer.start", {
		tokens,
		chunkTokens,
		coversUpToId,
		sourceEntryIds,
		sourceEntryCount: sourceEntryIds.length,
		priorReflections: priorReflections.length,
		priorObservations: priorObservations.length,
	});

	const modelAttempts: Record<string, unknown>[] = [];
	return trackedWorker<StageOutcome>(pi, ctx, "observer", currentBranch, {
		...workerMetadata(resolved), modelAttempts, sourceEntryIds, fromExclusiveId: coverageId ?? null,
		coversUpToId, chunkTokens, truncatedSourceEntryIds,
	}, async (commit) => {
		if (truncatedSourceEntryIds.length > 0) throw new Error("incomplete_source: observer chunk contains an excerpt; raise observerChunkMaxTokens to observe the full source");
		const observations = await runStageWithFallback(ctx, "observer", resolved, resolver, (worker) => {
			if (hasImages && !(worker.model as { input?: string[] }).input?.includes("image")) {
				throw new Error("unsupported_model: observer model does not accept images");
			}
			return runObserver({
				model: worker.model as any,
				apiKey: worker.apiKey,
				headers: worker.headers,
				env: worker.env,
				priorReflections,
				priorObservations,
				chunk,
				allowedSourceEntryIds: sourceEntryIds,
				maxTurns: runtime.config.agentMaxTurns,
				maxOutputTokens: runtime.config.agentMaxTokens,
				thinkingLevel: workerThinkingLevel(runtime, worker),
				modelRegistry: ctx.modelRegistry,
			});
		}, modelAttempts);
		if (!currentBranch()) throw new Error("stale worker branch; result discarded");
		if (!observations || observations.length === 0) {
			// Deliberate empty backs off over the same uncovered span.
			debugLog("observer.empty", { coversUpToId });
			runtime.observerEmptyBackoff = { sessionIdentity, coverageId, tokensAtEmpty: tokens };
			if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
				"Observational memory: observer found nothing new in this chunk (coverage unchanged; will retry later)",
				"info",
			);
			return "continue";
		}
		runtime.observerEmptyBackoff = undefined;

		const data = buildObservationsRecordedData(observations, coversUpToId);
		if (!data) return "continue";
		debugLog("observer.records", {
			count: observations.length,
			observationTokens: observations.reduce((sum, observation) => sum + observation.tokenCount, 0),
			coversUpToId,
		});
		const currentEntries = ctx.sessionManager.getBranch() as Entry[];
		if (latestCoverageMarkerId(currentEntries, OM_OBSERVATIONS_RECORDED) !== coverageId) throw new Error("observer_coverage_changed: result discarded");
		const record = { ...data, coverage: { version: 1 as const, fromExclusiveId: coverageId ?? null, sourceEntryIds, truncatedSourceEntryIds } };
		if (committedObserverFrontier([...currentEntries, { type: "custom", id: operationId(), customType: OM_OBSERVATIONS_RECORDED, data: record }]).id !== coversUpToId) {
			throw new Error("invalid_observer_coverage: result does not identify a complete contiguous source range");
		}
		commit(OM_OBSERVATIONS_RECORDED, record);
		debugLog("observer.appended", { count: observations.length, coversUpToId });
		if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
			`Observational memory: ${observations.length} observation${observations.length === 1 ? "" : "s"} recorded`,
			"info",
		);
		return "continue";
	});
}

async function runReflectorStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
): Promise<ReflectorStageResult> {
	const entries = ctx.sessionManager.getBranch() as Entry[];
	const currentTokens = realContextTokens(ctx);
	const real = currentTokens !== undefined ? realTokensSinceAnchor(entries, OM_REFLECTIONS_RECORDED, currentTokens) : undefined;
	const reflectionTokens = real !== undefined ? real : rawTokensSinceReflectionCoverage(entries); // fallback: no usage baseline / basis change
	if (reflectionTokens < runtime.config.reflectAfterTokens) return { outcome: "continue", sameRunReflections: [] };

	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return { outcome: "continue", sameRunReflections: [] };

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: reflector running (~${reflectionTokens.toLocaleString()} tokens)`,
		"info",
	);
	const currentBranch = captureBranch(runtime, ctx);
	const resolved = await resolver.resolve("reflector");
	if (!currentBranch()) return { outcome: "abort", sameRunReflections: [] };
	if (!resolved) {
		emitMemoryEvent(pi, ctx, "memory.reflector.failed", { operationId: operationId(), reason: "model_unavailable", failure: resolver.failureReason() });
		persistMemoryState(pi, ctx);
		return { outcome: "abort", sameRunReflections: [] };
	}
	const modelAttempts: Record<string, unknown>[] = [];
	return trackedWorker<ReflectorStageResult>(pi, ctx, "reflector", currentBranch, { ...workerMetadata(resolved), modelAttempts, coversUpToId: observationCoverageId }, async (commit) => {
		const folded = foldLedger(entries);
		const reflections = await runStageWithFallback(ctx, "reflector", resolved, resolver, (worker) => runReflector({
			model: worker.model as any,
			apiKey: worker.apiKey,
			headers: worker.headers,
			env: worker.env,
			reflections: folded.reflections,
			observations: folded.activeObservations,
			maxTurns: runtime.config.agentMaxTurns,
			maxOutputTokens: runtime.config.agentMaxTokens,
			thinkingLevel: workerThinkingLevel(runtime, worker),
			modelRegistry: ctx.modelRegistry,
		}), modelAttempts);
		if (!reflections) return { outcome: "continue", sameRunReflections: [] };

		const data = buildReflectionsRecordedData(reflections, observationCoverageId);
		if (!data) return { outcome: "continue", sameRunReflections: [] };
		commit(OM_REFLECTIONS_RECORDED, data);
		return {
			outcome: "continue",
			sameRunReflections: reflections,
			effectiveReflectionCoverageId: data.coversUpToId,
		};
	});
}

async function runDropperStage(
	pi: ExtensionAPI,
	runtime: Runtime,
	ctx: ConsolidationCtx,
	resolver: ModelResolver,
	sameRunReflections: Reflection[],
	sameRunReflectionCoverageId: string | undefined,
): Promise<StageOutcome> {
	if (!sameRunReflectionCoverageId || sameRunReflections.length === 0) {
		debugLog("dropper.waiting_for_reflection", { sameRunReflections: sameRunReflections.length });
		return "continue";
	}

	const entries = ctx.sessionManager.getBranch() as Entry[];
	const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
	if (!observationCoverageId) return "continue";

	const folded = foldLedger(entries);
	const metrics = observationPoolMetrics(folded.activeObservations, runtime.config.observationsPoolTargetTokens);
	if (!metrics.ready) {
		debugLog("dropper.not_ready", {
			observationTokens: metrics.observationTokens,
			targetTokens: metrics.targetTokens,
			tokensOverTarget: metrics.tokensOverTarget,
			fullness: metrics.fullness,
			activeObservationCount: metrics.activeObservationCount,
			droppableCount: metrics.droppableCount,
			maxDropsAllowed: metrics.maxDropsAllowed,
		});
		return "continue";
	}
	debugLog("dropper.stage_start", {
		observationCoverageId,
		sameRunReflectionCoverageId,
		sameRunReflectionCount: sameRunReflections.length,
		activeObservationCount: metrics.activeObservationCount,
		observationTokens: metrics.observationTokens,
		targetTokens: metrics.targetTokens,
		tokensOverTarget: metrics.tokensOverTarget,
		fullness: metrics.fullness,
		maxDropsAllowed: metrics.maxDropsAllowed,
	});

	if (shouldNotifyWorker(runtime, ctx)) ctx.ui?.notify(
		`Observational memory: dropper running after reflection — active observation pool ~${metrics.observationTokens.toLocaleString()} / ${metrics.targetTokens.toLocaleString()} target tokens (${Math.round(metrics.fullness * 100).toLocaleString()}%)`,
		"info",
	);
	const currentBranch = captureBranch(runtime, ctx);
	const resolved = await resolver.resolve("dropper");
	if (!currentBranch()) return "abort";
	if (!resolved) {
		emitMemoryEvent(pi, ctx, "memory.dropper.failed", { operationId: operationId(), reason: "model_unavailable", failure: resolver.failureReason() });
		persistMemoryState(pi, ctx);
		return "abort";
	}
	const modelAttempts: Record<string, unknown>[] = [];
	return trackedWorker<StageOutcome>(pi, ctx, "dropper", currentBranch, {
		...workerMetadata(resolved), modelAttempts, coversUpToId: observationCoverageId,
		activeObservationCount: metrics.activeObservationCount, targetTokens: metrics.targetTokens,
	}, async (commit) => {
		const reflectionsForDropper = mergeReflections(folded.reflections, sameRunReflections);
		const droppedIds = await runStageWithFallback(ctx, "dropper", resolved, resolver, (worker) => runDropper({
			model: worker.model as any,
			apiKey: worker.apiKey,
			headers: worker.headers,
			env: worker.env,
			reflections: reflectionsForDropper,
			observations: folded.activeObservations,
			targetTokens: runtime.config.observationsPoolTargetTokens,
			maxTurns: runtime.config.agentMaxTurns,
			maxOutputTokens: runtime.config.agentMaxTokens,
			thinkingLevel: workerThinkingLevel(runtime, worker),
			modelRegistry: ctx.modelRegistry,
		}), modelAttempts);
		const coversUpToId = earlierCoverageMarkerId(entries, observationCoverageId, sameRunReflectionCoverageId);
		const data = coversUpToId && droppedIds ? buildObservationsDroppedData(droppedIds, coversUpToId) : undefined;
		debugLog("dropper.append", {
			droppedIdsCount: droppedIds?.length ?? 0,
			coversUpToId,
			dataBuilt: data !== undefined,
			appended: data !== undefined,
		});
		if (data) commit(OM_OBSERVATIONS_DROPPED, data);
		return "continue";
	});
}
