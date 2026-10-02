import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCompactAfterTokens } from "../config.js";
import { rawTokensSinceLastCompaction, type Entry } from "../session-ledger/index.js";
import type { Runtime } from "../runtime.js";
import { captureBranch, emitMemoryEvent, operationId, persistMemoryState } from "../telemetry.js";

export function registerCompactionTrigger(pi: ExtensionAPI, runtime: Runtime): void {
	// Pi emits agent_settled only after retries, automatic compaction, and queued
	// continuation have finished, so retry policy stays owned by Pi.
	pi.on("agent_settled", (_event, ctx) => {
		runtime.ensureConfig(ctx.cwd);
		if (runtime.config.passive === true) return;
		if (runtime.compactInFlight) return;

		const entries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
		if (!entries) return;
		const progress = rawTokensSinceLastCompaction(entries);
		const contextWindow = typeof ctx.model?.contextWindow === "number" ? ctx.model.contextWindow : undefined;
		const threshold = resolveCompactAfterTokens(runtime.config, contextWindow);
		if (progress < threshold) return;

		// Capture ctx properties synchronously — the setTimeout + async work below
		// may outlive the extension ctx (stale after session replacement/reload).
		const hasUI = ctx.hasUI;
		const ui = ctx.ui;
		const currentBranch = captureBranch(runtime, ctx);
		const id = operationId();
		let beforeHook = runtime.memoryCompactionSequence ?? 0;
		const deferred = (reason: string, failure?: string) => {
			if (!currentBranch()) return;
			emitMemoryEvent(pi, ctx, failure ? "memory.compaction.failed" : "memory.compaction.deferred", {
				operationId: id, reason, failure, threshold, sourceTokens: progress,
			});
			persistMemoryState(pi, ctx);
		};

		if (hasUI) ui?.notify(
			`Observational memory: compaction threshold reached (~${progress.toLocaleString()} estimated source tokens); triggering compaction`,
			"info",
		);

		runtime.compactInFlight = true;
		setTimeout(() => {
			try {
				if (!currentBranch()) { runtime.compactInFlight = false; return; }
				if (!ctx.isIdle()) {
					deferred("agent_busy");
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction deferred — agent became busy before compaction",
						"info",
					);
					return;
				}
				const currentEntries = ctx.sessionManager?.getBranch?.() as Entry[] | undefined;
				if (!currentEntries) {
					runtime.compactInFlight = false;
					return;
				}
				const currentProgress = rawTokensSinceLastCompaction(currentEntries);
				if (currentProgress < threshold) {
					deferred("threshold_no_longer_met");
					runtime.compactInFlight = false;
					if (hasUI) ui?.notify(
						"Observational memory: compaction skipped — another compaction already ran before deferred compaction",
						"info",
					);
					return;
				}
				beforeHook = runtime.memoryCompactionSequence ?? 0;
				const metadata = { operationId: id, reason: "source_threshold", threshold, sourceTokens: currentProgress };
				runtime.memoryCompactionRequest = { operationId: id, startedAt: Date.now(), current: currentBranch, metadata };
				emitMemoryEvent(pi, ctx, "memory.compaction.requested", metadata);
				ctx.compact({
					onComplete: () => {
						runtime.memoryCompactionRequest = undefined;
						runtime.compactInFlight = false;
						if (hasUI) ui?.notify("Observational memory: compaction complete", "info");
					},
					onError: (error: { message: string }) => {
						runtime.memoryCompactionRequest = undefined;
						runtime.compactInFlight = false;
						if (error.message === "Compaction cancelled") {
							// We already notified the user with the real reason before returning { cancel: true }.
							return;
						}
						if ((runtime.memoryCompactionSequence ?? 0) === beforeHook) deferred("request_error", error.message);
						if (hasUI) ui?.notify(`Observational memory: ${error.message}`, "error");
					},
				});
			} catch (error) {
				runtime.memoryCompactionRequest = undefined;
				runtime.compactInFlight = false;
				const msg = error instanceof Error ? error.message : String(error);
				if ((runtime.memoryCompactionSequence ?? 0) === beforeHook) deferred("request_threw", msg);
				if (hasUI) ui?.notify(`Observational memory: compact threw: ${msg}`, "error");
			}
		}, 0);
	});
}
