import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
	type Agent,
	type AgentOutputType,
	getCurrentTrace,
	type Runner,
	type SpanData,
	setTraceProcessors,
	type Trace,
	withTraceContext,
} from "@openai/agents";
import { logger } from "../log";
import { loadConfig } from "../persistence";
import { redactMcpText } from "./mcp";

export interface TraceIdentity {
	sessionId: string;
	runId: string;
	workspaceId: string;
	startNodeId: string;
	parentSessionId?: string;
}
export type DiagnosticOutcome =
	| "success"
	| "error"
	| "length"
	| "cancel"
	| "guardrail"
	| "suspended";
interface Scope {
	ids: TraceIdentity;
	redact: (text: string) => string;
	traces: Set<Trace>;
}
let configured = false;
const log = logger("sdk-trace");
const scope = new AsyncLocalStorage<Scope>();
const spanScopes = new WeakMap<object, Scope>();
const traceScopes = new WeakMap<object, Scope>();
const identityKeys = new Set([
	"sessionId",
	"runId",
	"workspaceId",
	"startNodeId",
	"parentSessionId",
]);

function safeText(text: string, current = scope.getStore()): string {
	return (current?.redact(text) ?? redactMcpText(text)).slice(0, 256);
}
function metadata(value: object | undefined, current?: Scope) {
	return Object.fromEntries(
		Object.entries(value ?? {}).flatMap(([key, field]) =>
			identityKeys.has(key) && typeof field === "string" ? [[key, safeText(field, current)]] : [],
		),
	);
}
function fields(data: SpanData, current?: Scope): Record<string, unknown> {
	const text = (value: string) => safeText(value, current);
	const usage = (value: Record<string, unknown> | undefined) =>
		Object.fromEntries(
			[
				"requests",
				"input_tokens",
				"output_tokens",
				"total_tokens",
				"cached_input_tokens",
				"cache_write_input_tokens",
			].flatMap((key) => {
				const count = value?.[key];
				return typeof count === "number" && Number.isFinite(count) && count >= 0
					? [[key, count]]
					: [];
			}),
		);
	switch (data.type) {
		case "agent":
		case "function":
			return { name: text(data.name) };
		case "handoff":
			return {
				...(data.from_agent === undefined ? {} : { from: text(data.from_agent) }),
				...(data.to_agent === undefined ? {} : { to: text(data.to_agent) }),
			};
		case "guardrail":
			return { name: text(data.name), triggered: data.triggered };
		case "generation":
			return {
				...(data.model === undefined ? {} : { model: text(data.model) }),
				usage: usage(data.usage),
			};
		case "task":
			return { name: text(data.name), usage: usage(data.usage) };
		case "turn":
			return { turn: data.turn, agent: text(data.agent_name), usage: usage(data.usage) };
		default:
			return {};
	}
}
export function configureLocalSdkTracing(): void {
	if (configured) return;
	setTraceProcessors([
		{
			onTraceStart(trace) {
				const current = scope.getStore();
				if (current) {
					traceScopes.set(trace, current);
					current.traces.add(trace);
				}
				return Promise.resolve();
			},
			onSpanStart(span) {
				const current = scope.getStore();
				if (current) spanScopes.set(span, current);
				return Promise.resolve();
			},
			onTraceEnd(trace) {
				const current = traceScopes.get(trace) ?? scope.getStore();
				traceScopes.delete(trace);
				log.info(
					JSON.stringify({
						event: "trace.end",
						traceId: trace.traceId,
						groupId: trace.groupId,
						name: safeText(trace.name, current),
						...metadata(trace.metadata, current),
					}),
				);
				return Promise.resolve();
			},
			onSpanEnd(span) {
				const current = spanScopes.get(span) ?? scope.getStore();
				spanScopes.delete(span);
				const durationMs =
					span.startedAt && span.endedAt
						? Date.parse(span.endedAt) - Date.parse(span.startedAt)
						: undefined;
				log.info(
					JSON.stringify({
						event: "span.end",
						traceId: span.traceId,
						spanId: span.spanId,
						parentId: span.parentId,
						type: span.spanData.type,
						...metadata(current?.ids ?? span.traceMetadata, current),
						startedAt: span.startedAt,
						endedAt: span.endedAt,
						...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
						...fields(span.spanData, current),
						...(span.error ? { error: safeText(span.error.message, current) } : {}),
					}),
				);
				return Promise.resolve();
			},
			shutdown: () => Promise.resolve(),
			forceFlush: () => Promise.resolve(),
		},
	]);
	configured = true;
}

export function traceRunOptions(ids: TraceIdentity) {
	return {
		tracingDisabled: !loadConfig().sdkTracingEnabled,
		traceIncludeSensitiveData: false,
		groupId: ids.sessionId,
		traceMetadata: { ...ids },
	};
}

