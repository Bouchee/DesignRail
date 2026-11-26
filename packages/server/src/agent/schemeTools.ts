import { createHash } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { tool } from "@openai/agents";
import { z } from "zod";
import { readFile, resolveWorktreeFile } from "../fs";
import {
	type DesignReviewInput,
	designReviewEvidence,
	formatDesignReviewReport,
} from "./designReviewInput";
import { requirementsSkill } from "./requirementsTools";
import type { WorkflowHost, WorkflowReview } from "./workflowHost";

export const schemeSkill = "scheme-generation-workflow-host";
const exporterSkill = "json-exporter";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const sessionId = z.string().regex(/^session-[a-f0-9]{16}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const receipt = z.strictObject({
	artifact_type: z.enum(["design_requirement_baseline", "concept_scheme_set"]),
	artifact_id: id,
	revision,
	schema_version: z.literal("2.0"),
	producer_skill: z.enum([requirementsSkill, schemeSkill]),
	content_digest: digest,
	committed: z.literal(true),
});
const upstream = z.strictObject({
	sessionId,
	baselineId: id,
	receipt,
});
const candidateRef = z.strictObject({ concept_scheme_id: id, revision, content_digest: digest });
const stagedProgress = z.object({
	digest,
	missing: z.array(z.string()),
	candidates: z.array(z.object({ local_key: id, missing: z.array(z.string()) })),
});
const boundSubmission = z.looseObject({ draft_binding: digest });
const stagedSubmission = z.strictObject({ draft_binding: digest, staged_digest: digest });
const pending = z.strictObject({
	digest,
	candidates: z.array(candidateRef).min(1),
	messageId: z.string().min(1).optional(),
});
export const schemeBindingSchema = z.strictObject({
	sessionId,
	runId: id,
	revision,
	pointerSha256: sha256,
	upstream,
	state: z.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("draft"),
			draftBinding: digest,
			staged: stagedProgress.optional(),
		}),
		z.strictObject({ kind: z.literal("pending"), pending }),
		z.strictObject({
			kind: z.literal("committed"),
			receipt,
			documentFingerprint: sha256,
			presentationDigest: digest,
		}),
	]),
});
export type SchemeBinding = z.infer<typeof schemeBindingSchema>;

const requirementsPair = z.looseObject({
	document: z.looseObject({
		document_type: z.literal("design_requirement_baseline"),
		document_schema_version: z.literal("2.0"),
		export_id: id,
		baseline: z.looseObject({ baseline_id: id, version: revision }),
		requirements: z.array(
			z.looseObject({
				requirement_id: id,
				status: z.string(),
				definition: z.looseObject({
					content_role: z.string(),
					statement: z.string(),
					verification: z.looseObject({ criterion: z.string().nullable() }),
				}),
			}),
		),
	}),
	receipt,
});
const resultSchema = z.looseObject({
	ok: z.boolean(),
	reason: z.string().optional(),
	session_id: sessionId.optional(),
	run_id: id.optional(),
	revision: revision.optional(),
});
type SchemeResult = z.infer<typeof resultSchema>;
const successfulResult = resultSchema.extend({
	ok: z.literal(true),
	session_id: sessionId,
	run_id: id,
	revision,
});
const storedReference = z.looseObject({ path: z.string(), sha256 });
const reference = storedReference.extend({ bytes: revision });
const page = z.looseObject({
	ok: z.literal(true),
	session_id: sessionId,
	text: z.string(),
	offset: revision,
	next_offset: revision,
	eof: z.boolean(),
	bytes: revision,
	sha256,
});
const unknown = z.looseObject({ unknown_id: id, statement: z.string(), next_action: z.string() });
const candidate = z.looseObject({
	concept_scheme_id: id,
	revision,
	name: z.string(),
	operating_principle: z.string(),
	unknowns: z.array(unknown),
	requirement_checks: z.array(
		z.looseObject({
			requirement_ref: id,
			target_ref: z.string(),
			status: z.string(),
			rationale: z.string(),
		}),
	),
});
const design = z.looseObject({
	document_type: z.literal("concept_scheme_set"),
	document_schema_version: z.literal("2.0"),
	scheme_set_id: z.string().regex(/^set-[a-f0-9]{32}$/),
	revision,
	mode: z.literal("formal"),
	source: z.looseObject({ producer_skill: z.literal(schemeSkill), run_id: id }),
	source_requirement_baseline_id: id,
	source_requirement_baseline_ref: receipt,
	schemes: z.array(candidate).min(1),
	design_basis: z.looseObject({
		unknowns: z.array(unknown),
		functions: z.array(z.looseObject({ source_requirement_ids: z.array(id) })),
		direct_constraints: z.array(z.looseObject({ source_requirement_ids: z.array(id) })),
	}),
	exit_reason: z.string().nullable(),
	exit_detail: z.string(),
});
const presentation = z.looseObject({
	presentation_digest: digest,
	revision,
	candidate_refs: z.array(candidateRef).min(1),
	design,
});
const checkSummary = z.looseObject({
	status: z.enum(["reviewable", "incomplete"]),
	completion_blockers: z.array(z.string()),
});
const reviewPair = z.looseObject({
	document: design.extend({
		input_sources: z.array(z.looseObject({ text: z.string(), sha256 })),
		task_scope: z.looseObject({ message: z.string() }),
		confirmation: z.looseObject({
			purpose: z.literal("review"),
			message_text: z.string(),
			presentation_digest: digest,
			candidate_refs: z.array(candidateRef),
		}),
		candidate_eligibility: z.array(
			z.strictObject({
				concept_scheme_id: id,
				revision,
				eligible: z.boolean(),
				reasons: z.array(z.string()),
			}),
		),
		authorized_candidate_refs: z.array(candidateRef).length(0),
	}),
	receipt,
});
const reviewSnapshot = z.looseObject({
	format: z.literal(3),
	session_id: sessionId,
	run_id: id,
	revision,
	context_ref: z.null(),
	pair_ref: storedReference,
	presentation_ref: storedReference,
	baseline_ref: storedReference,
	tools: z.record(z.string(), storedReference),
});
const reviewToolKind = z.enum(["tools", "calculations", "knowledge"]);
type ReviewViewKind =
	| "snapshots"
	| "pairs"
	| "presentations"
	| "baselines"
	| z.infer<typeof reviewToolKind>;
