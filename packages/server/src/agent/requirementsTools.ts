import { realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { tool } from "@openai/agents";
import { z } from "zod";
import { resolveWorktreeFile } from "../fs";
import { type WorkflowHost, type WorkflowReview, workflowScratchPrefix } from "./workflowHost";

export const requirementsSkill = "requirements-workflow-host";
const exporterSkill = "json-exporter";
const sessionId = z.string().regex(/^session-[a-f0-9]{16}$/);
const presentationId = z.string().regex(/^presentation-[a-f0-9]{32}$/);
const targetId = z.string().regex(/^[a-z]+-[a-f0-9]{32}$/);
const decisionType = z.enum(["confirm", "reject", "defer"]);
const filePath = z.string().min(1).max(4096);
const definition = z.looseObject({
	statement: z.string(),
	conditions: z.array(z.string()),
	subject: z.string(),
	modality: z.string(),
	content_role: z.string(),
	parameter: z.looseObject({ label: z.string(), operator: z.string() }),
	value: z.looseObject({
		raw_text: z.string(),
		normalized: z.unknown(),
		unit: z.string().nullable(),
	}),
	authorization_scope: z.string().nullable(),
});
const requirement = z.looseObject({
	requirement_id: targetId,
	status: z.string(),
	definition,
	source_refs: z.array(z.looseObject({ locator: z.string(), quote: z.string() })),
});
const presentation = z.looseObject({
	presentation_id: presentationId,
	baseline_version: z.number().int().nonnegative(),
	requirements: z.array(requirement),
	confirmable_ids: z.array(targetId),
	changes: z.array(
		z.looseObject({
			requirement_id: targetId,
			action: z.string(),
			before: requirement.nullable(),
			after: requirement.nullable(),
			reason: z.string().nullish(),
			impact: z.string().nullish(),
		}),
	),
	questions: z.array(
		z.looseObject({
			detail: z.string(),
			question: z.string(),
			next_action: z.string(),
			blocks_handoff: z.boolean(),
		}),
	),
	candidates: z.array(
		z.looseObject({
			candidate_id: targetId,
			status: z.string(),
			statement: z.string(),
			definition: definition.nullish(),
			decision_needed: z.string(),
		}),
	),
	analysis_records: z.array(
		z.looseObject({
			analysis_id: targetId,
			review_status: z.string(),
			conclusion: z.string(),
		}),
	),
	assessment: z.looseObject({
		findings: z.array(z.looseObject({ message: z.string() })),
		issues: z.array(z.looseObject({ message: z.string() })),
	}),
});
const toolResult = z.looseObject({
	reason: z.string().optional(),
	session_id: sessionId.optional(),
	presentation: presentation.optional(),
});
type RunnerResult = z.infer<typeof toolResult>;

export const requirementsBindingSchema = z.strictObject({
	sessionId,
	displayed: z.strictObject({ presentationId, messageId: z.string().min(1) }).optional(),
});
export type RequirementsBinding = z.infer<typeof requirementsBindingSchema>;

function frozenReview(value: z.infer<typeof presentation>): WorkflowReview {
	const inline = (text: string) =>
		text.replace(/\s+/gu, " ").replace(/[\\`*_{}[\]<>()[\]!|&]/gu, "\\$&");
	const statement = (item: z.infer<typeof definition>) => {
		const value =
			item.value.normalized == null
				? item.value.raw_text
				: typeof item.value.normalized === "string"
					? item.value.normalized
					: JSON.stringify(item.value.normalized);
		const bound = [
			item.modality,
			item.subject,
			item.parameter.label,
			item.parameter.operator,
			value,
			item.value.unit,
		]
			.filter(Boolean)
			.join(" ");
		return [
			item.statement,
			bound,
			...item.conditions,
			...(item.authorization_scope ? [`Scope: ${item.authorization_scope}`] : []),
		]
			.map(inline)
			.join(" · ");
	};
	const lines = [
		`### Requirements review · v${value.baseline_version}`,
		"",
		`Reference: \`${value.presentation_id}\``,
		"",
	];
	for (const item of value.requirements) {
		const status = value.confirmable_ids.includes(item.requirement_id)
			? item.definition.content_role === "assumption"
				? "Assumption · requires an explicit decision"
				: "Pending"
			: inline(item.status);
		lines.push(`- **${status}** · ${statement(item.definition)} (\`${item.requirement_id}\`)`);
		for (const ref of item.source_refs)
			lines.push(`  - Source ${inline(ref.locator)} · “${inline(ref.quote)}”`);
	}
	for (const change of value.changes) {
		if (!change.before && !change.after) continue;
		const before = change.before ? statement(change.before.definition) : "—";
		const after = change.after ? statement(change.after.definition) : "—";
		const notes = [change.reason, change.impact]
			.filter((note): note is string => typeof note === "string" && note.length > 0)
			.map(inline)
			.join(" · ");
		lines.push(
			`- **${inline(change.action)}** \`${change.requirement_id}\` · ${before} → ${after}${notes ? ` · ${notes}` : ""}`,
		);
	}
	for (const question of value.questions)
		lines.push(
			`- **${question.blocks_handoff ? "Blocking question" : "Open item"}** · ${inline(question.question)} · ${inline(question.detail)} · ${inline(question.next_action)}`,
		);
	for (const item of [...value.assessment.issues, ...value.assessment.findings])
		lines.push(`- **Check** · ${inline(item.message)}`);
	for (const candidate of value.candidates) {
		lines.push(
			`- **Candidate (${inline(candidate.status)})** \`${candidate.candidate_id}\` · ${candidate.definition ? statement(candidate.definition) : inline(candidate.statement)} · ${inline(candidate.decision_needed)}`,
		);
	}
	for (const analysis of value.analysis_records) {
		lines.push(
			`- **Analysis (${inline(analysis.review_status)})** \`${analysis.analysis_id}\` · ${inline(analysis.conclusion)}`,
		);
	}
	if (
		value.requirements.some(
			(item) =>
				value.confirmable_ids.includes(item.requirement_id) &&
				item.definition.content_role !== "assumption",
		)
	) {
		lines.push(
			"",
			"Reply “确认” or “I confirm the displayed requirements.” to confirm pending requirements, or describe what to change.",
		);
	}
	return { workflow: "requirements", id: value.presentation_id, markdown: lines.join("\n") };
}

interface RequirementsOptions {
	host: WorkflowHost;
	binding: () => RequirementsBinding | undefined;
	saveBinding: (binding: RequirementsBinding) => void;
	userText: () => string | undefined;
	priorDisplay: () => string | undefined;
	onPresentation: (review: WorkflowReview | undefined) => void;
}

export function requirementsDecision(
	text: string,
): { kind: z.infer<typeof decisionType>; targets: string[] } | undefined {
	const reply = text
		.normalize("NFKC")
		.trim()
		.replace(/[.!。！]+$/u, "")
		.trim()
		.toLowerCase();
	const targeted =
		/^(confirm|reject|defer|确认|拒绝|暂缓|采纳) ([-a-z0-9]+(?:[,、 ]+[-a-z0-9]+)*)$/u.exec(reply);
	const command = targeted?.[1] ?? reply;
	const targets = targeted?.[2]?.split(/[,、 ]+/u) ?? [];
	if (
		targets.some((id) => !targetId.safeParse(id).success) ||
		new Set(targets).size !== targets.length
	)
		return undefined;
	if (command === "采纳") return targets.length ? { kind: "confirm", targets } : undefined;
	if (
		/^(?:确认|我确认|确认需求|确认全部需求|(?:我)?确认(?:当前|本次)(?:展示的)?(?:全部)?需求(?:并导出)?|(?:i )?confirm(?: (?:the )?(?:displayed |current )?requirements)?(?: and export)?)$/u.test(
			command,
		)
	)
		return { kind: "confirm", targets };
	if (
		/^(?:拒绝|拒绝(?:当前|本次)(?:展示的)?需求|(?:i )?reject(?: (?:the )?(?:displayed |current )?requirements)?)$/u.test(
			command,
		)
	)
		return { kind: "reject", targets };
	if (
		/^(?:暂缓|暂缓(?:当前|本次)(?:展示的)?需求|(?:i )?defer(?: (?:the )?(?:displayed |current )?requirements)?)$/u.test(
			command,
		)
	)
		return { kind: "defer", targets };
	return undefined;
}

export const requirementsInstructions =
	"For engineering requirements understanding (需求理解), begin extraction, clarification or revision with requirements_prepare. " +
	"It opens a named workspace brief itself; give it the relative path directly, without listing files or using the shell or a Skill. " +
	"Then send the source-bound draft with requirements_apply. Use the requirements tools for every phase; the shared Skill's CLI examples describe other hosts. " +
	"Use a separate chat for a separate requirements task. " +
	"Use requirements_resume for explanations and progress; do not change the workflow on those turns. " +
	"For revisions or clarifications, use requirements_prepare with the current user message. " +
	"DesignRail displays a successful pending review from requirements_apply directly. When re-displaying a review from requirements_resume or requirements_decide, include the literal presentation_id in your final reply so DesignRail attaches it. " +
	"Stop and wait for the user. Only an explicit decision on that display allows requirements_decide. " +
	"For ambiguity ask for a reply such as 'I confirm the displayed requirements.' or '确认'. " +
	"Only delivery.path with verified delivery status is a delivered file. Use requirements_export to retry a failed delivery or supply an existing baseline.";

export function createRequirementsTools(options: RequirementsOptions) {
	const { host } = options;
	const { grant, perform, installed } = host;

	async function run(args: string[], signal?: AbortSignal): Promise<RunnerResult> {
		const output = await host.run(requirementsSkill, "requirements_runner.py", args, signal);
		const result = (
			args[0] === "read-view" && output.ok
				? toolResult.extend({
						text: z.string(),
						next_offset: z.number().int().nonnegative(),
						eof: z.boolean(),
					})
				: toolResult.extend({ reason: z.string() })
		).safeParse(output.data);
		if (!result.success || (!output.ok && result.data.reason !== "blocked"))
			throw new Error("Requirements runner returned an invalid result");
		const existing = options.binding();
		if (result.data.session_id && existing && result.data.session_id !== existing.sessionId)
			throw new Error("Requirements runner returned another session");
		return result.data;
	}

	function bound() {
		const binding = options.binding();
		if (!binding)
			throw new Error(
				"No requirements workflow is attached to this chat. Start with its design brief here.",
			);
		return binding;
	}

	function publish(result: RunnerResult, applyCallId?: string) {
		const review = result.presentation && frozenReview(result.presentation);
		if (review && result.reason === "required_user") review.applyCallId = applyCallId;
		if (result.reason !== "blocked") options.onPresentation(review);
		return result.reason === "blocked"
			? { ...result, isError: true }
			: review && !review.applyCallId
				? {
						...result,
						display_instruction:
							"Include this literal presentation_id in the final reply so DesignRail attaches the frozen review, then wait for the user's decision.",
					}
				: result;
	}

	function inputPath(path: string) {
		if (isAbsolute(path)) throw new Error("Use a path relative to the assigned worktree");
		const absolute = resolveWorktreeFile(grant.workspaceId, path);
		const actual = realpathSync(absolute);
		if (!statSync(actual).isFile()) throw new Error("The requirements source must be a file");
		const first = relative(realpathSync(grant.cwd), actual).split(sep)[0]?.toLowerCase();
		if (
			[".requirements", "requirements-work"].includes(first ?? "") ||
			first?.startsWith(workflowScratchPrefix)
		)
			throw new Error("Use the original source file, outside the requirements working records");
		return absolute;
	}

	async function withInputFile(text: string, action: (path: string) => Promise<RunnerResult>) {
		return host.withScratch(async (directory) => {
			const input = `${directory}/input.json`;
			writeFileSync(join(grant.cwd, input), text, { flag: "wx", mode: 0o600 });
			return action(input);
		});
	}

	function userText() {
		const text = options.userText();
		if (!text?.trim()) throw new Error("This operation needs the current user's own message");
		return text;
	}

	function exporterRoot() {
		host.script(exporterSkill, "json_exporter.py");
		const { root } = installed(exporterSkill);
		return root;
	}

	return [
		tool({
			name: "requirements_prepare",
			description:
				"Start or revise the engineering requirements workflow from the user's design brief. Use the returned source-bound draft template and contract. Include the current user message when it contains requirements or changes; for a task book alone use its workspace path. Use a separate chat for a separate requirements task.",
			parameters: z.object({
				sources: z
					.array(
						z.object({
							path: filePath,
							extracted: filePath.nullable(),
							revision: z.boolean(),
						}),
					)
					.max(32)
					.nullable(),
				include_message: z.boolean(),
				profile: filePath.nullable(),
				segment_start: z.number().int().nonnegative().nullable(),
				requirement_ids: z.array(targetId).nullable(),
			}),
			errorFunction: null,
			execute: (input, _context, details) =>
				perform(details?.signal, async () => {
					const message = userText();
					if (requirementsDecision(message))
						throw new Error("Use requirements_decide for a requirements decision");
					const binding = options.binding();
					const guidance = installed(requirementsSkill).guidance;
					const args = binding
						? ["prepare", "--session-id", binding.sessionId]
						: ["prepare", "--new-session", "--exporter-root", exporterRoot()];
					if (input.profile)
						args.push(
							"--profile",
							relative(grant.cwd, inputPath(input.profile)).split(sep).join("/"),
						);
					if (input.segment_start !== null)
						args.push("--segment-start", String(input.segment_start));
					for (const id of input.requirement_ids ?? []) args.push("--requirement-id", id);
					const sources = input.sources ?? [];
					const result = sources.length
						? await withInputFile(
								JSON.stringify([
									...(input.include_message ? [{ message }] : []),
									...sources.map(({ path, extracted, revision }) => ({
										source: inputPath(path),
										...(extracted
											? {
													extracted: relative(grant.cwd, inputPath(extracted)).split(sep).join("/"),
												}
											: {}),
										...(revision ? { revision: true } : {}),
									})),
								]),
								(path) => run([...args, "--inputs", path], details?.signal),
							)
						: await run([...args, `--message-text=${message}`], details?.signal);
					if (result.reason === "semantic_draft" && result.session_id) {
						options.saveBinding({ sessionId: result.session_id });
						return {
							...publish(result),
							guidance,
							tool_instruction:
								"Follow the Skill's semantic guidance using the requirements tools. Use requirements_read_view for an out-of-line semantic view and requirements_apply for the completed JSON draft.",
						};
					}
					return publish(result);
				}),
		}),
		tool({
			name: "requirements_apply",
			description:
				"Apply the completed JSON draft from requirements_prepare, using exact template IDs and source quotes. For unresolved_items target_requirement_ids, use operation:N for a zero-based draft operation that produces a requirement, an existing ID from context.target_ids, or [] for a general question. Never invent IDs or use requirement names. DesignRail displays the frozen review and waits for the user's decision.",
			parameters: z.object({
				draft_json: z
					.string()
					.min(2)
					.max(2 * 1024 * 1024),
			}),
			errorFunction: null,
			execute: ({ draft_json }, _context, details) =>
				perform(details?.signal, async () => {
					const binding = bound();
					const result = await withInputFile(draft_json, (path) =>
						run(
							[
								"apply",
								"--session-id",
								binding.sessionId,
								"--draft",
								path,
								"--exporter-root",
								exporterRoot(),
							],
							details?.signal,
						),
					);
					if (result.reason !== "blocked") options.saveBinding({ sessionId: binding.sessionId });
					return publish(result, details?.toolCall?.callId);
				}),
		}),
		tool({
			name: "requirements_resume",
			description:
				"Read the requirements workflow attached to this chat, including pending presentation or actual delivery status. Useful for a progress or explanation request.",
			parameters: z.object({}),
			errorFunction: null,
			execute: (_input, _context, details) =>
				perform(details?.signal, async () =>
					publish(await run(["resume", "--session-id", bound().sessionId], details?.signal)),
				),
		}),
		tool({
			name: "requirements_read_view",
			description:
				"Read a page of the semantic draft view when prepare or resume returns an out-of-line view. Use the returned path and sha256 and follow next_offset until eof.",
			parameters: z.object({
				path: filePath,
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
				offset: z.number().int().nonnegative(),
			}),
			errorFunction: null,
			execute: ({ path, sha256, offset }, _context, details) =>
				perform(details?.signal, async () => {
					const result = await run(
						[
							"read-view",
							"--session-id",
							bound().sessionId,
							`--path=${path}`,
							"--sha256",
							sha256,
							"--offset",
							String(offset),
						],
						details?.signal,
					);
					return result.reason === "blocked" ? { ...result, isError: true } : result;
				}),
		}),
		tool({
			name: "requirements_decide",
			description:
				"Record a real user confirmation, rejection or deferral of the requirements previously presented in this chat. Use the literal presentation_id from that reply. For explicit individual decisions the user may send 'confirm ID1, ID2' using the displayed IDs. The host supplies the current user's text and actual target IDs.",
			parameters: z.object({ presentation_id: presentationId, decision: decisionType }),
			errorFunction: null,
			execute: (input, _context, details) =>
				perform(details?.signal, async () => {
					const binding = bound();
					const message = userText();
					const decision = requirementsDecision(message);
					if (decision?.kind !== input.decision)
						throw new Error(
							"An explicit matching decision from the current user is required. Ask them to confirm, reject or defer the displayed requirements directly.",
						);
					if (
						binding.displayed?.presentationId !== input.presentation_id ||
						options.priorDisplay() !== binding.displayed.messageId
					)
						throw new Error(
							"This version was not the requirements presentation shown for this reply. Redisplay the current presentation before asking for a decision.",
						);
					const result = await run(
						[
							"decide",
							"--session-id",
							binding.sessionId,
							"--presentation-id",
							input.presentation_id,
							"--decision",
							decision.kind,
							`--message-text=${message}`,
							"--exporter-root",
							exporterRoot(),
							...decision.targets.flatMap((id) => ["--target-id", id]),
						],
						details?.signal,
					);
					if (result.reason !== "blocked" || result.confirmation === "committed")
						options.saveBinding({ sessionId: binding.sessionId });
					return publish(result);
				}),
		}),
		tool({
			name: "requirements_export",
			description:
				"Re-verify or retry delivery of the already committed requirements baseline in this chat. Use a relative JSON path only when the user asks for another file.",
			parameters: z.object({ path: filePath.nullable() }),
			errorFunction: null,
			execute: ({ path }, _context, details) =>
				perform(details?.signal, async () => {
					const message = userText();
					if (path) {
						if (isAbsolute(path)) throw new Error("Use a path relative to the assigned worktree");
						resolveWorktreeFile(grant.workspaceId, path);
					}
					return publish(
						await run(
							[
								"export",
								"--session-id",
								bound().sessionId,
								`--message-text=${message}`,
								"--exporter-root",
								exporterRoot(),
								...(path ? [`--export-path=${path}`] : []),
							],
							details?.signal,
						),
					);
				}),
		}),
	];
}
