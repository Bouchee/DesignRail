import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assistantMessage,
	functionCall,
	modelResponse,
	ScriptedModel,
} from "@openai/agents/testing";
import {
	PROTOCOL_VERSION,
	type Workspace,
	WS_CHANNELS,
	type WsMethodName,
	type WsParams,
	type WsResult,
} from "@thinkrail/contracts";
import { configureAgentModelFactory } from "../agent";
import { removeWorkspaceArtifacts } from "../artifacts";
import { loadConfig, resetChatsStoreForTests, saveConfig } from "../persistence";
import { resetConfigCache } from "../settings";
import { setTrashImplementationForTests } from "../trash";
import { resetChatIdCache } from "../workspaces";
import { seedSdkTestModel } from "./sdkTestFixture";
import { createServer, type RunningServer } from "./server";
import { until } from "./testFixtures";

const CONTEXT = ".raildesign/context";
const savedDataDir = process.env.THINKRAIL_DATA_DIR;
let directory: string;
let server: RunningServer;
let socket: WebSocket;
let workspace: Workspace;
let model: ReturnType<typeof seedSdkTestModel>;
let nudges: string[];
let request: <M extends WsMethodName>(method: M, params: WsParams<M>) => Promise<WsResult<M>>;

beforeEach(async () => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "raildesign-artifacts-wiring-")));
	process.env.THINKRAIL_DATA_DIR = join(directory, "data");
	resetConfigCache();
	resetChatsStoreForTests();
	resetChatIdCache();
	model = seedSdkTestModel(join(directory, "data"), "artifacts");
	saveConfig({ ...loadConfig(), disabledExtensions: ["web-access"], subagentsEnabled: true });
	setTrashImplementationForTests(async (input) => {
		for (const path of typeof input === "string" ? [input] : input)
			rmSync(path, { recursive: true, force: true });
	});
	server = await createServer({ port: 0, host: "127.0.0.1" });
	socket = new WebSocket(
		`ws://127.0.0.1:${server.port}/ws?protocol=${PROTOCOL_VERSION}&client=artifacts-test`,
	);
	const replies = new Map<string, { ok: boolean; result?: unknown; error?: string }>();
	let welcomed = false;
	nudges = [];
	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(String(event.data));
		if (frame.channel === WS_CHANNELS.serverWelcome) welcomed = true;
		if (frame.channel === WS_CHANNELS.workspaceArtifactsChanged)
			nudges.push(frame.data.workspaceId);
		if (typeof frame.id === "string") {
			replies.set(frame.id, frame);
			socket.send(JSON.stringify({ ack: [frame.id] }));
		}
	});
	await until(() => welcomed, "artifacts welcome");
	let sequence = 0;
	request = async <M extends WsMethodName>(
		method: M,
		params: WsParams<M>,
	): Promise<WsResult<M>> => {
		const id = `artifact-${++sequence}`;
		socket.send(JSON.stringify({ id, method, params }));
		await until(() => replies.has(id), method);
		const reply = replies.get(id);
		if (!reply?.ok) throw new Error(reply?.error ?? "No response");
		return reply.result as WsResult<M>;
	};
	const path = join(directory, "repo");
	mkdirSync(path);
	for (const args of [
		["init", "-b", "main"],
		[
			"-c",
			"user.email=fixture@raildesign.invalid",
			"-c",
			"user.name=Fixture",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			"fixture",
		],
	]) {
		const run = Bun.spawnSync(["git", ...args], { cwd: path, stdout: "pipe", stderr: "pipe" });
		if (!run.success) throw new Error(run.stderr.toString());
	}
	const project = await request("project.open", { path });
	const records = await request("workspace.list", {
		projectId: project.id,
		includeDiffStats: false,
	});
	const found = records.find((item) => item.kind === "default");
	if (!found) throw new Error("Missing workspace");
	workspace = found;
});
afterEach(async () => {
	socket?.close();
	await server?.shutdown();
	configureAgentModelFactory();
	setTrashImplementationForTests(undefined);
	if (workspace) removeWorkspaceArtifacts(workspace.id);
	resetConfigCache();
	resetChatIdCache();
	resetChatsStoreForTests();
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
	rmSync(directory, { recursive: true, force: true });
});
const call = (name: string, args: unknown, callId: string) =>
	modelResponse([functionCall(name, JSON.stringify(args), { callId })]);
