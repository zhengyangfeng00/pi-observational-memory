import { isObservationsRecordedEntry, isReflectionsRecordedEntry, type Entry } from "./types.js";

export type ObserverCoverage = {
	version: 1;
	fromExclusiveId: string | null;
	sourceEntryIds: string[];
	truncatedSourceEntryIds: string[];
};

function source(entry: Entry): boolean {
	return ["message", "custom_message", "branch_summary"].includes(entry.type);
}

/** Only validated, already appended, branch-local ledger records grant coverage. */
export function committedObserverFrontier(entries: Entry[]): { id: string | null; index: number } {
	const indexes = new Map(entries.map((entry, index) => [entry.id, index]));
	// Ambiguous identity must never grant permission to discard source.
	if (indexes.size !== entries.length) return { id: null, index: -1 };
	let index = -1;
	for (let recordIndex = 0; recordIndex < entries.length; recordIndex++) {
		const entry = entries[recordIndex];
		if (!isObservationsRecordedEntry(entry)) continue;
		const end = indexes.get(entry.data.coversUpToId);
		if (end === undefined || end <= index || end >= recordIndex || !source(entries[end])) continue;
		if (!entry.data.observations.every((observation) => observation.sourceEntryIds.every((id) => {
			const position = indexes.get(id);
			return position !== undefined && position <= end && source(entries[position]);
		}))) continue;
		const coverage = (entry.data as typeof entry.data & { coverage?: ObserverCoverage }).coverage;
		// Historical coversUpToId alone cannot prove full input: legacy workers
		// were allowed to cover head/tail excerpts. Re-observe before trusting it.
		if (coverage === undefined || coverage === null || typeof coverage !== "object") continue;
		const expected = entries.slice(index + 1, end + 1).filter(source).map((item) => item.id);
		if (coverage.version !== 1 || coverage.fromExclusiveId !== (entries[index]?.id ?? null)
			|| !Array.isArray(coverage.sourceEntryIds)
			|| JSON.stringify(coverage.sourceEntryIds) !== JSON.stringify(expected)
			|| !Array.isArray(coverage.truncatedSourceEntryIds)
			|| coverage.truncatedSourceEntryIds.length > 0) continue;
		index = end;
	}
	return { id: entries[index]?.id ?? null, index };
}

/** Upgrade recovery must not be suppressed by a small post-compaction provider delta. */
export function hasLegacyObservationBacklog(entries: Entry[]): boolean {
	const frontier = committedObserverFrontier(entries);
	const indexes = new Map(entries.map((entry, index) => [entry.id, index]));
	return entries.some((entry, recordIndex) => {
		if (!isObservationsRecordedEntry(entry) || (entry.data as typeof entry.data & { coverage?: unknown }).coverage !== undefined) return false;
		const end = indexes.get(entry.data.coversUpToId) ?? -1;
		return end > frontier.index && end < recordIndex && end >= 0 && source(entries[end]);
	});
}

export function committedReflectionFrontier(entries: Entry[]): string | null {
	const observed = committedObserverFrontier(entries);
	let latest = -1;
	const indexes = new Map(entries.map((entry, index) => [entry.id, index]));
	const observationIds = new Set<string>();
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (isObservationsRecordedEntry(entry)) {
			for (const observation of entry.data.observations) observationIds.add(observation.id);
		}
		if (!isReflectionsRecordedEntry(entry)) continue;
		const position = indexes.get(entry.data.coversUpToId) ?? -1;
		if (position >= 0 && source(entries[position]) && position < i && position <= observed.index && position > latest
			&& entry.data.reflections.every((reflection) => reflection.supportingObservationIds.every((id) => observationIds.has(id)))) latest = position;
	}
	return entries[latest]?.id ?? null;
}

export function validCutPoint(entry: Entry): boolean {
	if (entry.type === "custom_message" || entry.type === "branch_summary") return true;
	if (entry.type !== "message") return false;
	const role = (entry.message as { role?: string } | undefined)?.role;
	return role === "user" || role === "assistant" || role === "bashExecution";
}

export type SafeCut = { ok: true; firstKeptEntryId: string; frontier: string; clamped: boolean }
	| { ok: false; reason: string; frontier: string | null };

export function safeCompactionCut(entries: Entry[], desiredId: string): SafeCut {
	const frontier = committedObserverFrontier(entries);
	const blocked = (reason: string): SafeCut => ({ ok: false, reason, frontier: frontier.id });
	const desired = entries.findIndex((entry) => entry.id === desiredId);
	if (desired < 0) return blocked("unknown_desired_boundary");
	if (frontier.id === null) return blocked("no_committed_observer_coverage");
	const uncovered = entries.findIndex((entry, index) => index > frontier.index && source(entry));
	let cut = uncovered < 0 ? desired : Math.min(desired, uncovered);
	while (cut >= 0 && !validCutPoint(entries[cut])) cut--;
	if (cut < 0) return blocked("unrepresentable_boundary");
	// Workers serialize raw source, not Pi's replacement projection. Never
	// discard edited content under coverage of the original source value.
	const latestEdits = new Map<string, unknown>();
	for (const entry of entries) {
		if (entry.type !== "context_edit") continue;
		const edit = entry as Entry & { targetId?: string; replacement?: unknown };
		if (edit.targetId) latestEdits.set(edit.targetId, edit.replacement);
	}
	if (entries.slice(0, cut).some((entry) => source(entry) && latestEdits.has(entry.id) && latestEdits.get(entry.id) !== null)) {
		return blocked("context_edited_source");
	}
	let lastCompaction = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") { lastCompaction = i; break; }
	}
	const previousKept = lastCompaction < 0 ? 0
		: entries.findIndex((entry) => entry.id === entries[lastCompaction].firstKeptEntryId);
	if (lastCompaction >= 0 && (previousKept < 0 || cut < previousKept)) return blocked("incompatible_previous_boundary");
	if (!entries.slice(previousKept, cut).some(source)) return blocked("no_removable_covered_source");
	return { ok: true, firstKeptEntryId: entries[cut].id, frontier: frontier.id, clamped: entries[cut].id !== desiredId };
}