const viewLimit = 4 * 1024 * 1024;
const object = z.looseObject({});
const exactJson = JSON as typeof JSON & {
	parse(
		source: string,
		revive: (key: string, value: unknown, context?: { source: string }) => unknown,
	): unknown;
	rawJSON(source: string): unknown;
	isRawJSON(value: unknown): boolean;
};

function parseWithExactNumbers(raw: string) {
	return exactJson.parse(raw, (_key: string, value: unknown, context?: { source: string }) =>
		typeof value === "number" && context ? exactJson.rawJSON(context.source) : value,
	);
}

function sha(value: string | Uint8Array) {
	return createHash("sha256").update(value).digest("hex");
}

function documentFingerprint(value: unknown) {
	return sha(
		JSON.stringify(value, (_key, item: unknown) => {
			if (!item || typeof item !== "object" || Array.isArray(item) || exactJson.isRawJSON(item))
				return item;
			const record = object.parse(item);
			return Object.fromEntries(
				Object.keys(record)
					.sort()
					.map((key) => [key, record[key]]),
			);
		}),
	);
}

function normalize(text: string) {
	return text
		.normalize("NFKC")
		.trim()
		.replace(/[.!。！]+$/u, "")
		.trim();
}

const chineseStart =
	/^(?:(?:请(?:帮我)?|现在)\s*)?(?:(?:按|基于|依据)(?:当前)?已确认的?(?:需求(?:基线)?|基线)[,，\s]*)?(?:正式)?生成(一个|一套|一份|[1-9]\d*个)?(?:正式)?(?:概念)?(?:设计)?方案(?:[,:，：][\s\S]+)?$/u;
const englishStart =
	/^(?:please )?(?:generate|start|create) (a|one|\d+) (?:formal )?(?:concept )?(?:schemes?|designs?)(?: from (?:the )?(?:current )?confirmed (?:requirements|baseline))?$/iu;

export function requestedCandidateCount(text: string) {
	const normalized = normalize(text);
	const chinese = chineseStart.exec(normalized)?.[1];
	const english = englishStart.exec(normalized)?.[1];
	const count =
		chinese?.startsWith("一") || /^(?:a|one)$/iu.test(english ?? "")
			? 1
			: chinese
				? Number(chinese.slice(0, -1))
				: english
					? Number(english)
					: undefined;
	if (count !== undefined && (!Number.isSafeInteger(count) || count < 1))
		throw new Error("The requested candidate count is invalid.");
	return count;
}

function requestsUpdatedBaseline(text: string) {
	const normalized = normalize(text);
	return (
		/^(?:(?:请(?:帮我)?|现在)\s*)?(?:按|依据|基于)(?:新版|新版本|更新后)的?需求基线[,，\s]*(?:修订|修改|调整)/u.test(
			normalized,
		) ||
		/^(?:please )?(?:revise|update) (?:the )?(?:current )?(?:concept )?scheme (?:against|from) (?:the )?updated (?:requirements )?baseline(?::[\s\S]+)?$/iu.test(
			normalized,
		)
	);
}

export function schemeUserIntent(text: string) {
	const value = normalize(text);
	if (chineseStart.test(value) || englishStart.test(value)) return "start";
	if (
		/^(?:(?:请(?:帮我)?|现在)\s*)?(?:(?:按|依据|基于)(?:当前|新版|新版本|更新后)的?需求基线[,，\s]*)?(?:修订|修改|调整)(?:当前)?(?:展示的)?(?:概念|设计)?方案(?:[,:，：][\s\S]+)?$/u.test(
			value,
		) ||
		/^(?:please )?(?:revise|update) (?:the )?(?:current )?(?:concept )?scheme(?: (?:against|from) (?:the )?updated (?:requirements )?baseline)?(?::[\s\S]+)?$/iu.test(
			value,
		)
	)
		return "revise";
	if (
		/^(?:(?:请|现在)\s*)?继续(?:正式)?(?:方案生成|生成当前方案)(?::[^?？!！\n]+)?$/u.test(value) ||
		/^(?:please )?continue (?:the )?(?:current )?(?:concept )?scheme generation(?::[^?？!！\n]+)?$/iu.test(
			value,
		)
	)
		return "continue";
	if (
		/^(?:我)?确认(?:当前|本次)?展示的(?:概念)?方案用于审阅$/u.test(value) ||
		/^(?:i )?confirm (?:the )?(?:current )?displayed (?:concept )?scheme(?: set)? for review$/iu.test(
			value,
		)
	)
		return "review";
	if (
		/^(?:请)?重试当前方案的独立评审$/u.test(value) ||
		/^(?:please )?retry independent review of (?:the )?current scheme$/iu.test(value)
	)
		return "retry_review";
	if (
		/^(?:请)?导出(?:当前|刚才)?(?:已审阅|已确认)?(?:正式)?方案集(?:的)?(?:\s*json(?:文件)?)?$/iu.test(
			value,
		) ||
		/^(?:please )?export (?:the )?(?:current )?(?:reviewed|committed) (?:concept )?scheme set(?: as json)?$/iu.test(
			value,
		)
	)
		return "export";
	if (
		/^(?:请)?(?:再|重新)展示(?:当前)?(?:待审阅的)?(?:概念)?方案(?:及来源)?$/u.test(value) ||
		/^(?:please )?(?:show (?:the )?(?:current )?(?:concept )?scheme again|redisplay (?:the )?(?:current )?(?:concept )?scheme)$/iu.test(
			value,
		)
	)
		return "redisplay";
	return undefined;
}

