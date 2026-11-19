import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	Agent,
	type AgentInputItem,
	type AgentOptions,
	type AgentOutputType,
	handoff,
	InputGuardrailTripwireTriggered,
	MaxTurnsExceededError,
	type RunConfig,
	type RunContext,
	Runner,
	RunState,
	type RunStreamEvent,
	type Tool,
	tool,
} from "@openai/agents";
import { filesystem, Manifest, SandboxAgent } from "@openai/agents/sandbox";
import { UnixLocalSandboxClient, type UnixLocalSandboxSession } from "@openai/agents/sandbox/local";
import type {
	AgentSettlement,
	AssistantMessage,
	ChatHandoffDetails,
	ContinueInWorkspaceRequestDetails,
	DelegationRunDetails,
	ExtUiRequest,
	ExtUiResponse,
	ImageContent,
	PlanReviewOutput,
	PlanReviewResult,
	QueueLane,
	RemovedQueuedMessage,
	ResourceHistoryCursor,
	ResourceKind,
	ResourceRecord,
	SessionCreatedPayload,
	SessionDeletedPayload,
	SessionEvent,
	SessionEventPayload,
	SessionQueueContent,
	SessionQueueState,
	SessionResources,
	SessionState,
	SessionStateRecord,
	SessionStats,
	SessionSummary,
	SubagentResourceSummary,
	ThinkingLevel,
	ToolGuardrailOutcome,
	TranscriptMessage,
	WireModel,
} from "@thinkrail/contracts";
import {
	AGENT_TRANSFER_CUSTOM_TYPE,
	firstPromptOfTexts,
	isControlMessage,
	isPlanReviewOutput,
	normalizeSessionTitle,
	SUBAGENT_COMPLETION_CUSTOM_TYPE,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { truncateHead } from "@thinkrail/shared/toolOutput";
import { createSpecTools, SPEC_RULE } from "@thinkrail/spec-graph";
import { createTodoTools, TODO_RULE } from "@thinkrail/todos";
import { WORKFLOW_RULE } from "@thinkrail/workflow";
import { z } from "zod";
import {
	createWorkspaceFiles,
	interactiveTools,
	registrySdkTools,
	type SdkExtensionSnapshot,
	snapshotSdkExtensions,
} from "../extensions";
import { findImageBlock, type ImageSource, projectImages } from "../images";
import { logger } from "../log";
import { dataDir, loadConfig, loadProjects, loadWorkspaces } from "../persistence";
import { archivedCommandOutput, finishedResources, recordResource } from "../resourceHistory";
import { trashFile } from "../trash";
import {
	type BackgroundCommands,
	tail as commandExcerpt,
	createBackgroundCommands,
} from "./backgroundCommands";
import {
	archiveCommandHistory,
	resourceHistoryOf,
	getResourceHistoryPage as resourcePage,
	getSessionResources as summarizeResources,
} from "./chatResources";
import { type AgentDefinition, discoverAgentDefinitions } from "./childDefinitions";
import { toSpawnMapping } from "./childMapping";
import {
	GuardrailOutputBlockedError,
	type GuardrailPolicy,
	loadGuardrailPolicy,
} from "./guardrails";
import {
	agentName,
	HANDOFF_ROOT,
	handoffHistory,
	handoffTargets,
	loadHandoffGraph,
	ROOT_AGENT_NAME,
	withoutToolHistory,
} from "./handoffGraph";
import {
	attachAgentDiagnostics,
	attachRunDiagnostics,
	configureLocalSdkTracing,
	type DiagnosticOutcome,
	traceRunOptions,
} from "./localTracing";
import { loadMcpConfigFiles, mcpCredentialValues } from "./mcp";
import {
	applySessionMcpApproval,
	mcpResourceSummaries,
	pauseSessionMcpConnections,
	reconcileMcpSessions,
	sessionMcpApproval,
	sessionMcpTools,
} from "./mcpSessions";
import {
	configuredModelKeys,
	createConfiguredModel,
	listAvailableModels,
	modelContextBudget,
	modelOutputBudget,
	responsesClientSettings,
} from "./modelConfiguration";
import { assertCompletedPlanReviewResponse, planReviewOutput } from "./planReviewOutput";
import {
	SANDBOX_ARCHIVE_BYTES,
	SandboxMemory,
	SandboxMemoryRunner,
	sandboxArchiveLimits,
} from "./sandboxMemory";
import { type StructuredToolResult, structuredToolResult } from "./sdkToolResult";
import { workspaceTools } from "./sdkTools";
import {
	type ApprovalRequest,
	type ChildRunRecord,
	listSessionRecords,
	PersistentSession,
	REVIEW_OUTPUT_CONTRACT,
	readSessionRecord,
	type SessionRecord,
	type StoredInput,
	sessionRecordPath,
} from "./sessionStore";
import { admissionContextFor } from "./skillAdmission";
import {
	createSkillTools,
	expandSkillCommand,
	readAdmittedSkill,
	skillCommandName,
	skillInstructions,
	workspaceInstructions,
} from "./skillTools";
import { stripAnsi } from "./stripAnsi";
import { readWebAccessKey, webFetch, webSearch } from "./webAccess";
import { createWorkspaceActions } from "./workspaceActions";

const log = logger("agent");

type SessionContext = Readonly<{ workspaceId: string }>;

type SessionAgent = Agent<SessionContext, "text" | typeof planReviewOutput>;

const agentNodes = new WeakMap<object, string>();

interface ActiveRun {
	state?: RunState<SessionContext, SessionAgent>;
	sandbox?: UnixLocalSandboxSession;
	memory?: SandboxMemory;
	suspended?: boolean;
	inputId?: string;
	enabledExtensions: SdkExtensionSnapshot[];
	ready?: Promise<void>;
	markReady?: () => void;
	id: string;
	controller: AbortController;
	granted: boolean;
	done: Promise<void>;
	assistantId?: string;
	finalAssistant?: {
		messageId: string;
		providerId?: string | undefined;
		responseId?: string | undefined;
	};
	reviewResponse?: { responseId: string | undefined; status?: unknown };
	toolCalls: Map<string, { name: string; arguments: Record<string, unknown>; failed: boolean }>;
	startedTools: Set<string>;
	pendingTransfer?: { from: string; to: string; reason: string };
	/** SDK agent currently streaming, for message authorship in Handoff chats. */
	author?: string;
	structuredResults?: Map<string, StructuredToolResult>;
	/** Loaded once at run start; every agent and tool in the run shares it. */
	guardrails?: GuardrailPolicy;
	diagnostics?: ReturnType<typeof attachRunDiagnostics>;
	guardrailOutcomes?: Map<string, ToolGuardrailOutcome>;
	/** Full text of the streaming assistant message; only its gated prefix is published. */
	streamText?: string;
	/** The output gate stopped this run. */
	blocked?: { rule: string };
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheRead: number;
		cacheWrite: number;
	};
	toolResponse?: {
		request: NonNullable<SessionRecord["pendingToolResponse"]>;
		resolve: () => void;
		reject: (error: Error) => void;
	};
	approval?: {
		request: ApprovalRequest;
		agentNode?: string | undefined;
		generation: boolean;
		resolve: (approved: boolean) => void;
		reject: (error: Error) => void;
	};
}
interface Entry {
	summaryController?: AbortController;
	summaryDone?: Promise<void>;
	stopping?: boolean;
	store: PersistentSession;
	active?: ActiveRun;
	flush?: ReturnType<typeof setTimeout>;
	commands?: BackgroundCommands;
	commandArchive?: { finish: () => void };
	closingResources?: boolean;
	reviewScopes?: Set<{ controller: AbortController; done: Promise<void> }>;
	foregroundChildren?: Set<string>;
	fixCompletions?: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
}
const sessions = new Map<string, Entry>();
const closingSessions = new Set<string>();
const deletingSessions = new Set<string>();
const closingWorkspaces = new Set<string>();
let publish: (payload: SessionEventPayload, workspaceId: string) => void = () => {};
let publishCreated: (payload: SessionCreatedPayload) => void = () => {};
let publishDeleted: (payload: SessionDeletedPayload) => void = () => {};
let publishState: (record: SessionStateRecord) => void = () => {};
let publishRawDialog: (request: ExtUiRequest) => void = () => {};
let projectOf: (workspaceId: string) => string | null = () => null;
let releaseSessionResources: ((sessionId: string) => Promise<void>) | undefined;

export function setSessionResourceCleanup(fn: typeof releaseSessionResources): void {
	releaseSessionResources = fn;
}

export function setSessionPublisher(fn: typeof publish): void {
	publish = fn;
}
export function setSessionCreatedPublisher(fn: typeof publishCreated): void {
	publishCreated = fn;
}
export function setSessionDeletedPublisher(fn: typeof publishDeleted): void {
	publishDeleted = fn;
}
export function setSessionStatePublisher(fn: typeof publishState): void {
	publishState = fn;
}
export function setSessionProjectResolver(fn: typeof projectOf): void {
	projectOf = fn;
}
export function setExtUiPublisher(fn: typeof publishDialog): void {
	publishRawDialog = fn;
}

function imageOwner(entry: Entry): string {
	return entry.store.record.childRun?.parentSessionId ?? entry.store.record.sessionId;
}
function projectDialog<T extends ExtUiRequest>(request: T, sessionId: string): T {
	let projected = projectImages(request, sessionId) as T;
	if (
		request.kind === "confirm" &&
		projected.kind === "confirm" &&
		projected.toolInput !== request.toolInput
	) {
		projected = { ...projected, message: JSON.stringify(projected.toolInput) };
	}
	if ("title" in projected) projected = { ...projected, title: stripAnsi(projected.title) };
	if ("message" in projected) projected = { ...projected, message: stripAnsi(projected.message) };
	return projected;
}
function publishDialog(request: ExtUiRequest): void {
	const child = sessions.get(request.sessionId)?.store.record.childRun;
	if (!child) {
		publishRawDialog(projectDialog(request, request.sessionId));
		return;
	}
	if (!sessions.has(child.parentSessionId)) return;
	publishRawDialog(
		projectDialog(
			{
				...request,
				sessionId: child.parentSessionId,
				...("title" in request ? { title: `${child.definition.name}: ${request.title}` } : {}),
			},
			child.parentSessionId,
		),
	);
}
function childApproval(entry: Entry): ApprovalRequest | undefined {
	if (entry.store.record.childRun) return undefined;
	let candidates: SessionRecord[];
	try {
		candidates = childRecords(entry);
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		)
			return undefined;
		throw error;
	}
	const records = candidates.filter(
		(record) => record.childRun?.status === "running" && record.pendingApproval,
	);
	records.sort(
		(a, b) =>
			(a.childRun?.createdAt ?? "").localeCompare(b.childRun?.createdAt ?? "") ||
			a.sessionId.localeCompare(b.sessionId),
	);
	const child = records[0],
		request = child?.pendingApproval?.request;
	return child && request
		? {
				...request,
				sessionId: entry.store.record.sessionId,
				title: `${child.childRun?.definition.name}: ${request.title}`,
			}
		: undefined;
}
function visibleState(entry: Entry): SessionState {
	const state = structuredClone(entry.store.record.state);
	if (!state.needsInput) {
		const request = childApproval(entry);
		if (request) state.needsInput = { kind: "dialog", interactionId: request.id, request };
	}
	if (state.needsInput?.kind === "dialog") {
		state.needsInput.request = projectDialog(state.needsInput.request, imageOwner(entry));
	}
	const handoffs = entry.store.record.handoffs;
	if (handoffs) state.activeAgent = agentName(handoffs.activeNode);
	if (entry.store.record.sandbox === true) {
		state.sandbox = true;
		if (!handoffs && entry.store.record.sandboxMemory) state.sandboxMemory = true;
	}
	return state;
}
export async function attachApprovalOwner(response: ExtUiResponse): Promise<void> {
	const entry = mustGet(response.sessionId);
	if (
		entry.store.record.pendingApproval?.request.id === response.id ||
		entry.store.record.decisions[response.id]
	)
		return;
	const child = childRecords(entry).find(
		(record) => record.pendingApproval?.request.id === response.id || record.decisions[response.id],
	);
	if (child && !(await ensureSessionAttached(child.sessionId, child.workspaceId, child.cwd)))
		throw new Error("Child approval is unavailable");
}

function idleState(): SessionState {
	return {
		execution: "idle",
		runId: null,
		needsInput: null,
		completion: null,
		completionUnread: false,
		queuedCount: 0,
		backgroundWork: false,
	};
}
function stateRecord(entry: Entry): SessionStateRecord {
	const record = entry.store.record;
	const firstPrompt = firstPromptOfTexts(
		record.messages.flatMap((message) =>
			message.role === "user" ? [textOf(message.content)] : [],
		),
	);
	return {
		sessionId: record.sessionId,
		workspaceId: record.workspaceId,
		projectId: projectOf(record.workspaceId) ?? "",
		state: visibleState(entry),
		...(record.title ? { title: record.title } : {}),
		...(firstPrompt ? { firstPrompt } : {}),
	};
}
function notifyState(entry: Entry): void {
	if (entry.store.record.childRun) {
		const parent = sessions.get(entry.store.record.childRun.parentSessionId);
		if (parent) publishState(stateRecord(parent));
		return;
	}
	publishState(stateRecord(entry));
}
function flush(entry: Entry): void {
	if (entry.flush) clearTimeout(entry.flush);
	delete entry.flush;
	entry.store.update(() => {});
}
function emit(entry: Entry, event: SessionEvent, immediate = true): void {
	entry.store.record.eventSeq += 1;
	if (immediate) flush(entry);
	else if (!entry.flush) {
		entry.flush = setTimeout(() => {
			delete entry.flush;
			try {
				flush(entry);
			} catch (error) {
				log.error("Could not persist streamed session", error);
				entry.active?.controller.abort();
			}
		}, 100);
		entry.flush.unref();
	}
	publishEvent(entry, event);
}
function publishEvent(entry: Entry, event: SessionEvent): void {
	const record = entry.store.record;
	publish(
		{
			sessionId: record.sessionId,
			runId: record.state.runId,
			seq: record.eventSeq,
			event: structuredClone(projectImages(event, imageOwner(entry))) as SessionEvent,
		},
		record.workspaceId,
	);
}
function mustGet(sessionId: string): Entry {
	const entry = sessions.get(sessionId);
	if (!entry) throw new Error(`Unknown session: ${sessionId}`);
	return entry;
}
const ARTIFACTS_RULE =
	"Keep documents, plans, reports, mockups and other deliverables in .raildesign/context/. Update the same artifact path when revising it; do not delete or move deliverables out of this folder yourself. Keep completed task-specs with status: done instead of deleting them. Regular project edits still belong at their assigned project paths.";

