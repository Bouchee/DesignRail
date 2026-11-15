import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type ModelResponse, Runner, tool, Usage } from "@openai/agents";
import {
	assistantMessage,
	functionCall,
	modelResponder,
	modelResponse,
	modelStreamResponder,
	ScriptedModel,
} from "@openai/agents/testing";
import type {
	ExtUiRequest,
	PlanReviewOutput,
	SessionEventPayload,
	TranscriptMessage,
} from "@thinkrail/contracts";
import { TODO_NUDGE_PREFIX } from "@thinkrail/contracts";
import { z } from "zod";
import { loadConfig, saveConfig, saveWorkspaces } from "../persistence";
import { configureAgentModelFactory } from "./modelConfiguration";
import { planReviewOutput } from "./planReviewOutput";
import {
	abortSession,
	createSession,
	disposeAllSessions,
	followUpSession,
	getSessionMessages,
	getSessionState,
	nudgeSession,
	promptSession,
	removeSession,
	resolveExtUi,
	runSessionChild,
	sendHostMessageToSession,
	sendReviewFixToSession,
	sendSteeringNow,
	setExtUiPublisher,
	setSessionPublisher,
	settleSessionsForShutdown,
	steerSession,
	subagentTranscript,
	updateQueuedMessage,
} from "./sdkSessionManager";
import {
	listSessionRecords,
	PersistentSession,
	REVIEW_OUTPUT_CONTRACT,
	readSessionRecord,
	writeSessionRecord,
} from "./sessionStore";

const value: PlanReviewOutput = {
	verdict: "request_changes",
	summary: "One issue",
	findings: [{ id: "local-f1", body: "BUG: Fix this", path: "a.ts", startLine: 1 }],
};
const envNames = [
	"THINKRAIL_DATA_DIR",
	"OPENAI_BASE_URL",
	"OPENAI_MODEL",
	"OPENAI_API_KEY",
] as const;
let environment: (string | undefined)[], root: string, cwd: string;
beforeEach(() => {
	environment = envNames.map((key) => process.env[key]);
	root = mkdtempSync(join(tmpdir(), "raildesign-typed-review-"));
	cwd = join(root, "worktree");
	mkdirSync(cwd);
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	process.env.OPENAI_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
	process.env.OPENAI_MODEL = "deepseek-v4.1-flash";
	process.env.OPENAI_API_KEY = "offline-fixture";
	saveWorkspaces([
		{
			id: "workspace",
			projectId: "project",
			name: "Review",
			branch: "test",
			baseBranch: "main",
			worktreePath: cwd,
		},
	]);
	saveConfig({ ...loadConfig(), disabledExtensions: ["web-access"] });
});
afterEach(async () => {
	await settleSessionsForShutdown();
	disposeAllSessions();
	configureAgentModelFactory();
	setSessionPublisher(() => {});
	setExtUiPublisher(() => {});
	envNames.forEach((key, index) => {
		const saved = environment[index];
		if (saved === undefined) delete process.env[key];
		else process.env[key] = saved;
	});
	rmSync(root, { recursive: true, force: true });
});

function response(output = value, status = "completed"): ModelResponse {
	return {
		responseId: "review-response",
		providerData: { status },
		usage: new Usage({ requests: 1, inputTokens: 20, outputTokens: 10, totalTokens: 30 }),
		output: [assistantMessage(JSON.stringify(output), { id: "review-final" })],
	};
}
async function review(model: ScriptedModel, maxTurns = 3) {
	configureAgentModelFactory(() => model);
	const parent = await createSession({ cwd, workspaceId: "workspace" });
	if (!parent.model) throw new Error("Missing model");
	return runSessionChild(parent.sessionId, {
		name: "Plan reviewer",
		instructions: "Review",
		prompt: "Fixture",
		model: parent.model,
		thinkingLevel: "off",
		tools: ["read"],
		maxTurns,
	});
}

