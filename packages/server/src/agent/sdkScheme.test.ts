import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInputItem } from "@openai/agents";
import {
	assistantMessage,
	functionCall,
	modelResponder,
	ScriptedModel,
	type ScriptedModelInput,
} from "@openai/agents/testing";
import { saveProjects, saveWorkspaces } from "../persistence";
import { configureAgentModelFactory } from "./modelConfiguration";
import { requestedCandidateCount, schemeUserIntent } from "./schemeTools";
import {
	createSession,
	disposeAllSessions,
	ensureSessionAttached,
	promptSession,
	setSessionProjectResolver,
	settleSessionsForShutdown,
} from "./sdkSessionManager";
import { readSessionRecord } from "./sessionStore";

const environment = {
	THINKRAIL_DATA_DIR: "",
	OPENAI_BASE_URL: "https://opencode.ai/inference/go/openai/v1",
	OPENAI_MODEL: "deepseek-v4.1-flash",
	OPENAI_API_KEY: "fixture",
};
const dist = process.env.RAILDESIGN_SCHEME_TEST_DIST;
const goal = "设计一个静载导向机构";
const limit = "导向端位移不大于 2 mm";
const accept = "我确认当前展示的方案用于审阅。";
const start = "按已确认的需求生成一个概念方案";
const exportRequest = "请导出当前已审阅方案集的 JSON。";
const prepared = {
	sources: null,
	include_message: true,
	profile: null,
	segment_start: null,
	requirement_ids: null,
};
let root: string, cwd: string;
let previous: Record<string, string | undefined>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "raildesign-scheme-"));
	cwd = join(root, "worktree");
	mkdirSync(cwd);
	previous = Object.fromEntries(Object.keys(environment).map((name) => [name, process.env[name]]));
	Object.assign(process.env, environment, { THINKRAIL_DATA_DIR: join(root, "data") });
	saveProjects([
		{
			id: "project",
			name: "Scheme",
			slug: "scheme",
			path: cwd,
			lastOpened: 1,
			resourceTrust: "granted",
		},
	]);
	saveWorkspaces([
		{
			id: "worktree",
			projectId: "project",
			name: "Scheme",
			worktreePath: cwd,
			branch: "main",
			baseBranch: "main",
		},
	]);
	setSessionProjectResolver(() => "project");
});

