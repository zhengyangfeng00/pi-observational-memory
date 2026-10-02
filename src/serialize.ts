import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { estimateStringTokens } from "./tokens.js";

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

function fmtLocal(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTimestamp(v: number | string | undefined): string {
	if (v === undefined) return "????-??-?? ??:??";
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? "????-??-?? ??:??" : fmtLocal(d);
}

function formatRecallTimestamp(...values: Array<number | string | undefined>): string {
	for (const v of values) {
		if (v === undefined) continue;
		const d = new Date(v);
		if (!Number.isNaN(d.getTime())) return fmtLocal(d);
	}
	return "Unknown time";
}

function textAndPlaceholders(
	content: unknown,
	options: { omitRedactedThinking?: boolean; includeThinking?: boolean } = {},
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "[non-text content omitted]";

	const parts: string[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (!block || typeof block !== "object") {
			parts.push("[non-text content omitted]");
			continue;
		}
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
			continue;
		}
		if (block.type === "thinking") {
			if (options.omitRedactedThinking && block.redacted === true) continue;
			if (options.includeThinking && typeof block.thinking === "string") {
				parts.push(`[thinking: ${block.thinking}]`);
				continue;
			}
			parts.push("[non-text content omitted]");
			continue;
		}
		if (block.type === "toolCall" && typeof block.name === "string") {
			const name = typeof block.namespace === "string" ? `${block.namespace}.${block.name}` : block.name;
			parts.push(`[${name}(${JSON.stringify(block.arguments ?? {})})${typeof block.id === "string" ? ` id=${block.id}` : ""}]`);
			continue;
		}
		parts.push("[non-text content omitted]");
	}
	return parts.join("\n");
}

function serializeMessage(msg: AgentMessage, time: string, recall = false): string {
	switch (msg.role) {
		case "user": return `[User @ ${time}]: ${textAndPlaceholders(msg.content)}`;
		case "assistant": return `[Assistant @ ${time}]: ${textAndPlaceholders(msg.content, { includeThinking: true, omitRedactedThinking: true })}`;
		case "toolResult": return `[Tool result${recall ? ":" : " for"} ${msg.toolName} @ ${time}]: ${textAndPlaceholders(msg.content)}\n[Tool call id: ${msg.toolCallId}; error: ${msg.isError}]`;
		case "system": {
			// Structured prompt/loadout changes are payload too, not just content.
			const { role: _role, timestamp: _timestamp, content, ...checkpoint } = msg;
			return `[System @ ${time}]: ${textAndPlaceholders(content)}\n${JSON.stringify(checkpoint)}`;
		}
		case "bashExecution": {
			// Use Pi's own converter so command, output, exit/cancellation and
			// truncation/path annotations exactly match the host's model context.
			const projected = convertToLlm([msg])[0];
			return `[Bash execution @ ${time}]: ${projected ? textAndPlaceholders(projected.content) : "[Excluded from model context]"}`;
		}
		case "custom": return `[Custom (${msg.customType}) @ ${time}]: ${textAndPlaceholders(msg.content)}`;
		case "branchSummary": return `[Branch summary @ ${time}]: ${msg.summary}`;
		case "compactionSummary": return `[Compaction summary @ ${time}]: ${msg.summary}`;
		default: return `[Unsupported source message @ ${time}]: ${JSON.stringify(msg)}`;
	}
}

export function serializeConversation(messages: AgentMessage[]): string {
	return messages.map((msg) => serializeMessage(msg, formatTimestamp(msg.timestamp))).join("\n\n");
}

export function nowTimestamp(): string {
	return fmtLocal(new Date());
}

export const MAX_RECORD_CONTENT_CHARS = 10_000;

export function truncateRecordContent(content: string): string {
	if (content.length <= MAX_RECORD_CONTENT_CHARS) return content;
	const head = content.slice(0, MAX_RECORD_CONTENT_CHARS);
	const dropped = content.length - MAX_RECORD_CONTENT_CHARS;
	return `${head} … [truncated ${dropped} chars]`;
}

export type RenderableEntry = {
	type: string;
	id?: string;
	timestamp?: string;
	message?: unknown;
	customType?: string;
	content?: unknown;
	summary?: unknown;
};

function renderCustomMessage(entry: RenderableEntry, options: { recallFormat: boolean }): string {
	const time = options.recallFormat ? formatRecallTimestamp(entry.timestamp) : formatTimestamp(entry.timestamp);
	const text = textAndPlaceholders(entry.content);
	if (options.recallFormat) {
		const origin = entry.customType ? `Custom message (${entry.customType})` : "Custom message";
		return `[${origin} @ ${time}]: ${text}`;
	}
	const tag = entry.customType ? `Custom (${entry.customType})` : "Custom";
	return `[${tag} @ ${time}]: ${text}`;
}

export function serializeBranchEntries(entries: RenderableEntry[]): string {
	const blocks: string[] = [];
	for (const entry of entries) {
		if (entry.type === "message" && entry.message) {
			const part = serializeConversation([entry.message as AgentMessage]);
			if (part) blocks.push(part);
			continue;
		}
		if (entry.type === "custom_message") {
			blocks.push(renderCustomMessage(entry, { recallFormat: false }));
			continue;
		}
		if (entry.type === "branch_summary" && typeof entry.summary === "string") {
			const time = formatTimestamp(entry.timestamp);
			blocks.push(`[Branch summary @ ${time}]: ${entry.summary}`);
		}
	}
	return blocks.join("\n\n");
}

