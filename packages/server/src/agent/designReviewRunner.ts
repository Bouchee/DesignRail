import { lstatSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as sdk from "@openai/agents";
import { z } from "zod";
import type { DesignReviewInput } from "./designReviewInput";

const evidenceReference = z.object({ id: z.string(), source: z.string(), sha256: z.string() });
const reviewResult = z.object({
	status: z.enum(["pass", "revise", "incomplete"]),
	summary: z.string(),
	findings: z.array(
		z.object({
			kind: z.enum(["error", "uncertain"]),
			location: z.string(),
			basis: z.string(),
			difference: z.string(),
			action: z.string(),
		}),
	),
	report: z.string(),
	reportDigest: z.string(),
	evidence: z.array(evidenceReference),
});

export type DesignReviewFinding = z.infer<typeof reviewResult>["findings"][number];

type ReviewOptions = Pick<DesignReviewInput, "publicTask" | "report" | "evidence"> & {
	model: sdk.Agent["model"];
	modelSettings: sdk.ModelSettings;
	signal: AbortSignal;
};

export async function runDesignReview(distributionRoot: string, options: ReviewOptions) {
	if (!lstatSync(distributionRoot).isDirectory())
		throw new Error("Invalid installed design review root.");
	const root = realpathSync(distributionRoot);
	for (const relative of [
		"design-review/agents-sdk.mjs",
		"design-review/core.mjs",
		"design-review/review.mjs",
		"design-review/review-prompt.txt",
		"distribution/active-skills.json",
	]) {
		const path = join(root, relative);
		if (realpathSync(path) !== path || !statSync(path).isFile())
			throw new Error("Invalid installed design review distribution.");
	}
	const entry = await import(pathToFileURL(join(root, "design-review/agents-sdk.mjs")).href);
	const result = reviewResult.parse(await entry.reviewWithAgentsSdk({ ...options, sdk }));
	if (result.report !== options.report || (result.findings.length > 0 && result.status === "pass"))
		throw new Error("The independent review does not approve the submitted report.");
	return result;
}
