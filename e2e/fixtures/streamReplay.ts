import type { Page, WebSocketRoute } from "@playwright/test";
import {
	type AssistantMessage,
	type SessionEvent,
	WS_CHANNELS,
	type WsPush,
} from "@thinkrail/contracts";

const DELTA_CHARS = 40;
const WORDS = ["stream", "row", "measure", "scroll", "virtual", "anchor", "layout", "delta"];
const sequenceBySession = new Map<string, number>();

export interface StreamReplay {
	steps: string[][];
	finalTail: string;
}

const sentence = (seed: number, length: number) =>
	Array.from({ length }, (_, index) => WORDS[(seed * 7 + index * 3) % WORDS.length]).join(" ");

const markdownBlock = (index: number) => {
	if (index % 4 === 1) {
		return Array.from(
			{ length: 4 },
			(_, item) => `- \`${sentence(index + item, 1)}\` ${sentence(index + item, 8)}`,
		).join("\n");
	}
	if (index % 4 === 3) return `\`\`\`ts\nconst row${index} = "${sentence(index, 6)}";\n\`\`\``;
	return `${sentence(index, 48)}.`;
};

export const streamedMarkdown = (marker: string, minChars: number) => {
	const blocks = [`${marker} ${sentence(0, 12)}.`];
	let length = blocks[0]?.length ?? 0;
	for (let index = 1; length < minChars; index += 1) {
		const block = markdownBlock(index);
		blocks.push(block);
		length += block.length + 2;
	}
	blocks.push(`${marker} done.`);
	return blocks.join("\n\n");
};

const assistantShell = (timestamp: number): AssistantMessage => ({
	role: "assistant",
	content: [],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-replay",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp,
});

function replayFrame(sessionId: string, runId: string) {
	return (event: SessionEvent) => {
		const seq = (sequenceBySession.get(sessionId) ?? 0) + 1;
		sequenceBySession.set(sessionId, seq);
		return JSON.stringify({
			channel: WS_CHANNELS.sessionEvent,
			data: { sessionId, runId, seq, event },
		} satisfies WsPush);
	};
}

export const textStreamReplay = (
	sessionId: string,
	text: string,
	timestamp: number,
): StreamReplay => {
	const runId = `replay-${timestamp}-${(sequenceBySession.get(sessionId) ?? 0) + 1}`;
	const push = replayFrame(sessionId, runId);
	const message = { ...assistantShell(timestamp), id: `message-${runId}` };
	const start = [
		push({ type: "agent_start" }),
		push({ type: "turn_start" }),
		push({ type: "message_start", message }),
		push({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message },
		}),
	];
	const deltas = Array.from({ length: Math.ceil(text.length / DELTA_CHARS) }, (_, index) => {
		const end = (index + 1) * DELTA_CHARS;
		const partial: AssistantMessage = {
			...message,
			content: [{ type: "text", text: text.slice(0, end) }],
		};
		return [
			push({
				type: "message_update",
				message: partial,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: text.slice(index * DELTA_CHARS, end),
					partial,
				},
			}),
		];
	});
	const final: AssistantMessage = { ...message, content: [{ type: "text", text }] };
	return {
		steps: [
			start,
			...deltas,
			[
				push({
					type: "message_update",
					message: final,
					assistantMessageEvent: { type: "done", reason: "stop", message: final },
				}),
				push({ type: "message_end", message: final }),
				push({ type: "turn_end", message: final, toolResults: [] }),
				push({ type: "agent_end", messages: [], willRetry: false }),
				push({ type: "agent_settled", terminal: null }),
			],
		],
		finalTail: text.slice(-40),
	};
};

type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

export function toolCallReplay(
	sessionId: string,
	runId: string,
	toolCall: ToolCall,
	timestamp: number,
) {
	const push = replayFrame(sessionId, runId);
	const message = {
		...assistantShell(timestamp),
		id: `message-${runId}`,
		stopReason: "toolUse",
	} as const;
	const final: AssistantMessage = { ...message, content: [toolCall] };
	return [
		push({ type: "agent_start" }),
		push({ type: "turn_start" }),
		push({ type: "message_start", message }),
		push({
			type: "message_update",
			message: final,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: final },
		}),
		push({ type: "message_end", message: final }),
		push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		}),
	];
}

export const interceptAppWire = async (page: Page) => {
	let current: WebSocketRoute | null = null;
	await page.routeWebSocket(/\/ws(\?|$)/, (browser) => {
		browser.connectToServer();
		current = browser;
	});
	return () => {
		if (!current) throw new Error("The app wire is not connected");
		return current;
	};
};

export const playStreamReplay = async (
	socket: WebSocketRoute,
	replay: StreamReplay,
	gapMs: number,
) => {
	for (const frames of replay.steps) {
		for (const frame of frames) socket.send(frame);
		await new Promise((resolve) => setTimeout(resolve, gapMs));
	}
};