export type SourceAddressedSerialization = {
	text: string;
	sourceEntryIds: string[];
	estimatedTokens: number;
	truncatedSourceEntryIds: string[];
	incompleteSourceEntryIds: string[];
};

export type SourceAddressedSerializationOptions = {
	/** Maximum estimated tokens in the final source-addressed text. */
	maxTokens?: number;
};

const SOURCE_OMISSION_MARKER =
	"\n\n[… middle omitted: source exceeds observer input budget; original source remains in the session ledger …]\n\n";

function truncateSourceBlockToTokenBudget(label: string, rendered: string, maxTokens: number): string | undefined {
	const required = `${label}\n${SOURCE_OMISSION_MARKER}`;
	if (estimateStringTokens(required) > maxTokens) return undefined;
	const full = `${label}\n${rendered}`;
	if (estimateStringTokens(full) <= maxTokens) return full;
	const maxChars = Math.max(1, maxTokens * 4);
	const fixed = `${label}\n${SOURCE_OMISSION_MARKER}`;
	const retainedChars = maxChars - fixed.length;
	const headChars = Math.ceil(retainedChars / 2);
	const tailChars = retainedChars - headChars;
	return `${label}\n${rendered.slice(0, headChars)}${SOURCE_OMISSION_MARKER}${tailChars > 0 ? rendered.slice(-tailChars) : ""}`;
}

function isSourceRenderableEntry(entry: RenderableEntry): boolean {
	return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

function isCompleteContent(content: unknown): boolean {
	if (typeof content === "string") return true;
	return Array.isArray(content) && content.every((block) => {
		if (!block || typeof block !== "object") return false;
		if (block.type === "text") return typeof block.text === "string";
		if (block.type === "thinking") return block.redacted === true || typeof block.thinking === "string";
		if (block.type === "toolCall") return typeof block.name === "string" && block.arguments !== undefined;
		// A text-only observer cannot prove coverage of images/unknown blocks.
		return false;
	});
}

function isCompleteSource(entry: RenderableEntry): boolean {
	if (entry.type === "custom_message") return isCompleteContent(entry.content);
	if (entry.type === "branch_summary") return typeof entry.summary === "string";
	if (!entry.message || typeof entry.message !== "object") return false;
	const msg = entry.message as Record<string, unknown>;
	switch (msg.role) {
		case "user": case "assistant": case "toolResult": case "system": case "custom":
			return isCompleteContent(msg.content);
		case "bashExecution": return typeof msg.command === "string" && typeof msg.output === "string";
		case "branchSummary": case "compactionSummary": return typeof msg.summary === "string";
		default: return false;
	}
}

/**
 * Serialize complete source entries up to the token budget. If the first entry
 * alone exceeds the budget, report a clearly marked head/tail excerpt. Callers
 * decide whether excerpts can grant coverage; the observer requires full input.
 * The original ledger entry is never modified and remains recallable by id.
 */
export function serializeSourceAddressedBranchEntries(
	entries: RenderableEntry[],
	options: SourceAddressedSerializationOptions = {},
): SourceAddressedSerialization {
	const blocks: string[] = [];
	const sourceEntryIds: string[] = [];
	const truncatedSourceEntryIds: string[] = [];
	const incompleteSourceEntryIds: string[] = [];
	let estimatedTokens = 0;

	for (const entry of entries) {
		if (!entry.id || !isSourceRenderableEntry(entry)) continue;
		if (!isCompleteSource(entry)) {
			if (blocks.length === 0) incompleteSourceEntryIds.push(entry.id);
			break; // Observe a complete prefix first; never jump past this payload.
		}
		const rawRendered = serializeBranchEntries([entry]);
		const rendered = rawRendered.trim() ? rawRendered : "[Source entry has no serializable text]";
		const label = `[Source entry id: ${entry.id}]`;
		const block = `${label}\n${rendered}`;
		const separator = blocks.length > 0 ? "\n\n" : "";
		const blockTokens = estimateStringTokens(`${separator}${block}`);
		const maxTokens = options.maxTokens;

		if (maxTokens !== undefined && estimatedTokens + blockTokens > maxTokens) {
			if (blocks.length > 0) break;
			const excerpt = truncateSourceBlockToTokenBudget(label, rendered, maxTokens);
			if (!excerpt) break;
			blocks.push(excerpt);
			sourceEntryIds.push(entry.id);
			truncatedSourceEntryIds.push(entry.id);
			estimatedTokens = estimateStringTokens(excerpt);
			break;
		}

		blocks.push(block);
		sourceEntryIds.push(entry.id);
		estimatedTokens += blockTokens;
	}

	const text = blocks.join("\n\n");
	return { text, sourceEntryIds, estimatedTokens: estimateStringTokens(text), truncatedSourceEntryIds, incompleteSourceEntryIds };
}

function renderRecallMessage(entry: RenderableEntry): string | null {
	if (!entry.message || typeof entry.message !== "object") return null;
	const msg = entry.message as AgentMessage;
	return serializeMessage(msg, formatRecallTimestamp(msg.timestamp, entry.timestamp), true);
}

export function renderRecallSourceEntry(entry: RenderableEntry): string | null {
	if (entry.type === "message") return renderRecallMessage(entry);
	if (entry.type === "custom_message") return renderCustomMessage(entry, { recallFormat: true });
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		const time = formatRecallTimestamp(entry.timestamp);
		return `[Branch summary @ ${time}]: ${entry.summary}`;
	}
	return null;
}

export function renderRecallSourceEntries(entries: RenderableEntry[]): string {
	return entries
		.map(renderRecallSourceEntry)
		.filter((block): block is string => block !== null && block.trim().length > 0)
		.join("\n\n");
}