const done = () => modelResponse([assistantMessage("done")]);
async function turn(sessionId: string, previousCompletionId?: string) {
	await request("session.prompt", {
		sessionId,
		text: `Run the next fixture turn ${previousCompletionId ?? "first"}`,
	});
	const answered = new Set<string>();
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		const snapshot = await request("session.getMessages", { workspaceId: workspace.id, sessionId });
		const state = snapshot.summary.state;
		const pending = state?.needsInput;
		if (pending?.kind === "dialog" && !answered.has(pending.interactionId)) {
			const approval = pending.request;
			if (
				approval.kind !== "confirm" ||
				!approval.runId ||
				!approval.toolCallId ||
				approval.revision === undefined
			)
				throw new Error("Unexpected interaction");
			const args = approval.toolInput ?? {};
			if (
				!(
					args.path === `${CONTEXT}/proof.md` ||
					args.path === `${CONTEXT}/child.md` ||
					args.command === "mkdir -p out && printf output > out/result.txt"
				)
			)
				throw new Error("Unexpected effect");
			answered.add(pending.interactionId);
			await request("session.extUiReply", {
				response: {
					id: approval.id,
					sessionId: approval.sessionId,
					runId: approval.runId,
					toolCallId: approval.toolCallId,
					revision: approval.revision,
					value: true,
				},
			});
		}
		if (
			state?.execution === "idle" &&
			state.completion?.completionId !== previousCompletionId &&
			state.completion
		) {
			expect(state.completion.outcome).toBe("succeeded");
			return snapshot;
		}
		await Bun.sleep(10);
	}
	throw new Error("Artifact SDK turn did not settle");
}

test("real SDK apply_patch and visualize publish parent-owned artifacts and restore the latest atomic replacement", async () => {
	const path = `${CONTEXT}/proof.md`;
	writeFileSync(join(workspace.worktreePath, ".gitignore"), "out/\n");
	const scripted = new ScriptedModel([
		call("apply_patch", { path, original: null, diff: "+v1\n+\n" }, "create"),
		call(
			"visualize",
			{ type: "diagram", title: "Flow", mermaid: "flowchart LR\n A --> B" },
			"diagram",
		),
		call(
			"visualize",
			{
				type: "comparison",
				title: "Choice",
				options: [
					{ name: "One", pros: ["good"], cons: ["cost"] },
					{ name: "Two", pros: ["fast"], cons: ["risk"] },
				],
			},
			"comparison",
		),
		done(),
		call("apply_patch", { path, original: "v1\n", diff: "@@\n-v1\n+v2\n" }, "update"),
		call(
			"bash",
			{ command: "mkdir -p out && printf output > out/result.txt", timeoutMs: 10000 },
			"output",
		),
		done(),
	]);
	configureAgentModelFactory(() => scripted);
	const { sessionId } = await request("session.create", { workspaceId: workspace.id, model });
	const first = await turn(sessionId);
	const initial = await request("artifacts.list", { workspaceId: workspace.id });
	expect(initial.artifacts).toHaveLength(3);
	expect(initial.artifacts.every((item) => item.sessionId === sessionId)).toBe(true);
	const stamp = initial.artifacts.find((item) => item.path === path)?.firstSeenAt;
	const saved = initial.artifacts.filter((item) => item.path.includes("/visualize/"));
	for (const row of saved)
		expect(
			(await request("fs.readFile", { workspaceId: workspace.id, path: row.path })).content,
		).toMatch(/Flow|Choice/);
	const second = await turn(sessionId, first.summary.state?.completion?.completionId);
	expect(second.summary.state?.completion?.completionId).not.toBe(
		first.summary.state?.completion?.completionId,
	);
	expect((await request("fs.readFile", { workspaceId: workspace.id, path })).content).toBe("v2\n");
	let outputs = await request("artifacts.list", { workspaceId: workspace.id });
	const deadline = Date.now() + 5000;
	while (!outputs.outputs?.some((item) => item.path === "out") && Date.now() < deadline) {
		await Bun.sleep(10);
		outputs = await request("artifacts.list", { workspaceId: workspace.id });
	}
	expect(outputs.outputs).toEqual(
		expect.arrayContaining([expect.objectContaining({ path: "out", files: 1, sessionId })]),
	);
	rmSync(join(workspace.worktreePath, path));
	expect(
		(await request("artifacts.list", { workspaceId: workspace.id })).artifacts.find(
			(item) => item.path === path,
		)?.state,
	).toBe("deleted");
	await request("artifacts.restore", { workspaceId: workspace.id, path });
	expect((await request("fs.readFile", { workspaceId: workspace.id, path })).content).toBe("v2\n");
	expect(
		(await request("artifacts.list", { workspaceId: workspace.id })).artifacts.find(
			(item) => item.path === path,
		),
	).toMatchObject({ state: "live", firstSeenAt: stamp, sessionId });
	expect(nudges).toContain(workspace.id);
	expect(
		first.messages
			.filter((item) => item.role === "toolResult")
			.every((item) => item.role === "toolResult" && !item.isError),
	).toBe(true);
	expect(
		second.messages
			.filter((item) => item.role === "toolResult")
			.every((item) => item.role === "toolResult" && !item.isError),
	).toBe(true);
	scripted.assertComplete();
}, 30000);