const inline = (text: string) =>
	text.replace(/\s+/gu, " ").replace(/[\\`*_{}[\]<>()[\]!|&]/gu, "\\$&");

function renderScheme(show: z.infer<typeof presentation>, base: z.infer<typeof upstream>) {
	const sources = new Set([
		...show.design.design_basis.functions.flatMap((item) => item.source_requirement_ids),
		...show.design.design_basis.direct_constraints.flatMap((item) => item.source_requirement_ids),
		...show.design.schemes.flatMap((item) =>
			item.requirement_checks.map((check) => check.requirement_ref),
		),
	]);
	const rows = [
		`### Concept scheme review · v${show.revision}`,
		"",
		`Reference: \`${show.presentation_digest}\``,
		`Requirements baseline: \`${base.baselineId}\` · v${base.receipt.revision} · \`${base.receipt.content_digest}\``,
		`Source requirements: ${[...sources].map((source) => `\`${source}\``).join(", ")}`,
		"",
		`Stage: ${inline(show.design.exit_reason ?? "in progress")}${show.design.exit_detail ? ` · ${inline(show.design.exit_detail)}` : ""}`,
	];
	for (const item of show.design.schemes) {
		rows.push("", `- **${inline(item.name)}** · \`${item.concept_scheme_id}\` · v${item.revision}`);
		rows.push(`  - ${inline(item.operating_principle)}`);
		for (const check of item.requirement_checks)
			rows.push(
				`  - Requirement \`${check.requirement_ref}\` · ${inline(check.status)} · ${inline(check.rationale)}`,
			);
		for (const unknown of item.unknowns)
			rows.push(
				`  - Unknown \`${unknown.unknown_id}\` · ${inline(unknown.statement)} · ${inline(unknown.next_action)}`,
			);
	}
	for (const item of show.design.design_basis.unknowns)
		rows.push(
			`- Unknown \`${item.unknown_id}\` · ${inline(item.statement)} · ${inline(item.next_action)}`,
		);
	rows.push(
		"",
		"Reply “我确认当前展示的方案用于审阅。” or “I confirm the displayed concept scheme set for review.” to accept the displayed set for review.",
	);
	return rows.join("\n");
}

const firstStageInstruction =
	"Immediately call scheme_stage once with candidate_key null and fields_json containing only functions. " +
	"Use the actual confirmed design_goal IDs for the root function with parent_ref null. Focus on that field now; defer planning the rest of the design until after the tool returns.";

const fieldAdvice: Record<string, string> = {
	functions:
		"Bind the confirmed design_goal IDs to one root function with parent_ref null. All other functions have a parent.",
	expected_behaviors:
		"A baseline_target uses exact verification.criterion (including null) and applicable_candidate_keys: []. A known_condition is operating context only and cannot source a baseline_target. Model candidate-specific behavior as intermediate with its local key.",
	direct_constraints:
		"Use the confirmed hard constraints. Copy direct_constraint_statement to statement and conditions.criterion. A known_condition is operating context and cannot source a direct constraint.",
	name: "Use the candidate's stable local_key for every part of this candidate.",
	operating_principle: "Describe the proposed mechanism briefly.",
	architecture: "Keep the configuration consistent with the staged operating principle.",
	key_parameters:
		"A baseline-backed fact requires the exact scalar name, value and unit and its baseline_definition_ref. Preserve ranges and multidimensional quantities in operating context.",
	analyses:
		"Use [] if no analysis has been performed. Analysis inputs refer to parameter:<id>, assumption:<id>, or a real source locator.",
	requirement_checks:
		"Reference a target and its source requirement ID. Copy its conditions exactly. If unverified, use unknown with analysis_refs: [] and record a candidate-scoped unknown.",
	unknowns:
		"Keep candidate-local unknowns with their candidate and give each a next verification action. Shared unknowns apply across the design; use [] when there are none.",
};

function nextStageInstruction(staged: z.infer<typeof stagedProgress>) {
	const shared = staged.missing.filter((field) => field !== "candidates");
	const candidate = staged.candidates.find((row) => row.missing.length);
	const missing = shared.length ? shared : (candidate?.missing ?? []);
	const field = Object.keys(fieldAdvice).find((name) => missing.includes(name)) ?? missing[0];
	if (field) {
		const scope = shared.length ? "null" : JSON.stringify(candidate?.local_key);
		return `Next stage ${field} using candidate_key ${scope}. ${fieldAdvice[field] ?? "Use its field_contract. Use an empty list only where it is allowed and there are no entries."}`;
	}
	if (!staged.candidates.length) return "Next choose a stable candidate_key and stage its name.";
	return "If the requested candidates are complete, call scheme_apply with draft_binding and staged_digest set to this receipt's staged.digest. Otherwise stage the next candidate's name under a new stable candidate_key.";
}

export const schemeInstructions =
	"For a separate explicit request to generate a formal concept scheme from confirmed requirements in this chat, start with scheme_start. " +
	"Leave requirements drafts unchanged during explicit scheme requests. Do not call requirements_prepare or requirements_apply as part of formal scheme generation. " +
	"Wait for a separate scheme request after requirements confirmation. Immediately after scheme_start opens a first draft, stage only functions. For an explicit continuation, follow the last stage receipt or use scheme_status for the current binding. Apply the final staged digest. Follow the revision template for an existing scheme. " +
	"A successful apply displays the actual frozen scheme automatically. Use scheme_status for status or an explicit redisplay request. Use scheme_revise for an explicit revision. " +
	"Only a new user message confirming the displayed scheme for review permits scheme_review. Use its literal presentation digest. " +
	"Only a separate user request to export the committed reviewed scheme set permits scheme_export. Treat the returned unknowns as unresolved and the review as having no downstream selection authority.";

export const schemeIndependentReviewInstructions =
	"For an explicit retry request such as “请重试当前方案的独立评审。” or “Retry independent review of the current scheme”, call scheme_retry_review immediately as the first action. " +
	"The retry tool checks the current version's independent review record and reports whether retry was accepted. Use scheme_status when the user asks only for status. " +
	"Scheme state committed means submitted for review. Use independent_review.status for the independent verdict and independent_review.report_available for report delivery.";

interface Options {
	host: WorkflowHost;
	binding: () => SchemeBinding | undefined;
	saveBinding: (binding: SchemeBinding) => void;
	requirementsSession: () => string | undefined;
	userText: () => string | undefined;
	priorDisplay: () => string | undefined;
	displayText: (messageId: string) => string | undefined;
	onPresentation: (review: WorkflowReview | undefined) => void;
	independentReviewStatus?: (binding: SchemeBinding) => {
		status: string;
		report_available?: boolean;
	};
	onIndependentReview?: (
		prepare: (signal?: AbortSignal) => Promise<DesignReviewInput>,
		trigger: "commit" | "retry",
		callId?: string,
	) => { accepted: boolean; message?: string };
}

