import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, applyDiff, tool, Usage } from "@openai/agents";
import { UnixLocalSandboxClient, type UnixLocalSandboxSession } from "@openai/agents/sandbox/local";
import {
	assistantMessage,
	functionCall,
	modelError,
	modelResponder,
	modelResponse,
	modelStreamResponder,
	ScriptedModel,
} from "@openai/agents/testing";
import type { ExtUiRequest, ExtUiResponse, SessionEventPayload } from "@thinkrail/contracts";
import { TODO_NUDGE_PREFIX } from "@thinkrail/contracts";
import { TodoStore } from "@thinkrail/todos/core";
import { z } from "zod";
import * as fsModule from "../fs";
import { gitDiffFile } from "../git";
import { loadConfig, saveConfig, saveWorkspaces } from "../persistence";
import { resetConfigCache, updateConfig } from "../settings";
import * as subprocessModule from "../subprocess";
import { setTrashImplementationForTests } from "../trash";
import { MCP_CONFIRM_CHAT, MCP_CONFIRM_CHOICES } from "./mcp";
import { closeAllMcpConnections, setMcpProjectResolver } from "./mcpSessions";
import * as modelConfigurationModule from "./modelConfiguration";
import { configureAgentModelFactory, saveCustomEndpoint } from "./modelConfiguration";
import {
	abortSession,
	clearSessionQueue,
	compactSession,
	createSession,
	deleteSession,
	disposeAllSessions,
	followUpSession,
	getSessionMessages,
	getSessionState,
	getSessionStats,
	liveSessionIdsOf,
	notifyExtUi,
	nudgeSession,
	pendingExtUiDialog,
	promptSession,
	queuedMessages,
	removeQueuedMessage,
	removeSession,
	renameSession,
	resolveExtUi,
	respondToTool,
	sendSteeringNow,
	setExtUiPublisher,
	setSessionPublisher,
	setSessionResourceCleanup,
	setSessionSandbox,
	setSessionStatePublisher,
	steerSession,
	updateQueuedMessage,
} from "./sdkSessionManager";
import * as sdkToolsModule from "./sdkTools";
import { applyWorkspacePatch, type ToolGrant, workspaceTools } from "./sdkTools";
import { readSessionRecord, sessionRecordPath, writeSessionRecord } from "./sessionStore";
import { setWebAccessKey } from "./webAccess";
import { setContinueToolHost, setWorkspaceToolsHost } from "./workspaceActions";

let root: string;
let worktree: string;
let webFetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
const originalEnvironment = {
	data: process.env.THINKRAIL_DATA_DIR,
	key: process.env.OPENAI_API_KEY,
	base: process.env.OPENAI_BASE_URL,
	model: process.env.OPENAI_MODEL,
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "raildesign-agent-test-"));
	worktree = join(root, "worktree");
	mkdirSync(worktree);
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	process.env.OPENAI_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
	process.env.OPENAI_MODEL = "deepseek-v4.1-flash";
	process.env.OPENAI_API_KEY = "offline-test-key";
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			name: "Test",
			branch: "test",
			baseBranch: "main",
			worktreePath: worktree,
		},
	]);
});
afterEach(() => {
	webFetchMock?.mockRestore();
	webFetchMock = undefined;
	setSessionResourceCleanup(undefined);
	setWorkspaceToolsHost(undefined);
	setContinueToolHost(undefined);
	disposeAllSessions();
	setTrashImplementationForTests(undefined);
	configureAgentModelFactory();
	setExtUiPublisher(() => {});
	setSessionPublisher(() => {});
	for (const [name, value] of Object.entries({
		THINKRAIL_DATA_DIR: originalEnvironment.data,
		OPENAI_API_KEY: originalEnvironment.key,
		OPENAI_BASE_URL: originalEnvironment.base,
		OPENAI_MODEL: originalEnvironment.model,
	})) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

const command = (callId: string, command: string) =>
	modelResponse([functionCall("bash", JSON.stringify({ command, timeoutMs: 10000 }), { callId })]);
const done = () => modelResponse([assistantMessage("done")]);
function offlineWeb(reply: (request: Request) => Response | Promise<Response>) {
	const implementation = async (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => reply(new Request(input, init));
	webFetchMock = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(implementation, { preconnect: () => {} }),
	);
	return webFetchMock;
}

test("a root SDK run completes more than twenty sequential tool rounds", async () => {
	writeFileSync(join(worktree, "fixture.txt"), "fixture bytes");
	const model = new ScriptedModel([
		...Array.from({ length: 21 }, (_, index) =>
			modelResponse([functionCall("read", { path: "fixture.txt" }, { callId: `read-${index}` })]),
		),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, "Read the fixture in twenty-one sequential rounds, then finish.");
	expect(model.calls).toHaveLength(22);
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	expect(
		readSessionRecord(sessionId)?.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "read" && !message.isError,
		),
	).toHaveLength(21);
});

const httpFailure = (status: number, headers: Record<string, string> = {}) =>
	Object.assign(new Error(`HTTP ${status}`), { status, headers: new Headers(headers) });
const transient = (retryAfterMs = "1") =>
	modelError(httpFailure(503, { "retry-after-ms": retryAfterMs }));
const assistantMessages = (sessionId: string) =>
	readSessionRecord(sessionId)?.messages.filter((message) => message.role === "assistant") ?? [];

test("a transient model failure is retried with the same input and the earlier tool effect runs once", async () => {
	const model = new ScriptedModel([
		command("effect", "printf x >> effect.txt"),
		transient(),
		done(),
	]);
	configureAgentModelFactory(() => model);
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") resolveExtUi(approvalResponse(request, true));
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, "Run the command");
	expect(model.calls).toHaveLength(3);
	expect(model.calls[2]?.request.input).toEqual(model.calls[1]?.request.input);
	for (const call of model.calls) expect(call.request.modelSettings.retry?.maxRetries).toBe(5);
	expect(readFileSync(join(worktree, "effect.txt"), "utf8")).toBe("x");
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	expect(assistantMessages(sessionId).filter((message) => message.errorMessage)).toEqual([]);
	expect(assistantMessages(sessionId).at(-1)).toMatchObject({
		content: [{ type: "text", text: "done" }],
	});
	model.assertComplete();
});

test("model retries stop after five transient failures and settle the turn once with the error", async () => {
	const model = new ScriptedModel(Array.from({ length: 6 }, () => transient()));
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, "Fail repeatedly");
	expect(model.calls).toHaveLength(6);
	expect(getSessionState(sessionId).completion?.outcome).toBe("failed");
	expect(assistantMessages(sessionId)).toEqual([
		expect.objectContaining({ stopReason: "error", errorMessage: "HTTP 503" }),
	]);
	model.assertComplete();
});

test("non-transient model failures and failures after streamed output are not retried", async () => {
	for (const failure of [
		modelError(httpFailure(400)),
		modelStreamResponder(async function* () {
			yield { type: "output_text_delta" as const, delta: "partial" };
			throw httpFailure(503);
		}),
	]) {
		const model = new ScriptedModel([failure]);
		configureAgentModelFactory(() => model);
		const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
		await promptSession(sessionId, "Fail once");
		expect(model.calls).toHaveLength(1);
		expect(getSessionState(sessionId).completion?.outcome).toBe("failed");
		expect(assistantMessages(sessionId)).toHaveLength(1);
		model.assertComplete();
	}
});