test("a real SDK child writer attributes its artifact to the openable parent chat", async () => {
	const { sessionId } = await request("session.create", { workspaceId: workspace.id, model });
	const parent = new ScriptedModel([
		call(
			"Agent",
			{
				subagent_type: "worker",
				task: "Create a child artifact",
				model: null,
				run_in_background: false,
			},
			"delegate",
		),
		done(),
	]);
	const child = new ScriptedModel([
		call(
			"apply_patch",
			{ path: `${CONTEXT}/child.md`, original: null, diff: "+child\n" },
			"child-write",
		),
		done(),
	]);
	configureAgentModelFactory((_model, id) => (id === sessionId ? parent : child));
	await turn(sessionId);
	const row = (await request("artifacts.list", { workspaceId: workspace.id })).artifacts[0];
	expect(row).toMatchObject({ path: `${CONTEXT}/child.md`, sessionId, state: "live" });
	expect(
		(await request("session.list", { workspaceId: workspace.id })).map((item) => item.sessionId),
	).toEqual([sessionId]);
	parent.assertComplete();
	child.assertComplete();
}, 30000);

test("public artifact mutations retain user intent and reject closed or removed workspace access", async () => {
	const path = `${CONTEXT}/user.md`;
	mkdirSync(join(workspace.worktreePath, CONTEXT), { recursive: true });
	writeFileSync(join(workspace.worktreePath, path), "user");
	await request("artifacts.list", { workspaceId: workspace.id });
	await request("fs.rename", { workspaceId: workspace.id, path, name: "renamed.md" });
	const renamed = `${CONTEXT}/renamed.md`;
	expect(
		(await request("artifacts.list", { workspaceId: workspace.id })).artifacts.map(
			(item) => item.path,
		),
	).toEqual([renamed]);
	await request("fs.delete", { workspaceId: workspace.id, path: renamed });
	expect((await request("artifacts.list", { workspaceId: workspace.id })).artifacts).toEqual([]);
	expect(existsSync(join(workspace.worktreePath, renamed))).toBe(false);
	await request("project.close", { id: workspace.projectId });
	await expect(request("artifacts.list", { workspaceId: workspace.id })).rejects.toThrow(
		"Unknown workspace",
	);
	await expect(
		request("artifacts.restore", { workspaceId: workspace.id, path: renamed }),
	).rejects.toThrow("Unknown workspace");
});