afterEach(async () => {
	await settleSessionsForShutdown();
	disposeAllSessions();
	configureAgentModelFactory();
	setSessionProjectResolver(() => null);
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

const call = (name: string, args: Record<string, unknown> = {}) => [
	functionCall(name, JSON.stringify(args), { callId: crypto.randomUUID() }),
];
const reply = (text: string) => [assistantMessage(text)];
function output(items: string | AgentInputItem[], name: string) {
	if (typeof items === "string") throw new Error("Missing structured history.");
	const item = items.findLast(
		(entry) => entry.type === "function_call_result" && entry.name === name,
	);
	if (item?.type !== "function_call_result") throw new Error(`Missing ${name} result`);
	const first = Array.isArray(item.output) ? item.output[0] : item.output;
	const text =
		typeof first === "string" ? first : first && "text" in first ? first.text : undefined;
	if (typeof text !== "string") throw new Error(`Missing text for ${name}`);
	return JSON.parse(text);
}

function toolError(record: Awaited<ReturnType<typeof turn>>, name: string) {
	const result = record.messages.findLast(
		(item) => item.role === "toolResult" && item.toolName === name,
	);
	if (result?.role !== "toolResult" || !result.isError) throw new Error(`Missing ${name} error`);
	return result.content.find((item) => item.type === "text")?.text;
}

async function turn(sessionId: string, text: string, ...script: ScriptedModelInput[]) {
	const model = new ScriptedModel(script);
	configureAgentModelFactory(() => model);
	await promptSession(sessionId, text);
	const record = readSessionRecord(sessionId);
	if (!record) throw new Error("Missing session");
	if (record.state.completion?.outcome !== "succeeded")
		throw new Error(JSON.stringify(record.messages.slice(-4)).slice(-3500));
	model.assertComplete();
	expect(model.calls.filter((call) => call.streamed)).toHaveLength(script.length);
	return record;
}

test("scheme authority accepts explicit approved user phrases and separates decisions from export", () => {
	for (const entry of [
		[start, "start"],
		["按已确认的需求生成概念方案", "start"],
		["请基于当前已确认的需求基线，生成一个正式概念方案。", "start"],
		["请按新版需求基线修订当前方案：重新评估边界。", "revise"],
		["请再展示当前待审阅的方案及来源。", "redisplay"],
		["请继续方案生成：先补功能。", "continue"],
		["Please continue the current scheme generation: use the staged fields.", "continue"],
		["不要继续方案生成：先补功能。", undefined],
		["请继续方案生成吗？", undefined],
		["请继续方案生成：先补功能吗？", undefined],
		["请继续方案生成并导出", undefined],
		["请继续方案生成：先补功能，然后导出。", "continue"],
		[accept, "review"],
		[exportRequest, "export"],
		["请只说明当前方案进度。", undefined],
		["不要确认当前方案用于审阅", undefined],
		["确认旧方案用于审阅", undefined],
		["确认当前展示的方案并导出", undefined],
	])
		expect(schemeUserIntent(entry[0] ?? "")).toBe(entry[1]);
	expect(requestedCandidateCount("请生成正式概念方案：把手生成３个加强筋")).toBeUndefined();
	expect(requestedCandidateCount("请生成２个正式概念方案。")).toBe(2);
});

test.skipIf(!dist)(
	"real installed scheme workflow uses the current confirmed pair, exposes only actual reviews, and verifies formal JSON",
	async () => {
		if (!dist)
			throw new Error("Set RAILDESIGN_SCHEME_TEST_DIST to a staged design-agent distribution.");
		const skills = join(root, "data", "skills");
		for (const name of [
			"requirements-workflow-host",
			"scheme-generation-workflow-host",
			"fbs-transformer",
			"scheme-constraint-checker",
			"json-exporter",
		])
			cpSync(join(dist, "skills", name), join(skills, name), { recursive: true });
		const { sessionId: owner } = await createSession({ cwd, workspaceId: "worktree" });
		const { sessionId: foreign } = await createSession({ cwd, workspaceId: "worktree" });
		await turn(owner, start, call("scheme_start"), reply("Needs confirmation"));
		expect(existsSync(join(cwd, ".generation"))).toBe(false);
		const requirements = await turn(
			owner,
			`${goal}；${limit}`,
			call("requirements_prepare", prepared),
			modelResponder(({ request }) => {
				const view = output(request.input, "requirements_prepare");
				const segment = view.segments[0].segment_id;
				const ops = [goal, limit].map((quote, index) => {
					const op = structuredClone(view.operation_example);
					Object.assign(op.definition, {
						statement: quote,
						subject: "静载导向机构",
						content_role: index ? "hard_constraint" : "design_goal",
						raw_requirement_refs: [segment],
					});
					op.definition.parameter.label = index ? "导向端位移" : "设计目标";
					op.definition.parameter.operator = index ? "maximum" : "equals";
					op.definition.value = index
						? {
								raw_text: "2 mm",
								type: "number",
								normalized: 2,
								unit: "mm",
								normalization_status: "exact",
							}
						: {
								raw_text: goal,
								type: "qualitative",
								normalized: goal,
								unit: null,
								normalization_status: "preserved",
							};
					if (index)
						Object.assign(op.definition.verification, {
							method: "解析计算与测试核验",
							criterion: "位移不大于 2 mm",
						});
					op.sources = [{ segment_id: segment, quote }];
					return op;
				});
				const draft = JSON.stringify({ ...view.draft_template, operations: ops }).replace(
					'"normalized":2,',
					'"normalized":2.0,',
				);
				expect(draft).toContain('"normalized":2.0');
				return call("requirements_apply", { draft_json: draft });
			}),
		);
		const requirementsDisplay = requirements.requirements?.displayed?.presentationId;
		expect(requirementsDisplay).toBeTruthy();
		await turn(owner, start, call("scheme_start"), reply("Still pending"));
		expect(existsSync(join(cwd, ".generation"))).toBe(false);
		await turn(
			owner,
			"请再展示需求",
			call("requirements_resume"),
			reply(requirementsDisplay ?? ""),
		);
		const confirmed = await turn(
			owner,
			"我确认当前展示的需求。",
			call("requirements_decide", { presentation_id: requirementsDisplay, decision: "confirm" }),
			call("scheme_start"),
			reply("Baseline confirmed"),
		);
		const baseline = output(confirmed.history, "requirements_decide").pair;
		const requirementsPointer = join(
			cwd,
			".requirements",
			confirmed.requirements?.sessionId ?? "",
			"current.json",
		);
		const confirmedRequirementsBytes = readFileSync(requirementsPointer);
		expect(baseline.receipt.committed).toBe(true);
		expect(existsSync(join(cwd, ".generation"))).toBe(false);
		const idOf = (role: string) =>
			baseline.document.requirements.find(
				(row: { definition: { content_role: string } }) => row.definition.content_role === role,
			).requirement_id;
		const goalId = idOf("design_goal");
		const limitId = idOf("hard_constraint");
		const example = JSON.parse(
			readFileSync(join(skills, "fbs-transformer/references/semantic-draft.example.json"), "utf8"),
		);
		const draft = structuredClone(example);
		draft.functions[0].source_requirement_ids = [goalId, limitId];
		draft.expected_behaviors[0].source_requirement_ids = [limitId];
		draft.direct_constraints[0].source_requirement_ids = [limitId];
		const candidate = draft.candidates[0];
		candidate.analyses[0].input_refs = ["parameter:span"];
		candidate.analyses[0].result_kind = "qualitative";
		candidate.analyses[0].value = null;
		candidate.analyses[0].result = "载荷尚未绑定，当前未知";
		for (const evidence of candidate.analyses[0].evidence)
			Object.assign(evidence, {
				source_refs: [],
				verification_ref: null,
				evidence_type: "qualitative_reasoning",
				supports: "mechanism",
			});
		for (const item of candidate.requirement_checks)
			Object.assign(item, {
				requirement_ref: limitId,
				status: "unknown",
				rationale: "未取得适用计算结果",
			});
		for (let index = 0; index < 10; index++)
			candidate.unknowns.push({
				unknown_id: `Unverified-${index}`,
				statement: "载荷与导向精度待验证。".repeat(700),
				target_refs: ["B-guidance"],
				affects: ["comparison"],
				next_action: "进行实际测量",
			});
		draft.exit_reason = "external_dependency";
		draft.exit_detail = "等待有来源的载荷与计算复核";
		const invalidFact = structuredClone(draft);
		Object.assign(invalidFact.candidates[0].key_parameters[0], {
			role: "fact",
			source_refs: [`baseline:${limitId}#/definition`],
			value: 3,
		});
		let draftBinding: string;
		const stage = (key: string | null, fields: Record<string, unknown>) =>
			call("scheme_stage", {
				draft_binding: draftBinding,
				candidate_key: key,
				fields_json: JSON.stringify(fields),
			});
		const finalize = (snapshot: string) =>
			call("scheme_apply", {
				draft_json: JSON.stringify({ draft_binding: draftBinding, staged_digest: snapshot }),
			});
		const partial = await turn(
			owner,
			start,
			call("scheme_start"),
			modelResponder(({ request }) => {
				const value = output(request.input, "scheme_start");
				expect(value.view.baseline.receipt).toEqual(baseline.receipt);
				expect(value.confirmed_hard_constraints).toEqual([
					{
						requirement_id: limitId,
						direct_constraint_statement: limit,
						baseline_target_criterion: "位移不大于 2 mm",
						baseline_definition_ref: `baseline:${limitId}#/definition`,
					},
				]);
				expect(value.view.task_scope.candidate_count).toBe(1);
				expect(value.tool_instruction).toContain("only functions");
				draftBinding = value.draft_binding;
				return stage(null, { functions: draft.functions });
			}),
			reply("Functions saved."),
		);
		const pendingStage = output(partial.history, "scheme_stage");
		const partialDigest = pendingStage.staged.digest;
		expect(pendingStage).toMatchObject({ reason: "draft_staged", revision: 0 });
		expect(pendingStage.staged.missing).toContain("expected_behaviors");
		expect(pendingStage.tool_instruction).toContain(
			"Next stage expected_behaviors using candidate_key null",
		);
		expect(pendingStage.tool_instruction).toContain("known_condition is operating context only");
		expect(partial.scheme?.state).toMatchObject({
			kind: "draft",
			staged: { digest: partialDigest },
		});
		const stagedPointer = join(cwd, ".generation", pendingStage.session_id, "current.json");
		const before = readFileSync(stagedPointer);
		await settleSessionsForShutdown();
		disposeAllSessions();
		expect(await ensureSessionAttached(owner, "worktree", cwd)).toBe(true);
		expect(await ensureSessionAttached(foreign, "worktree", cwd)).toBe(true);
		const paused = await turn(
			owner,
			"请说明方案进度",
			call("scheme_status"),
			reply("Fields saved."),
		);
		expect(output(paused.history, "scheme_status")).toMatchObject({
			state: "draft",
			staged: { digest: partialDigest },
		});
		const foreignWrite = await turn(
			foreign,
			"请继续方案生成",
			stage("wrong", { name: "not my scheme" }),
			reply("No access"),
		);
		expect(toolError(foreignWrite, "scheme_stage")).toContain("No formal scheme is attached");
		const unauthorized = await turn(
			owner,
			"请说明方案进度",
			stage("wrong", { name: "not an edit request" }),
			reply("Read only"),
		);
		expect(toolError(unauthorized, "scheme_stage")).toContain("No current authorized scheme draft");
		expect(readFileSync(stagedPointer)).toEqual(before);
		const missing = await turn(
			owner,
			"请继续方案生成",
			finalize(partialDigest),
			reply("Needs a candidate."),
		);
		expect(output(missing.history, "scheme_apply")).toMatchObject({ ok: false });
		expect(readFileSync(stagedPointer)).toEqual(before);
		const { unknowns: candidateUnknowns, ...configuration } = invalidFact.candidates[0];
		const { functions: _functions, candidates: _candidates, ...remainingShared } = draft;
		const first = await turn(
			owner,
			"请继续方案生成：基于已保存的功能，补齐方案。",
			stage(null, remainingShared),
			modelResponder(({ request }) => {
				expect(output(request.input, "scheme_stage").tool_instruction).toContain("stage its name");
				return stage(candidate.local_key, configuration);
			}),
			modelResponder(({ request }) => {
				expect(output(request.input, "scheme_stage").tool_instruction).toContain(
					`Next stage unknowns using candidate_key "${candidate.local_key}"`,
				);
				return stage(candidate.local_key, { unknowns: candidateUnknowns });
			}),
			finalize(partialDigest),
			modelResponder(({ request }) => {
				expect(JSON.stringify(request.input.at(-1))).toContain("latest staged digest");
				const latest = output(request.input, "scheme_stage").staged;
				expect(latest.digest).not.toBe(partialDigest);
				expect(latest.missing).toEqual([]);
				expect(latest.candidates).toEqual([{ local_key: candidate.local_key, missing: [] }]);
				return finalize(latest.digest);
			}),
			modelResponder(({ request }) => {
				const rejected = output(request.input, "scheme_apply");
				expect(rejected).toMatchObject({
					ok: false,
					error: { code: "fact_value_mismatch", message: "span" },
				});
				expect(rejected.tool_instruction).toContain("Repair the rejected key parameter span.");
				expect(rejected.tool_instruction).toContain("correct the unsupported fact");
				expect(rejected.tool_instruction).toContain(
					"operating conditions and all requirement checks",
				);
				return stage(candidate.local_key, { key_parameters: candidate.key_parameters });
			}),
			modelResponder(({ request }) =>
				finalize(output(request.input, "scheme_stage").staged.digest),
			),
		);
		const actual = output(first.history, "scheme_apply");
		const shown = actual.presentation;
		expect(actual.reason).toBe("required_user");
		expect(shown.design.source_requirement_baseline_ref).toEqual(baseline.receipt);
		const visible = first.messages.at(-1);
		expect(visible?.role).toBe("assistant");
		expect(first.scheme?.state).toMatchObject({
			kind: "pending",
			pending: { messageId: visible?.id },
		});
		for (const text of [shown.presentation_digest, goalId, limitId, "Unverified-0", "进行实际测量"])
			expect(JSON.stringify(visible)).toContain(text);
		const pointer = join(cwd, ".generation", actual.session_id, "current.json");
		const frozen = readFileSync(pointer);
		await turn(
			foreign,
			accept,
			call("scheme_review", { presentation_digest: shown.presentation_digest }),
			reply("No access"),
		);
		await turn(owner, exportRequest, call("scheme_export"), reply("No committed review"));
		const progress = await turn(
			owner,
			"请只说明当前方案进度。",
			call("scheme_status"),
			reply("Waiting for review"),
		);
		expect(output(progress.history, "scheme_status")).toMatchObject({
			state: "pending",
			upstream_current: true,
		});
		expect(readFileSync(pointer)).toEqual(frozen);
		expect(existsSync(join(cwd, "scheme-outputs"))).toBe(false);

		const previous = shown.design.schemes[0];
		const newName = `${previous.name}（修订）`;
		let openRevisionPointer: string;
		const revisionRecord = await turn(
			owner,
			"请修订当前方案：调整名称。",
			call("scheme_revise"),
			modelResponder(({ request }) => {
				const view = output(request.input, "scheme_revise");
				expect(view.view.revision_template).toBeDefined();
				expect(view.tool_instruction).toContain("revision_template");
				openRevisionPointer = readFileSync(pointer, "utf8");
				return call("scheme_apply", {
					draft_json: JSON.stringify({ draft_binding: view.draft_binding, design: draft }),
				});
			}),
			modelResponder(({ request }) => {
				expect(output(request.input, "scheme_apply")).toMatchObject({
					ok: false,
					error: { code: "invalid_draft" },
				});
				expect(readFileSync(pointer, "utf8")).toBe(openRevisionPointer);
				const view = output(request.input, "scheme_revise");
				return call("scheme_apply", {
					draft_json: JSON.stringify({
						draft_binding: view.draft_binding,
						revision: {
							kind: "structure",
							reason: "区分当前待审议方案",
							edits: [{ candidate_id: previous.concept_scheme_id, path: ["name"], value: newName }],
						},
					}),
				});
			}),
		);
		const current = output(revisionRecord.history, "scheme_apply").presentation;
		expect(current.presentation_digest).not.toBe(shown.presentation_digest);
		expect(current.design.schemes[0]).toMatchObject({
			concept_scheme_id: previous.concept_scheme_id,
			name: newName,
			analyses: previous.analyses,
			unknowns: previous.unknowns,
		});
		const revisedPointer = readFileSync(pointer);
		await turn(
			owner,
			accept,
			call("scheme_review", { presentation_digest: shown.presentation_digest }),
			reply("Outdated review"),
		);
		expect(readFileSync(pointer)).toEqual(revisedPointer);
		await turn(owner, "请再展示当前待审阅的方案及来源。", call("scheme_status"));
		expect(readFileSync(pointer)).toEqual(revisedPointer);

		await settleSessionsForShutdown();
		disposeAllSessions();
		expect(await ensureSessionAttached(owner, "worktree", cwd)).toBe(true);
		const reviewed = await turn(
			owner,
			accept,
			call("scheme_review", { presentation_digest: current.presentation_digest }),
			call("scheme_export"),
			reply("Review saved"),
		);
		const pair = output(reviewed.history, "scheme_review").pair;
		expect(pair.receipt.committed).toBe(true);
		expect(pair.document.confirmation).toMatchObject({
			purpose: "review",
			message_text: accept,
			presentation_digest: current.presentation_digest,
			candidate_refs: current.candidate_refs,
		});
		expect(pair.document.authorized_candidate_refs).toEqual([]);
		expect(existsSync(join(cwd, "scheme-outputs"))).toBe(false);
		const delivered = await turn(owner, exportRequest, call("scheme_export"), reply("Delivered"));
		const { deliveries } = output(delivered.history, "scheme_export");
		const data = readFileSync(join(cwd, deliveries[0].path));
		expect(data.byteLength).toBe(deliveries[0].bytes);
		expect(createHash("sha256").update(data).digest("hex")).toBe(deliveries[0].sha256);
		expect(JSON.parse(data.toString("utf8"))).toEqual(pair.document);
		expect(readFileSync(requirementsPointer)).toEqual(confirmedRequirementsBytes);

		const updatedLimit = "导向端位移不大于 1.5 mm";
		const updated = await turn(
			owner,
			updatedLimit,
			call("requirements_prepare", prepared),
			modelResponder(({ request }) => {
				const view = output(request.input, "requirements_prepare");
				const segment = view.segments[0].segment_id;
				const definition = structuredClone(
					baseline.document.requirements.find(
						(row: { requirement_id: string }) => row.requirement_id === limitId,
					).definition,
				);
				definition.parameter = {
					label: definition.parameter.label,
					operator: definition.parameter.operator,
				};
				definition.statement = updatedLimit;
				definition.raw_requirement_refs = [segment];
				definition.value.raw_text = "1.5 mm";
				definition.value.normalized = 1.5;
				definition.verification.criterion = null;
				return call("requirements_apply", {
					draft_json: JSON.stringify({
						...view.draft_template,
						operations: [
							{
								op: "update",
								target_requirement_id: limitId,
								question_id: null,
								definition,
								reason: "用户修改导向端位移上限",
								impact: "重新核对候选方案",
								sources: [{ segment_id: segment, quote: updatedLimit }],
							},
						],
					}),
				});
			}),
		);
		const replacement = await turn(
			owner,
			"我确认当前展示的需求。",
			call("requirements_decide", {
				presentation_id: updated.requirements?.displayed?.presentationId,
				decision: "confirm",
			}),
			reply("Updated requirements confirmed"),
		);
		const replacementReceipt = output(replacement.history, "requirements_decide").pair.receipt;
		expect(replacementReceipt.revision).toBeGreaterThan(baseline.receipt.revision);
		const reviewedPointer = readFileSync(pointer);
		const staleExport = await turn(
			owner,
			exportRequest,
			call("scheme_export"),
			reply("Review is out of date"),
		);
		expect(toolError(staleExport, "scheme_export")).toContain("requirements baseline has changed");
		const negatedRebind = await turn(
			owner,
			"请修订当前方案：不要按新版需求基线，继续按旧版。",
			call("scheme_revise"),
			reply("Rebinding requires a new request"),
		);
		expect(toolError(negatedRebind, "scheme_revise")).toContain("Explicitly request revision");
		const staleStatus = await turn(
			owner,
			"请只说明当前方案进度。",
			call("scheme_status"),
			reply("Baseline has changed"),
		);
		expect(output(staleStatus.history, "scheme_status").upstream_current).toBe(false);
		expect(readFileSync(pointer)).toEqual(reviewedPointer);
		const rebound = await turn(
			owner,
			"请按新版需求基线修订当前方案：重新评估导向位移。",
			call("scheme_revise"),
			reply("Started revision with updated baseline"),
		);
		const reboundResult = output(rebound.history, "scheme_revise");
		expect(reboundResult.confirmed_hard_constraints).toEqual([
			{
				requirement_id: limitId,
				direct_constraint_statement: updatedLimit,
				baseline_target_criterion: null,
				baseline_definition_ref: `baseline:${limitId}#/definition`,
			},
		]);
		const reboundView = reboundResult.view;
		expect(reboundView.baseline.receipt).toEqual(replacementReceipt);
		expect(reboundView.reanalysis_required).toBe(true);
		expect(rebound.scheme?.state.kind).toBe("draft");

		const reboundPointer = readFileSync(pointer);
		const externalPointer = Buffer.concat([reboundPointer, Buffer.from("\n")]);
		writeFileSync(pointer, externalPointer);
		const externallyChanged = await turn(
			owner,
			"请修订当前方案：调整名称。",
			call("scheme_revise"),
			reply("Current scheme is no longer verified"),
		);
		expect(toolError(externallyChanged, "scheme_revise")).toContain("last verified result");
		expect(readFileSync(pointer)).toEqual(externalPointer);

		writeFileSync(pointer, reboundPointer);
		const snapshotFile = JSON.parse(readFileSync(requirementsPointer, "utf8")).path;
		const pairFile = JSON.parse(readFileSync(join(cwd, snapshotFile), "utf8")).pair_ref.path;
		writeFileSync(join(cwd, pairFile), "{}");
		const wrongPair = await turn(
			owner,
			"请修订当前方案：调整名称。",
			call("scheme_revise"),
			reply("The confirmed baseline pair is no longer valid"),
		);
		expect(toolError(wrongPair, "scheme_revise")).toContain("current confirmed baseline");
		expect(readFileSync(pointer)).toEqual(reboundPointer);
	},
	30_000,
);
