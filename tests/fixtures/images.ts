const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5c8AAAAASUVORK5CYII=";

/** A small PNG payload whose header declares the given pixel dimensions. */
export function pngWithDimensions(width: number, height: number) {
	const bytes = Buffer.from(TINY_PNG, "base64");
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(height, 20);
	return { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") };
}
