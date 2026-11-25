import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { expect, test } from "@playwright/test";
import { gitText } from "../fixtures/git";
import { E2E_DATA_DIR, E2E_FAKE_BIN_DIR } from "../fixtures/paths";
import { E2eWire } from "../fixtures/wire";
import { driveTurn, openSeededSession, type WorkflowSession } from "./harness";

const BRIEF = [
	"设计一台用于在常温车间搬运纸箱的手推车。",
	"额定载荷为 80 kg。",
	"整车最大宽度为 600 mm，含把手、车轮和其他突出部件。",
	"每次搬运一只不堆叠的纸箱，最大外形为 400×300×300 mm，单箱质量为 20 至 60 kg。车间现有移载设备负责把纸箱放在车板中部，到达后用移载设备卸货。",
	"单程搬运距离为 20 m，全程为平整的水平混凝土地面，无坡道、台阶、门槛或地沟。直行通道净宽 1.5 m，在一处 2 m×2 m 的开阔区低速转弯 90°，无需原地掉头。",
	"",
].join("\n");
const REQUIREMENTS_CONFIRM = "我确认当前展示的需求。";
const START =
	"请基于当前已确认的需求基线，生成一个正式概念方案：在 RailDesign 的方案工作流内先用整体式固定把手，给出可审阅的最简构型和装载、推行、转向、卸载的功能链。纸箱长宽高、单箱质量范围及路线原样保留在使用工况中，候选参数只列本方案的设计选择。逐项对照基线检查 80 kg 额定载荷和 600 mm 整车宽度上限。尺寸实测、载荷试验和详细计算留到后续，标明当前尚待验证的事项。";
const REVISE =
	"请修订当前方案：在 RailDesign 的方案工作流内把整体式固定把手改为可拆卸结构。继续以原任务书和已确认基线为依据，保留 80 kg 额定载荷、600 mm 整车宽度上限、已知使用条件及其余方案内容。重新核对把手改动影响的概念判断和待验证项，并逐项说明两项整车约束是否受影响。尺寸实测、载荷试验和详细计算留到后续。";
const REVIEW = "我确认当前展示的方案用于审阅。";
const EXPORT = "请导出当前已审阅方案集的 JSON。";
const SKILLS = [
	"requirements-workflow-host",
	"scheme-generation-workflow-host",
	"fbs-transformer",
	"scheme-constraint-checker",
	"json-exporter",
];

interface Receipt {
	artifact_type: string;
	artifact_id: string;
	revision: number;
	schema_version: string;
	content_digest: string;
	committed: boolean;
}

interface Pair<T> {
	document: T;
	receipt: Receipt;
}

interface RequirementsDocument {
	document_type: string;
	document_schema_version: string;
	export_id: string;
	baseline: { baseline_id: string; version: number };
	requirements: {
		requirement_id: string;
		definition: { value: { normalized: unknown; unit: string | null } };
		source_refs: { quote: string; locator: string }[];
	}[];
	document_manifests: { filename: string; content_sha256: string }[];
	provenance: { export_request: { quote: string } };
}

interface CandidateRef {
	concept_scheme_id: string;
	revision: number;
	content_digest: string;
}

interface SchemeDocument {
	document_type: string;
	document_schema_version: string;
	scheme_set_id: string;
	revision: number;
	mode: string;
	source_requirement_baseline_id: string;
	source_requirement_baseline_ref: Receipt;
	schemes: {
		concept_scheme_id: string;
		revision: number;
		architecture: unknown;
		unknowns: { statement: string }[];
	}[];
	design_basis: { unknowns: { statement: string }[] };
	confirmation: {
		purpose: string;
		message_text: string;
		presentation_digest: string;
		candidate_refs: CandidateRef[];
	};
	authorized_candidate_refs: CandidateRef[];
}

interface SchemePresentation {
	presentation_digest: string;
	revision: number;
	candidate_refs: CandidateRef[];
	design: SchemeDocument;
	check_report: {
		status: string;
		candidate_checks: { requirement_results: { requirement_ref: string; status: string }[] }[];
	};
}

interface Delivery {
	path: string;
	bytes: number;
	sha256: string;
}

interface LedgerEntry {
	event?: string;
	number?: number;
}