function recorder(ids: TraceIdentity, redact: Scope["redact"]) {
	const current: Scope = { ids, redact, traces: new Set() };
	const enabled = loadConfig().sdkTracingEnabled;
	const agents = new Map<object, { itemId: string; agent: string }>();
	const tools = new Map<string, { itemId: string; agent: string; tool: string; callId: string }>();
	let closed = false;
	let sequence = 0;
	const recordingId = randomUUID();
	let traceId: string | undefined;
	let inputBlocked = false;
	const write = (event: string, values: Record<string, unknown> = {}) => {
		if (!enabled || closed) return;
		traceId = getCurrentTrace()?.traceId ?? traceId;
		log.info(
			JSON.stringify({
				event: "lifecycle",
				lifecycle: event,
				...metadata(ids, current),
				traceId,
				...values,
			}),
		);
	};
	const endAgent = (agent: object, outcome: DiagnosticOutcome) => {
		const item = agents.get(agent);
		if (!item) return;
		agents.delete(agent);
		write("agent.end", { ...item, outcome });
	};
	const startAgent = (agent: { name: string }) => {
		if (closed || agents.has(agent)) return;
		const item = {
			itemId: `${recordingId}:agent:${++sequence}`,
			agent: safeText(agent.name, current),
		};
		agents.set(agent, item);
		write("agent.start", item);
	};
	const startTool = (agent: { name: string }, tool: { name: string }, callId: string) => {
		if (closed || tools.has(callId)) return;
		const item = {
			itemId: `${recordingId}:tool:${++sequence}`,
			agent: safeText(agent.name, current),
			tool: safeText(tool.name, current),
			callId: safeText(callId, current),
		};
		tools.set(callId, item);
		write("tool.start", item);
	};
	const endTool = (callId: string, outcome: DiagnosticOutcome = "success") => {
		const item = tools.get(callId);
		if (!item) return;
		tools.delete(callId);
		write("tool.end", { ...item, outcome });
	};
	return {
		enabled,
		startAgent,
		endAgent,
		startTool,
		endTool,
		inputGuardrailBlocked() {
			inputBlocked = true;
		},
		handoff(from: { name: string }, to: { name: string }) {
			write("handoff", { from: safeText(from.name, current), to: safeText(to.name, current) });
			endAgent(from, "success");
		},
		run<T>(fn: () => T): T {
			return enabled ? scope.run(current, fn) : fn();
		},
		async close(outcome: DiagnosticOutcome) {
			if (closed) return;
			if (inputBlocked && outcome === "error") outcome = "guardrail";
			for (const key of tools.keys()) endTool(key, outcome);
			for (const agent of agents.keys()) endAgent(agent, outcome);
			write("run.end", { outcome });
			closed = true;
			for (const trace of current.traces) await trace.end();
			current.traces.clear();
		},
	};
}

export function attachRunDiagnostics(runner: Runner, ids: TraceIdentity, redact: Scope["redact"]) {
	const record = recorder(ids, redact);
	const onStart: Parameters<typeof runner.on<"agent_start">>[1] = (_context, agent) =>
		record.startAgent(agent);
	const onEnd: Parameters<typeof runner.on<"agent_end">>[1] = (_context, agent) =>
		record.endAgent(agent, "success");
	const onHandoff: Parameters<typeof runner.on<"agent_handoff">>[1] = (_context, from, to) =>
		record.handoff(from, to);
	const onToolStart: Parameters<typeof runner.on<"agent_tool_start">>[1] = (
		_context,
		agent,
		tool,
		{ toolCall },
	) => {
		if (toolCall.type === "function_call") record.startTool(agent, tool, toolCall.callId);
	};
	const onToolEnd: Parameters<typeof runner.on<"agent_tool_end">>[1] = (
		_context,
		_agent,
		_tool,
		_result,
		{ toolCall },
	) => {
		if (toolCall.type === "function_call") record.endTool(toolCall.callId);
	};
	if (record.enabled)
		runner
			.on("agent_start", onStart)
			.on("agent_end", onEnd)
			.on("agent_handoff", onHandoff)
			.on("agent_tool_start", onToolStart)
			.on("agent_tool_end", onToolEnd);
	return {
		run<T>(fn: () => T): T {
			return record.run(() => withTraceContext(null, fn));
		},
		async close(outcome: DiagnosticOutcome) {
			await record.close(outcome);
			runner
				.off("agent_start", onStart)
				.off("agent_end", onEnd)
				.off("agent_handoff", onHandoff)
				.off("agent_tool_start", onToolStart)
				.off("agent_tool_end", onToolEnd);
		},
	};
}

export function attachAgentDiagnostics<TContext, TOutput extends AgentOutputType>(
	agent: Agent<TContext, TOutput>,
	ids: TraceIdentity,
	redact: Scope["redact"],
) {
	const record = recorder(ids, redact);
	const inputGuardrails = agent.inputGuardrails;
	if (record.enabled)
		agent.inputGuardrails = inputGuardrails.map((guardrail) => ({
			...guardrail,
			async execute(args) {
				const result = await guardrail.execute(args);
				if (result.tripwireTriggered) record.inputGuardrailBlocked();
				return result;
			},
		}));
	const onStart = () => record.startAgent(agent);
	const onEnd = () => record.endAgent(agent, "success");
	const onToolStart: Parameters<typeof agent.on<"agent_tool_start">>[1] = (
		_context,
		tool,
		{ toolCall },
	) => {
		if (toolCall.type === "function_call") record.startTool(agent, tool, toolCall.callId);
	};
	const onToolEnd: Parameters<typeof agent.on<"agent_tool_end">>[1] = (
		_context,
		_tool,
		_result,
		{ toolCall },
	) => {
		if (toolCall.type === "function_call") record.endTool(toolCall.callId);
	};
	if (record.enabled)
		agent
			.on("agent_start", onStart)
			.on("agent_end", onEnd)
			.on("agent_tool_start", onToolStart)
			.on("agent_tool_end", onToolEnd);
	return {
		run: record.run,
		async close(outcome: DiagnosticOutcome) {
			await record.close(outcome);
			if (record.enabled) agent.inputGuardrails = inputGuardrails;
			agent
				.off("agent_start", onStart)
				.off("agent_end", onEnd)
				.off("agent_tool_start", onToolStart)
				.off("agent_tool_end", onToolEnd);
		},
	};
}
