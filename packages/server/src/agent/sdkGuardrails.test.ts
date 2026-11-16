import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Runner, type RunStreamEvent, StreamedRunResult } from "@openai/agents";
import {
	assistantMessage,
	functionCall,
	modelResponse,
	modelStream,
	modelStreamResponder,
	ScriptedModel,
} from "@openai/agents/testing";
import type { ExtUiRequest, SessionEventPayload } from "@thinkrail/contracts";
import { loadConfig, saveConfig, saveWorkspaces } from "../persistence";
import { configureAgentModelFactory } from "./modelConfiguration";
import {
	abortSession,
	compactSession,
	createSession,
	disposeAllSessions,
	getSessionMessages,
	getSessionState,
	promptSession,
	removeSession,
	resolveExtUi,
	setExtUiPublisher,
	setSessionProjectResolver,
	setSessionPublisher,
	setSessionStatePublisher,
	settleSessionsForShutdown,
} from "./sdkSessionManager";
import { PersistentSession, readSessionRecord } from "./sessionStore";

const KEY = "configured-provider-key-0123456789";
const TOKEN = "ghp_abcdefghijklmnopqrstuv";
let directory: string, cwd: string, data: string;
const envNames = [
	"THINKRAIL_DATA_DIR",
	"OPENAI_BASE_URL",
	"OPENAI_MODEL",
	"OPENAI_API_KEY",
] as const;
let environment: Record<string, string | undefined>;
let frames: SessionEventPayload[];
let dialogs: ExtUiRequest[];
function write(path: string, content: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}
function rules(...list: { name: string; stages: string[]; literal: string }[]) {
	write(join(data, "guardrails.json"), JSON.stringify({ version: 1, rules: list }));
}
beforeEach(() => {
	environment = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
	directory = mkdtempSync(join(tmpdir(), "raildesign-sdk-guardrails-"));
	cwd = join(directory, "worktree");
	data = join(directory, "data");
	mkdirSync(cwd);
	process.env.THINKRAIL_DATA_DIR = data;
	process.env.OPENAI_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
	process.env.OPENAI_MODEL = "deepseek-v4.1-flash";
	process.env.OPENAI_API_KEY = KEY;
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
	frames = [];
	dialogs = [];
	setSessionPublisher((frame) => frames.push(frame));
	setExtUiPublisher((request) => dialogs.push(request));
	write(join(cwd, "config.txt"), `api_key=${KEY}\n`);
	write(join(cwd, "token.txt"), `token=${TOKEN}\n`);
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
const read = (path: string, id: string) => call("read", { path }, id);
const bash = (command: string, id: string) => call("bash", { command, timeoutMs: 1000 }, id);
async function until(check: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Expected asynchronous state");
		await Bun.sleep(5);
	}
}
async function session(model: ScriptedModel) {
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory(() => model);
	return created.sessionId;
}
const prompts = (model: ScriptedModel) =>
	model.calls.map(({ request }) =>
		request.systemInstructions?.includes("ANALYST_PROMPT") ? "ANALYST_PROMPT" : "root",
	);
const requests = (model: ScriptedModel) =>
	model.calls.map(({ request }) => JSON.stringify(request.input));
const history = (sessionId: string) => JSON.stringify(readSessionRecord(sessionId)?.history);
const toolResult = (sessionId: string, callId: string) =>
	readSessionRecord(sessionId)?.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === callId,
	);
const toolEnd = (callId: string) =>
	frames.find(({ event }) => event.type === "tool_execution_end" && event.toolCallId === callId)
		?.event;
function confirmations() {
	return dialogs.filter((request) => request.kind === "confirm");
}
function reply(request: ExtUiRequest, value: boolean) {
	if (request.kind !== "confirm") throw new Error("Expected a confirmation");
	return {
		id: request.id,
		sessionId: request.sessionId,
		runId: request.runId ?? "",
		revision: request.revision ?? 0,
		toolCallId: request.toolCallId ?? "",
		value,
	};
}

