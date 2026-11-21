import { realpathSync, utimesSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import type { AskUserQuestionArgs } from "@thinkrail/ask-user-question/core";
import type {
	SessionState,
	ToolCall,
	ToolResponsePendingDetails,
	WsParams,
	WsRequest,
} from "@thinkrail/contracts";
import { openPersistedChat } from "./app";
import { E2E_FIXTURE_REPO } from "./paths";
import { pendingToolFixtureState, seedWorkspaceSession } from "./sessions";

export type QuestionnaireArgs = AskUserQuestionArgs & ToolCall["arguments"];

type QuestionReply = WsParams<"session.respondToTool">;

// A seeded transcript has no live SDK checkpoint. Exercise the client's wire reply and receipt here.
export async function routeQuestionReplies(
	page: Page,
	rounds: readonly { sessionId: string; toolCallId: string; runId?: string }[],
): Promise<QuestionReply[]> {
	const replies: QuestionReply[] = [];
	await page.routeWebSocket(/\/ws(\?|$)/, (browser) => {
		const server = browser.connectToServer();
		browser.onMessage((raw) => {
			const request = JSON.parse(raw.toString()) as WsRequest;
			if (request.method !== "session.respondToTool") {
				server.send(raw);
				return;
			}
			const reply = request.params as QuestionReply;
			const round = rounds.find((item) => item.sessionId === reply.sessionId);
			if (
				!round ||
				round.toolCallId !== reply.toolCallId ||
				round.toolCallId !== reply.interactionId ||
				(round.runId ?? `fixture-run-${round.toolCallId}`) !== reply.runId ||
				reply.revision !== 0 ||
				replies.some((previous) => previous.sessionId === reply.sessionId)
			) {
				browser.send(JSON.stringify({ id: request.id, ok: false, error: "Invalid fixture reply" }));
				return;
			}
			replies.push(reply);
			browser.send(JSON.stringify({ id: request.id, ok: true, result: { ok: true } }));
			browser.send(
				JSON.stringify({
					channel: "session.event",
					data: {
						sessionId: reply.sessionId,
						runId: reply.runId,
						seq: 1,
						event: {
							type: "message_end",
							message: {
								id: `answer:${reply.interactionId}`,
								role: "custom",
								customType: "tool-response",
								content: [],
								details: { toolCallId: reply.toolCallId, response: reply.response },
								display: false,
								timestamp: Date.now(),
							},
						},
					},
				}),
			);
		});
	});
	return replies;
}

export function seedQuestionnaire(
	name: string,
	toolCallId: string,
	args: QuestionnaireArgs,
	timestamp: number,
	prompt = "Ask me these questions.",
	state: SessionState = pendingToolFixtureState(toolCallId),
): { id: string; path: string } {
	const ack: ToolResponsePendingDetails = { kind: "ack" };
	const session = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name,
		state,
		messages: [
			{ role: "user", text: prompt, timestamp },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "ask_user_question", arguments: args }],
				stopReason: "toolUse",
				timestamp: timestamp + 1_000,
			},
			{
				role: "toolResult",
				toolCallId,
				toolName: "ask_user_question",
				content: [{ type: "text", text: "Questions shown to the user; awaiting an answer." }],
				details: ack,
				isError: false,
				timestamp: timestamp + 2_000,
			},
		],
	});
	utimesSync(session.path, new Date(timestamp), new Date(timestamp));
	return session;
}

export async function openPersistedChatAfterInput(page: Page, title: string): Promise<void> {
	await openPersistedChat(page, title);
	const chatTab = page
		.locator('[data-testid="editor-tab"][data-kind="chat"]')
		.filter({ hasText: title });
	await chatTab.hover();
	await chatTab.getByTestId("editor-tab-close").click();
	await expect(chatTab).toHaveCount(0);
	await openPersistedChat(page, title);
}
