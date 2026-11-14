import type { ImageContent, ToolResultMessage } from "@thinkrail/contracts";
import { parseToolResultContent } from "@thinkrail/extension-api/server";

export interface StructuredToolResult {
	content: ToolResultMessage["content"];
	details?: unknown;
	isError: boolean;
	terminate?: boolean;
}

export function structuredToolResult(value: unknown): StructuredToolResult | null {
	let result = value;
	if (typeof result === "string") {
		try {
			result = JSON.parse(result);
		} catch {
			return null;
		}
		if (
			!result ||
			typeof result !== "object" ||
			!("content" in result) ||
			!Array.isArray(result.content) ||
			!result.content.some(
				(block: unknown) =>
					typeof block === "object" &&
					block !== null &&
					"type" in block &&
					block.type === "image" &&
					"data" in block &&
					typeof block.data === "string",
			)
		)
			return null;
	}
	if (
		!result ||
		typeof result !== "object" ||
		!("content" in result) ||
		!Array.isArray(result.content)
	)
		return null;
	const parsed = parseToolResultContent(result);
	return {
		content: [
			{ type: "text", text: parsed.text },
			...parsed.images.filter((image): image is ImageContent => "data" in image),
		],
		...("details" in result ? { details: result.details } : {}),
		isError: typeof value !== "string" && "isError" in result && result.isError === true,
		...(typeof value !== "string" && "terminate" in result && result.terminate === true
			? { terminate: true }
			: {}),
	};
}
