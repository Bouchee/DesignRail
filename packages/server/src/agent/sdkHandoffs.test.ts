import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "@openai/agents";
import {
	assistantMessage,
	functionCall,
	modelError,
	modelResponse,
	ScriptedModel,
} from "@openai/agents/testing";
import type { ExtUiRequest, SessionEventPayload, TranscriptMessage } from "@thinkrail/contracts";
import { loadConfig, saveConfig, saveProjects, saveWorkspaces } from "../persistence";
import { configureAgentModelFactory } from "./modelConfiguration";
import {
	abortSession,
	compactSession,
	createSession,
	disposeAllSessions,
	followUpSession,
	getSessionMessages,
	getSessionState,
	promptSession,
	removeSession,
	resolveExtUi,
	respondToTool,
	setExtUiPublisher,
	setSessionProjectResolver,
	setSessionPublisher,
	setSessionSandbox,
	setSessionSandboxMemory,
	setSessionStatePublisher,
	settleSessionsForShutdown,
} from "./sdkSessionManager";
import { PersistentSession, readSessionRecord, writeSessionRecord } from "./sessionStore";

let directory: string, cwd: string, data: string;
const envNames = [
	"THINKRAIL_DATA_DIR",
	"OPENAI_BASE_URL",
	"OPENAI_MODEL",
	"OPENAI_API_KEY",
] as const;
let environment: Record<string, string | undefined>;
function write(path: string, content: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}
const agentFile = (name: string, prompt: string, tools?: string) =>
	`---\nname: ${name}\ndescription: ${name} role\n${tools ? `tools: ${tools}\n` : ""}---\n${prompt}`;
function personalGraph(
	rootTargets: string[],
	agents: [string, string[], ("all" | "without_tools")?][],
) {
	write(
		join(data, "handoffs.json"),
		JSON.stringify({
			version: 1,
			rootTargets,
			agents: agents.map(([definition, targets, history = "all"]) => ({
				definition,
				targets,
				history,
			})),
		}),
	);
}
beforeEach(() => {
	environment = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
	directory = mkdtempSync(join(tmpdir(), "raildesign-sdk-handoffs-"));
	cwd = join(directory, "worktree");
	data = join(directory, "data");
	mkdirSync(cwd);
	process.env.THINKRAIL_DATA_DIR = data;
	process.env.OPENAI_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
	process.env.OPENAI_MODEL = "deepseek-v4.1-flash";
	process.env.OPENAI_API_KEY = "fixture";
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			name: "Test",
			branch: "test",
			baseBranch: "main",
			worktreePath: cwd,
		},
	]);
	saveConfig({
		...loadConfig(),
		disabledExtensions: ["web-access"],
		subagentsEnabled: true,
		subagentMaxConcurrent: 1,
	});
	setSessionProjectResolver(() => "project");
	write(join(data, "agents", "analyst.md"), agentFile("analyst", "ANALYST_PROMPT", "read, search"));
	write(join(data, "agents", "builder.md"), agentFile("builder", "BUILDER_PROMPT", "bash"));
});
afterEach(async () => {
	await settleSessionsForShutdown();
	disposeAllSessions();
	configureAgentModelFactory();
	setExtUiPublisher(() => {});
	setSessionPublisher(() => {});
	setSessionStatePublisher(() => {});
	setSessionProjectResolver(() => null);
	for (const name of envNames) {
		if (environment[name] === undefined) delete process.env[name];
		else process.env[name] = environment[name];
	}
	rmSync(directory, { recursive: true, force: true });
});
const done = (text: string) => modelResponse([assistantMessage(text)]);
const call = (name: string, args: unknown, id: string) =>
	modelResponse([functionCall(name, JSON.stringify(args), { callId: id })]);
const transfer = (to: string, id: string) => call(`transfer_to_${to}`, { reason: `to ${to}` }, id);
const bash = (command: string, id: string) => call("bash", { command, timeoutMs: 1000 }, id);
const prompts = (model: ScriptedModel) =>
	model.calls.map(
		({ request }) =>
			["ANALYST_PROMPT", "BUILDER_PROMPT", "ASKER_PROMPT"].find((prompt) =>
				request.systemInstructions?.includes(prompt),
			) ?? "root",
	);
