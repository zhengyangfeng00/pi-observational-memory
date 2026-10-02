import type { Context, ImageContent, Model } from "@earendil-works/pi-ai";

/** Conservative local allowance, not a provider's exact vision-token count. */
export const IMAGE_TOKEN_RESERVE = 16_384;
export const OBSERVER_REQUEST_MARGIN = 4_096;

function imageDimensions(image: ImageContent): [number, number] | undefined {
	const bytes = Buffer.from(image.data, "base64");
	if (image.mimeType === "image/png" && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
	}
	if (image.mimeType === "image/gif" && bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
	if (image.mimeType === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let pos = 2;
		while (pos + 4 <= bytes.length) {
			if (bytes[pos++] !== 0xff) return undefined;
			while (bytes[pos] === 0xff) pos++;
			const marker = bytes[pos++];
			if (pos + 2 > bytes.length) return undefined;
			const size = bytes.readUInt16BE(pos);
			if (size < 2 || pos + size > bytes.length) return undefined;
			if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 7) return [bytes.readUInt16BE(pos + 5), bytes.readUInt16BE(pos + 3)];
			pos += size;
		}
	}
	if (image.mimeType === "image/webp" && bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
		const format = bytes.toString("ascii", 12, 16);
		if (format === "VP8X" && bytes.length >= 30) return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
		if (format === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
		if (format === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
			const bits = bytes.readUInt32LE(21);
			return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
		}
	}
	return undefined;
}

export function isSupportedImage(value: unknown): value is ImageContent {
	if (!value || typeof value !== "object") return false;
	const image = value as ImageContent;
	if (!(image.type === "image" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)
		&& typeof image.data === "string" && image.data.length > 0
		&& image.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(image.data))) return false;
	const dimensions = imageDimensions(image);
	return dimensions !== undefined && dimensions.every((size) => size > 0 && size <= 65_535);
}

export function estimateImageTokens(image: ImageContent): number {
	// Charge the encoded payload as well as a large per-image vision reserve.
	// Do not use the host's flat 1200-token image heuristic for worker budgets.
	const [width, height] = imageDimensions(image) ?? [65_535, 65_535];
	return IMAGE_TOKEN_RESERVE + Math.ceil(image.data.length / 4)
		+ 4 * Math.ceil(width / 32) * Math.ceil(height / 32);
}

/** Check every multimodal request, including loop continuations and fallback. */
export function validateObserverRequest(model: Model<any>, context: Context, outputTokens: number): void {
	let imageCount = 0;
	let inputTokens = OBSERVER_REQUEST_MARGIN;
	for (const message of context.messages) {
		if (typeof message.content === "string") inputTokens += Buffer.byteLength(message.content, "utf8");
		else for (const block of message.content) {
			if (block.type === "image") {
				if (!isSupportedImage(block)) throw new Error("unsupported_source: invalid observer image");
				imageCount++;
				inputTokens += estimateImageTokens(block);
			} else {
				// One token per UTF-8 byte bounds the local text estimate, including
				// tool arguments and non-ASCII text, instead of chars/4.
				inputTokens += Buffer.byteLength(JSON.stringify(block), "utf8");
			}
		}
	}
	if (!imageCount) return; // Existing text-only worker behavior is unchanged.
	if (!model.input?.includes("image")) throw new Error("unsupported_model: observer model does not accept images");
	if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) throw new Error("image_budget: observer model has no known context window");
	inputTokens += Buffer.byteLength(context.systemPrompt ?? "", "utf8");
	inputTokens += Buffer.byteLength(JSON.stringify(context.tools ?? []), "utf8");
	if (inputTokens + outputTokens > model.contextWindow) throw new Error("image_budget: complete observer request exceeds context allowance");
	const limits = model.inputLimits;
	if (limits?.images?.maxPerRequest !== undefined && imageCount > limits.images.maxPerRequest) throw new Error("image_budget: too many images per request");
	for (const message of context.messages) {
		const count = Array.isArray(message.content) ? message.content.filter((block) => block.type === "image").length : 0;
		if (limits?.images?.maxPerMessage !== undefined && count > limits.images.maxPerMessage) throw new Error("image_budget: too many images per message");
	}
	if (limits?.maxRequestBytes !== undefined && Buffer.byteLength(JSON.stringify(context), "utf8") + OBSERVER_REQUEST_MARGIN > limits.maxRequestBytes) {
		throw new Error("image_budget: observer request exceeds byte allowance");
	}
}
