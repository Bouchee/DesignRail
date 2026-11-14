import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { expect, type Locator, type Page, test, type WebSocketRoute } from "@playwright/test";
import type { AssistantMessage, SessionEvent, WsPush } from "@thinkrail/contracts";
import { DEFAULT_CONFIG } from "@thinkrail/contracts";
import {
	enterDefaultWorkspace,
	hideAuxiliaryWorkbench,
	openFixtureProject,
	openPersistedChat,
	PHONE_VIEWPORT,
} from "./fixtures/app";
import { clickTranscriptControl } from "./fixtures/chatScroll";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";
import { interceptAppWire } from "./fixtures/streamReplay";
import { E2eWire } from "./fixtures/wire";

const BASE_TS = 1_700_930_000_000;
const CHAT_NAME = "content width chat";
const WIDE_LINE = `const route = [${Array.from({ length: 60 }, (_, i) => `"segment-${i}"`).join(", ")}];`;
const NARROW_LINE = "const ok = true;";
const WIDE_OUTPUT = Array.from({ length: 40 }, (_, i) => `column-${i}`).join("\t");
const WIDE_DIAGRAM = `flowchart LR\n  ${Array.from({ length: 16 }, (_, i) => `step${i}[Pipeline stage ${i}]`).join(" --> ")}`;
const TABLE_COLUMNS = Array.from({ length: 18 }, (_, i) => `column-${i}`);

const ASSISTANT_TEXT = [
	"Here is the route table and a short check.",
	"",
	"```ts",
	WIDE_LINE,
	"```",
	"",
	"```ts",
	NARROW_LINE,
	"```",
	"",
	`| ${TABLE_COLUMNS.join(" | ")} |`,
	`| ${TABLE_COLUMNS.map(() => "---").join(" | ")} |`,
	`| ${TABLE_COLUMNS.map((_, i) => `value-${i}`).join(" | ")} |`,
].join("\n");

