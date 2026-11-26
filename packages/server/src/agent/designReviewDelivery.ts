import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { seedArtifactsDir } from "@thinkrail/shared/artifactsDir";
import { WORKSPACE_CONTEXT_DIR } from "@thinkrail/shared/paths";

function sha256(value: string | Uint8Array): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deliveryPaths(attemptId: string) {
	const path = `${WORKSPACE_CONTEXT_DIR}/design-reviews/${attemptId}`;
	return { reportPath: `${path}/delivery.md`, receiptPath: `${path}/receipt.json` };
}

export function deliverDesignReview(
	cwd: string,
	attemptId: string,
	report: string,
	reportDigest: string,
	receipt: unknown,
) {
	if (sha256(report) !== reportDigest)
		throw new Error("The review result is not bound to this report.");
	const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
	const context = seedArtifactsDir(realpathSync(cwd));
	const directory = join(context, "design-reviews");
	if (!lstatSync(directory, { throwIfNoEntry: false })) mkdirSync(directory, { recursive: true });
	if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory)
		throw new Error("The independent review folder must be a real directory.");
	const pending = mkdtempSync(join(directory, ".review-"));
	const target = join(directory, attemptId);
	try {
		writeFileSync(join(pending, "delivery.md"), report, { flag: "wx" });
		writeFileSync(join(pending, "receipt.json"), receiptText, {
			flag: "wx",
		});
		renameSync(pending, target);
	} finally {
		rmSync(pending, { recursive: true, force: true });
	}
	return { ...deliveryPaths(attemptId), reportDigest, receiptDigest: sha256(receiptText) };
}

export function verifyDesignReviewDelivery(
	cwd: string,
	delivery: {
		id: string;
		reportPath?: string | undefined;
		receiptPath?: string | undefined;
		reportDigest?: string | undefined;
		receiptDigest?: string | undefined;
	},
): boolean {
	const { reportPath, receiptPath } = deliveryPaths(delivery.id);
	if (delivery.reportPath !== reportPath || delivery.receiptPath !== receiptPath) return false;
	try {
		const root = realpathSync(cwd);
		const matches = (relative: string, digest: string | undefined) => {
			const path = join(root, relative);
			return (
				!!digest &&
				realpathSync(path) === path &&
				lstatSync(path).isFile() &&
				sha256(readFileSync(path)) === digest
			);
		};
		return (
			matches(reportPath, delivery.reportDigest) && matches(receiptPath, delivery.receiptDigest)
		);
	} catch {
		return false;
	}
}
