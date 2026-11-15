import { expect, test } from "@playwright/test";
import { runReviewCompatibility } from "@thinkrail/server/structured-review-test-fixtures";
import { assertLivePlaywrightRunner } from "./agentRunPlan";
import { E2E_DATA_DIR } from "./fixtures/paths";
import { isLiveAgentE2e } from "./fixtures/sdkAgent";

test("selected Plan review schema completes nonstream then stream @agent", async () => {
	const testInfo = test.info();
	test.setTimeout(95_000);
	expect(testInfo.retry).toBe(0);
	expect(testInfo.project.retries).toBe(0);
	expect(isLiveAgentE2e()).toBe(true);
	assertLivePlaywrightRunner(process.env, process.argv);
	const ledgerPath = process.env.RAILDESIGN_STRUCTURED_REVIEW_LEDGER;
	const freezePath = process.env.RAILDESIGN_STRUCTURED_REVIEW_FREEZE;
	if (!ledgerPath || !freezePath)
		throw new Error("Supply the approved request ledger and frozen source manifest");
	const previous = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = E2E_DATA_DIR;
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		const outputs = await runReviewCompatibility({
			ledgerPath,
			freezePath,
			signal: controller.signal,
		});
		expect(outputs).toHaveLength(2);
		expect(outputs[1]).toEqual(outputs[0]);
	} finally {
		controller.abort();
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		if (previous === undefined) delete process.env.THINKRAIL_DATA_DIR;
		else process.env.THINKRAIL_DATA_DIR = previous;
	}
});
