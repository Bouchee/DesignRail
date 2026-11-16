import { beforeEach, expect, test } from "bun:test";
import type {
	AgentTransferMessage,
	AssistantMessage,
	ExtUiRequest,
	SessionEventPayload,
	SessionState,
	SessionSummary,
	UserMessage,
	WireCompactionSummary,
} from "@thinkrail/contracts";
import { messagesToRuntime } from "../chat/hydrate";
import { deriveRows } from "../chat/rows";
import { EMPTY_RUNTIME, reduceSessionEvent, useAppStore } from "./appStore";

const assistant = (text: string): AssistantMessage => ({
	id: "assistant-1",
	role: "assistant",
	content: [{ type: "text", text }],
	api: "responses",
	provider: "custom-go",
	model: "deepseek-v4.1-flash",
	timestamp: 1,
	stopReason: "stop",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});
const payload = (seq: number, text: string, sessionId = "session"): SessionEventPayload => ({
	sessionId,
	runId: "run",
	seq,
	event: { type: "message_end", message: assistant(text) },
});
const approval = (runId: string, revision: number): Extract<ExtUiRequest, { kind: "confirm" }> => ({
	id: "approval",
	sessionId: "session",
	runId,
	revision,
	toolCallId: "call",
	kind: "confirm",
	title: "Allow bash?",
	message: "echo approved",
});
const approvalSummary = (
	request: ReturnType<typeof approval>,
): SessionSummary & { state: SessionState } => ({
	sessionId: request.sessionId,
	workspaceId: "workspace",
	title: "Task",
	model: null,
	thinkingLevel: "off",
	isStreaming: true,
	messageCount: 0,
	updatedAt: 1,
	live: true,
	state: {
		execution: "running",
		runId: request.runId ?? null,
		needsInput: { interactionId: request.id, kind: "dialog", request },
		completion: null,
		completionUnread: false,
		queuedCount: 0,
		backgroundWork: false,
	},
});

beforeEach(() =>
	useAppStore.setState({
		sessions: {},
		sessionEventsBeforeHydration: {},
		tabsByWorkspace: {},
		removedWorkspaceIds: {},
		deletedSessionsByWorkspace: {},
		closedChatsByWorkspace: {},
		activeTabByWorkspace: {},
		sessionStateByWorkspace: {},
		extUiOrphans: [],
	}),
);

test("typed final correction survives peers, watermark replay and refresh on the original message", () => {
	const partial = assistant("provisional");
	const final: AssistantMessage = {
		...assistant("canonical JSON"),
		planReview: { verdict: "approve", summary: "Complete", findings: [] },
	};
	const frame: SessionEventPayload = {
		sessionId: "review",
		runId: "run",
		seq: 3,
		event: { type: "message_end", message: final },
	};
	const peer = reduceSessionEvent(
		reduceSessionEvent(EMPTY_RUNTIME, { type: "message_start", message: partial }),
		frame.event,
	);
	expect(peer.turns).toEqual(messagesToRuntime([final]).turns);
	const store = useAppStore.getState();
	store.beginSessionHydration("review");
	store.handleSessionEvents([frame]);
	store.hydrateSession(
		{
			sessionId: "review",
			workspaceId: "workspace",
			title: "Review",
			model: null,
			thinkingLevel: "off",
			isStreaming: false,
			messageCount: 1,
			updatedAt: 1,
			live: true,
			eventSeq: 2,
		},
		messagesToRuntime([partial]),
	);
	const current = useAppStore.getState().sessions.review;
	expect(current?.turns).toEqual(peer.turns);
	store.handleSessionEvents([
		frame,
		{ ...frame, seq: 2, event: { type: "message_end", message: partial } },
	]);
	expect(useAppStore.getState().sessions.review).toBe(current);
	expect(messagesToRuntime(JSON.parse(JSON.stringify([final]))).turns).toEqual(peer.turns);
});

