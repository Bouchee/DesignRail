import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { gitText } from "../fixtures/git";
import { E2E_DATA_DIR, E2E_FAKE_BIN_DIR } from "../fixtures/paths";
import { E2eWire } from "../fixtures/wire";
import { driveTurn, type EventLog, openSeededSession, type WorkflowSession } from "./harness";

const BRIEF =
	"设计一台用于在常温车间搬运纸箱的手推车。\n额定载荷为 80 kg。\n整车最大宽度为 600 mm。\n";
const REVISION =
	"把额定载荷从 80 kg 改成 90 kg，其他要求保持原样。每次搬一只不堆叠的纸箱，最大外形 400×300×300 mm，行驶路线为平整水平混凝土地面，无门槛。全程没有狭窄通道。";
const CONFIRM = "我确认当前展示的需求。";
const SKILLS = ["requirements-workflow-host", "json-exporter"];
const SHA256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

interface Source {
	source_type: string;
	locator: string;
	quote: string;
	sha256: string;
}
interface Requirement {
	definition: {
		content_role: string;
		statement: string;
		value: { normalized: unknown; unit: string | null };
	};
	source_refs: Source[];
}
interface Presentation {
	presentation_id: string;
	baseline_version: number;
	requirements: Requirement[];
}
interface RunnerResult {
	reason: string;
	session_id?: string;
	presentation?: Presentation;
	pair?: {
		document: {
			document_type: string;
			document_schema_version: string;
			export_id: string;
			baseline: { version: number };
			requirements: Requirement[];
			document_manifests: { filename: string; content_sha256: string }[];
			provenance: { export_request: { quote: string }; confirmation_receipt_ids: string[] };
		};
		receipt: Record<string, unknown>;
	};
	delivery?: { status: string; path: string; sha256: string; bytes: number };
}

function resultOf(log: EventLog, tool: string, reason: string): RunnerResult {
	const result = log
		.toolCalls(tool)
		.flatMap((call) => {
			if (call.isError || !call.result) return [];
			const { content } = call.result as { content: { type: string; text?: string }[] };
			const written = content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
			try {
				const payload = JSON.parse(written) as RunnerResult;
				return payload.reason === reason ? [payload] : [];
			} catch {
				return [];
			}
		})
		.at(-1);
	if (!result) throw new Error(`Expected ${tool} to return ${reason}\n${log.renderTranscript()}`);
	return result;
}

function sentRequests(ledger: string) {
	return readFileSync(ledger, "utf8")
		.trim()
		.split("\n")
		.map(
			(line) =>
				JSON.parse(line) as {
					event?: string;
					number: number;
					startedAtMs: number;
					tools: string[];
				},
		)
		.filter(({ event }) => event === "sent");
}

function expectTerminalApply(
	turn: Awaited<ReturnType<typeof driveTurn>> & { requests: ReturnType<typeof sentRequests> },
) {
	const callId = turn.log
		.toolCalls("requirements_apply")
		.findLast((call) => call.result !== undefined && !call.isError)?.toolCallId;
	const applied = turn.snapshot.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === callId && !message.isError,
	);
	if (applied?.role !== "toolResult") throw new Error("Expected a successful apply result");
	const workspaceRequests = turn.requests.filter(({ tools }) =>
		tools.includes("requirements_apply"),
	);
	expect(workspaceRequests.length).toBeGreaterThan(0);
	for (const request of workspaceRequests)
		expect(
			request.startedAtMs,
			`workspace provider request ${request.number} must precede apply`,
		).toBeLessThan(applied.timestamp);
	return { callId, appliedAtMs: applied.timestamp, lastWorkspaceRequest: workspaceRequests.at(-1) };
}

