import type { ModelResponse, StandardSchemaWithJSON } from "@openai/agents";
import {
	isPlanReviewOutput,
	PLAN_REVIEW_VERDICTS,
	type PlanReviewOutput,
	REVIEW_READING_ORDER_LIMIT,
} from "@thinkrail/contracts";

const schema = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: PLAN_REVIEW_VERDICTS },
		summary: { type: "string" },
		readingOrder: {
			type: "array",
			maxItems: REVIEW_READING_ORDER_LIMIT,
			items: {
				type: "object",
				properties: {
					path: { type: "string", minLength: 1 },
					why: { type: "string", minLength: 1 },
				},
				required: ["path", "why"],
				additionalProperties: false,
			},
		},
		findings: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string", minLength: 1 },
					body: { type: "string", minLength: 1 },
					kind: { type: "string", enum: ["inline", "diff", "file", "review"] },
					path: { type: "string" },
					startLine: { type: "integer", minimum: 1 },
					endLine: { type: "integer", minimum: 1 },
				},
				required: ["id", "body"],
				additionalProperties: false,
			},
		},
	},
	required: ["verdict", "findings"],
	additionalProperties: false,
};

export const planReviewOutput: StandardSchemaWithJSON<PlanReviewOutput> = {
	"~standard": {
		version: 1,
		vendor: "raildesign",
		validate: (value) =>
			isPlanReviewOutput(value)
				? { value }
				: { issues: [{ message: "Invalid Plan review output" }] },
		jsonSchema: { input: () => structuredClone(schema), output: () => structuredClone(schema) },
	},
};

export function assertCompletedPlanReviewResponse(
	response: ModelResponse | undefined,
	completion: { responseId: string | undefined; status?: unknown } | undefined,
): void {
	if (
		!response?.responseId ||
		completion?.responseId !== response.responseId ||
		completion.status !== "completed"
	)
		throw new Error("Plan review response did not complete");
	const messages = response.output.filter(
		(item): item is Extract<ModelResponse["output"][number], { role: "assistant" }> =>
			item.type === "message" && item.role === "assistant",
	);
	if (!messages.length || messages.some((item) => item.status !== "completed"))
		throw new Error("Plan review final message did not complete");
	if (messages.some((item) => item.content.some((part) => part.type === "refusal")))
		throw new Error("Plan review response contains a refusal");
}