interface SentRequest extends LedgerEntry {
	event: "sent";
	number: number;
	startedAtMs: number;
	tools: string[];
	reasoning_effort: "none" | "other" | null;
	max_output_tokens: number | null;
}

type Turn = Awaited<ReturnType<typeof driveTurn>> & { requests: SentRequest[] };

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function ledgerEntries(path: string): LedgerEntry[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as LedgerEntry);
}

function sentRequests(entries: LedgerEntry[]): SentRequest[] {
	return entries.filter((entry): entry is SentRequest => entry.event === "sent");
}

function result<T>(turn: Turn, tool: string, ...reasons: string[]) {
	for (const call of turn.log.toolCalls(tool).reverse()) {
		if (!call.result || call.isError) continue;
		const { content } = call.result as { content: { type: string; text?: string }[] };
		const value = JSON.parse(
			content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(""),
		) as T & { reason: string };
		if (reasons.length === 0 || reasons.includes(value.reason)) return { call, value };
	}
	throw new Error(`Expected successful ${tool} ${reasons.join("/")}; see attached turn proof`);
}

function expectDenial(turn: Turn, tool: (name: string) => boolean, explanation: RegExp) {
	const calls = turn.log.toolCalls().filter(({ toolName }) => tool(toolName));
	expect(calls.every(({ isError }) => isError === true)).toBe(true);
	if (calls.length === 0) expect(turn.log.assistantTexts().join("\n")).toMatch(explanation);
}

function terminalApply(turn: Turn, tool: string) {
	const { call } = result(turn, tool, "required_user");
	const effect = turn.snapshot.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === call.toolCallId,
	);
	if (effect?.role !== "toolResult") throw new Error("Missing recorded successful apply");
	const requests = turn.requests.filter((request) => request.tools.includes(tool));
	expect(requests.length).toBeGreaterThan(0);
	for (const request of requests)
		expect(
			request.startedAtMs,
			`provider request ${request.number} must precede ${tool}`,
		).toBeLessThan(effect.timestamp);
	return { appliedAtMs: effect.timestamp, toolCallId: effect.toolCallId, requests };
}

function readDelivery(cwd: string, delivery: Delivery): Buffer {
	expect(isAbsolute(delivery.path)).toBe(false);
	const path = realpathSync(resolve(cwd, delivery.path));
	const confined = relative(realpathSync(cwd), path);
	expect(isAbsolute(confined)).toBe(false);
	expect(confined).not.toMatch(/^\.\.(?:[/\\]|$)/);
	const raw = readFileSync(path);
	expect(raw.length).toBe(delivery.bytes);
	expect(sha256(raw)).toBe(delivery.sha256);
	return raw;
}

function canonicalDigest(python: string, raw: Buffer) {
	return `sha256:${execFileSync(
		python,
		[
			"-B",
			"-c",
			"import hashlib,json,sys; d=json.load(sys.stdin); print(hashlib.sha256(json.dumps(d,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest())",
		],
		{ input: raw, encoding: "utf8" },
	).trim()}`;
}

function generationPointers(cwd: string) {
	const directory = join(cwd, ".generation");
	return existsSync(directory)
		? readdirSync(directory)
				.filter((id) => existsSync(join(directory, id, "current.json")))
				.sort()
		: [];
}

function schemeFiles(cwd: string) {
	const internal = new Set([
		".git",
		".generation",
		".requirements",
		".raildesign",
		"requirements-output",
	]);
	return readdirSync(cwd, { recursive: true })
		.map(String)
		.filter((entry) => entry.endsWith(".json") && !internal.has(entry.split(sep)[0] ?? ""))
		.sort();
}

function assertBasis(design: SchemeDocument, baseline: Pair<RequirementsDocument>) {
	expect(design.mode).toBe("formal");
	expect(design.source_requirement_baseline_id).toBe(baseline.document.baseline.baseline_id);
	expect(design.source_requirement_baseline_ref).toEqual(baseline.receipt);
}