test("a final correction updates its stable message even after streaming ends", () => {
	let runtime = reduceSessionEvent(EMPTY_RUNTIME, {
		type: "message_start",
		message: assistant(""),
	});
	runtime = reduceSessionEvent(runtime, {
		type: "message_update",
		message: assistant("partial"),
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "partial",
			partial: assistant("partial"),
		},
	});
	runtime = reduceSessionEvent(runtime, payload(1, "final").event);
	runtime = reduceSessionEvent(runtime, payload(2, "corrected final").event);
	expect(runtime.turns).toHaveLength(1);
	expect(runtime.turns[0]).toMatchObject({
		id: "assistant-1",
		streaming: false,
		message: assistant("corrected final"),
	});
	expect(messagesToRuntime([assistant("corrected final")]).turns[0]?.id).toBe("assistant-1");
});

test("a finalized user message reaches peers under the sender's stable ID", () => {
	const message: UserMessage = { id: "host-user", role: "user", content: "hello", timestamp: 1 };
	const peer = reduceSessionEvent(EMPTY_RUNTIME, { type: "message_end", message });
	expect(peer.turns).toEqual([{ kind: "user", id: "host-user", message }]);
	const sender = reduceSessionEvent(
		{
			...EMPTY_RUNTIME,
			turns: [{ kind: "user", id: "host-user", message }],
		},
		{ type: "message_end", message },
	);
	expect(sender.turns).toEqual(peer.turns);
});

test("equal-text inputs with distinct IDs stay distinct across live and restored projection", () => {
	const first: UserMessage = { id: "first", role: "user", content: "same text", timestamp: 1 };
	const second: UserMessage = { ...first, id: "second", timestamp: 2 };
	let runtime = reduceSessionEvent(EMPTY_RUNTIME, { type: "message_end", message: first });
	runtime = reduceSessionEvent(runtime, { type: "message_end", message: second });
	runtime = reduceSessionEvent(runtime, { type: "message_end", message: second });
	expect(runtime.turns.map((turn) => turn.id)).toEqual(["first", "second"]);
	expect(runtime.turns).toEqual(messagesToRuntime([first, second]).turns);
});

test("a canonical summary marker keeps prior turns and converges live with restored history", () => {
	const message: WireCompactionSummary = {
		id: "summary-1",
		role: "compactionSummary",
		summary: "Older decisions",
		tokensBefore: 1200,
		timestamp: 3,
	};
	const previous = assistant("full earlier reply");
	let runtime = reduceSessionEvent(EMPTY_RUNTIME, { type: "message_end", message: previous });
	runtime = reduceSessionEvent(runtime, { type: "message_end", message });
	runtime = reduceSessionEvent(runtime, { type: "message_end", message });
	expect(runtime.turns).toHaveLength(2);
	expect(runtime.turns).toEqual(messagesToRuntime([previous, message]).turns);
});

test("initial hydration replays only events above the snapshot watermark", () => {
	const store = useAppStore.getState();
	store.beginSessionHydration("session");
	store.handleSessionEvents([payload(1, "included in snapshot"), payload(3, "after snapshot")]);
	const summary: SessionSummary = {
		sessionId: "session",
		workspaceId: "workspace",
		title: "Task",
		model: null,
		thinkingLevel: "off",
		isStreaming: false,
		messageCount: 1,
		updatedAt: 1,
		live: true,
		eventSeq: 2,
	};
	store.hydrateSession(summary, messagesToRuntime([assistant("snapshot")]));
	const runtime = useAppStore.getState().sessions.session;
	expect(runtime?.turns).toHaveLength(1);
	expect(runtime?.turns[0]).toMatchObject({ message: assistant("after snapshot") });
	expect(runtime?.lastEventSeq).toBe(3);
	expect(useAppStore.getState().sessionEventsBeforeHydration.session).toBeUndefined();
	store.handleSessionEvents([
		payload(3, "duplicate"),
		payload(2, "stale"),
		payload(4, "other", "other-session"),
	]);
	expect(useAppStore.getState().sessions.session).toBe(runtime);
});

