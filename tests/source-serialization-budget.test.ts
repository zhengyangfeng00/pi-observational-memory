import { describe, expect, it } from "vitest";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

import { renderRecallSourceEntry, serializeSourceAddressedBranchEntries } from "../src/serialize.js";
import { estimateStringTokens } from "../src/tokens.js";

function customEntry(id: string, content: string) {
	return {
		type: "custom_message",
		id,
		timestamp: "2026-05-02T10:00:00.000Z",
		content,
	};
}

function toolResultEntry(id: string, text: string) {
	return {
		type: "message",
		id,
		timestamp: "2026-05-02T10:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.parse("2026-05-02T10:00:00.000Z"),
		},
	};
}

describe("source-addressed serialization budget", () => {
	it("includes an explicit label for empty source rather than creating a coverage identity gap", () => {
		const result = serializeSourceAddressedBranchEntries([
			{ type: "message", id: "empty", message: { role: "assistant", content: [] } },
			customEntry("next", "text"),
		]);
		expect(result.sourceEntryIds).toEqual(["empty", "next"]);
		expect(result.text).toContain("[Source entry id: empty]");
		expect(result.incompleteSourceEntryIds).toEqual([]);
		expect(result.truncatedSourceEntryIds).toEqual([]);
	});
	it.each([
		[{ role: "user", content: "USER_PAYLOAD" }, "USER_PAYLOAD"],
		[{ role: "assistant", content: [{ type: "thinking", thinking: "THINKING_PAYLOAD" }, { type: "toolCall", name: "bash", arguments: { command: "CALL_PAYLOAD" } }] }, "CALL_PAYLOAD"],
		[{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "RESULT_PAYLOAD" }] }, "RESULT_PAYLOAD"],
		[{ role: "system", content: "SYSTEM_PAYLOAD", sections: { guidelines: "SECTION_PAYLOAD" }, toolsAdded: [{ name: "TOOL_PAYLOAD" }] }, "SECTION_PAYLOAD"],
		[{ role: "custom", customType: "note", content: "CUSTOM_PAYLOAD" }, "CUSTOM_PAYLOAD"],
		[{ role: "branchSummary", summary: "BRANCH_PAYLOAD" }, "BRANCH_PAYLOAD"],
		[{ role: "compactionSummary", summary: "COMPACTION_PAYLOAD" }, "COMPACTION_PAYLOAD"],
	])("preserves supported message payload %j", (message, payload) => {
		const result = serializeSourceAddressedBranchEntries([{ type: "message", id: "source", message }]);
		expect(result.text).toContain(payload as string);
		expect(result.sourceEntryIds).toEqual(["source"]);
		expect(result.incompleteSourceEntryIds).toEqual([]);
	});

	it("matches Pi's bash context including command/output and annotations in input and recall", () => {
		const message = { role: "bashExecution" as const, command: "DISTINCT_COMMAND", output: "DISTINCT_OUTPUT", exitCode: 9, cancelled: false, truncated: true, fullOutputPath: "/tmp/distinct-output", timestamp: Date.now() };
		const entry = { type: "message", id: "bash", message };
		const projected = (convertToLlm([message])[0].content as any[])[0].text;
		expect(serializeSourceAddressedBranchEntries([entry]).text).toContain(projected);
		expect(renderRecallSourceEntry(entry)).toContain(projected);
		const excluded = serializeSourceAddressedBranchEntries([{ ...entry, message: { ...message, excludeFromContext: true } }]);
		expect(excluded.text).toContain("Excluded from model context");
		expect(excluded.text).not.toContain(message.command);
	});

	it.each([
		{ type: "message", id: "unsupported", message: { role: "unknown", payload: "hidden" } },
		{ type: "message", id: "unsupported", message: { role: "user", content: [{ type: "image", data: "binary" }] } },
		{ type: "custom_message", id: "unsupported", content: [{ type: "unknown", payload: "hidden" }] },
		{ type: "branch_summary", id: "unsupported", summary: undefined },
	])("marks unsupported source incomplete and never skips to later source %j", (entry) => {
		const blocked = serializeSourceAddressedBranchEntries([entry, customEntry("later", "later")]);
		expect(blocked.incompleteSourceEntryIds).toEqual(["unsupported"]);
		expect(blocked.sourceEntryIds).toEqual([]);
		const prefix = serializeSourceAddressedBranchEntries([customEntry("before", "before"), entry, customEntry("later", "later")]);
		expect(prefix.sourceEntryIds).toEqual(["before"]);
		expect(prefix.incompleteSourceEntryIds).toEqual([]);
	});

	it("preserves all source blocks when they fit", () => {
		const entries = [
			customEntry("raw-1", "first"),
			customEntry("raw-2", "second"),
		];
		const result = serializeSourceAddressedBranchEntries(entries, {
			maxTokens: 1_000,
		});

		expect(result.sourceEntryIds).toEqual(["raw-1", "raw-2"]);
		expect(result.truncatedSourceEntryIds).toEqual([]);
		expect(result.text).toContain("[Source entry id: raw-1]");
		expect(result.text).toContain("[Source entry id: raw-2]");
		expect(result.estimatedTokens).toBe(estimateStringTokens(result.text));
	});

	it("keeps later complete entries for the next run when the budget is full", () => {
		const first = customEntry("raw-1", "a".repeat(80));
		const second = customEntry("raw-2", "b".repeat(80));
		const firstOnly = serializeSourceAddressedBranchEntries([first]);
		const result = serializeSourceAddressedBranchEntries([first, second], {
			maxTokens: firstOnly.estimatedTokens,
		});

		expect(result.sourceEntryIds).toEqual(["raw-1"]);
		expect(result.truncatedSourceEntryIds).toEqual([]);
		expect(result.text).not.toContain("raw-2");
	});

	it("returns no source instead of truncating the source label under an unusably small budget", () => {
		const result = serializeSourceAddressedBranchEntries(
			[customEntry("raw-1", "content")],
			{ maxTokens: 1 },
		);

		expect(result).toEqual({
			text: "",
			sourceEntryIds: [],
			estimatedTokens: 0,
			truncatedSourceEntryIds: [],
			incompleteSourceEntryIds: [],
		});
	});

	it("uses a marked head/tail excerpt when one tool result exceeds the budget", () => {
		const source = `HEAD:${"m".repeat(2_000)}:TAIL`;
		const hugeEntry = toolResultEntry("raw-huge", source);
		const result = serializeSourceAddressedBranchEntries(
			[hugeEntry, customEntry("raw-next", "later")],
			{ maxTokens: 100 },
		);

		expect(result.sourceEntryIds).toEqual(["raw-huge"]);
		expect(result.truncatedSourceEntryIds).toEqual(["raw-huge"]);
		expect(result.estimatedTokens).toBeLessThanOrEqual(100);
		expect(result.text).toContain("[Source entry id: raw-huge]");
		expect(result.text).toContain("[Tool result for bash");
		expect(result.text).toContain("HEAD:");
		expect(result.text).toContain(":TAIL");
		expect(result.text).toContain(
			"middle omitted: source exceeds observer input budget",
		);
		expect(result.text).toContain(
			"original source remains in the session ledger",
		);
		expect(result.text).not.toContain("raw-next");

		// Budgeting changes only the observer projection. Recall still renders
		// the original, unmodified ledger entry in full.
		const recalled = renderRecallSourceEntry(hugeEntry);
		expect(recalled).toContain(source);
		expect(recalled?.length).toBeGreaterThan(result.text.length);
	});
});