test("Stop during model retry backoff ends the turn without another request", async () => {
	const model = new ScriptedModel([transient("60000")]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const started = Date.now();
	const running = promptSession(sessionId, "Wait for the provider");
	while (model.calls.length === 0) await Bun.sleep(5);
	await Bun.sleep(20);
	await abortSession(sessionId);
	await running;
	expect(Date.now() - started).toBeLessThan(5000);
	expect(model.calls).toHaveLength(1);
	expect(getSessionState(sessionId).completion?.outcome).toBe("cancelled");
	model.assertComplete();
});

test("SDK web tools keep renderer metadata in restored transcripts and readable text in model history", async () => {
	setWebAccessKey("offline-platform-key");
	const requests: string[] = [];
	offlineWeb((request) => {
		requests.push(request.url);
		return request.url.endsWith("/search")
			? Response.json({
					results: [{ title: "Source", url: "https://example.com/page", summary: "Summary" }],
				})
			: Response.json({ title: "Page", content: "Page body" });
	});
	const model = new ScriptedModel([
		modelResponse([
			functionCall("web_search", { query: "example", count: 1 }, { callId: "web-search" }),
		]),
		modelResponse([
			functionCall("web_fetch", { url: "https://example.com/page" }, { callId: "web-fetch" }),
		]),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, "Search and read the result");
	expect(requests).toEqual([
		"https://api.deepseek.com/v1/tools/search",
		"https://api.deepseek.com/v1/tools/fetch",
	]);
	const results = readSessionRecord(sessionId)?.messages.filter(
		(item) => item.role === "toolResult",
	);
	if (!results) throw new Error("Missing web transcript");
	expect(results).toEqual([
		expect.objectContaining({
			toolCallId: "web-search",
			content: [{ type: "text", text: "Source\nhttps://example.com/page\nSummary" }],
			details: {
				provider: "DeepSeek",
				results: [{ title: "Source", url: "https://example.com/page", summary: "Summary" }],
			},
			isError: false,
		}),
		expect.objectContaining({
			toolCallId: "web-fetch",
			content: [{ type: "text", text: "# Page\n\nPage body" }],
			details: {
				provider: "DeepSeek",
				title: "Page",
				url: "https://example.com/page",
				truncated: false,
			},
			isError: false,
		}),
	]);
	const input = model.calls[2]?.request.input;
	if (!Array.isArray(input)) throw new Error("Missing web continuation input");
	expect(input.filter((item) => item.type === "function_call_result")).toEqual([
		expect.objectContaining({
			callId: "web-search",
			output: { type: "text", text: "Source\nhttps://example.com/page\nSummary" },
		}),
		expect.objectContaining({
			callId: "web-fetch",
			output: { type: "text", text: "# Page\n\nPage body" },
		}),
	]);
	expect(JSON.stringify(input)).not.toContain('"provider":"DeepSeek"');
	await removeSession(sessionId);
	const restored = await getSessionMessages(sessionId, "workspace", worktree);
	expect(restored.messages.filter((item) => item.role === "toolResult")).toEqual(results);
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	model.assertComplete();
});

test("a disabled web extension is absent from the SDK graph and cannot execute", async () => {
	saveConfig({ ...loadConfig(), disabledExtensions: ["web-access"] });
	const fetch = offlineWeb(() => Response.json({ results: [] }));
	const model = new ScriptedModel([
		modelResponder(({ request }) => {
			expect(JSON.stringify(request.tools)).not.toContain("web_search");
			expect(JSON.stringify(request.tools)).not.toContain("web_fetch");
			return [
				functionCall("web_search", { query: "blocked", count: 1 }, { callId: "disabled-web" }),
			];
		}),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, "Try a disabled web tool");
	expect(fetch).not.toHaveBeenCalled();
	expect(getSessionState(sessionId).completion?.outcome).toBe("failed");
	expect(readSessionRecord(sessionId)?.effects["disabled-web"]).toBeUndefined();
	model.assertComplete();
});

test("Stop cancels an SDK web request before a late result can enter the transcript", async () => {
	setWebAccessKey("offline-platform-key");
	const started = latch();
	let cancelled = false;
	offlineWeb(
		() =>
			new Response(
				new ReadableStream({
					start() {
						started.release();
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
	);
	const model = new ScriptedModel([
		modelResponse([
			functionCall("web_fetch", { url: "https://example.com/page" }, { callId: "stopped-web" }),
		]),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(sessionId, "Read the page");
	await started.promise;
	await abortSession(sessionId);
	await running;
	expect(cancelled).toBe(true);
	expect(getSessionState(sessionId).completion?.outcome).toBe("cancelled");
	expect(
		readSessionRecord(sessionId)?.messages.some(
			(item) =>
				item.role === "toolResult" &&
				item.toolCallId === "stopped-web" &&
				item.details !== undefined,
		),
	).toBe(false);
	model.assertComplete();
});

function approvalResponse(request: ExtUiRequest, value: boolean): ExtUiResponse {
	if (
		request.kind !== "confirm" ||
		!request.runId ||
		request.revision === undefined ||
		!request.toolCallId
	)
		throw new Error("Expected owned approval");
	return {
		id: request.id,
		sessionId: request.sessionId,
		runId: request.runId,
		revision: request.revision,
		toolCallId: request.toolCallId,
		value,
	};
}

function observeSandboxSessions() {
	const opened: UnixLocalSandboxSession[] = [];
	const create = UnixLocalSandboxClient.prototype.create;
	const probe = spyOn(UnixLocalSandboxClient.prototype, "create").mockImplementation(
		async function (this: UnixLocalSandboxClient, ...args) {
			const session = await create.apply(this, args);
			opened.push(session);
			return session;
		},
	);
	return { opened, probe };
}

test.skipIf(process.platform === "win32")(
	"Sandbox shares the selected worktree across an ordinary patch approval and closes on settlement",
	async () => {
		const fixture = join(realpathSync(worktree), "sandbox.txt");
		writeFileSync(fixture, "before\n");
		for (const args of [
			["init", "-b", "main"],
			["add", "sandbox.txt"],
			[
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.test",
				"-c",
				"commit.gpgSign=false",
				"commit",
				"-m",
				"fixture",
			],
		]) {
			const result = Bun.spawnSync(["git", "-C", worktree, ...args]);
			expect(result.exitCode).toBe(0);
		}
		const { opened, probe } = observeSandboxSessions();
		try {
			const model = new ScriptedModel([
				modelResponder(async ({ request }) => {
					const session = opened[0];
					if (!session) throw new Error("The runtime must exist at the model boundary");
					expect(request.tools.every((tool) => tool.type === "function")).toBe(true);
					expect(request.tools.filter((tool) => tool.name === "apply_patch")).toHaveLength(1);
					expect(request.tools.map((tool) => tool.name)).not.toContain("exec_command");
					expect(Buffer.from(await session.readFile({ path: fixture })).toString()).toBe(
						"before\n",
					);
					await expect(
						session
							.createEditor()
							.createFile({ type: "create_file", path: fixture, diff: "+changed\n" }),
					).rejects.toThrow(/read.only/i);
					return [
						functionCall(
							"apply_patch",
							{ path: "sandbox.txt", original: "before\n", diff: "@@\n-before\n+after\n" },
							{ callId: "sandbox-patch" },
						),
					];
				}),
				modelResponder(async () => {
					const session = opened[0];
					if (!session) throw new Error("No Sandbox session after approval");
					expect(opened).toHaveLength(1);
					expect(Buffer.from(await session.readFile({ path: fixture })).toString()).toBe("after\n");
					return [assistantMessage("Done")];
				}),
			]);
			configureAgentModelFactory(() => model);
			setExtUiPublisher((request) => {
				if (request.kind === "confirm") resolveExtUi(approvalResponse(request, true));
			});
			const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
			setSessionSandbox(sessionId, true);
			await promptSession(sessionId, "Edit the selected worktree");
			expect(getSessionState(sessionId)).toMatchObject({
				sandbox: true,
				completion: { outcome: "succeeded" },
			});
			expect(readSessionRecord(sessionId)?.effects["sandbox-patch"]?.status).toBe("completed");
			expect(fsModule.readFile("workspace", "sandbox.txt").content).toBe("after\n");
			expect(await gitDiffFile("workspace", "sandbox.txt", { kind: "uncommitted" })).toMatchObject({
				original: "before\n",
				modified: "after\n",
			});
			expect(opened).toHaveLength(1);
			const owned = opened[0];
			if (!owned) throw new Error("No Sandbox session to verify cleanup");
			expect(existsSync(owned.state.workspaceRootPath)).toBe(false);
			model.assertComplete();
			setSessionSandbox(sessionId, false);
			model.enqueue(done());
			await promptSession(sessionId, "Continue as a regular chat");
			expect(getSessionState(sessionId).sandbox).toBeUndefined();
			expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
			expect(opened).toHaveLength(1);
			model.assertComplete();
		} finally {
			probe.mockRestore();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"Stop closes a Sandbox workspace paused for approval and blocks the late edit",
	async () => {
		const { opened, probe } = observeSandboxSessions();
		try {
			const model = new ScriptedModel([
				modelResponse([
					functionCall(
						"apply_patch",
						{ path: "late.txt", original: null, diff: "+forbidden\n" },
						{ callId: "late-patch" },
					),
				]),
			]);
			configureAgentModelFactory(() => model);
			const asked = latch();
			setExtUiPublisher((request) => {
				if (request.kind === "confirm") asked.release();
			});
			const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
			setSessionSandbox(sessionId, true);
			const running = promptSession(sessionId, "Propose a patch");
			await Promise.race([asked.promise, running]);
			const request = pendingExtUiDialog(sessionId);
			const workspace = opened[0]?.state.workspaceRootPath;
			if (!workspace || !request) throw new Error("Sandbox did not reach its approval boundary");
			expect(existsSync(workspace)).toBe(true);
			expect(() => setSessionSandbox(sessionId, false)).toThrow("Stop the active run");
			const stopping = abortSession(sessionId);
			expect(() => resolveExtUi(approvalResponse(request, true))).toThrow();
			await stopping;
			await running;
			expect(existsSync(workspace)).toBe(false);
			expect(existsSync(join(worktree, "late.txt"))).toBe(false);
			expect(getSessionState(sessionId).completion?.outcome).toBe("cancelled");
			expect(model.calls).toHaveLength(1);
		} finally {
			probe.mockRestore();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"Sandbox Handoff keeps approval ownership and rebuilds a fresh runtime on reattach",
	async () => {
		const agents = join(root, "data", "agents");
		mkdirSync(agents, { recursive: true });
		writeFileSync(
			join(agents, "sandbox-validator.md"),
			"---\nname: sandbox-validator\ndescription: Validate a workspace fixture.\n---\nValidate the fixture.",
		);
		writeFileSync(
			join(root, "data", "handoffs.json"),
			JSON.stringify({
				version: 1,
				rootTargets: ["sandbox-validator"],
				agents: [{ definition: "sandbox-validator", targets: [], history: "without_tools" }],
			}),
		);
		const { opened, probe } = observeSandboxSessions();
		try {
			const model = new ScriptedModel([
				modelResponder(({ request }) => {
					const transfer = request.handoffs[0];
					if (!transfer) throw new Error("No SDK Handoff tool");
					return [
						functionCall(
							transfer.toolName,
							{ reason: "verify the fixture" },
							{ callId: "transfer" },
						),
					];
				}),
				modelResponse([
					functionCall(
						"apply_patch",
						{ path: "reopened.txt", original: null, diff: "+once\n" },
						{ callId: "reopened-patch" },
					),
				]),
				done(),
			]);
			configureAgentModelFactory(() => model);
			const asked = latch();
			setExtUiPublisher((request) => {
				if (request.kind === "confirm") asked.release();
			});
			const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
			setSessionSandbox(sessionId, true);
			const running = promptSession(sessionId, "Transfer and ask for approval");
			await Promise.race([asked.promise, running]);
			const firstWorkspace = opened[0]?.state.workspaceRootPath;
			if (!firstWorkspace) throw new Error("No first Sandbox session");
			if (pendingExtUiDialog(sessionId)?.kind !== "confirm")
				throw new Error(
					assistantMessages(sessionId).at(-1)?.errorMessage ??
						"Sandbox Handoff did not request approval",
				);
			expect(getSessionState(sessionId).activeAgent).toBe("sandbox-validator");
			expect(opened).toHaveLength(1);

			await removeSession(sessionId);
			await running;
			expect(existsSync(firstWorkspace)).toBe(false);
			expect(readSessionRecord(sessionId)?.pendingApproval?.checkpoint).not.toContain(
				firstWorkspace,
			);
			const restored = await getSessionMessages(sessionId, "workspace", worktree);
			expect(restored.summary.state?.sandbox).toBe(true);
			const approval = pendingExtUiDialog(sessionId);
			if (!approval) throw new Error("The approval was not restored");
			const response = approvalResponse(approval, true);
			const settled = latch();
			setSessionPublisher((frame) => {
				if (frame.sessionId === sessionId && frame.event.type === "agent_settled")
					settled.release();
			});
			resolveExtUi(response);
			await settled.promise;
			expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
			resolveExtUi(response);
			expect(readFileSync(join(worktree, "reopened.txt"), "utf8")).toBe("once");
			expect(readSessionRecord(sessionId)?.effects["reopened-patch"]?.status).toBe("completed");
			expect(opened).toHaveLength(2);
			const secondWorkspace = opened[1]?.state.workspaceRootPath;
			if (!secondWorkspace) throw new Error("No restored Sandbox session");
			expect(secondWorkspace).not.toBe(firstWorkspace);
			expect(existsSync(secondWorkspace)).toBe(false);
			model.assertComplete();
		} finally {
			probe.mockRestore();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"an active Sandbox runtime closes after an SDK model error",
	async () => {
		const { opened, probe } = observeSandboxSessions();
		try {
			const model = new ScriptedModel([modelError(new Error("Sandbox model failed"))]);
			configureAgentModelFactory(() => model);
			const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
			setSessionSandbox(sessionId, true);
			await promptSession(sessionId, "Encounter an injected failure");
			expect(assistantMessages(sessionId).at(-1)?.errorMessage).toBe("Sandbox model failed");
			const workspace = opened[0]?.state.workspaceRootPath;
			if (!workspace) throw new Error("Sandbox runtime did not start");
			expect(existsSync(workspace)).toBe(false);
			expect(getSessionState(sessionId).completion?.outcome).toBe("failed");
			model.assertComplete();
		} finally {
			probe.mockRestore();
		}
	},
);

test("an unavailable Sandbox runtime reports its cause without a regular model call", async () => {
	const model = new ScriptedModel([]);
	configureAgentModelFactory(() => model);
	const python = process.env.OPENAI_AGENTS_PYTHON;
	process.env.OPENAI_AGENTS_PYTHON = join(root, "missing-python");
	try {
		const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
		setSessionSandbox(sessionId, true);
		await promptSession(sessionId, "Do not fall back");
		expect(model.calls).toHaveLength(0);
		expect(assistantMessages(sessionId).at(-1)?.errorMessage).toContain("trusted Python 3");
		expect(getSessionState(sessionId)).toMatchObject({
			sandbox: true,
			completion: { outcome: "failed", failure: "error" },
		});
	} finally {
		if (python === undefined) delete process.env.OPENAI_AGENTS_PYTHON;
		else process.env.OPENAI_AGENTS_PYTHON = python;
	}
});

test("SDK stream projects stable IDs, persists history once and settles with its watermark", async () => {
	const model = new ScriptedModel([done()]);
	const conversationIds: string[] = [];
	configureAgentModelFactory((_model, sessionId) => {
		conversationIds.push(sessionId);
		return model;
	});
	const frames: SessionEventPayload[] = [];
	setSessionPublisher((frame) => frames.push(frame));
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(created.sessionId, "say done");
	const snapshot = await getSessionMessages(created.sessionId, "workspace", worktree);
	expect(snapshot.messages.filter((message) => message.role === "user")).toHaveLength(1);
	expect(snapshot.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
	expect(new Set(snapshot.messages.map((message) => message.id)).size).toBe(
		snapshot.messages.length,
	);
	const lastFrame = frames.at(-1);
	if (!lastFrame) throw new Error("No event frames");
	expect(snapshot.eventSeq).toBe(lastFrame.seq);
	expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index + 1));
	expect(getSessionState(created.sessionId).completion?.outcome).toBe("succeeded");
	expect(
		readSessionRecord(created.sessionId)?.history.filter(
			(item) => "role" in item && item.role === "user",
		),
	).toHaveLength(1);
	expect(getSessionStats(created.sessionId).cost).toBeNull();
	model.enqueue(done());
	await promptSession(created.sessionId, "continue the same conversation");
	expect(conversationIds).toEqual([created.sessionId, created.sessionId]);
	expect(model.calls.map((call) => call.request.modelSettings.providerData)).toEqual([
		{ extra_headers: { "User-Agent": "RailDesign/0.1" } },
		{ extra_headers: { "User-Agent": "RailDesign/0.1" } },
	]);
	model.assertComplete();
});

test("failed input admission launches no model and leaves the session available for a later send", async () => {
	const model = new ScriptedModel([done()]);
	configureAgentModelFactory(() => model);
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const directory = join(root, "data", "sessions");
	const saved = join(root, "saved-sessions");
	renameSync(directory, saved);
	writeFileSync(directory, "not a directory");
	expect(() => promptSession(created.sessionId, "must not be accepted")).toThrow();
	expect(model.calls).toHaveLength(0);
	expect(getSessionState(created.sessionId).execution).toBe("idle");
	rmSync(directory);
	renameSync(saved, directory);
	await promptSession(created.sessionId, "accepted after repair");
	expect(
		readSessionRecord(created.sessionId)?.messages.filter((message) => message.role === "user"),
	).toHaveLength(1);
	model.assertComplete();
});

test("owned approval executes once, duplicate reply is idempotent and cross-session reply fails", async () => {
	const model = new ScriptedModel([
		command(
			"approved",
			"printf once >> count.txt; if printenv OPENAI_API_KEY > key.txt; then :; else printf unset > key.txt; fi",
		),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const other = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const receipts: ExtUiResponse[] = [];
	setExtUiPublisher((request) => {
		if (request.kind !== "confirm") return;
		const receipt = approvalResponse(request, true);
		receipts.push(receipt);
		const waiting = readSessionRecord(created.sessionId)?.pendingApproval;
		if (!waiting) throw new Error("Approval was published before persistence");
		expect(waiting.request).toMatchObject(request);
		expect(waiting.checkpoint.length).toBeGreaterThan(0);
		expect(existsSync(join(worktree, "count.txt"))).toBe(false);
		expect(() => resolveExtUi({ ...receipt, sessionId: other.sessionId })).toThrow("stale");
		expect(() => resolveExtUi({ ...receipt, runId: "another-run" })).toThrow("stale");
		expect(() => resolveExtUi({ ...receipt, revision: (receipt.revision ?? 0) + 1 })).toThrow(
			"stale",
		);
		expect(() => resolveExtUi({ ...receipt, id: "unknown-interaction" })).toThrow("stale");
		expect(() => resolveExtUi({ ...receipt, value: "yes" })).toThrow("stale");
		resolveExtUi(receipt);
		const accepted = readSessionRecord(created.sessionId);
		expect(accepted?.pendingApproval).toBeUndefined();
		expect(accepted?.decisions[request.id]).toEqual({
			runId: waiting.request.runId,
			revision: waiting.request.revision,
			toolCallId: waiting.request.toolCallId,
			value: true,
		});
		resolveExtUi(receipt);
	});
	await promptSession(created.sessionId, "run once");
	expect(readFileSync(join(worktree, "count.txt"), "utf8")).toBe("once");
	expect(readFileSync(join(worktree, "key.txt"), "utf8")).toBe("unset");
	expect(
		readSessionRecord(created.sessionId)?.history.filter(
			(item) => "role" in item && item.role === "user",
		),
	).toHaveLength(1);
	const receipt = receipts[0];
	if (!receipt) throw new Error("No approval card");
	expect(() => resolveExtUi({ ...receipt, value: false })).toThrow("Conflicting");
	model.assertComplete();
});

test("rejected approval never starts its executor", async () => {
	const model = new ScriptedModel([command("denied", "printf forbidden > forbidden.txt"), done()]);
	configureAgentModelFactory(() => model);
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") resolveExtUi(approvalResponse(request, false));
	});
	const frames: SessionEventPayload[] = [];
	setSessionPublisher((frame) => frames.push(frame));
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(created.sessionId, "request a command");
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
	expect(frames.some((frame) => frame.event.type === "tool_execution_start")).toBe(false);
	expect(
		readSessionRecord(created.sessionId)?.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "denied",
		),
	).toMatchObject({ isError: true });
	model.assertComplete();
});

test("tool failure status follows actual execution and preserves successful error-shaped file text", async () => {
	const contents = '{"isError":true}\nAn error occurred while running the tool';
	writeFileSync(join(worktree, "fixture.txt"), contents);
	const model = new ScriptedModel([
		modelResponse([
			functionCall("read", { path: "fixture.txt" }, { callId: "successful-read" }),
			functionCall("read", { path: "missing.txt" }, { callId: "failed-read" }),
			functionCall("read", "{invalid", { callId: "malformed-read" }),
			functionCall("read", { path: null }, { callId: "invalid-read" }),
			functionCall("skill_read", { name: "", path: null }, { callId: "invalid-skill-read" }),
			functionCall("skill_search", { query: "", limit: null }, { callId: "invalid-skill-search" }),
			functionCall("todo_list", "{invalid", { callId: "invalid-todo" }),
			functionCall("spec_search", "{invalid", { callId: "invalid-spec" }),
		]),
		command("failed-command", "printf failed-command; exit 7"),
		done(),
	]);
	configureAgentModelFactory(() => model);
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") resolveExtUi(approvalResponse(request, true));
	});
	const frames: SessionEventPayload[] = [];
	setSessionPublisher((frame) => frames.push(frame));
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(created.sessionId, "read the files and run the command");
	const results = readSessionRecord(created.sessionId)?.messages.filter(
		(message) => message.role === "toolResult",
	);
	expect(results).toHaveLength(9);
	expect(results?.find((message) => message.toolCallId === "successful-read")).toMatchObject({
		isError: false,
		content: [{ type: "text", text: contents }],
	});
	for (const callId of [
		"successful-read",
		"failed-read",
		"malformed-read",
		"failed-command",
		"invalid-read",
		"invalid-skill-read",
		"invalid-skill-search",
		"invalid-todo",
		"invalid-spec",
	]) {
		const failed = callId !== "successful-read";
		expect(results?.find((message) => message.toolCallId === callId)).toMatchObject({
			isError: failed,
		});
		const endings = frames.filter(
			(frame) => frame.event.type === "tool_execution_end" && frame.event.toolCallId === callId,
		);
		expect(endings).toHaveLength(1);
		expect(endings[0]?.event).toMatchObject({ isError: failed });
		if (!["malformed-read", "invalid-todo", "invalid-spec"].includes(callId))
			expect(readSessionRecord(created.sessionId)?.effects[callId]?.isError).toBe(failed);
		else expect(readSessionRecord(created.sessionId)?.effects[callId]).toBeUndefined();
	}
	model.assertComplete();
});

test("invalid input to each effectful tool factory returns an error result without running its executor", async () => {
	const workspaceHost = {
		start: mock(() => Promise.reject(new Error("must not start"))),
		status: mock(async () => "must not report"),
	};
	setWorkspaceToolsHost(workspaceHost);
	// An admitted Skill makes skill_read/skill_search succeed if their executors run.
	mkdirSync(join(root, "data/skills/probe"), { recursive: true });
	writeFileSync(
		join(root, "data/skills/probe/SKILL.md"),
		"---\nname: probe\ndescription: Probe procedure\n---\nProbe body.",
	);
	const reads = spyOn(fsModule, "readFile");
	const processes = spyOn(subprocessModule, "runBounded");
	const invalid: [string, unknown][] = [
		["read", { path: "" }],
		["search", { query: "" }],
		["bash", { command: "printf leak > bash-leak.txt", timeoutMs: "fast" }],
		["apply_patch", { path: "patch-leak.txt", diff: "+leak\n", original: 5 }],
		["skill_read", { name: "probe", path: 5 }],
		["skill_search", { query: "probe", limit: 0 }],
		["start_workspace", { prompt: "", project: 5 }],
		["workspace_status", { workspaces: "all" }],
	];
	const model = new ScriptedModel([
		modelResponse(
			invalid.map(([name, args]) =>
				functionCall(name, args as Record<string, unknown>, { callId: `invalid-${name}` }),
			),
		),
		done(),
	]);
	configureAgentModelFactory(() => model);
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") resolveExtUi(approvalResponse(request, true));
	});
	try {
		const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
		await promptSession(sessionId, "Call every tool with invalid input");
		const results = readSessionRecord(sessionId)?.messages.filter(
			(message) => message.role === "toolResult",
		);
		for (const [name] of invalid)
			expect(results?.find((message) => message.toolCallId === `invalid-${name}`)).toMatchObject({
				isError: true,
			});
		expect(reads).not.toHaveBeenCalled();
		expect(processes).not.toHaveBeenCalled();
		expect(workspaceHost.start).not.toHaveBeenCalled();
		expect(workspaceHost.status).not.toHaveBeenCalled();
		expect(existsSync(join(worktree, "bash-leak.txt"))).toBe(false);
		expect(existsSync(join(worktree, "patch-leak.txt"))).toBe(false);
		expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
		model.assertComplete();
	} finally {
		reads.mockRestore();
		processes.mockRestore();
	}
});

test("a model key referenced by an arbitrary environment name is not inherited by commands", async () => {
	const previous = process.env.SERVICE_ACCESS;
	process.env.SERVICE_ACCESS = "not-a-real-key";
	try {
		await saveCustomEndpoint({
			name: "Go",
			baseUrl: "https://opencode.ai/inference/go/openai/v1",
			apiKey: "$SERVICE_ACCESS",
			models: [
				{
					id: "deepseek-v4.1-flash",
					contextWindow: null,
					maxTokens: 32,
					reasoning: null,
					vision: null,
					tools: true,
				},
			],
		});
		const model = new ScriptedModel([
			command(
				"key-isolation",
				"if printenv SERVICE_ACCESS > key.txt; then :; else printf unset > key.txt; fi",
			),
			done(),
		]);
		configureAgentModelFactory(() => model);
		setExtUiPublisher((request) => {
			if (request.kind === "confirm") resolveExtUi(approvalResponse(request, true));
		});
		const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
		await promptSession(created.sessionId, "check child environment");
		expect(readFileSync(join(worktree, "key.txt"), "utf8")).toBe("unset");
		model.assertComplete();
	} finally {
		if (previous === undefined) delete process.env.SERVICE_ACCESS;
		else process.env.SERVICE_ACCESS = previous;
	}
});

test("Stop during approval revokes the run, rejects stale replies and prevents a second Runner", async () => {
	const model = new ScriptedModel([command("waiting", "printf forbidden > forbidden.txt")]);
	configureAgentModelFactory(() => model);
	let card: ExtUiRequest | undefined;
	let ready: (() => void) | undefined;
	const waiting = new Promise<void>((resolve) => {
		ready = resolve;
	});
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") {
			card = request;
			ready?.();
		}
	});
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(created.sessionId, "request approval");
	await waiting;
	expect(() => promptSession(created.sessionId, "second run")).toThrow("already active");
	await abortSession(created.sessionId);
	await running;
	expect(getSessionState(created.sessionId).completion?.outcome).toBe("cancelled");
	if (!card) throw new Error("Missing card");
	const stoppedReply = approvalResponse(card, true);
	expect(() => resolveExtUi(stoppedReply)).toThrow("stale");
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
});

test("a deleted workspace cannot authorize a tool when its worktree is the host cwd", async () => {
	const previousCwd = process.cwd();
	process.chdir(worktree);
	const cwd = process.cwd();
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
	const model = new ScriptedModel([
		command("removed-workspace", "printf forbidden > forbidden.txt"),
		done(),
	]);
	configureAgentModelFactory(() => model);
	let ready: (request: ExtUiRequest) => void = () => {};
	const approval = new Promise<ExtUiRequest>((resolve) => {
		ready = resolve;
	});
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") ready(request);
	});
	const created = await createSession({ cwd, workspaceId: "workspace" });
	const running = promptSession(created.sessionId, "request approval");
	try {
		const request = await approval;
		saveWorkspaces([]);
		expect(() => resolveExtUi(approvalResponse(request, true))).toThrow("permission");
	} finally {
		await abortSession(created.sessionId);
		await running;
		process.chdir(previousCwd);
	}
	expect(existsSync(join(cwd, "forbidden.txt"))).toBe(false);
	expect(model.remainingSteps).toBe(1);
});

test.skipIf(process.platform === "win32")(
	"Stop waits for an executing command tree and its next model call cannot start afterwards",
	async () => {
		const model = new ScriptedModel([
			command(
				"running",
				"(sleep 1; printf forbidden > orphan.txt) & echo $! > child.pid; printf ready > ready.txt; wait",
			),
			modelResponse([
				functionCall(
					"apply_patch",
					{ path: "later.txt", original: null, diff: "+forbidden\n" },
					{ callId: "later" },
				),
			]),
		]);
		configureAgentModelFactory(() => model);
		setExtUiPublisher((request) => {
			if (request.kind === "confirm") resolveExtUi(approvalResponse(request, true));
		});
		const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
		const running = promptSession(created.sessionId, "run command");
		const deadline = Date.now() + 3000;
		while (!existsSync(join(worktree, "ready.txt"))) {
			if (Date.now() > deadline) throw new Error("Command did not start");
			await Bun.sleep(10);
		}
		const pid = Number(readFileSync(join(worktree, "child.pid"), "utf8"));
		await abortSession(created.sessionId);
		await running;
		expect(() => process.kill(pid, 0)).toThrow();
		expect(existsSync(join(worktree, "orphan.txt"))).toBe(false);
		expect(existsSync(join(worktree, "later.txt"))).toBe(false);
		expect(model.remainingSteps).toBe(1);
		expect(getSessionState(created.sessionId).completion?.outcome).toBe("cancelled");
	},
);

test("patch exposes executable SDK diff examples and exact-original guidance to the model", () => {
	const patch = workspaceTools({
		workspaceId: "workspace",
		cwd: worktree,
		signal: new AbortController().signal,
		assertActive() {},
	}).find((entry) => entry.name === "apply_patch");
	const schema = patch?.parameters as { properties?: Record<string, { description?: string }> };
	const description = schema.properties?.diff?.description ?? "";
	const existingExample = description.match(/@@\n-before\n\+after\n/)?.[0];
	const createExample = description.match(/\+first line\n\+second line\n/)?.[0];
	expect(existingExample).toBeDefined();
	expect(createExample).toBeDefined();
	expect(applyDiff("before\n", existingExample ?? "")).toBe("after\n");
	expect(applyDiff("", createExample ?? "", "create")).toBe("first line\nsecond line");
	expect(schema.properties?.original?.description).toMatch(/exact entire.*original/i);
	expect(schema.properties?.original?.description).toMatch(/null only.*new file/i);
});

test("patch validates original text, symlinks, new ancestors, .git and revoked grants", () => {
	const outside = join(root, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "secret.txt"), "secret\n");
	symlinkSync(outside, join(worktree, "escape"));
	mkdirSync(join(worktree, ".git"));
	let active = true;
	const grant: ToolGrant = {
		workspaceId: "workspace",
		cwd: worktree,
		signal: new AbortController().signal,
		assertActive: () => {
			if (!active) throw new Error("revoked");
		},
	};
	for (const path of [
		"../outside/secret.txt",
		"escape/secret.txt",
		"escape/new/deep.txt",
		".git/config",
	])
		expect(() => applyWorkspacePatch(grant, { path, diff: "+changed", original: null })).toThrow();
	writeFileSync(join(worktree, "file.txt"), "before\n");
	expect(() =>
		applyWorkspacePatch(grant, {
			path: "file.txt",
			diff: "@@\n-before\n+after\n",
			original: "wrong\n",
		}),
	).toThrow("Original text changed");
	applyWorkspacePatch(grant, {
		path: "file.txt",
		diff: "@@\n-before\n+after\n",
		original: "before\n",
	});
	expect(readFileSync(join(worktree, "file.txt"), "utf8")).toBe("after\n");
	active = false;
	expect(() =>
		applyWorkspacePatch(grant, {
			path: "file.txt",
			diff: "@@\n-after\n+forbidden\n",
			original: "after\n",
		}),
	).toThrow("revoked");
	expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret\n");
});

test("automatic titles cannot overwrite a manual title or another accepted automatic title", async () => {
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const manual = renameSession(sessionId, "workspace", worktree, "Manual name");
	const automatic = renameSession(sessionId, "workspace", worktree, "Automatic name", {
		onlyIfUnnamed: true,
	});
	expect(await manual).toBe(true);
	expect(await automatic).toBe(false);
	expect(readSessionRecord(sessionId)?.title).toBe("Manual name");
	const next = await createSession({ cwd: worktree, workspaceId: "workspace" });
	expect(
		await renameSession(next.sessionId, "workspace", worktree, "First title", {
			onlyIfUnnamed: true,
		}),
	).toBe(true);
	expect(
		await renameSession(next.sessionId, "workspace", worktree, "Second title", {
			onlyIfUnnamed: true,
		}),
	).toBe(false);
	expect(readSessionRecord(next.sessionId)?.title).toBe("First title");
});

test("resource cleanup settles before detaching a session and failures leave it attached", async () => {
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	let finish: (() => void) | undefined;
	setSessionResourceCleanup(async (id) => {
		expect(id).toBe(sessionId);
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
	});
	const pending = removeSession(sessionId);
	await Bun.sleep(0);
	expect(liveSessionIdsOf("workspace")).toContain(sessionId);
	finish?.();
	await pending;
	expect(liveSessionIdsOf("workspace")).not.toContain(sessionId);
	await getSessionMessages(sessionId, "workspace", worktree);
	setSessionResourceCleanup(async () => {
		throw new Error("resources still active");
	});
	await expect(removeSession(sessionId)).rejects.toThrow("resources still active");
	expect(liveSessionIdsOf("workspace")).toContain(sessionId);
});

test("session deletion uses recoverable trash and a failed trash preserves its transcript", async () => {
	const created = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const path = sessionRecordPath(created.sessionId);
	setTrashImplementationForTests(async () => {
		throw new Error("trash unavailable");
	});
	await expect(deleteSession(created.sessionId, "workspace", worktree)).rejects.toThrow(
		"trash unavailable",
	);
	expect(readSessionRecord(created.sessionId)?.sessionId).toBe(created.sessionId);
	await getSessionMessages(created.sessionId, "workspace", worktree);
	const trashed = join(root, "recoverable-session.json");
	setTrashImplementationForTests(async (source) => {
		if (typeof source !== "string") throw new Error("Expected one transcript");
		renameSync(source, trashed);
	});
	await deleteSession(created.sessionId, "workspace", worktree);
	expect(existsSync(path)).toBe(false);
	expect(JSON.parse(readFileSync(trashed, "utf8")).sessionId).toBe(created.sessionId);
});

function latch() {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

async function settled(sessionId: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (getSessionState(sessionId).execution === "idle") return;
		await Bun.sleep(10);
	}
	throw new Error("SDK test run did not settle");
}

test("an idle TODO nudge executes the SDK tools once and survives retry after reattachment", async () => {
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const todos = new TodoStore(worktree, sessionId);
	const todo = todos.add({ title: "manual task", origin: "user" });
	const model = new ScriptedModel([
		modelResponse([functionCall("todo_list", {}, { callId: "list-added" })]),
		modelResponse([
			functionCall("todo_update", { id: todo.id, status: "done" }, { callId: "complete-added" }),
		]),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const text = `${TODO_NUDGE_PREFIX}Read and complete the manual task.`;
	const messageId = `todo-nudge-${todo.id}`;
	expect(nudgeSession(sessionId, text, messageId)).toEqual({ disposition: "prompted" });
	nudgeSession(sessionId, text, messageId);
	await settled(sessionId);
	expect(todos.get(todo.id)?.status).toBe("done");
	expect(readSessionRecord(sessionId)).toMatchObject({
		state: { completion: { outcome: "succeeded" } },
	});
	expect(
		readSessionRecord(sessionId)?.history.filter((item) => item.id === messageId),
	).toHaveLength(1);
	expect(readSessionRecord(sessionId)?.messages.some((item) => item.id === messageId)).toBe(false);
	expect(queuedMessages(sessionId)).toEqual({ steering: [], followUp: [] });
	await removeSession(sessionId);
	await getSessionMessages(sessionId, "workspace", worktree);
	nudgeSession(sessionId, text, messageId);
	expect(model.calls).toHaveLength(3);
	expect(() => nudgeSession(sessionId, `${text} conflicting`, messageId)).toThrow("Conflicting");
	model.assertComplete();
});

test("a running TODO nudge is a follow-up after normal settlement and never steering", async () => {
	const ready = latch();
	const finish = latch();
	const model = new ScriptedModel([
		modelResponder(async () => {
			ready.release();
			await finish.promise;
			return [functionCall("todo_list", {}, { callId: "original-list" })];
		}),
		done(),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "original");
	await ready.promise;
	const text = `${TODO_NUDGE_PREFIX}Read the updated list.`;
	expect(nudgeSession(sessionId, text, "todo-nudge-queued")).toEqual({ disposition: "queued" });
	nudgeSession(sessionId, text, "todo-nudge-queued");
	followUpSession(sessionId, "withdraw this user input", undefined, "withdrawable");
	expect(clearSessionQueue(sessionId).followUp).toEqual([
		expect.objectContaining({ id: "withdrawable" }),
	]);
	expect(readSessionRecord(sessionId)?.queue).toEqual([
		expect.objectContaining({ id: "todo-nudge-queued", kind: "followUp", internal: true }),
	]);
	expect(queuedMessages(sessionId)).toEqual({ steering: [], followUp: [] });
	finish.release();
	await run;
	expect(model.calls).toHaveLength(3);
	const middle = model.calls[1]?.request.input;
	const last = model.calls[2]?.request.input;
	if (!Array.isArray(middle) || !Array.isArray(last)) throw new Error("Missing model history");
	expect(middle.some((item) => item.id === "todo-nudge-queued")).toBe(false);
	expect(last.filter((item) => item.id === "todo-nudge-queued")).toHaveLength(1);
	model.assertComplete();
});

test("TODO nudges cannot bypass a pending approval", async () => {
	const model = new ScriptedModel([command("block-nudge", "printf forbidden > forbidden.txt")]);
	configureAgentModelFactory(() => model);
	const ready = latch();
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") ready.release();
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "wait for approval");
	await ready.promise;
	const request = getSessionState(sessionId).needsInput;
	expect(nudgeSession(sessionId, `${TODO_NUDGE_PREFIX}New item`, "todo-nudge-blocked")).toEqual({
		disposition: "needs_input",
	});
	expect(getSessionState(sessionId).needsInput).toEqual(request);
	expect(readSessionRecord(sessionId)?.queue).toEqual([]);
	await abortSession(sessionId);
	await run;
	expect(model.calls).toHaveLength(1);
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
});

test("Stop discards stale internal TODO follow-ups and keeps their durable retry identity", async () => {
	const ready = latch();
	const finish = latch();
	const model = new ScriptedModel([
		modelResponder(async () => {
			ready.release();
			await finish.promise;
			return [assistantMessage("late")];
		}),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "original");
	await ready.promise;
	const text = `${TODO_NUDGE_PREFIX}Do not revive after Stop.`;
	nudgeSession(sessionId, text, "todo-nudge-stop");
	followUpSession(sessionId, "user follow-up", undefined, "user-kept");
	const stopping = abortSession(sessionId);
	finish.release();
	await stopping;
	await run;
	expect(readSessionRecord(sessionId)?.queue.map((item) => item.id)).toEqual(["user-kept"]);
	nudgeSession(sessionId, text, "todo-nudge-stop");
	expect(model.calls).toHaveLength(1);
});

test("SDK workspace actions reach the host services with run identity and structured results", async () => {
	const starts: string[] = [];
	setWorkspaceToolsHost({
		start: async (sessionId, params, signal) => {
			signal.throwIfAborted();
			starts.push(sessionId);
			expect(params).toEqual({ prompt: "independent task", project: "project" });
			return {
				workspaceId: "side-workspace",
				projectId: "project",
				sessionId: "side-chat",
				name: "Side",
				branch: "side",
				baseBranch: "main",
				model: null,
				effort: "off",
			};
		},
		status: async (sessionId, params) => {
			expect(starts).toEqual([sessionId]);
			expect(params).toEqual({ workspaces: ["side-workspace"] });
			return "Side: completed";
		},
	});
	const model = new ScriptedModel([
		modelResponse([
			functionCall(
				"start_workspace",
				{
					prompt: "independent task",
					project: "project",
					base_branch: null,
					model: null,
					effort: null,
					attachments: null,
				},
				{ callId: "start-side" },
			),
		]),
		modelResponse([
			functionCall(
				"workspace_status",
				{ workspaces: ["side-workspace"], project: null },
				{ callId: "side-status" },
			),
		]),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, "Start another workspace and check it");
	expect(starts).toEqual([sessionId]);
	expect(
		readSessionRecord(sessionId)?.messages.find(
			(item) => item.role === "toolResult" && item.toolCallId === "start-side",
		),
	).toMatchObject({
		isError: false,
		details: { workspaceId: "side-workspace", sessionId: "side-chat" },
	});
	model.assertComplete();
});

test("Stop during workspace admission aborts the host signal and rejects the late tool result", async () => {
	const ready = latch();
	const finish = latch();
	let receivedSignal: AbortSignal | undefined;
	setWorkspaceToolsHost({
		start: async (_sessionId, _params, signal) => {
			receivedSignal = signal;
			ready.release();
			await finish.promise;
			signal.throwIfAborted();
			throw new Error("Unexpected admission after Stop");
		},
		status: async () => "unused",
	});
	const model = new ScriptedModel([
		modelResponse([
			functionCall(
				"start_workspace",
				{
					prompt: "side",
					project: null,
					base_branch: null,
					model: null,
					effort: null,
					attachments: null,
				},
				{ callId: "stopped-side" },
			),
		]),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "Start workspace");
	await ready.promise;
	const stopped = abortSession(sessionId);
	expect(receivedSignal?.aborted).toBe(true);
	finish.release();
	await stopped;
	await run;
	expect(getSessionState(sessionId).completion?.outcome).toBe("cancelled");
	expect(model.calls).toHaveLength(1);
	expect(
		readSessionRecord(sessionId)?.messages.find(
			(item) => item.role === "toolResult" && item.toolCallId === "stopped-side",
		),
	).toMatchObject({ isError: true });
});
test("steering reaches the next model boundary once and remains separate from follow-ups", async () => {
	const frames: SessionEventPayload[] = [];
	setSessionPublisher((frame) => frames.push(frame));
	writeFileSync(join(worktree, "fixture.txt"), "fixture");
	const started = latch();
	const finish = latch();
	const model = new ScriptedModel([
		modelResponder(async () => {
			started.release();
			await finish.promise;
			return [functionCall("read", { path: "fixture.txt" }, { callId: "continue" })];
		}),
		done(),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "initial", undefined, "initial");
	await started.promise;
	followUpSession(sessionId, "after completion", undefined, "follow");
	steerSession(sessionId, "correct direction", undefined, "steer");
	expect(queuedMessages(sessionId).steering[0]).toMatchObject({ id: "steer", state: "staged" });
	expect(() => removeQueuedMessage(sessionId, "steer")).toThrow("Staged");
	finish.release();
	await run;
	expect(model.calls).toHaveLength(3);
	const next = model.calls[1]?.request.input;
	if (!Array.isArray(next)) throw new Error("Missing model input");
	expect(next.filter((item) => item.id === "steer")).toHaveLength(1);
	expect(next.some((item) => item.id === "follow")).toBe(false);
	expect(readSessionRecord(sessionId)?.history.filter((item) => item.id === "steer")).toHaveLength(
		1,
	);
	expect(readSessionRecord(sessionId)?.messages.filter((item) => item.id === "steer")).toHaveLength(
		1,
	);
	expect(queuedMessages(sessionId)).toEqual({ steering: [], followUp: [] });
	expect(frames.map((frame) => frame.seq)).toEqual(frames.map((_, index) => index + 1));
	model.assertComplete();
});
test("unused in-flight steering starts before followups after terminal response", async () => {
	const started = latch();
	const finish = latch();
	const model = new ScriptedModel([
		modelResponder(async () => {
			started.release();
			await finish.promise;
			return [assistantMessage("first done")];
		}),
		done(),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "initial");
	await started.promise;
	followUpSession(sessionId, "follow", undefined, "follow");
	steerSession(sessionId, "steer", undefined, "steer");
	finish.release();
	await run;
	expect(model.calls).toHaveLength(3);
	const second = model.calls[1]?.request.input;
	if (!Array.isArray(second)) throw new Error("Missing next input");
	expect(second.filter((item) => item.id === "steer")).toHaveLength(1);
	expect(second.some((item) => item.id === "follow")).toBe(false);
	model.assertComplete();
});
test("Stop preserves pending followups for editing and withdraws by stable input ID", async () => {
	const model = new ScriptedModel([command("wait", "printf forbidden > forbidden.txt")]);
	configureAgentModelFactory(() => model);
	const ready = latch();
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") ready.release();
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const run = promptSession(sessionId, "initial");
	await ready.promise;
	followUpSession(sessionId, "queued", undefined, "queued");
	await abortSession(sessionId);
	await run;
	expect(queuedMessages(sessionId).followUp).toEqual([
		{ id: "queued", text: "queued", state: "pending" },
	]);
	updateQueuedMessage(sessionId, "queued", "edited");
	expect(() => followUpSession(sessionId, "conflict", undefined, "queued")).toThrow("Conflicting");
	expect(removeQueuedMessage(sessionId, "queued").removed).toMatchObject({
		id: "queued",
		text: "edited",
	});
	expect(model.calls).toHaveLength(1);
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
});
test("closing and reattaching a pending approval rebuilds executors, keeps model retry and executes the same call once", async () => {
	const model = new ScriptedModel([
		command("durable", "printf once >> once.txt"),
		transient(),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const ready = latch();
	let card: ExtUiRequest | undefined;
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") {
			card = request;
			ready.release();
		}
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(sessionId, "run durable");
	await ready.promise;
	const saved = readSessionRecord(sessionId)?.pendingApproval;
	if (!saved) throw new Error("No saved approval");
	await removeSession(sessionId);
	await running;
	expect(readSessionRecord(sessionId)?.pendingApproval?.request.id).toBe(saved.request.id);
	const restored = latch();
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") {
			card = request;
			restored.release();
		}
	});
	await getSessionMessages(sessionId, "workspace", worktree);
	await restored.promise;
	if (!card) throw new Error("Missing restored card");
	expect(card.id).toBe(saved.request.id);
	resolveExtUi(approvalResponse(card, true));
	const deadline = Date.now() + 3000;
	while (getSessionState(sessionId).execution !== "idle") {
		if (Date.now() > deadline) throw new Error("Recovery did not settle");
		await Bun.sleep(5);
	}
	expect(readFileSync(join(worktree, "once.txt"), "utf8")).toBe("once");
	expect(readSessionRecord(sessionId)?.effects.durable).toMatchObject({ status: "completed" });
	expect(model.calls.slice(1).map((call) => call.request.modelSettings.retry?.maxRetries)).toEqual([
		5, 5,
	]);
	expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
	resolveExtUi(approvalResponse(card, true));
	expect(readFileSync(join(worktree, "once.txt"), "utf8")).toBe("once");
	model.assertComplete();
});
test("manual summary uses the configured SDK model and successful replay makes no request", async () => {
	const model = new ScriptedModel([
		modelResponse([assistantMessage("a".repeat(600))]),
		done(),
		modelResponse({
			responseId: "summary-response",
			output: [assistantMessage("Keep fact alpha.")],
			usage: new Usage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
		}),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, `fact alpha ${"x".repeat(600)}`);
	await promptSession(sessionId, "recent fact beta");
	const before = readSessionRecord(sessionId);
	const usageBefore = getSessionStats(sessionId).tokens;
	await compactSession(sessionId, { operationId: "summary" });
	expect(model.calls[2]?.request.modelSettings.retry?.maxRetries).toBe(5);
	expect(getSessionStats(sessionId).tokens.input).toBe(usageBefore.input + 100);
	expect(getSessionStats(sessionId).tokens.output).toBe(usageBefore.output + 20);
	const compacted = readSessionRecord(sessionId);
	expect(compacted?.history.length).toBeLessThan(before?.history.length ?? 0);
	expect(compacted?.messages.filter((item) => item.role !== "compactionSummary")).toEqual(
		before?.messages.filter((item) => item.role !== "compactionSummary"),
	);
	await promptSession(sessionId, "continue");
	const calls = model.calls.length;
	const usageAfter = getSessionStats(sessionId).tokens;
	const history = readSessionRecord(sessionId)?.history;
	await compactSession(sessionId, { operationId: "summary" });
	expect(model.calls.length).toBe(calls);
	expect(getSessionStats(sessionId).tokens).toEqual(usageAfter);
	expect(readSessionRecord(sessionId)?.history).toEqual(history);
	model.assertComplete();
});

test("a tool call interrupted by Stop does not block later summaries", async () => {
	const model = new ScriptedModel([
		command("stopped", "printf forbidden > forbidden.txt"),
		done(),
		done(),
		modelResponse([assistantMessage("Keep fact alpha.")]),
	]);
	configureAgentModelFactory(() => model);
	let ready: (() => void) | undefined;
	const waiting = new Promise<void>((resolve) => {
		ready = resolve;
	});
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") ready?.();
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(sessionId, `fact alpha ${"x".repeat(600)}`);
	await waiting;
	await abortSession(sessionId);
	await running;
	await promptSession(sessionId, "fact beta");
	await promptSession(sessionId, "recent fact gamma");
	const before = readSessionRecord(sessionId)?.history.length ?? 0;
	await compactSession(sessionId, { operationId: "after-stop" });
	expect(readSessionRecord(sessionId)?.history.length).toBeLessThan(before);
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
	model.assertComplete();
});

test("durable questions restore with their original identity and apply each valid answer once", async () => {
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
		modelResponse([functionCall("ask_user_question", args, { callId: "question" })]),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const waiting = latch();
	setSessionStatePublisher((record) => {
		if (record.state.needsInput?.kind === "tool-response") waiting.release();
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const other = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(sessionId, "ask for a color");
	await waiting.promise;
	const original = readSessionRecord(sessionId)?.pendingToolResponse;
	if (!original) throw new Error("Missing pending question");
	expect(
		nudgeSession(
			sessionId,
			`${TODO_NUDGE_PREFIX}Keep the question blocked.`,
			"todo-question-blocked",
		),
	).toEqual({ disposition: "needs_input" });
	expect(readSessionRecord(sessionId)?.pendingToolResponse).toEqual(original);
	expect(readSessionRecord(sessionId)?.queue).toEqual([]);
	await removeSession(sessionId);
	await running;
	saveConfig({
		...loadConfig(),
		disabledExtensions: ["ask-user-question"],
		extensionSettings: { "ask-user-question": { richPreviews: false } },
	});
	const snapshot = await getSessionMessages(sessionId, "workspace", worktree);
	const anchor = snapshot.summary.state?.needsInput;
	if (anchor?.kind !== "tool-response") throw new Error("No restored question anchor");
	expect(anchor.interactionId).toBe(original.id);
	const ownership = {
		interactionId: anchor.interactionId,
		runId: anchor.runId,
		revision: anchor.revision,
	};
	const answer = {
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Which color?", kind: "option", answer: "Blue" }],
	};
	expect(() => respondToTool(other.sessionId, "question", answer, ownership)).toThrow("stale");
	expect(() => respondToTool(sessionId, "other", answer, ownership)).toThrow("stale");
	expect(() =>
		respondToTool(sessionId, "question", answer, {
			...ownership,
			revision: ownership.revision + 1,
		}),
	).toThrow("stale");
	respondToTool(sessionId, "question", answer, ownership);
	respondToTool(sessionId, "question", answer, ownership);
	expect(() =>
		respondToTool(sessionId, "question", { ...answer, cancelled: true }, ownership),
	).toThrow("Conflicting");
	const deadline = Date.now() + 3000;
	while (getSessionState(sessionId).execution !== "idle") {
		if (Date.now() > deadline) throw new Error("Question did not settle");
		await Bun.sleep(5);
	}
	expect(
		readSessionRecord(sessionId)?.messages.filter(
			(item) => item.role === "custom" && item.customType === "tool-response",
		),
	).toHaveLength(1);
	expect(
		readSessionRecord(sessionId)?.history.filter(
			(item) => item.type === "function_call_result" && item.callId === "question",
		),
	).toHaveLength(1);
	const modelInput = model.calls[1]?.request.input;
	expect(JSON.stringify(model.calls[1]?.request.tools)).toContain("previewFile");
	expect(JSON.stringify(modelInput)).toContain("Blue");
	model.assertComplete();
	setSessionStatePublisher(() => {});
});
test("a queued input rejected before model admission can retry with the same ID", async () => {
	configureAgentModelFactory(() => {
		throw new Error("Model preparation failed");
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	steerSession(sessionId, "retry this", undefined, "retry");
	await Bun.sleep(0);
	expect(queuedMessages(sessionId).steering[0]).toMatchObject({
		id: "retry",
		state: "pending",
		error: "Model preparation failed",
	});
	updateQueuedMessage(sessionId, "retry", "edited retry");
	const model = new ScriptedModel([done()]);
	configureAgentModelFactory(() => model);
	await sendSteeringNow(sessionId);
	expect(JSON.stringify(model.calls[0]?.request.input)).toContain("edited retry");
	expect(readSessionRecord(sessionId)?.messages.filter((item) => item.id === "retry")).toHaveLength(
		1,
	);
	expect(readSessionRecord(sessionId)?.history.filter((item) => item.id === "retry")).toHaveLength(
		1,
	);
	expect(queuedMessages(sessionId).steering).toHaveLength(0);
	model.assertComplete();
});
test("restart exposes unknown effects, repairs model history, and never automatically executes them", async () => {
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await removeSession(sessionId);
	const saved = readSessionRecord(sessionId);
	if (!saved) throw new Error("Missing record");
	saved.state.execution = "running";
	saved.state.runId = "interrupted-run";
	saved.effects.effect = {
		runId: "interrupted-run",
		name: "bash",
		arguments: { command: "printf forbidden > forbidden.txt", timeoutMs: 10000 },
		status: "started",
	};
	writeFileSync(sessionRecordPath(sessionId), JSON.stringify(saved));
	const model = new ScriptedModel([done()]);
	configureAgentModelFactory(() => model);
	const snapshot = await getSessionMessages(sessionId, "workspace", worktree);
	expect(snapshot.summary.state?.completion?.outcome).toBe("interrupted");
	expect(model.calls).toHaveLength(0);
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
	expect(readSessionRecord(sessionId)?.effects.effect?.status).toBe("unknown");
	await promptSession(sessionId, "inspect before retrying");
	const input = model.calls[0]?.request.input;
	if (!Array.isArray(input)) throw new Error("Missing model history");
	expect(
		input.filter((item) => item.type === "function_call" && item.callId === "effect"),
	).toHaveLength(1);
	expect(
		input.filter((item) => item.type === "function_call_result" && item.callId === "effect"),
	).toHaveLength(1);
	expect(JSON.stringify(input)).toContain("result is unknown");
	expect(existsSync(join(worktree, "forbidden.txt"))).toBe(false);
	model.assertComplete();
});

test("composer steering supersedes only the pending question and reaches continuation", async () => {
	const args = {
		questions: [
			{
				question: "Which color?",
				header: "Color",
				options: [{ label: "Blue", description: "Use blue" }],
			},
		],
	};
	const model = new ScriptedModel([
		modelResponse([functionCall("ask_user_question", args, { callId: "superseded-question" })]),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const ready = latch();
	setSessionStatePublisher((record) => {
		if (record.state.needsInput?.kind === "tool-response") ready.release();
	});
	let settled = 0;
	setSessionPublisher((frame) => {
		if (frame.event.type === "agent_settled") settled++;
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(sessionId, "ask color");
	await ready.promise;
	steerSession(sessionId, "Use green instead", undefined, "replacement");
	await running;
	const deadline = Date.now() + 3000;
	while (settled < 2 && Date.now() < deadline) await Bun.sleep(5);
	// The superseded question ends its run; the reply starts the next run.
	expect(settled).toBe(2);
	expect(model.calls).toHaveLength(2);
	expect(JSON.stringify(model.calls[1]?.request.input)).toContain("Use green instead");
	expect(readSessionRecord(sessionId)?.pendingToolResponse).toBeUndefined();
	expect(
		readSessionRecord(sessionId)?.messages.filter((item) => item.id === "replacement"),
	).toHaveLength(1);
	expect(getSessionState(sessionId).needsInput).toBeNull();
	model.assertComplete();
	setSessionStatePublisher(() => {});
});

test("new input cancels a detached summary and waits for its model cleanup before another Runner", async () => {
	const started = latch();
	let ended = false;
	const model = new ScriptedModel([
		modelResponse([assistantMessage("a".repeat(600))]),
		done(),
		modelResponder(async ({ request }) => {
			started.release();
			if (!request.signal) throw new Error("Missing summary signal");
			await new Promise<void>((_resolve, reject) => {
				request.signal?.addEventListener(
					"abort",
					() => {
						ended = true;
						reject(new Error("summary cancelled"));
					},
					{ once: true },
				);
			});
			return [assistantMessage("never committed")];
		}),
		modelResponder(() => {
			expect(ended).toBe(true);
			return [assistantMessage("new response")];
		}),
	]);
	configureAgentModelFactory(() => model);
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	await promptSession(sessionId, `history ${"x".repeat(600)}`);
	await promptSession(sessionId, "recent");
	const before = readSessionRecord(sessionId)?.history;
	const summary = compactSession(sessionId, { operationId: "cancelled-summary" }).catch(
		(error) => error,
	);
	await started.promise;
	await promptSession(sessionId, "new input");
	expect(await summary).toBeInstanceOf(Error);
	expect(readSessionRecord(sessionId)?.history.slice(0, before?.length)).toEqual(before);
	expect(readSessionRecord(sessionId)?.summaryOperations["cancelled-summary"]).toBeUndefined();
	model.assertComplete();
});

const IMAGE_PAYLOAD = Buffer.from("sdk-image-bytes-that-stay-on-the-host").toString("base64");
const IMAGE_BLOCK = { type: "image" as const, data: IMAGE_PAYLOAD, mimeType: "image/png" };

for (const outputKind of ["object", "string"] as const) {
	test(`SDK ${outputKind} tool image results retain raw canonical bytes and publish only detached references`, async () => {
		const result = {
			content: [{ type: "text", text: "Captured" }, IMAGE_BLOCK],
			details: { screenshot: IMAGE_BLOCK },
		};
		const factory = spyOn(sdkToolsModule, "workspaceTools").mockImplementation(() => [
			tool({
				name: "fixture_image",
				description: "fixture",
				parameters: z.object({}),
				execute: () =>
					outputKind === "string"
						? JSON.stringify({ ...result, isError: true, terminate: true })
						: result,
			}),
		]);
		try {
			const model = new ScriptedModel([
				modelResponse([functionCall("fixture_image", {}, { callId: "image-result" })]),
				done(),
			]);
			configureAgentModelFactory(() => model);
			const frames: SessionEventPayload[] = [];
			setSessionPublisher((frame) => frames.push(frame));
			const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
			await promptSession(sessionId, "Capture a fixture image");
			expect(JSON.stringify(frames)).not.toContain(IMAGE_PAYLOAD);
			expect(model.calls).toHaveLength(2);
			expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
			const ends = frames.filter(
				(frame) =>
					frame.event.type === "tool_execution_end" && frame.event.toolCallId === "image-result",
			);
			expect(ends).toHaveLength(1);
			expect(JSON.stringify(ends)).toContain(`/images/${sessionId}/`);
			const raw = readSessionRecord(sessionId);
			expect(JSON.stringify(raw?.messages)).toContain(IMAGE_PAYLOAD);
			expect(JSON.stringify(raw)).not.toContain("/images/");
			expect(JSON.stringify(model.calls[1]?.request.input).includes(IMAGE_PAYLOAD)).toBe(
				outputKind === "string",
			);
			const first = await getSessionMessages(sessionId, "workspace", worktree);
			expect(JSON.stringify(first)).not.toContain(IMAGE_PAYLOAD);
			const before = structuredClone(first);
			const user = first.messages.find((message) => message.role === "user");
			if (user?.role === "user") user.content = "mutated snapshot";
			const imageResult = first.messages.find((message) => message.role === "toolResult");
			if (imageResult?.role === "toolResult") imageResult.content.splice(0);
			first.messages.pop();
			expect(await getSessionMessages(sessionId, "workspace", worktree)).toEqual(before);
			const event = frames.find(
				(frame) => frame.event.type === "message_end" && frame.event.message.role === "user",
			);
			if (event?.event.type === "message_end" && event.event.message.role === "user")
				event.event.message.content = "mutated event";
			expect(await getSessionMessages(sessionId, "workspace", worktree)).toEqual(before);
			await removeSession(sessionId);
			const replay = await getSessionMessages(sessionId, "workspace", worktree);
			expect(JSON.stringify(replay)).not.toContain(IMAGE_PAYLOAD);
			expect(JSON.stringify(replay.messages)).toContain(`/images/${sessionId}/`);
			model.assertComplete();
		} finally {
			factory.mockRestore();
		}
	});
}

test("SDK image upload keeps model input and composer restore inline while its live echo is a reference", async () => {
	const catalog = spyOn(modelConfigurationModule, "listAvailableModels").mockResolvedValue([
		{
			id: "fixture-image-model",
			provider: "fixture",
			name: "Image fixture",
			contextWindow: 100_000,
			reasoning: false,
			thinkingLevels: ["off"],
			input: ["text", "image"],
		},
	]);
	try {
		const model = new ScriptedModel([done()]);
		configureAgentModelFactory(() => model);
		const frames: SessionEventPayload[] = [];
		setSessionPublisher((frame) => frames.push(frame));
		const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
		await promptSession(sessionId, "Inspect attached fixture", [IMAGE_BLOCK], "upload-id");
		expect(JSON.stringify(model.calls[0]?.request.input)).toContain(
			`data:image/png;base64,${IMAGE_PAYLOAD}`,
		);
		expect(JSON.stringify(readSessionRecord(sessionId)?.messages)).toContain(IMAGE_PAYLOAD);
		expect(JSON.stringify(frames)).not.toContain(IMAGE_PAYLOAD);
		expect(JSON.stringify(frames)).toContain(`/images/${sessionId}/`);
		const started = latch();
		const release = latch();
		const holding = new ScriptedModel([
			modelResponder(async () => {
				started.release();
				await release.promise;
				return [assistantMessage("done")];
			}),
		]);
		configureAgentModelFactory(() => holding);
		const run = promptSession(sessionId, "Hold");
		await started.promise;
		followUpSession(sessionId, "Restore attached fixture", [IMAGE_BLOCK], "restore-id");
		const restored = clearSessionQueue(sessionId);
		expect(JSON.stringify(restored)).toContain(IMAGE_PAYLOAD);
		release.release();
		await run;
	} finally {
		catalog.mockRestore();
	}
});

test("SDK select display retains exact MCP consent tokens through live and snapshot projections", async () => {
	writeFileSync(
		join(root, "data", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				docs: {
					command: process.execPath,
					args: [join(import.meta.dir, "mcp/fixtures/stdioServer.ts")],
					env: { MCP_FIXTURE_NOTE_FILE: join(root, "note.txt") },
					exposure: "direct",
				},
			},
		}),
	);
	setMcpProjectResolver(undefined);
	const model = new ScriptedModel([
		modelResponse([
			functionCall("mcp__docs__write_note", { text: "kept" }, { callId: "select-write" }),
		]),
		done(),
	]);
	configureAgentModelFactory(() => model);
	const ready = latch();
	const displays: ExtUiRequest[] = [];
	setExtUiPublisher((request) => {
		displays.push(request);
		if (request.kind === "select") ready.release();
	});
	try {
		const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
		const run = promptSession(sessionId, "Write the note");
		await ready.promise;
		const request = pendingExtUiDialog(sessionId);
		if (
			request?.kind !== "select" ||
			!request.runId ||
			request.revision === undefined ||
			!request.toolCallId
		)
			throw new Error("Missing actual MCP consent");
		expect(request.options).toEqual(MCP_CONFIRM_CHOICES);
		expect(displays).toContainEqual(
			expect.objectContaining({ kind: "select", options: MCP_CONFIRM_CHOICES }),
		);
		const before = readSessionRecord(sessionId)?.pendingApproval;
		const snapshot = await getSessionMessages(sessionId, "workspace", worktree);
		expect(snapshot.summary.state?.needsInput).toMatchObject({
			request: { options: MCP_CONFIRM_CHOICES },
		});
		expect(readSessionRecord(sessionId)?.pendingApproval).toEqual(before);
		resolveExtUi({
			id: request.id,
			sessionId,
			runId: request.runId,
			revision: request.revision,
			toolCallId: request.toolCallId,
			value: MCP_CONFIRM_CHAT,
		});
		await run;
		expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("kept");
		expect(readSessionRecord(sessionId)?.decisions[request.id]?.selection).toBe(MCP_CONFIRM_CHAT);
		model.assertComplete();
	} finally {
		await closeAllMcpConnections();
		setMcpProjectResolver(undefined);
	}
});

test("SDK UI display cleans notification and restored approval text without changing execution input", async () => {
	const raw = "\u009b31mraw input\u009b0m";
	const rawOutput = "\u001b[32mtool output\u001b[0m";
	let executed = "";
	const factory = spyOn(sdkToolsModule, "workspaceTools").mockImplementation(() => [
		tool({
			name: "fixture_approval",
			description: "fixture",
			parameters: z.object({ query: z.string() }),
			needsApproval: true,
			execute: ({ query }) => {
				executed = query;
				return rawOutput;
			},
		}),
	]);
	try {
		configureAgentModelFactory(
			() =>
				new ScriptedModel([
					modelResponse([
						functionCall("fixture_approval", { query: raw }, { callId: "ansi-approval" }),
					]),
				]),
		);
		const initial = latch();
		const live: ExtUiRequest[] = [];
		setExtUiPublisher((request) => {
			live.push(request);
			if (request.kind === "confirm") initial.release();
		});
		const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
		const running = promptSession(sessionId, "Ask for approval");
		await initial.promise;
		expect(live).toContainEqual(
			expect.objectContaining({
				kind: "confirm",
				message: JSON.stringify({ query: "raw input" }),
				toolInput: { query: raw },
			}),
		);
		expect(readSessionRecord(sessionId)?.pendingApproval?.request).toMatchObject({
			message: JSON.stringify({ query: raw }),
			toolInput: { query: raw },
		});
		await removeSession(sessionId);
		await running;
		const saved = readSessionRecord(sessionId);
		if (saved?.pendingApproval?.request.kind !== "confirm")
			throw new Error("Missing real SDK approval");
		saved.pendingApproval.request.title = "\u001b[31mApproval\u001b[0m";
		saved.pendingApproval.request.message = "\u001b]0;terminal title\u0007Approve this\u001b[0m";
		if (saved.state.needsInput?.kind === "dialog")
			saved.state.needsInput.request = saved.pendingApproval.request;
		writeSessionRecord(saved);
		const restored = latch();
		const displays: ExtUiRequest[] = [];
		const states: ReturnType<typeof getSessionState>[] = [];
		setExtUiPublisher((request) => {
			displays.push(request);
			if (request.kind === "confirm") restored.release();
		});
		setSessionStatePublisher((record) => states.push(record.state));
		configureAgentModelFactory(() => new ScriptedModel([done()]));
		const snapshot = await getSessionMessages(sessionId, "workspace", worktree);
		await restored.promise;
		const display = pendingExtUiDialog(sessionId);
		expect(display).toMatchObject({ kind: "confirm", title: "Approval", message: "Approve this" });
		expect(displays).toContainEqual(
			expect.objectContaining({ kind: "confirm", title: "Approval", message: "Approve this" }),
		);
		expect(snapshot.summary.state?.needsInput).toMatchObject({
			request: { title: "Approval", message: "Approve this" },
		});
		expect(states).toContainEqual(
			expect.objectContaining({
				needsInput: expect.objectContaining({
					request: expect.objectContaining({ title: "Approval", message: "Approve this" }),
				}),
			}),
		);
		const before = readSessionRecord(sessionId)?.pendingApproval;
		getSessionState(sessionId);
		pendingExtUiDialog(sessionId);
		await getSessionMessages(sessionId, "workspace", worktree);
		expect(readSessionRecord(sessionId)?.pendingApproval).toEqual(before);
		expect(before?.request).toMatchObject({
			title: saved.pendingApproval.request.title,
			message: saved.pendingApproval.request.message,
			toolInput: { query: raw },
		});
		notifyExtUi(sessionId, "\u001b[33mnotice\u001b[0m\n\tkeep spacing", "warning");
		expect(displays.at(-1)).toMatchObject({
			kind: "notify",
			message: "notice\n\tkeep spacing",
			level: "warning",
		});
		if (!display) throw new Error("Missing projected approval");
		resolveExtUi(approvalResponse(display, true));
		await settled(sessionId);
		expect(executed).toBe(raw);
		expect(getSessionState(sessionId).completion?.outcome).toBe("succeeded");
		expect(readSessionRecord(sessionId)?.messages).toContainEqual(
			expect.objectContaining({
				role: "toolResult",
				toolCallId: "ansi-approval",
				content: [{ type: "text", text: rawOutput }],
			}),
		);
		expect((await getSessionMessages(sessionId, "workspace", worktree)).messages).toContainEqual(
			expect.objectContaining({
				role: "toolResult",
				toolCallId: "ansi-approval",
				content: [{ type: "text", text: rawOutput }],
			}),
		);
	} finally {
		factory.mockRestore();
		setSessionStatePublisher(() => {});
	}
});

test("SDK approval display projects argument images while checkpoint and restored canonical results keep bytes", async () => {
	let executions = 0;
	const factory = spyOn(sdkToolsModule, "workspaceTools").mockImplementation(() => [
		tool({
			name: "fixture_image",
			description: "fixture",
			parameters: z.object({}),
			execute: () => {
				executions += 1;
				return { content: [{ type: "text", text: "Captured" }, IMAGE_BLOCK] };
			},
		}),
		tool({
			name: "fixture_approval",
			description: "fixture",
			parameters: z.object({
				shot: z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
			}),
			needsApproval: true,
			execute: () => "approved",
		}),
	]);
	try {
		const model = new ScriptedModel([
			modelResponse([functionCall("fixture_image", {}, { callId: "saved-image" })]),
			modelResponse([
				functionCall("fixture_approval", { shot: IMAGE_BLOCK }, { callId: "image-approval" }),
			]),
		]);
		configureAgentModelFactory(() => model);
		const requested = latch();
		let approval: ExtUiRequest | null = null;
		setExtUiPublisher((request) => {
			approval = request;
			requested.release();
		});
		const frames: SessionEventPayload[] = [];
		setSessionPublisher((frame) => frames.push(frame));
		const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
		const pending = promptSession(sessionId, "Capture then ask");
		await requested.promise;
		expect(JSON.stringify(approval)).not.toContain(IMAGE_PAYLOAD);
		expect(JSON.stringify(getSessionState(sessionId))).not.toContain(IMAGE_PAYLOAD);
		expect(
			JSON.stringify(await getSessionMessages(sessionId, "workspace", worktree)),
		).not.toContain(IMAGE_PAYLOAD);
		expect(JSON.stringify(frames)).not.toContain(IMAGE_PAYLOAD);
		expect(JSON.stringify(readSessionRecord(sessionId)?.pendingApproval)).toContain(IMAGE_PAYLOAD);
		await removeSession(sessionId);
		await pending;
		const savedApproval = readSessionRecord(sessionId);
		if (!savedApproval?.pendingApproval) throw new Error("Missing image approval record");
		savedApproval.pendingApproval.request.title = "\u001b[31mImage approval\u001b[0m";
		if (savedApproval.state.needsInput?.kind === "dialog")
			savedApproval.state.needsInput.request = savedApproval.pendingApproval.request;
		writeSessionRecord(savedApproval);
		const resumed = new ScriptedModel([done()]);
		configureAgentModelFactory(() => resumed);
		await getSessionMessages(sessionId, "workspace", worktree);
		expect(pendingExtUiDialog(sessionId)?.title).toBe("Image approval");
		expect(JSON.stringify(pendingExtUiDialog(sessionId))).toContain(`/images/${sessionId}/`);
		expect(readSessionRecord(sessionId)?.pendingApproval?.request.title).toBe(
			savedApproval.pendingApproval.request.title,
		);
		const request = getSessionState(sessionId).needsInput;
		if (request?.kind !== "dialog") throw new Error("Missing restored approval");
		resolveExtUi(approvalResponse(request.request, true));
		const deadline = Date.now() + 3000;
		while (getSessionState(sessionId).execution !== "idle") {
			if (Date.now() > deadline) throw new Error("Restore did not settle");
			await Bun.sleep(0);
		}
		expect(executions).toBe(1);
		const stored = readSessionRecord(sessionId)?.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "saved-image",
		);
		expect(JSON.stringify(stored)).toContain(IMAGE_PAYLOAD);
		expect(
			JSON.stringify(await getSessionMessages(sessionId, "workspace", worktree)),
		).not.toContain(IMAGE_PAYLOAD);
	} finally {
		factory.mockRestore();
	}
});

test("settings saves request nothing; the next settled check uses the new choice and in-flight summary keeps it", async () => {
	const budget = spyOn(modelConfigurationModule, "modelContextBudget").mockReturnValue(10000);
	const replyStarted = Promise.withResolvers<void>();
	const finishReply = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const model = new ScriptedModel([
		done(),
		done(),
		modelResponder(async () => {
			replyStarted.resolve();
			await finishReply.promise;
			return [assistantMessage("done")];
		}),
		modelResponder(async () => {
			started.resolve();
			await finish.promise;
			return [assistantMessage("ORBIT is blue.")];
		}),
		modelResponder(({ request }) => {
			expect(JSON.stringify(request.input)).toContain("ORBIT is blue.");
			return [assistantMessage("continued")];
		}),
	]);
	configureAgentModelFactory(() => model);
	resetConfigCache();
	try {
		const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
		await promptSession(sessionId, "ORBIT ".repeat(1000));
		await promptSession(sessionId, "newest exchange");
		expect(model.calls).toHaveLength(2);
		const running = promptSession(sessionId, "One more reply");
		await replyStarted.promise;
		updateConfig({ autoSummaryThresholdPercent: 50 });
		expect(model.calls).toHaveLength(3);
		finishReply.resolve();
		await started.promise;
		const before = readSessionRecord(sessionId);
		updateConfig({ autoSummaryThresholdPercent: 90 });
		expect(model.calls).toHaveLength(4);
		finish.resolve();
		await running;
		const after = readSessionRecord(sessionId);
		const operationId = Object.keys(after?.summaryOperations ?? {})[0];
		if (!operationId) throw new Error("Missing automatic summary receipt");
		expect(after?.messages.filter((message) => message.role !== "compactionSummary")).toEqual(
			before?.messages.filter((message) => message.role !== "compactionSummary"),
		);
		await compactSession(sessionId, { operationId, force: false });
		expect(model.calls).toHaveLength(4);
		await promptSession(sessionId, "Recall the fact");
		model.assertComplete();
	} finally {
		budget.mockRestore();
		resetConfigCache();
	}
});

test("dynamic instructions reject mismatched workspace context and revoked authority before requests", async () => {
	for (const invalid of ["identity", "grant"] as const) {
		const model = new ScriptedModel([done()]);
		configureAgentModelFactory(() => model);
		const original = Agent.prototype.getSystemPrompt;
		const consumer = spyOn(Agent.prototype, "getSystemPrompt").mockImplementation(function (
			this: Agent,
			context,
		) {
			if (invalid === "identity") context.context = { workspaceId: "foreign-workspace" };
			else saveWorkspaces([]);
			return original.call(this, context);
		});
		try {
			const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
			await promptSession(sessionId, "Must fail before a request");
			expect(model.calls).toHaveLength(0);
			expect(getSessionState(sessionId).completion?.outcome).toBe("failed");
		} finally {
			consumer.mockRestore();
		}
	}
});

test("identity-only context checkpoints exclude closure services and credentials while admitted instructions reach requests", async () => {
	const sentinel = "closure-service-private-sentinel-7b42";
	const credential = "credential-private-sentinel-c835";
	process.env.OPENAI_API_KEY = credential;
	setSessionResourceCleanup(async () => {
		expect(sentinel).toContain("private-sentinel");
	});
	writeFileSync(join(worktree, "AGENTS.md"), "Approved project instruction: preserve ORBIT.");
	const skill = join(root, "data/skills/private-boundary");
	mkdirSync(skill, { recursive: true });
	writeFileSync(
		join(skill, "SKILL.md"),
		"---\nname: private-boundary\ndescription: Boundary procedure\n---\nApproved Skill instruction: preserve blue.",
	);
	const model = new ScriptedModel([command("private-pause", "true"), done()]);
	configureAgentModelFactory(() => model);
	const ready = Promise.withResolvers<ExtUiRequest>();
	setExtUiPublisher((request) => {
		if (request.kind === "confirm") ready.resolve(request);
	});
	const { sessionId } = await createSession({ cwd: worktree, workspaceId: "workspace" });
	const running = promptSession(sessionId, "/skill:private-boundary Remember ORBIT.");
	const card = await ready.promise;
	const snapshot = await getSessionMessages(sessionId, "workspace", worktree);
	const checkpoint = readSessionRecord(sessionId)?.runCheckpoint?.checkpoint;
	if (!checkpoint) throw new Error("Missing checkpoint");
	const context = JSON.parse(checkpoint) as { context: { context: unknown } };
	expect(context.context.context).toEqual({ workspaceId: "workspace" });
	const requests = JSON.stringify(model.calls);
	expect(requests).toContain("Approved project instruction: preserve ORBIT.");
	expect(requests).toContain("Approved Skill instruction: preserve blue.");
	for (const value of [requests, checkpoint, JSON.stringify(snapshot), JSON.stringify(card)]) {
		expect(value).not.toContain(sentinel);
		expect(value).not.toContain(credential);
	}
	await abortSession(sessionId);
	await running;
});