for (const failure of ["Stop", "maxTurns", "network"] as const) {
	test(`review preserves completed commentary and usage after a tool then ${failure}`, async () => {
		writeFileSync(join(cwd, "a.ts"), "fixture bytes");
		let commentary: TranscriptMessage | undefined;
		let stopped: Promise<void> | undefined;
		setSessionPublisher((frame) => {
			if (
				frame.event.type === "message_end" &&
				frame.event.message.role === "assistant" &&
				JSON.stringify(frame.event.message.content).includes("Reading a.ts") &&
				!commentary
			)
				commentary = structuredClone(frame.event.message);
			if (failure === "Stop" && frame.event.type === "tool_execution_start")
				stopped = abortSession(frame.sessionId);
		});
		const model = new ScriptedModel([
			modelResponse({
				responseId: "commentary-response",
				providerData: { status: "completed" },
				usage: new Usage({ requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
				output: [
					assistantMessage("Reading a.ts", { id: "commentary" }),
					functionCall("read", { path: "a.ts" }, { callId: "read-before-failure" }),
				],
			}),
			modelResponder(() => {
				throw new Error("Fixture network failure");
			}),
		]);
		const result = await review(model, failure === "maxTurns" ? 1 : 3);
		await stopped;
		expect(commentary).toBeDefined();
		const saved = readSessionRecord(result.sessionId);
		const earlier = saved?.messages.find((message) => message.id === commentary?.id);
		expect(earlier).toEqual(commentary);
		const terminal = saved?.messages.findLast((message) => message.role === "assistant");
		expect(terminal?.id).not.toBe(commentary?.id);
		expect(terminal).toMatchObject({
			role: "assistant",
			stopReason: failure === "Stop" ? "aborted" : failure === "maxTurns" ? "length" : "error",
			usage: { totalTokens: 120 },
		});
		expect(saved?.messages.findIndex((message) => message.id === terminal?.id)).toBeGreaterThan(
			saved?.messages.findIndex((message) => message.id === earlier?.id) ?? -1,
		);
		expect(result.status).toBe(failure === "Stop" ? "aborted" : "error");
		expect(saved?.childRun?.reviewOutput).toBeUndefined();
		expect(model.calls).toHaveLength(failure === "network" ? 2 : 1);
		expect(() => promptSession(result.sessionId, "Restart reviewer")).toThrow("read-only");
		expect(readSessionRecord(result.sessionId)).toEqual(saved);
	});
}

test("active review rejects steering and follow-up before writes and still completes its typed verdict", async () => {
	let entered!: () => void, release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const model = new ScriptedModel([
		modelResponder(async () => {
			entered();
			await gate;
			return response();
		}),
	]);
	const running = review(model);
	await waiting;
	const child = listSessionRecords().find((record) => record.childRun?.purpose === "review");
	if (!child) throw new Error("Missing active review");
	const before = readSessionRecord(child.sessionId);
	const rejected: string[] = [];
	for (const [name, admit] of [
		[
			"steer",
			() => steerSession(child.sessionId, "Unsupported steering", undefined, "review-steer"),
		],
		[
			"followUp",
			() =>
				followUpSession(child.sessionId, "Unsupported follow-up", undefined, "review-follow-up"),
		],
		["nudge", () => nudgeSession(child.sessionId, `${TODO_NUDGE_PREFIX}New input`, "review-nudge")],
		[
			"host",
			() =>
				sendHostMessageToSession(child.sessionId, "continue-in-workspace-request", "Continue", {
					operationId: "review-host",
					projectId: "project",
					projectName: "Project",
				}),
		],
		["fix", () => sendReviewFixToSession(child.sessionId, "Fix this", {})],
		["prompt", () => promptSession(child.sessionId, "Another prompt")],
		["flush", () => sendSteeringNow(child.sessionId)],
		["edit", () => updateQueuedMessage(child.sessionId, "review-follow-up", "Changed input")],
	] as const) {
		try {
			await admit();
		} catch (error) {
			if (error instanceof Error && error.message.includes("read-only")) rejected.push(name);
		}
	}
	const after = readSessionRecord(child.sessionId);
	release();
	const result = await running;
	expect(rejected).toEqual([
		"steer",
		"followUp",
		"nudge",
		"host",
		"fix",
		"prompt",
		"flush",
		"edit",
	]);
	expect(after).toEqual(before);
	expect(result).toMatchObject({ status: "completed", output: value });
	expect(readSessionRecord(child.sessionId)?.queue).toEqual([]);
	expect(model.calls).toHaveLength(1);
});

test("ordinary child follow-up queues still run after the active prompt", async () => {
	let entered!: () => void, release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const model = new ScriptedModel([
		modelResponder(async () => {
			entered();
			await gate;
			return { usage: new Usage({ requests: 1 }), output: [assistantMessage("First done")] };
		}),
		modelResponse([assistantMessage("Follow-up done")]),
	]);
	configureAgentModelFactory(() => model);
	const parent = await createSession({ cwd, workspaceId: "workspace" });
	const child = await createSession({
		cwd,
		workspaceId: "workspace",
		childRun: {
			parentSessionId: parent.sessionId,
			toolCallId: "generic-owner",
			task: "Ordinary task",
			enabledExtensions: [],
			detached: false,
			createdAt: new Date().toISOString(),
			status: "running",
			completionDelivered: false,
			collected: false,
			definition: {
				name: "Worker",
				description: "Work",
				source: "builtin",
				systemPrompt: "Work",
				tools: ["read"],
			},
		},
	});
	const running = promptSession(child.sessionId, "First prompt");
	await waiting;
	followUpSession(child.sessionId, "Follow-up prompt", undefined, "ordinary-follow-up");
	expect(readSessionRecord(child.sessionId)?.queue).toHaveLength(1);
	release();
	await running;
	expect(readSessionRecord(child.sessionId)?.queue).toEqual([]);
	expect(
		readSessionRecord(child.sessionId)
			?.messages.filter((message) => message.role === "user")
			.map((message) => message.content),
	).toEqual(["First prompt", "Follow-up prompt"]);
	expect(model.calls).toHaveLength(2);
});

test("selected review commits typed output to its exact final message despite later reasoning; reload and second-client reads use the same object", async () => {
	const final = response();
	final.output.push({
		type: "reasoning",
		id: "later-reasoning",
		content: [{ type: "input_text", text: "Later reasoning" }],
	});
	const model = new ScriptedModel([modelResponse(final)]);
	const frames: SessionEventPayload[] = [];
	setSessionPublisher((frame) => frames.push(structuredClone(frame)));
	const result = await review(model);
	expect(result.status).toBe("completed");
	expect(result.output).toEqual(value);
	const saved = readSessionRecord(result.sessionId);
	expect(saved?.childRun?.outputContract).toBe(REVIEW_OUTPUT_CONTRACT);
	const binding = saved?.childRun?.reviewOutput;
	if (!binding) throw new Error("Missing binding");
	const message = saved?.messages.find((message) => message.id === binding.messageId);
	expect(message).toMatchObject({
		role: "assistant",
		planReview: value,
		stopReason: "stop",
		usage: { totalTokens: 30 },
	});
	expect(saved?.messages.at(-1)?.id).not.toBe(binding.messageId);
	const corrections = frames.filter(
		(frame) =>
			frame.sessionId === result.sessionId &&
			frame.event.type === "message_end" &&
			"id" in frame.event.message &&
			frame.event.message.id === binding.messageId,
	);
	expect(corrections.length).toBeGreaterThanOrEqual(2);
	expect(corrections[0]?.event).not.toHaveProperty("message.planReview");
	expect(
		corrections.find(
			(frame) =>
				frame.event.type === "message_end" &&
				frame.event.message.role === "assistant" &&
				frame.event.message.planReview,
		)?.event,
	).toMatchObject({ message: { id: binding.messageId, planReview: value } });
	expect(model.calls[0]?.request.outputType).toMatchObject({ type: "json_schema", strict: true });
	if (!saved?.childRun) throw new Error("Missing child");
	expect(
		(await subagentTranscript("workspace", saved.childRun.parentSessionId, result.sessionId))
			.messages,
	).toEqual(saved.messages);
	await removeSession(result.sessionId);
	expect((await getSessionMessages(result.sessionId, "workspace", cwd)).messages).toEqual(
		saved.messages,
	);
	expect(model.calls).toHaveLength(1);
	expect(() => promptSession(result.sessionId, "another review")).toThrow("read-only");
	expect(readSessionRecord(result.sessionId)?.childRun?.reviewOutput).toEqual(binding);
});

test("review final getter failure and typed-persistence failure cannot complete a child", async () => {
	for (const failure of ["getter", "write"] as const) {
		const model = new ScriptedModel([modelResponse(response())]);
		const process = Agent.prototype.processFinalOutput;
		const update = PersistentSession.prototype.update;
		let reads = 0,
			rejected = false;
		const getter = spyOn(Agent.prototype, "processFinalOutput").mockImplementation(function (
			this: Agent,
			text,
		) {
			if (failure === "getter" && ++reads === 2) throw new Error("final getter failed");
			return process.call(this, text);
		});
		const writer = spyOn(PersistentSession.prototype, "update").mockImplementation(function (
			this: PersistentSession,
			change,
			revision,
		) {
			const candidate = structuredClone(this.record);
			change(candidate);
			if (failure === "write" && !rejected && candidate.childRun?.reviewOutput) {
				rejected = true;
				throw new Error("typed write failed");
			}
			return update.call(this, change, revision);
		});
		try {
			const result = await review(model);
			expect(result.status).toBe("error");
			expect(result.output).toBeUndefined();
			const saved = readSessionRecord(result.sessionId);
			expect(saved?.childRun?.reviewOutput).toBeUndefined();
			expect(
				saved?.messages.some((message) => message.role === "assistant" && message.planReview),
			).toBe(false);
			expect(saved?.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		} finally {
			getter.mockRestore();
			writer.mockRestore();
		}
	}
});

test("Stop while final validation commits blocks typed success", async () => {
	const update = PersistentSession.prototype.update;
	let stopped: Promise<void> | undefined;
	const writer = spyOn(PersistentSession.prototype, "update").mockImplementation(function (
		this: PersistentSession,
		change,
		revision,
	) {
		const candidate = structuredClone(this.record);
		change(candidate);
		if (!stopped && candidate.childRun?.reviewOutput) stopped = abortSession(this.record.sessionId);
		return update.call(this, change, revision);
	});
	try {
		const result = await review(new ScriptedModel([modelResponse(response())]));
		await stopped;
		expect(result.status).toBe("aborted");
		expect(result.output).toBeUndefined();
		expect(readSessionRecord(result.sessionId)?.childRun?.reviewOutput).toBeUndefined();
	} finally {
		writer.mockRestore();
	}
});

test("a streaming projection write failure aborts the producer before its next tool or model effect", async () => {
	let signal: AbortSignal | undefined,
		effects = 0;
	const model = new ScriptedModel([
		modelStreamResponder(({ request }) => {
			signal = request.signal;
			return (async function* () {
				yield { type: "output_text_delta" as const, delta: "provisional" };
				await new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				if (!signal?.aborted) effects++;
			})();
		}),
	]);
	const update = PersistentSession.prototype.update;
	let failed = false;
	const writer = spyOn(PersistentSession.prototype, "update").mockImplementation(function (
		this: PersistentSession,
		change,
		revision,
	) {
		if (
			!failed &&
			this.record.childRun &&
			this.record.messages.some((message) => message.role === "assistant")
		) {
			failed = true;
			throw new Error("streamed milestone write failed");
		}
		return update.call(this, change, revision);
	});
	try {
		const result = await review(model);
		expect(result.status).toBe("error");
		expect(signal?.aborted).toBe(true);
		expect(effects).toBe(0);
		expect(model.calls).toHaveLength(1);
	} finally {
		writer.mockRestore();
	}
});

test("nonterminal response/message and mixed refusal never acquire typed authority", async () => {
	for (const condition of [
		"in_progress",
		"cancelled",
		"message_incomplete",
		"mixed_refusal",
	] as const) {
		const final = response(
			value,
			condition === "in_progress" || condition === "cancelled" ? condition : "completed",
		);
		const message = final.output[0];
		if (!message || !("role" in message) || message.role !== "assistant")
			throw new Error("Missing message");
		if (condition === "message_incomplete") message.status = "incomplete";
		if (condition === "mixed_refusal") message.content.push({ type: "refusal", refusal: "No" });
		const result = await review(new ScriptedModel([modelResponse(final)]));
		expect(result.status).toBe("error");
		expect(result.output).toBeUndefined();
		expect(readSessionRecord(result.sessionId)?.childRun?.reviewOutput).toBeUndefined();
	}
});

test("old incompatible pending review checkpoints explicitly stop before continuation; completed old histories stay readable", async () => {
	const result = await review(new ScriptedModel([modelResponse(response())]));
	await removeSession(result.sessionId);
	const saved = readSessionRecord(result.sessionId);
	if (!saved?.childRun) throw new Error("Missing child");
	delete saved.childRun.outputContract;
	delete saved.childRun.reviewOutput;
	for (const message of saved.messages) if (message.role === "assistant") delete message.planReview;
	writeSessionRecord(saved);
	expect((await getSessionMessages(saved.sessionId, "workspace", cwd)).messages).toEqual(
		saved.messages,
	);
	await removeSession(saved.sessionId);
	saved.state.execution = "running";
	saved.childRun.status = "running";
	delete saved.childRun.finishedAt;
	saved.runCheckpoint = {
		runId: saved.state.runId ?? "old-run",
		checkpoint: "must not parse",
		granted: true,
		enabledExtensions: [],
	};
	writeSessionRecord(saved);
	const model = new ScriptedModel([]);
	configureAgentModelFactory(() => model);
	await getSessionMessages(saved.sessionId, "workspace", cwd);
	for (let i = 0; i < 100 && getSessionState(saved.sessionId).execution !== "idle"; i++)
		await Bun.sleep(1);
	expect(model.calls).toHaveLength(0);
	expect(readSessionRecord(saved.sessionId)?.messages.at(-1)).toMatchObject({
		stopReason: "error",
		errorMessage: expect.stringContaining("Unsupported Plan review output contract"),
	});
	expect(
		listSessionRecords().find((record) => record.sessionId === saved.sessionId)?.runCheckpoint,
	).toBeUndefined();
	saved.pendingApproval = {
		request: {
			id: "old-approval",
			sessionId: saved.sessionId,
			runId: saved.state.runId ?? "old-run",
			toolCallId: "old-read",
			revision: 1,
			kind: "confirm",
			title: "Old review",
			message: "Read",
		},
		checkpoint: "must not parse",
	};
	writeSessionRecord(saved);
	disposeAllSessions();
	await getSessionMessages(saved.childRun.parentSessionId, "workspace", cwd);
	const reconciled = readSessionRecord(saved.sessionId);
	expect(reconciled?.childRun).toMatchObject({
		status: "error",
		abortReason: expect.stringContaining("Unsupported Plan review output contract"),
	});
	expect(reconciled?.pendingApproval).toBeUndefined();
	expect(model.calls).toHaveLength(0);
});

test("current review approval recovery rebuilds the same schema, preserves usage and executes a read once", async () => {
	writeFileSync(join(cwd, "a.ts"), "fixture bytes");
	const model = new ScriptedModel([
		modelResponse({
			output: [functionCall("read", { path: "a.ts" }, { callId: "review-read" })],
			usage: new Usage({ requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
		}),
		modelResponse(response()),
	]);
	configureAgentModelFactory(() => model);
	const parent = await createSession({ cwd, workspaceId: "workspace" });
	if (!parent.model) throw new Error("Missing parent model");
	const child = await createSession({
		cwd,
		workspaceId: "workspace",
		model: parent.model,
		childRun: {
			parentSessionId: parent.sessionId,
			purpose: "review",
			outputContract: REVIEW_OUTPUT_CONTRACT,
			toolCallId: "review-owner",
			task: "Inspect a.ts",
			enabledExtensions: [],
			detached: false,
			createdAt: new Date().toISOString(),
			status: "running",
			completionDelivered: false,
			collected: false,
			definition: {
				name: "Plan reviewer",
				description: "Review",
				source: "builtin",
				systemPrompt: "Review",
				tools: ["read"],
			},
		},
	});
	const fixtureAgent = new Agent({
		name: "Plan reviewer",
		outputType: planReviewOutput,
		model,
		tools: [
			tool({
				name: "read",
				description: "Read",
				parameters: z.object({ path: z.string() }),
				needsApproval: true,
				execute: () => {
					throw new Error("Fixture effect must never execute");
				},
			}),
		],
	});
	const pending = await new Runner({ tracingDisabled: true }).run(fixtureAgent, "Inspect a.ts", {
		context: { workspaceId: "workspace" },
		maxTurns: 3,
	});
	expect(pending.interruptions).toHaveLength(1);
	await removeSession(child.sessionId);
	const saved = readSessionRecord(child.sessionId);
	if (!saved?.childRun) throw new Error("Missing child");
	const card: Extract<ExtUiRequest, { kind: "confirm" }> = {
		id: "review-approval",
		sessionId: child.sessionId,
		runId: "review-run",
		toolCallId: "review-read",
		revision: 1,
		kind: "confirm",
		title: "Read fixture",
		message: "Read a.ts",
	};
	saved.state.runId = "review-run";
	saved.state.execution = "running";
	saved.state.needsInput = { kind: "dialog", interactionId: card.id, request: card };
	saved.state.completion = null;
	saved.history = pending.history;
	saved.childRun.status = "running";
	delete saved.childRun.finishedAt;
	saved.pendingApproval = {
		request: { ...card, runId: "review-run", revision: 1, toolCallId: "review-read" },
		checkpoint: pending.state.toString(),
	};
	saved.runCheckpoint = {
		runId: "review-run",
		granted: true,
		enabledExtensions: [],
		checkpoint: pending.state.toString(),
	};
	writeSessionRecord(saved);
	setExtUiPublisher(() => {});
	const snapshot = await getSessionMessages(child.sessionId, "workspace", cwd);
	expect(snapshot.summary.state?.needsInput?.kind).toBe("dialog");
	resolveExtUi({
		id: card.id,
		sessionId: child.sessionId,
		runId: "review-run",
		revision: 1,
		toolCallId: "review-read",
		value: true,
	});
	for (let i = 0; i < 1000 && getSessionState(child.sessionId).execution !== "idle"; i++)
		await Bun.sleep(1);
	const restored = readSessionRecord(child.sessionId);
	expect(restored?.childRun?.status).toBe("completed");
	expect(restored?.childRun?.reviewOutput?.runId).toBe("review-run");
	expect(restored?.effects["review-read"]?.status).toBe("completed");
	expect(
		restored?.messages.find((message) => message.role === "assistant" && message.planReview),
	).toMatchObject({ planReview: value, usage: { totalTokens: 150 } });
	expect(model.calls[1]?.request.outputType).toEqual(model.calls[0]?.request.outputType);
	resolveExtUi({
		id: card.id,
		sessionId: child.sessionId,
		runId: "review-run",
		revision: 1,
		toolCallId: "review-read",
		value: true,
	});
	expect(model.calls).toHaveLength(2);
});
