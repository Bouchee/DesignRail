import { readFileSync, realpathSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { SessionRecord } from "@thinkrail/server/agent";
import { defaultWorkspaceRow, enterDefaultWorkspace, openFixtureProject } from "./fixtures/app";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";

const BASE_TS = 1_700_600_000_000;
const usage = {
	input: 10,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model = { api: "openai-responses", provider: "fixture", model: "fixture", usage };

// A stored chat with guardrail outcomes: the browser renders the application record only; no model starts.
function seedGuardrailChat() {
	const chat = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "guardrails",
		messages: [{ role: "user", text: "Read the configuration.", timestamp: BASE_TS }],
	});
	const record = JSON.parse(readFileSync(chat.path, "utf8")) as SessionRecord;
	record.messages.push(
		{
			id: `${chat.id}-calls`,
			role: "assistant",
			...model,
			content: [
				{ type: "toolCall", id: "read-config", name: "read", arguments: { path: "config.txt" } },
				{
					type: "toolCall",
					id: "bash-delete",
					name: "bash",
					arguments: { command: "rm -rf build" },
				},
			],
			stopReason: "toolUse",
			timestamp: BASE_TS + 1_000,
		},
		{
			id: `${chat.id}-read-config`,
			role: "toolResult",
			toolCallId: "read-config",
			toolName: "read",
			content: [{ type: "text", text: "api_key=held-on-host" }],
			isError: false,
			guardrail: { stage: "output", rule: "secret" },
			timestamp: BASE_TS + 2_000,
		},
		{
			id: `${chat.id}-bash-delete`,
			role: "toolResult",
			toolCallId: "bash-delete",
			toolName: "bash",
			content: [{ type: "text", text: 'Tool call rejected by guardrail "no-delete".' }],
			isError: true,
			guardrail: { stage: "input", rule: "no-delete" },
			timestamp: BASE_TS + 2_000,
		},
		{
			id: `${chat.id}-stopped`,
			role: "assistant",
			...model,
			content: [],
			stopReason: "guardrail",
			guardrail: "secret",
			timestamp: BASE_TS + 3_000,
		},
	);
	const staged = `${chat.path}.fixture-update`;
	writeFileSync(staged, `${JSON.stringify(record)}\n`);
	renameSync(staged, chat.path);
	utimesSync(chat.path, new Date(BASE_TS), new Date(BASE_TS));
}

test("stored guardrail outcomes show on their tool rows and as a distinct stop after refresh", async ({
	page,
}) => {
	await openFixtureProject(page);
	seedGuardrailChat();
	await expect(defaultWorkspaceRow(page)).toBeVisible();
	await enterDefaultWorkspace(page);
	await expect(page.locator('[data-testid="editor-tab"][data-kind="chat"]')).toHaveCount(1);

	for (const pass of ["initial", "refresh"]) {
		if (pass === "refresh") await page.reload();
		await page.getByRole("button", { name: "2 steps · read, bash" }).click();
		const notes = page.getByTestId("tool-guardrail");
		await expect(notes).toHaveCount(2);
		await expect(notes.and(page.locator('[data-stage="output"]'))).toHaveText(
			'Withheld by guardrail "secret"; the model did not see this result.',
		);
		await expect(notes.and(page.locator('[data-stage="input"]'))).toHaveText(
			'Blocked by guardrail "no-delete"; the call did not run.',
		);
		await expect(
			page.getByText('Guardrail "secret" stopped the answer. The rest of the answer is withheld.'),
		).toBeVisible();
		await expect(page.getByText("The agent run ended in an error.")).toHaveCount(0);
	}
});