function expectFacts(
	requirements: Requirement[],
	load: number,
	loadSource: string,
	displayed?: string,
) {
	expect(requirements).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				definition: expect.objectContaining({
					content_role: "design_goal",
					statement: expect.stringMatching(/手推车/),
				}),
			}),
		]),
	);
	for (const [value, unit, source] of [
		[load, "kg", loadSource],
		[600, "mm", BRIEF],
	] as const) {
		const fact = requirements.find(
			(item) => item.definition.value.normalized === value && item.definition.value.unit === unit,
		);
		expect(fact, `${value} ${unit}`).toBeDefined();
		const ref = fact?.source_refs.find(
			(ref) =>
				ref.quote.includes(String(value)) &&
				source.includes(ref.quote) &&
				ref.locator.length > 0 &&
				/^[a-f0-9]{64}$/.test(ref.sha256) &&
				ref.source_type === (source === BRIEF ? "design_document" : "user_message"),
		);
		expect(ref, `source of ${value} ${unit}`).toBeDefined();
		if (displayed && ref) expect(displayed).toContain(`“${ref.quote.replace(/\s+/gu, " ")}”`);
	}
}

function expectFrozenDisplay(
	log: EventLog,
	presentation: Presentation,
	load: number,
	source: string,
) {
	const displayed = log.assistantTexts().at(-1) ?? "";
	expect(displayed).toContain(`### Requirements review · v${presentation.baseline_version}`);
	expect(displayed).toContain(`Reference: \`${presentation.presentation_id}\``);
	expectFacts(presentation.requirements, load, source, displayed);
}

function namesUnder(cwd: string, name: string): string[] {
	const path = join(cwd, name);
	return existsSync(path) ? readdirSync(path, { recursive: true }).map(String).sort() : [];
}

