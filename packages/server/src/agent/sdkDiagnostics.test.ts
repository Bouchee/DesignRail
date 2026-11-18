import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	Agent,
	type AgentOutputType,
	getGlobalTraceProvider,
	NoopTrace,
	RunContext,
	Runner,
	setTracingDisabled,
	tool,
	withTrace,
} from "@openai/agents";
import {
	assistantMessage,
	functionCall,
	modelError,
	modelResponder,
	modelResponse,
	ScriptedModel,
} from "@openai/agents/testing";
import { z } from "zod";
import { loadConfig, saveConfig, saveWorkspaces } from "../persistence";
import { loadGuardrailPolicy } from "./guardrails";
import {
	attachAgentDiagnostics,
	attachRunDiagnostics,
	configureLocalSdkTracing,
	traceRunOptions,
} from "./localTracing";
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
	settleSessionsForShutdown,
} from "./sdkSessionManager";
import { listSessionRecords, readSessionRecord } from "./sessionStore";

if (process.env.RAILDESIGN_DIAGNOSTICS_CASES === "1") {
	const KEY = "configured-diagnostic-key-0123456789";
	const SHORT_KEY = "p4ss";
	const TOKEN = "ghp_abcdefghijklmnopqrstuv";
	let root: string, cwd: string, data: string;
	let environment: Record<string, string | undefined>;
	let initiallyDisabled: boolean;
	let output: string[];
	let stderr: ReturnType<typeof spyOn<typeof process.stderr, "write">>;
	let network: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
	const envNames = [
		"THINKRAIL_DATA_DIR",
		"OPENAI_API_KEY",
		"OPENAI_BASE_URL",
		"OPENAI_MODEL",
	] as const;
	interface RecordEntry {
		event: string;
		[key: string]: unknown;
	}
	function records(): RecordEntry[] {
		return output.flatMap((line) => {
			const at = line.indexOf("[sdk-trace] ");
			return at < 0 ? [] : [JSON.parse(line.slice(at + 12)) as RecordEntry];
		});
	}
	function write(path: string, value: string) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, value);
	}
	const done = (text = "done") => modelResponse([assistantMessage(text)]);
	const call = (name: string, args: unknown, callId: string) =>
		modelResponse([functionCall(name, JSON.stringify(args), { callId })]);
	beforeEach(() => {
		environment = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
		root = mkdtempSync(join(tmpdir(), "raildesign-diagnostics-"));
		cwd = join(root, "worktree");
		data = join(root, "data");
		mkdirSync(cwd);
		process.env.THINKRAIL_DATA_DIR = data;
		process.env.OPENAI_API_KEY = KEY;
		process.env.OPENAI_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
		process.env.OPENAI_MODEL = "deepseek-v4.1-flash";
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
			sdkTracingEnabled: true,
			disabledExtensions: ["web-access"],
			subagentsEnabled: true,
			subagentMaxConcurrent: 1,
		});
		setSessionProjectResolver(() => "project");
		initiallyDisabled =
			getGlobalTraceProvider().createTrace({ name: "Probe" }) instanceof NoopTrace;
		setTracingDisabled(false);
		configureLocalSdkTracing();
		output = [];
		stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
			output.push(String(chunk));
			return true;
		});
		const reject = () => {
			throw new Error("Diagnostics must not contact a provider or exporter");
		};
		network = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(reject, { preconnect: reject }),
		);
	});
	afterEach(async () => {
		await settleSessionsForShutdown();
		disposeAllSessions();
		configureAgentModelFactory();
		setExtUiPublisher(() => {});
		setSessionProjectResolver(() => null);
		expect(network).not.toHaveBeenCalled();
		network.mockRestore();
		stderr.mockRestore();
		setTracingDisabled(initiallyDisabled);
		for (const name of envNames) {
			const value = environment[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	async function until(check: () => boolean) {
		const deadline = Date.now() + 3000;
		while (!check()) {
			if (Date.now() > deadline) throw new Error("Expected diagnostic test state");
			await Bun.sleep(5);
		}
	}
	function assertClosed(entries = records()) {
		const starts = entries.filter(
			(r) =>
				r.event === "lifecycle" && (r.lifecycle === "agent.start" || r.lifecycle === "tool.start"),
		);
		expect(entries.some((r) => r.lifecycle === "run.end")).toBe(true);
		for (const start of starts) {
			const ends = entries.filter(
				(r) =>
					r.event === "lifecycle" &&
					r.sessionId === start.sessionId &&
					r.runId === start.runId &&
					r.itemId === start.itemId &&
					(r.lifecycle === "agent.end" || r.lifecycle === "tool.end"),
			);
			expect(ends).toHaveLength(1);
		}
	}

	test("LA1: root, native child, Handoff and tool diagnostics preserve trace nesting and application identity", async () => {
		write(
			join(data, "agents", "analyst.md"),
			"---\nname: analyst\ndescription: Read a file\ntools: read\n---\nANALYST_PROMPT",
		);
		write(
			join(data, "handoffs.json"),
			JSON.stringify({
				version: 1,
				rootTargets: ["analyst"],
				agents: [{ definition: "analyst", targets: [], history: "all" }],
			}),
		);
		write(join(cwd, "fixture.txt"), "private file result");
		const session = await createSession({ cwd, workspaceId: "workspace" });
		const parent = new ScriptedModel([
			call(
				"Agent",
				{ subagent_type: "worker", task: "Inspect fixture", model: null, run_in_background: false },
				"child-call",
			),
			call("transfer_to_analyst", { reason: "Inspect" }, "transfer"),
			call("read", { path: "fixture.txt" }, "target-read"),
			done(),
		]);
		const child = new ScriptedModel([
			call("read", { path: "fixture.txt" }, "child-read"),
			done("child report"),
		]);
		configureAgentModelFactory((_model, id) => (id === session.sessionId ? parent : child));
		await promptSession(session.sessionId, "Delegate then hand off");
		await getGlobalTraceProvider().forceFlush();
		const entries = records();
		const trace = entries.find((r) => r.event === "trace.end" && r.sessionId === session.sessionId);
		expect(trace).toMatchObject({
			groupId: session.sessionId,
			workspaceId: "workspace",
			startNodeId: "$root",
		});
		const childRecord = listSessionRecords().find(
			(r) => r.childRun?.parentSessionId === session.sessionId,
		);
		expect(childRecord).toBeDefined();
		const childSpan = entries.find(
			(r) =>
				r.event === "span.end" &&
				r.type === "function" &&
				r.name === "read" &&
				r.sessionId === childRecord?.sessionId,
		);
		expect(childSpan).toMatchObject({
			parentSessionId: session.sessionId,
			traceId: trace?.traceId,
		});
		expect(entries.some((r) => r.event === "span.end" && r.spanId === childSpan?.parentId)).toBe(
			true,
		);
		expect(entries).toContainEqual(
			expect.objectContaining({
				event: "lifecycle",
				lifecycle: "handoff",
				from: "RailDesign",
				to: "analyst",
			}),
		);
		expect(entries).toContainEqual(
			expect.objectContaining({
				event: "lifecycle",
				lifecycle: "tool.start",
				agent: "analyst",
				callId: "target-read",
			}),
		);
		expect(entries).toContainEqual(
			expect.objectContaining({
				event: "lifecycle",
				lifecycle: "run.end",
				sessionId: childRecord?.sessionId,
				outcome: "success",
			}),
		);
		assertClosed();
		parent.assertComplete();
		child.assertComplete();
		expect(JSON.stringify(entries)).not.toContain("private file result");
		expect(readSessionRecord(session.sessionId)?.effects["target-read"]?.status).toBe("completed");
	});

	test("LA2: span allowlist removes payloads and arbitrary metadata; all allowed strings and errors redact before bounding", async () => {
		const ids = {
			sessionId: "session",
			runId: "run",
			workspaceId: "workspace",
			startNodeId: "$root",
		};
		const policy = loadGuardrailPolicy({
			dataDir: data,
			projectTrusted: false,
			credentials: [KEY, SHORT_KEY],
		});
		const runner = new Runner(traceRunOptions(ids));
		const diag = attachRunDiagnostics(runner, ids, policy.redact);
		await diag.run(() =>
			withTrace(KEY, async (trace) => {
				trace.metadata = { ...ids, unexpected: KEY };
				for (const data of [
					{ type: "agent" as const, name: KEY, tools: [KEY], handoffs: [KEY] },
					{
						type: "function" as const,
						name: KEY,
						input: `private argument ${KEY}`,
						output: `private result ${KEY}`,
					},
					{ type: "handoff" as const, from_agent: KEY, to_agent: TOKEN },
					{ type: "guardrail" as const, name: KEY, triggered: true },
					{ type: "task" as const, name: SHORT_KEY },
					{
						type: "generation" as const,
						model: KEY,
						input: [{ text: KEY }],
						output: [{ text: KEY }],
						model_config: { secret: KEY },
						usage: { input_tokens: 4, output_tokens: 2, details: { secret: KEY }, secret: KEY },
					},
				]) {
					const span = getGlobalTraceProvider().createSpan({ data }, trace);
					span.start();
					span.setError({
						message:
							data.type === "task"
								? `failure ${SHORT_KEY}`
								: `${"x".repeat(249)} ${data.type === "handoff" ? TOKEN : KEY}`,
						data: { secret: KEY },
					});
					span.end();
				}
			}),
		);
		await diag.close("error");
		await diag.close("success");
		const entries = records();
		const raw = JSON.stringify(entries);
		for (const secret of [
			KEY,
			SHORT_KEY,
			TOKEN,
			"private argument",
			"private result",
			"model_config",
			"unexpected",
		])
			expect(raw).not.toContain(secret);
		for (const span of entries.filter((r) => r.event === "span.end"))
			expect(span.error).toBe(span.type === "handoff" ? `${"x".repeat(249)} ***` : "***");
		expect(entries).toContainEqual(
			expect.objectContaining({
				type: "generation",
				model: "***",
				usage: { input_tokens: 4, output_tokens: 2 },
			}),
		);
		expect(entries.filter((r) => r.lifecycle === "run.end")).toHaveLength(1);
	});

	for (const name of [KEY, TOKEN])
		test("Handoff identity redacts configured credentials and tokens on the next run", async () => {
			write(
				join(data, "agents", `${name}.md`),
				`---\nname: ${name}\ndescription: fixture\n---\nInspect`,
			);
			write(
				join(data, "handoffs.json"),
				JSON.stringify({
					version: 1,
					rootTargets: [name],
					agents: [{ definition: name, targets: [], history: "all" }],
				}),
			);
			const session = await createSession({ cwd, workspaceId: "workspace" });
			const model = new ScriptedModel([
				modelResponder(({ request }) => {
					const target = request.handoffs[0];
					if (!target) throw new Error("Missing Handoff");
					return [functionCall(target.toolName, { reason: "Inspect" }, { callId: "transfer" })];
				}),
				done(),
				done(),
			]);
			configureAgentModelFactory(() => model);
			await promptSession(session.sessionId, "handoff");
			await promptSession(session.sessionId, "continue");
			expect(records()).toContainEqual(
				expect.objectContaining({ event: "trace.end", startNodeId: "***" }),
			);
			expect(JSON.stringify(records())).not.toContain(name);
			assertClosed();
		});

	test("LA2: public session diagnostics exclude secret prompt, tool argument/result and final output", async () => {
		write(join(cwd, "private.txt"), `private result ${KEY}`);
		const model = new ScriptedModel([
			call("read", { path: "private.txt", unused: KEY }, "rejected-secret"),
			call("read", { path: "private.txt" }, "private-read"),
			done(`private final ${KEY}`),
		]);
		configureAgentModelFactory(() => model);
		const session = await createSession({ cwd, workspaceId: "workspace" });
		await promptSession(session.sessionId, `private prompt ${KEY}`);
		const raw = JSON.stringify(records());
		for (const text of [KEY, "private prompt", "private final", "private result", "private.txt"])
			expect(raw).not.toContain(text);
		expect(records()).toContainEqual(
			expect.objectContaining({ lifecycle: "run.end", outcome: "guardrail" }),
		);
		assertClosed();
	});

	test("LA3: disabled tracing writes no trace, span or lifecycle diagnostics", async () => {
		saveConfig({ ...loadConfig(), sdkTracingEnabled: false });
		const session = await createSession({ cwd, workspaceId: "workspace" });
		const parent = new ScriptedModel([
			call(
				"Agent",
				{ subagent_type: "worker", task: "Inspect", model: null, run_in_background: false },
				"child",
			),
			done("a".repeat(600)),
			done(),
			done("summary"),
		]);
		const child = new ScriptedModel([done()]);
		configureAgentModelFactory((_model, id) => (id === session.sessionId ? parent : child));
		await promptSession(session.sessionId, `disabled ${"x".repeat(600)}`);
		await promptSession(session.sessionId, "recent");
		await compactSession(session.sessionId);
		expect(records()).toEqual([]);
		parent.assertComplete();
		child.assertComplete();
	});

	for (const outcome of ["error", "guardrail", "length"] as const)
		test(`LA4: public run ${outcome} closes open lifecycle items once`, async () => {
			if (outcome === "guardrail")
				write(
					join(data, "guardrails.json"),
					JSON.stringify({
						version: 1,
						rules: [{ name: "deny", stages: ["userInput"], literal: "deny" }],
					}),
				);
			write(join(cwd, "fixture.txt"), "fixture");
			const model = new ScriptedModel(
				outcome === "error"
					? [modelError(new Error(`private provider error ${TOKEN}`))]
					: outcome === "length"
						? Array.from({ length: 51 }, (_, i) =>
								call("read", { path: "fixture.txt" }, `read-${i}`),
							)
						: [done()],
			);
			configureAgentModelFactory(() => model);
			const session = await createSession({ cwd, workspaceId: "workspace" });
			await promptSession(session.sessionId, outcome === "guardrail" ? "deny" : "go");
			expect(records()).toContainEqual(expect.objectContaining({ lifecycle: "run.end", outcome }));
			assertClosed();
			expect(JSON.stringify(records())).not.toContain(TOKEN);
		});

	test("LA4: Stop closes an agent that never reaches its SDK end", async () => {
		let entered = false;
		const model = new ScriptedModel([
			modelResponder(async ({ request }) => {
				entered = true;
				await new Promise<void>((_resolve, reject) =>
					request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
						once: true,
					}),
				);
				return [assistantMessage("done")];
			}),
		]);
		configureAgentModelFactory(() => model);
		const session = await createSession({ cwd, workspaceId: "workspace" });
		const run = promptSession(session.sessionId, "wait");
		await until(() => entered);
		await abortSession(session.sessionId);
		await run;
		expect(records()).toContainEqual(
			expect.objectContaining({ lifecycle: "agent.end", outcome: "cancel" }),
		);
		assertClosed();
	});

	for (const outcome of ["error", "length", "cancel", "guardrail"] as const)
		test(`native child diagnostics close as ${outcome} without taking parent trace ownership`, async () => {
			const session = await createSession({ cwd, workspaceId: "workspace" });
			let entered = false;
			write(join(cwd, "fixture.txt"), "fixture");
			const parent = new ScriptedModel([
				call(
					"Agent",
					{ subagent_type: "worker", task: "Inspect", model: null, run_in_background: false },
					"child-call",
				),
				done(),
			]);
			const child = new ScriptedModel(
				outcome === "error"
					? [modelError(new Error("child failed"))]
					: outcome === "length"
						? Array.from({ length: 21 }, (_, i) =>
								call("read", { path: "fixture.txt" }, `child-${i}`),
							)
						: outcome === "guardrail"
							? [done(KEY)]
							: [
									modelResponder(async ({ request }) => {
										entered = true;
										await new Promise<void>((_resolve, reject) =>
											request.signal?.addEventListener(
												"abort",
												() => reject(new Error("cancelled")),
												{ once: true },
											),
										);
										return [assistantMessage("done")];
									}),
								],
			);
			configureAgentModelFactory((_model, id) => (id === session.sessionId ? parent : child));
			const run = promptSession(session.sessionId, "delegate");
			if (outcome === "cancel") {
				await until(() => entered);
				await abortSession(session.sessionId);
			}
			await run;
			const childRecord = listSessionRecords().find(
				(r) => r.childRun?.parentSessionId === session.sessionId,
			);
			expect(records()).toContainEqual(
				expect.objectContaining({
					lifecycle: "run.end",
					sessionId: childRecord?.sessionId,
					outcome,
				}),
			);
			const parentTrace = records().find(
				(r) => r.event === "trace.end" && r.sessionId === session.sessionId,
			);
			expect(parentTrace).toMatchObject({ groupId: session.sessionId });
			expect(
				records().filter((r) => r.event === "trace.end" && r.sessionId === childRecord?.sessionId),
			).toHaveLength(0);
			expect(records()).toContainEqual(
				expect.objectContaining({ lifecycle: "tool.end", tool: "Agent" }),
			);
			assertClosed();
		});

	test("native child input tripwire logs guardrail without making a child model request", async () => {
		write(
			join(data, "guardrails.json"),
			JSON.stringify({
				version: 1,
				rules: [{ name: "deny-child", stages: ["userInput"], literal: "child-only" }],
			}),
		);
		const session = await createSession({ cwd, workspaceId: "workspace" });
		const parent = new ScriptedModel([
			call(
				"Agent",
				{ subagent_type: "worker", task: "child-only", model: null, run_in_background: false },
				"child",
			),
			done(),
		]);
		const child = new ScriptedModel([done("must not run")]);
		configureAgentModelFactory((_model, id) => (id === session.sessionId ? parent : child));
		await promptSession(session.sessionId, "delegate");
		expect(child.calls).toHaveLength(0);
		const childRecord = listSessionRecords().find(
			(r) => r.childRun?.parentSessionId === session.sessionId,
		);
		expect(records()).toContainEqual(
			expect.objectContaining({
				lifecycle: "run.end",
				sessionId: childRecord?.sessionId,
				outcome: "guardrail",
			}),
		);
		const spans = records().filter(
			(r) =>
				r.type === "guardrail" && r.name === "deny-child" && r.sessionId === childRecord?.sessionId,
		);
		expect(spans).toHaveLength(1);
		expect(spans[0]?.triggered).toBe(true);
	});

	for (const outcome of ["allow", "block", "throw"] as const)
		test(`native child guardrail observation preserves ${outcome}, execution count and restoration`, async () => {
			const result = { tripwireTriggered: outcome === "block", outputInfo: { fixture: true } };
			const failure = new Error("guardrail failed");
			let calls = 0;
			let received: unknown;
			const agent = new Agent({
				name: "observer",
				inputGuardrails: [
					{
						name: "original",
						async execute(args: unknown) {
							calls += 1;
							received = args;
							if (outcome === "throw") throw failure;
							return result;
						},
					},
				],
			});
			const original = agent.inputGuardrails;
			const policy = loadGuardrailPolicy({
				dataDir: data,
				projectTrusted: false,
				credentials: [KEY],
			});
			const diagnostic = attachAgentDiagnostics(
				agent,
				{ sessionId: "child", runId: "run", workspaceId: "workspace", startNodeId: "$root" },
				policy.redact,
			);
			const observed = agent.inputGuardrails[0];
			if (!observed) throw new Error("Missing observed guardrail");
			const args = { input: [], agent, context: new RunContext({}) };
			if (outcome === "throw") await expect(observed.execute(args)).rejects.toBe(failure);
			else expect(await observed.execute(args)).toBe(result);
			expect(received).toBe(args);
			expect(calls).toBe(1);
			await diagnostic.close("error");
			expect(agent.inputGuardrails).toBe(original);
			expect(records()).toContainEqual(
				expect.objectContaining({
					lifecycle: "run.end",
					outcome: outcome === "block" ? "guardrail" : "error",
				}),
			);
		});

	test("tracing-enabled foreground approval recovery preserves once-only effects and lifecycle identity", async () => {
		const session = await createSession({ cwd, workspaceId: "workspace" });
		const parent = new ScriptedModel([
			call(
				"Agent",
				{ subagent_type: "worker", task: "Run the check", model: null, run_in_background: false },
				"child-call",
			),
			done("parent complete"),
		]);
		const child = new ScriptedModel([
			call("bash", { command: "printf x >> recovered-once.txt", timeoutMs: 1000 }, "child-bash"),
			done("child complete"),
		]);
		configureAgentModelFactory((_model, id) => (id === session.sessionId ? parent : child));
		setExtUiPublisher(() => {});
		const running = promptSession(session.sessionId, "delegate");
		await until(() => getSessionState(session.sessionId).needsInput?.kind === "dialog");
		const pending = getSessionState(session.sessionId).needsInput;
		if (pending?.kind !== "dialog") throw new Error("Missing approval");
		await removeSession(session.sessionId);
		await running;
		expect(existsSync(join(cwd, "recovered-once.txt"))).toBe(false);
		await getSessionMessages(session.sessionId, "workspace", cwd);
		const restored = getSessionState(session.sessionId).needsInput;
		if (restored?.kind !== "dialog") throw new Error("Missing restored approval");
		expect(restored.request.id).toBe(pending.request.id);
		const { request } = restored;
		if (!request.runId || request.revision === undefined || !request.toolCallId)
			throw new Error("Missing approval identity");
		resolveExtUi({
			id: request.id,
			sessionId: request.sessionId,
			runId: request.runId,
			revision: request.revision,
			toolCallId: request.toolCallId,
			value: true,
		});
		await until(() => getSessionState(session.sessionId).completion?.outcome === "succeeded");
		expect(readFileSync(join(cwd, "recovered-once.txt"), "utf8")).toBe("x");
		await settleSessionsForShutdown();
		const entries = records();
		assertClosed(entries);
		const childRecord = listSessionRecords().find(
			(r) => r.childRun?.parentSessionId === session.sessionId,
		);
		expect(entries).toContainEqual(
			expect.objectContaining({
				lifecycle: "run.end",
				sessionId: childRecord?.sessionId,
				outcome: "success",
			}),
		);
		expect(
			entries.filter((r) => r.lifecycle === "tool.start" && r.callId === "child-bash"),
		).toHaveLength(1);
		parent.assertComplete();
		child.assertComplete();
	});

	for (const outcome of ["success", "guardrail", "cancel"] as const)
		test(`summary diagnostics settle as ${outcome} with operation identity`, async () => {
			const session = await createSession({ cwd, workspaceId: "workspace" });
			const historyModel = new ScriptedModel([done("a".repeat(600)), done()]);
			configureAgentModelFactory(() => historyModel);
			await promptSession(session.sessionId, `remember ${"x".repeat(600)}`);
			await promptSession(session.sessionId, "recent");
			output = [];
			let entered = false;
			configureAgentModelFactory(
				() =>
					new ScriptedModel(
						outcome === "cancel"
							? [
									modelResponder(async ({ request }) => {
										entered = true;
										await new Promise<void>((_resolve, reject) =>
											request.signal?.addEventListener(
												"abort",
												() => reject(new Error("cancelled")),
												{ once: true },
											),
										);
										return [assistantMessage("done")];
									}),
								]
							: [done(outcome === "guardrail" ? KEY : "summary")],
					),
			);
			const compact = compactSession(session.sessionId, { operationId: "summary-operation" });
			if (outcome === "cancel") {
				await until(() => entered);
				await abortSession(session.sessionId);
			}
			if (outcome === "success") await compact;
			else await expect(compact).rejects.toThrow();
			expect(records()).toContainEqual(
				expect.objectContaining({
					event: "trace.end",
					groupId: session.sessionId,
					runId: "summary-operation",
				}),
			);
			expect(records()).toContainEqual(
				expect.objectContaining({ lifecycle: "run.end", runId: "summary-operation", outcome }),
			);
			assertClosed();
			expect(JSON.stringify(records())).not.toContain(KEY);
		});

	test("background children create their own trace group even when launched inside a parent tool", async () => {
		const session = await createSession({ cwd, workspaceId: "workspace" });
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const parent = new ScriptedModel([
			call(
				"Agent",
				{ subagent_type: "worker", task: "Inspect", model: null, run_in_background: true },
				"background",
			),
			done(),
			done(),
		]);
		const child = new ScriptedModel([
			modelResponder(async () => {
				await gate;
				return [assistantMessage("child report")];
			}),
		]);
		configureAgentModelFactory((_model, id) => (id === session.sessionId ? parent : child));
		try {
			await promptSession(session.sessionId, "background");
			release();
			await until(() =>
				records().some((r) => r.event === "trace.end" && r.parentSessionId === session.sessionId),
			);
			const childRecord = listSessionRecords().find(
				(r) => r.childRun?.parentSessionId === session.sessionId,
			);
			const childTrace = records().find(
				(r) => r.event === "trace.end" && r.sessionId === childRecord?.sessionId,
			);
			expect(childTrace).toMatchObject({
				groupId: childRecord?.sessionId,
				parentSessionId: session.sessionId,
			});
			const parentTrace = records().find(
				(r) => r.event === "trace.end" && r.sessionId === session.sessionId,
			);
			expect(childTrace?.traceId).not.toBe(parentTrace?.traceId);
			assertClosed(records().filter((r) => r.sessionId === childRecord?.sessionId));
		} finally {
			release();
		}
	});

	test("LA4: settlement closes a started tool without an SDK end exactly once and detaches hooks", async () => {
		const ids = {
			sessionId: "session",
			runId: "run",
			workspaceId: "workspace",
			startNodeId: "$root",
		};
		const policy = loadGuardrailPolicy({
			dataDir: data,
			projectTrusted: false,
			credentials: [KEY],
		});
		const runner = new Runner(traceRunOptions(ids));
		const diagnostic = attachRunDiagnostics(runner, ids, policy.redact);
		const agent = new Agent<unknown, AgentOutputType>({ name: KEY });
		const context = new RunContext({});
		const candidate = tool({
			name: KEY,
			description: "fixture",
			parameters: z.object({}),
			execute: () => "done",
		});
		const details = {
			toolCall: {
				type: "function_call" as const,
				name: "waiting",
				callId: "call",
				arguments: "{}",
			},
		};
		runner.emit("agent_start", context, agent);
		runner.emit("agent_tool_start", context, agent, candidate, details);
		await diagnostic.close("cancel");
		await diagnostic.close("error");
		runner.emit("agent_tool_end", context, agent, candidate, "late", details);
		expect(records().filter((r) => r.lifecycle === "tool.end")).toEqual([
			expect.objectContaining({ outcome: "cancel", callId: "call" }),
		]);
		expect(JSON.stringify(records())).not.toContain(KEY);
		assertClosed();
	});

	test("concurrent runs keep span and lifecycle identities isolated", async () => {
		const sessions = await Promise.all([
			createSession({ cwd, workspaceId: "workspace" }),
			createSession({ cwd, workspaceId: "workspace" }),
		]);
		configureAgentModelFactory(
			(_model, id) =>
				new ScriptedModel([
					modelResponder(async () => {
						await Bun.sleep(id === sessions[0]?.sessionId ? 10 : 1);
						return [assistantMessage("done")];
					}),
				]),
		);
		await Promise.all(sessions.map(({ sessionId }) => promptSession(sessionId, "go")));
		for (const { sessionId } of sessions) {
			const trace = records().find((r) => r.event === "trace.end" && r.sessionId === sessionId);
			expect(trace).toMatchObject({ groupId: sessionId });
			for (const span of records().filter(
				(r) => r.event === "span.end" && r.traceId === trace?.traceId,
			))
				expect(span.sessionId).toBe(sessionId);
			assertClosed(records().filter((r) => r.sessionId === sessionId));
		}
	});
} else {
	test("SDK diagnostics stay isolated from process-wide host logging initialization", () => {
		const child = Bun.spawnSync([process.execPath, "test", import.meta.path], {
			env: { ...process.env, RAILDESIGN_DIAGNOSTICS_CASES: "1" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			timeout: 15_000,
		});
		expect(child.exitCode, `${child.stdout.toString()}\n${child.stderr.toString()}`).toBe(0);
	}, 20_000);
}