test("closing a pending hydration clears its buffered events", () => {
	const store = useAppStore.getState();
	store.beginSessionHydration("session");
	store.handleSessionEvents([payload(1, "pending")]);
	store.closeChatRuntime("session");
	expect(useAppStore.getState().sessionEventsBeforeHydration.session).toBeUndefined();
});

test("queue hydration ignores covered deltas and keeps newer admission errors and states", () => {
	const store = useAppStore.getState();
	store.beginSessionHydration("session");
	store.handleSessionEvents([
		{
			sessionId: "session",
			runId: "run",
			seq: 1,
			event: {
				type: "queue_update",
				steering: [{ id: "withdrawn", text: "old", state: "pending" }],
				followUp: [],
			},
		},
		{
			sessionId: "session",
			runId: "run",
			seq: 3,
			event: {
				type: "queue_update",
				steering: [{ id: "next", text: "continue", state: "staged" }],
				followUp: [
					{ id: "later", text: "afterward", state: "pending", error: "Input was not admitted" },
				],
			},
		},
	]);
	store.hydrateSession(
		{
			sessionId: "session",
			workspaceId: "workspace",
			title: "Task",
			model: null,
			thinkingLevel: "off",
			isStreaming: true,
			messageCount: 0,
			updatedAt: 1,
			live: true,
			eventSeq: 2,
			queue: { steering: [{ id: "next", text: "continue", state: "pending" }], followUp: [] },
		},
		messagesToRuntime([]),
	);
	const runtime = useAppStore.getState().sessions.session;
	expect(runtime?.queue).toEqual({
		steering: [{ id: "next", text: "continue", state: "staged" }],
		followUp: [
			{ id: "later", text: "afterward", state: "pending", error: "Input was not admitted" },
		],
	});
	expect(runtime?.turns).toHaveLength(0);
	expect(runtime?.lastEventSeq).toBe(3);
});

test("fresh attachment and refresh recover approval from the transcript summary alone", () => {
	const store = useAppStore.getState();
	const request = approval("run", 4);
	const summary = approvalSummary(request);
	store.hydrateSession(summary, messagesToRuntime([]));
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(request);
	store.closeChatRuntime("session");
	store.hydrateSession(summary, messagesToRuntime([]));
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(request);
});

test("an installed state restores approval on open and outranks a stale transcript summary", () => {
	const store = useAppStore.getState();
	const request = approval("new-run", 8);
	const summary = approvalSummary(request);
	const record = {
		sessionId: "session",
		workspaceId: "workspace",
		projectId: "project",
		state: summary.state,
	};
	store.installSessionStateSnapshot([record]);
	store.openChatSession("workspace", "session", null, "off");
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(request);
	store.closeChatRuntime("session");
	store.hydrateSession(approvalSummary(approval("old-run", 3)), messagesToRuntime([]));
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(request);
	expect(useAppStore.getState().sessions.session?.hostState?.runId).toBe("new-run");
});

test("new ownership replaces an approval and a cleared request cannot return from stale snapshots or frames", () => {
	const store = useAppStore.getState();
	const oldRequest = approval("old-run", 3);
	store.hydrateSession(approvalSummary(oldRequest), messagesToRuntime([]));
	const request = approval("new-run", 8);
	const state = approvalSummary(request).state;
	const record = { sessionId: "session", workspaceId: "workspace", projectId: "project", state };
	store.applyExtUi(request);
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(oldRequest);
	store.applySessionState(record);
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(request);
	store.applyExtUi(oldRequest);
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toEqual(request);
	expect(useAppStore.getState().sessions.session?.extUiQueue).toEqual([]);
	store.applySessionState({ ...record, state: { ...state, needsInput: null } });
	const revision = useAppStore.getState().sessions.session?.eventRevision;
	if (revision === undefined) throw new Error("Missing session runtime");
	expect(store.reconcileSession(approvalSummary(request), messagesToRuntime([]), revision, 0)).toBe(
		true,
	);
	store.applyExtUi(oldRequest);
	store.applyExtUi(request);
	expect(useAppStore.getState().sessions.session?.pendingExtUi).toBeNull();
	expect(useAppStore.getState().sessions.session?.hostState?.needsInput).toBeNull();
});

