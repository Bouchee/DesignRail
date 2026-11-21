import { expect, test } from "bun:test";
import type { SessionEvent } from "@thinkrail/contracts";
import type { ArtifactTools } from "../extensions";
import { createArtifactEventMapper } from "./artifactEvents";

test("SDK artifact readers only see successful effects and their own session call arguments", () => {
	const reads: unknown[] = [];
	const tools: ArtifactTools = new Map([
		[
			"artifact",
			{
				presented: (args, details) => {
					reads.push({ args, details });
					return ["draft.html"];
				},
			},
		],
	]);
	const project = createArtifactEventMapper(() => tools);
	const start: SessionEvent = {
		type: "tool_execution_start",
		toolName: "artifact",
		toolCallId: "call",
		args: { path: "a" },
	};
	const end: SessionEvent = {
		type: "tool_execution_end",
		toolName: "artifact",
		toolCallId: "call",
		result: { details: { savedPath: "draft.html" } },
		isError: false,
	};
	project("first", start);
	project("second", { ...start, args: { path: "b" } });
	expect(
		project("first", { ...end, guardrail: { rule: "stop", stage: "output" } }),
	).not.toHaveProperty("presented");
	expect(project("second", end)).toMatchObject({ presented: ["draft.html"] });
	expect(reads).toEqual([{ args: { path: "b" }, details: { savedPath: "draft.html" } }]);
});

test("a visible SDK user message supplies the exact chat round timestamp", () => {
	const project = createArtifactEventMapper(() => new Map());
	expect(
		project("session", {
			type: "message_end",
			message: { role: "user", timestamp: 42, content: "Write the report." },
		}),
	).toEqual({ type: "round_start", at: 42 });
});