test(
	"DesignRail routes a design brief through revision, restored-chat confirmation and delivery",
	{
		tag: "@agent",
	},
	async ({ page }, testInfo) => {
		const distribution = process.env.RAILDESIGN_E2E_DESIGN_AGENT_DIST;
		test.skip(
			!distribution,
			"Set RAILDESIGN_E2E_DESIGN_AGENT_DIST to a staged design-agent distribution",
		);
		if (!distribution) return;
		test.setTimeout(660_000);
		expect(testInfo.retry).toBe(0);
		expect(testInfo.project.retries).toBe(0);
		const ledger = process.env.RAILDESIGN_REQUIREMENTS_LEDGER;
		if (!ledger) throw new Error("Set RAILDESIGN_REQUIREMENTS_LEDGER to a new disposable path");
		const proof: Record<string, unknown> = {
			sourceCommit: gitText(process.cwd(), "rev-parse", "HEAD").trim(),
			sourceStatus: gitText(process.cwd(), "status", "--porcelain"),
			brief: BRIEF,
			revision: REVISION,
		};
		const installed: string[] = [];
		const pythonName = process.platform === "win32" ? "python.exe" : "python3";
		const pythonLink = join(E2E_FAKE_BIN_DIR, pythonName);
		let installedPython = false;
		let wire = await E2eWire.connect();
		try {
			const pythonExecutable = process.env.RAILDESIGN_E2E_REQUIREMENTS_PYTHON;
			if (pythonExecutable && !isAbsolute(pythonExecutable))
				throw new Error("RAILDESIGN_E2E_REQUIREMENTS_PYTHON must name an absolute executable");
			const python = execFileSync(
				pythonExecutable ?? pythonName,
				[
					"-c",
					"import sys; assert sys.version_info >= (3, 11), 'Python 3.11+ required'; print(sys.executable)",
				],
				{ encoding: "utf8" },
			).trim();
			if (!existsSync(pythonLink)) {
				symlinkSync(python, pythonLink, "file");
				installedPython = true;
			}
			const skills = join(E2E_DATA_DIR, "skills");
			mkdirSync(skills, { recursive: true });
			for (const name of SKILLS) {
				const path = join(skills, name);
				expect(existsSync(path)).toBe(false);
				installed.push(path);
				cpSync(join(distribution, "skills", name), path, {
					recursive: true,
					force: false,
					errorOnExist: true,
				});
			}
			const session = await openSeededSession(page, wire, (cwd) => {
				writeFileSync(join(cwd, "design-brief.md"), BRIEF);
			});
			proof.session = session;
			const skillsState = await wire.request("skills.state", { workspaceId: session.workspaceId });
			proof.skills = skillsState.filter((skill) => SKILLS.includes(skill.name));
			for (const name of SKILLS)
				expect(skillsState).toContainEqual(expect.objectContaining({ name, decision: "load" }));
			const prompt = async (
				target: WorkflowSession,
				step: string,
				message: string,
				expectedDenial?: RegExp,
			) => {
				const requestOffset = sentRequests(ledger).length;
				const result = await driveTurn(wire, target, message, {
					budget: { maxMs: 90_000, maxToolCalls: 24 },
					forbid: [
						{
							description: "A requirement turn must not call shell or edit tools",
							test: (log) =>
								log
									.toolCalls()
									.some(({ toolName }) =>
										["bash", "exec", "apply_patch", "edit", "write"].includes(toolName),
									),
						},
					],
				});
				const turn = { ...result, requests: sentRequests(ledger).slice(requestOffset) };
				proof[step] = { ...turn, log: turn.log.renderTranscript(2000) };
				if (
					expectedDenial &&
					result.failure === "Turn settled with failed" &&
					result.log
						.toolCalls()
						.some(
							(call) =>
								call.toolName.startsWith("requirements_") &&
								call.isError &&
								expectedDenial.test(JSON.stringify(call.result)),
						)
				) {
					const cause = result.snapshot.messages.findLast(
						(item) => item.role === "assistant" && item.stopReason === "error",
					);
					if (cause?.role === "assistant" && expectedDenial.test(cause.errorMessage ?? ""))
						return turn;
				}
				expect(result.failure, result.log.renderTranscript()).toBeNull();
				expect(result.snapshot.summary.state?.completion?.outcome).toBe("succeeded");
				return turn;
			};
			const before = await prompt(
				session,
				"before",
				"请梳理 design-brief.md 的设计需求，列出来源并等待我确认。",
			);
			const prepared = resultOf(before.log, "requirements_prepare", "semantic_draft");
			expect(prepared.session_id).toMatch(/^session-[a-f0-9]{16}$/);
			const first = resultOf(before.log, "requirements_apply", "required_user").presentation;
			if (!first) throw new Error("The initial presentation is missing");
			expectFrozenDisplay(before.log, first, 80, BRIEF);
			proof.firstApplySettlement = expectTerminalApply(before);
			const pointerPath = join(
				session.cwd,
				".requirements",
				prepared.session_id ?? "",
				"current.json",
			);
			const pointer = () => readFileSync(pointerPath, "utf8");
			const baselineFiles = () =>
				namesUnder(session.cwd, "requirements-output").filter((name) => name.endsWith(".json"));
			const initialPointer = pointer();
			expect(baselineFiles()).toEqual([]);

			const progress = await prompt(session, "progress", "当前需求处理到哪一步了？只说明进度。");
			resultOf(progress.log, "requirements_resume", "required_user");
			expect(pointer()).toBe(initialPointer);

			const revision = await prompt(session, "revisionTurn", REVISION);
			const second = resultOf(revision.log, "requirements_apply", "required_user").presentation;
			if (!second) throw new Error("The revised presentation is missing");
			expect(second.presentation_id).not.toBe(first.presentation_id);
			expect(second.baseline_version).toBeGreaterThan(first.baseline_version);
			expectFrozenDisplay(revision.log, second, 90, REVISION);
			proof.revisionApplySettlement = expectTerminalApply(revision);
			const revisedPointer = pointer();
			expect(revisedPointer).not.toBe(initialPointer);

			await prompt(
				session,
				"stale",
				"请仅尝试确认最初展示的 80 kg 旧版。若旧版已失效，只说明原因。保留当前 90 kg 需求，暂不确认，不恢复旧版，不修改任何需求，也不需要再询问。",
				/An explicit matching decision from the current user is required|This version was not the requirements presentation shown/,
			);
			expect(pointer()).toBe(revisedPointer);
			expect(baselineFiles()).toEqual([]);

			const { sessionId: otherId } = await wire.request("session.create", {
				workspaceId: session.workspaceId,
			});
			const other = { ...session, sessionId: otherId };
			proof.other = other;
			await prompt(
				other,
				"foreign",
				"我想确认另一个对话里展示的手推车需求。如果这里不能确认，只说明原因，不要另起任务、不改需求、也不用再问。",
				/No requirements workflow is attached to this chat/,
			);
			expect(pointer()).toBe(revisedPointer);
			expect(baselineFiles()).toEqual([]);
			expect(
				namesUnder(session.cwd, ".requirements").filter((name) =>
					/^session-[a-f0-9]{16}$/.test(name),
				),
			).toEqual([prepared.session_id]);
			proof.negativeEffects = { pointerHash: SHA256(pointer()), deliveryFiles: baselineFiles() };

			const shownAgain = await prompt(session, "redisplay", "请再展示当前待确认的整版需求和来源。");
			expect(resultOf(shownAgain.log, "requirements_resume", "required_user").presentation).toEqual(
				second,
			);
			expectFrozenDisplay(shownAgain.log, second, 90, REVISION);
			expect(pointer()).toBe(revisedPointer);
			const prior = await wire.request("session.getMessages", session);
			await wire.request("session.dispose", { sessionId: session.sessionId });
			wire.close();
			wire = await E2eWire.connect();
			const restored = await wire.request("session.getMessages", session);
			proof.restored = restored;
			expect(restored.messages).toEqual(prior.messages);

			const accepted = await prompt(session, "accepted", CONFIRM);
			const committed = resultOf(accepted.log, "requirements_decide", "complete");
			expect(accepted.log.toolCalls("requirements_decide").map((call) => call.args)).toEqual([
				{ decision: "confirm", presentation_id: second.presentation_id },
			]);
			const { pair, delivery } = committed;
			if (!pair || !delivery) throw new Error("The committed pair or delivery is missing");
			expect(committed.session_id).toBe(prepared.session_id);
			expect(delivery.status).toBe("created");
			expect(delivery.path).toMatch(/^requirements-output[/\\]/);
			expect(isAbsolute(delivery.path)).toBe(false);
			const outputPath = resolve(session.cwd, delivery.path);
			expect(relative(session.cwd, outputPath)).not.toMatch(/^\.\.(?:[/\\]|$)/);
			const output = readFileSync(outputPath);
			expect(delivery.sha256).toBe(SHA256(output));
			expect(delivery.bytes).toBe(output.byteLength);
			expect(JSON.parse(output.toString("utf8"))).toEqual(pair.document);
			expect(pair.document).toMatchObject({
				document_type: "design_requirement_baseline",
				document_schema_version: "2.0",
				provenance: { export_request: { quote: CONFIRM } },
			});
			expect(pair.document.document_manifests).toContainEqual(
				expect.objectContaining({ filename: "design-brief.md", content_sha256: SHA256(BRIEF) }),
			);
			expect(pair.document.provenance.confirmation_receipt_ids).toHaveLength(1);
			expect(pair.receipt).toMatchObject({
				committed: true,
				artifact_type: pair.document.document_type,
				schema_version: pair.document.document_schema_version,
				artifact_id: pair.document.export_id,
				revision: pair.document.baseline.version,
				content_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			});
			expectFacts(pair.document.requirements, 90, REVISION);
			expect(baselineFiles()).toHaveLength(1);

			const deliveredPointer = pointer();
			const repeat = await prompt(session, "repeat", "请再给我刚才确认的基线 JSON。");
			expect(resultOf(repeat.log, "requirements_export", "complete").delivery).toEqual({
				...delivery,
				status: "reused",
			});
			expect(readFileSync(outputPath)).toEqual(output);
			expect(baselineFiles()).toHaveLength(1);
			expect(pointer()).toBe(deliveredPointer);
			proof.delivered = { pair, delivery };
			proof.briefDiff = gitText(session.cwd, "diff", "HEAD", "--", "design-brief.md");
			expect(proof.briefDiff).toBe("");
		} finally {
			wire.close();
			proof.requestLedger = readFileSync(ledger, "utf8");
			for (const path of installed) rmSync(path, { recursive: true, force: true });
			if (installedPython) rmSync(pythonLink);
			await testInfo.attach("requirements-agent-proof", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify(proof, null, 2)),
			});
		}
	},
);