test("GA1: a tool result with a configured key or token reaches the model only as the withheld message", async () => {
	const model = new ScriptedModel([
		read("config.txt", "r1"),
		read("token.txt", "r2"),
		done("FINISHED"),
	]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Read the configuration");
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	for (const text of requests(model)) {
		expect(text).not.toContain(KEY);
		expect(text).not.toContain(TOKEN);
	}
	expect(requests(model)[2]).toContain('Tool result withheld by guardrail \\"secret\\"');
	expect(history(sessionId)).not.toContain(KEY);
	expect(history(sessionId)).not.toContain(TOKEN);
	for (const [callId, secret] of [
		["r1", KEY],
		["r2", TOKEN],
	] as const) {
		expect(toolResult(sessionId, callId)).toMatchObject({
			isError: false,
			guardrail: { stage: "output", rule: "secret" },
		});
		expect(JSON.stringify(toolResult(sessionId, callId))).toContain(secret);
		expect(toolEnd(callId)).toMatchObject({
			isError: false,
			guardrail: { stage: "output", rule: "secret" },
		});
	}
	const record = readSessionRecord(sessionId);
	expect(JSON.stringify(record?.effects)).not.toContain(KEY);
	model.assertComplete();
});

test("GA2: a call whose arguments contain a configured key never runs and asks for no approval", async () => {
	const model = new ScriptedModel([
		bash(`printf '${KEY}' > leaked.txt`, "b1"),
		read(KEY, "r1"),
		done("GAVE_UP"),
	]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Store the key");
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	expect(confirmations()).toEqual([]);
	expect(existsSync(join(cwd, "leaked.txt"))).toBe(false);
	for (const callId of ["b1", "r1"]) {
		expect(toolResult(sessionId, callId)).toMatchObject({
			isError: true,
			guardrail: { stage: "input", rule: "secret" },
		});
		expect(JSON.stringify(toolResult(sessionId, callId))).not.toContain(KEY);
	}
	expect(requests(model)[1]).toContain('Tool call rejected by guardrail \\"secret\\"');
	expect(JSON.stringify(readSessionRecord(sessionId)?.effects?.b1)).toBeUndefined();
	model.assertComplete();
});

test("GA4/GA5: rule-file stages act as configured; a user-input rule stops before any model request", async () => {
	rules(
		{ name: "no-codename", stages: ["userInput"], literal: "BLUEBIRD" },
		{ name: "no-delete", stages: ["toolInput"], literal: "rm -rf" },
		{ name: "no-salary", stages: ["toolOutput"], literal: "SALARY" },
	);
	write(join(cwd, "salary.txt"), "SALARY 100\n");
	const model = new ScriptedModel([
		bash("rm -rf build", "b1"),
		read("salary.txt", "r1"),
		done("REPORTED"),
	]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Use BLUEBIRD");
	expect(model.calls).toHaveLength(0);
	expect(getSessionState(sessionId).completion).toMatchObject({
		outcome: "failed",
		failure: "guardrail",
	});
	expect(
		readSessionRecord(sessionId)?.messages.findLast((m) => m.role === "assistant"),
	).toMatchObject({
		stopReason: "guardrail",
		guardrail: "no-codename",
	});
	expect(history(sessionId)).not.toContain("BLUEBIRD");

	await promptSession(sessionId, "Clean up and report");
	expect(model.calls).toHaveLength(3);
	expect(requests(model)[0]).not.toContain("BLUEBIRD");
	expect(confirmations()).toEqual([]);
	expect(toolResult(sessionId, "b1")).toMatchObject({
		guardrail: { stage: "input", rule: "no-delete" },
	});
	expect(toolResult(sessionId, "r1")).toMatchObject({
		guardrail: { stage: "output", rule: "no-salary" },
	});
	expect(requests(model)[2]).not.toContain("SALARY 100");
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	model.assertComplete();
});

test("GA4: a malformed rule file fails the run explicitly before any model request", async () => {
	write(join(data, "guardrails.json"), "{");
	const model = new ScriptedModel([]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Hello");
	expect(model.calls).toHaveLength(0);
	expect(getSessionState(sessionId).completion).toMatchObject({
		outcome: "failed",
		failure: "error",
	});
	const last = readSessionRecord(sessionId)?.messages.findLast((m) => m.role === "assistant");
	expect(last?.role === "assistant" ? last.errorMessage : "").toContain(
		"Invalid guardrail configuration",
	);
});

test("GA8: Handoff targets and delegated children get the same guardrails", async () => {
	write(
		join(data, "agents", "analyst.md"),
		"---\nname: analyst\ndescription: analyst role\ntools: read\n---\nANALYST_PROMPT",
	);
	write(
		join(data, "handoffs.json"),
		JSON.stringify({
			version: 1,
			rootTargets: ["analyst"],
			agents: [{ definition: "analyst", targets: [], history: "all" }],
		}),
	);
	const model = new ScriptedModel([
		call("transfer_to_analyst", { reason: "inspect" }, "h1"),
		read("config.txt", "r1"),
		done("ANALYST_DONE"),
	]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Inspect");
	expect(toolResult(sessionId, "r1")).toMatchObject({
		guardrail: { stage: "output", rule: "secret" },
	});
	expect(requests(model)[2]).not.toContain(KEY);
	expect(prompts(model)).toEqual(["root", "ANALYST_PROMPT", "ANALYST_PROMPT"]);
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");

	rmSync(join(data, "handoffs.json"));
	const parent = new ScriptedModel([
		call(
			"Agent",
			{ subagent_type: "analyst", task: "Read config.txt.", model: null, run_in_background: false },
			"child",
		),
		done("PARENT_DONE"),
	]);
	const child = new ScriptedModel([read("config.txt", "c1"), done("CHILD_REPORT")]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	await promptSession(created.sessionId, "Delegate");
	expect(child.calls).toHaveLength(2);
	expect(requests(child)[1]).not.toContain(KEY);
	expect(requests(child)[1]).toContain("withheld by guardrail");
	expect(requests(parent)[1]).not.toContain(KEY);
	expect(getSessionState(created.sessionId).completion?.outcome).toBe("succeeded");
});

test("GA7: approval restored after restart executes once; a withheld result does not replay", async () => {
	const model = new ScriptedModel([
		bash("printf x >> once.txt; cat token.txt", "b1"),
		done("DONE"),
	]);
	const sessionId = await session(model);
	const running = promptSession(sessionId, "Run it");
	await until(() => getSessionState(sessionId).needsInput?.kind === "dialog");
	await removeSession(sessionId);
	await running;
	expect(existsSync(join(cwd, "once.txt"))).toBe(false);
	await getSessionMessages(sessionId, "workspace", cwd);
	const restored = getSessionState(sessionId).needsInput;
	if (restored?.kind !== "dialog") throw new Error("Missing restored approval");
	const decision = reply(restored.request, true);
	resolveExtUi(decision);
	resolveExtUi(decision);
	await until(() => getSessionState(sessionId).completion?.outcome === "succeeded");
	expect(() => resolveExtUi(decision)).not.toThrow();
	expect(readFileSync(join(cwd, "once.txt"), "utf8")).toBe("x");
	expect(toolResult(sessionId, "b1")).toMatchObject({
		guardrail: { stage: "output", rule: "secret" },
	});
	expect(requests(model)[1]).not.toContain(TOKEN);
	expect(history(sessionId)).not.toContain(TOKEN);

	await removeSession(sessionId);
	await getSessionMessages(sessionId, "workspace", cwd);
	expect(readFileSync(join(cwd, "once.txt"), "utf8")).toBe("x");
	expect(toolResult(sessionId, "b1")).toMatchObject({
		guardrail: { stage: "output", rule: "secret" },
	});
	model.assertComplete();
});

test("GA7: a rejected approval runs nothing and repeated replies keep one decision", async () => {
	const model = new ScriptedModel([bash("printf x >> never.txt", "b1"), done("DENIED")]);
	const sessionId = await session(model);
	const running = promptSession(sessionId, "Try it");
	await until(() => confirmations().length === 1);
	const [request] = confirmations();
	if (!request) throw new Error("Missing approval");
	const decision = reply(request, false);
	resolveExtUi(decision);
	resolveExtUi(decision);
	expect(() => resolveExtUi({ ...decision, value: true })).toThrow("Conflicting");
	await running;
	expect(existsSync(join(cwd, "never.txt"))).toBe(false);
	expect(toolResult(sessionId, "b1")).toMatchObject({ isError: true });
	expect(toolResult(sessionId, "b1")).not.toHaveProperty("guardrail");
	model.assertComplete();
});

test("summaries and later turns read only the withheld model view", async () => {
	const model = new ScriptedModel([
		read("config.txt", "r1"),
		done("FIRST"),
		done("SECOND"),
		done("SUMMARY"),
		done("AFTER"),
	]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Read it");
	await promptSession(sessionId, "Next");
	await compactSession(sessionId, { force: true });
	await promptSession(sessionId, "Again");
	model.assertComplete();
	expect(model.calls[3]?.request.input).toEqual([
		expect.objectContaining({ content: expect.stringContaining("withheld by guardrail") }),
	]);
	for (const text of requests(model)) expect(text).not.toContain(KEY);
	expect(JSON.stringify(toolResult(sessionId, "r1"))).toContain(KEY);
});

const usage = { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const streamed = (deltas: string[], id = "resp") =>
	modelStream([
		...deltas.map((delta) => ({ type: "output_text_delta" as const, delta })),
		{
			type: "response_done" as const,
			response: { id, usage, output: [assistantMessage(deltas.join(""))] },
		},
	]);
const refusal = (text: string) =>
	modelResponse([
		{
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "refusal", refusal: text }],
		},
	]);
const sessionFile = (sessionId: string) =>
	readFileSync(join(data, "sessions", `${sessionId}.json`), "utf8");
const INTRO = "Here is the configuration summary you asked for, in one line: ";

test("GA3a: a key split across deltas is never published or saved; the safe prefix stays", async () => {
	const model = new ScriptedModel([streamed([INTRO, KEY.slice(0, 10), `${KEY.slice(10)} end`])]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Show it");
	expect(getSessionState(sessionId).completion).toMatchObject({
		outcome: "failed",
		failure: "guardrail",
	});
	expect(JSON.stringify(frames)).not.toContain(KEY);
	expect(JSON.stringify(frames)).not.toContain(KEY.slice(0, 10));
	expect(sessionFile(sessionId)).not.toContain(KEY.slice(0, 10));
	const snapshot = await getSessionMessages(sessionId, "workspace", cwd);
	expect(JSON.stringify(snapshot)).not.toContain(KEY.slice(0, 10));
	const last = snapshot.messages.findLast((message) => message.role === "assistant");
	expect(last).toMatchObject({ stopReason: "guardrail", guardrail: "secret" });
	const text =
		last?.role === "assistant" && last.content[0]?.type === "text" ? last.content[0].text : "";
	expect(text.length).toBeGreaterThan(0);
	expect(INTRO.startsWith(text)).toBe(true);
	expect(history(sessionId)).not.toContain(KEY);
});

test("GA3b: a token in a no-delta message or a refusal is blocked before it is saved or published", async () => {
	for (const step of [done(`token ${TOKEN}`), refusal(`I cannot share ${TOKEN}`)]) {
		frames.length = 0;
		const model = new ScriptedModel([step]);
		const sessionId = await session(model);
		await promptSession(sessionId, "Share");
		expect(getSessionState(sessionId).completion).toMatchObject({ failure: "guardrail" });
		expect(JSON.stringify(frames)).not.toContain(TOKEN);
		expect(sessionFile(sessionId)).not.toContain(TOKEN);
		expect(
			readSessionRecord(sessionId)?.messages.findLast((m) => m.role === "assistant"),
		).toMatchObject({
			stopReason: "guardrail",
			guardrail: "secret",
			content: [],
		});
	}
});

test("GA3c: after a blocked turn, history, the next request and a later summary hold no key", async () => {
	const model = new ScriptedModel([
		streamed([INTRO, KEY]),
		done("SECOND"),
		done("THIRD"),
		done("SUMMARY"),
	]);
	const sessionId = await session(model);
	await promptSession(sessionId, "First");
	await promptSession(sessionId, "Second");
	await promptSession(sessionId, "Third");
	await compactSession(sessionId, { force: true });
	model.assertComplete();
	for (const text of requests(model)) expect(text).not.toContain(KEY);
	expect(history(sessionId)).not.toContain(KEY);
	expect(sessionFile(sessionId)).not.toContain(KEY);
	expect(readSessionRecord(sessionId)?.messages.some((m) => m.role === "compactionSummary")).toBe(
		true,
	);
});

test("GA3d: if the SDK writes the turn before the host sees it, the write is refused and history is unchanged", async () => {
	// Delay the host's view of every event until the SDK has finished the turn, including its session write.
	const run = Runner.prototype.run;
	const late = spyOn(Runner.prototype, "run").mockImplementation(async function (
		this: Runner,
		...args: Parameters<Runner["run"]>
	) {
		const result = await run.apply(this, args);
		if (!(result instanceof StreamedRunResult)) return result;
		const iterate = result[Symbol.asyncIterator].bind(result);
		Object.defineProperty(result, Symbol.asyncIterator, {
			value: async function* () {
				const events: RunStreamEvent[] = [];
				try {
					for await (const event of { [Symbol.asyncIterator]: iterate }) events.push(event);
				} finally {
					yield* events;
				}
			},
		});
		return result;
	} as Runner["run"]);
	try {
		const model = new ScriptedModel([done(`final ${KEY}`)]);
		const sessionId = await session(model);
		await promptSession(sessionId, "Show");
		const record = readSessionRecord(sessionId);
		expect(record?.state.completion).toMatchObject({ failure: "guardrail" });
		expect(history(sessionId)).not.toContain(KEY);
		expect(sessionFile(sessionId)).not.toContain(KEY);
		expect(record?.history.some((item) => "role" in item && item.role === "assistant")).toBe(false);
	} finally {
		late.mockRestore();
	}
});

test("GA3e: a literal output rule gates like the built-in rule; an output regex fails to load", async () => {
	rules({ name: "codename", stages: ["finalOutput"], literal: "BLUEBIRD-7" });
	const model = new ScriptedModel([streamed([INTRO, "BLUE", "BIRD-7 is live"])]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Status");
	expect(
		readSessionRecord(sessionId)?.messages.findLast((m) => m.role === "assistant"),
	).toMatchObject({
		stopReason: "guardrail",
		guardrail: "codename",
	});
	expect(JSON.stringify(frames)).not.toContain("BLUEBIRD-7");
	expect(sessionFile(sessionId)).not.toContain("BLUEBIRD-7");

	write(
		join(data, "guardrails.json"),
		JSON.stringify({
			version: 1,
			rules: [{ name: "x", stages: ["finalOutput"], regex: "BLUE.*" }],
		}),
	);
	const next = new ScriptedModel([]);
	const other = await session(next);
	await promptSession(other, "Status");
	expect(next.calls).toHaveLength(0);
	const last = readSessionRecord(other)?.messages.findLast((m) => m.role === "assistant");
	expect(last?.role === "assistant" ? last.errorMessage : "").toContain(
		"finalOutput rules accept literal strings only",
	);
});

test("GA3f: a summary whose output contains a key is not saved and prior history is kept", async () => {
	const model = new ScriptedModel([done("FIRST"), done("SECOND"), done(`summary ${KEY}`)]);
	const sessionId = await session(model);
	await promptSession(sessionId, "One");
	await promptSession(sessionId, "Two");
	const before = readSessionRecord(sessionId)?.history;
	await expect(compactSession(sessionId, { force: true })).rejects.toThrow(
		'Assistant output blocked by guardrail "secret"',
	);
	expect(readSessionRecord(sessionId)?.history).toEqual(before);
	expect(sessionFile(sessionId)).not.toContain(KEY);
	model.assertComplete();
});

test("GA3g: Handoff target and delegated child transcripts are gated the same way", async () => {
	write(
		join(data, "agents", "analyst.md"),
		"---\nname: analyst\ndescription: analyst role\ntools: read\n---\nANALYST_PROMPT",
	);
	write(
		join(data, "handoffs.json"),
		JSON.stringify({
			version: 1,
			rootTargets: ["analyst"],
			agents: [{ definition: "analyst", targets: [], history: "all" }],
		}),
	);
	const model = new ScriptedModel([
		call("transfer_to_analyst", { reason: "inspect" }, "h1"),
		streamed([INTRO, KEY]),
	]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Inspect");
	expect(
		readSessionRecord(sessionId)?.messages.findLast((m) => m.role === "assistant"),
	).toMatchObject({
		stopReason: "guardrail",
		guardrail: "secret",
		agent: "analyst",
	});
	expect(sessionFile(sessionId)).not.toContain(KEY);

	rmSync(join(data, "handoffs.json"));
	frames.length = 0;
	const parent = new ScriptedModel([
		call(
			"Agent",
			{ subagent_type: "analyst", task: "Report.", model: null, run_in_background: false },
			"child",
		),
		done("PARENT_DONE"),
	]);
	const child = new ScriptedModel([streamed([INTRO, TOKEN])]);
	const created = await createSession({ cwd, workspaceId: "workspace" });
	configureAgentModelFactory((_model, id) => (id === created.sessionId ? parent : child));
	await promptSession(created.sessionId, "Delegate");
	expect(JSON.stringify(frames)).not.toContain(TOKEN);
	expect(requests(parent)[1]).toContain('Child output blocked by guardrail \\"secret\\"');
	expect(getSessionState(created.sessionId).completion?.outcome).toBe("succeeded");
	const childRecord = readdirSync(join(data, "sessions"))
		.map((file) => readSessionRecord(file.replace(/\.json$/, "")))
		.find((record) => record?.childRun?.parentSessionId === created.sessionId);
	expect(childRecord?.messages.findLast((m) => m.role === "assistant")).toMatchObject({
		stopReason: "guardrail",
		guardrail: "secret",
	});
	for (const file of readdirSync(join(data, "sessions")))
		expect(readFileSync(join(data, "sessions", file), "utf8")).not.toContain(TOKEN);
});

const KEY_HEAD = KEY.slice(0, 11);
/** A stream that sends the intro and the first part of the key, then waits for Stop or fails. */
const brokenKeyStream = (ending: "stop" | "error") =>
	modelStreamResponder(({ request }) =>
		(async function* () {
			yield { type: "output_text_delta" as const, delta: INTRO };
			yield { type: "output_text_delta" as const, delta: KEY.slice(0, 20) };
			if (ending === "error") throw new Error("connection reset");
			await new Promise<void>((resolve) => {
				if (request.signal?.aborted) resolve();
				else request.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
		})(),
	);

test("a held tail is dropped when a run stops or fails in the middle of a key", async () => {
	for (const ending of ["stop", "error"] as const) {
		frames.length = 0;
		const model = new ScriptedModel([brokenKeyStream(ending)]);
		const sessionId = await session(model);
		const running = promptSession(sessionId, "Show");
		if (ending === "stop") {
			await until(() => frames.some(({ event }) => event.type === "message_update"));
			await abortSession(sessionId);
		}
		await running;
		expect(getSessionState(sessionId).completion?.outcome).toBe(
			ending === "stop" ? "cancelled" : "failed",
		);
		expect(JSON.stringify(frames)).not.toContain(KEY_HEAD);
		expect(sessionFile(sessionId)).not.toContain(KEY_HEAD);
		expect(history(sessionId)).not.toContain(KEY_HEAD);
	}
});

const reasoning = (text: string) => ({
	type: "reasoning" as const,
	content: [{ type: "input_text" as const, text }],
});

test("reasoning text with a key is not published and stops the run", async () => {
	const model = new ScriptedModel([
		modelResponse([reasoning(`the key is ${KEY}`), assistantMessage("ok")]),
	]);
	const sessionId = await session(model);
	await promptSession(sessionId, "Think");
	expect(getSessionState(sessionId).completion).toMatchObject({ failure: "guardrail" });
	expect(JSON.stringify(frames)).not.toContain(KEY);
	expect(sessionFile(sessionId)).not.toContain(KEY);
	expect(history(sessionId)).not.toContain(KEY);
});

test("the session write gate refuses reasoning items with a key", async () => {
	const sessionId = await session(new ScriptedModel([done("FIRST")]));
	await promptSession(sessionId, "Hello");
	const record = readSessionRecord(sessionId);
	if (!record) throw new Error("Missing record");
	const store = new PersistentSession(record);
	store.outputGate = (text) => {
		if (text.includes(KEY)) throw new Error("blocked");
	};
	const before = structuredClone(store.record.history);
	expect(() => store.addItems([reasoning(`see ${KEY}`)])).toThrow("blocked");
	expect(() =>
		store.applyHistoryTransaction({
			operationId: "op-reasoning",
			transaction: { type: "append_items", items: [reasoning(KEY)] },
		}),
	).toThrow("blocked");
	expect(store.record.history).toEqual(before);
});

test("a suffix rewrite is checked only for new content, not older history", async () => {
	const sessionId = await session(new ScriptedModel([done("ALPHA-OLD answer")]));
	await promptSession(sessionId, "Hello");
	const record = readSessionRecord(sessionId);
	if (!record) throw new Error("Missing record");
	const store = new PersistentSession(record);
	store.outputGate = (text) => {
		if (text.includes("ALPHA-OLD")) throw new Error("blocked");
	};
	const suffix = store.record.history.slice(-1);
	await store.applyHistoryTransaction({
		operationId: "op-keep",
		transaction: {
			type: "replace_suffix",
			expectedSuffix: suffix,
			replacement: [...suffix, { role: "user", content: "later" }],
		},
	});
	expect(JSON.stringify(store.record.history)).toContain("later");
	expect(() =>
		store.applyHistoryTransaction({
			operationId: "op-new",
			transaction: {
				type: "replace_suffix",
				expectedSuffix: [],
				replacement: [assistantMessage("ALPHA-OLD again")],
			},
		}),
	).toThrow("blocked");
});

test("each run uses its own policy: a later stricter rule spares older history, a removed rule no longer applies", async () => {
	const model = new ScriptedModel([
		done("ALPHA-OLD answer"),
		done("fine"),
		done("ALPHA-OLD again"),
	]);
	const sessionId = await session(model);
	await promptSession(sessionId, "One");
	rules({ name: "alpha", stages: ["finalOutput"], literal: "ALPHA-OLD" });
	await promptSession(sessionId, "Two");
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	rmSync(join(data, "guardrails.json"));
	await promptSession(sessionId, "Three");
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	model.assertComplete();
});