export function createSchemeTools(options: Options) {
	const { host } = options;
	const { grant, perform } = host;
	let editingThisTurn = false;

	function userText(intent: "start" | "revise" | "review" | "retry_review" | "export") {
		const message = options.userText();
		if (!message || schemeUserIntent(message) !== intent)
			throw new Error(
				`An explicit scheme ${intent} request in the current user message is required.`,
			);
		return message;
	}

	function dependencies() {
		host.script("fbs-transformer", "design_semantics.py");
		host.script("scheme-constraint-checker", "check_constraints.py");
	}

	function worktreePath(path: string) {
		return resolveWorktreeFile(grant.workspaceId, path);
	}

	function bound() {
		const binding = options.binding();
		if (!binding) throw new Error("No formal scheme is attached to this chat.");
		return binding;
	}

	function workflowFile(path: string, maxBytes: number) {
		const file = worktreePath(path);
		if (!lstatSync(file).isFile() || realpathSync(file) !== resolve(realpathSync(grant.cwd), path))
			throw new Error("Invalid bound scheme workflow file.");
		const { content, meta } = readFile(grant.workspaceId, path, { maxBytes });
		if (!meta.text || !meta.hash) throw new Error("Invalid bound scheme workflow file.");
		return { content, hash: meta.hash };
	}

	function pointerHash(sid: string) {
		return workflowFile(`.generation/${sid}/current.json`, 4096).hash;
	}

	function currentPointer(binding: SchemeBinding) {
		if (pointerHash(binding.sessionId) !== binding.pointerSha256)
			throw new Error(
				"The saved scheme state no longer matches this chat’s last verified result. Inspect the bound session through the installed Skill before proceeding.",
			);
	}

	async function baseline(signal?: AbortSignal) {
		const sid = options.requirementsSession();
		if (!sid)
			throw new Error(
				"Confirm the requirements baseline in this chat before generating a formal scheme.",
			);
		const response = await host.run(
			requirementsSkill,
			"requirements_runner.py",
			["resume", "--session-id", sid],
			signal,
		);
		const envelope = z
			.looseObject({
				reason: z.string(),
				session_id: sessionId.optional(),
				pair: z.unknown().optional(),
			})
			.parse(response.data);
		if (!response.ok || envelope.reason !== "complete" || envelope.session_id !== sid)
			throw new Error(
				"The requirements workflow in this chat does not have a current confirmed baseline.",
			);
		const pair = requirementsPair.parse(envelope.pair);
		if (
			pair.receipt.artifact_type !== "design_requirement_baseline" ||
			pair.receipt.producer_skill !== requirementsSkill ||
			pair.receipt.artifact_id !== pair.document.export_id ||
			pair.receipt.revision !== pair.document.baseline.version
		)
			throw new Error("The requirements baseline and receipt do not match.");
		return {
			exactPair: object.parse(object.parse(parseWithExactNumbers(response.raw)).pair),
			binding: {
				sessionId: sid,
				baselineId: pair.document.baseline.baseline_id,
				receipt: pair.receipt,
			},
		};
	}

	async function requireBaseline(binding: SchemeBinding, signal?: AbortSignal) {
		const active = await baseline(signal);
		if (!isDeepStrictEqual(active.binding, binding.upstream))
			throw new Error(
				"The requirements baseline has changed. Explicitly revise the scheme against the new baseline.",
			);
		return active;
	}

	async function invoke(args: string[], signal?: AbortSignal) {
		const response = await host.run(schemeSkill, "scheme_runner.py", args, signal);
		const value = resultSchema.parse(response.data);
		if (!response.ok && value.ok)
			throw new Error("The scheme runner exited without a valid result.");
		return { value, raw: response.raw };
	}

	async function expand(
		sid: string,
		kind: "contexts" | "presentations" | "pairs" | "draft-progress",
		value: unknown,
		signal?: AbortSignal,
	) {
		const ref = reference.safeParse(value);
		if (!ref.success) return { value, raw: undefined };
		return readView(sid, kind, ref.data, signal);
	}

	async function readView(
		sid: string,
		kind: ReviewViewKind | "contexts" | "draft-progress",
		ref: z.infer<typeof storedReference> & { bytes?: number },
		signal?: AbortSignal,
	) {
		const { path, sha256: hash } = ref;
		let bytes = ref.bytes;
		if (path !== `.generation/${sid}/${kind}/${hash.slice(0, 32)}.json`)
			throw new Error("The scheme view is outside the current workflow and stage.");
		if (bytes !== undefined && bytes > viewLimit)
			throw new Error("The scheme view exceeds the RailDesign runner output limit.");
		const content: string[] = [];
		const hasher = createHash("sha256");
		let offset = 0;
		for (;;) {
			const response = await invoke(
				[
					"read-view",
					"--session-id",
					sid,
					"--path",
					path,
					"--sha256",
					hash,
					"--offset",
					String(offset),
				],
				signal,
			);
			const fragment = page.parse(response.value);
			bytes ??= fragment.bytes;
			if (bytes > viewLimit)
				throw new Error("The scheme view exceeds the RailDesign runner output limit.");
			if (
				fragment.session_id !== sid ||
				fragment.sha256 !== hash ||
				fragment.bytes !== bytes ||
				fragment.offset !== offset ||
				fragment.next_offset !== offset + Buffer.byteLength(fragment.text) ||
				fragment.next_offset <= offset ||
				fragment.next_offset > bytes ||
				fragment.eof !== (fragment.next_offset === bytes)
			)
				throw new Error("The scheme view pages do not match the retained reference.");
			hasher.update(fragment.text);
			content.push(fragment.text);
			offset = fragment.next_offset;
			if (fragment.eof) break;
		}
		if (hasher.digest("hex") !== hash)
			throw new Error("The reconstructed scheme view failed its SHA-256 check.");
		const joined = content.join("");
		return { value: JSON.parse(joined) as unknown, raw: joined };
	}

	function successful(result: SchemeResult, prior?: SchemeBinding) {
		const value = successfulResult.parse(result);
		if (prior && (value.session_id !== prior.sessionId || value.run_id !== prior.runId))
			throw new Error("The returned scheme belongs to another run or chat.");
		return value;
	}

	function bindingFor(
		result: z.infer<typeof successfulResult>,
		source: z.infer<typeof upstream>,
		state: SchemeBinding["state"],
	): SchemeBinding {
		return {
			sessionId: result.session_id,
			runId: result.run_id,
			revision: result.revision,
			pointerSha256: pointerHash(result.session_id),
			upstream: source,
			state,
		};
	}

	function verifyDesign(
		doc: z.infer<typeof design>,
		binding: SchemeBinding,
		expectedRevision: number,
	) {
		if (
			doc.source.run_id !== binding.runId ||
			doc.revision !== expectedRevision ||
			doc.source_requirement_baseline_id !== binding.upstream.baselineId ||
			!isDeepStrictEqual(doc.source_requirement_baseline_ref, binding.upstream.receipt)
		)
			throw new Error("The scheme design does not match the bound run and requirements baseline.");
	}

	async function prepareReview(
		binding: SchemeBinding,
		signal?: AbortSignal,
	): Promise<DesignReviewInput> {
		const state = binding.state;
		if (state.kind !== "committed") throw new Error("Only a submitted scheme can be reviewed.");
		host.assertActive(signal);
		const pointer = workflowFile(`.generation/${binding.sessionId}/current.json`, 4096);
		if (pointer.hash !== binding.pointerSha256)
			throw new Error("The saved scheme pointer changed before independent review.");
		const tracked: z.infer<typeof storedReference>[] = [];
		async function frozen(kind: ReviewViewKind, ref: z.infer<typeof storedReference>) {
			const value = await readView(binding.sessionId, kind, ref, signal);
			tracked.push(ref);
			return value;
		}
		const snapshotRef = storedReference.parse(JSON.parse(pointer.content));
		const snapshot = reviewSnapshot.parse((await frozen("snapshots", snapshotRef)).value);
		if (
			snapshot.session_id !== binding.sessionId ||
			snapshot.run_id !== binding.runId ||
			snapshot.revision !== binding.revision
		)
			throw new Error("The review snapshot does not match the submitted scheme.");
		const original = await frozen("pairs", snapshot.pair_ref);
		const pair = reviewPair.parse(original.value);
		const exact = object.parse(parseWithExactNumbers(original.raw));
		verifyDesign(pair.document, binding, binding.revision);
		if (
			!isDeepStrictEqual(pair.receipt, state.receipt) ||
			documentFingerprint(exact.document) !== state.documentFingerprint ||
			pair.document.confirmation.presentation_digest !== state.presentationDigest
		)
			throw new Error("The submitted scheme's original document no longer matches its receipt.");

		const base = await frozen("baselines", snapshot.baseline_ref);
		if (!isDeepStrictEqual(requirementsPair.parse(base.value).receipt, binding.upstream.receipt))
			throw new Error("The stored requirements are not the submitted scheme's requirements.");
		const baselineFingerprint = documentFingerprint(parseWithExactNumbers(base.raw));
		const published = await frozen("presentations", snapshot.presentation_ref);
		const shown = presentation.extend({ check_report: checkSummary }).parse(published.value);
		if (
			shown.presentation_digest !== state.presentationDigest ||
			!isDeepStrictEqual(shown.candidate_refs, pair.document.confirmation.candidate_refs)
		)
			throw new Error("The checker result belongs to a different shown scheme.");
		const evidence = [
			designReviewEvidence("requirements", snapshot.baseline_ref.path, base.raw),
			designReviewEvidence("scheme", snapshot.pair_ref.path, original.raw),
			designReviewEvidence(
				"checker",
				`${snapshot.presentation_ref.path}#/check_report`,
				JSON.stringify(object.parse(parseWithExactNumbers(published.raw)).check_report),
			),
		];
		const references = new Set<string>();
		JSON.stringify(pair.document, (_key, value: unknown) => {
			if (typeof value === "string") {
				const source = value.split("#", 1)[0];
				if (source && Object.hasOwn(snapshot.tools, source)) references.add(source);
			}
			return value;
		});
		for (const key of references) {
			const ref = snapshot.tools[key];
			if (!ref) continue;
			const tool = await frozen(reviewToolKind.parse(ref.path.split("/")[2]), ref);
			evidence.push(designReviewEvidence(key, ref.path, tool.raw));
		}
		const publicTask = [
			...new Set([
				...pair.document.input_sources.map((source) => source.text),
				pair.document.task_scope.message,
				pair.document.confirmation.message_text,
			]),
		].join("\n\n");

		async function verifyCurrent(checkSignal?: AbortSignal) {
			host.assertActive(checkSignal);
			if (!isDeepStrictEqual(options.binding(), binding))
				throw new Error("The scheme version changed during independent review.");
			const active = await requireBaseline(binding, checkSignal);
			if (documentFingerprint(active.exactPair) !== baselineFingerprint)
				throw new Error("The stored requirements changed during independent review.");
			for (const ref of tracked) {
				if (workflowFile(ref.path, viewLimit).hash !== ref.sha256)
					throw new Error("The scheme or its evidence changed during independent review.");
			}
			currentPointer(binding);
			host.assertActive(checkSignal);
		}
		return {
			publicTask,
			report: formatDesignReviewReport(
				pair.document,
				shown.check_report,
				object.parse(exact.document),
			),
			evidence,
			verifyCurrent,
		};
	}

	function failure(result: SchemeResult) {
		return { ...result, isError: true };
	}

	async function editableDraft(draftBinding: string, signal?: AbortSignal) {
		const binding = bound();
		const state = binding.state;
		if (
			state.kind !== "draft" ||
			(!editingThisTurn && schemeUserIntent(options.userText() ?? "") !== "continue")
		)
			throw new Error(
				"No current authorized scheme draft. Explicitly start, revise, or continue the current scheme generation.",
			);
		if (draftBinding !== state.draftBinding)
			throw new Error("The scheme draft was produced for an older context.");
		dependencies();
		await requireBaseline(binding, signal);
		currentPointer(binding);
		return { binding, state };
	}

	function sendDraftFile(
		command: "stage" | "apply",
		sid: string,
		json: string,
		signal?: AbortSignal,
	) {
		return host.withScratch(async (directory) => {
			const path = `${directory}/draft.json`;
			writeFileSync(join(grant.cwd, path), json, { flag: "wx", mode: 0o600 });
			return invoke(
				[command, "--session-id", sid, command === "stage" ? "--input" : "--draft", path],
				signal,
			);
		});
	}

	async function openDraft(
		result: SchemeResult,
		source: z.infer<typeof upstream>,
		signal?: AbortSignal,
		prior?: SchemeBinding,
	) {
		if (!result.ok) return failure(result);
		const value = successful(result, prior);
		const binding = digest.parse(value.draft_binding);
		if (value.reason !== "model_work")
			throw new Error("The runner did not open a formal scheme draft.");
		const expanded = await expand(value.session_id, "contexts", value.view, signal);
		const view = z
			.looseObject({
				mode: z.literal("formal"),
				run_id: id,
				revision,
				draft_binding: digest,
				baseline: requirementsPair,
				current_design: object.nullable(),
			})
			.parse(expanded.value);
		if (
			view.run_id !== value.run_id ||
			view.revision !== value.revision ||
			view.draft_binding !== binding ||
			view.baseline.document.baseline.baseline_id !== source.baselineId ||
			!isDeepStrictEqual(view.baseline.receipt, source.receipt)
		)
			throw new Error("The scheme draft view does not match the bound baseline and revision.");
		options.saveBinding(bindingFor(value, source, { kind: "draft", draftBinding: binding }));
		editingThisTurn = true;
		options.onPresentation(undefined);
		return {
			...value,
			view,
			confirmed_hard_constraints: view.baseline.document.requirements
				.filter(
					({ status, definition }) =>
						status === "confirmed" && definition.content_role === "hard_constraint",
				)
				.map(({ requirement_id, definition }) => ({
					requirement_id,
					direct_constraint_statement: definition.statement,
					baseline_target_criterion: definition.verification.criterion,
					baseline_definition_ref: `baseline:${requirement_id}#/definition`,
				})),
			tool_instruction: view.current_design
				? "Submit the changes in one scheme_apply call. Pass draft_json containing draft_binding and revision, following revision_template and revision_instructions. Include only changed values and any necessary reassessments. The runner checks the full result."
				: firstStageInstruction +
					" Pass the returned draft_binding. Each stage receipt suggests the next field. Follow field_contract and domain_guidance as you reach each field. After the first receipt you can group related fields.",
		};
	}

	function withBaseline<Result>(
		pair: Record<string, unknown>,
		action: (args: string[]) => Promise<Result>,
	) {
		return host.withScratch(async (directory) => {
			const document = `${directory}/baseline.json`;
			const receipt = `${directory}/receipt.json`;
			writeFileSync(join(grant.cwd, document), JSON.stringify(pair.document), {
				flag: "wx",
				mode: 0o600,
			});
			writeFileSync(join(grant.cwd, receipt), JSON.stringify(pair.receipt), {
				flag: "wx",
				mode: 0o600,
			});
			return action(["--baseline-document", document, "--baseline-receipt", receipt]);
		});
	}

	return [
		tool({
			name: "scheme_start",
			description:
				"Start formal concept scheme generation only on the user's explicit request, using this chat's current confirmed requirements and any candidate count stated by the user.",
			parameters: z.object({}),
			errorFunction: null,
			execute: (_input, _context, details) =>
				perform(details?.signal, async () => {
					const message = userText("start");
					const count = requestedCandidateCount(message);
					dependencies();
					const current = await baseline(details?.signal);
					const prior = options.binding();
					if (prior) {
						currentPointer(prior);
						if (prior.upstream.baselineId === current.binding.baselineId)
							throw new Error(
								"This requirements baseline already has a formal scheme. Ask to revise or view it.",
							);
					}
					const result = await withBaseline(current.exactPair, (input) =>
						invoke(
							[
								"start",
								...(prior ? ["--session-id", prior.sessionId, "--new-task"] : ["--new-session"]),
								`--message-text=${message}`,
								"--design-depth",
								"concept",
								...(count === undefined ? [] : ["--candidate-count", String(count)]),
								...input,
							],
							details?.signal,
						),
					);
					if (prior && result.value.ok && result.value.session_id !== prior.sessionId)
						throw new Error("The replacement formal scheme did not stay in the bound session.");
					return openDraft(result.value, current.binding, details?.signal);
				}),
		}),
		tool({
			name: "scheme_stage",
			description:
				"Save a small group of fields in the current first draft. Use null candidate_key for shared fields, or the same local_key for each part of a candidate. To discard a mistakenly keyed candidate, pass its key and fields_json containing null. Returns a digest and missing fields.",
			parameters: z.object({
				draft_binding: digest,
				candidate_key: id.nullable(),
				fields_json: z
					.string()
					.min(2)
					.max(2 * 1024 * 1024),
			}),
			errorFunction: null,
			execute: ({ draft_binding, candidate_key, fields_json }, _context, details) =>
				perform(details?.signal, async () => {
					const { binding, state } = await editableDraft(draft_binding, details?.signal);
					if (binding.revision !== 0) throw new Error("Use revision edits for an existing scheme.");
					object.nullable().parse(JSON.parse(fields_json));
					const input = `{"draft_binding":${JSON.stringify(draft_binding)},"candidate_key":${JSON.stringify(candidate_key)},"fields":${fields_json}}`;
					const result = await sendDraftFile("stage", binding.sessionId, input, details?.signal);
					if (!result.value.ok) return failure(result.value);
					const value = successful(result.value, binding);
					if (
						value.reason !== "draft_staged" ||
						value.revision !== binding.revision ||
						value.draft_binding !== draft_binding
					)
						throw new Error("The runner did not save fields in the current scheme draft.");
					const receipt = stagedProgress
						.extend({ all_candidates: reference.optional() })
						.parse(value.staged);
					const staged = receipt.all_candidates
						? stagedProgress.parse({
								...receipt,
								candidates: (
									await expand(
										binding.sessionId,
										"draft-progress",
										receipt.all_candidates,
										details?.signal,
									)
								).value,
							})
						: stagedProgress.parse(receipt);
					options.saveBinding(bindingFor(value, binding.upstream, { ...state, staged }));
					return { ...value, staged, tool_instruction: nextStageInstruction(staged) };
				}),
		}),
		tool({
			name: "scheme_apply",
			description:
				"Validate and publish the current scheme. For the first draft pass draft_json with only draft_binding and the latest staged_digest. For an existing scheme pass draft_binding and revision edits. A successful apply displays the frozen review.",
			parameters: z.object({
				draft_json: z
					.string()
					.min(2)
					.max(2 * 1024 * 1024),
			}),
			errorFunction: null,
			execute: ({ draft_json }, _context, details) =>
				perform(details?.signal, async () => {
					const submission = boundSubmission.parse(JSON.parse(draft_json));
					const { binding, state: draftState } = await editableDraft(
						submission.draft_binding,
						details?.signal,
					);
					let result: Awaited<ReturnType<typeof invoke>>;
					if (binding.revision === 0) {
						const final = stagedSubmission.parse(submission);
						if (final.staged_digest !== draftState.staged?.digest)
							throw new Error("Submit the latest staged digest from this draft.");
						result = await invoke(
							["apply", "--session-id", binding.sessionId, "--staged", final.staged_digest],
							details?.signal,
						);
					} else {
						result = await sendDraftFile("apply", binding.sessionId, draft_json, details?.signal);
					}
					if (!result.value.ok) {
						const rejected = failure(result.value);
						const factError = z
							.object({
								code: z.enum(["fact_value_mismatch", "fact_semantic_mismatch"]),
								message: id,
							})
							.safeParse(result.value.error);
						const retry =
							binding.revision === 0
								? "Use scheme_stage to save only the missing or corrected fields, then submit the latest staged digest."
								: "Resubmit the corrected revision edits.";
						if (!factError.success) return { ...rejected, tool_instruction: retry };
						return {
							...rejected,
							tool_instruction:
								`Repair the rejected key parameter ${factError.data.message}. ` +
								"If its source provides a single usable scalar, copy the complete exact quantity name, value, and unit. " +
								"Otherwise correct the unsupported fact while preserving the operating conditions and all requirement checks. " +
								retry,
						};
					}
					const value = successful(result.value, binding);
					if (value.reason !== "required_user" || value.revision !== binding.revision + 1)
						throw new Error("The runner did not return the next frozen scheme revision.");
					const expanded = await expand(
						binding.sessionId,
						"presentations",
						value.presentation,
						details?.signal,
					);
					const shown = presentation.parse(expanded.value);
					verifyDesign(shown.design, binding, value.revision);
					if (
						shown.revision !== value.revision ||
						shown.candidate_refs.length !== shown.design.schemes.length ||
						shown.candidate_refs.some((ref, index) => {
							const candidate = shown.design.schemes[index];
							return (
								!candidate ||
								candidate.concept_scheme_id !== ref.concept_scheme_id ||
								candidate.revision !== ref.revision
							);
						})
					)
						throw new Error("The frozen review candidate references do not match the design.");
					const state = {
						kind: "pending",
						pending: { digest: shown.presentation_digest, candidates: shown.candidate_refs },
					} as const;
					options.saveBinding(bindingFor(value, binding.upstream, state));
					editingThisTurn = false;
					options.onPresentation({
						workflow: "scheme",
						id: shown.presentation_digest,
						markdown: renderScheme(shown, binding.upstream),
						applyCallId: details?.toolCall?.callId,
					});
					return { ...value, presentation: shown };
				}),
		}),
		tool({
			name: "scheme_status",
			description:
				"Read the scheme workflow and the independent review status for its current submitted version. Explicit redisplay shows the current frozen presentation." +
				(options.onIndependentReview ? " Call scheme_retry_review for a retry request." : ""),
			parameters: z.object({}),
			errorFunction: null,
			execute: (_input, _context, details) =>
				perform(details?.signal, async () => {
					const binding = bound();
					currentPointer(binding);
					const active = await baseline(details?.signal);
					const upstream_current = isDeepStrictEqual(active.binding, binding.upstream);
					const state = binding.state;
					const intent = schemeUserIntent(options.userText() ?? "");
					if (upstream_current && state.kind === "pending" && intent === "redisplay") {
						const markdown =
							state.pending.messageId && options.displayText(state.pending.messageId);
						if (!markdown)
							throw new Error(
								"The frozen review was not published. Explicitly revise the scheme to show a fresh version.",
							);
						options.onPresentation({
							workflow: "scheme",
							id: state.pending.digest,
							markdown,
							applyCallId: details?.toolCall?.callId,
						});
					}
					return {
						ok: true,
						reason: "status",
						session_id: binding.sessionId,
						run_id: binding.runId,
						revision: binding.revision,
						baseline_id: binding.upstream.baselineId,
						baseline_revision: binding.upstream.receipt.revision,
						upstream_current,
						state: state.kind,
						...(state.kind === "draft"
							? {
									draft_binding: state.draftBinding,
									staged: state.staged,
									...(upstream_current && binding.revision === 0 && intent === "continue"
										? {
												tool_instruction: state.staged
													? nextStageInstruction(state.staged)
													: firstStageInstruction,
											}
										: {}),
								}
							: {}),
						...(state.kind === "pending"
							? {
									presentation_digest: state.pending.digest,
									candidate_refs: state.pending.candidates,
									displayed: !!state.pending.messageId,
								}
							: state.kind === "committed"
								? {
										receipt: state.receipt,
										independent_review: upstream_current
											? (options.independentReviewStatus?.(binding) ?? { status: "not_started" })
											: { status: "outdated" },
										...(upstream_current && intent === "retry_review" && options.onIndependentReview
											? {
													tool_instruction:
														"Call scheme_retry_review now to carry out the user's explicit retry request.",
												}
											: {}),
									}
								: {}),
					};
				}),
		}),
		tool({
			name: "scheme_revise",
			description:
				"Open a fresh source-bound draft after an explicit user request to revise the current concept scheme. A changed requirements baseline requires the user to explicitly ask to revise against the updated baseline.",
			parameters: z.object({}),
			errorFunction: null,
			execute: (_input, _context, details) =>
				perform(details?.signal, async () => {
					const message = userText("revise");
					const binding = bound();
					dependencies();
					const current = await baseline(details?.signal);
					const rebind = !isDeepStrictEqual(current.binding, binding.upstream);
					if (current.binding.baselineId !== binding.upstream.baselineId)
						throw new Error(
							"The confirmed requirements now have another identity. Explicitly start a new formal scheme for that baseline.",
						);
					if (rebind && !requestsUpdatedBaseline(message))
						throw new Error(
							"Explicitly request revision against the updated requirements baseline.",
						);
					currentPointer(binding);
					const cmd = ["revise", "--session-id", binding.sessionId, `--message-text=${message}`];
					const result = rebind
						? await withBaseline(current.exactPair, (input) =>
								invoke([...cmd, ...input], details?.signal),
							)
						: await invoke(cmd, details?.signal);
					return openDraft(result.value, current.binding, details?.signal, binding);
				}),
		}),
		tool({
			name: "scheme_review",
			description:
				"Commit the displayed candidate set for review only after an explicit user confirmation of that presentation. Pass its literal presentation digest. This does not authorize downstream selection.",
			parameters: z.object({ presentation_digest: digest }),
			errorFunction: null,
			execute: (input, _context, details) =>
				perform(details?.signal, async () => {
					const message = userText("review");
					const binding = bound();
					if (binding.state.kind !== "pending")
						throw new Error("There is no current pending scheme review.");
					const frozen = binding.state.pending;
					if (
						input.presentation_digest !== frozen.digest ||
						!frozen.messageId ||
						frozen.messageId !== options.priorDisplay()
					)
						throw new Error(
							"Confirm the current displayed scheme set, not an older or another chat's version.",
						);
					await requireBaseline(binding, details?.signal);
					currentPointer(binding);
					const result = await invoke(
						[
							"decide",
							"--session-id",
							binding.sessionId,
							"--purpose",
							"review",
							"--presentation-digest",
							frozen.digest,
							...frozen.candidates.flatMap((candidate) => [
								"--candidate-id",
								candidate.concept_scheme_id,
							]),
							`--message-text=${message}`,
						],
						details?.signal,
					);
					if (!result.value.ok) return failure(result.value);
					const value = successful(result.value, binding);
					if (
						!(value.reason === "complete" || value.reason === "stage_result") ||
						value.revision !== binding.revision + 1
					)
						throw new Error("The runner did not return a newly committed review.");
					const expanded = await expand(binding.sessionId, "pairs", value.pair, details?.signal);
					const pair = reviewPair.parse(expanded.value);
					verifyDesign(pair.document, binding, value.revision);
					if (
						pair.receipt.artifact_type !== "concept_scheme_set" ||
						pair.receipt.producer_skill !== schemeSkill ||
						pair.receipt.artifact_id !== pair.document.scheme_set_id ||
						pair.receipt.revision !== value.revision ||
						pair.document.confirmation.message_text !== message ||
						pair.document.confirmation.presentation_digest !== frozen.digest ||
						!isDeepStrictEqual(pair.document.confirmation.candidate_refs, frozen.candidates)
					)
						throw new Error("The committed scheme, review decision and receipt do not match.");
					const exact = expanded.raw
						? object.parse(parseWithExactNumbers(expanded.raw))
						: object.parse(object.parse(parseWithExactNumbers(result.raw)).pair);
					const committed = bindingFor(value, binding.upstream, {
						kind: "committed",
						receipt: pair.receipt,
						documentFingerprint: documentFingerprint(exact.document),
						presentationDigest: frozen.digest,
					});
					options.saveBinding(committed);
					options.onPresentation(undefined);
					const review = options.onIndependentReview?.(
						(signal) => prepareReview(committed, signal),
						"commit",
						details?.toolCall?.callId,
					);
					return { ...value, pair, ...(review ? { independent_review: review } : {}) };
				}),
		}),
		...(options.onIndependentReview
			? [
					tool({
						name: "scheme_retry_review",
						description:
							"Call first when the user explicitly says “请重试当前方案的独立评审。” or asks to retry independent review of the current scheme. Checks the current version's independent review record and retries an interrupted review.",
						parameters: z.object({}),
						errorFunction: null,
						execute: (_input, _context, details) =>
							perform(details?.signal, async () => {
								userText("retry_review");
								const binding = bound();
								if (binding.state.kind !== "committed")
									throw new Error("Only a submitted scheme can be reviewed.");
								await requireBaseline(binding, details?.signal);
								currentPointer(binding);
								const review = options.onIndependentReview?.(
									(signal) => prepareReview(binding, signal),
									"retry",
									details?.toolCall?.callId,
								);
								return { ok: review?.accepted === true, independent_review: review };
							}),
					}),
				]
			: []),
		tool({
			name: "scheme_export",
			description:
				"Deliver the committed formal scheme JSON after a separate explicit user export request. Verify the actual exported file against the committed review.",
			parameters: z.object({}),
			errorFunction: null,
			execute: (_input, _context, details) =>
				perform(details?.signal, async () => {
					const message = userText("export");
					const binding = bound();
					if (binding.state.kind !== "committed")
						throw new Error("Only a committed current review can be delivered.");
					const committed = binding.state;
					await requireBaseline(binding, details?.signal);
					currentPointer(binding);
					const exporter = dirname(dirname(host.script(exporterSkill, "json_exporter.py")));
					return host.withScratch(async (directory) => {
						const staged = `${directory}/scheme.json`;
						const result = await invoke(
							[
								"export",
								"--session-id",
								binding.sessionId,
								"--json-path",
								staged,
								"--exporter-root",
								exporter,
								`--message-text=${message}`,
							],
							details?.signal,
						);
						if (!result.value.ok) return failure(result.value);
						const delivery = z
							.looseObject({
								reason: z.literal("delivered"),
								internal_commit: z.literal(true),
								deliveries: z.tuple([reference]),
							})
							.parse(result.value).deliveries[0];
						const sourceFile = worktreePath(staged);
						if (
							!lstatSync(sourceFile).isFile() ||
							realpathSync(sourceFile) !== resolve(realpathSync(grant.cwd), staged)
						)
							throw new Error("Invalid staged scheme delivery file.");
						const raw = readFileSync(sourceFile);
						if (
							delivery.path !== staged ||
							raw.byteLength !== delivery.bytes ||
							sha(raw) !== delivery.sha256 ||
							documentFingerprint(parseWithExactNumbers(raw.toString("utf8"))) !==
								committed.documentFingerprint
						)
							throw new Error(
								"The staged export does not match the committed scheme and its file receipt.",
							);
						await requireBaseline(binding, details?.signal);
						currentPointer(binding);
						const path = `scheme-outputs/${committed.receipt.artifact_id}-v${committed.receipt.revision}.json`;
						const target = worktreePath(path);
						const parent = dirname(target);
						mkdirSync(parent, { recursive: true });
						if (realpathSync(parent) !== resolve(realpathSync(grant.cwd), "scheme-outputs"))
							throw new Error("Invalid scheme delivery directory.");
						host.assertActive(details?.signal);
						try {
							linkSync(sourceFile, target);
						} catch (error) {
							if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
								throw error;
						}
						if (!lstatSync(target).isFile() || !readFileSync(target).equals(raw))
							throw new Error("A conflicting scheme delivery file already exists.");
						return { ...result.value, deliveries: [{ ...delivery, path }] };
					});
				}),
		}),
	];
}
