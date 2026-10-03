import { describe, expect, it } from "vitest";
import { collectPayloadImages, imageFingerprint, verifyRequestImages } from "../scripts/replay-images.mjs";

const first = { mimeType: "image/png", data: Buffer.from("first captured image").toString("base64") };
const second = { mimeType: "image/png", data: Buffer.from("second captured image").toString("base64") };
const a = imageFingerprint(first);
const b = imageFingerprint(second);
const request = (images: typeof a[], index = 1) => ({ request: index, payloadImages: [images] });

describe("captured replay image verification", () => {
	it("collects actual payload image order and repeated occurrences", () => {
		const payload = { input: [{ role: "user", content: [
			{ type: "input_text", text: "surrounding text" },
			...([first, second, first].map((image) => ({ type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` }))),
		] }] };
		expect(collectPayloadImages(payload)).toEqual([a, b, a]);
	});

	it("requires every request to preserve the entire ordered list, including duplicates", () => {
		expect(verifyRequestImages([a, b, a], [request([a, b, a]), request([a, b, a], 2)])).toBe(true);
	});

	it.each([
		[[request([a, b]), request([], 2)], "later dropped images"],
		[[request([]), request([a, b], 2)], "initial dropped images"],
		[[request([b, a])], "reordered images"],
		[[request([a])], "missing image"],
		[[request([a, b, b])], "extra image"],
		[[request([a, { ...b, mimeType: "image/jpeg" }])], "changed MIME"],
		[[request([a, { ...b, sha256: a.sha256 }])], "changed image bytes"],
		[[{ request: 1, payloadImages: [] }], "missing payload callback"],
		[[{ request: 1, payloadImages: [[a, b], [a]] }], "loss in a later payload callback"],
		[[], "no requests"],
	])("rejects %s (%s)", (requests) => {
		expect(verifyRequestImages([a, b], requests)).toBe(false);
	});

	it("rejects duplicate loss even when aggregate existential hashes would match", () => {
		expect(verifyRequestImages([a, a], [request([a]), request([a], 2)])).toBe(false);
	});
});
