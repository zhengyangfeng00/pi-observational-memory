import { createHash } from "node:crypto";

export function imageFingerprint(image) {
	return { mimeType: image.mimeType, sha256: createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex") };
}

/** Preserve payload traversal order and duplicate image occurrences. */
export function collectPayloadImages(payload) {
	const images = [];
	function inspect(value) {
		if (typeof value === "string" && value.startsWith("data:image/")) {
			const match = /^data:([^;]+);base64,(.*)$/.exec(value);
			if (match) images.push(imageFingerprint({ mimeType: match[1], data: match[2] }));
		} else if (Array.isArray(value)) value.forEach(inspect);
		else if (value && typeof value === "object") Object.values(value).forEach(inspect);
	}
	inspect(payload);
	return images;
}

/** Every request needs captured payloads, each with the exact ordered image list. */
export function verifyRequestImages(expected, wireRequests) {
	return expected.length > 0 && wireRequests.length > 0 && wireRequests.every((request) =>
		request.payloadImages.length > 0 && request.payloadImages.every((images) =>
			images.length === expected.length && images.every((image, index) =>
				image.mimeType === expected[index].mimeType && image.sha256 === expected[index].sha256)));
}