async function replayTranscript(socket: WebSocketRoute, sessionId: string): Promise<void> {
	const wire = await E2eWire.connect();
	try {
		const [project] = await wire.request("project.list", {});
		if (!project) throw new Error("Missing fixture project");
		const workspace = (await wire.request("workspace.list", { projectId: project.id })).find(
			(item) => item.kind === "default",
		);
		if (!workspace) throw new Error("Missing fixture workspace");
		const session = (await wire.request("session.list", { workspaceId: workspace.id })).find(
			(item) => item.sessionId === sessionId,
		);
		if (!session) throw new Error("Missing fixture session");
		let seq = session.eventSeq ?? 0;
		const runId = `width-${sessionId}`;
		const send = (event: SessionEvent) => {
			socket.send(
				JSON.stringify({
					channel: "session.event",
					data: { sessionId, runId, seq: ++seq, event },
				} satisfies WsPush),
			);
		};
		const assistant = (id: string, content: AssistantMessage["content"]): AssistantMessage => ({
			id,
			role: "assistant",
			api: "responses",
			provider: "fixture",
			model: "fixture",
			content,
			stopReason: "toolUse",
			timestamp: BASE_TS + seq,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const message = (value: AssistantMessage) => {
			send({ type: "message_start", message: value });
			send({ type: "message_end", message: value });
		};
		const result = (
			toolCallId: string,
			toolName: string,
			args: Record<string, unknown>,
			text: string,
			details?: Record<string, unknown>,
		) => {
			send({ type: "tool_execution_start", toolCallId, toolName, args });
			send({
				type: "tool_execution_end",
				toolCallId,
				toolName,
				isError: false,
				result: { content: [{ type: "text", text }], ...(details ? { details } : {}) },
			});
		};
		send({ type: "agent_start" });
		send({ type: "turn_start" });
		message(
			assistant(`${runId}-outputs`, [
				{ type: "text", text: ASSISTANT_TEXT },
				{ type: "toolCall", id: "bash-wide", name: "bash", arguments: { command: "cat wide.tsv" } },
				{ type: "toolCall", id: "bash-narrow", name: "bash", arguments: { command: "echo ok" } },
			]),
		);
		result("bash-wide", "bash", { command: "cat wide.tsv" }, WIDE_OUTPUT);
		result("bash-narrow", "bash", { command: "echo ok" }, "ok");
		const diagram = { type: "diagram", title: "Pipeline", mermaid: WIDE_DIAGRAM };
		message(
			assistant(`${runId}-diagram`, [
				{ type: "toolCall", id: "visualize-wide", name: "visualize", arguments: diagram },
			]),
		);
		result("visualize-wide", "visualize", diagram, "Visualization complete.", diagram);
		message({
			...assistant(`${runId}-done`, [{ type: "text", text: "Done." }]),
			stopReason: "stop",
		});
		send({ type: "agent_end", messages: [], willRetry: false });
		send({ type: "agent_settled", terminal: null });
	} finally {
		wire.close();
	}
}

interface Geometry {
	left: number;
	right: number;
	parentLeft: number;
	parentRight: number;
	columnLeft: number;
	columnRight: number;
	paneLeft: number;
	paneRight: number;
	gutter: number;
}

function geometry(block: Locator): Promise<Geometry> {
	return block.evaluate((element) => {
		const row = element.closest('[data-testid="chat-row"]');
		const scroller = element.closest("[data-virtuoso-scroller]");
		const parent = element.parentElement;
		if (!(row instanceof HTMLElement) || !(scroller instanceof HTMLElement) || !parent) {
			throw new Error("block is not inside a transcript row");
		}
		const contentBox = (box: HTMLElement) => {
			const rect = box.getBoundingClientRect();
			const style = getComputedStyle(box);
			return {
				left:
					rect.left +
					Number.parseFloat(style.borderLeftWidth) +
					Number.parseFloat(style.paddingLeft),
				right:
					rect.right -
					Number.parseFloat(style.borderRightWidth) -
					Number.parseFloat(style.paddingRight),
			};
		};
		const box = element.getBoundingClientRect();
		const column = contentBox(row);
		const parentBox = contentBox(parent);
		const paneLeft = scroller.getBoundingClientRect().left + scroller.clientLeft;
		return {
			left: box.left,
			right: box.right,
			parentLeft: parentBox.left,
			parentRight: parentBox.right,
			columnLeft: column.left,
			columnRight: column.right,
			paneLeft,
			paneRight: paneLeft + scroller.clientWidth,
			gutter: Number.parseFloat(getComputedStyle(row).paddingLeft),
		};
	});
}

async function expectCenteredBreakout(block: Locator): Promise<void> {
	await expect
		.poll(async () => {
			const g = await geometry(block);
			return {
				grewPastColumn: g.right - g.left > g.columnRight - g.columnLeft + 1,
				fillsPane:
					Math.abs(g.left - (g.paneLeft + g.gutter)) <= 1 &&
					Math.abs(g.right - (g.paneRight - g.gutter)) <= 1,
				centeredOnColumn:
					Math.abs((g.left + g.right) / 2 - (g.columnLeft + g.columnRight) / 2) <= 1,
			};
		})
		.toEqual({ grewPastColumn: true, fillsPane: true, centeredOnColumn: true });
}

async function expectWithinPane(block: Locator): Promise<void> {
	await expect
		.poll(async () => {
			const g = await geometry(block);
			return {
				grewPastParent: g.right - g.left > g.parentRight - g.parentLeft + 1,
				withinPane: g.left >= g.paneLeft + g.gutter - 1 && g.right <= g.paneRight - g.gutter + 1,
			};
		})
		.toEqual({ grewPastParent: true, withinPane: true });
}

async function expectParentWidth(block: Locator): Promise<void> {
	await expect
		.poll(async () => {
			const g = await geometry(block);
			return Math.max(Math.abs(g.left - g.parentLeft), Math.abs(g.right - g.parentRight));
		})
		.toBeLessThanOrEqual(1);
}

async function expandTranscriptDisclosure(toggle: Locator): Promise<void> {
	if ((await toggle.getAttribute("aria-expanded")) !== "true") await clickTranscriptControl(toggle);
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function setFitToPane(page: Page, bounded: boolean): Promise<void> {
	if (!(await page.getByTestId("settings-dialog").isVisible())) {
		await page.getByTestId("open-settings").click();
	}
	await page.getByTestId("settings-nav-chat").click();
	const control = page.getByTestId("chat-line-width-bounded");
	if ((await control.getAttribute("data-active")) !== String(bounded)) {
		await control.click();
		await expect(control).toHaveAttribute("data-active", String(bounded));
	}
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("settings-dialog")).toBeHidden();
}

test("wide code blocks and tool results grow past the chat column only while it fits the pane", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 900 });
	const browser = await interceptAppWire(page);
	await openFixtureProject(page);
	const session = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: CHAT_NAME,
		messages: [{ role: "user", text: "Show me the wide output.", timestamp: BASE_TS }],
	});
	await enterDefaultWorkspace(page);
	await openPersistedChat(page, CHAT_NAME);
	await hideAuxiliaryWorkbench(page);
	await replayTranscript(browser(), session.id);

	const assistant = page
		.locator('[data-testid="chat-message"][data-role="assistant"]')
		.filter({ hasText: "route table" });
	const wideCode = assistant.locator("pre").filter({ hasText: "segment-59" }).first();
	const narrowCode = assistant.locator("pre").filter({ hasText: NARROW_LINE }).first();
	const table = assistant.locator("table").locator("xpath=..");
	const card = page.locator('[data-testid="tool-card"][data-tool="visualize"]');
	await expect(card).toHaveAttribute("data-expanded", "true");
	await expect(card.getByTestId("mermaid-svg").locator("svg")).toBeVisible({ timeout: 20_000 });
	const group = page.getByTestId("activity-group");
	await expandTranscriptDisclosure(group.getByTestId("activity-group-toggle"));
	const wideStep = group.locator('[data-testid="activity-step"]').first();
	await expandTranscriptDisclosure(wideStep.getByTestId("activity-step-toggle"));
	const wideOutput = wideStep.getByTestId("tool-bash").locator("xpath=..");

	try {
		await expectCenteredBreakout(wideCode);
		await expectCenteredBreakout(table);
		await expectCenteredBreakout(card);
		await expectWithinPane(wideOutput);
		await expectParentWidth(narrowCode);
		await expect
			.poll(() => wideOutput.locator("pre").evaluate((pre) => pre.scrollWidth > pre.clientWidth))
			.toBe(true);
		await page.setViewportSize(PHONE_VIEWPORT);
		for (const block of [wideCode, table, card, wideOutput]) {
			await expect
				.poll(async () => {
					const g = await geometry(block);
					return g.left >= g.paneLeft - 1 && g.right <= g.paneRight + 1;
				})
				.toBe(true);
		}
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
			.toBe(true);
		await page.setViewportSize({ width: 1400, height: 900 });

		await setFitToPane(page, false);
		for (const block of [wideCode, table, card, wideOutput, narrowCode])
			await expectParentWidth(block);
	} finally {
		await setFitToPane(page, true).catch(() => {});
	}
});

