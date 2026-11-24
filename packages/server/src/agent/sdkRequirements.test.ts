import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assistantMessage,
	functionCall,
	modelResponder,
	modelResponse,
	ScriptedModel,
	type ScriptedModelInput,
} from "@openai/agents/testing";
import { saveProjects, saveWorkspaces } from "../persistence";
import { configureAgentModelFactory } from "./modelConfiguration";
import { requirementsDecision } from "./requirementsTools";
import {
	createSession,
	disposeAllSessions,
	ensureSessionAttached,
	promptSession,
	setSessionProjectResolver,
	settleSessionsForShutdown,
} from "./sdkSessionManager";
import { readSessionRecord } from "./sessionStore";

const sid = "session-0123456789abcdef";
const p1 = `presentation-${"1".repeat(32)}`;
const p2 = `presentation-${"2".repeat(32)}`;
const prepare = {
	sources: null,
	include_message: true,
	profile: null,
	segment_start: null,
	requirement_ids: null,
};

const runner = `
from json import dumps, loads
from pathlib import Path
from sys import argv, exit
command, *args = argv[1:]
def option(key):
    return args[args.index(key) + 1]
with Path("runner-calls.jsonl").open("a", encoding="utf-8") as log:
    log.write(dumps(argv[1:], ensure_ascii=False) + "\\n")
state = Path("runner-fixture-presentation")
presentation = state.read_text() if state.exists() else None
def frozen():
    req = {"requirement_id": "requirement-" + "a" * 32, "status": "provisional",
           "definition": {"statement": "Frozen fixture requirement.", "conditions": ["With a fixed load"],
                          "subject": "Fixture", "modality": "must", "content_role": "design_goal", "parameter": {"label": "capacity", "operator": "equals"},
                          "value": {"raw_text": "Four kilograms", "normalized": 4, "unit": "kg"}, "authorization_scope": None},
           "source_refs": [{"locator": "brief.md line 1", "quote": "Exact fixture quote."}]}
    question = {"detail": "Fixture material unspecified.", "question": "What is the fixture material?",
                "next_action": "Provide the material specification.", "blocks_handoff": True}
    return {"presentation_id": presentation, "baseline_version": 2,
            "requirements": [req], "confirmable_ids": [req["requirement_id"]],
            "changes": [], "questions": [question], "candidates": [], "analysis_records": [],
            "assessment": {"findings": [], "issues": []}}
result = {"session_id": "${sid}"}
if command == "prepare":
    result.update(reason="semantic_draft")
elif command == "apply":
    assert option("--exporter-root").endswith("json-exporter")
    draft = loads(Path(option("--draft")).read_text())
    if draft.get("invalid_target"):
        print(dumps({"reason":"blocked", "error":"question_target_invalid"}))
        exit(3)
    presentation = draft["test_presentation"]
    state.write_text(presentation)
    result.update(reason="required_user", presentation=frozen())
elif command == "resume":
    result.update(reason="required_user", presentation=frozen())
elif command == "decide":
    assert option("--session-id") == "${sid}" and option("--presentation-id") == presentation
    result.update(reason="complete")
elif command == "read-view":
    result.update(text="fixture page", next_offset=12, eof=True)
else:
    raise AssertionError(command)
print(dumps(result))
`;

