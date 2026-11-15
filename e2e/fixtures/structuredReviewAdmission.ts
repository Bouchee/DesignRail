import { installHostReviewAdmission } from "@thinkrail/server/structured-review-test-fixtures";

if (
	process.env.RAILDESIGN_E2E_LIVE !== "1" ||
	process.env.RAILDESIGN_E2E_LIVE_RUNNER_AUTHORIZED !== "1"
)
	throw new Error("Structured review admission requires the protected public live runner");
const ledgerPath = process.env.RAILDESIGN_STRUCTURED_REVIEW_LEDGER;
const freezePath = process.env.RAILDESIGN_STRUCTURED_REVIEW_INTEGRATION_FREEZE;
const compatibilityPath = process.env.RAILDESIGN_STRUCTURED_REVIEW_FREEZE;
if (!ledgerPath || !freezePath || !compatibilityPath)
	throw new Error("Missing approved review evidence paths");
const cleanup = await installHostReviewAdmission({ ledgerPath, freezePath, compatibilityPath });
const stop = () => {
	void cleanup();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