test("a resource child transcript keeps wide content inside its own detail pane", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1600, height: 1000 });
	await openFixtureProject(page);
	const cwd = realpathSync(E2E_FIXTURE_REPO);
	const parent = seedWorkspaceSession(cwd, {
		name: "Nested content width",
		messages: [{ role: "user", text: "Inspect the completed child.", timestamp: BASE_TS }],
	});
	const child = seedWorkspaceSession(cwd, {
		name: "Width child",
		messages: [
			{ role: "user", text: "Show wide child content.", timestamp: BASE_TS },
			{
				role: "assistant",
				timestamp: BASE_TS + 1,
				content: [
					{ type: "text", text: ASSISTANT_TEXT },
					{
						type: "toolCall",
						id: "child-bash",
						name: "bash",
						arguments: { command: "cat wide.tsv" },
					},
				],
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "child-bash",
				toolName: "bash",
				content: [{ type: "text", text: WIDE_OUTPUT }],
				isError: false,
				timestamp: BASE_TS + 2,
			},
		],
	});
	const record = JSON.parse(readFileSync(child.path, "utf8"));
	record.childRun = {
		parentSessionId: parent.id,
		toolCallId: "width-child",
		task: "Inspect wide content",
		definition: {
			name: "Width worker",
			description: "Fixture worker",
			source: "builtin",
			systemPrompt: "Fixture child",
		},
		enabledExtensions: [],
		detached: true,
		createdAt: new Date(BASE_TS).toISOString(),
		status: "completed",
		finishedAt: BASE_TS + 3,
		completionDelivered: true,
		collected: true,
	};
	writeFileSync(child.path, JSON.stringify(record));
	const wire = await E2eWire.connect();
	try {
		await wire.request("settings.update", {
			config: { chatLineWidth: 40, chatLineWidthBounded: true },
		});
		await enterDefaultWorkspace(page);
		await openPersistedChat(page, "Nested content width");
		await hideAuxiliaryWorkbench(page);
		await page.getByTestId("resources-trigger").click();
		const inspector = page.getByTestId("resources-inspector");
		const resource = inspector.getByTestId("resource-subagent").filter({ hasText: "Width worker" });
		await resource.getByRole("option").click();
		const transcript = inspector.getByTestId("subagent-transcript");
		await expect(transcript).toContainText("route table");
		const step = transcript.getByTestId("activity-step");
		await expandTranscriptDisclosure(step.getByTestId("activity-step-toggle"));
		const output = step.getByTestId("tool-bash").locator("xpath=..");
		await expect(output).toBeVisible();
		const wideCode = transcript.locator("pre").filter({ hasText: "segment-59" }).first();
		const table = transcript.locator("table").locator("xpath=..");
		for (const viewport of [{ width: 1600, height: 1000 }, PHONE_VIEWPORT]) {
			await page.setViewportSize(viewport);
			for (const block of [wideCode, table, output]) {
				await expect
					.poll(() =>
						block.evaluate((element) => {
							const pane = element.closest('[data-testid="subagent-transcript"]');
							if (!(pane instanceof HTMLElement)) throw new Error("Missing child transcript");
							const frame = element.getBoundingClientRect();
							const bounds = pane.getBoundingClientRect();
							return {
								inside:
									frame.left >= bounds.left - 1 &&
									frame.right <= bounds.left + pane.clientWidth + 1,
								noOverflow: pane.scrollWidth <= pane.clientWidth + 1,
							};
						}),
					)
					.toEqual({ inside: true, noOverflow: true });
			}
			await expect
				.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
				.toBe(true);
		}
	} finally {
		await wire
			.request("settings.update", {
				config: {
					chatLineWidth: DEFAULT_CONFIG.chatLineWidth,
					chatLineWidthBounded: DEFAULT_CONFIG.chatLineWidthBounded,
				},
			})
			.finally(() => wire.close());
	}
});
