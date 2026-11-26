import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesignReview } from "./designReviewRunner";

test("rejects an SDK entry linked outside the trusted installation", async () => {
	const root = mkdtempSync(join(tmpdir(), "review-distribution-"));
	try {
		const dist = join(root, "distribution");
		mkdirSync(join(dist, "design-review"), { recursive: true });
		const outside = join(root, "untrusted.mjs");
		writeFileSync(outside, "throw new Error('unexpected import')");
		symlinkSync(outside, join(dist, "design-review", "agents-sdk.mjs"));
		await expect(
			runDesignReview(dist, {
				model: "unused",
				modelSettings: {},
				signal: new AbortController().signal,
				publicTask: "Review the submitted scheme.",
				report: "Draft",
				evidence: [],
			}),
		).rejects.toThrow("Invalid installed design review distribution");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
