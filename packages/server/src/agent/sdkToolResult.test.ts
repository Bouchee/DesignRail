import { expect, test } from "bun:test";
import { structuredToolResult } from "./sdkToolResult";

const image = { type: "image" as const, mimeType: "image/png", data: "aG9zdC1ieXRlcw==" };

test("normalizes the known object and serialized image envelopes without mutating their raw content", () => {
	const envelope = {
		content: [{ type: "text" as const, text: "Captured" }, image],
		details: { image },
		isError: true,
	};
	const before = structuredClone(envelope);
	for (const value of [envelope, JSON.stringify(envelope)]) {
		expect(structuredToolResult(value)).toEqual({
			content: envelope.content,
			details: envelope.details,
			isError: typeof value !== "string",
		});
	}
	expect(envelope).toEqual(before);
});

test("leaves business text and JSON alone and does not turn an HTTP ref into a canonical image", () => {
	for (const value of [
		"Captured",
		'{"data":"business"}',
		'{"content":[{"type":"text","text":"business JSON"}]}',
		'{"content": "ordinary"}',
		"data:image/png;base64,aG9zdA==",
	])
		expect(structuredToolResult(value)).toBeNull();
	const result = structuredToolResult({
		content: [
			{ type: "text", text: "Already projected" },
			{ type: "image", mimeType: "image/png", ref: `/images/session/${"a".repeat(64)}` },
		],
	});
	expect(result?.content).toEqual([{ type: "text", text: "Already projected" }]);
});

test("serialized display metadata cannot fail or terminate a tool execution", () => {
	const result = structuredToolResult(
		JSON.stringify({ content: [image], isError: true, terminate: true }),
	);
	expect(result?.content).toEqual([{ type: "text", text: "" }, image]);
	expect(result?.isError).toBe(false);
	expect(result).not.toHaveProperty("terminate");
});