let root: string, cwd: string;
const settings = {
	THINKRAIL_DATA_DIR: "",
	OPENAI_BASE_URL: "https://opencode.ai/inference/go/openai/v1",
	OPENAI_MODEL: "deepseek-v4.1-flash",
	OPENAI_API_KEY: "fixture",
};
let previous: Record<string, string | undefined>;
const trustedProject = () => ({
	id: "project",
	name: "Design fixture",
	slug: "design-fixture",
	path: cwd,
	lastOpened: 1,
	resourceTrust: "granted" as const,
});

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "raildesign-requirements-"));
	cwd = join(root, "worktree");
	mkdirSync(cwd);
	previous = Object.fromEntries(Object.keys(settings).map((name) => [name, process.env[name]]));
	Object.assign(process.env, settings, { THINKRAIL_DATA_DIR: join(root, "data") });
	saveProjects([trustedProject()]);
	saveWorkspaces([
		{
			id: "worktree",
			projectId: "project",
			name: "Design",
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
	for (const [name, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

function install(base: string, skill: string, script: string, content: string) {
	const dir = join(base, skill);
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${skill}\ndescription: Test skill\n---\nTest fixture\n`,
	);
	writeFileSync(join(dir, "scripts", script), content);
}

const done = (text: string) => modelResponse([assistantMessage(text)]);
function call(name: string, args: unknown) {
	return modelResponse([
		functionCall(`requirements_${name}`, JSON.stringify(args), {
			callId: `call-${crypto.randomUUID()}`,
		}),
	]);
}
const apply = (id: string) =>
	call("apply", { draft_json: JSON.stringify({ test_presentation: id }) });
const decide = (id: string) => call("decide", { presentation_id: id, decision: "confirm" });
const display = (id: string) =>
	done(`Requirements under review. Source: brief.md. Display reference: ${id}`);
function executionLog(): string[][] {
	const path = join(cwd, "runner-calls.jsonl");
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
		: [];
}
async function turn(sessionId: string, user: string, ...replies: ScriptedModelInput[]) {
	const model = new ScriptedModel(replies);
	configureAgentModelFactory(() => model);
	await promptSession(sessionId, user);
	model.assertComplete();
	expect(model.calls).toHaveLength(replies.length);
	return model.calls[0]?.request.tools.map((tool) => ("name" in tool ? tool.name : ""));
}

test("requirements decisions accept exact authenticated replies and explicit target IDs", () => {
	expect(requirementsDecision("  我确认当前展示的需求。 ")).toEqual({
		kind: "confirm",
		targets: [],
	});
	const id = `requirement-${"a".repeat(32)}`;
	expect(requirementsDecision(`defer ${id}`)).toEqual({ kind: "defer", targets: [id] });
	expect(requirementsDecision(`采纳 ${id}`)).toEqual({ kind: "confirm", targets: [id] });
	for (const input of [
		"Don't confirm.",
		"Translate 'I confirm the displayed requirements.'",
		"确认？",
		"采纳",
		"确认当前展示的需求，但把质量改成 5 kg",
		`confirm ${id} ${id}`,
	]) {
		expect(requirementsDecision(input)).toBeUndefined();
	}
});

test("a project Skill cannot register the executable tool", async () => {
	install(
		join(cwd, ".raildesign", "skills"),
		"requirements-workflow-host",
		"requirements_runner.py",
		runner,
	);
	const { sessionId } = await createSession({ cwd, workspaceId: "worktree" });
	expect(await turn(sessionId, "Read my brief", done("No tool called"))).not.toContain(
		"requirements_prepare",
	);
	expect(executionLog()).toEqual([]);
});

test.skipIf(!Bun.which(process.platform === "win32" ? "python" : "python3"))(
	"SDK requirements tools enforce user, display, chat and workspace ownership through reattachment",
	async () => {
		const skills = join(root, "data", "skills");
		install(skills, "requirements-workflow-host", "requirements_runner.py", runner);
		install(skills, "json-exporter", "json_exporter.py", "");
		const { sessionId: owner } = await createSession({ cwd, workspaceId: "worktree" });
		const { sessionId: foreign } = await createSession({ cwd, workspaceId: "worktree" });
		expect(
			await turn(
				owner,
				"Review the design brief",
				call("prepare", prepare),
				call("apply", { draft_json: '{"invalid_target":true}' }),
				modelResponder(({ request }) => {
					expect(JSON.stringify(request.input)).toContain("question_target_invalid");
					return apply(p1).response;
				}),
			),
		).toContain("requirements_prepare");
		expect(executionLog().map(([name]) => name)).toEqual(["prepare", "apply", "apply"]);
		const shown = readSessionRecord(owner);
		expect(shown?.state.completion?.outcome).toBe("succeeded");
		expect(shown?.requirements?.displayed?.presentationId).toBe(p1);
		expect(
			JSON.stringify(
				shown?.history.findLast(
					(item) => item.type === "function_call_result" && item.name === "requirements_apply",
				),
			),
		).toContain(p1);
		const reply = shown?.messages.find(
			(message) => message.id === shown.requirements?.displayed?.messageId,
		);
		expect(JSON.stringify(reply)).toContain("Frozen fixture requirement.");
		expect(JSON.stringify(reply)).toContain("Exact fixture quote.");
		expect(JSON.stringify(reply)).toContain("With a fixed load");
		expect(JSON.stringify(reply)).toContain("must Fixture capacity equals 4 kg");
		expect(JSON.stringify(reply)).toContain("What is the fixture material?");
		await turn(
			foreign,
			"I confirm the displayed requirements.",
			decide(p1),
			done("Nothing from this chat"),
		);
		await turn(
			owner,
			"Do not confirm the displayed requirements.",
			decide(p1),
			done("No decision"),
		);
		expect(executionLog().map(([name]) => name)).toEqual(["prepare", "apply", "apply"]);

		await turn(owner, "Use the revised brief", call("prepare", prepare), done("No review shown"));
		expect(readSessionRecord(owner)?.requirements?.displayed).toBeUndefined();
		await turn(
			owner,
			"I confirm the displayed requirements.",
			decide(p2),
			done("Need to show this version"),
		);
		await turn(owner, "Finish the revised brief", apply(p2));
		await turn(
			owner,
			"I confirm the displayed requirements.",
			decide(p1),
			done("Outdated presentation"),
		);
		expect(executionLog().map(([name]) => name)).toEqual([
			"prepare",
			"apply",
			"apply",
			"prepare",
			"apply",
		]);
		await turn(owner, "Show the current requirements", call("resume", {}), display(p2));
		await turn(owner, "An unrelated turn", done("   "));
		await turn(owner, "I confirm the displayed requirements.", decide(p2), done("Show it again"));
		expect(executionLog().filter(([name]) => name === "decide")).toHaveLength(0);

		await turn(
			owner,
			"Show the current requirements",
			call("resume", {}),
			modelResponse([
				assistantMessage(p2),
				{
					id: "rs_fixture_trailing",
					type: "reasoning",
					content: [{ type: "input_text", text: "Trailing model reasoning." }],
				},
			]),
		);
		expect(readSessionRecord(owner)?.messages.at(-1)).toMatchObject({
			id: "rs_fixture_trailing",
			role: "assistant",
			content: [{ type: "thinking", thinking: "Trailing model reasoning." }],
		});
		await settleSessionsForShutdown();
		disposeAllSessions();
		expect(await ensureSessionAttached(owner, "worktree", cwd)).toBe(true);
		await turn(owner, "我确认当前展示的需求。", decide(p2), done("Delivered"));
		expect(executionLog().at(-1)).toContain("--message-text=我确认当前展示的需求。");
		expect(executionLog().filter(([name]) => name === "decide")).toHaveLength(1);

		saveProjects([{ ...trustedProject(), resourceTrust: "untrusted" }]);
		const count = executionLog().length;
		expect(await turn(owner, "Review a new task", done("No project access"))).not.toContain(
			"requirements_prepare",
		);
		expect(executionLog()).toHaveLength(count);
	},
);

for (const stage of ["toolOutput", "finalOutput"]) {
	test.skipIf(!Bun.which(process.platform === "win32" ? "python" : "python3"))(
		`a ${stage} guardrail prevents publishing or confirming a frozen review`,
		async () => {
			const data = join(root, "data");
			const skills = join(data, "skills");
			install(skills, "requirements-workflow-host", "requirements_runner.py", runner);
			install(skills, "json-exporter", "json_exporter.py", "");
			writeFileSync(
				join(data, "guardrails.json"),
				JSON.stringify({
					version: 1,
					rules: [
						{
							name: "protected-review",
							stages: [stage],
							literal:
								stage === "toolOutput"
									? "Frozen fixture requirement."
									: "must Fixture capacity equals 4 kg",
						},
					],
				}),
			);
			const { sessionId } = await createSession({ cwd, workspaceId: "worktree" });
			await turn(
				sessionId,
				"Review the brief",
				call("prepare", prepare),
				apply(p1),
				...(stage === "toolOutput" ? [done(`Review blocked. ${p1}`)] : []),
			);
			const record = readSessionRecord(sessionId);
			expect(record?.requirements?.displayed).toBeUndefined();
			expect(
				JSON.stringify(record?.messages.filter((message) => message.role === "assistant")),
			).not.toContain("Requirements review");
			expect(record?.state.completion?.outcome).toBe(
				stage === "finalOutput" ? "failed" : "succeeded",
			);
		},
	);
}
