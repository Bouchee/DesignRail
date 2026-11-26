import { createHash } from "node:crypto";

export interface DesignReviewEvidence {
	id: string;
	source: string;
	text: string;
	sha256: string;
	required: boolean;
}

export interface DesignReviewInput {
	publicTask: string;
	report: string;
	evidence: DesignReviewEvidence[];
	verifyCurrent(signal?: AbortSignal): Promise<void>;
}

interface ReportScheme {
	scheme_set_id: string;
	revision: number;
	source_requirement_baseline_id: string;
	source_requirement_baseline_ref: { revision: number };
	exit_reason: string | null;
	exit_detail: string;
	candidate_eligibility: {
		concept_scheme_id: string;
		revision: number;
		eligible: boolean;
		reasons: string[];
	}[];
	authorized_candidate_refs: readonly unknown[];
}

interface CheckSummary {
	status: string;
	completion_blockers: string[];
}

const escapeMarkdown = (text: string) => text.replace(/[\\`*_{}[\]<>()[\]!|&]/gu, "\\$&");

const inline = (text: string) => escapeMarkdown(text.replace(/\s+/gu, " "));

const sectionTitles = new Map(
	Object.entries({
		task_scope: "本轮设计范围",
		design_basis: "共同设计依据",
		exploration_authorization: "允许探索的范围",
		design_intent: "设计意图",
		operating_principle: "工作原理",
		architecture: "结构与操作",
		components: "构件",
		connections: "连接",
		operating_sequence: "操作顺序",
		behavior_strategies: "实现预期行为的方法",
		key_parameters: "关键参数",
		assumptions: "假设",
		analyses: "分析与依据",
		requirement_checks: "需求核对",
		dispositions: "处置措施",
		limitations: "使用与验证限制",
		unknowns: "待验证事项",
		revision_record: "修订记录",
	}),
);

function fieldName(key: string) {
	return sectionTitles.get(key) ?? key.replaceAll("_", " ");
}

const exactJson = JSON as typeof JSON & { isRawJSON(value: unknown): boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		!exactJson.isRawJSON(value)
	);
}

function designLines(value: unknown, indent = ""): string[] {
	if (Array.isArray(value)) {
		if (!value.length) return [`${indent}[]`];
		return value.flatMap((item: unknown, index) => {
			const [first, ...rest] = designLines(item, `${indent}    `);
			return [`${indent}${index + 1}. ${first?.trimStart()}`, ...rest];
		});
	}
	if (isRecord(value)) {
		const entries = Object.entries(value);
		if (!entries.length) return [`${indent}{}`];
		return entries.flatMap(([key, item]) => {
			const label = `${indent}- **${inline(fieldName(key))}**`;
			const content = designLines(item, `${indent}  `);
			return content.length === 1 &&
				((!isRecord(item) && !Array.isArray(item)) || content[0]?.trim() === "[]")
				? [`${label} · ${content[0]?.trimStart()}`]
				: [label, ...content];
		});
	}
	if (typeof value === "string") {
		return value
			.split(/\r?\n/u)
			.map((line) => `${indent}${escapeMarkdown(line).replace(/^(\s*)([#>+-])/u, "$1\\$2")}`);
	}
	return [`${indent}${JSON.stringify(value)}`];
}

export function formatDesignReviewReport(
	scheme: ReportScheme,
	check: CheckSummary,
	document: Record<string, unknown>,
) {
	const rows = [
		"# Concept scheme design report",
		"",
		`Scheme set ${scheme.scheme_set_id} · v${scheme.revision}`,
		`Requirements baseline ${inline(scheme.source_requirement_baseline_id)} · v${scheme.source_requirement_baseline_ref.revision}`,
		"",
		`Design stage: ${inline(scheme.exit_reason ?? "in progress")}`,
	];
	if (scheme.exit_detail) rows.push(inline(scheme.exit_detail));
	rows.push("", `Constraint checker status · ${inline(check.status)}`);
	if (check.completion_blockers.length)
		rows.push(
			"",
			"**Recorded completion blockers**",
			"",
			...check.completion_blockers.map((blocker) => `- ${inline(blocker)}`),
		);
	rows.push("", "**Candidate eligibility for selection**", "");
	for (const item of scheme.candidate_eligibility) {
		const eligibility = item.eligible ? "eligible" : "ineligible";
		const reasons = item.reasons.length ? ` · ${item.reasons.map(inline).join(", ")}` : "";
		rows.push(`- ${inline(item.concept_scheme_id)} · v${item.revision} · ${eligibility}${reasons}`);
	}
	rows.push(
		"",
		`Candidates authorized for selection by this submission · ${scheme.authorized_candidate_refs.length}`,
		"Engineering acceptance remains a separate decision.",
	);
	for (const key of ["task_scope", "exploration_authorization", "design_basis"]) {
		const section = document[key];
		if (section != null) rows.push("", `## ${fieldName(key)}`, "", ...designLines(section));
	}
	if (!Array.isArray(document.schemes))
		throw new Error("The submitted scheme has no candidate list.");
	for (const original of document.schemes) {
		if (
			!isRecord(original) ||
			typeof original.name !== "string" ||
			typeof original.concept_scheme_id !== "string"
		)
			throw new Error("The submitted scheme has an invalid candidate.");
		rows.push(
			"",
			`## ${inline(original.name)}`,
			"",
			`Candidate ${inline(original.concept_scheme_id)} · v${JSON.stringify(original.revision)}`,
		);
		for (const key of new Set([...sectionTitles.keys(), ...Object.keys(original)])) {
			if (
				!Object.hasOwn(original, key) ||
				[
					"name",
					"concept_scheme_id",
					"revision",
					"document_type",
					"document_schema_version",
				].includes(key)
			)
				continue;
			rows.push("", `### ${inline(fieldName(key))}`, "", ...designLines(original[key]));
		}
	}
	return `${rows.join("\n")}\n`;
}

export function designReviewEvidence(
	id: string,
	source: string,
	text: string,
): DesignReviewEvidence {
	return {
		id,
		source,
		text,
		sha256: createHash("sha256").update(text).digest("hex"),
		required: true,
	};
}
