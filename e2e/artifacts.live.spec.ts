import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ToolCall, Workspace, WsResult } from "@thinkrail/contracts";
import { expandAllRoutineGroups, openWorkspaceChat, revealWorkbenchTool } from "./fixtures/app";
import { resolveE2eModel } from "./fixtures/sdkAgent";
import { toolCalls } from "./fixtures/skillCompaction";
import { E2eWire } from "./fixtures/wire";

const PATH = ".raildesign/context/sdk-artifacts-proof.md";
const V1 = "ARTIFACTS_V1\n";
const V2 = "ARTIFACTS_V2\n";
const CREATE = { path: PATH, original: null, diff: "+ARTIFACTS_V1\n+\n" };
const UPDATE = { path: PATH, original: V1, diff: "@@\n-ARTIFACTS_V1\n+ARTIFACTS_V2\n" };
const COMMAND = "mkdir -p out && printf 'ARTIFACTS_BUILD\\n' > out/result.txt";
const DIAGRAM = {
	type: "diagram",
	title: "SDK Artifacts Diagram",
	mermaid: "flowchart LR\n  A[SDK] --> B[Artifact]",
};
const COMPARISON = {
	type: "comparison",
	title: "SDK Artifacts Comparison",
	options: [
		{ name: "One", pros: ["ARTIFACTS_ONE_PRO"], cons: ["ARTIFACTS_ONE_CON"], recommended: true },
		{ name: "Two", pros: ["ARTIFACTS_TWO_PRO"], cons: ["ARTIFACTS_TWO_CON"] },
	],
};
function exact(input: Record<string, unknown>, expected: Record<string, unknown>): boolean {
	return (
		Object.keys(input).length === Object.keys(expected).length &&
		Object.entries(expected).every(([key, value]) => input[key] === value)
	);
}
async function sendTurn(
	page: Page,
	wire: E2eWire,
	workspace: Workspace,
	sessionId: string,
	marker: string,
	instructions: unknown[],
	allow: (input: Record<string, unknown>, name: string) => boolean,
) {
	const previous = await wire.request("session.getMessages", {
		workspaceId: workspace.id,
		sessionId,
	});
	const completionId = previous.summary.state?.completion?.completionId;
	const priorCalls = new Set(previous.messages.flatMap(toolCalls).map((call) => call.id));
	const approved: string[] = [];
	await page
		.getByTestId("chat-input")
		.fill(
			`${marker}. Execute exactly these tools in order, without any additional tools. All file edits are explicitly requested and their exact original text is supplied. The tool field names the tool and is not a tool argument. Finish with ${marker}_DONE.\n${JSON.stringify(instructions)}`,
		);
	await page.getByTestId("chat-send").click();
	await expect
		.poll(
			async () => {
				const snapshot = await wire.request("session.getMessages", {
					workspaceId: workspace.id,
					sessionId,
				});
				const state = snapshot.summary.state;
				const pending = state?.needsInput;
				if (pending?.kind === "tool-response")
					throw new Error("Unexpected tool response interaction");
				if (pending?.kind === "dialog" && !approved.includes(pending.interactionId)) {
					const request = pending.request;
					if (
						request.kind !== "confirm" ||
						!request.runId ||
						!request.toolCallId ||
						request.revision === undefined
					)
						throw new Error("Unexpected artifact interaction");
					const call = snapshot.messages
						.flatMap(toolCalls)
						.find((call) => call.id === request.toolCallId);
					if (!call) throw new Error("Approval has no matching tool call");
					const accepted = allow(request.toolInput ?? {}, call.name);
					approved.push(pending.interactionId);
					await wire.request("session.extUiReply", {
						response: {
							id: request.id,
							sessionId,
							runId: request.runId,
							toolCallId: request.toolCallId,
							revision: request.revision,
							value: accepted,
						},
					});
					if (!accepted) throw new Error(`Unexpected artifact effect: ${call.name}`);
				}
				if (
					state?.execution !== "idle" ||
					state.needsInput !== null ||
					!state.completion ||
					state.completion.completionId === completionId
				)
					return "pending";
				return state.completion.outcome;
			},
			{ timeout: 150000, intervals: [250, 500] },
		)
		.toBe("succeeded");
	const snapshot = await wire.request("session.getMessages", {
		workspaceId: workspace.id,
		sessionId,
	});
	const calls = snapshot.messages.flatMap(toolCalls).filter((call) => !priorCalls.has(call.id));
	for (const call of calls) {
		const results = snapshot.messages.filter(
			(message) => message.role === "toolResult" && message.toolCallId === call.id,
		);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ isError: false });
	}
	expect(JSON.stringify(snapshot.messages.filter((message) => message.role === "user"))).toContain(
		marker,
	);
	return { snapshot, calls, approved };
}
function artifactRow(page: Page, path: string) {
	return page.locator(`[data-testid="artifact-row"][data-path="${path}"]`);
}
function checkCalls(calls: ToolCall[], expected: string[]) {
	expect(calls.map((call) => call.name)).toEqual(expected);
}