test("an agent transfer row and attributed messages converge live with restored history", () => {
	const root: AssistantMessage = { ...assistant("routing"), id: "root-1", agent: "RailDesign" };
	const transfer: AgentTransferMessage = {
		id: "transfer:t1",
		role: "custom",
		customType: "agent-transfer",
		content: "",
		display: true,
		details: { transferId: "t1", from: "RailDesign", to: "analyst", reason: "needs analysis" },
		timestamp: 2,
	};
	const target: AssistantMessage = { ...assistant("answer"), id: "target-1", agent: "analyst" };
	let runtime = EMPTY_RUNTIME;
	for (const message of [root, transfer, transfer, target])
		runtime = reduceSessionEvent(runtime, { type: "message_end", message });
	expect(runtime.turns.map((turn) => turn.kind)).toEqual([
		"assistant",
		"agentTransfer",
		"assistant",
	]);
	expect(runtime.turns).toEqual(messagesToRuntime([root, transfer, target]).turns);
	const rows = deriveRows(runtime.turns, {}, false);
	expect(rows.flatMap((row) => (row.kind === "markdown" ? [[row.agent, row.text]] : []))).toEqual([
		["RailDesign", "routing"],
		["analyst", "answer"],
	]);
	expect(rows.find((row) => row.kind === "agentTransfer")).toEqual({
		kind: "agentTransfer",
		id: "transfer:t1",
		details: transfer.details,
	});
	expect(rows.some((row) => row.kind === "handoff")).toBe(false);
});

test("guardrail tool outcomes and a guardrail stop agree live and after restore", () => {
	const call: AssistantMessage = {
		...assistant(""),
		id: "call-1",
		content: [
			{ type: "toolCall", id: "r1", name: "read", arguments: { path: "config.txt" } },
			{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo" } },
		],
		stopReason: "toolUse",
	};
	const withheld = {
		id: "result:r1",
		role: "toolResult" as const,
		toolCallId: "r1",
		toolName: "read",
		content: [{ type: "text" as const, text: "original" }],
		isError: false,
		guardrail: { stage: "output" as const, rule: "secret" },
		timestamp: 2,
	};
	const rejected = {
		...withheld,
		id: "result:b1",
		toolCallId: "b1",
		toolName: "bash",
		isError: true,
		guardrail: { stage: "input" as const, rule: "no-delete" },
	};
	const stopped: AssistantMessage = {
		...assistant(""),
		id: "stop-1",
		content: [],
		stopReason: "guardrail",
		guardrail: "secret",
	};
	let runtime = reduceSessionEvent(EMPTY_RUNTIME, { type: "message_end", message: call });
	for (const result of [withheld, rejected])
		runtime = reduceSessionEvent(runtime, {
			type: "tool_execution_end",
			toolCallId: result.toolCallId,
			toolName: result.toolName,
			result: { content: result.content },
			isError: result.isError,
			guardrail: result.guardrail,
		});
	runtime = reduceSessionEvent(runtime, { type: "message_end", message: stopped });
	runtime = reduceSessionEvent(runtime, {
		type: "agent_settled",
		terminal: { stopReason: "guardrail", guardrail: "secret" },
	});
	const restored = messagesToRuntime([call, withheld, rejected, stopped]);
	for (const view of [runtime, restored]) {
		expect(view.toolResults.r1).toMatchObject({ status: "done", guardrail: withheld.guardrail });
		expect(view.toolResults.b1).toMatchObject({ status: "error", guardrail: rejected.guardrail });
		expect(view.turns.at(-1)).toMatchObject({
			kind: "error",
			failure: "guardrail",
			text: "secret",
		});
	}
});