function assertShown(turn: Turn, shown: SchemePresentation, baseline: Pair<RequirementsDocument>) {
	assertBasis(shown.design, baseline);
	expect(shown.design.schemes).toHaveLength(1);
	expect(shown.candidate_refs).toHaveLength(1);
	const candidate = shown.candidate_refs[0];
	if (!candidate) throw new Error("Missing frozen candidate identity");
	expect(shown.design.schemes[0]).toMatchObject({
		concept_scheme_id: candidate.concept_scheme_id,
		revision: candidate.revision,
	});
	const display = turn.log.assistantTexts().at(-1) ?? "";
	expect(display).toContain(`### Concept scheme review · v${shown.revision}`);
	expect(display).toContain(`Reference: \`${shown.presentation_digest}\``);
	expect(display).toContain(candidate.concept_scheme_id);
	const sources = shown.check_report.candidate_checks.flatMap((row) => row.requirement_results);
	expect(
		sources.some(({ requirement_ref }) =>
			baseline.document.requirements.some(
				({ requirement_id }) =>
					requirement_ref.includes(requirement_id) && display.includes(requirement_id),
			),
		),
	).toBe(true);
	const unknowns = [
		...shown.design.design_basis.unknowns,
		...shown.design.schemes.flatMap((s) => s.unknowns),
	];
	expect(unknowns.length).toBeGreaterThan(0);
	expect(
		unknowns.some(({ statement }) =>
			display.includes(statement.replace(/\s+/gu, " ").slice(0, 20)),
		),
		"the frozen review shows a real unknown",
	).toBe(true);
	return candidate;
}

function checkerRuns(cwd: string, id: string) {
	const directory = join(cwd, ".generation", id, "apply");
	return readdirSync(directory).flatMap((name) => {
		const at = (...parts: string[]) => join(directory, name, ...parts);
		if (!existsSync(at("fbs.json")) || !existsSync(at("checker.json"))) return [];
		const fbs = JSON.parse(readFileSync(at("fbs.json"), "utf8")) as { status: string };
		const checker = JSON.parse(
			readFileSync(at("checker.json"), "utf8"),
		) as SchemePresentation["check_report"];
		const processExit = (file: string) =>
			(JSON.parse(readFileSync(at(file), "utf8")) as { exit_code: number }).exit_code;
		return [
			{
				name,
				fbsStatus: fbs.status,
				checker,
				fbsExit: processExit("fbs.json.process.json"),
				checkerExit: processExit("checker.json.process.json"),
			},
		];
	});
}

