import { SessionManager } from "@earendil-works/pi-coding-agent";
import { observation, memoryDetails } from "./session.js";

/** Historical worker accepted an oversized head/tail excerpt and advanced coversUpToId. */
export function legacyExcerptFixture() {
	const manager = SessionManager.inMemory();
	const middleFact = "MIDDLE_ONLY_SAFETY_FACT";
	const originalText = `HEAD:${"a".repeat(2_000)}:${middleFact}:${"z".repeat(2_000)}:TAIL`;
	const sourceId = manager.appendMessage({ role: "user", content: originalText, timestamp: Date.now() });
	const legacy = observation("aaaaaaaaaaaa", { sourceEntryIds: [sourceId], content: "Only HEAD and TAIL were observed" });
	manager.appendCustomEntry("om.observations.recorded", { observations: [legacy], coversUpToId: sourceId });
	const keptId = manager.appendMessage({ role: "user", content: "previously retained source", timestamp: Date.now() });
	manager.appendCompaction("Legacy excerpt summary", keptId, 2_000, memoryDetails({ observations: [legacy] }), true);
	manager.appendMessage({
		role: "assistant", content: [{ type: "text", text: "post-compaction baseline" }],
		api: "openai-completions", provider: "test", model: "memory", stopReason: "stop", timestamp: Date.now(),
		usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	const boundary = manager.appendMessage({ role: "user", content: "next retained source", timestamp: Date.now() });
	return { manager, sourceId, boundary, middleFact, originalText };
}