function assertActive(entry: Entry, run: ActiveRun): void {
	const child = entry.store.record.childRun;
	if (child) {
		const parent = sessions.get(child.parentSessionId);
		if (
			!parent ||
			parent.store.record.workspaceId !== entry.store.record.workspaceId ||
			closingSessions.has(child.parentSessionId) ||
			deletingSessions.has(child.parentSessionId) ||
			(child.purpose !== "review" && !subagentsAllowed(parent))
		)
			throw new Error("The child owner is unavailable");
		if (
			child.definition.source === "project" &&
			loadProjects().find((project) => project.id === projectOf(entry.store.record.workspaceId))
				?.resourceTrust !== "granted"
		)
			throw new Error("Project resources are not trusted");
	}
	const workspace = loadWorkspaces().find(
		(candidate) => candidate.id === entry.store.record.workspaceId,
	);
	if (
		!run.granted ||
		run.controller.signal.aborted ||
		entry.active !== run ||
		sessions.get(entry.store.record.sessionId) !== entry ||
		!workspace ||
		resolve(workspace.worktreePath) !== entry.store.record.cwd
	)
		throw new Error("The run no longer has permission to execute");
}
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			part &&
			typeof part === "object" &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("\n");
}
function summaryOf(entry: Entry): SessionSummary {
	const record = entry.store.record;
	const state = stateRecord(entry);
	return {
		sessionId: record.sessionId,
		workspaceId: record.workspaceId,
		title: record.title ?? "",
		...(state.firstPrompt ? { firstPrompt: state.firstPrompt } : {}),
		model: record.model,
		thinkingLevel: record.thinkingLevel,
		isStreaming: !!entry.active,
		messageCount: record.messages.length,
		updatedAt: record.updatedAt,
		live: sessions.has(record.sessionId),
		state: state.state,
		eventSeq: record.eventSeq,
		queue: queueStateOf(record),
	};
}
function appendMessage(entry: Entry, message: TranscriptMessage): void {
	const index = entry.store.record.messages.findIndex((item) => item.id === message.id);
	if (index === -1) entry.store.record.messages.push(message);
	else entry.store.record.messages[index] = message;
}
function assistant(
	entry: Entry,
	id: string,
	content: AssistantMessage["content"],
	reason: AssistantMessage["stopReason"] = "stop",
	author?: string,
): AssistantMessage {
	const previous = entry.store.record.messages.find((message) => message.id === id);
	const agent = author ?? (previous?.role === "assistant" ? previous.agent : undefined);
	return {
		id,
		role: "assistant",
		content,
		api: "openai-responses",
		provider: entry.store.record.model?.provider ?? "",
		model: entry.store.record.model?.id ?? "",
		usage:
			previous?.role === "assistant"
				? previous.usage
				: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
		stopReason: reason,
		...(entry.store.record.handoffs && agent ? { agent } : {}),
		timestamp: previous?.timestamp ?? Date.now(),
	};
}
function startAssistant(entry: Entry, run: ActiveRun): AssistantMessage {
	if (!run.assistantId) {
		run.assistantId = randomUUID();
		const message = assistant(entry, run.assistantId, [], "stop", run.author);
		appendMessage(entry, message);
		emit(entry, { type: "message_start", message });
		return message;
	}
	const found = entry.store.record.messages.find((message) => message.id === run.assistantId);
	if (found?.role !== "assistant") throw new Error("Missing streamed message");
	return found;
}
function addToolCall(
	entry: Entry,
	run: ActiveRun,
	call: { callId: string; name: string; arguments: string },
	author?: string,
): void {
	if (run.toolCalls.has(call.callId)) return;
	let args: Record<string, unknown> = {};
	let failed = false;
	try {
		const parsed: unknown = JSON.parse(
			run.guardrails?.redactToolArguments(call.arguments) ?? call.arguments,
		);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			args = parsed as Record<string, unknown>;
	} catch {
		failed = true;
	}
	run.toolCalls.set(call.callId, { name: call.name, arguments: args, failed });
	const message = assistant(
		entry,
		`call:${call.callId}`,
		[{ type: "toolCall", id: call.callId, name: call.name, arguments: args }],
		"toolUse",
		author,
	);
	appendMessage(entry, message);
	emit(entry, { type: "message_end", message });
}
function recordToolResult(
	entry: Entry,
	callId: string,
	name: string,
	output: string,
	isError = false,
	completed = true,
): void {
	const structured = entry.active?.structuredResults?.get(callId) ?? structuredToolResult(output);
	if (structured) isError ||= structured.isError;
	const guardrail = entry.active?.guardrailOutcomes?.get(callId);
	if (guardrail?.stage === "input") isError = true;
	const previous = entry.store.record.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === callId,
	);
	const previousContent =
		previous?.role === "toolResult" && textOf(previous.content) === output ? previous : null;
	const content = structured?.content ??
		previousContent?.content ?? [{ type: "text" as const, text: output }];
	const details = structured?.details ?? previousContent?.details;
	if (
		previous?.role === "toolResult" &&
		JSON.stringify(previous.content) === JSON.stringify(content) &&
		previous.isError === isError &&
		isDeepStrictEqual(previous.guardrail, guardrail)
	)
		return;
	const message: TranscriptMessage = {
		id: `result:${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content,
		...(details !== undefined ? { details } : {}),
		isError,
		...(guardrail ? { guardrail } : {}),
		timestamp: previous?.timestamp ?? Date.now(),
	};
	const answer = Object.values(entry.store.record.toolResponses).find(
		(receipt) => receipt.toolCallId === callId,
	);
	if (answer && message.role === "toolResult")
		message.details = isSupersededAnswer(answer.response) ? { kind: "ack" } : answer.response;
	appendMessage(entry, message);
	const effect = entry.store.record.effects[callId];
	if (effect)
		entry.store.update((record) => {
			const current = record.effects[callId];
			if (current) {
				current.status = completed ? "completed" : "unknown";
				current.result = output;
				current.isError = isError;
			}
		});
	emit(entry, {
		type: "tool_execution_end",
		toolCallId: callId,
		toolName: name,
		result: {
			content: message.content,
			...(message.role === "toolResult" && message.details !== undefined
				? { details: message.details }
				: {}),
		},
		isError,
		...(guardrail ? { guardrail } : {}),
	});
	emit(entry, { type: "message_end", message });
}

function outputGate(run: ActiveRun): GuardrailPolicy["output"] {
	if (!run.guardrails) throw new Error("The run has no guardrail policy");
	return run.guardrails.output;
}

/** On an output-gate match, revokes the grant and stops the run before anything is published. */
function blockOutput(run: ActiveRun, text: string): boolean {
	const hit = outputGate(run).match(text);
	if (!hit) return false;
	run.blocked ??= hit;
	run.granted = false;
	run.controller.abort();
	return true;
}

/** The guardrail stop message: the published safe prefix only, under the streaming message ID. */
function appendGuardrailStop(entry: Entry, run: ActiveRun, rule: string): void {
	const partial = run.assistantId
		? entry.store.record.messages.find((message) => message.id === run.assistantId)
		: undefined;
	const message = assistant(
		entry,
		run.assistantId ?? randomUUID(),
		partial?.role === "assistant" ? partial.content : [],
		"guardrail",
		partial?.role === "assistant" ? partial.agent : run.author,
	);
	message.guardrail = rule;
	appendMessage(entry, message);
	emit(entry, { type: "message_end", message });
}

function projectStream(entry: Entry, run: ActiveRun, event: RunStreamEvent): void {
	if (!run.granted || entry.active !== run) return;
	if (
		entry.store.record.childRun?.purpose === "review" &&
		event.type === "raw_model_stream_event" &&
		event.data.type === "response_done"
	)
		run.reviewResponse = {
			responseId: event.data.response.id,
			status: event.data.response.providerData?.status,
		};
	if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta") {
		const previous = startAssistant(entry, run);
		const published = textOf(previous.content);
		const text = (run.streamText ?? published) + event.data.delta;
		run.streamText = text;
		if (blockOutput(run, text)) return;
		const safe = text.slice(0, Math.max(0, text.length - (outputGate(run).window - 1)));
		if (safe.length <= published.length) return;
		const message = { ...previous, content: [{ type: "text" as const, text: safe }] };
		appendMessage(entry, message);
		emit(
			entry,
			{
				type: "message_update",
				message,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: safe.slice(published.length),
					partial: message,
				},
			},
			false,
		);
	}
	// The SDK announces the starting agent and each accepted Handoff target. The transfer row itself is
	// published by the owner commit (commitHandoffOwner); here the event only selects the author of
	// later streamed text. Handoff call/output items are represented by that row, not as tool cards.
	if (event.type === "agent_updated_stream_event") run.author = event.agent.name;
	if (event.type !== "run_item_stream_event") return;
	const item = event.item;
	if (item.type === "message_output_item") {
		const content = item.rawItem.content.flatMap((part) =>
			part.type === "output_text"
				? [{ type: "text" as const, text: part.text }]
				: part.type === "refusal"
					? [{ type: "text" as const, text: part.refusal }]
					: [],
		);
		if (blockOutput(run, content.map((part) => part.text).join(""))) return;
		delete run.streamText;
		const previous = startAssistant(entry, run);
		const message = assistant(entry, previous.id ?? randomUUID(), content, "stop", item.agent.name);
		appendMessage(entry, message);
		emit(entry, { type: "message_end", message });
		run.finalAssistant = {
			messageId: previous.id ?? "",
			providerId: item.rawItem.id,
			responseId: run.reviewResponse?.responseId,
		};
		delete run.assistantId;
	} else if (item.type === "tool_call_item" && item.rawItem.type === "function_call") {
		addToolCall(entry, run, item.rawItem, item.agent.name);
	} else if (
		item.type === "tool_call_output_item" &&
		item.rawItem.type === "function_call_result"
	) {
		const call = run.toolCalls.get(item.rawItem.callId);
		const text = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
		recordToolResult(entry, item.rawItem.callId, call?.name ?? "tool", text, call?.failed);
	} else if (item.type === "reasoning_item") {
		const text = item.rawItem.content
			.flatMap((part) => (part.type === "input_text" ? [part.text] : []))
			.join("\n");
		if (text && !blockOutput(run, text)) {
			const message = assistant(
				entry,
				item.rawItem.id ?? randomUUID(),
				[{ type: "thinking", thinking: text }],
				"stop",
				item.agent.name,
			);
			appendMessage(entry, message);
			emit(entry, { type: "message_end", message });
		}
	}
}

async function waitForApproval(
	entry: Entry,
	run: ActiveRun,
	state: RunState<SessionContext, SessionAgent> | undefined,
	call: { callId: string; name: string; arguments: string },
	agentNode?: string,
): Promise<boolean> {
	assertActive(entry, run);
	addToolCall(entry, run, call, agentNode && agentName(agentNode));
	const saved = entry.store.record.pendingApproval?.request;
	if (
		saved?.runId === run.id &&
		saved.toolCallId === call.callId &&
		entry.store.record.pendingApproval?.agentNode !== agentNode
	)
		throw new Error("The pending approval belongs to another agent");
	const consent = state && sessionMcpApproval(entry.store.record.sessionId, call.name);
	if (saved?.policyFingerprint && saved.policyFingerprint !== consent?.fingerprint)
		throw new Error("MCP approval configuration changed");
	const request: ApprovalRequest =
		saved?.runId === run.id && saved.toolCallId === call.callId
			? saved
			: {
					id: randomUUID(),
					sessionId: entry.store.record.sessionId,
					runId: run.id,
					revision: entry.store.record.revision + 1,
					...(consent
						? { kind: "select" as const, ...consent, policyFingerprint: consent.fingerprint }
						: {
								kind: "confirm" as const,
								title: `${agentNode && agentNode !== HANDOFF_ROOT ? `${agentNode}: ` : ""}Allow ${call.name}?`,
								message: call.arguments,
							}),
					toolCallId: call.callId,
					toolInput: run.toolCalls.get(call.callId)?.arguments ?? {},
				};
	const approved = new Promise<boolean>((resolveApproval, reject) => {
		run.approval = {
			request,
			agentNode,
			generation: state === undefined,
			resolve: resolveApproval,
			reject,
		};
	});
	entry.store.update((record) => {
		const checkpoint = state?.toString() ?? "";
		record.pendingApproval = {
			request,
			checkpoint,
			...(agentNode !== undefined ? { agentNode } : {}),
		};
		if (state)
			record.runCheckpoint = {
				runId: run.id,
				checkpoint,
				granted: run.granted,
				enabledExtensions: run.enabledExtensions,
			};
		else delete record.runCheckpoint;
		record.state.needsInput = { interactionId: request.id, kind: "dialog", request };
	});
	publishDialog(request);
	notifyState(entry);
	run.markReady?.();
	return approved;
}

function isSupersededAnswer(response: unknown): boolean {
	return (
		typeof response === "object" &&
		response !== null &&
		"kind" in response &&
		response.kind === "superseded"
	);
}
async function waitForToolResponse(
	entry: Entry,
	run: ActiveRun,
	state: RunState<SessionContext, SessionAgent>,
	call: { callId: string; name: string; arguments: string },
	agentNode?: string,
): Promise<void> {
	assertActive(entry, run);
	addToolCall(entry, run, call, agentNode && agentName(agentNode));
	const args = z.record(z.string(), z.unknown()).parse(JSON.parse(call.arguments));
	const policy = interactiveTools(
		(name) => !run.enabledExtensions.some((extension) => extension.name === name),
	).get(call.name);
	if (!policy) throw new Error("The interactive tool is unavailable");
	policy.validateArgs?.(args);
	if (
		Object.values(entry.store.record.toolResponses).some(
			(answer) => answer.runId === run.id && answer.toolCallId === call.callId,
		)
	)
		return;
	const saved = entry.store.record.pendingToolResponse;
	if (saved?.runId === run.id && saved.toolCallId === call.callId && saved.agentNode !== agentNode)
		throw new Error("The pending question belongs to another agent");
	const request: NonNullable<SessionRecord["pendingToolResponse"]> =
		saved?.runId === run.id && saved.toolCallId === call.callId
			? saved
			: {
					id: randomUUID(),
					sessionId: entry.store.record.sessionId,
					runId: run.id,
					revision: entry.store.record.revision + 1,
					toolCallId: call.callId,
					toolName: call.name,
					args: { ...args },
					checkpoint: state.toString(),
					...(agentNode !== undefined ? { agentNode } : {}),
				};
	const answered = new Promise<void>((resolve, reject) => {
		run.toolResponse = { request, resolve, reject };
	});
	entry.store.update((record) => {
		record.pendingToolResponse = { ...request, checkpoint: state.toString() };
		record.runCheckpoint = {
			runId: run.id,
			checkpoint: state.toString(),
			granted: run.granted,
			enabledExtensions: run.enabledExtensions,
		};
		record.state.needsInput = {
			interactionId: request.id,
			kind: "tool-response",
			toolCallId: call.callId,
			runId: run.id,
			revision: request.revision,
		};
	});
	notifyState(entry);
	run.markReady?.();
	await answered;
}
export function respondToTool(
	sessionId: string,
	toolCallId: string,
	response: unknown,
	ownership: { runId: string; interactionId: string; revision: number },
): void {
	const entry = mustGet(sessionId);
	let parsed = response;
	const previous = entry.store.record.toolResponses[ownership.interactionId];
	if (previous) {
		if (
			previous.runId !== ownership.runId ||
			previous.revision !== ownership.revision ||
			previous.toolCallId !== toolCallId ||
			!isDeepStrictEqual(previous.response, parsed)
		)
			throw new Error("Conflicting tool response");
		return;
	}
	const run = entry.active;
	const pending = run?.toolResponse;
	if (
		!run ||
		!pending ||
		pending.request.id !== ownership.interactionId ||
		run.id !== ownership.runId ||
		pending.request.toolCallId !== toolCallId ||
		pending.request.revision !== ownership.revision
	)
		throw new Error("Tool response is stale or belongs to a different run");
	assertActive(entry, run);
	const args = pending.request.args;
	const policy = interactiveTools(
		(name) => !run.enabledExtensions.some((extension) => extension.name === name),
	).get(pending.request.toolName);
	if (!policy) throw new Error("The interactive tool is unavailable");
	policy.validateArgs?.(args);
	if (policy.parseResponse) parsed = policy.parseResponse(args, response);
	const message: TranscriptMessage = {
		id: `answer:${ownership.interactionId}`,
		role: "custom",
		customType: "tool-response",
		content: [
			{ type: "text", text: policy.describeResponse?.(args, parsed) ?? JSON.stringify(parsed) },
		],
		details: { toolCallId, response: parsed },
		display: false,
		timestamp: Date.now(),
	};
	entry.store.update((record) => {
		record.toolResponses[ownership.interactionId] = {
			runId: run.id,
			toolCallId,
			revision: ownership.revision,
			response: parsed,
		};
		record.runCheckpoint = {
			runId: run.id,
			checkpoint: run.state?.toString() ?? pending.request.checkpoint,
			granted: run.granted,
			enabledExtensions: run.enabledExtensions,
		};
		record.messages.push(message);
		delete record.pendingToolResponse;
		record.state.needsInput = null;
	});
	emit(entry, { type: "message_end", message });
	delete run.toolResponse;
	notifyState(entry);
	pending.resolve();
}

export function resolveExtUi(response: ExtUiResponse): void {
	const entry = mustGet(response.sessionId);
	if (
		!entry.store.record.childRun &&
		!entry.store.record.decisions[response.id] &&
		entry.store.record.pendingApproval?.request.id !== response.id
	) {
		const child = childRecords(entry).find(
			(record) =>
				record.pendingApproval?.request.id === response.id || record.decisions[response.id],
		);
		if (child) {
			if (!sessions.has(child.sessionId)) throw new Error("Child approval is not attached");
			resolveExtUi({ ...response, sessionId: child.sessionId });
			return;
		}
	}
	const decision = entry.store.record.decisions[response.id];
	if (decision) {
		if (
			decision.runId !== response.runId ||
			decision.revision !== response.revision ||
			(decision.selection !== undefined ? decision.selection : decision.value) !== response.value ||
			decision.toolCallId !== response.toolCallId
		)
			throw new Error("Conflicting approval response");
		return;
	}
	const run = entry.active;
	const pending = run?.approval;
	if (
		!run ||
		!pending ||
		pending.request.id !== response.id ||
		run.id !== response.runId ||
		pending.request.revision !== response.revision ||
		pending.request.toolCallId !== response.toolCallId ||
		(pending.request.kind === "confirm"
			? typeof response.value !== "boolean"
			: response.value !== null &&
				(typeof response.value !== "string" || !pending.request.options.includes(response.value)))
	)
		throw new Error("Approval is stale or belongs to a different run");
	assertActive(entry, run);
	if (
		pending.request.policyFingerprint &&
		pending.request.policyFingerprint !==
			sessionMcpApproval(
				response.sessionId,
				run.toolCalls.get(pending.request.toolCallId)?.name ?? "",
			)?.fingerprint
	)
		throw new Error("MCP approval configuration changed");
	const approved =
		pending.request.kind === "select"
			? applySessionMcpApproval(
					response.sessionId,
					run.toolCalls.get(pending.request.toolCallId)?.name ?? "",
					typeof response.value === "string" ? response.value : null,
				)
			: response.value === true;
	entry.store.update((record) => {
		record.decisions[response.id] = {
			runId: run.id,
			revision: response.revision,
			toolCallId: pending.request.toolCallId,
			value: approved,
			...(pending.request.policyFingerprint
				? { policyFingerprint: pending.request.policyFingerprint }
				: {}),
			...(pending.request.kind === "select"
				? { selection: typeof response.value === "string" ? response.value : null }
				: {}),
			...(pending.agentNode !== undefined ? { agentNode: pending.agentNode } : {}),
		};
		if (!pending.generation)
			record.runCheckpoint = {
				runId: run.id,
				checkpoint: run.state?.toString() ?? record.pendingApproval?.checkpoint ?? "",
				granted: run.granted,
				enabledExtensions: run.enabledExtensions,
			};
		delete record.pendingApproval;
		record.state.needsInput = null;
	});
	delete run.approval;
	notifyState(entry);
	pending.resolve(approved);
}
export function pendingExtUiDialog(sessionId: string): ApprovalRequest | null {
	const entry = sessions.get(sessionId);
	if (!entry) return null;
	const request = entry.store.record.pendingApproval?.request ?? childApproval(entry);
	return request ? projectDialog(request, imageOwner(entry)) : null;
}
export function notifyExtUi(
	sessionId: string,
	message: string,
	level: "info" | "warning" | "error",
): void {
	publishDialog({ id: randomUUID(), sessionId, kind: "notify", message, level });
}

function startStream(
	runner: Runner,
	agent: SessionAgent,
	input: AgentInputItem[] | RunState<SessionContext, SessionAgent>,
	session: PersistentSession,
	signal: AbortSignal,
	sandbox?: UnixLocalSandboxSession,
) {
	return runner.run(agent, input, {
		stream: true,
		session,
		context: { workspaceId: session.record.workspaceId },
		signal,
		...(sandbox ? { sandbox: { session: sandbox } } : {}),
		maxTurns: session.record.childRun ? (session.record.childRun.definition.maxTurns ?? 20) : 50,
	});
}

const childWaiters = new Map<string, Set<() => void>>();
const childQueues = new Map<string, string[]>();
const queuedChildControllers = new Map<string, AbortController>();
const childTasks = new Map<string, Promise<void>>();
let publishResources: (resources: SessionResources) => void = () => {};
export function setSessionResourcesPublisher(fn: typeof publishResources): void {
	publishResources = fn;
}

function childRecords(entry: Entry): SessionRecord[] {
	const { sessionId, workspaceId } = entry.store.record;
	return listSessionRecords().filter(
		(record) =>
			record.workspaceId === workspaceId && record.childRun?.parentSessionId === sessionId,
	);
}
function subagentsAllowed(entry: Entry): boolean {
	const workspace = loadWorkspaces().find((item) => item.id === entry.store.record.workspaceId);
	return (
		workspace?.subagentsOverride === "on" ||
		(workspace?.subagentsOverride !== "off" && loadConfig().subagentsEnabled)
	);
}
function childSummary(record: SessionRecord): SubagentResourceSummary {
	const child = record.childRun;
	if (!child) throw new Error("Not a child session");
	return {
		childSessionId: record.sessionId,
		parentSessionId: child.parentSessionId,
		roleName: child.definition.name.slice(0, 200),
		task: child.task.slice(0, 2000),
		status: child.status,
		createdAt: child.createdAt,
		detached: child.detached,
		model: record.model ? `${record.model.provider}/${record.model.id}` : "",
		thinkingLevel: record.thinkingLevel,
		...(child.finishedAt !== undefined
			? { finishedAt: child.finishedAt, durationMs: child.finishedAt - Date.parse(child.createdAt) }
			: {}),
		...(child.abortReason ? { abortReason: child.abortReason } : {}),
		...(child.abortReason === "interrupted" ? { interrupted: true as const } : {}),
	};
}
function commandOwners(entry: Entry): Entry[] {
	return [
		entry,
		...childRecords(entry).map(
			(record) => sessions.get(record.sessionId) ?? { store: new PersistentSession(record) },
		),
	];
}
function resourceScope(entry: Entry) {
	return {
		workspaceId: entry.store.record.workspaceId,
		sessionId: entry.store.record.sessionId,
		commandSessionIds: commandOwners(entry).map((owner) => owner.store.record.sessionId),
	};
}
function resourceParent(entry: Entry): Entry | undefined {
	const id = entry.store.record.childRun?.parentSessionId;
	const parent = id ? sessions.get(id) : undefined;
	return parent?.store.record.workspaceId === entry.store.record.workspaceId ? parent : undefined;
}
function ownedResourceSnapshots(entry: Entry): ResourceRecord[] {
	return [
		...commandOwners(entry).flatMap((owner) => {
			const current = owner.commands?.list() ?? [];
			const archived =
				owner === entry
					? []
					: finishedResources(
							{
								workspaceId: owner.store.record.workspaceId,
								sessionId: owner.store.record.sessionId,
							},
							"command",
							new Set(current.map((command) => command.id)),
						);
			return [...current.map((summary) => ({ kind: "command" as const, summary })), ...archived];
		}),
		...childRecords(entry).map((record) => ({
			kind: "subagent" as const,
			summary: childSummary(record),
		})),
	];
}
function resourceIsLive(record: ResourceRecord): boolean {
	return record.kind === "command"
		? record.summary.status === "running" || record.summary.status === "stopping"
		: record.summary.status === "queued" || record.summary.status === "running";
}
function resourceChanged(entry: Entry): void {
	if (sessions.get(entry.store.record.sessionId) !== entry) return;
	const snapshots = ownedResourceSnapshots(entry);
	entry.store.record.state.backgroundWork =
		!!entry.reviewScopes?.size || snapshots.some(resourceIsLive);
	flush(entry);
	publishResources(summarizeResources(resourceScope(entry), snapshots));
	notifyState(entry);
	const parent = resourceParent(entry);
	if (parent) resourceChanged(parent);
}
function archiveChild(entry: Entry): void {
	const child = entry.store.record.childRun;
	if (!child) return;
	recordResource(
		{ workspaceId: entry.store.record.workspaceId, sessionId: child.parentSessionId },
		{ kind: "subagent", summary: childSummary(entry.store.record) },
	);
	const parent = sessions.get(child.parentSessionId);
	if (parent) resourceChanged(parent);
}
function wakeChildQueue(parentSessionId: string): void {
	for (const wake of childWaiters.get(parentSessionId) ?? []) wake();
}
async function acquireChildSlot(child: Entry, signal: AbortSignal): Promise<void> {
	const metadata = child.store.record.childRun;
	if (!metadata) throw new Error("Missing child owner");
	const parent = mustGet(metadata.parentSessionId);
	let queue = childQueues.get(metadata.parentSessionId);
	if (!queue) {
		queue = [];
		childQueues.set(metadata.parentSessionId, queue);
	}
	if (!queue.includes(child.store.record.sessionId)) queue.push(child.store.record.sessionId);
	try {
		while (true) {
			signal.throwIfAborted();
			if (metadata.purpose !== "review" && !subagentsAllowed(parent))
				throw new Error("Child agents are disabled");
			const workspace = loadWorkspaces().find(
				(item) => item.id === parent.store.record.workspaceId,
			);
			const limit = Math.max(
				1,
				workspace?.subagentMaxConcurrentOverride ?? loadConfig().subagentMaxConcurrent,
			);
			const active = childRecords(parent).filter(
				(record) => record.childRun?.status === "running",
			).length;
			if (queue[0] === child.store.record.sessionId && active < limit) break;
			await new Promise<void>((resolveWait, reject) => {
				const waiters = childWaiters.get(metadata.parentSessionId) ?? new Set<() => void>();
				childWaiters.set(metadata.parentSessionId, waiters);
				const finish = () => {
					waiters.delete(finish);
					signal.removeEventListener("abort", abort);
					resolveWait();
				};
				const abort = () => {
					waiters.delete(finish);
					reject(new Error("Child run cancelled"));
				};
				waiters.add(finish);
				signal.addEventListener("abort", abort, { once: true });
			});
		}
		child.store.update((record) => {
			if (record.childRun) record.childRun.status = "running";
		});
		archiveChild(child);
	} finally {
		const index = queue.indexOf(child.store.record.sessionId);
		if (index >= 0) queue.splice(index, 1);
		wakeChildQueue(metadata.parentSessionId);
	}
}
function childDetails(child: Entry): DelegationRunDetails {
	const record = child.store.record,
		metadata = record.childRun;
	if (!metadata) throw new Error("Missing child metadata");
	const stats = statsFromRecord(record);
	return {
		childSessionId: record.sessionId,
		roleName: metadata.definition.name,
		roleSource: metadata.definition.source,
		task: metadata.task,
		status: metadata.status,
		model: record.model ? `${record.model.provider}/${record.model.id}` : "",
		thinkingLevel: record.thinkingLevel,
		usage: {
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
			cacheWrite: stats.tokens.cacheWrite,
			cost: 0,
			turns: record.messages.filter((message) => message.role === "assistant").length,
			contextTokens: record.modelContextTokens ?? 0,
		},
		durationMs: (metadata.finishedAt ?? Date.now()) - Date.parse(metadata.createdAt),
		...(metadata.abortReason ? { abortReason: metadata.abortReason } : {}),
	};
}
// Ends a foreground child that failed. A failed result keeps its details so the card can open the
// child transcript; a stopped run rethrows so cancellation stays an SDK abort.
function failedForegroundChild(child: Entry, childRun: ActiveRun, error: unknown) {
	if (childRun.blocked) {
		appendGuardrailStop(child, childRun, childRun.blocked.rule);
		finishChild(child, "error");
		childRun.granted = false;
		delete child.active;
		delete child.store.historyGuardrails;
		return {
			content: [
				{
					type: "text" as const,
					text: `Child output blocked by guardrail "${childRun.blocked.rule}".`,
				},
			],
			details: childDetails(child),
			isError: true,
		};
	}
	finishChild(child, childRun.controller.signal.aborted ? "aborted" : "error");
	childRun.granted = false;
	delete child.active;
	delete child.store.historyGuardrails;
	if (childRun.controller.signal.aborted) throw error;
	return {
		content: [
			{ type: "text" as const, text: error instanceof Error ? error.message : String(error) },
		],
		details: childDetails(child),
		isError: true,
	};
}
function childOutput(child: Entry) {
	const message = child.store.record.messages.findLast(
		(item) => item.role === "assistant" && textOf(item.content).trim(),
	);
	return {
		content: [
			{
				type: "text" as const,
				text:
					message && "content" in message
						? textOf(message.content).slice(0, 50000)
						: "Child run has no final report.",
			},
		],
		details: childDetails(child),
		isError:
			child.store.record.childRun?.status === "error" ||
			child.store.record.childRun?.status === "aborted",
	};
}
function queueResourceCompletion(
	parent: Entry,
	id: string,
	text: string,
	customType: string,
	details: unknown,
): void {
	assertAdditionalInputAllowed(parent);
	if (
		parent.stopping ||
		closingSessions.has(parent.store.record.sessionId) ||
		deletingSessions.has(parent.store.record.sessionId)
	)
		return;
	if (parent.store.record.messages.some((message) => message.id === id)) return;
	const message: TranscriptMessage = {
		id,
		role: "custom",
		customType,
		content: [{ type: "text", text }],
		details,
		display: true,
		timestamp: Date.now(),
	};
	parent.store.update((record) => {
		record.messages.push(message);
		record.queue.push({
			id: `resource-input-${id}`,
			kind: "followUp",
			state: "pending",
			text,
			internal: true,
		});
	});
	emit(parent, { type: "message_end", message });
	if (!parent.active)
		void drainQueue(parent).catch((error) =>
			log.warn("Could not deliver resource completion", error),
		);
}
function flushChildCompletions(parent: Entry): void {
	if (parent.active || parent.stopping) return;
	for (const record of childRecords(parent)) {
		const metadata = record.childRun;
		if (
			!metadata?.detached ||
			metadata.completionDelivered ||
			metadata.collected ||
			metadata.status === "queued" ||
			metadata.status === "running"
		)
			continue;
		const child = sessions.get(record.sessionId) ?? { store: new PersistentSession(record) };
		const output = childOutput(child);
		const text = `Subagent "${metadata.definition.name}" (${record.sessionId}) ${metadata.status}:\n${output.content[0]?.text ?? ""}`;
		queueResourceCompletion(
			parent,
			`child-${record.sessionId}`,
			text,
			SUBAGENT_COMPLETION_CUSTOM_TYPE,
			{ ...output.details, delivery: "wake" },
		);
		if (parent.store.record.messages.some((message) => message.id === `child-${record.sessionId}`))
			child.store.update((current) => {
				if (current.childRun) current.childRun.completionDelivered = true;
			});
	}
}
function finishChild(child: Entry, status: ChildRunRecord["status"], reason?: string): void {
	if (child.store.record.childRun?.finishedAt !== undefined) return;
	child.store.update((record) => {
		if (record.childRun) {
			record.childRun.status = status;
			record.childRun.finishedAt = Date.now();
			record.state.execution = "idle";
			record.state.needsInput = null;
			record.state.completion = {
				completionId: record.state.runId ?? record.sessionId,
				...(status === "error"
					? { outcome: "failed" as const, failure: "error" as const }
					: { outcome: status === "completed" ? ("succeeded" as const) : ("cancelled" as const) }),
			};
			if (reason) record.childRun.abortReason = reason;
		}
	});
	archiveChild(child);
	const parent = child.store.record.childRun?.parentSessionId;
	if (parent) {
		wakeChildQueue(parent);
		const owner = sessions.get(parent);
		if (owner) flushChildCompletions(owner);
	}
}
async function childTools(entry: Entry, run: ActiveRun): Promise<Tool<SessionContext>[]> {
	if (entry.store.record.childRun) return [];
	const project = loadProjects().find(
		(item) => item.id === projectOf(entry.store.record.workspaceId),
	);
	const definitions = discoverAgentDefinitions({
		cwd: entry.store.record.cwd,
		agentDir: dataDir(),
		includeProject: project?.resourceTrust === "granted",
	});
	const description = definitions
		.map(
			(definition) =>
				`${definition.name}: ${definition.description}${definition.model ? ` [model ${definition.model}]` : ""}`,
		)
		.join("\n");
	return [
		tool({
			errorFunction: null,
			name: "Agent",
			description: `Delegate one task to a child agent. Children cannot call MCP or delegate more children. Background results arrive automatically; do not poll.\n${description}`,
			isEnabled: () => subagentsAllowed(entry),
			parameters: z.object({
				subagent_type: z.string(),
				task: z.string().min(1).max(100000),
				model: z.string().nullable().optional(),
				run_in_background: z.boolean().optional(),
			}),
			execute: async (args, context: RunContext<SessionContext> | undefined, details) => {
				if (!context) throw new Error("Child execution requires its parent SDK context");
				assertWorkspaceContext(context.context, entry);
				assertActive(entry, run);
				if (!subagentsAllowed(entry)) throw new Error("Child agents are disabled");
				if (!details?.toolCall) throw new Error("Child call identity is required");
				const definition = definitions.find((item) => item.name === args.subagent_type);
				if (!definition) throw new Error("Unknown child agent definition");
				if (
					definition.source === "project" &&
					loadProjects().find((item) => item.id === projectOf(entry.store.record.workspaceId))
						?.resourceTrust !== "granted"
				)
					throw new Error("Project resources are not trusted");
				const available = await listAvailableModels();
				assertActive(entry, run);
				const mapped = toSpawnMapping(definition, {
					cwd: entry.store.record.cwd,
					availableModels: available,
					...(args.model ? { model: args.model } : {}),
				});
				const model = mapped.session.model
					? available.find(
							(item) =>
								item.id === mapped.session.model?.id &&
								item.provider === mapped.session.model.provider,
						)
					: entry.store.record.model;
				if (!model) throw new Error("Child model is unavailable");
				const toolCallId = details.toolCall.callId;
				let record = childRecords(entry).find((item) => item.childRun?.toolCallId === toolCallId);
				let child: Entry;
				if (record) {
					child = sessions.get(record.sessionId) ?? { store: new PersistentSession(record) };
					sessions.set(record.sessionId, child);
				} else {
					const created = await createSession({
						cwd: entry.store.record.cwd,
						workspaceId: entry.store.record.workspaceId,
						model,
						thinkingLevel: mapped.session.thinkingLevel ?? entry.store.record.thinkingLevel,
						childRun: {
							parentSessionId: entry.store.record.sessionId,
							toolCallId: details.toolCall.callId,
							task: args.task,
							definition: { ...definition, systemPrompt: mapped.session.systemPrompt },
							enabledExtensions: snapshotSdkExtensions(
								loadConfig().disabledExtensions,
								loadConfig().extensionSettings,
								"child",
							),
							detached: args.run_in_background === true,
							createdAt: new Date().toISOString(),
							status: "queued",
							completionDelivered: false,
							collected: false,
						},
					});
					child = mustGet(created.sessionId);
					record = child.store.record;
					try {
						assertActive(entry, run);
					} catch (error) {
						finishChild(child, "aborted", "user");
						throw error;
					}
					archiveChild(child);
				}
				const metadata = record.childRun;
				if (!metadata) throw new Error("Missing child owner");
				if (
					metadata.status === "completed" ||
					metadata.status === "error" ||
					metadata.status === "aborted"
				)
					return childOutput(child);
				if (metadata.detached) {
					if (!childTasks.has(record.sessionId)) {
						const controller = new AbortController();
						queuedChildControllers.set(record.sessionId, controller);
						const work = (async () => {
							try {
								await acquireChildSlot(child, controller.signal);
								controller.signal.throwIfAborted();
								await promptSession(record.sessionId, metadata.task);
								if (child.store.record.pendingApproval || child.store.record.pendingToolResponse)
									return;
								const completion = child.store.record.state.completion;
								finishChild(
									child,
									completion?.outcome === "succeeded"
										? "completed"
										: completion?.outcome === "cancelled"
											? "aborted"
											: "error",
								);
							} catch {
								finishChild(child, "aborted", "interrupted");
							} finally {
								queuedChildControllers.delete(record.sessionId);
								childTasks.delete(record.sessionId);
							}
						})();
						childTasks.set(record.sessionId, work);
					}
					return {
						content: [
							{
								type: "text",
								text: `Background child ${record.sessionId} started. Its report will arrive automatically.`,
							},
						],
						details: childDetails(child),
					};
				}
				const childRun: ActiveRun = child.active ?? {
					id: randomUUID(),
					enabledExtensions: metadata.enabledExtensions,
					controller: new AbortController(),
					granted: true,
					done: Promise.resolve(),
					toolCalls: new Map(),
					startedTools: new Set<string>(),
				};
				child.active = childRun;
				let childDiagnostics: ReturnType<typeof attachAgentDiagnostics> | undefined;
				let childOutcome: DiagnosticOutcome = "success";
				let childError: unknown;
				try {
					if (metadata.status === "queued")
						await acquireChildSlot(child, childRun.controller.signal);
					if (!child.store.record.messages.some((message) => message.role === "user"))
						child.store.update((current) => {
							current.messages.push({
								id: randomUUID(),
								role: "user",
								content: metadata.task,
								timestamp: Date.now(),
							});
							current.state = { ...idleState(), execution: "running", runId: childRun.id };
						});
					const agent = await buildSessionAgent(child, childRun, model);
					childDiagnostics = attachAgentDiagnostics(
						agent,
						diagnosticIdentity(child, childRun.id),
						childRun.guardrails?.redact ?? runGuardrails(child).redact,
					);
					let hasChildOutcome = false;
					const childTool = agent.asTool({
						toolName: "Agent",
						toolDescription: "Run one foreground child task.",
						runConfig: {
							...traceRunOptions(diagnosticIdentity(entry, run.id)),
							toolExecution: { preApprovalInputGuardrails: true },
						},
						runOptions: {
							session: child.store,
							signal: childRun.controller.signal,
							maxTurns: metadata.definition.maxTurns ?? 20,
							errorHandlers: {
								maxTurns: ({ error }) => {
									childError = error;
								},
							},
						},
						onStream: ({ event }) => projectStream(child, childRun, event),
						customOutputExtractor: (result) => {
							if (result.interruptions.length) childOutcome = "suspended";
							const output = result.interruptions.length ? "" : (result.finalOutput ?? "");
							if (typeof output !== "string") throw new Error("Ordinary child output must be text");
							hasChildOutcome = true;
							childRun.state = result.state;
							const usage = result.state.usage;
							const last = child.store.record.messages.findLast(
								(message) => message.role === "assistant",
							);
							if (last?.role === "assistant") {
								const accounted = statsFromRecord(child.store.record).tokens;
								last.usage.input += usage.inputTokens - accounted.input;
								last.usage.output += usage.outputTokens - accounted.output;
								last.usage.totalTokens += usage.totalTokens - accounted.total;
								last.usage.cacheRead +=
									usage.inputTokensDetails.reduce(
										(sum, part) =>
											sum + (typeof part.cached_tokens === "number" ? part.cached_tokens : 0),
										0,
									) - accounted.cacheRead;
								last.usage.cacheWrite +=
									usage.inputTokensDetails.reduce(
										(sum, part) =>
											sum +
											(typeof part.cache_write_tokens === "number" ? part.cache_write_tokens : 0),
										0,
									) - accounted.cacheWrite;
								flush(child);
							}
							if (!result.interruptions.length) {
								finishChild(child, "completed");
								childRun.granted = false;
								delete child.active;
								delete child.store.historyGuardrails;
							}
							return output;
						},
					});
					let childInvocationDetails = details;
					if (details.resumeState) {
						const resumed = await RunState.fromString(agent, details.resumeState);
						assertWorkspaceContext(resumed.toJSON().context.context, child);
						for (const interruption of resumed.getInterruptions()) {
							if (interruption.rawItem.type !== "function_call")
								throw new Error("Unsupported child approval");
							const callId = interruption.rawItem.callId;
							const decision = Object.values(entry.store.record.decisions).find(
								(item) => item.runId === run.id && item.toolCallId === callId,
							);
							if (decision?.value === true) resumed.approve(interruption);
							else if (decision) resumed.reject(interruption);
						}
						childInvocationDetails = { ...details, resumeState: resumed.toString() };
					}
					const invocation = childDiagnostics.run(() =>
						childTool.invoke(
							context,
							JSON.stringify({ input: metadata.task }),
							childInvocationDetails,
						),
					);
					childRun.done = invocation.then(
						() => {},
						() => {},
					);
					const output = await invocation;
					if (!hasChildOutcome)
						throw new Error(
							typeof output === "string" ? output : "The child SDK run did not return an outcome",
						);
					return childOutput(child);
				} catch (error) {
					childOutcome = diagnosticFailure(
						childError ?? error,
						childRun.controller.signal,
						!!childRun.blocked,
					);
					return failedForegroundChild(child, childRun, error);
				} finally {
					await childDiagnostics?.close(childOutcome);
				}
			},
		}),
		tool({
			errorFunction: null,
			name: "get_subagent_result",
			description:
				"Read a child result owned by this parent. Background reports also arrive automatically.",
			isEnabled: () => subagentsAllowed(entry),
			parameters: z.object({ session_id: z.string() }),
			execute: ({ session_id }) => {
				assertActive(entry, run);
				const child = ownedChildEntry(entry, session_id);
				child.store.update((record) => {
					if (record.childRun && record.childRun.finishedAt !== undefined) {
						record.childRun.collected = true;
						record.childRun.completionDelivered = true;
					}
				});
				return childOutput(child);
			},
		}),
	];
}
function ownedChildEntry(parent: Entry, id: string): Entry {
	const record = sessions.get(id)?.store.record ?? readSessionRecord(id);
	if (
		!record ||
		record.workspaceId !== parent.store.record.workspaceId ||
		record.childRun?.parentSessionId !== parent.store.record.sessionId
	)
		throw new CodedError("RESOURCE_UNAVAILABLE", "Resource unavailable");
	return sessions.get(id) ?? { store: new PersistentSession(record) };
}
function commandService(entry: Entry): BackgroundCommands {
	if (entry.commands) return entry.commands;
	const service = createBackgroundCommands({
		sessionId: entry.store.record.sessionId,
		getContext: () => ({
			cwd: entry.store.record.cwd,
			sessionFile: sessionRecordPath(entry.store.record.sessionId),
			model: entry.store.record.model ?? undefined,
			thinkingLevel: entry.store.record.thinkingLevel,
			exposeSessionEnvironment: false,
		}),
	});
	entry.commands = service;
	entry.commandArchive = archiveCommandHistory(
		entry.store.record.workspaceId,
		entry.store.record.sessionId,
		service,
		() => entry.closingResources === true,
	);
	service.onChange(() => resourceChanged(entry));
	service.bindCompletion({
		canDeliverCompletion: () => {
			const recipient = entry.store.record.childRun ? resourceParent(entry) : entry;
			return !!recipient && !recipient.active && !recipient.stopping && !entry.stopping;
		},
		deliver: (batch) => {
			const recipient = entry.store.record.childRun ? resourceParent(entry) : entry;
			if (!recipient) return [];
			for (const completion of batch) {
				if (completion.snapshot.status === "stopped") continue;
				const { command: _command, ...summary } = completion.snapshot;
				const excerpt = commandExcerpt(completion.output.text, 4096, 40);
				const output = {
					text: excerpt.text,
					truncated: completion.output.truncated || excerpt.truncated,
				};
				queueResourceCompletion(
					recipient,
					`command-${completion.snapshot.id}`,
					`Background command ${completion.snapshot.name} ${completion.snapshot.status}:\n${output.text}`,
					"background-command-completion",
					{ ...summary, output, delivery: "wake" },
				);
			}
			return batch;
		},
	});
	return service;
}
function backgroundTools(entry: Entry, run: ActiveRun): Tool[] {
	return [
		tool({
			name: "background_command",
			description:
				"Manage session-owned background commands. Use action start, list, output or stop. Output of a finished command claims its completion.",
			parameters: z.object({
				action: z.enum(["start", "list", "output", "stop"]),
				command: z.string().min(1).max(65536).nullish(),
				name: z.string().max(200).nullish(),
				timeout: z.number().positive().max(2147483.647).nullish(),
				id: z.string().min(1).nullish(),
			}),
			needsApproval: async (_context, args) => args.action === "start",
			errorFunction: null,
			execute: (args) => {
				assertActive(entry, run);
				const allowed =
					args.action === "start"
						? ["action", "command", "name", "timeout"]
						: args.action === "list"
							? ["action"]
							: ["action", "id"];
				if (Object.entries(args).some(([key, value]) => value != null && !allowed.includes(key)))
					throw new Error("Unsupported inputs for this background command action");
				const service = commandService(entry);
				if (args.action === "start") {
					if (!args.command) throw new Error("start requires command");
					const handle = service.start({
						command: args.command,
						...(args.name ? { name: args.name } : {}),
						...(args.timeout ? { timeout: args.timeout } : {}),
					});
					return {
						content: [
							{
								type: "text",
								text: `Accepted background command ${handle.id} (${handle.snapshot.name}): ${handle.snapshot.status}`,
							},
						],
						details: { snapshot: handle.snapshot },
					};
				}
				if (args.action === "list") {
					const commands = service.list();
					return {
						content: [
							{
								type: "text",
								text:
									commands
										.map((snapshot) => `${snapshot.id} (${snapshot.name}): ${snapshot.status}`)
										.join("\n") || "No background commands in this session.",
							},
						],
						details: { commands },
					};
				}
				if (!args.id) throw new Error("output and stop require a command id");
				const handle = service.find(args.id);
				if (!handle) throw new Error("Background command unavailable in this session");
				if (args.action === "stop") {
					const snapshot = handle.stop();
					return {
						content: [{ type: "text", text: `Stop requested; ${snapshot.id}: ${snapshot.status}` }],
						details: { snapshot },
					};
				}
				const output = handle.output;
				if (!output) throw new Error("Background command output unavailable");
				const snapshot = handle.snapshot;
				if (snapshot.finishedAt !== undefined) handle.claimCompletion();
				return {
					content: [
						{
							type: "text",
							text: `${snapshot.id} (${snapshot.name}): ${snapshot.status}\n\n${output.truncated ? "[Output truncated; retained tail only.]\n" : ""}${output.text || "(no output)"}`,
						},
					],
					details: { snapshot, output },
				};
			},
		}),
	];
}
async function settleResourceCleanup(pending: Promise<unknown>[]): Promise<void> {
	const results = await Promise.allSettled(pending);
	const failures = results.filter(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (failures.length)
		throw new AggregateError(
			failures.map((result) => result.reason),
			"Resource cleanup failed",
		);
}
async function stopOwnedResources(entry: Entry, reason = "user"): Promise<void> {
	const pending: Promise<unknown>[] = [pauseSessionMcpConnections(entry.store.record.sessionId)];
	for (const scope of entry.reviewScopes ?? []) {
		scope.controller.abort();
		pending.push(scope.done);
	}
	for (const record of childRecords(entry)) {
		const live = record.childRun?.status === "queued" || record.childRun?.status === "running";
		queuedChildControllers.get(record.sessionId)?.abort();
		const child = sessions.get(record.sessionId);
		if (child) child.stopping = true;
		const preserveApproval =
			live &&
			reason === "interrupted" &&
			!deletingSessions.has(entry.store.record.sessionId) &&
			((!record.childRun?.detached &&
				!!entry.store.record.runCheckpoint &&
				!!(entry.store.record.pendingApproval || entry.store.record.pendingToolResponse)) ||
				!!(record.pendingApproval || record.pendingToolResponse)) &&
			!Object.values(record.effects).some((effect) => effect.status !== "completed");
		if (child?.active) {
			if (preserveApproval) child.active.suspended = true;
			child.active.granted = false;
			child.active.controller.abort();
			child.active.approval?.reject(new Error("Parent stopped"));
			child.active.toolResponse?.reject(new Error("Parent stopped"));
			pending.push(
				child.active.done.then(() => {
					if (preserveApproval) {
						delete child.active;
						delete child.store.historyGuardrails;
						sessions.delete(record.sessionId);
					}
				}),
			);
		}
		if (child) {
			pending.push(
				settleResourceCleanup([
					child.active?.done ?? Promise.resolve(),
					stopOwnedResources(child, reason),
				]).finally(() => {
					delete child.stopping;
				}),
			);
			if (live && !preserveApproval) finishChild(child, "aborted", reason);
		}
		const task = childTasks.get(record.sessionId);
		if (task) pending.push(task);
	}
	if (entry.commands) {
		const commands = entry.commands;
		entry.closingResources = reason === "interrupted";
		pending.push(
			commands.dispose().then(() => {
				entry.commandArchive?.finish();
				delete entry.commandArchive;
				if (entry.commands === commands) delete entry.commands;
				delete entry.closingResources;
			}),
		);
	}
	await settleResourceCleanup(pending);
	resourceChanged(entry);
}
export async function sessionResources(
	workspaceId: string,
	sessionId: string,
): Promise<SessionResources> {
	const entry = await ownedSessionEntry(workspaceId, sessionId);
	return {
		...summarizeResources(resourceScope(entry), ownedResourceSnapshots(entry)),
		mcpServers: mcpResourceSummaries(sessionId),
	};
}
async function ownedSessionEntry(workspaceId: string, sessionId: string): Promise<Entry> {
	const workspace = loadWorkspaces().find((item) => item.id === workspaceId);
	if (!workspace || !(await ensureSessionAttached(sessionId, workspaceId, workspace.worktreePath)))
		throw new CodedError("RESOURCE_UNAVAILABLE", "Resource unavailable");
	return mustGet(sessionId);
}
export async function reloadSessionResources(
	sessionId: string,
	workspaceId: string,
	cwd: string,
): Promise<void> {
	const record = sessions.get(sessionId)?.store.record ?? readSessionRecord(sessionId);
	if (
		!record ||
		record.workspaceId !== workspaceId ||
		record.cwd !== resolve(cwd) ||
		record.childRun
	)
		throw new Error("Session is unavailable in its workspace");
	if (
		record.state.execution === "running" ||
		record.pendingApproval ||
		record.pendingToolResponse ||
		record.runCheckpoint
	)
		throw new Error("Resources can only reload in an idle session");
	const entry = await ownedSessionEntry(workspaceId, sessionId);
	if (
		entry.active ||
		entry.stopping ||
		entry.summaryController ||
		entry.reviewScopes?.size ||
		ownedResourceSnapshots(entry).some(resourceIsLive)
	)
		throw new Error("Resources can only reload in an idle session");
	const model = entry.store.record.model;
	if (!model) throw new Error("Select a model before reloading resources");
	const run: ActiveRun = {
		id: randomUUID(),
		enabledExtensions: snapshotSdkExtensions(
			loadConfig().disabledExtensions,
			loadConfig().extensionSettings,
		),
		controller: new AbortController(),
		granted: true,
		done: Promise.resolve(),
		toolCalls: new Map(),
		startedTools: new Set(),
	};
	entry.active = run;
	run.done = (async () => {
		try {
			assertActive(entry, run);
			await reconcileMcpSessions([sessionId]);
			assertActive(entry, run);
			await buildSessionGraph(entry, run, model, false);
			assertActive(entry, run);
		} finally {
			run.granted = false;
			run.controller.abort();
			if (entry.active === run) {
				delete entry.active;
				delete entry.store.historyGuardrails;
			}
		}
	})();
	await run.done;
}
export async function sessionResourceHistory(
	workspaceId: string,
	sessionId: string,
	request: { kind: ResourceKind; before?: ResourceHistoryCursor; limit?: number },
) {
	const entry = await ownedSessionEntry(workspaceId, sessionId);
	return resourcePage(resourceScope(entry), ownedResourceSnapshots(entry), request);
}
export async function backgroundCommandOutput(
	workspaceId: string,
	sessionId: string,
	commandId: string,
) {
	const entry = await ownedSessionEntry(workspaceId, sessionId);
	const handle = commandOwners(entry)
		.map((owner) => owner.commands?.find(commandId))
		.find(Boolean);
	if (handle)
		return {
			available: true as const,
			command: handle.snapshot,
			output: handle.output ?? { text: "", truncated: false },
		};
	const output = commandOwners(entry)
		.map((owner) =>
			archivedCommandOutput({ workspaceId, sessionId: owner.store.record.sessionId }, commandId),
		)
		.find((value) => value !== undefined);
	const summary = resourceHistoryOf(
		resourceScope(entry),
		"command",
		ownedResourceSnapshots(entry),
	).finished.find((item) => item.kind === "command" && item.summary.id === commandId);
	return output && summary?.kind === "command"
		? { available: true as const, command: summary.summary, output }
		: { available: false as const };
}
export async function stopBackgroundCommand(
	workspaceId: string,
	sessionId: string,
	commandId: string,
): Promise<void> {
	const entry = await ownedSessionEntry(workspaceId, sessionId);
	const handle = commandOwners(entry)
		.map((owner) => owner.commands?.find(commandId))
		.find(Boolean);
	if (!handle) throw new CodedError("RESOURCE_UNAVAILABLE", "Resource unavailable");
	handle.stop();
}
export async function stopSubagent(
	workspaceId: string,
	parentSessionId: string,
	childSessionId: string,
): Promise<void> {
	const parent = await ownedSessionEntry(workspaceId, parentSessionId);
	const child = ownedChildEntry(parent, childSessionId);
	queuedChildControllers.get(childSessionId)?.abort();
	if (sessions.has(childSessionId)) await abortSession(childSessionId);
	finishChild(child, "aborted", "user");
}
export async function stopSubagents(workspaceId: string, parentSessionId: string): Promise<number> {
	const parent = await ownedSessionEntry(workspaceId, parentSessionId);
	const records = childRecords(parent).filter((record) => {
		const child = sessions.get(record.sessionId);
		return (
			record.childRun?.status === "running" ||
			record.childRun?.status === "queued" ||
			(child !== undefined &&
				(!!child.active || ownedResourceSnapshots(child).some(resourceIsLive)))
		);
	});
	await Promise.all(
		records.map((record) => stopSubagent(workspaceId, parentSessionId, record.sessionId)),
	);
	return records.length;
}
export async function subagentTranscript(
	workspaceId: string,
	parentSessionId: string,
	childSessionId: string,
) {
	const parent = await ownedSessionEntry(workspaceId, parentSessionId);
	const child = ownedChildEntry(parent, childSessionId);
	return {
		messages: structuredClone(
			projectImages(child.store.record.messages, parentSessionId),
		) as TranscriptMessage[],
		...(child.store.record.childRun ? { status: child.store.record.childRun.status } : {}),
	};
}

export function acquireSessionReviewScope(sessionId: string): {
	signal: AbortSignal;
	release: () => void;
} {
	const entry = mustGet(sessionId);
	if (
		entry.stopping ||
		closingSessions.has(sessionId) ||
		deletingSessions.has(sessionId) ||
		closingWorkspaces.has(entry.store.record.workspaceId)
	)
		throw new Error("Session is closing");
	const controller = new AbortController();
	let releaseScope = () => {};
	const scope = {
		controller,
		done: new Promise<void>((resolveScope) => {
			releaseScope = resolveScope;
		}),
	};
	entry.reviewScopes ??= new Set();
	entry.reviewScopes.add(scope);
	resourceChanged(entry);
	return {
		signal: controller.signal,
		release: () => {
			if (!entry.reviewScopes?.delete(scope)) return;
			releaseScope();
			resourceChanged(entry);
		},
	};
}

export interface AgentTitleHost {
	apply(
		sessionId: string,
		params: { chat_title?: string; workspace_name?: string; branch?: string },
		assertActive: () => void,
	): Promise<string>;
	workspaceNeedsName(sessionId: string): boolean;
}
let titleHost: AgentTitleHost | undefined;
export function setAgentTitleHost(host: AgentTitleHost | undefined): void {
	titleHost = host;
}
function titleTools(entry: Entry, run: ActiveRun): Tool[] {
	if (!titleHost || entry.store.record.childRun) return [];
	return [
		tool({
			errorFunction: null,
			name: "set_title",
			description: `Set a concise chat title. ${titleHost.workspaceNeedsName(entry.store.record.sessionId) ? "Also supply workspace_name and branch for the unnamed workspace." : "Existing user names are preserved."}`,
			parameters: z.object({
				chat_title: z.string().nullable().optional(),
				workspace_name: z.string().nullable().optional(),
				branch: z.string().nullable().optional(),
			}),
			execute: async (args) => {
				assertActive(entry, run);
				if (!titleHost) throw new Error("Title service is unavailable");
				return titleHost.apply(
					entry.store.record.sessionId,
					{
						...(args.chat_title ? { chat_title: args.chat_title } : {}),
						...(args.workspace_name ? { workspace_name: args.workspace_name } : {}),
						...(args.branch ? { branch: args.branch } : {}),
					},
					() => assertActive(entry, run),
				);
			},
		}),
	];
}
export interface SessionChildRequest {
	name: string;
	instructions: string;
	prompt: string;
	model: WireModel;
	thinkingLevel: ThinkingLevel;
	tools?: string[];
	maxTurns?: number;
	signal?: AbortSignal;
}
export async function runSessionChild(parentSessionId: string, request: SessionChildRequest) {
	const parentRecord =
		sessions.get(parentSessionId)?.store.record ?? readSessionRecord(parentSessionId);
	if (!parentRecord) throw new Error("Parent session is unavailable");
	await ownedSessionEntry(parentRecord.workspaceId, parentSessionId);
	const scope = acquireSessionReviewScope(parentSessionId);
	request = {
		...request,
		signal: request.signal ? AbortSignal.any([request.signal, scope.signal]) : scope.signal,
	};
	try {
		request.signal?.throwIfAborted();
		if (!request.model.thinkingLevels.includes(request.thinkingLevel))
			throw new Error("Review effort is unavailable for the selected model");
		const allowedTools = request.tools ?? [
			"read",
			"search",
			"spec_get",
			"spec_graph",
			"spec_search",
			"spec_grep",
		];
		if (
			allowedTools.some(
				(name) =>
					![
						"read",
						"search",
						"spec_get",
						"spec_graph",
						"spec_search",
						"spec_grep",
						"spec_validate",
					].includes(name),
			)
		)
			throw new Error("Review children require read-only tools");
		const created = await createSession({
			cwd: parentRecord.cwd,
			workspaceId: parentRecord.workspaceId,
			model: request.model,
			thinkingLevel: request.thinkingLevel,
			childRun: {
				parentSessionId,
				purpose: "review",
				outputContract: REVIEW_OUTPUT_CONTRACT,
				toolCallId: randomUUID(),
				task: request.prompt,
				enabledExtensions: snapshotSdkExtensions(
					loadConfig().disabledExtensions,
					loadConfig().extensionSettings,
					"child",
				),
				definition: {
					name: request.name,
					description: "Independent review",
					source: "builtin",
					systemPrompt: request.instructions,
					tools: allowedTools,
					extensions: true,
					inheritProjectContext: true,
					...(request.maxTurns ? { maxTurns: request.maxTurns } : {}),
				},
				detached: false,
				createdAt: new Date().toISOString(),
				status: "queued",
				completionDelivered: false,
				collected: false,
			},
		});
		const child = mustGet(created.sessionId),
			controller = new AbortController();
		const abort = () => {
			controller.abort();
			if (child.active)
				void abortSession(created.sessionId).catch((error) =>
					log.warn("Review cancellation failed", error),
				);
		};
		request.signal?.addEventListener("abort", abort, { once: true });
		queuedChildControllers.set(created.sessionId, controller);
		try {
			if (request.signal?.aborted) abort();
			request.signal?.throwIfAborted();
			await acquireChildSlot(child, controller.signal);
			request.signal?.throwIfAborted();
			await promptEntry(child, request.prompt);
			request.signal?.throwIfAborted();
			const binding = child.store.record.childRun?.reviewOutput;
			const message =
				binding && binding.runId === child.store.record.state.completion?.completionId
					? child.store.record.messages.find((message) => message.id === binding.messageId)
					: undefined;
			const output =
				message?.role === "assistant" && message.stopReason === "stop"
					? message.planReview
					: undefined;
			if (child.store.record.childRun?.status === "completed" && !output)
				throw new Error("The review child has no committed output");
			return {
				sessionId: created.sessionId,
				output,
				status: child.store.record.childRun?.status ?? "error",
				usage: getSessionStats(created.sessionId).tokens,
			};
		} catch (error) {
			finishChild(child, controller.signal.aborted ? "aborted" : "error");
			throw error;
		} finally {
			request.signal?.removeEventListener("abort", abort);
			queuedChildControllers.delete(created.sessionId);
		}
	} finally {
		scope.release();
	}
}

let requestReviewHandler:
	| ((
			sessionId: string,
			itemId: string,
			signal: AbortSignal,
	  ) => Promise<{ result: PlanReviewResult; text: string }>)
	| undefined;
let resolveCommentHandler:
	| ((
			sessionId: string,
			commentId: string,
			reason: string,
			signal: AbortSignal,
	  ) => Promise<unknown>)
	| undefined;
export function setRequestReviewHandler(handler: typeof requestReviewHandler): void {
	requestReviewHandler = handler;
}
export function setResolveCommentHandler(handler: typeof resolveCommentHandler): void {
	resolveCommentHandler = handler;
}
function reviewTools(entry: Entry, run: ActiveRun): Tool[] {
	if (entry.store.record.childRun) return [];
	const tools: Tool[] = [];
	if (requestReviewHandler && loadConfig().agentReviewEnabled)
		tools.push(
			tool({
				errorFunction: null,
				name: "request_review",
				description: "Request independent review of one completed Plan step.",
				parameters: z.object({ itemId: z.string().min(1) }),
				execute: async ({ itemId }) => {
					assertActive(entry, run);
					if (!requestReviewHandler || !loadConfig().agentReviewEnabled)
						throw new Error("Agent review is disabled");
					const result = await requestReviewHandler(
						entry.store.record.sessionId,
						itemId,
						run.controller.signal,
					);
					assertActive(entry, run);
					return { content: [{ type: "text", text: result.text }], details: result.result };
				},
			}),
		);
	if (resolveCommentHandler)
		tools.push(
			tool({
				errorFunction: null,
				name: "resolve_comment",
				description: "Resolve one review finding after its requested fix.",
				parameters: z.object({ commentId: z.string().min(1), note: z.string().nullish() }),
				execute: async ({ commentId, note }) => {
					assertActive(entry, run);
					if (!resolveCommentHandler) throw new Error("Review comment service is unavailable");
					return resolveCommentHandler(
						entry.store.record.sessionId,
						commentId,
						note ?? "",
						run.controller.signal,
					);
				},
			}),
		);
	return tools;
}
export async function sendReviewFixToSession(
	sessionId: string,
	text: string,
	details: unknown,
): Promise<void> {
	const entry = mustGet(sessionId);
	assertAdditionalInputAllowed(entry);
	if (entry.stopping || closingSessions.has(sessionId) || deletingSessions.has(sessionId))
		throw new Error("The session cannot accept a review fix");
	const messageId = `review-fix-${randomUUID()}`;
	const inputId = `resource-input-${messageId}`;
	entry.fixCompletions ??= new Map();
	return new Promise<void>((resolveFix, rejectFix) => {
		entry.fixCompletions?.set(inputId, { resolve: resolveFix, reject: rejectFix });
		try {
			queueResourceCompletion(entry, messageId, text, "review-fix-request", details);
			if (!entry.store.record.messages.some((message) => message.id === messageId))
				throw new Error("The review fix was not accepted");
		} catch (error) {
			entry.fixCompletions?.delete(inputId);
			rejectFix(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function reconcileStoredChildren(parent: Entry): void {
	if (parent.store.record.childRun) return;
	for (const record of childRecords(parent)) {
		const child = record.childRun;
		if (
			!child ||
			(child.status !== "queued" && child.status !== "running") ||
			sessions.get(record.sessionId)?.active ||
			childTasks.has(record.sessionId) ||
			queuedChildControllers.has(record.sessionId)
		)
			continue;
		const waiting =
			!!record.runCheckpoint && !!(record.pendingApproval || record.pendingToolResponse);
		const nested =
			!child.detached &&
			!!parent.store.record.runCheckpoint &&
			!!(parent.store.record.pendingApproval || parent.store.record.pendingToolResponse);
		const unsupportedReview =
			child.purpose === "review" && child.outputContract !== REVIEW_OUTPUT_CONTRACT;
		if (
			!unsupportedReview &&
			(waiting || nested) &&
			!Object.values(record.effects).some((effect) => effect.status !== "completed")
		)
			continue;
		const store = new PersistentSession(record);
		store.update((current) => {
			if (current.childRun) {
				current.childRun.status = unsupportedReview ? "error" : "aborted";
				current.childRun.abortReason = unsupportedReview
					? "Unsupported Plan review output contract; start a new review"
					: "interrupted";
				current.childRun.finishedAt = Date.now();
				current.childRun.completionDelivered = true;
			}
			current.state.execution = "idle";
			current.state.needsInput = null;
			current.state.completion = {
				completionId: current.state.runId ?? current.sessionId,
				...(unsupportedReview
					? { outcome: "failed" as const, failure: "error" as const }
					: { outcome: "interrupted" as const }),
			};
			for (const effect of Object.values(current.effects))
				if (effect.status === "started") effect.status = "unknown";
			delete current.pendingApproval;
			delete current.pendingToolResponse;
			delete current.runCheckpoint;
		});
		recordResource(
			{ workspaceId: record.workspaceId, sessionId: parent.store.record.sessionId },
			{ kind: "subagent", summary: childSummary(store.record) },
		);
	}
}

function captureStructuredToolResults(tools: Tool<SessionContext>[], run: ActiveRun): void {
	run.structuredResults ??= new Map();
	for (const candidate of tools) {
		if (candidate.type !== "function") continue;
		const invoke = candidate.invoke;
		candidate.invoke = async (context, input, details) => {
			const callId = details?.toolCall?.callId;
			let result: unknown;
			try {
				result = await invoke(context, input, details);
			} catch (error) {
				if (!run.granted || run.controller.signal.aborted || details?.signal?.aborted) throw error;
				const text = error instanceof Error ? error.message : String(error);
				const bounded = truncateHead(`Error: ${text}`);
				result = {
					content: [
						{
							type: "text",
							text: bounded.truncated
								? `${bounded.content || "Tool failed."}\n[Error text truncated]`
								: bounded.content,
						},
					],
					isError: true,
				};
			}
			if (
				callId &&
				result &&
				typeof result === "object" &&
				"isError" in result &&
				result.isError === true
			) {
				const call = run.toolCalls.get(callId);
				if (call) call.failed = true;
			}
			const structured = structuredToolResult(result);
			if (callId && structured) {
				run.structuredResults?.set(callId, structured);
				const call = run.toolCalls.get(callId);
				if (call && structured.isError) call.failed = true;
				return typeof result === "string" ? result : textOf(structured.content);
			}
			return result;
		};
	}
}

function assertWorkspaceContext(context: unknown, entry: Entry): asserts context is SessionContext {
	if (
		typeof context !== "object" ||
		context === null ||
		Array.isArray(context) ||
		Object.keys(context).length !== 1 ||
		!("workspaceId" in context) ||
		context.workspaceId !== entry.store.record.workspaceId
	)
		throw new Error(
			"SDK checkpoint workspace identity is missing or does not match this workspace",
		);
}

async function buildSessionAgent(
	entry: Entry,
	run: ActiveRun,
	model: WireModel,
	sdkModel: Agent["model"] = createConfiguredModel(model, entry.store.record.sessionId),
	role: { node?: string; target?: AgentDefinition; thinkingLevel?: ThinkingLevel } = {},
): Promise<SessionAgent> {
	const childDefinition = entry.store.record.childRun?.definition;
	const definition = role.target ?? childDefinition;
	const active = () => assertActive(entry, run);
	const assertOwner = () => {
		assertActive(entry, run);
		if (role.node !== undefined && entry.store.record.handoffs?.activeNode !== role.node)
			throw new Error("This agent is not the accepted conversation owner");
	};
	const thinkingLevel = role.thinkingLevel ?? entry.store.record.thinkingLevel;
	run.guardrails ??= runGuardrails(entry);
	const gate = run.guardrails.output;
	entry.store.historyGuardrails = {
		redactToolArguments: run.guardrails.redactToolArguments,
		checkOutput: (text) => {
			const hit = gate.match(text);
			if (!hit) return;
			run.blocked ??= hit;
			throw new GuardrailOutputBlockedError(hit.rule);
		},
	};
	const skillOptions = {
		...(definition ? { allowedSkills: definition.skills ?? [] } : {}),
		manualSkills: definition
			? []
			: entry.store.record.messages.flatMap((message) =>
					message.role === "user"
						? [skillCommandName(textOf(message.content))].filter(
								(name): name is string => name !== undefined,
							)
						: [],
				),
		cwd: entry.store.record.cwd,
		admission: () =>
			admissionContextFor(
				loadProjects().find((item) => item.id === projectOf(entry.store.record.workspaceId)),
				loadWorkspaces().find((item) => item.id === entry.store.record.workspaceId)
					?.skillOverrides ?? {},
				loadConfig().otherAgentSkills,
			),
		assertActive: active,
		signal: run.controller.signal,
	};
	// Preloaded Skills are read inside the SDK run (dynamic instructions), so a read failure fails that run.
	const preloadedSkills = () =>
		definition?.skills
			?.map((name) => readAdmittedSkill(skillOptions, name, null).text)
			.join("\n\n");
	const projectContext =
		!definition || definition.inheritProjectContext
			? workspaceInstructions(entry.store.record.cwd)
			: "";
	const skillCatalog = skillInstructions(skillOptions, model);
	// A standalone chat is not a repository: it and its children get no Spec tools or rule.
	const repository =
		loadWorkspaces().find((item) => item.id === entry.store.record.workspaceId)?.kind !== "chat";
	const sandboxEnabled = entry.store.record.sandbox === true;
	const sandboxSession = sandboxEnabled
		? () => {
				if (!run.sandbox) throw new Error("The Sandbox session has not started");
				return run.sandbox;
			}
		: undefined;
	const applicationTools = [
		...(definition
			? []
			: createWorkspaceActions({
					sessionId: entry.store.record.sessionId,
					inputId: run.inputId,
					standalone: !repository,
					signal: run.controller.signal,
					assertActive: active,
				})),
		...(definition || sandboxEnabled ? [] : await childTools(entry, run)),
		...(sandboxEnabled ? [] : backgroundTools(entry, run)),
		...titleTools(entry, run),
		...reviewTools(entry, run),
		...createTodoTools({
			cwd: entry.store.record.cwd,
			sessionId: entry.store.record.sessionId,
			assertActive: active,
		}),
		...(repository
			? createSpecTools({
					cwd: entry.store.record.cwd,
					assertActive: active,
				})
			: []),
		...(definition && !definition.extensions && !definition.skills?.length
			? []
			: createSkillTools(skillOptions)),
		...(await (definition
			? Promise.resolve([])
			: sessionMcpTools({
					sessionId: entry.store.record.sessionId,
					workspaceId: entry.store.record.workspaceId,
					cwd: entry.store.record.cwd,
					signal: run.controller.signal,
					assertActive: active,
					markToolFailed: (callId: string) => {
						const call = run.toolCalls.get(callId);
						if (call) call.failed = true;
					},
				}))),
	];
	const options: AgentOptions<SessionContext, "text" | typeof planReviewOutput> = {
		name: definition?.name ?? ROOT_AGENT_NAME,
		outputType: entry.store.record.childRun?.purpose === "review" ? planReviewOutput : "text",
		inputGuardrails: run.guardrails.agentInput,
		instructions: (context) => {
			assertWorkspaceContext(context.context, entry);
			assertOwner();
			const commandInstructions = sandboxEnabled
				? "Sandbox bash supports bare pwd directly and rm -- <relative-file> with approval. Other command forms are rejected. Use apply_patch for approved edits."
				: "Use apply_patch for edits and bash to run project checks. Request approval for commands and edits.";
			return `${definition?.systemPrompt ?? ""}\nYou are RailDesign, a coding assistant. Work only in the assigned worktree: ${entry.store.record.cwd}. Use read and search to inspect files. ${commandInstructions} A denied operation is not permission to try another route. Report actual checks and remaining limits.\n${projectContext}\n${preloadedSkills() ?? ""}\n${skillCatalog}\n${TODO_RULE}\n${repository ? SPEC_RULE : ""}\n${WORKFLOW_RULE}\n${ARTIFACTS_RULE}`;
		},
		model: sdkModel,
		tools: [
			...applicationTools,
			...(run.memory && sandboxSession ? [run.memory.readTool(sandboxSession, active)] : []),
			...workspaceTools(
				{
					workspaceId: entry.store.record.workspaceId,
					cwd: entry.store.record.cwd,
					signal: run.controller.signal,
					assertActive: active,
				},
				sandboxSession,
			),
			...registrySdkTools(
				{
					cwd: entry.store.record.cwd,
					webAccess: {
						search: async (query, count, signal) => {
							active();
							const result = await webSearch(query, count, signal ?? run.controller.signal);
							active();
							return result;
						},
						fetch: async (url, signal) => {
							active();
							const result = await webFetch(url, signal ?? run.controller.signal);
							active();
							return result;
						},
					},
					workspaceFiles: createWorkspaceFiles(
						entry.store.record.workspaceId,
						entry.store.record.cwd,
						active,
					),
					assertActive: active,
					toolResponse: (callId) => {
						const answer = Object.values(entry.store.record.toolResponses).find(
							(receipt) => receipt.runId === run.id && receipt.toolCallId === callId,
						);
						if (!answer) throw new Error("The tool has no saved response");
						return isSupersededAnswer(answer.response)
							? { kind: "deferred" }
							: { kind: "response", value: answer.response };
					},
				},
				definition && !definition.extensions ? [] : run.enabledExtensions,
				childDefinition ? "child" : "parent",
			),
		],
		// A tool result marked `terminate` ends the run without another model call.
		toolUseBehavior: (_context, results) =>
			results.some(
				(result) =>
					result.type === "function_output" &&
					run.structuredResults?.get(result.runItem.rawItem.callId)?.terminate,
			)
				? { isFinalOutput: true, isInterrupted: undefined, finalOutput: "" }
				: { isFinalOutput: false, isInterrupted: undefined },
		modelSettings: {
			...responsesClientSettings,
			maxTokens: modelOutputBudget(model),
			...(model.reasoning && thinkingLevel !== "off"
				? { reasoning: { effort: thinkingLevel } }
				: {}),
		},
	};
	const agent = sandboxEnabled
		? new SandboxAgent({ ...options, capabilities: [], baseInstructions: "" })
		: new Agent(options);
	trackWorkspaceTools(entry, run, agent, assertOwner);
	if (definition) {
		const aliases = new Set(
			definition.tools?.flatMap((name) =>
				["grep", "find", "ls"].includes(name) ? ["search"] : [name],
			),
		);
		const excluded = childDefinition
			? ["Agent", "get_subagent_result", "ask_user_question"]
			: ["Agent", "get_subagent_result"];
		agent.tools = agent.tools.filter(
			(candidate) =>
				candidate.type !== "function" ||
				(!excluded.includes(candidate.name) && (!definition.tools || aliases.has(candidate.name))),
		);
	}
	if (role.node !== undefined) agentNodes.set(agent, role.node);
	captureStructuredToolResults(agent.tools, run);
	attachToolGuardrails(agent.tools, run, run.guardrails);
	if (agent instanceof SandboxAgent) {
		const patch = agent.tools.find((candidate) => candidate.name === "apply_patch");
		if (patch) agent.tools = agent.tools.filter((candidate) => candidate !== patch);
		agent.capabilities = [
			...(patch ? [filesystem({ configureTools: () => [patch] })] : []),
			...(run.memory?.capabilities ?? []),
		];
	}
	return agent;
}

function trackWorkspaceTools<TContext, TOutput extends AgentOutputType>(
	entry: Entry,
	run: ActiveRun,
	agent: Agent<TContext, TOutput>,
	assertOwner: () => void,
): void {
	agent.on("agent_tool_start", (_context, _tool, details) => {
		assertOwner();
		if (details.toolCall.type !== "function_call") return;
		const toolCall = details.toolCall;
		addToolCall(entry, run, toolCall, agent.name);
		const previous = entry.store.record.effects[toolCall.callId];
		if (
			previous &&
			!(
				toolCall.name === "Agent" &&
				childRecords(entry).some((record) => record.childRun?.toolCallId === toolCall.callId)
			)
		)
			throw new Error("A recorded tool effect cannot be replayed");
		entry.store.update((record) => {
			delete record.runCheckpoint;
			record.effects[toolCall.callId] = {
				runId: run.id,
				name: toolCall.name,
				arguments: run.toolCalls.get(toolCall.callId)?.arguments ?? {},
				status: "started",
			};
		});
		run.startedTools.add(toolCall.callId);
		const call = run.toolCalls.get(toolCall.callId);
		emit(entry, {
			type: "tool_execution_start",
			toolCallId: toolCall.callId,
			toolName: toolCall.name,
			args: call?.arguments ?? {},
		});
	});
	agent.on("agent_tool_end", (_context, _tool, result, details) => {
		if (!run.granted || details.toolCall.type !== "function_call") return;
		recordToolResult(
			entry,
			details.toolCall.callId,
			details.toolCall.name,
			result,
			run.toolCalls.get(details.toolCall.callId)?.failed,
		);
	});
}

/** Current rule files and configured credentials; read once per run. */
function runGuardrails(entry: Entry): GuardrailPolicy {
	const { cwd, workspaceId } = entry.store.record;
	const projectTrusted = projectResourcesTrusted(workspaceId);
	return loadGuardrailPolicy({
		cwd,
		dataDir: dataDir(),
		projectTrusted,
		credentials: [
			...configuredModelKeys(),
			readWebAccessKey() ?? "",
			...mcpCredentialValues(
				loadMcpConfigFiles({ agentDir: dataDir(), cwd, projectTrusted }).servers,
			),
		],
	});
}

function diagnosticIdentity(entry: Entry, runId: string) {
	const { sessionId, workspaceId, childRun, handoffs } = entry.store.record;
	return {
		sessionId,
		runId,
		workspaceId,
		startNodeId: handoffs?.activeNode ?? HANDOFF_ROOT,
		...(childRun ? { parentSessionId: childRun.parentSessionId } : {}),
	};
}

function diagnosticFailure(
	error: unknown,
	signal: AbortSignal,
	blocked = false,
): DiagnosticOutcome {
	if (
		blocked ||
		error instanceof GuardrailOutputBlockedError ||
		error instanceof InputGuardrailTripwireTriggered
	)
		return "guardrail";
	if (signal.aborted) return "cancel";
	return error instanceof MaxTurnsExceededError ? "length" : "error";
}

/**
 * Every FunctionTool gets the run's tool guardrails. A rejection records its outcome for the tool card;
 * a withheld result keeps the original output on the host transcript while the model gets the message.
 */
function attachToolGuardrails(
	tools: Tool<SessionContext>[],
	run: ActiveRun,
	policy: GuardrailPolicy,
): void {
	run.guardrailOutcomes ??= new Map();
	const observe = (callId: string, stage: ToolGuardrailOutcome["stage"], rule: string) =>
		run.guardrailOutcomes?.set(callId, { stage, rule });
	for (const candidate of tools) {
		if (candidate.type !== "function") continue;
		candidate.inputGuardrails = [...policy.toolInput, ...(candidate.inputGuardrails ?? [])].map(
			(guardrail) => ({
				...guardrail,
				run: async (data) => {
					const result = await guardrail.run(data);
					if (result.behavior.type === "rejectContent")
						observe(data.toolCall.callId, "input", guardrail.name);
					return result;
				},
			}),
		);
		candidate.outputGuardrails = policy.toolOutput.map((guardrail) => ({
			...guardrail,
			run: async (data) => {
				const result = await guardrail.run(data);
				if (result.behavior.type === "rejectContent") {
					const callId = data.toolCall.callId;
					observe(callId, "output", guardrail.name);
					if (!run.structuredResults?.has(callId))
						run.structuredResults?.set(callId, {
							content: [
								{
									type: "text",
									text: typeof data.output === "string" ? data.output : JSON.stringify(data.output),
								},
							],
							isError: false,
						});
				}
				return result;
			},
		}));
	}
}

function projectResourcesTrusted(workspaceId: string): boolean {
	return (
		loadProjects().find((project) => project.id === projectOf(workspaceId))?.resourceTrust ===
		"granted"
	);
}

function assertHandoffGraphCurrent(entry: Entry): void {
	const saved = entry.store.record.handoffs?.graph;
	if (!saved) return;
	// A malformed or unreadable graph throws its own cause; only a valid but different graph is drift.
	const current = loadHandoffGraph({
		cwd: entry.store.record.cwd,
		agentDir: dataDir(),
		projectTrusted: projectResourcesTrusted(entry.store.record.workspaceId),
	});
	if (!isDeepStrictEqual(current, saved))
		throw new Error(
			"Handoff configuration or trust changed since this chat started; restore it or start a new chat",
		);
}

function assertOwnerAgent(entry: Entry, agent: object): void {
	const handoffs = entry.store.record.handoffs;
	if (handoffs && agentNodes.get(agent) !== handoffs.activeNode)
		throw new Error("The SDK agent is not the accepted conversation owner");
}

function assertHandoffAuthority(entry: Entry, run: ActiveRun, from: string, to: string): void {
	assertActive(entry, run);
	const handoffs = entry.store.record.handoffs;
	if (!handoffs || handoffs.activeNode !== from)
		throw new Error("The transferring agent is not the accepted conversation owner");
	if (!handoffTargets(handoffs.graph, from)?.includes(to))
		throw new Error("The conversation transfer is not declared");
	assertHandoffGraphCurrent(entry);
}

function commitHandoffOwner(entry: Entry, run: ActiveRun, node: string): void {
	if (entry.store.record.handoffs?.activeNode === node) return;
	const pending = run.pendingTransfer;
	delete run.pendingTransfer;
	if (pending?.to !== node) throw new Error("The conversation transfer was not accepted");
	assertHandoffAuthority(entry, run, pending.from, node);
	const transfer = {
		id: randomUUID(),
		runId: run.id,
		from: pending.from,
		to: node,
		reason: pending.reason,
		timestamp: Date.now(),
	};
	const message: TranscriptMessage = {
		id: `transfer:${transfer.id}`,
		role: "custom",
		customType: AGENT_TRANSFER_CUSTOM_TYPE,
		content: "",
		display: true,
		details: {
			transferId: transfer.id,
			from: agentName(transfer.from),
			to: agentName(node),
			reason: transfer.reason,
		},
		timestamp: transfer.timestamp,
	};
	// Owner, receipt and transcript row commit in one write; the row is published only after it.
	entry.store.update((record) => {
		if (record.handoffs?.activeNode !== pending.from)
			throw new Error("The conversation owner changed during transfer");
		record.handoffs.activeNode = node;
		record.handoffs.transfers.push(transfer);
		record.messages.push(message);
		record.eventSeq += 1;
	});
	assertActive(entry, run);
	publishEvent(entry, { type: "message_end", message });
	notifyState(entry);
}

/** Applies the current agent's Handoff history policy to the model request; the Session keeps all. */
function modelHistoryView(
	entry: Entry,
	run: ActiveRun,
	agent: object,
	input: AgentInputItem[],
): AgentInputItem[] {
	const handoffs = entry.store.record.handoffs;
	const node = agentNodes.get(agent);
	if (!handoffs || node === undefined || handoffHistory(handoffs.graph, node) === "all")
		return input;
	// The target keeps its own exchanges of this run; RunState attributes each generated item. Before
	// the first stream of a fresh run there is no state and no generated item yet.
	const own = new Set(
		(run.state?.toJSON().generatedItems ?? []).flatMap((item) =>
			(item.type === "tool_call_item" || item.type === "handoff_call_item") &&
			item.rawItem.type === "function_call" &&
			item.agent.name === agentName(node)
				? [item.rawItem.callId]
				: [],
		),
	);
	return withoutToolHistory(
		input,
		own,
		(operationId) => entry.store.record.summaryOperations[operationId]?.toolFree === true,
	);
}

const handoffReason = z.object({ reason: z.string().max(2000) });

/** Builds every declared node over one run grant; returns the root and the accepted owner. */
async function buildSessionGraph(
	entry: Entry,
	run: ActiveRun,
	model: WireModel,
	configured = true,
): Promise<{ root: SessionAgent; start: SessionAgent }> {
	const sdkModel = (selected: WireModel) =>
		configured ? createConfiguredModel(selected, entry.store.record.sessionId) : selected.id;
	const handoffs = entry.store.record.handoffs;
	if (!handoffs) {
		const agent = await buildSessionAgent(entry, run, model, sdkModel(model));
		return { root: agent, start: agent };
	}
	assertHandoffGraphCurrent(entry);
	const available = await listAvailableModels();
	assertActive(entry, run);
	const agents = new Map<string, SessionAgent>([
		[
			HANDOFF_ROOT,
			await buildSessionAgent(entry, run, model, sdkModel(model), { node: HANDOFF_ROOT }),
		],
	]);
	for (const { definition } of handoffs.graph.nodes) {
		const mapped = toSpawnMapping(definition, {
			cwd: entry.store.record.cwd,
			availableModels: available,
		});
		const selected = mapped.session.model
			? available.find(
					(item) =>
						item.id === mapped.session.model?.id && item.provider === mapped.session.model.provider,
				)
			: model;
		if (!selected) throw new Error(`Agent "${definition.name}" model is unavailable`);
		agents.set(
			definition.name,
			await buildSessionAgent(entry, run, selected, sdkModel(selected), {
				node: definition.name,
				target: definition,
				...(mapped.session.thinkingLevel !== undefined
					? { thinkingLevel: mapped.session.thinkingLevel }
					: {}),
			}),
		);
		assertActive(entry, run);
	}
	for (const [from, agent] of agents) {
		const transfers = (handoffTargets(handoffs.graph, from) ?? []).map((to) => {
			const target = agents.get(to);
			if (!target) throw new Error(`Handoff target "${to}" is unavailable`);
			return handoff(target, {
				inputType: handoffReason,
				onHandoff: (_context, input) => {
					assertHandoffAuthority(entry, run, from, to);
					run.pendingTransfer = { from, to, reason: input?.reason ?? "" };
				},
			});
		});
		const names = new Set(agent.tools.map((candidate) => candidate.name));
		for (const { toolName } of transfers) {
			if (names.has(toolName))
				throw new Error(`Handoff tool "${toolName}" of "${agent.name}" collides with another tool`);
			names.add(toolName);
		}
		agent.handoffs = transfers;
		agent.on("agent_start", () => commitHandoffOwner(entry, run, from));
	}
	const start = agents.get(handoffs.activeNode);
	if (!start) throw new Error("The accepted conversation owner is not in the Handoff graph");
	return { root: agents.get(HANDOFF_ROOT) ?? start, start };
}

function commitReviewOutput(
	entry: Entry,
	run: ActiveRun,
	output: PlanReviewOutput,
	messageId: string,
): void {
	assertActive(entry, run);
	if (entry.flush) clearTimeout(entry.flush);
	delete entry.flush;
	entry.store.update((record) => {
		assertActive(entry, run);
		const message = record.messages.find((message) => message.id === messageId);
		if (message?.role !== "assistant" || !record.childRun || record.childRun.purpose !== "review")
			throw new Error("Missing final Plan review message");
		message.planReview = structuredClone(output);
		message.stopReason = "stop";
		record.childRun.reviewOutput = { runId: run.id, messageId };
		record.eventSeq += 1;
	});
	assertActive(entry, run);
	const message = entry.store.record.messages.find((message) => message.id === messageId);
	if (message?.role !== "assistant") throw new Error("Missing committed Plan review message");
	publishEvent(entry, { type: "message_end", message });
	assertActive(entry, run);
}

function createSandboxMemory(entry: Entry, run: ActiveRun, model: WireModel): SandboxMemory {
	const active = () => assertActive(entry, run);
	const session = () => {
		if (!run.sandbox) throw new Error("The Sandbox session has not started");
		return run.sandbox;
	};
	return new SandboxMemory(createConfiguredModel(model, entry.store.record.sessionId), {
		session,
		assertActive: active,
		canGenerate: () => run.state?.toJSON().currentStep?.type === "next_step_final_output",
		signal: () => run.controller.signal,
		workspaceTools: (signal) =>
			workspaceTools(
				{
					workspaceId: entry.store.record.workspaceId,
					cwd: entry.store.record.cwd,
					signal,
					assertActive: active,
				},
				session,
			).filter((candidate) => candidate.name !== "search"),
		approve: async (call, signal) => {
			signal.throwIfAborted();
			const approval = waitForApproval(entry, run, undefined, call);
			const cancel = () => run.approval?.reject(new Error("Memory approval cancelled"));
			signal.addEventListener("abort", cancel, { once: true });
			try {
				return await approval;
			} finally {
				signal.removeEventListener("abort", cancel);
				if (run.approval?.generation && run.approval.request.toolCallId === call.callId) {
					delete run.approval;
					entry.store.update((record) => {
						delete record.pendingApproval;
						record.state.needsInput = null;
					});
					notifyState(entry);
				}
			}
		},
		trackTools: (agent) => {
			trackWorkspaceTools(entry, run, agent, active);
			if (run.guardrails) attachToolGuardrails(agent.tools, run, run.guardrails);
		},
	});
}

async function executeRun(
	entry: Entry,
	run: ActiveRun,
	input: AgentInputItem[],
	recovery?: string,
): Promise<void> {
	let terminal: AgentSettlement = { stopReason: "stop" };
	let streamFailed = false;
	let sandboxWorktree: string | undefined;
	try {
		assertActive(entry, run);
		if (
			entry.store.record.childRun?.purpose === "review" &&
			entry.store.record.childRun.outputContract !== REVIEW_OUTPUT_CONTRACT
		)
			throw new Error("Unsupported Plan review output contract; start a new review");
		const selected = entry.store.record.model;
		const model = selected
			? (await listAvailableModels()).find(
					(candidate) => candidate.id === selected.id && candidate.provider === selected.provider,
				)
			: undefined;
		if (!model) throw new Error("Configure a Responses-compatible model before sending a message");
		assertActive(entry, run);
		if (
			entry.store.record.sandbox &&
			entry.store.record.sandboxMemory &&
			!entry.store.record.handoffs
		)
			run.memory = createSandboxMemory(entry, run, model);
		const buildAgent = () => buildSessionGraph(entry, run, model);
		let graph = await buildAgent();
		configureLocalSdkTracing();
		const runnerConfig: Partial<RunConfig> = {
			...traceRunOptions(diagnosticIdentity(entry, run.id)),
			toolExecution: { preApprovalInputGuardrails: true },
			callModelInputFilter: ({ modelData, agent }) => {
				assertActive(entry, run);
				if (run.memory?.owns(agent)) return modelData;
				assertOwnerAgent(entry, agent);
				if (entry.store.record.runCheckpoint && !entry.store.record.pendingApproval)
					entry.store.update((record) => {
						delete record.runCheckpoint;
					});
				return { ...modelData, input: modelHistoryView(entry, run, agent, modelData.input) };
			},
		};
		const runner = run.memory
			? new SandboxMemoryRunner(runnerConfig, run.memory)
			: new Runner(runnerConfig);
		run.diagnostics = attachRunDiagnostics(
			runner,
			diagnosticIdentity(entry, run.id),
			run.guardrails?.redact ?? runGuardrails(entry).redact,
		);
		let next: AgentInputItem[] | RunState<SessionContext, SessionAgent> = recovery
			? await RunState.fromString(graph.root, recovery)
			: input;
		if (recovery && next instanceof RunState) {
			assertWorkspaceContext(next.toJSON().context.context, entry);
			assertOwnerAgent(entry, next.currentAgent);
			run.state = next;
			const pendingIds = new Set(next.pendingInput.map((item) => item.id));
			if (
				entry.store.record.queue.some(
					(input) => input.state === "staged" && !pendingIds.has(input.id),
				)
			)
				entry.store.update((record) => {
					for (const input of record.queue)
						if (input.state === "staged" && !pendingIds.has(input.id)) input.state = "pending";
				});
			stageSteering(entry);
			for (const interruption of next.getInterruptions()) {
				if (interruption.rawItem.type !== "function_call")
					throw new Error("Unsupported approval type");
				if (
					interactiveTools(
						(name) => !run.enabledExtensions.some((extension) => extension.name === name),
					).has(interruption.rawItem.name)
				) {
					await waitForToolResponse(
						entry,
						run,
						next,
						interruption.rawItem,
						agentNodes.get(interruption.agent),
					);
					assertActive(entry, run);
					next.approve(interruption);
					continue;
				}
				const saved = entry.store.record.pendingApproval;
				const callId = interruption.rawItem.callId;
				if (!saved) {
					const decision = Object.values(entry.store.record.decisions).find(
						(d) => d.runId === run.id && d.toolCallId === callId,
					);
					if (!decision) throw new Error("No saved decision for checkpoint");
					if (decision.agentNode !== agentNodes.get(interruption.agent))
						throw new Error("The saved decision belongs to another agent");
					if (
						decision.policyFingerprint &&
						decision.policyFingerprint !==
							sessionMcpApproval(entry.store.record.sessionId, interruption.rawItem.name)
								?.fingerprint
					)
						throw new Error("MCP approval configuration changed");
					if (decision.value) next.approve(interruption);
					else next.reject(interruption);
				} else {
					const approved = await waitForApproval(
						entry,
						run,
						next,
						interruption.rawItem,
						agentNodes.get(interruption.agent),
					);
					assertActive(entry, run);
					if (approved) next.approve(interruption);
					else next.reject(interruption);
				}
			}
		}
		run.markReady?.();
		if (entry.store.record.sandbox) {
			assertActive(entry, run);
			if (process.platform !== "darwin" && process.platform !== "linux")
				throw new Error("The Unix-local Sandbox requires macOS or Linux and trusted Python 3");
			const cwd = await realpath(entry.store.record.cwd);
			sandboxWorktree = cwd;
			assertActive(entry, run);
			if (cwd.trimEnd() !== cwd)
				throw new Error(
					"Sandbox cannot use a worktree path ending in whitespace because the SDK trims it",
				);
			// The SDK resolves its virtual root before looking for a host path grant.
			const defaultRoot = "/workspace";
			run.sandbox = await new UnixLocalSandboxClient({
				archiveLimits: sandboxArchiveLimits,
			}).create(
				new Manifest({
					root:
						cwd === defaultRoot || cwd.startsWith(`${defaultRoot}/`)
							? "/raildesign-workspace"
							: defaultRoot,
					extraPathGrants: [{ path: cwd, readOnly: true }],
				}),
			);
			const archive = entry.store.record.sandboxArchive;
			if (run.memory && archive) {
				assertActive(entry, run);
				if (
					archive.sessionId !== entry.store.record.sessionId ||
					archive.workspaceId !== entry.store.record.workspaceId ||
					archive.cwd !== cwd
				)
					throw new Error("Sandbox archive belongs to a different session or worktree");
				await run.sandbox.hydrateWorkspace(Buffer.from(archive.data, "base64"));
				assertActive(entry, run);
			}
		}
		while (true) {
			assertActive(entry, run);
			const stream = await run.diagnostics.run(() =>
				startStream(runner, graph.start, next, entry.store, run.controller.signal, run.sandbox),
			);
			run.state = stream.state;
			stageSteering(entry);
			const completed = stream.completed.catch(() => undefined);
			try {
				for await (const event of stream) {
					projectStream(entry, run, event);
					stageSteering(entry);
				}
			} catch (error) {
				if (run.granted && !run.controller.signal.aborted) streamFailed = true;
				run.granted = false;
				run.controller.abort();
				throw error;
			} finally {
				await completed;
				if (entry.store.record.childRun?.purpose === "review") {
					const response = stream.rawResponses.at(-1);
					const message = response?.output.findLast(
						(item) => item.type === "message" && item.role === "assistant",
					);
					if (
						!response?.responseId ||
						response.responseId !== run.finalAssistant?.responseId ||
						response.output.some((item) => item.type !== "message" && item.type !== "reasoning") ||
						message?.type !== "message" ||
						message.role !== "assistant" ||
						message.id !== run.finalAssistant?.providerId ||
						!message.content.some(
							(part) =>
								(part.type === "output_text" && part.text.length > 0) || part.type === "refusal",
						)
					)
						delete run.finalAssistant;
				}
				const lastUsage = stream.state.usage.requestUsageEntries?.at(-1);
				entry.store.record.modelContextTokens =
					lastUsage?.totalTokens ??
					(stream.state.usage.requests === 1 ? stream.state.usage.totalTokens : 0);
				run.usage = {
					inputTokens: stream.state.usage.inputTokens,
					outputTokens: stream.state.usage.outputTokens,
					totalTokens: stream.state.usage.totalTokens,
					cacheRead: stream.state.usage.inputTokensDetails.reduce(
						(sum, detail) =>
							sum + (typeof detail.cached_tokens === "number" ? detail.cached_tokens : 0),
						0,
					),
					cacheWrite: stream.state.usage.inputTokensDetails.reduce(
						(sum, detail) =>
							sum + (typeof detail.cache_write_tokens === "number" ? detail.cache_write_tokens : 0),
						0,
					),
				};
			}
			await stream.completed;

			if (run.controller.signal.aborted || stream.cancelled) throw new Error("Run cancelled");
			if (stream.error) throw stream.error;
			if (stream.interruptions.length === 0) {
				if (entry.store.record.childRun?.purpose === "review") {
					assertActive(entry, run);
					const response = stream.rawResponses.at(-1);
					assertCompletedPlanReviewResponse(response, run.reviewResponse);
					const finalMessage = response?.output.findLast(
						(item) => item.type === "message" && item.role === "assistant",
					);
					if (
						!run.finalAssistant?.messageId ||
						!finalMessage?.id ||
						run.finalAssistant.providerId !== finalMessage.id
					)
						throw new Error("The final Plan review message is not bound");
					const output = stream.finalOutput;
					if (!isPlanReviewOutput(output)) throw new Error("Invalid Plan review output");
					commitReviewOutput(entry, run, output, run.finalAssistant.messageId);
				}
				break;
			}
			for (const interruption of stream.interruptions) {
				if (interruption.rawItem.type !== "function_call")
					throw new Error("Unsupported approval type");
				if (
					interactiveTools(
						(name) => !run.enabledExtensions.some((extension) => extension.name === name),
					).has(interruption.rawItem.name)
				) {
					await waitForToolResponse(
						entry,
						run,
						stream.state,
						interruption.rawItem,
						agentNodes.get(interruption.agent),
					);
					assertActive(entry, run);
					stream.state.approve(interruption);
					continue;
				}
				const approved = await waitForApproval(
					entry,
					run,
					stream.state,
					interruption.rawItem,
					agentNodes.get(interruption.agent),
				);
				assertActive(entry, run);
				if (approved) stream.state.approve(interruption);
				else {
					const call = run.toolCalls.get(interruption.rawItem.callId);
					if (call) call.failed = true;
					stream.state.reject(interruption);
				}
			}
			const checkpoint = stream.state.toString();
			entry.store.update((record) => {
				record.runCheckpoint = {
					runId: run.id,
					checkpoint,
					granted: run.granted,
					enabledExtensions: run.enabledExtensions,
				};
			});
			run.controller.abort();
			run.controller = new AbortController();
			graph = await buildAgent();
			next = await RunState.fromString(graph.root, checkpoint);
			assertWorkspaceContext(next.toJSON().context.context, entry);
			assertOwnerAgent(entry, next.currentAgent);
			run.state = next;
		}
		if (run.sandbox) {
			const { sessionId, workspaceId, cwd, revision } = entry.store.record;
			const archive = run.memory?.completed ? await run.sandbox.persistWorkspace() : undefined;
			const close = run.sandbox.close();
			delete run.sandbox;
			await close;
			assertActive(entry, run);
			if (archive) {
				if (!sandboxWorktree || (await realpath(cwd)) !== sandboxWorktree)
					throw new Error("The Sandbox worktree changed during memory generation");
				assertActive(entry, run);
				if (archive.byteLength > SANDBOX_ARCHIVE_BYTES)
					throw new Error("Sandbox archive exceeds its size limit");
				const snapshot = {
					sessionId,
					workspaceId,
					cwd: sandboxWorktree,
					data: Buffer.from(archive).toString("base64"),
				};
				entry.store.update((record) => {
					record.sandboxArchive = snapshot;
				}, revision);
			}
			if (run.memory?.failed) notifyExtUi(sessionId, "Sandbox memory was not updated.", "warning");
		}
	} catch (error) {
		run.markReady?.();
		if (run.sandbox) {
			const close = run.sandbox.close();
			delete run.sandbox;
			await close.catch((cleanupError: unknown) => {
				log.warn("Could not close the Unix-local Sandbox", cleanupError);
			});
		}
		if (run.suspended) return;
		const tripwire = error instanceof InputGuardrailTripwireTriggered ? error : undefined;
		const aborted = !streamFailed && (!run.granted || run.controller.signal.aborted);
		const rule = run.blocked?.rule ?? (aborted ? undefined : tripwire?.result.guardrail.name);
		terminal = rule
			? { stopReason: "guardrail", guardrail: rule }
			: {
					stopReason: aborted
						? "aborted"
						: error instanceof MaxTurnsExceededError
							? "length"
							: "error",
					...(aborted
						? {}
						: { errorMessage: error instanceof Error ? error.message : String(error) }),
				};
		const failedId =
			run.assistantId ??
			(entry.store.record.childRun?.purpose === "review"
				? run.finalAssistant?.messageId
				: undefined);
		const partial = failedId
			? entry.store.record.messages.find((message) => message.id === failedId)
			: undefined;
		if (entry.store.record.childRun?.reviewOutput?.runId === run.id)
			entry.store.update((record) => {
				if (record.childRun) delete record.childRun.reviewOutput;
			});
		if (
			terminal.stopReason !== "aborted" ||
			partial?.role === "assistant" ||
			entry.store.record.childRun?.purpose === "review"
		) {
			const messageId = failedId ?? randomUUID();
			const message = assistant(
				entry,
				messageId,
				partial?.role === "assistant" ? partial.content : [],
				terminal.stopReason,
				partial?.role === "assistant"
					? partial.agent
					: entry.store.record.handoffs && agentName(entry.store.record.handoffs.activeNode),
			);
			if (terminal.errorMessage) message.errorMessage = terminal.errorMessage;
			if (terminal.guardrail) message.guardrail = terminal.guardrail;
			if (entry.store.record.childRun?.purpose === "review") run.assistantId = messageId;
			appendMessage(entry, message);
			emit(entry, { type: "message_end", message });
		}
	} finally {
		try {
			if (!run.suspended) {
				for (const [callId, call] of run.toolCalls) {
					if (
						entry.store.record.messages.some(
							(message) => message.role === "toolResult" && message.toolCallId === callId,
						)
					)
						continue;
					const output = run.startedTools.has(callId)
						? "Operation interrupted; its result is unknown. Inspect the worktree before retrying."
						: "Operation was not executed because its approval or run was cancelled.";
					recordToolResult(entry, callId, call.name, output, true, false);
					if (
						!entry.store.record.history.some(
							(item) => item.type === "function_call_result" && item.callId === callId,
						)
					)
						await entry.store.addItems([
							{
								type: "function_call_result",
								callId,
								name: call.name,
								status: "incomplete",
								output,
							},
						]);
				}
				const lastAssistant =
					entry.store.record.childRun?.purpose === "review"
						? entry.store.record.messages.find(
								(message) => message.id === (run.assistantId ?? run.finalAssistant?.messageId),
							)
						: entry.store.record.messages.findLast((message) => message.role === "assistant");
				if (lastAssistant?.role === "assistant" && run.usage) {
					lastAssistant.usage.input = run.usage.inputTokens;
					lastAssistant.usage.output = run.usage.outputTokens;
					lastAssistant.usage.totalTokens = run.usage.totalTokens;
					lastAssistant.usage.cacheRead = run.usage.cacheRead;
					lastAssistant.usage.cacheWrite = run.usage.cacheWrite;
					emit(entry, { type: "message_end", message: lastAssistant });
				}
				run.granted = false;
				const interactionId =
					run.approval?.request.id ?? entry.store.record.state.needsInput?.interactionId;
				if (interactionId) {
					publishDialog({
						id: interactionId,
						sessionId: entry.store.record.sessionId,
						kind: "dismiss",
					});
					delete run.approval;
				}
				entry.store.record.state.execution = "idle";
				entry.store.record.state.needsInput = null;
				entry.store.record.state.completion =
					terminal.stopReason === "aborted"
						? { completionId: run.id, outcome: "cancelled" }
						: terminal.stopReason === "error" ||
								terminal.stopReason === "length" ||
								terminal.stopReason === "guardrail"
							? { completionId: run.id, outcome: "failed", failure: terminal.stopReason }
							: { completionId: run.id, outcome: "succeeded" };
				entry.store.record.state.completionUnread = terminal.stopReason !== "aborted";
				delete entry.store.record.pendingApproval;
				delete entry.store.record.pendingToolResponse;
				delete run.toolResponse;
				delete entry.store.record.runCheckpoint;
				for (const queued of entry.store.record.queue) {
					queued.state = "pending";
					if (terminal.errorMessage) queued.error = terminal.errorMessage;
				}
				emit(entry, { type: "agent_end", messages: entry.store.record.messages, willRetry: false });
				emit(entry, { type: "agent_settled", terminal });
				if (entry.store.record.childRun)
					finishChild(
						entry,
						terminal.stopReason === "stop"
							? "completed"
							: terminal.stopReason === "aborted"
								? "aborted"
								: "error",
					);
			}
		} finally {
			await run.diagnostics?.close(
				run.suspended
					? "suspended"
					: terminal.stopReason === "stop" || terminal.stopReason === "toolUse"
						? "success"
						: terminal.stopReason === "aborted"
							? "cancel"
							: terminal.stopReason,
			);
			run.granted = false;
			run.controller.abort();
			delete entry.active;
			delete entry.store.historyGuardrails;
			notifyState(entry);
		}
	}
	if (terminal.stopReason === "stop" && !entry.stopping) {
		try {
			await compactSession(entry.store.record.sessionId, { force: false });
		} catch (error) {
			log.warn("Automatic summary kept the prior history", error);
		}
		flushChildCompletions(entry);
		for (const owner of commandOwners(entry)) owner.commands?.flushCompletions({ atTurnEnd: true });
		await drainQueue(entry);
	}
}

function userItem(
	input: Pick<StoredInput, "id" | "text" | "images">,
): Extract<AgentInputItem, { role: "user" }> {
	return {
		id: input.id,
		role: "user",
		content: input.images?.length
			? [
					{ type: "input_text", text: input.text },
					...input.images.map((image) => ({
						type: "input_image" as const,
						image: `data:${image.mimeType};base64,${image.data}`,
					})),
				]
			: input.text,
	};
}
function queuedContent(input: StoredInput) {
	return {
		id: input.id,
		text: input.text,
		state: input.state,
		...(input.images?.length ? { images: structuredClone(input.images) } : {}),
		...(input.error ? { error: input.error } : {}),
	};
}
function queueOf(record: SessionRecord): SessionQueueContent {
	const queue = record.queue;
	return {
		steering: queue.filter((input) => input.kind === "steering").map(queuedContent),
		followUp: queue
			.filter((input) => input.kind === "followUp" && !input.internal)
			.map(queuedContent),
	};
}
export function getQueuedMessageContent(sessionId: string): SessionQueueContent {
	return queueOf(mustGet(sessionId).store.record);
}

function queueStateOf(record: SessionRecord): SessionQueueState {
	const project = (input: StoredInput) => ({
		id: input.id,
		text: input.text,
		state: input.state,
		...(input.error ? { error: input.error } : {}),
	});
	return {
		steering: record.queue.filter((input) => input.kind === "steering").map(project),
		followUp: record.queue
			.filter((input) => input.kind === "followUp" && !input.internal)
			.map(project),
		...(record.queue.some((input) => input.images?.length) ? { hasImages: true as const } : {}),
	};
}
export function queuedMessages(sessionId: string): SessionQueueState {
	return queueStateOf(mustGet(sessionId).store.record);
}

function publishQueue(entry: Entry): void {
	entry.store.record.state.queuedCount = entry.store.record.queue.filter(
		(input) => !input.internal,
	).length;
	emit(entry, { type: "queue_update", ...queuedMessages(entry.store.record.sessionId) });
	notifyState(entry);
}
function observeStore(entry: Entry): void {
	entry.store.onUpdate = (previous) => {
		if (JSON.stringify(previous.queue) === JSON.stringify(entry.store.record.queue)) return;
		const admitted = previous.queue.filter(
			(input) =>
				!entry.store.record.queue.some((current) => current.id === input.id) &&
				entry.store.record.history.some((item) => item.id === input.id),
		);
		for (const input of admitted) {
			const message = entry.store.record.messages.find((item) => item.id === input.id);
			if (!message || previous.messages.some((item) => item.id === input.id)) continue;
			emit(entry, { type: "message_end", message });
		}
		publishQueue(entry);
	};
}
function stageSteering(entry: Entry): void {
	const run = entry.active;
	if (!run?.state || !run.granted || run.controller.signal.aborted || entry.stopping) return;
	if (run.approval?.generation) return;
	const waiting = entry.store.record.queue.filter(
		(input) => input.kind === "steering" && input.state === "pending",
	);
	if (!waiting.length) return;
	const previous = run.state.pendingInput;
	try {
		run.state.addInput(waiting.map(userItem));
		entry.store.update((record) => {
			for (const input of record.queue)
				if (waiting.some((item) => item.id === input.id)) {
					input.state = "staged";
					delete input.error;
				}
			if (record.runCheckpoint)
				record.runCheckpoint = {
					runId: run.id,
					checkpoint: run.state?.toString() ?? record.runCheckpoint.checkpoint,
					granted: run.granted,
					enabledExtensions: run.enabledExtensions,
				};
			if (record.pendingToolResponse) {
				record.pendingToolResponse.checkpoint =
					run.state?.toString() ?? record.pendingToolResponse.checkpoint;
				record.runCheckpoint = {
					runId: run.id,
					checkpoint: record.pendingToolResponse.checkpoint,
					granted: run.granted,
					enabledExtensions: run.enabledExtensions,
				};
			}
			if (record.pendingApproval) {
				record.pendingApproval.checkpoint =
					run.state?.toString() ?? record.pendingApproval.checkpoint;
				record.runCheckpoint = {
					runId: run.id,
					checkpoint: record.pendingApproval.checkpoint,
					granted: run.granted,
					enabledExtensions: run.enabledExtensions,
				};
			}
		});
	} catch (error) {
		run.state.clearPendingInput();
		if (previous.length) run.state.addInput(previous);
		const message = error instanceof Error ? error.message : String(error);
		if (waiting.some((input) => input.error !== message))
			entry.store.update((record) => {
				for (const input of record.queue)
					if (waiting.some((item) => item.id === input.id)) input.error = message;
			});
	}
}
function assertAdditionalInputAllowed(entry: Entry): void {
	if (entry.store.record.childRun?.purpose === "review")
		throw new Error("Plan review children are read-only; start a new review");
}
function enqueue(
	sessionId: string,
	kind: QueueLane,
	text: string,
	images?: readonly ImageContent[],
	messageId: string = randomUUID(),
	internal = false,
): void {
	const entry = mustGet(sessionId);
	assertAdditionalInputAllowed(entry);
	if (
		closingSessions.has(sessionId) ||
		deletingSessions.has(sessionId) ||
		closingWorkspaces.has(entry.store.record.workspaceId)
	)
		throw new Error("Session is closing");
	if (typeof text !== "string" || (!text.trim() && !images?.length))
		throw new Error("Message is empty");
	if (!/^[A-Za-z0-9_-]{1,200}$/.test(messageId)) throw new Error("Invalid input ID");
	if (images?.length && !entry.store.record.model?.input?.includes("image"))
		throw new Error("The selected model does not accept images");
	const internalItem = userItem({ id: messageId, text, images });
	const existing = entry.store.record.queue.find((input) => input.id === messageId);
	if (existing) {
		if (
			existing.kind !== kind ||
			existing.text !== text ||
			JSON.stringify(existing.images ?? []) !== JSON.stringify(images ?? [])
		)
			throw new Error("Conflicting input ID");
		return;
	}
	const previous = entry.store.record.messages.find((item) => item.id === messageId);
	if (previous) {
		if (
			previous.role !== "user" ||
			JSON.stringify(previous.content) !==
				JSON.stringify(images?.length ? [{ type: "text", text }, ...images] : text)
		)
			throw new Error("Conflicting input ID");
		return;
	}
	if (internal && Object.hasOwn(entry.store.record.inputItems, messageId)) {
		const admitted = entry.store.record.inputItems[messageId];
		if (
			!admitted ||
			!("role" in admitted) ||
			admitted.role !== "user" ||
			!isDeepStrictEqual(admitted, internalItem)
		)
			throw new Error("Conflicting input ID");
		return;
	}
	const pendingToolResponse = kind === "steering" ? entry.active?.toolResponse : undefined;
	entry.store.update((record) => {
		if (pendingToolResponse && entry.active) {
			record.toolResponses[pendingToolResponse.request.id] = {
				runId: entry.active.id,
				toolCallId: pendingToolResponse.request.toolCallId,
				revision: pendingToolResponse.request.revision,
				response: { kind: "superseded", inputId: messageId },
			};
			delete record.pendingToolResponse;
			record.state.needsInput = null;
		}
		record.queue.push({
			id: messageId,
			text,
			...(images?.length ? { images: structuredClone([...images]) } : {}),
			kind,
			state: "pending",
			...(internal ? { internal: true } : {}),
		});
		if (internal)
			record.inputItems = {
				...record.inputItems,
				[messageId]: internalItem,
			};
	});
	if (kind === "steering") stageSteering(entry);
	if (pendingToolResponse && entry.active) {
		delete entry.active.toolResponse;
		pendingToolResponse.resolve();
	}
	if (!entry.active && !entry.stopping)
		void drainQueue(entry).catch((error) => log.error("Could not start queued input", error));
}
export function steerSession(
	sessionId: string,
	text: string,
	images?: readonly ImageContent[],
	messageId?: string,
): void {
	enqueue(sessionId, "steering", text, images, messageId);
}
export function followUpSession(
	sessionId: string,
	text: string,
	images?: readonly ImageContent[],
	messageId?: string,
): void {
	enqueue(sessionId, "followUp", text, images, messageId);
}
export function nudgeSession(
	sessionId: string,
	text: string,
	messageId: string,
	images?: readonly ImageContent[],
): { disposition: "needs_input" | "queued" | "prompted" } {
	const entry = mustGet(sessionId);
	assertAdditionalInputAllowed(entry);
	if (!isControlMessage(text)) throw new Error("Nudges must be internal control messages");
	if (visibleState(entry).needsInput) return { disposition: "needs_input" };
	if (entry.stopping) throw new Error("Session is stopping");
	const disposition = entry.active ? "queued" : "prompted";
	enqueue(sessionId, "followUp", text, images, messageId, true);
	return { disposition };
}
export function sendHostMessageToSession(
	sessionId: string,
	customType: string,
	text: string,
	details: ChatHandoffDetails | ContinueInWorkspaceRequestDetails,
): Promise<void> {
	const entry = mustGet(sessionId);
	assertAdditionalInputAllowed(entry);
	if (
		entry.stopping ||
		closingSessions.has(sessionId) ||
		deletingSessions.has(sessionId) ||
		closingWorkspaces.has(entry.store.record.workspaceId)
	)
		throw new Error("Session is closing");
	if (!text.trim() || !/^[A-Za-z0-9_-]{1,150}$/.test(details.operationId))
		throw new Error("Invalid host notification");
	const id = `host-${details.operationId}`;
	const previous = entry.store.record.messages.find((item) => item.id === id);
	if (previous) {
		if (
			previous.role !== "custom" ||
			previous.customType !== customType ||
			!isDeepStrictEqual(previous.content, [{ type: "text", text }]) ||
			!isDeepStrictEqual(previous.details, details)
		)
			throw new Error("Conflicting host notification");
		return Promise.resolve();
	}
	const message: TranscriptMessage = {
		id,
		role: "custom",
		customType,
		content: [{ type: "text", text }],
		details,
		display: true,
		timestamp: Date.now(),
	};
	entry.store.update((record) => {
		record.messages.push(message);
		record.queue.push({
			id: `host-input-${details.operationId}`,
			kind: "followUp",
			state: "pending",
			text,
			internal: true,
		});
	});
	emit(entry, { type: "message_end", message });
	if (!entry.active && !visibleState(entry).needsInput)
		void drainQueue(entry).catch((error) => log.warn("Host notification could not start", error));
	return Promise.resolve();
}
export function isHostMessagePending(
	sessionId: string,
	details: ContinueInWorkspaceRequestDetails,
): boolean {
	return mustGet(sessionId).store.record.queue.some(
		(input) => input.id === `host-input-${details.operationId}`,
	);
}
export function clearSessionQueue(sessionId: string, requireTextOnly = false): SessionQueueContent {
	const entry = mustGet(sessionId);
	const content = getQueuedMessageContent(sessionId);
	if (requireTextOnly && entry.store.record.queue.some((input) => input.images?.length))
		throw new Error("The queue contains images");
	if (entry.store.record.queue.some((input) => input.state === "staged"))
		throw new Error("Staged input cannot be withdrawn before settlement");
	entry.store.update((record) => {
		record.queue = record.queue.filter((input) => input.internal);
	});
	return content;
}
export function removeQueuedMessage(sessionId: string, messageId: string): RemovedQueuedMessage {
	const entry = mustGet(sessionId);
	const input = entry.store.record.queue.find((item) => item.id === messageId);
	if (input?.state === "staged")
		throw new Error("Staged input cannot be withdrawn before settlement");
	if (input)
		entry.store.update((record) => {
			record.queue = record.queue.filter((item) => item.id !== messageId);
		});
	return { removed: input ? queuedContent(input) : null, queue: queuedMessages(sessionId) };
}
export function updateQueuedMessage(
	sessionId: string,
	messageId: string,
	text: string,
	images?: readonly ImageContent[],
): void {
	const entry = mustGet(sessionId);
	assertAdditionalInputAllowed(entry);
	const input = entry.store.record.queue.find((item) => item.id === messageId);
	if (!input || input.state === "staged")
		throw new Error("Queued input is unavailable for editing");
	if (!text.trim() && !images?.length) throw new Error("Message is empty");
	if (images?.length && !entry.store.record.model?.input?.includes("image"))
		throw new Error("The selected model does not accept images");
	entry.store.update((record) => {
		const current = record.queue.find((item) => item.id === messageId);
		if (current) {
			current.text = text;
			if (images?.length) current.images = structuredClone([...images]);
			else delete current.images;
			delete current.error;
		}
	});
}
async function drainQueue(entry: Entry, steeringOnly = false): Promise<void> {
	if (
		entry.active ||
		entry.stopping ||
		closingSessions.has(entry.store.record.sessionId) ||
		deletingSessions.has(entry.store.record.sessionId)
	)
		return;
	const next =
		entry.store.record.queue.find((input) => input.kind === "steering") ??
		(steeringOnly ? undefined : entry.store.record.queue[0]);
	if (!next) return;
	try {
		await promptSession(entry.store.record.sessionId, next.text, next.images, next.id);
	} catch (error) {
		entry.store.update((record) => {
			const current = record.queue.find((input) => input.id === next.id);
			if (current) {
				current.state = "pending";
				current.error = error instanceof Error ? error.message : String(error);
			}
		});
		throw error;
	}
}
export async function sendSteeringNow(sessionId: string): Promise<void> {
	const entry = mustGet(sessionId);
	assertAdditionalInputAllowed(entry);
	if (entry.active) {
		stageSteering(entry);
		return;
	}
	await drainQueue(entry, true);
}
export async function compactSession(
	sessionId: string,
	options: {
		operationId?: string | undefined;
		instructions?: string | undefined;
		force?: boolean | undefined;
	} = {},
): Promise<void> {
	const entry = mustGet(sessionId);
	const thresholdPercent = loadConfig().autoSummaryThresholdPercent;
	if (
		entry.active ||
		entry.store.record.pendingApproval ||
		entry.store.record.pendingToolResponse ||
		entry.store.record.runCheckpoint ||
		entry.stopping
	)
		throw new Error("Wait for the run to settle before summarizing");
	if (entry.summaryController) throw new Error("A summary is already running");
	const selected = entry.store.record.model;
	if (!selected) throw new Error("Configure a model before summarizing");
	const controller = new AbortController();
	entry.summaryController = controller;
	let finishSummary: () => void = () => {};
	entry.summaryDone = new Promise((resolve) => {
		finishSummary = resolve;
	});
	let summaryDiagnostics: ReturnType<typeof attachRunDiagnostics> | undefined;
	let summaryOutcome: DiagnosticOutcome = "success";
	try {
		const operationId = options.operationId ?? randomUUID();
		const guard = runGuardrails(entry);
		const summaryUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const result = await entry.store.compact({
			operationId,
			usage: summaryUsage,
			tokensBefore: entry.store.record.modelContextTokens ?? 0,
			force: options.force ?? true,
			instructions: options.instructions,
			tokenBudget: modelContextBudget(selected),
			thresholdPercent,
			signal: controller.signal,
			summarize: async (prefix, signal) => {
				const agent = new Agent({
					name: "RailDesign summary",
					model: createConfiguredModel(selected, sessionId),
					instructions:
						"Summarize the older conversation for continuation. Preserve user requirements, decisions, file paths, exact facts, tool outcomes and unfinished work. Do not invent facts. Return only the summary.",
					modelSettings: { ...responsesClientSettings, maxTokens: modelOutputBudget(selected) },
				});
				configureLocalSdkTracing();
				const runner = new Runner({
					...traceRunOptions(diagnosticIdentity(entry, operationId)),
				});
				summaryDiagnostics = attachRunDiagnostics(
					runner,
					diagnosticIdentity(entry, operationId),
					guard.redact,
				);
				const response = await summaryDiagnostics.run(() =>
					runner.run(
						agent,
						[
							{
								role: "user",
								content: `${options.instructions ?? ""}\nConversation:\n${JSON.stringify(prefix)}`,
							},
						],
						{ signal, maxTurns: 1 },
					),
				);
				summaryUsage.input = response.state.usage.inputTokens;
				summaryUsage.output = response.state.usage.outputTokens;
				summaryUsage.total = response.state.usage.totalTokens;
				summaryUsage.cacheRead = response.state.usage.inputTokensDetails.reduce(
					(sum, detail) =>
						sum + (typeof detail.cached_tokens === "number" ? detail.cached_tokens : 0),
					0,
				);
				summaryUsage.cacheWrite = response.state.usage.inputTokensDetails.reduce(
					(sum, detail) =>
						sum + (typeof detail.cache_write_tokens === "number" ? detail.cache_write_tokens : 0),
					0,
				);
				const summary = response.finalOutput ?? "";
				const hit = guard.output.match(summary);
				if (hit) throw new GuardrailOutputBlockedError(hit.rule);
				return summary;
			},
		});
		if (result.status === "compacted") {
			const message = entry.store.record.messages.find(
				(item) => item.id === `summary:${operationId}`,
			);
			if (message) emit(entry, { type: "message_end", message });
		}
	} catch (error) {
		summaryOutcome = diagnosticFailure(error, controller.signal);
		throw error;
	} finally {
		await summaryDiagnostics?.close(summaryOutcome);
		finishSummary();
		if (entry.summaryController === controller) {
			delete entry.summaryController;
			delete entry.summaryDone;
		}
	}
}

export interface CreateSessionInput {
	cwd: string;
	workspaceId: string;
	model?: WireModel;
	thinkingLevel?: ThinkingLevel;
	modelOptional?: boolean;
	childRun?: ChildRunRecord;
}
export interface CreateSessionResult {
	sessionId: string;
	model: WireModel | null;
	thinkingLevel: ThinkingLevel;
}
export async function createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
	const workspace = loadWorkspaces().find((candidate) => candidate.id === input.workspaceId);
	if (!workspace || resolve(workspace.worktreePath) !== resolve(input.cwd))
		throw new Error("Session must use its assigned worktree");
	if (closingWorkspaces.has(input.workspaceId)) throw new Error("Workspace is closing");
	const available = await listAvailableModels();
	if (closingWorkspaces.has(input.workspaceId)) throw new Error("Workspace is closing");
	const requested = input.model;
	const model = requested
		? available.find((item) => item.provider === requested.provider && item.id === requested.id)
		: available[0];
	if (requested && !model && !input.modelOptional) throw new Error("Unknown model");
	const graph = input.childRun
		? undefined
		: loadHandoffGraph({
				cwd: resolve(input.cwd),
				agentDir: dataDir(),
				projectTrusted: projectResourcesTrusted(input.workspaceId),
			});
	const sessionId = randomUUID();
	const entry: Entry = {
		store: new PersistentSession({
			version: 2,
			...(input.childRun ? { childRun: input.childRun } : {}),
			...(graph ? { handoffs: { graph, activeNode: HANDOFF_ROOT, transfers: [] } } : {}),
			sessionId,
			workspaceId: input.workspaceId,
			cwd: resolve(input.cwd),
			model: model ?? null,
			thinkingLevel: model?.thinkingLevels.includes(input.thinkingLevel ?? "off")
				? (input.thinkingLevel ?? "off")
				: "off",
			sandbox: false,
			eventSeq: 0,
			revision: 0,
			history: [],
			messages: [],
			state: idleState(),
			updatedAt: Date.now(),
			decisions: {},
			toolResponses: {},
			queue: [],
			effects: {},
			historyOperations: {},
			summaryOperations: {},
			retiredInputIds: [],
			inputItems: {},
		}),
	};
	flush(entry);
	sessions.set(sessionId, entry);
	observeStore(entry);
	if (!input.childRun) {
		publishCreated(summaryOf(entry));
		notifyState(entry);
	}
	return {
		sessionId,
		model: entry.store.record.model,
		thinkingLevel: entry.store.record.thinkingLevel,
	};
}
export function promptSession(
	sessionId: string,
	text: string,
	images?: readonly ImageContent[],
	messageId?: string,
): Promise<void> {
	const entry = mustGet(sessionId);
	assertAdditionalInputAllowed(entry);
	return promptEntry(entry, text, images, messageId);
}
function promptEntry(
	entry: Entry,
	text: string,
	images?: readonly ImageContent[],
	messageId?: string,
): Promise<void> {
	const sessionId = entry.store.record.sessionId;
	if (typeof text !== "string") throw new Error("Message must be text");
	if (
		closingSessions.has(sessionId) ||
		deletingSessions.has(sessionId) ||
		closingWorkspaces.has(entry.store.record.workspaceId)
	)
		throw new Error("Session is closing");
	if (messageId) {
		const previous = entry.store.record.messages.find((item) => item.id === messageId);
		if (previous) {
			if (
				previous.role !== "user" ||
				JSON.stringify(previous.content) !==
					JSON.stringify(images?.length ? [{ type: "text", text }, ...images] : text)
			)
				throw new Error("Conflicting input ID");
			if (entry.active?.inputId === messageId) return entry.active.done;
			if (!entry.store.record.queue.some((item) => item.id === messageId)) return Promise.resolve();
		}
	}
	if (entry.active) throw new Error("A run is already active in this session");
	entry.summaryController?.abort();
	if (entry.stopping) throw new Error("Session is stopping");
	if (!text.trim() && !images?.length) throw new Error("Message is empty");
	if (images?.length && !entry.store.record.model?.input?.includes("image"))
		throw new Error("The selected model does not accept images");
	const id = messageId ?? randomUUID();
	if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error("Invalid input ID");
	const run: ActiveRun = {
		id: randomUUID(),
		inputId: id,
		enabledExtensions:
			entry.store.record.childRun?.enabledExtensions ??
			snapshotSdkExtensions(loadConfig().disabledExtensions, loadConfig().extensionSettings),
		controller: new AbortController(),
		granted: true,
		done: Promise.resolve(),
		toolCalls: new Map(),
		startedTools: new Set(),
	};
	let modelText: string;
	entry.active = run;
	try {
		modelText = entry.store.record.childRun
			? text
			: expandSkillCommand(
					{
						cwd: entry.store.record.cwd,
						admission: () =>
							admissionContextFor(
								loadProjects().find(
									(item) => item.id === projectOf(entry.store.record.workspaceId),
								),
								loadWorkspaces().find((item) => item.id === entry.store.record.workspaceId)
									?.skillOverrides ?? {},
								loadConfig().otherAgentSkills,
							),
						assertActive: () => assertActive(entry, run),
						signal: run.controller.signal,
					},
					text,
				);
	} finally {
		delete entry.active;
		delete entry.store.historyGuardrails;
	}
	const content: AgentInputItem[] = [userItem({ id, text, images })];
	if (modelText !== text) content.unshift({ id: randomUUID(), role: "user", content: modelText });
	const message: TranscriptMessage = {
		id,
		role: "user",
		content: images?.length ? [{ type: "text", text }, ...images] : text,
		timestamp: Date.now(),
	};
	const queuedInput = entry.store.record.queue.some((input) => input.id === id);
	const backgroundWork =
		ownedResourceSnapshots(entry).some(resourceIsLive) || !!entry.reviewScopes?.size;
	const firstSeq = entry.store.record.eventSeq + 1;
	entry.store.update((record) => {
		const existing = record.messages.findIndex((item) => item.id === message.id);
		if (!queuedInput) {
			if (existing === -1) record.messages.push(message);
			else record.messages[existing] = message;
		}
		record.state = {
			...idleState(),
			execution: "running",
			runId: run.id,
			queuedCount: record.queue.filter((input) => !input.internal).length,
			backgroundWork,
		};
		record.eventSeq += queuedInput ? 1 : 2;
	});
	entry.active = run;
	publish(
		{ sessionId, runId: run.id, seq: firstSeq, event: { type: "agent_start" } },
		entry.store.record.workspaceId,
	);
	if (!queuedInput)
		publish(
			{
				sessionId,
				runId: run.id,
				seq: firstSeq + 1,
				event: structuredClone(
					projectImages({ type: "message_end", message }, imageOwner(entry)),
				) as SessionEvent,
			},
			entry.store.record.workspaceId,
		);
	notifyState(entry);
	run.done = entry.summaryDone
		? entry.summaryDone.then(() => executeRun(entry, run, content))
		: executeRun(entry, run, content);
	const fix = entry.fixCompletions?.get(id);
	if (fix)
		void run.done.then(
			() => {
				entry.fixCompletions?.delete(id);
				if (entry.store.record.state.completion?.outcome === "succeeded") fix.resolve();
				else fix.reject(new Error("Review fix run did not succeed"));
			},
			(error) => {
				entry.fixCompletions?.delete(id);
				fix.reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	return run.done;
}
function rejectPendingFixes(entry: Entry): void {
	const pending = entry.fixCompletions;
	if (!pending?.size) return;
	entry.store.update((record) => {
		record.queue = record.queue.filter((input) => !pending.has(input.id));
	});
	for (const fix of pending.values()) fix.reject(new Error("Review fix cancelled"));
	pending.clear();
}
export async function abortSession(
	sessionId: string,
	reason: "user" | "interrupted" = "user",
): Promise<void> {
	const entry = mustGet(sessionId);
	const run = entry.active;
	if (run) run.granted = false;
	if (entry.store.record.queue.some((input) => input.internal))
		entry.store.update((record) => {
			record.queue = record.queue.filter((input) => !input.internal);
		});
	entry.summaryController?.abort();
	if (!run) {
		entry.stopping = true;
		rejectPendingFixes(entry);
		try {
			await stopOwnedResources(entry, reason);
			await entry.summaryDone;
		} finally {
			delete entry.stopping;
		}
		return;
	}
	entry.stopping = true;
	rejectPendingFixes(entry);
	run.controller.abort();
	run.approval?.reject(new Error("Run cancelled"));
	run.toolResponse?.reject(new Error("Run cancelled"));
	try {
		await Promise.all([run.done, stopOwnedResources(entry, reason)]);
	} finally {
		delete entry.stopping;
	}
}
export function hasSession(sessionId: string): boolean {
	return sessions.has(sessionId);
}
export function getSessionOwnerId(sessionId: string): string | undefined {
	const entry = sessions.get(sessionId);
	return entry ? imageOwner(entry) : undefined;
}
export function getSessionWorkspaceId(sessionId: string): string | undefined {
	return sessions.get(sessionId)?.store.record.workspaceId;
}
export function liveSessionIdsOf(workspaceId?: string): string[] {
	return [...sessions]
		.filter(
			([, entry]) =>
				!entry.store.record.childRun &&
				(workspaceId === undefined || entry.store.record.workspaceId === workspaceId),
		)
		.map(([sessionId]) => sessionId);
}
export function isSessionStreaming(sessionId: string): boolean {
	return !!sessions.get(sessionId)?.active;
}
export function getSessionState(sessionId: string): SessionState {
	return visibleState(mustGet(sessionId));
}
export async function ensureSessionAttached(
	sessionId: string,
	workspaceId: string,
	cwd: string,
): Promise<boolean> {
	if (
		closingSessions.has(sessionId) ||
		deletingSessions.has(sessionId) ||
		closingWorkspaces.has(workspaceId)
	)
		return false;
	const existing = sessions.get(sessionId);
	if (existing) {
		await existing.active?.ready;
		return (
			existing.store.record.workspaceId === workspaceId &&
			existing.store.record.cwd === resolve(cwd)
		);
	}
	const record = readSessionRecord(sessionId);
	if (!record || record.workspaceId !== workspaceId || record.cwd !== resolve(cwd)) return false;
	const entry: Entry = { store: new PersistentSession(record) };
	sessions.set(sessionId, entry);
	reconcileStoredChildren(entry);
	observeStore(entry);
	const interruptedEffects = Object.entries(record.effects).filter(
		([, effect]) => effect.status !== "completed" && effect.runId === record.state.runId,
	);
	const checkpoint = record.runCheckpoint;
	const unsupportedReview =
		record.childRun?.purpose === "review" &&
		record.childRun.outputContract !== REVIEW_OUTPUT_CONTRACT &&
		(record.state.execution === "running" || record.pendingApproval || record.pendingToolResponse);
	if (
		unsupportedReview ||
		(checkpoint?.granted &&
			interruptedEffects.length === 0 &&
			(record.pendingApproval ||
				record.pendingToolResponse ||
				record.state.execution === "running"))
	) {
		const run: ActiveRun = {
			id: checkpoint?.runId ?? record.state.runId ?? randomUUID(),
			enabledExtensions: checkpoint?.enabledExtensions ?? record.childRun?.enabledExtensions ?? [],
			controller: new AbortController(),
			granted: true,
			done: Promise.resolve(),
			toolCalls: new Map(),
			startedTools: new Set(),
		};
		run.ready = new Promise((resolveReady) => {
			run.markReady = resolveReady;
		});
		entry.active = run;
		run.done = executeRun(entry, run, [], checkpoint?.checkpoint);
		await run.ready;
	} else if (
		record.state.execution === "running" ||
		record.pendingApproval ||
		record.pendingToolResponse
	) {
		entry.store.update((current) => {
			current.state.execution = "idle";
			current.state.needsInput = null;
			current.state.completion = {
				completionId: current.state.runId ?? randomUUID(),
				outcome: "interrupted",
			};
			current.state.completionUnread = true;
			for (const queued of current.queue) queued.state = "pending";
			for (const [, effect] of Object.entries(current.effects))
				if (effect.status === "started") effect.status = "unknown";
			delete current.pendingApproval;
			delete current.pendingToolResponse;
			delete current.runCheckpoint;
		});
		for (const [callId, effect] of interruptedEffects)
			recordToolResult(
				entry,
				callId,
				effect.name,
				"Operation interrupted; its result is unknown. Inspect the worktree before retrying.",
				true,
				false,
			);
	}
	if (!entry.active && record.state.runId) {
		for (const [callId, effect] of Object.entries(entry.store.record.effects)) {
			if (effect.runId !== record.state.runId) continue;
			const items: AgentInputItem[] = [];
			if (
				!entry.store.record.history.some(
					(item) => item.type === "function_call" && item.callId === callId,
				)
			)
				items.push({
					type: "function_call",
					callId,
					name: effect.name,
					arguments: JSON.stringify(effect.arguments),
					status: "completed",
				});
			if (
				!entry.store.record.history.some(
					(item) => item.type === "function_call_result" && item.callId === callId,
				)
			)
				items.push({
					type: "function_call_result",
					callId,
					name: effect.name,
					status: "completed",
					output:
						effect.result ??
						"Operation interrupted; its result is unknown. Inspect the worktree before retrying.",
				});
			if (items.length) await entry.store.addItems(items);
		}
	}
	flush(entry);
	return true;
}
export async function getSessionMessages(sessionId: string, workspaceId: string, cwd: string) {
	if (!(await ensureSessionAttached(sessionId, workspaceId, cwd)))
		throw new Error("Unknown session in this workspace");
	const entry = mustGet(sessionId);
	return {
		summary: summaryOf(entry),
		messages: structuredClone(
			projectImages(entry.store.record.messages, imageOwner(entry)),
		) as TranscriptMessage[],
		eventSeq: entry.store.record.eventSeq,
	};
}
export const sessionImageSource: ImageSource = {
	isServable: (sessionId) => {
		const entry = sessions.get(sessionId);
		if (
			!entry ||
			entry.store.record.childRun ||
			closingSessions.has(sessionId) ||
			deletingSessions.has(sessionId) ||
			closingWorkspaces.has(entry.store.record.workspaceId)
		)
			return false;
		const workspace = loadWorkspaces().find((item) => item.id === entry.store.record.workspaceId);
		if (!workspace || workspace.deletionPending) return false;
		const project = loadProjects().find((item) => item.id === workspace.projectId);
		return !!project && !project.closed;
	},
	find: (sessionId, hash) => {
		if (!sessionImageSource.isServable(sessionId)) return null;
		const entry = sessions.get(sessionId);
		if (!entry) return null;
		for (const message of entry.store.record.messages) {
			const found = findImageBlock("content" in message ? message.content : undefined, hash);
			if (found) return found;
		}
		return null;
	},
};
export async function listSessions(workspaceId: string, cwd: string): Promise<SessionSummary[]> {
	const records = listSessionRecords().filter(
		(record) =>
			!record.childRun && record.workspaceId === workspaceId && record.cwd === resolve(cwd),
	);
	return records
		.map((record) =>
			summaryOf(sessions.get(record.sessionId) ?? { store: new PersistentSession(record) }),
		)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}
export interface SessionStateWorkspace {
	id: string;
	projectId: string;
	cwd: string;
}
export async function listSessionStates(
	workspaces: readonly SessionStateWorkspace[],
): Promise<SessionStateRecord[]> {
	const records: SessionStateRecord[] = [];
	for (const workspace of workspaces)
		for (const summary of await listSessions(workspace.id, workspace.cwd))
			records.push({
				sessionId: summary.sessionId,
				workspaceId: workspace.id,
				projectId: workspace.projectId,
				state: summary.state ?? idleState(),
				title: summary.title,
				...(summary.firstPrompt ? { firstPrompt: summary.firstPrompt } : {}),
			});
	return records;
}
export async function initializeSessionStates(
	workspaces: readonly SessionStateWorkspace[],
): Promise<void> {
	for (const state of await listSessionStates(workspaces)) publishState(state);
}
export function renameSession(
	sessionId: string,
	workspaceId: string,
	cwd: string,
	name: string,
	options: { onlyIfUnnamed?: boolean; assertActive?: () => void } = {},
): Promise<boolean> {
	const title = normalizeSessionTitle(name);
	if (!title) return Promise.reject(new Error("Invalid session title"));
	return ensureSessionAttached(sessionId, workspaceId, cwd).then((attached) => {
		if (!attached) throw new Error("Unknown session");
		if (closingSessions.has(sessionId) || deletingSessions.has(sessionId))
			throw new Error("Session is closing");
		const entry = mustGet(sessionId);
		options.assertActive?.();
		if (options.onlyIfUnnamed && entry.store.record.title?.trim()) return false;
		if (entry.store.record.title === title) return true;
		entry.store.update((record) => {
			record.title = title;
		});
		emit(entry, { type: "session_info_changed", name: title });
		notifyState(entry);
		return true;
	});
}
export async function setSessionModel(sessionId: string, model: WireModel): Promise<WireModel> {
	const entry = mustGet(sessionId);
	if (entry.active) throw new Error("Stop the active run before changing its model");
	const configured = (await listAvailableModels()).find(
		(candidate) => candidate.id === model.id && candidate.provider === model.provider,
	);
	if (!configured) throw new Error("Unknown model");
	entry.store.update((record) => {
		record.model = configured;
		if (!configured.thinkingLevels.includes(record.thinkingLevel)) record.thinkingLevel = "off";
	});
	return configured;
}
export function setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void {
	const entry = mustGet(sessionId);
	if (entry.active) throw new Error("Stop the active run before changing reasoning");
	if (!entry.store.record.model?.thinkingLevels.includes(level))
		throw new Error("Unsupported reasoning level");
	entry.store.update((record) => {
		record.thinkingLevel = level;
	});
	emit(entry, { type: "thinking_level_changed", level });
}
export function setSessionSandbox(sessionId: string, enabled: boolean): void {
	if (typeof enabled !== "boolean") throw new Error("Sandbox setting must be a boolean");
	const entry = mustGet(sessionId);
	if (entry.store.record.childRun) throw new Error("The Sandbox setting belongs to a chat");
	if (entry.active || entry.stopping)
		throw new Error("Stop the active run before changing Sandbox");
	if ((entry.store.record.sandbox === true) === enabled) return;
	entry.store.update((record) => {
		record.sandbox = enabled;
	});
	notifyState(entry);
}
export function setSessionSandboxMemory(sessionId: string, enabled: boolean): void {
	if (typeof enabled !== "boolean") throw new Error("Sandbox memory setting must be a boolean");
	const entry = mustGet(sessionId);
	if (entry.store.record.childRun || !entry.store.record.sandbox)
		throw new Error("Retained memory requires a Sandbox chat");
	if (entry.store.record.handoffs)
		throw new Error("Retained memory is unavailable in Handoff chats");
	if (entry.active || entry.stopping)
		throw new Error("Stop the active run before changing Sandbox memory");
	if ((entry.store.record.sandboxMemory === true) === enabled) return;
	entry.store.update((record) => {
		record.sandboxMemory = enabled;
	});
	notifyState(entry);
}

export function acknowledgeCompletion(
	sessionId: string,
	completionId: string,
): { acknowledged: boolean; record: SessionStateRecord } {
	const entry = mustGet(sessionId);
	const acknowledged =
		entry.store.record.state.completion?.completionId === completionId &&
		entry.store.record.state.completionUnread;
	if (acknowledged) {
		entry.store.update((record) => {
			record.state.completionUnread = false;
		});
		notifyState(entry);
	}
	return { acknowledged, record: stateRecord(entry) };
}
export async function markWorkspaceRead(
	workspace: SessionStateWorkspace,
): Promise<SessionStateRecord[]> {
	const result: SessionStateRecord[] = [];
	for (const summary of await listSessions(workspace.id, workspace.cwd)) {
		if (!summary.state?.completion || !summary.state.completionUnread) continue;
		await ensureSessionAttached(summary.sessionId, workspace.id, workspace.cwd);
		result.push(
			acknowledgeCompletion(summary.sessionId, summary.state.completion.completionId).record,
		);
	}
	return result;
}
export async function markWorkspaceUnread(
	workspace: SessionStateWorkspace,
): Promise<SessionStateRecord | null> {
	for (const summary of await listSessions(workspace.id, workspace.cwd)) {
		if (
			!summary.state?.completion ||
			summary.state.completionUnread ||
			summary.state.completion.outcome === "cancelled" ||
			summary.state.execution === "running"
		)
			continue;
		await ensureSessionAttached(summary.sessionId, workspace.id, workspace.cwd);
		const entry = mustGet(summary.sessionId);
		entry.store.update((record) => {
			record.state.completionUnread = true;
		});
		notifyState(entry);
		return stateRecord(entry);
	}
	return null;
}
function statsFromRecord(record: SessionRecord): SessionStats {
	const entry = { store: { record } };
	const sessionId = record.sessionId;
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

	for (const message of entry.store.record.messages)
		if (message.role === "assistant") {
			tokens.input += message.usage.input;
			tokens.output += message.usage.output;
			tokens.cacheRead += message.usage.cacheRead;
			tokens.cacheWrite += message.usage.cacheWrite;
			tokens.total += message.usage.totalTokens;
		}
	for (const receipt of Object.values(entry.store.record.summaryOperations)) {
		if (!receipt.usage) continue;
		tokens.input += receipt.usage.input;
		tokens.output += receipt.usage.output;
		tokens.cacheRead += receipt.usage.cacheRead;
		tokens.cacheWrite += receipt.usage.cacheWrite;
		tokens.total += receipt.usage.total;
	}
	return { sessionId, totalMessages: entry.store.record.messages.length, tokens, cost: null };
}
export function getSessionStats(sessionId: string): SessionStats {
	const entry = mustGet(sessionId),
		stats = statsFromRecord(entry.store.record);
	if (!entry.store.record.childRun)
		for (const child of childRecords(entry)) {
			if (!child.childRun?.detached && child.childRun?.purpose !== "review") continue;
			const usage = statsFromRecord(child).tokens;
			stats.tokens.input += usage.input;
			stats.tokens.output += usage.output;
			stats.tokens.total += usage.total;
			stats.tokens.cacheRead += usage.cacheRead;
			stats.tokens.cacheWrite += usage.cacheWrite;
		}
	return stats;
}
export async function readFinalAssistantTexts(
	workspaceId: string,
	cwd: string,
	ids: readonly string[],
): Promise<Map<string, string | null>> {
	const result = new Map<string, string | null>();
	for (const id of ids) {
		const record = sessions.get(id)?.store.record ?? readSessionRecord(id);
		const message =
			record?.workspaceId === workspaceId && record.cwd === resolve(cwd)
				? record.messages.findLast(
						(item) => item.role === "assistant" && textOf(item.content).trim(),
					)
				: undefined;
		result.set(id, message?.role === "assistant" ? textOf(message.content) : null);
	}
	return result;
}
export async function removeSession(sessionId: string): Promise<void> {
	const entry = sessions.get(sessionId);
	if (!entry) return;
	closingSessions.add(sessionId);
	rejectPendingFixes(entry);
	try {
		if (
			entry.active &&
			(entry.store.record.pendingApproval || entry.store.record.pendingToolResponse)
		) {
			const run = entry.active;
			run.suspended = true;
			run.granted = false;
			run.controller.abort();
			run.approval?.reject(new Error("Approval saved for continuation"));
			run.toolResponse?.reject(new Error("Tool response saved for continuation"));
			await run.done;
		} else await abortSession(sessionId, "interrupted");
		await stopOwnedResources(entry, "interrupted");
		await releaseSessionResources?.(sessionId);
		flush(entry);
		sessions.delete(sessionId);
	} finally {
		closingSessions.delete(sessionId);
	}
}
export async function deleteSession(
	sessionId: string,
	workspaceId: string,
	cwd: string,
): Promise<void> {
	const record = sessions.get(sessionId)?.store.record ?? readSessionRecord(sessionId);
	if (!record || record.workspaceId !== workspaceId || record.cwd !== resolve(cwd))
		throw new Error("Unknown session in this workspace");
	if (deletingSessions.has(sessionId)) throw new Error("Session deletion is already in progress");
	deletingSessions.add(sessionId);
	try {
		await removeSession(sessionId);
		await trashFile(sessionRecordPath(sessionId));
		publishDeleted({ sessionId, workspaceId });
	} finally {
		deletingSessions.delete(sessionId);
	}
}
export async function removeWorkspaceSessions(workspaceId: string, cwd?: string): Promise<void> {
	for (const record of listSessionRecords())
		if (record.workspaceId === workspaceId && (cwd === undefined || record.cwd === resolve(cwd)))
			await deleteSession(record.sessionId, workspaceId, record.cwd);
}
export async function closeWorkspaceSessions<T>(
	workspaceId: string,
	operation: () => Promise<T>,
): Promise<T> {
	if (closingWorkspaces.has(workspaceId)) throw new Error("Workspace is closing");
	closingWorkspaces.add(workspaceId);
	try {
		for (const [id, entry] of sessions)
			if (entry.store.record.workspaceId === workspaceId) await removeSession(id);
		return await operation();
	} finally {
		closingWorkspaces.delete(workspaceId);
	}
}
export async function settleSessionsForShutdown(): Promise<void> {
	await Promise.all([...sessions.keys()].map((id) => removeSession(id)));
}
export function disposeAllSessions(): void {
	for (const controller of queuedChildControllers.values()) controller.abort();
	for (const entry of sessions.values()) {
		entry.summaryController?.abort();
		for (const scope of entry.reviewScopes ?? []) scope.controller.abort();
		void entry.commands?.dispose().catch((error) => log.warn("Command cleanup failed", error));
		if (entry.active) {
			entry.active.suspended = true;
			entry.active.granted = false;
			entry.active.controller.abort();
			entry.active.approval?.reject(new Error("Host stopped"));
			entry.active.toolResponse?.reject(new Error("Host stopped"));
		}
		if (entry.flush) clearTimeout(entry.flush);
	}
	sessions.clear();
}