test(
	"SDK artifacts retain the latest patch, saved visualizations and ignored output through explicit Restore",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		test.setTimeout(360000);
		const workspace = await openWorkspaceChat(page);
		const wire = await E2eWire.connect();
		const sessionId = (await wire.request("session.list", { workspaceId: workspace.id }))[0]
			?.sessionId;
		if (!sessionId) {
			wire.close();
			throw new Error("Missing fresh SDK artifact session");
		}
		const proof: Record<string, unknown> = { workspaceId: workspace.id, sessionId, phase: "setup" };
		try {
			await wire.request("project.setTrust", {
				id: workspace.projectId,
				trusted: true,
				resources: true,
			});
			writeFileSync(join(workspace.worktreePath, ".gitignore"), "out/\n", { flag: "a" });
			const initial = await wire.request("artifacts.list", { workspaceId: workspace.id });
			const existing = new Set(initial.artifacts.map((artifact) => artifact.path));
			proof.phase = "v1";
			const first = await sendTurn(
				page,
				wire,
				workspace,
				sessionId,
				"ARTIFACTS_FIRST",
				[
					{ tool: "apply_patch", ...CREATE },
					{ tool: "visualize", ...DIAGRAM },
					{ tool: "visualize", ...COMPARISON },
				],
				(input, name) => name === "apply_patch" && exact(input, CREATE),
			);
			proof.first = first;
			checkCalls(first.calls, ["apply_patch", "visualize", "visualize"]);
			expect(
				(await wire.request("fs.readFile", { workspaceId: workspace.id, path: PATH })).content,
			).toBe(V1);
			const target = resolveE2eModel();
			const assistants = first.snapshot.messages.filter((message) => message.role === "assistant");
			expect(assistants.at(-1)).toMatchObject({ provider: target.provider, model: target.id });
			expect(
				assistants.reduce((total, message) => total + message.usage.output, 0),
			).toBeGreaterThan(0);
			const v1 = await wire.request("artifacts.list", { workspaceId: workspace.id });
			const original = v1.artifacts.find((artifact) => artifact.path === PATH);
			expect(original).toMatchObject({ state: "live", sessionId });
			const visualizations = v1.artifacts.filter(
				(artifact) => !existing.has(artifact.path) && artifact.path.includes("/visualize/"),
			);
			expect(visualizations).toHaveLength(2);
			const saved: Record<string, string> = {};
			for (const artifact of visualizations) {
				expect(artifact).toMatchObject({
					state: "live",
					sessionId,
					role: "result",
					reason: "shown",
					rounds: [expect.objectContaining({ sessionId })],
				});
				const text = (
					await wire.request("fs.readFile", { workspaceId: workspace.id, path: artifact.path })
				).content;
				saved[artifact.path] = text;
				const result = first.snapshot.messages.find(
					(message) =>
						message.role === "toolResult" &&
						JSON.stringify(message.content).includes(artifact.path),
				);
				if (result?.role !== "toolResult") throw new Error("Missing saved visualization result");
				expect(result.details).toMatchObject(text.includes(DIAGRAM.title) ? DIAGRAM : COMPARISON);
			}
			expect(
				Object.values(saved).some(
					(text) => text.includes("```mermaid") && text.includes(DIAGRAM.mermaid),
				),
			).toBe(true);
			const comparison = Object.values(saved).find((text) => text.includes(COMPARISON.title));
			for (const text of [
				"ARTIFACTS_ONE_PRO",
				"ARTIFACTS_ONE_CON",
				"ARTIFACTS_TWO_PRO",
				"ARTIFACTS_TWO_CON",
				"One — ✅ Recommended",
			])
				expect(comparison).toContain(text);
			await expect(page.getByTestId("turn-divider-artifacts")).toHaveText("3 artifacts");
			proof.phase = "v2";
			const second = await sendTurn(
				page,
				wire,
				workspace,
				sessionId,
				"ARTIFACTS_SECOND",
				[
					{ tool: "apply_patch", ...UPDATE },
					{ tool: "bash", command: COMMAND, timeoutMs: 10000 },
				],
				(input, name) =>
					name === "apply_patch"
						? exact(input, UPDATE)
						: name === "bash" && exact(input, { command: COMMAND, timeoutMs: 10000 }),
			);
			proof.second = second;
			checkCalls(second.calls, ["apply_patch", "bash"]);
			expect(second.snapshot.summary.state?.completion?.completionId).not.toBe(
				first.snapshot.summary.state?.completion?.completionId,
			);
			expect(
				(await wire.request("fs.readFile", { workspaceId: workspace.id, path: PATH })).content,
			).toBe(V2);
			await expect
				.poll(async () =>
					(await wire.request("artifacts.list", { workspaceId: workspace.id })).outputs?.find(
						(output) => output.path === "out",
					),
				)
				.toMatchObject({ files: 1, sessionId });
			expect(
				(await wire.request("fs.readFile", { workspaceId: workspace.id, path: "out/result.txt" }))
					.content,
			).toBe("ARTIFACTS_BUILD\n");
			const updated = await wire.request("artifacts.list", { workspaceId: workspace.id });
			const updatedRows = updated.artifacts.filter((artifact) => artifact.path === PATH);
			expect(updatedRows).toHaveLength(1);
			expect(updatedRows[0]).toMatchObject({ sessionId, firstSeenAt: original?.firstSeenAt });
			expect(updatedRows[0]?.changedAt).toBeGreaterThanOrEqual(original?.changedAt ?? 0);
			proof.updated = updated;
			proof.phase = "delete-restore";
			rmSync(join(workspace.worktreePath, PATH));
			await expect
				.poll(
					async () =>
						(await wire.request("artifacts.list", { workspaceId: workspace.id })).artifacts.find(
							(artifact) => artifact.path === PATH,
						)?.state,
				)
				.toBe("deleted");
			await revealWorkbenchTool(page, "artifacts");
			await page.getByTestId("artifacts-view-list").click();
			await expect(artifactRow(page, PATH)).toHaveAttribute("data-state", "deleted");
			await artifactRow(page, PATH).getByTestId("artifact-restore").click();
			await expect(artifactRow(page, PATH)).toHaveAttribute("data-state", "live");
			expect(
				(await wire.request("fs.readFile", { workspaceId: workspace.id, path: PATH })).content,
			).toBe(V2);
			proof.restored = await wire.request("artifacts.list", { workspaceId: workspace.id });
			const restored = (proof.restored as WsResult<"artifacts.list">).artifacts.find(
				(artifact) => artifact.path === PATH,
			);
			expect(restored).toMatchObject({
				state: "live",
				firstSeenAt: original?.firstSeenAt,
				sessionId,
			});
			proof.phase = "reload";
			await page.reload();
			await expect(page.getByTestId("connection-status")).toHaveAttribute(
				"data-status",
				"connected",
			);
			for (const [path, content] of Object.entries({ [PATH]: V2, ...saved }))
				expect(
					(await wire.request("fs.readFile", { workspaceId: workspace.id, path })).content,
				).toBe(content);
			await revealWorkbenchTool(page, "artifacts");
			for (const path of [PATH, ...Object.keys(saved)])
				await expect(artifactRow(page, path)).toBeVisible();
			await expandAllRoutineGroups(page);
			const cards = page.locator('[data-testid="tool-card"][data-tool="visualize"]');
			await expect(cards).toHaveCount(2);
			for (const card of await cards.all())
				if ((await card.getAttribute("data-expanded")) !== "true")
					await card.getByTestId("tool-card-toggle").click();
			await expect(cards.nth(0).getByTestId("mermaid-svg").locator("svg")).toBeVisible();
			await expect(cards.nth(1).getByTestId("tool-visualize-comparison")).toContainText(
				"ARTIFACTS_ONE_PRO",
			);
			await expect(cards.nth(1).locator('[data-recommended="true"]')).toContainText("One");
			await artifactRow(page, PATH).getByTestId("artifact-open").click();
			await expect(
				page.getByTestId("editor-tab").filter({ hasText: "sdk-artifacts-proof.md" }),
			).toBeVisible();
			await expect(page.getByTestId("markdown-preview")).toContainText("ARTIFACTS_V2");
			for (const [path, content] of Object.entries(saved)) {
				await artifactRow(page, path).getByTestId("artifact-open").click();
				const preview = page.getByTestId("markdown-preview");
				await expect(preview).toContainText(
					content.includes(DIAGRAM.title) ? DIAGRAM.title : COMPARISON.title,
				);
				if (content.includes(DIAGRAM.title))
					await expect(preview.getByTestId("mermaid-svg").locator("svg")).toBeVisible();
			}
			proof.phase = "complete";
			await page.screenshot({ path: testInfo.outputPath("artifacts-sdk.png") });
		} finally {
			const proofPath = testInfo.outputPath("artifacts-sdk-proof.json");
			writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
			await testInfo.attach("artifacts-sdk-proof", {
				path: proofPath,
				contentType: "application/json",
			});
			try {
				await wire.request("session.abort", { sessionId });
			} finally {
				wire.close();
			}
		}
	},
);