async function until(check: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Expected asynchronous state");
		await Bun.sleep(5);
	}
}
function approve(request: ExtUiRequest) {
	if (request.kind !== "confirm" || !request.runId || request.revision === undefined) return;
	resolveExtUi({
		id: request.id,
		sessionId: request.sessionId,
		runId: request.runId,
		revision: request.revision,
		toolCallId: request.toolCallId ?? "",
		value: true,
	});
}
function lastError(sessionId: string) {
	const message = readSessionRecord(sessionId)?.messages.findLast(
		(item) => item.role === "assistant",
	);
	return message?.role === "assistant" ? message.errorMessage : undefined;
}
async function session(model: ScriptedModel) {
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory(() => model);
	return created.sessionId;
}

test("declared transfers run root -> analyst -> builder -> root with each definition's scope", async () => {
	personalGraph(
		["analyst"],
		[
			["analyst", ["builder"]],
			["builder", ["$root"]],
		],
	);
	const model = new ScriptedModel([
		transfer("analyst", "h1"),
		transfer("builder", "h2"),
		transfer("DesignRail", "h3"),
		done("ROOT_AGAIN"),
	]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Route the work");
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	expect(prompts(model)).toEqual(["root", "ANALYST_PROMPT", "BUILDER_PROMPT", "root"]);
	const [root, analyst, builder] = model.calls.map(({ request }) => request);
	expect(root?.handoffs.map((item) => item.toolName)).toEqual(["transfer_to_analyst"]);
	expect(root?.tools.map((item) => item.name)).toContain("Agent");
	expect(analyst?.handoffs.map((item) => item.toolName)).toEqual(["transfer_to_builder"]);
	expect(analyst?.tools.map((item) => item.name).sort()).toEqual(["read", "search"]);
	expect(analyst?.systemInstructions).not.toContain("Subagent protocol");
	expect(builder?.handoffs.map((item) => item.toolName)).toEqual(["transfer_to_DesignRail"]);
	expect(builder?.tools.map((item) => item.name)).toEqual(["bash"]);
	const record = readSessionRecord(sessionId);
	expect(record?.handoffs?.activeNode).toBe("$root");
	expect(record?.handoffs?.transfers.map(({ from, to, reason }) => [from, to, reason])).toEqual([
		["$root", "analyst", "to analyst"],
		["analyst", "builder", "to builder"],
		["builder", "$root", "to DesignRail"],
	]);
	model.assertComplete();
});

test("the next prompt and a queued follow-up start at the accepted owner", async () => {
	personalGraph(["analyst"], [["analyst", ["$root"]]]);
	const model = new ScriptedModel([
		transfer("analyst", "h1"),
		done("ANALYST_ANSWER"),
		done("ANALYST_FOLLOW_UP"),
		done("ANALYST_NEXT"),
	]);
	const sessionId = await session(model);
	const running = promptSession(sessionId, "Ask the analyst");
	followUpSession(sessionId, "One more thing");
	await running;
	await until(() => model.calls.length === 3 && getSessionState(sessionId).execution === "idle");
	await promptSession(sessionId, "Next turn");
	expect(prompts(model)).toEqual(["root", "ANALYST_PROMPT", "ANALYST_PROMPT", "ANALYST_PROMPT"]);
	expect(readSessionRecord(sessionId)?.handoffs?.activeNode).toBe("analyst");
	model.assertComplete();
});

test("an undeclared transfer cannot reach its target", async () => {
	personalGraph(
		["analyst"],
		[
			["analyst", ["builder"]],
			["builder", []],
		],
	);
	const model = new ScriptedModel([transfer("builder", "bad")]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Skip the analyst");
	expect(getSessionState(sessionId).completion).toMatchObject({ outcome: "failed" });
	expect(lastError(sessionId)).toContain("transfer_to_builder");
	expect(model.calls).toHaveLength(1);
	expect(readSessionRecord(sessionId)?.handoffs).toMatchObject({
		activeNode: "$root",
		transfers: [],
	});
});

test("an owner write failure stops target work and keeps the previous owner", async () => {
	personalGraph(["analyst"], [["analyst", []]]);
	const model = new ScriptedModel([transfer("analyst", "h1"), done("MUST_NOT_RUN")]);
	const sessionId = await session(model);
	const original = PersistentSession.prototype.update;
	const failing = spyOn(PersistentSession.prototype, "update").mockImplementation(function (
		this: PersistentSession,
		change,
		expected,
	) {
		return original.call(
			this,
			(record) => {
				const before = record.handoffs?.activeNode;
				change(record);
				if (record.handoffs?.activeNode !== before) throw new Error("disk full");
			},
			expected,
		);
	});
	try {
		await promptSession(sessionId, "Transfer");
	} finally {
		failing.mockRestore();
	}
	expect(model.calls).toHaveLength(1);
	const record = readSessionRecord(sessionId);
	expect(record?.state.completion).toMatchObject({ outcome: "failed" });
	expect(lastError(sessionId)).toContain("disk full");
	expect(record?.messages.findLast((item) => item.role === "assistant")).toMatchObject({
		agent: "DesignRail",
	});
	expect(record?.handoffs).toMatchObject({ activeNode: "$root", transfers: [] });
});

test("a target failure and Stop keep the accepted target as owner", async () => {
	personalGraph(["builder"], [["builder", ["$root"]]]);
	const model = new ScriptedModel([
		transfer("builder", "h1"),
		modelError(new Error("builder failed")),
		bash("printf x >> stopped.txt", "b1"),
	]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Transfer");
	expect(getSessionState(sessionId).completion).toMatchObject({ outcome: "failed" });
	expect(lastError(sessionId)).toContain("builder failed");
	expect(readSessionRecord(sessionId)?.handoffs?.activeNode).toBe("builder");
	const running = promptSession(sessionId, "Run it");
	await until(() => getSessionState(sessionId).needsInput?.kind === "dialog");
	expect(readSessionRecord(sessionId)?.pendingApproval?.agentNode).toBe("builder");
	await abortSession(sessionId);
	await running;
	expect(getSessionState(sessionId).completion?.outcome).toBe("cancelled");
	expect(existsSync(join(cwd, "stopped.txt"))).toBe(false);
	expect(readSessionRecord(sessionId)?.handoffs?.activeNode).toBe("builder");
	expect(prompts(model)).toEqual(["root", "BUILDER_PROMPT", "BUILDER_PROMPT"]);
});

test("a target-owned approval restores the full graph after restart and executes once", async () => {
	personalGraph(["builder"], [["builder", ["$root"]]]);
	const model = new ScriptedModel([
		transfer("builder", "h1"),
		bash("printf x >> once.txt", "b1"),
		done("BUILDER_DONE"),
	]);
	const sessionId = await session(model);
	const running = promptSession(sessionId, "Build");
	await until(() => getSessionState(sessionId).needsInput?.kind === "dialog");
	const before = getSessionState(sessionId).needsInput;
	if (before?.kind !== "dialog") throw new Error("Missing approval");
	await removeSession(sessionId);
	await running;
	expect(existsSync(join(cwd, "once.txt"))).toBe(false);
	await getSessionMessages(sessionId, "workspace", cwd);
	const restored = getSessionState(sessionId).needsInput;
	if (restored?.kind !== "dialog") throw new Error("Missing restored approval");
	expect(restored.request.id).toBe(before.request.id);
	approve(restored.request);
	await until(() => getSessionState(sessionId).completion?.outcome === "succeeded");
	expect(readFileSync(join(cwd, "once.txt"), "utf8")).toBe("x");
	expect(prompts(model)).toEqual(["root", "BUILDER_PROMPT", "BUILDER_PROMPT"]);
	expect(readSessionRecord(sessionId)?.handoffs?.activeNode).toBe("builder");
	model.assertComplete();
});

test("a restored approval attributed to another agent fails before its effect", async () => {
	personalGraph(["builder"], [["builder", ["$root"]]]);
	const model = new ScriptedModel([transfer("builder", "h1"), bash("printf x >> no.txt", "b1")]);
	const sessionId = await session(model);
	const running = promptSession(sessionId, "Build");
	await until(() => getSessionState(sessionId).needsInput?.kind === "dialog");
	await removeSession(sessionId);
	await running;
	const record = readSessionRecord(sessionId);
	if (!record?.pendingApproval) throw new Error("Missing saved approval");
	record.pendingApproval.agentNode = "$root";
	writeSessionRecord(record);
	await getSessionMessages(sessionId, "workspace", cwd);
	await until(() => getSessionState(sessionId).execution === "idle");
	expect(getSessionState(sessionId).completion).toMatchObject({ outcome: "failed" });
	expect(lastError(sessionId)).toContain("belongs to another agent");
	expect(existsSync(join(cwd, "no.txt"))).toBe(false);
});

test("definition drift and revoked project trust fail before any model request", async () => {
	personalGraph(["analyst"], [["analyst", []]]);
	const model = new ScriptedModel([]);
	const sessionId = await session(model);
	write(join(data, "agents", "analyst.md"), agentFile("analyst", "CHANGED", "read"));
	await promptSession(sessionId, "Hello");
	expect(model.calls).toHaveLength(0);
	expect(getSessionState(sessionId).completion).toMatchObject({ outcome: "failed" });
	expect(lastError(sessionId)).toContain("Handoff configuration or trust changed");

	saveProjects([
		{ id: "project", name: "P", path: cwd, slug: "p", lastOpened: 1, resourceTrust: "granted" },
	]);
	write(join(cwd, ".raildesign", "agents", "local.md"), agentFile("local", "LOCAL", "read"));
	write(
		join(cwd, ".raildesign", "handoffs.json"),
		JSON.stringify({
			version: 1,
			rootTargets: ["local"],
			agents: [{ definition: "local", targets: [], history: "all" }],
		}),
	);
	const project = await session(model);
	expect(readSessionRecord(project)?.handoffs?.graph.source.scope).toBe("project");
	saveProjects([
		{ id: "project", name: "P", path: cwd, slug: "p", lastOpened: 1, resourceTrust: "untrusted" },
	]);
	await promptSession(project, "Hello");
	expect(model.calls).toHaveLength(0);
	expect(lastError(project)).toContain("Handoff configuration or trust changed");
});

test("a malformed graph reports its own cause, not drift, before any model request", async () => {
	personalGraph(["analyst"], [["analyst", []]]);
	const model = new ScriptedModel([]);
	const sessionId = await session(model);
	write(join(data, "handoffs.json"), "{");
	await promptSession(sessionId, "Hello");
	expect(model.calls).toHaveLength(0);
	expect(getSessionState(sessionId).completion).toMatchObject({ outcome: "failed" });
	expect(lastError(sessionId)).toContain("not valid JSON");
	expect(lastError(sessionId)).not.toContain("changed");
});

test("a hand-edited saved graph that breaks an invariant fails to load", async () => {
	personalGraph(["analyst"], [["analyst", []]]);
	const sessionId = await session(new ScriptedModel([]));
	const path = join(data, "sessions", `${sessionId}.json`);
	const record = JSON.parse(readFileSync(path, "utf8"));
	record.handoffs.graph.nodes[0].targets = ["ghost"];
	writeFileSync(path, JSON.stringify(record));
	expect(() => readSessionRecord(sessionId)).toThrow("Invalid saved handoff graph");
});

test("colliding transfer tool names are rejected before a model request", async () => {
	write(join(data, "agents", "a-b.md"), agentFile("a-b", "AB_DASH"));
	write(join(data, "agents", "a.b.md"), agentFile("a.b", "AB_DOT"));
	personalGraph(
		["a-b", "a.b"],
		[
			["a-b", []],
			["a.b", []],
		],
	);
	const model = new ScriptedModel([]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Hello");
	expect(model.calls).toHaveLength(0);
	expect(lastError(sessionId)).toContain("collides");
});

test("delegated children receive no Handoffs and chats without a graph stay ordinary", async () => {
	personalGraph(["analyst"], [["analyst", []]]);
	const parent = new ScriptedModel([
		call(
			"Agent",
			{ subagent_type: "builder", task: "Report.", model: null, run_in_background: false },
			"child",
		),
		done("PARENT_DONE"),
	]);
	const child = new ScriptedModel([done("CHILD_REPORT")]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	await promptSession(created.sessionId, "Delegate");
	expect(parent.calls[0]?.request.handoffs.map((item) => item.toolName)).toEqual([
		"transfer_to_analyst",
	]);
	expect(child.calls[0]?.request.handoffs).toEqual([]);
	expect(readSessionRecord(created.sessionId)?.handoffs?.activeNode).toBe("$root");

	rmSync(join(data, "handoffs.json"));
	const plain = new ScriptedModel([done("PLAIN")]);
	const ordinary = await session(plain);
	await promptSession(ordinary, "Hello");
	expect(readSessionRecord(ordinary)?.handoffs).toBeUndefined();
	expect(plain.calls[0]?.request.handoffs).toEqual([]);
});

const toolCalls = (input: unknown) =>
	(Array.isArray(input) ? input : []).flatMap((item: { type?: string; callId?: string }) =>
		item.type === "function_call" ? [item.callId] : [],
	);
const inputOf = (model: ScriptedModel, index: number) => model.calls[index]?.request.input;

test.skipIf(process.platform === "win32")(
	"a Sandbox Handoff preserves the specialist's scope and skips saved retained memory",
	async () => {
		personalGraph(["analyst"], [["analyst", ["$root"], "without_tools"]]);
		const model = new ScriptedModel([transfer("analyst", "h1"), done("ANALYST_ANSWER")]);
		const sessionId = await session(model);
		setSessionSandbox(sessionId, true);
		expect(() => setSessionSandboxMemory(sessionId, true)).toThrow(
			"Retained memory is unavailable in Handoff chats",
		);
		await removeSession(sessionId);
		const record = readSessionRecord(sessionId);
		if (!record) throw new Error("Missing fixture session");
		writeSessionRecord({
			...record,
			sandboxMemory: true,
			sandboxArchive: { sessionId, workspaceId: record.workspaceId, cwd: record.cwd, data: "YQ==" },
		});
		await getSessionMessages(sessionId, record.workspaceId, record.cwd);
		expect(getSessionState(sessionId).sandboxMemory).toBeUndefined();
		await promptSession(sessionId, "Ask the analyst");
		model.assertComplete();
		expect(model.calls[0]?.request.tools.map(({ name }) => name)).not.toContain("read_memory");
		expect(model.calls[1]?.request.tools.map(({ name }) => name).sort()).toEqual([
			"read",
			"search",
		]);
		expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	},
);

test("without_tools hides inherited tool records but keeps the target's own exchanges", async () => {
	personalGraph(["builder"], [["builder", ["$root"], "without_tools"]]);
	setExtUiPublisher(approve);
	const model = new ScriptedModel([
		bash("printf r > root.txt", "r1"),
		transfer("builder", "h1"),
		bash("printf b > builder.txt", "b1"),
		transfer("DesignRail", "h2"),
		done("ROOT_SEES_ALL"),
		transfer("builder", "h3"),
		done("BUILDER_NEXT"),
	]);
	const sessionId = await session(model);
	await promptSession(sessionId, "First turn");
	expect(prompts(model)).toEqual(["root", "root", "BUILDER_PROMPT", "BUILDER_PROMPT", "root"]);
	expect(toolCalls(inputOf(model, 2))).toEqual([]);
	expect(JSON.stringify(inputOf(model, 2))).toContain("First turn");
	expect(toolCalls(inputOf(model, 3))).toEqual(["b1"]);
	expect(toolCalls(inputOf(model, 4))).toEqual(["r1", "h1", "b1", "h2"]);
	await promptSession(sessionId, "Second turn");
	expect(toolCalls(inputOf(model, 5))).toEqual(["r1", "h1", "b1", "h2"]);
	expect(toolCalls(inputOf(model, 6))).toEqual([]);
	expect(JSON.stringify(inputOf(model, 6))).toContain("ROOT_SEES_ALL");
	const record = readSessionRecord(sessionId);
	expect(
		record?.history.flatMap((item) => (item.type === "function_call" ? [item.callId] : [])),
	).toEqual(["r1", "h1", "b1", "h2", "h3"]);
	expect(
		record?.history
			.filter((item) => item.type === "function_call_result")
			.map((item) => item.callId),
	).toEqual(["r1", "h1", "b1", "h2", "h3"]);
	await promptSession(sessionId, "Third turn");
	model.assertComplete();
});

test("a without_tools owner keeps its own call across approval resume after restart", async () => {
	personalGraph(["builder"], [["builder", ["$root"], "without_tools"]]);
	const model = new ScriptedModel([
		bash("printf r > root.txt", "r1"),
		transfer("builder", "h1"),
		bash("printf b >> resumed.txt", "b1"),
		done("BUILDER_DONE"),
	]);
	const sessionId = await session(model);
	const requests: ExtUiRequest[] = [];
	setExtUiPublisher((request) => {
		requests.push(request);
		if (request.kind === "confirm" && request.toolCallId === "r1") approve(request);
	});
	const running = promptSession(sessionId, "Build");
	await until(() => readSessionRecord(sessionId)?.pendingApproval?.request.toolCallId === "b1");
	expect(
		requests.find((item) => item.kind === "confirm" && item.toolCallId === "b1"),
	).toMatchObject({ title: "builder: Allow bash?" });
	await removeSession(sessionId);
	await running;
	await getSessionMessages(sessionId, "workspace", cwd);
	const restored = getSessionState(sessionId).needsInput;
	if (restored?.kind !== "dialog") throw new Error("Missing restored approval");
	approve(restored.request);
	await until(() => getSessionState(sessionId).completion?.outcome === "succeeded");
	expect(readFileSync(join(cwd, "resumed.txt"), "utf8")).toBe("b");
	expect(toolCalls(inputOf(model, 3))).toEqual(["b1"]);
	model.assertComplete();
});

test("a restricted view omits summaries of tool history and keeps tool-free summaries", async () => {
	for (const withTool of [true, false]) {
		personalGraph(["builder"], [["builder", ["$root"], "without_tools"]]);
		setExtUiPublisher(approve);
		const summary = withTool ? "SUMMARY_WITH_TOOLS" : "SUMMARY_PLAIN";
		const model = new ScriptedModel([
			...(withTool ? [bash("printf s > summary.txt", "s1")] : []),
			done("a".repeat(800)),
			done("recent"),
			done(summary),
			transfer("builder", "h1"),
			done("BUILDER"),
		]);
		const sessionId = await session(model);
		await promptSession(sessionId, `old fact ${"x".repeat(800)}`);
		await promptSession(sessionId, "recent fact");
		await compactSession(sessionId, { operationId: `summary-${withTool}` });
		expect(readSessionRecord(sessionId)?.summaryOperations[`summary-${withTool}`]?.toolFree).toBe(
			!withTool,
		);
		await promptSession(sessionId, "Transfer now");
		const [root, builder] = model.calls
			.slice(-2)
			.map(({ request }) => JSON.stringify(request.input));
		expect(root).toContain(summary);
		if (withTool) expect(builder).not.toContain(summary);
		else expect(builder).toContain(summary);
		expect(builder).toContain("recent fact");
		model.assertComplete();
	}
});

test("a target-owned question survives restart; stale, cross-session and conflicting replies fail", async () => {
	write(
		join(data, "agents", "asker.md"),
		agentFile("asker", "ASKER_PROMPT", "ask_user_question").replace(
			"---\nASKER",
			"extensions: true\n---\nASKER",
		),
	);
	personalGraph(["asker"], [["asker", ["$root"]]]);
	const args = {
		questions: [
			{
				question: "Which color?",
				header: "Color",
				options: [
					{ label: "Blue", description: "Use blue" },
					{ label: "Red", description: "Use red" },
				],
			},
		],
	};
	const model = new ScriptedModel([
		transfer("asker", "h1"),
		call("ask_user_question", args, "q1"),
		done("ASKER_DONE"),
	]);
	const sessionId = await session(model);
	const other = await createSession({ cwd, workspaceId: "workspace" });
	const running = promptSession(sessionId, "Ask me");
	await until(() => getSessionState(sessionId).needsInput?.kind === "tool-response");
	expect(readSessionRecord(sessionId)?.pendingToolResponse?.agentNode).toBe("asker");
	await removeSession(sessionId);
	await running;
	await getSessionMessages(sessionId, "workspace", cwd);
	const anchor = getSessionState(sessionId).needsInput;
	if (anchor?.kind !== "tool-response") throw new Error("Missing restored question");
	expect(getSessionState(sessionId).activeAgent).toBe("asker");
	const ownership = {
		interactionId: anchor.interactionId,
		runId: anchor.runId,
		revision: anchor.revision,
	};
	const answer = {
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Which color?", kind: "option", answer: "Blue" }],
	};
	expect(() => respondToTool(other.sessionId, "q1", answer, ownership)).toThrow("stale");
	expect(() =>
		respondToTool(sessionId, "q1", answer, { ...ownership, revision: ownership.revision + 1 }),
	).toThrow("stale");
	respondToTool(sessionId, "q1", answer, ownership);
	respondToTool(sessionId, "q1", answer, ownership);
	expect(() => respondToTool(sessionId, "q1", { ...answer, cancelled: true }, ownership)).toThrow(
		"Conflicting",
	);
	await until(() => getSessionState(sessionId).completion?.outcome === "succeeded");
	const record = readSessionRecord(sessionId);
	expect(
		record?.messages.filter(
			(item) => item.role === "custom" && item.customType === "tool-response",
		),
	).toHaveLength(1);
	expect(
		record?.history.filter((item) => item.type === "function_call_result" && item.callId === "q1"),
	).toHaveLength(1);
	expect(prompts(model)).toEqual(["root", "ASKER_PROMPT", "ASKER_PROMPT"]);
	expect(JSON.stringify(inputOf(model, 2))).toContain("Blue");
	model.assertComplete();
});

test("a target approval rejects stale and cross-session replies and applies the original once", async () => {
	personalGraph(["builder"], [["builder", ["$root"]]]);
	const model = new ScriptedModel([
		transfer("builder", "h1"),
		bash("printf x >> approved.txt", "b1"),
		done("BUILDER_DONE"),
	]);
	const sessionId = await session(model);
	const other = await createSession({ cwd, workspaceId: "workspace" });
	const running = promptSession(sessionId, "Build");
	await until(() => getSessionState(sessionId).needsInput?.kind === "dialog");
	await removeSession(sessionId);
	await running;
	await getSessionMessages(sessionId, "workspace", cwd);
	const restored = getSessionState(sessionId).needsInput;
	if (restored?.kind !== "dialog" || restored.request.kind !== "confirm")
		throw new Error("Missing restored approval");
	const { request } = restored;
	const reply = {
		id: request.id,
		sessionId,
		runId: request.runId ?? "",
		revision: request.revision ?? 0,
		toolCallId: "b1",
		value: true,
	};
	expect(() => resolveExtUi({ ...reply, sessionId: other.sessionId })).toThrow();
	expect(() => resolveExtUi({ ...reply, revision: reply.revision + 1 })).toThrow("stale");
	resolveExtUi(reply);
	resolveExtUi(reply);
	expect(() => resolveExtUi({ ...reply, value: false })).toThrow("Conflicting");
	await until(() => getSessionState(sessionId).completion?.outcome === "succeeded");
	expect(readFileSync(join(cwd, "approved.txt"), "utf8")).toBe("x");
	model.assertComplete();
});

test("transfer rows, authorship and the active agent agree live and after reopen", async () => {
	personalGraph(["analyst"], [["analyst", ["$root"]]]);
	const frames: SessionEventPayload[] = [];
	const active: (string | undefined)[] = [];
	setSessionPublisher((frame) => frames.push(frame));
	setSessionStatePublisher((record) => active.push(record.state.activeAgent));
	const model = new ScriptedModel([
		modelResponse([
			assistantMessage("ROOT_ROUTES"),
			functionCall("transfer_to_analyst", JSON.stringify({ reason: "needs analysis" }), {
				callId: "h1",
			}),
		]),
		done("ANALYST_ANSWER"),
	]);
	const sessionId = await session(model);
	expect(getSessionState(sessionId).activeAgent).toBe("DesignRail");
	await promptSession(sessionId, "Analyse");
	expect(getSessionState(sessionId).activeAgent).toBe("analyst");
	expect(active).toContain("analyst");
	const seqs = frames.map((frame) => frame.seq);
	expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
	expect(new Set(seqs).size).toBe(seqs.length);
	const live = new Map<string, TranscriptMessage>();
	for (const { event } of frames)
		if (event.type === "message_end" && "id" in event.message && event.message.id)
			live.set(event.message.id, event.message as TranscriptMessage);
	await removeSession(sessionId);
	const reopened = await getSessionMessages(sessionId, "workspace", cwd);
	expect(reopened.summary.state?.activeAgent).toBe("analyst");
	const transfer = reopened.messages.filter(
		(item) => item.role === "custom" && item.customType === "agent-transfer",
	);
	expect(transfer).toHaveLength(1);
	expect(transfer[0]).toMatchObject({
		details: { from: "DesignRail", to: "analyst", reason: "needs analysis" },
	});
	const id = transfer[0]?.id ?? "";
	expect(live.get(id)).toEqual(transfer[0]);
	const record = readSessionRecord(sessionId);
	expect(transfer[0]).toMatchObject({
		details: { transferId: record?.handoffs?.transfers[0]?.id },
	});
	const authors = reopened.messages.flatMap((item) =>
		item.role === "assistant" && item.content.some((part) => part.type === "text")
			? [[item.agent, item.content.map((part) => (part.type === "text" ? part.text : "")).join("")]]
			: [],
	);
	expect(authors).toEqual([
		["DesignRail", "ROOT_ROUTES"],
		["analyst", "ANALYST_ANSWER"],
	]);
	for (const message of reopened.messages)
		if (message.role === "assistant" && message.id) expect(live.get(message.id)).toEqual(message);
	expect(
		reopened.messages.map((item) => (item.role === "custom" ? item.customType : item.role)),
	).toEqual(["user", "assistant", "agent-transfer", "assistant"]);
	expect(JSON.stringify(reopened)).not.toContain("checkpoint");
});

test("ordinary chats carry no agent identity", async () => {
	const model = new ScriptedModel([done("PLAIN")]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Hello");
	expect(getSessionState(sessionId).activeAgent).toBeUndefined();
	const message = readSessionRecord(sessionId)?.messages.find((item) => item.role === "assistant");
	expect(message && "agent" in message).toBe(false);
});

test("Stop after onHandoff and before the target commit publishes no switch", async () => {
	personalGraph(["builder"], [["builder", ["$root"]]]);
	const frames: SessionEventPayload[] = [];
	const active: (string | undefined)[] = [];
	setSessionPublisher((frame) => frames.push(frame));
	setSessionStatePublisher((record) => active.push(record.state.activeAgent));
	const model = new ScriptedModel([transfer("builder", "h1"), bash("printf x > late.txt", "b1")]);
	const sessionId = await session(model);
	// Hazard: relies on @openai/agents 0.21.0 emitting agent_handoff after onHandoff and before the
	// target's agent_start; the event-order assertion below fails instead of passing vacuously.
	const original = Agent.prototype.emit;
	const events: string[] = [];
	let eventsAtAbort: string[] | undefined;
	let stopping: Promise<void> | undefined;
	const emit = spyOn(Agent.prototype, "emit").mockImplementation(function (
		this: Agent,
		...args: unknown[]
	) {
		events.push(`${String(args[0])}:${this.name}`);
		if (args[0] === "agent_handoff" && !stopping) {
			eventsAtAbort = [...events];
			stopping = abortSession(sessionId);
		}
		return Reflect.apply(original, this, args) as boolean;
	} as typeof original);
	try {
		await promptSession(sessionId, "Transfer");
		await stopping;
	} finally {
		emit.mockRestore();
	}
	expect(stopping).toBeDefined();
	expect(eventsAtAbort?.at(-1)).toStartWith("agent_handoff:");
	expect(eventsAtAbort).not.toContain("agent_start:builder");
	await until(() => getSessionState(sessionId).execution === "idle");
	expect(getSessionState(sessionId).completion?.outcome).toBe("cancelled");
	const record = readSessionRecord(sessionId);
	expect(record?.handoffs).toMatchObject({ activeNode: "$root", transfers: [] });
	expect(
		record?.messages.some((item) => item.role === "custom" && item.customType === "agent-transfer"),
	).toBe(false);
	expect(prompts(model)).toEqual(["root"]);
	expect(existsSync(join(cwd, "late.txt"))).toBe(false);
	await Bun.sleep(50);
	expect(
		frames.some(
			({ event }) =>
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "agent-transfer",
		),
	).toBe(false);
	expect(active).not.toContain("builder");
	expect(getSessionState(sessionId).activeAgent).toBe("DesignRail");
});
