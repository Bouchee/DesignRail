import { expect, test } from "bun:test";
import { formatDesignReviewReport } from "./designReviewInput";

test("report preserves every candidate and the checker result in the submitted version", () => {
	const scheme = {
		scheme_set_id: "set-example",
		revision: 3,
		source_requirement_baseline_id: "baseline-example",
		source_requirement_baseline_ref: { revision: 2 },
		exit_reason: "external_dependency",
		exit_detail: "Wait for a measured load.",
		candidate_eligibility: [
			{
				concept_scheme_id: "candidate-a",
				revision: 1,
				eligible: false,
				reasons: ["[DC1]:unknown"],
			},
			{ concept_scheme_id: "candidate-b", revision: 2, eligible: true, reasons: [] },
		],
		authorized_candidate_refs: [],
		design_basis: { unknowns: [] },
		schemes: [
			{
				concept_scheme_id: "candidate-a",
				revision: 1,
				name: "Candidate A",
				operating_principle: "Principle A.",
				architecture: {
					components: [{ name: "Pressure plate", description: "Fit the plate before the seal." }],
					connections: [{ description: "Join by two pins." }],
					operating_sequence: ["Unlock first.", "Refit last."],
				},
				key_parameters: [
					{
						value: (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(
							"5.0000000000000001",
						),
						unit: "mm",
					},
				],
				analyses: [{ method: "Torque inspection", limitations: ["dry cycle only"] }],
				limitations: ["Accept the dry layout only."],
				dispositions: [{ action: "Measure the wet stiffness." }],
				requirement_checks: [],
				unknowns: [],
			},
			{
				name: "Second option",
				concept_scheme_id: "candidate-b",
				revision: 2,
				architecture: { components: [{ name: "Leaf spring" }] },
				limitations: ["No thermal proof"],
			},
		],
	};
	const check = {
		status: "incomplete",
		completion_blockers: ["analysis_depth_incomplete"],
	};
	const document = {
		...scheme,
		source: { run_id: "omit-internal-id" },
		task_scope: { message: "Compare layouts." },
	};
	const report = formatDesignReviewReport(scheme, check, document);
	const overview = report.slice(0, report.indexOf("\n## "));
	const body = report.slice(report.indexOf("\n## "));
	for (const entry of [
		"Compare layouts.",
		"5.0000000000000001",
		"Pressure plate",
		"Fit the plate before the seal.",
		"Join by two pins.",
		"Unlock first.",
		"Refit last.",
		"Torque inspection",
		"dry cycle only",
		"Accept the dry layout only.",
		"Measure the wet stiffness.",
		"Second option",
		"Leaf spring",
		"No thermal proof",
	])
		expect(body).toContain(entry);
	expect(body.indexOf("Unlock first.")).toBeLessThan(body.indexOf("Refit last."));
	expect(report).not.toContain("omit-internal-id");
	expect(body).toContain("Candidate A");
	expect(overview).toContain("Constraint checker status · incomplete");
	expect(overview).toContain("analysis\\_depth\\_incomplete");
	expect(overview).toContain("candidate-a · v1 · ineligible · \\[DC1\\]:unknown");
	expect(overview).toContain("candidate-b · v2 · eligible\n");
	expect(overview).toContain("Candidates authorized for selection by this submission · 0");
	expect(overview).toContain("Engineering acceptance remains a separate decision.");
	expect(
		formatDesignReviewReport(scheme, { status: "reviewable", completion_blockers: [] }, document),
	).not.toContain("Recorded completion blockers");
});
