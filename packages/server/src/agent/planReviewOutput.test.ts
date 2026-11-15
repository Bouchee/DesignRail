import { expect, test } from "bun:test";
import { Agent, type ModelResponse, Runner, Usage } from "@openai/agents";
import { assistantMessage, modelResponse, ScriptedModel } from "@openai/agents/testing";
import { isPlanReviewOutput } from "@thinkrail/contracts";
import { assertCompletedPlanReviewResponse, planReviewOutput } from "./planReviewOutput";

test("fixed adapter advertises the same natural DTO for input and output", () => {
	const conversion = planReviewOutput["~standard"].jsonSchema;
	expect(conversion.input({ target: "draft-2020-12" })).toEqual(
		conversion.output({ target: "draft-2020-12" }),
	);
	expect(conversion.input({ target: "draft-2020-12" }).required).toEqual(["verdict", "findings"]);
	const value = { verdict: "approve" as const, findings: [] };
	expect(planReviewOutput["~standard"].validate(value)).toEqual({ value });
	expect(value).toEqual({ verdict: "approve", findings: [] });
});

test("public SDK converts natural optional properties to strict nullable fields and normalizes them before validation", async () => {
	const model = new ScriptedModel([
		modelResponse([
			assistantMessage(
				JSON.stringify({
					verdict: "request_changes",
					summary: null,
					readingOrder: null,
					findings: [
						{ id: "local", body: "Fix", kind: null, path: null, startLine: null, endLine: null },
					],
				}),
			),
		]),
	]);
	const agent = new Agent({ name: "Fixed review", model, outputType: planReviewOutput });
	const result = await new Runner({ tracingDisabled: true }).run(agent, "fixture", { maxTurns: 1 });
	expect(result.finalOutput).toEqual({
		verdict: "request_changes",
		findings: [{ id: "local", body: "Fix" }],
	});
	const output = model.calls[0]?.request.outputType;
	expect(output).toMatchObject({
		type: "json_schema",
		strict: true,
		schema: {
			additionalProperties: false,
			required: ["verdict", "summary", "readingOrder", "findings"],
			properties: { summary: { anyOf: [{ type: "string" }, { type: "null" }] } },
		},
	});
});

test("actual SDK final parsing rejects malformed JSON and schema-valid domain failures in both modes", async () => {
	for (const stream of [false, true]) {
		for (const text of [
			"{",
			JSON.stringify({ verdict: "maybe", findings: [] }),
			JSON.stringify({ verdict: "request_changes", findings: [] }),
			JSON.stringify({ verdict: "approve", findings: [], itemId: "forged" }),
			JSON.stringify({
				verdict: "request_changes",
				findings: [{ id: "x", body: "Fix", path: "a", startLine: 3, endLine: 1 }],
			}),
		]) {
			const model = new ScriptedModel([modelResponse([assistantMessage(text)])]);
			const run = async () => {
				const runner = new Runner({ tracingDisabled: true });
				const agent = new Agent({ name: "Fixed", model, outputType: planReviewOutput });
				if (!stream) return (await runner.run(agent, "fixture", { maxTurns: 1 })).finalOutput;
				const result = await runner.run(agent, "fixture", { stream: true, maxTurns: 1 });
				const settled = result.completed.catch((error: unknown) => error);
				try {
					for await (const _event of result) {
					}
				} finally {
					await settled;
				}
				await result.completed;
				return result.finalOutput;
			};
			await expect(run()).rejects.toThrow();
			expect(model.calls).toHaveLength(1);
		}
	}
});

test("raw JSON-schema output is a control: SDK parsing alone accepts a semantic failure", async () => {
	const model = new ScriptedModel([
		modelResponse([assistantMessage('{"verdict":"request_changes","findings":[]}')]),
	]);
	const agent = new Agent({
		name: "Raw control",
		model,
		outputType: {
			type: "json_schema",
			name: "output",
			strict: true,
			schema: { type: "object", properties: {}, required: [], additionalProperties: false },
		},
	});
	const result = await new Runner({ tracingDisabled: true }).run(agent, "fixture", { maxTurns: 1 });
	expect(result.finalOutput).toEqual({ verdict: "request_changes", findings: [] });
	expect(isPlanReviewOutput(result.finalOutput)).toBe(false);
});

test("positive completion check rejects missing/mismatched identity, nonterminal messages and mixed refusal", () => {
	const response: ModelResponse = {
		output: [assistantMessage('{"verdict":"approve","findings":[]}')],
		usage: new Usage(),
		responseId: "response",
	};
	assertCompletedPlanReviewResponse(response, { responseId: "response", status: "completed" });
	for (const status of [undefined, "failed", "incomplete", "cancelled", "queued", "in_progress"])
		expect(() =>
			assertCompletedPlanReviewResponse(response, { responseId: "response", status }),
		).toThrow();
	expect(() =>
		assertCompletedPlanReviewResponse(response, { responseId: "other", status: "completed" }),
	).toThrow();
	for (const status of ["incomplete", "in_progress"] as const) {
		const incomplete = structuredClone(response);
		const message = incomplete.output[0];
		if (message?.type !== "message" || message.role !== "assistant")
			throw new Error("Missing fixture message");
		message.status = status;
		expect(() =>
			assertCompletedPlanReviewResponse(incomplete, {
				responseId: "response",
				status: "completed",
			}),
		).toThrow();
	}
	const message = response.output[0];
	if (message?.type !== "message" || message.role !== "assistant")
		throw new Error("Missing fixture message");
	message.content.push({ type: "refusal", refusal: "Declined" });
	expect(() =>
		assertCompletedPlanReviewResponse(response, { responseId: "response", status: "completed" }),
	).toThrow("refusal");
});
