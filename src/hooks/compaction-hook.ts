import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.js";
import { safeCompactionCut } from "../session-ledger/coverage.js";
import { buildCompactionProjection, rawTokensAfterIndex, renderSummary, type Entry } from "../session-ledger/index.js";
import { captureBranch, emitMemoryEvent, operationId, persistMemoryState } from "../telemetry.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	let pending: { operationId: string; startedAt: number; current: () => boolean; metadata: Record<string, unknown> } | undefined;
	pi.on("session_compact", (event, ctx) => {
		const attempt = pending ?? runtime.memoryCompactionRequest;
		pending = undefined;
		runtime.memoryCompactionRequest = undefined;
		runtime.memoryCompactionSequence = (runtime.memoryCompactionSequence ?? 0) + 1;
		if (attempt && !attempt.current()) return;
		emitMemoryEvent(pi, ctx, "memory.compaction.completed", {
			...attempt?.metadata,
			operationId: attempt?.operationId ?? operationId(),
			durationMs: attempt ? Date.now() - attempt.startedAt : null,
			firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
			compactionEntryId: event.compactionEntry.id,
		});
		persistMemoryState(pi, ctx);
	});
	pi.on("session_compact_failed", (event, ctx) => {
		const attempt = pending ?? runtime.memoryCompactionRequest;
		pending = undefined;
		runtime.memoryCompactionRequest = undefined;
		runtime.memoryCompactionSequence = (runtime.memoryCompactionSequence ?? 0) + 1;
		if (attempt && !attempt.current()) return;
		emitMemoryEvent(pi, ctx, "memory.compaction.failed", {
			...attempt?.metadata,
			operationId: attempt?.operationId ?? operationId(),
			durationMs: attempt ? Date.now() - attempt.startedAt : null,
			failure: event.errorMessage ?? attempt?.metadata.failure ?? "compaction cancelled",
			aborted: event.aborted,
		});
		persistMemoryState(pi, ctx);
	});
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) ctx.ui.notify("Observational memory: another compaction is already in progress; cancelling duplicate", "warning");
			return { cancel: true };
		}
		runtime.compactHookInFlight = true;
		runtime.memoryCompactionSequence = (runtime.memoryCompactionSequence ?? 0) + 1;
		const request = runtime.memoryCompactionRequest?.current() ? runtime.memoryCompactionRequest : undefined;
		const id = request?.operationId ?? operationId();
		const metadata = {
			...request?.metadata,
			operationId: id,
			desiredFirstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
			reason: event.reason ?? "manual",
		};
		pending = { operationId: id, startedAt: request?.startedAt ?? Date.now(), current: captureBranch(runtime, ctx, event.branchEntries as Entry[]), metadata };
		try {
			runtime.ensureConfig(ctx.cwd);
			if (!pending.current()) return { cancel: true };
			if (!request) emitMemoryEvent(pi, ctx, "memory.compaction.requested", metadata);
			const entries = event.branchEntries as Entry[];
			const cut = safeCompactionCut(entries, event.preparation.firstKeptEntryId);
			if (!cut.ok) {
				emitMemoryEvent(pi, ctx, "memory.compaction.blocked_on_observer", { ...metadata, reason: cut.reason, observedThrough: cut.frontier });
				persistMemoryState(pi, ctx);
				if (ctx.hasUI) ctx.ui.notify(`Observational memory: compaction blocked — ${cut.reason}`, "warning");
				return { cancel: true };
			}
			// A desired cut can fall inside a committed observer batch. Include the
			// whole batch rather than omit its memory by projecting only to the cut.
			const projection = buildCompactionProjection(entries, cut.frontier, { observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) });
			const summary = renderSummary(projection.reflections, projection.observations);
			if (!summary || event.signal?.aborted || !pending.current()) {
				emitMemoryEvent(pi, ctx, "memory.compaction.deferred", { ...metadata, reason: !summary ? "empty_memory" : "stale_or_aborted" });
				return { cancel: true };
			}
			const keptIndex = entries.findIndex((entry) => entry.id === cut.firstKeptEntryId);
			pending.metadata = {
				...metadata, firstKeptEntryId: cut.firstKeptEntryId, coverageUsedThrough: cut.frontier, clamped: cut.clamped,
				retainedRawTokens: rawTokensAfterIndex(entries, keptIndex - 1),
				desiredRetainedRawTokens: rawTokensAfterIndex(entries, entries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId) - 1),
				lastDiscardedSourceEntryId: entries.slice(0, keptIndex).reverse().find((entry) => ["message", "custom_message", "branch_summary"].includes(entry.type))?.id ?? null,
			};
			if (cut.clamped) emitMemoryEvent(pi, ctx, "memory.compaction.blocked_on_observer", { ...pending.metadata, reason: "boundary_clamped", deferred: false });
			return { compaction: { summary, firstKeptEntryId: cut.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: projection.details } };
		} catch (error) {
			// Hook exceptions normally fall through to native Pi compaction. Fail
			// closed even when persistence/telemetry itself cannot be written.
			if (pending) pending.metadata.failure = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Observational memory: compaction blocked: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return { cancel: true };
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
