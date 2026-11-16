import { readFileSync, realpathSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { AGENT_TRANSFER_CUSTOM_TYPE } from "@thinkrail/contracts";
import type { SessionRecord } from "@thinkrail/server/agent";
import { defaultWorkspaceRow, enterDefaultWorkspace, openFixtureProject } from "./fixtures/app";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";

const BASE_TS = 1_700_500_000_000;

// A stored SDK Handoff chat: the browser renders the application record only; no model is started.
function seedHandoffChat() {
	const chat = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "agent handoff",
		messages: [
			{ role: "user", text: "Please analyse the watcher.", timestamp: BASE_TS },
			{ role: "assistant", text: "Routing this to the analyst.", timestamp: BASE_TS + 1_000 },
			{
				role: "custom",
				customType: AGENT_TRANSFER_CUSTOM_TYPE,
				content: "",
				display: true,
				details: {
					transferId: "transfer-1",
					from: "RailDesign",
					to: "analyst",
					reason: "needs a focused analysis",
				},
				timestamp: BASE_TS + 2_000,
			},
			{ role: "assistant", text: "The watcher debounce is too short.", timestamp: BASE_TS + 3_000 },
		],
	});
	const record = JSON.parse(readFileSync(chat.path, "utf8")) as SessionRecord;
	const authors = ["RailDesign", "analyst"];
	for (const message of record.messages)
		if (message.role === "assistant") message.agent = authors.shift() ?? "";
	record.handoffs = {
		graph: {
			version: 1,
			source: { scope: "personal", path: "/fixture/handoffs.json" },
			rootTargets: ["analyst"],
			nodes: [
				{
					definition: {
						name: "analyst",
						description: "analyst role",
						source: "personal",
						systemPrompt: "Analyse.",
					},
					targets: ["$root"],
					history: "all",
				},
			],
		},
		activeNode: "analyst",
		transfers: [
			{
				id: "transfer-1",
				runId: "fixture-run",
				from: "$root",
				to: "analyst",
				reason: "needs a focused analysis",
				timestamp: BASE_TS + 2_000,
			},
		],
	};
	const staged = `${chat.path}.fixture-update`;
	writeFileSync(staged, `${JSON.stringify(record)}\n`);
	renameSync(staged, chat.path);
	utimesSync(chat.path, new Date(BASE_TS), new Date(BASE_TS));
}

test("a stored agent transfer shows its row, the current handler and authorship after refresh", async ({
	page,
}) => {
	await openFixtureProject(page);
	seedHandoffChat();
	await expect(defaultWorkspaceRow(page)).toBeVisible();
	await enterDefaultWorkspace(page);
	await expect(page.locator('[data-testid="editor-tab"][data-kind="chat"]')).toHaveCount(1);

	for (const pass of ["initial", "refresh"]) {
		if (pass === "refresh") await page.reload();
		const transfer = page.getByTestId("agent-transfer");
		await expect(transfer).toHaveCount(1);
		await expect(transfer).toContainText("RailDesign handed the conversation to analyst");
		await expect(transfer).toContainText("needs a focused analysis");
		await expect(page.getByTestId("handoff-card")).toHaveCount(0);
		await expect(page.getByTestId("active-agent")).toHaveText("Handled by analyst");
		await expect(page.getByTestId("assistant-agent")).toHaveText(["RailDesign", "analyst"]);
	}
});