test(
	"RailDesign reviews and separately exports a revised formal scheme from the same chat's baseline",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		const dist = process.env.RAILDESIGN_E2E_DESIGN_AGENT_DIST;
		test.skip(!dist, "Set RAILDESIGN_E2E_DESIGN_AGENT_DIST to a staged design-agent distribution");
		const ledger = process.env.RAILDESIGN_REQUIREMENTS_LEDGER;
		if (!dist || !ledger)
			throw new Error("The staged distribution and an isolated request ledger are required");
		expect(testInfo.retry).toBe(0);
		expect(testInfo.project.retries).toBe(0);
		test.setTimeout(2_460_000);
		const proof: Record<string, unknown> = {
			sourceCommit: gitText(process.cwd(), "rev-parse", "HEAD").trim(),
			sourceStatus: gitText(process.cwd(), "status", "--porcelain"),
			brief: BRIEF,
		};
		const installed: string[] = [];
		const pythonName = process.platform === "win32" ? "python.exe" : "python3";
		const pythonLink = join(E2E_FAKE_BIN_DIR, pythonName);
		let ownsPython = false;
		let wire = await E2eWire.connect();
		try {
			const suppliedPython = process.env.RAILDESIGN_E2E_REQUIREMENTS_PYTHON;
			if (suppliedPython && !isAbsolute(suppliedPython))
				throw new Error("RAILDESIGN_E2E_REQUIREMENTS_PYTHON must name an absolute executable");
			const python = execFileSync(
				suppliedPython ?? pythonName,
				[
					"-c",
					"import sys; assert sys.version_info >= (3,11), 'Python 3.11+ required'; print(sys.executable)",
				],
				{ encoding: "utf8" },
			).trim();
			if (!existsSync(pythonLink)) {
				symlinkSync(python, pythonLink, "file");
				ownsPython = true;
			}
			const skills = join(E2E_DATA_DIR, "skills");
			mkdirSync(skills, { recursive: true });
			for (const name of SKILLS) {
				const path = join(skills, name);
				expect(existsSync(path)).toBe(false);
				installed.push(path);
				cpSync(join(dist, "skills", name), path, {
					recursive: true,
					force: false,
					errorOnExist: true,
				});
			}
			const session = await openSeededSession(page, wire, (cwd) => {
				writeFileSync(join(cwd, "design-brief.md"), BRIEF);
			});
			proof.session = session;
			const skillCatalog = await wire.request("skills.state", { workspaceId: session.workspaceId });
			proof.skills = skillCatalog.filter((skill) => SKILLS.includes(skill.name));
			const nativeSkills = [
				"requirements-workflow-host",
				"scheme-generation-workflow-host",
				"json-exporter",
			];
			for (const name of nativeSkills)
				expect(skillCatalog).toContainEqual(expect.objectContaining({ name, decision: "load" }));

			const prompt = async (
				step: string,
				text: string,
				target: WorkflowSession = session,
				expectedDenial?: RegExp,
			): Promise<Turn> => {
				const isSchemeDraftTurn = step === "schemeStart" || step === "revision";
				const maxMs = step === "revision" ? 450_000 : isSchemeDraftTurn ? 360_000 : 210_000;
				const requestOffset = sentRequests(ledgerEntries(ledger)).length;
				const drove = await driveTurn(wire, target, text, {
					budget: { maxMs, maxToolCalls: 24 },
					forbid: [
						{
							description: "Use native workflow tools without shell or edits",
							test: (log) =>
								log
									.toolCalls()
									.some(({ toolName }) =>
										["bash", "exec", "apply_patch", "edit", "write"].includes(toolName),
									),
						},
					],
				});
				const entries = ledgerEntries(ledger);
				const turn = { ...drove, requests: sentRequests(entries).slice(requestOffset) };
				proof[step] = { ...turn, log: turn.log.renderTranscript(1600) };
				for (const request of turn.requests) {
					expect(request.reasoning_effort, `Go request ${request.number} effort`).toBeNull();
					if (!request.tools.includes("requirements_prepare")) continue;
					expect(
						request.max_output_tokens,
						`Go workspace request ${request.number} output cap`,
					).toBe(8_192);
					const terminal = entries.find(
						({ number, event }) => number === request.number && event?.startsWith("response."),
					);
					expect(terminal, `Go workspace request ${request.number} terminal event`).toMatchObject({
						event: "response.completed",
					});
				}
				if (expectedDenial && turn.failure === "Turn settled with failed") {
					const cause = turn.snapshot.messages.findLast(
						(item) => item.role === "assistant" && item.stopReason === "error",
					);
					const observed = turn.log
						.toolCalls()
						.some(
							({ toolName, isError, result }) =>
								toolName.startsWith("scheme_") &&
								isError &&
								expectedDenial.test(JSON.stringify(result)),
						);
					if (
						observed &&
						cause?.role === "assistant" &&
						expectedDenial.test(cause.errorMessage ?? "")
					)
						return turn;
				}
				expect(turn.failure, `Turn ${step}: see attached proof`).toBeNull();
				expect(turn.snapshot.summary.state?.completion?.outcome).toBe("succeeded");
				return turn;
			};

			const extraction = await prompt(
				"requirements",
				"请用需求理解工作流梳理 design-brief.md 的概念设计需求。从任务书提取设计目标，并分别列出手推车的 80 kg 额定载荷和 600 mm 整车宽度上限。纸箱外形、质量、装卸方式及路线是已知使用条件，纸箱的长×宽×高要按原文完整保留为一项使用条件。简明列出各项在任务书中的来源，并等待我确认。验证计划留到后续。",
			);
			const reqApply = result<{
				presentation: { presentation_id: string; baseline_version: number };
			}>(extraction, "requirements_apply", "required_user").value;
			expect(extraction.log.assistantTexts().at(-1)).toContain(
				`### Requirements review · v${reqApply.presentation.baseline_version}`,
			);
			expect(extraction.log.assistantTexts().at(-1)).toContain(
				reqApply.presentation.presentation_id,
			);
			expect(extraction.log.assistantTexts().at(-1)).toContain("80 kg");
			expect(extraction.log.assistantTexts().at(-1)).toContain("600 mm");
			proof.requirementsSettlement = terminalApply(extraction, "requirements_apply");
			expect(generationPointers(session.cwd)).toEqual([]);

			const confirm = await prompt("requirementsConfirm", REQUIREMENTS_CONFIRM);
			const { pair: baseline, delivery: baselineDelivery } = result<{
				pair: Pair<RequirementsDocument>;
				delivery: Delivery;
			}>(confirm, "requirements_decide", "complete").value;
			expect(confirm.log.toolCalls().map(({ toolName }) => toolName)).not.toContain("scheme_start");
			expect(generationPointers(session.cwd)).toEqual([]);
			const baselineBytes = readDelivery(session.cwd, baselineDelivery);
			expect(JSON.parse(baselineBytes.toString("utf8"))).toEqual(baseline.document);
			expect(baseline.receipt).toMatchObject({
				artifact_type: "design_requirement_baseline",
				schema_version: "2.0",
				artifact_id: baseline.document.export_id,
				revision: baseline.document.baseline.version,
				content_digest: canonicalDigest(python, baselineBytes),
				committed: true,
			});
			expect(baseline.document.provenance.export_request.quote).toBe(REQUIREMENTS_CONFIRM);
			for (const [value, unit] of [
				[80, "kg"],
				[600, "mm"],
			] as const) {
				const item = baseline.document.requirements.find(
					({ definition }) =>
						definition.value.normalized === value && definition.value.unit === unit,
				);
				expect(
					item?.source_refs.some(
						({ quote, locator }) =>
							quote.includes(String(value)) && BRIEF.includes(quote) && locator.length > 0,
					),
				).toBe(true);
			}
			expect(baseline.document.document_manifests).toContainEqual(
				expect.objectContaining({ filename: "design-brief.md", content_sha256: sha256(BRIEF) }),
			);
			const baselineEvidence = testInfo.outputPath("confirmed-requirement-baseline.json");
			const receiptEvidence = testInfo.outputPath("confirmed-requirement-receipt.json");
			writeFileSync(baselineEvidence, baselineBytes, { flag: "wx", mode: 0o600 });
			writeFileSync(receiptEvidence, JSON.stringify(baseline.receipt), { flag: "wx", mode: 0o600 });
			await testInfo.attach("confirmed-requirement-baseline", {
				path: baselineEvidence,
				contentType: "application/json",
			});
			await testInfo.attach("confirmed-requirement-receipt", {
				path: receiptEvidence,
				contentType: "application/json",
			});
			proof.confirmedBaseline = { pair: baseline, delivery: baselineDelivery };

			const initial = await prompt("schemeStart", START);
			expect(
				initial.requests.some(
					({ tools }) =>
						tools.includes("scheme_start") &&
						tools.includes("scheme_stage") &&
						tools.includes("scheme_apply"),
				),
			).toBe(true);

			const startCall = result<{
				session_id: string;
				run_id: string;
				view: {
					mode: string;
					baseline: Pair<RequirementsDocument>;
					task_scope: { candidate_count: number };
					message: string;
				};
			}>(initial, "scheme_start", "model_work");
			expect(startCall.call.args).toEqual({});
			const started = startCall.value;
			expect(started.view).toMatchObject({
				mode: "formal",
				message: START,
				task_scope: { candidate_count: 1 },
			});
			expect(started.view.baseline).toEqual(baseline);
			expect(started.session_id).toMatch(/^session-[a-f0-9]{16}$/);
			expect(generationPointers(session.cwd)).toEqual([started.session_id]);
			const firstApply = result<{ presentation: SchemePresentation }>(
				initial,
				"scheme_apply",
				"required_user",
			);
			const saved = result<{ draft_binding: string; staged: { digest: string } }>(
				initial,
				"scheme_stage",
				"draft_staged",
			);
			expect(JSON.parse(String(firstApply.call.args.draft_json))).toEqual({
				draft_binding: saved.value.draft_binding,
				staged_digest: saved.value.staged.digest,
			});
			const parts = initial.log.toolCalls("scheme_stage");
			const firstPart = parts[0];
			expect(firstPart?.args.candidate_key).toBeNull();
			expect(Object.keys(JSON.parse(String(firstPart?.args.fields_json)))).toEqual(["functions"]);
			expect(parts.some(({ args }) => typeof args.candidate_key === "string")).toBe(true);
			const first = firstApply.value.presentation;
			const firstRef = assertShown(initial, first, baseline);
			proof.initialSchemeSettlement = terminalApply(initial, "scheme_apply");
			const firstRuns = checkerRuns(session.cwd, started.session_id);
			expect(firstRuns).toContainEqual(
				expect.objectContaining({
					fbsStatus: "valid",
					fbsExit: 0,
					checkerExit: 0,
					checker: first.check_report,
				}),
			);
			proof.firstChecks = firstRuns;

			const current = () =>
				readFileSync(join(session.cwd, ".generation", started.session_id, "current.json"), "utf8");
			const firstPointer = current();
			const progress = await prompt("progress", "请只说明当前方案进度。");
			expect(result(progress, "scheme_status", "status").value).toMatchObject({
				state: "pending",
				presentation_digest: first.presentation_digest,
				baseline_id: baseline.document.baseline.baseline_id,
				baseline_revision: baseline.receipt.revision,
				upstream_current: true,
			});
			expect(current()).toBe(firstPointer);
			expect(schemeFiles(session.cwd)).toEqual([]);

			const revision = await prompt("revision", REVISE);
			expect(result(revision, "scheme_revise", "model_work").value).toMatchObject({
				session_id: started.session_id,
				run_id: started.run_id,
				view: { message: REVISE, baseline },
			});
			const revisedApply = result<{ presentation: SchemePresentation }>(
				revision,
				"scheme_apply",
				"required_user",
			);
			const submission = JSON.parse(String(revisedApply.call.args.draft_json));
			expect(Object.keys(submission).sort()).toEqual(["draft_binding", "revision"]);
			expect(submission.revision.edits.length).toBeGreaterThan(0);
			const revised = revisedApply.value.presentation;
			const revisedRef = assertShown(revision, revised, baseline);
			proof.revisedSchemeSettlement = terminalApply(revision, "scheme_apply");
			expect(revised.presentation_digest).not.toBe(first.presentation_digest);
			expect(revised.revision).toBeGreaterThan(first.revision);
			expect(revisedRef.concept_scheme_id).toBe(firstRef.concept_scheme_id);
			expect(revisedRef.revision).toBeGreaterThan(firstRef.revision);
			expect(revised.design.schemes[0]?.architecture).not.toEqual(
				first.design.schemes[0]?.architecture,
			);
			const revisedRuns = checkerRuns(session.cwd, started.session_id);
			expect(revisedRuns.length).toBeGreaterThan(firstRuns.length);
			expect(revisedRuns).toContainEqual(
				expect.objectContaining({
					fbsStatus: "valid",
					fbsExit: 0,
					checkerExit: 0,
					checker: revised.check_report,
				}),
			);
			proof.revisedChecks = revisedRuns;
			const revisedPointer = current();
			expect(revisedPointer).not.toBe(firstPointer);

			const stale = await prompt(
				"stale",
				`我只想确认用于审阅的旧版，引用 ${first.presentation_digest}。如不能确认，只说明原因，不恢复、不修订当前方案，也不用再问。`,
				session,
				/An explicit scheme review request|Confirm the current displayed (?:candidate|scheme)|stale presentation/i,
			);
			expectDenial(
				stale,
				(name) => name === "scheme_review",
				/失效|无法|不能|不支持|stale|cannot/i,
			);
			expect(current()).toBe(revisedPointer);
			expect(schemeFiles(session.cwd)).toEqual([]);

			const { sessionId: otherId } = await wire.request("session.create", {
				workspaceId: session.workspaceId,
			});
			const other = { ...session, sessionId: otherId };
			const foreign = await prompt(
				"foreign",
				"请查看另一个对话的当前方案并确认用于审阅。如果这里无权查看或确认，只说明原因，不新建任务，不要再追问。",
				other,
				/No formal scheme is attached to this chat|An explicit scheme review request/i,
			);
			expectDenial(
				foreign,
				(name) => name.startsWith("scheme_"),
				/无法|不能|无权|未找到|cannot|no access/i,
			);
			expect(foreign.log.assistantTexts().join("\n")).not.toContain(revised.presentation_digest);
			expect(current()).toBe(revisedPointer);
			expect(generationPointers(session.cwd)).toEqual([started.session_id]);
			expect(schemeFiles(session.cwd)).toEqual([]);
			proof.negativeEffects = {
				pointer: sha256(revisedPointer),
				workspaces: generationPointers(session.cwd),
				files: schemeFiles(session.cwd),
			};

			const redisplay = await prompt("redisplay", "请再展示当前待审阅的方案及来源。");
			result(redisplay, "scheme_status", "status");
			expect(redisplay.log.assistantTexts().at(-1)).toContain(revised.presentation_digest);
			expect(current()).toBe(revisedPointer);
			await wire.request("session.dispose", { sessionId: session.sessionId });
			wire.close();
			wire = await E2eWire.connect();
			const restored = await wire.request("session.getMessages", session);
			proof.restored = restored;
			expect(restored.messages).toEqual(redisplay.snapshot.messages);

			const reviewed = await prompt("review", REVIEW);
			const { pair } = result<{ pair: Pair<SchemeDocument> }>(
				reviewed,
				"scheme_review",
				"complete",
				"stage_result",
			).value;
			expect(reviewed.log.toolCalls("scheme_review").map(({ args }) => args)).toEqual([
				{
					presentation_digest: revised.presentation_digest,
				},
			]);
			expect(reviewed.log.toolCalls("scheme_export")).toEqual([]);
			expect(schemeFiles(session.cwd)).toEqual([]);
			assertBasis(pair.document, baseline);
			expect(pair.document).toMatchObject({
				document_type: "concept_scheme_set",
				document_schema_version: "2.0",
				scheme_set_id: revised.design.scheme_set_id,
				input_sources: [START, REVISE].map((text) => ({ text, sha256: sha256(text) })),
				confirmation: {
					purpose: "review",
					message_text: REVIEW,
					presentation_digest: revised.presentation_digest,
					candidate_refs: revised.candidate_refs,
				},
				authorized_candidate_refs: [],
			});
			expect(pair.document.revision).toBeGreaterThan(revised.revision);
			expect(pair.document.schemes).toEqual(revised.design.schemes);
			expect(pair.receipt).toMatchObject({
				artifact_type: "concept_scheme_set",
				schema_version: "2.0",
				committed: true,
				artifact_id: pair.document.scheme_set_id,
				revision: pair.document.revision,
			});
			proof.reviewed = pair;

			const exported = await prompt("export", EXPORT);
			const exportedResult = result<{ deliveries: Delivery[]; internal_commit: boolean }>(
				exported,
				"scheme_export",
				"delivered",
			).value;
			expect(exportedResult.internal_commit).toBe(true);
			expect(exportedResult.deliveries).toHaveLength(1);
			const delivery = exportedResult.deliveries[0];
			if (!delivery) throw new Error("Missing verified scheme JSON delivery");
			const raw = readDelivery(session.cwd, delivery);
			expect(JSON.parse(raw.toString("utf8"))).toEqual(pair.document);
			expect(canonicalDigest(python, raw)).toBe(pair.receipt.content_digest);
			expect(schemeFiles(session.cwd)).toEqual([delivery.path.split("/").join(sep)]);
			proof.delivery = delivery;
			const schemeEvidence = testInfo.outputPath("reviewed-scheme-export.json");
			writeFileSync(schemeEvidence, raw, { flag: "wx", mode: 0o600 });
			await testInfo.attach("reviewed-scheme-export", {
				path: schemeEvidence,
				contentType: "application/json",
			});
			expect(gitText(session.cwd, "diff", "HEAD", "--", "design-brief.md")).toBe("");
		} finally {
			wire.close();
			proof.requestLedger = readFileSync(ledger, "utf8");
			const evidence = Buffer.from(JSON.stringify(proof, null, 2));
			writeFileSync(testInfo.outputPath("proof.json"), evidence, { flag: "wx", mode: 0o600 });
			for (const path of installed) rmSync(path, { recursive: true, force: true });
			if (ownsPython) rmSync(pythonLink);
			await testInfo.attach("scheme-generation-proof", {
				body: evidence,
				contentType: "application/json",
			});
		}
	},
);
