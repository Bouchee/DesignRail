import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { Workspace, WsResult } from "@thinkrail/contracts";
import { expandActivityStep, openWorkspaceChat, revealWorkbenchTool } from "./fixtures/app";
import { clickTranscriptControl } from "./fixtures/chatScroll";
import { resolveBunExecutable } from "./fixtures/executables";
import { commitFile } from "./fixtures/git";
import { E2E_DATA_DIR } from "./fixtures/paths";
import { resolveE2eModel } from "./fixtures/sdkAgent";
import { assistantText, toolCalls } from "./fixtures/skillCompaction";
import { E2eWire } from "./fixtures/wire";

async function parentSession(wire: E2eWire, workspace: Workspace): Promise<string> {
	const sessions = await wire.request("session.list", { workspaceId: workspace.id });
	const sessionId = sessions[0]?.sessionId;
	if (!sessionId) throw new Error("The Stage 3 workspace has no parent session");
	return sessionId;
}

async function send(page: Page, text: string): Promise<void> {
	await page.getByTestId("chat-input").fill(text);
	await page.getByTestId("chat-send").click();
}

async function settle(
	wire: E2eWire,
	workspaceId: string,
	sessionId: string,
	allow: (input: Record<string, unknown>, toolName: string) => boolean = () => false,
): Promise<WsResult<"session.getMessages">> {
	const answered = new Set<string>();
	await expect
		.poll(
			async () => {
				const snapshot = await wire.request("session.getMessages", { workspaceId, sessionId });
				const pending = snapshot.summary.state?.needsInput;
				if (pending?.kind === "tool-response")
					throw new Error("The Stage 3 probe received an unexpected tool response request");
				if (pending?.kind === "dialog" && !answered.has(pending.interactionId)) {
					const request = pending.request;
					if (
						request.kind !== "confirm" ||
						!request.runId ||
						!request.toolCallId ||
						request.revision === undefined
					)
						throw new Error("The Stage 3 probe received an unexpected interaction");
					const call = snapshot.messages
						.flatMap(toolCalls)
						.find((item) => item.id === request.toolCallId);
					if (!call) throw new Error("The Stage 3 approval has no matching tool call");
					const accepted = allow(request.toolInput ?? {}, call.name);
					answered.add(pending.interactionId);
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
					if (!accepted)
						throw new Error("The model requested an effect outside this Stage 3 probe");
				}
				return snapshot.summary.state?.execution === "idle"
					? snapshot.summary.state.completion?.outcome
					: "running";
			},
			{ timeout: 150_000, intervals: [250, 500] },
		)
		.toBe("succeeded");
	return wire.request("session.getMessages", { workspaceId, sessionId });
}

test(
	"SDK Skills, instructions, Plan and Spec have real effects that survive refresh",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		const workspace = await openWorkspaceChat(page);
		const wire = await E2eWire.connect();
		const sessionId = await parentSession(wire, workspace);
		try {
			await wire.request("project.setTrust", {
				id: workspace.projectId,
				trusted: true,
				resources: true,
			});
			const skill = join(workspace.worktreePath, ".raildesign/skills/stage3-proof");
			mkdirSync(skill, { recursive: true });
			writeFileSync(
				join(skill, "SKILL.md"),
				"---\nname: stage3-proof\ndescription: Stage 3 tool connection probe\n---\nAfter the requested tool effects, include STAGE3_SKILL_BODY_READ in your final answer.\n",
			);
			writeFileSync(
				join(workspace.worktreePath, "AGENTS.md"),
				"For the Stage 3 probe, include STAGE3_WORKSPACE_RULE_READ in the final answer.\n",
			);
			await send(
				page,
				"/skill:stage3-proof This is a bounded tool connection probe. Use skill_read with name stage3-proof and path null. Use todo_write to create one group titled SDK Stage3 with one pending item titled Read workspace Skill. Use spec_create once with path stage3/SPEC.md, id stage3-proof, type module-design, title SDK Stage3 and status draft. Do no other work. Follow the Skill and workspace instructions in your final answer.",
			);
			const snapshot = await settle(
				wire,
				workspace.id,
				sessionId,
				(input) => input.path === "stage3/SPEC.md",
			);
			for (const name of ["skill_read", "todo_write", "spec_create"])
				expect(
					snapshot.messages.some(
						(message) =>
							message.role === "toolResult" && message.toolName === name && !message.isError,
					),
				).toBe(true);
			const final = snapshot.messages
				.filter((message) => message.role === "assistant")
				.findLast((message) => assistantText(message).trim().length > 0);
			if (!final) throw new Error("The Skill probe has no actual parent text answer");
			expect(assistantText(final)).toContain("STAGE3_SKILL_BODY_READ");
			expect(assistantText(final)).toContain("STAGE3_WORKSPACE_RULE_READ");
			expect(readFileSync(join(workspace.worktreePath, "stage3/SPEC.md"), "utf8")).toContain(
				"id: stage3-proof",
			);
			const plan = await wire.request("todo.list", { workspaceId: workspace.id, sessionId });
			expect(JSON.stringify(plan)).toContain("Read workspace Skill");
			await page.reload();
			await expect(page.getByTestId("connection-status")).toHaveAttribute(
				"data-status",
				"connected",
			);
			expect(await wire.request("todo.list", { workspaceId: workspace.id, sessionId })).toEqual(
				plan,
			);
			await revealWorkbenchTool(page, "plan");
			await expect(page.getByTestId("plan-rail-pane")).toContainText("SDK Stage3");
			await page.screenshot({ path: testInfo.outputPath("stage3-skill-plan-spec.png") });
			await testInfo.attach("stage3-skill-plan-spec", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify({ snapshot, plan })),
			});
		} finally {
			await wire.request("session.abort", { sessionId });
			wire.close();
		}
	},
);

test(
	"one SDK session connects Skill, Plan, Spec, MCP, child and background effects through refresh and Stop",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		const configuration = join(E2E_DATA_DIR, "mcp.json");
		const resourceCalls = join(E2E_DATA_DIR, "stage3-chain-mcp-calls.txt");
		const command = "printf 'STAGE3_CHAIN_BACKGROUND_READY\\n'; sleep 60";
		const proof: Record<string, unknown> = { phase: "setup" };
		let connection: E2eWire | undefined;
		let parentId: string | undefined;
		let workspaceId: string | undefined;
		try {
			writeFileSync(resourceCalls, "");
			writeFileSync(
				configuration,
				JSON.stringify({
					mcpServers: {
						fixture: {
							command: resolveBunExecutable(),
							args: [
								fileURLToPath(
									new URL(
										"../packages/server/src/agent/mcp/fixtures/stdioServer.ts",
										import.meta.url,
									),
								),
							],
							exposure: "direct",
							env: { MCP_FIXTURE_RESOURCES: "1", MCP_FIXTURE_RESOURCE_CALLS_FILE: resourceCalls },
						},
					},
				}),
			);
			const workspace = await openWorkspaceChat(page);
			workspaceId = workspace.id;
			const wire = await E2eWire.connect();
			connection = wire;
			const sessionId = await parentSession(wire, workspace);
			parentId = sessionId;
			Object.assign(proof, { workspaceId, sessionId });
			await wire.request("project.setTrust", {
				id: workspace.projectId,
				trusted: true,
				resources: true,
			});
			const skill = join(workspace.worktreePath, ".raildesign/skills/stage3-chain");
			mkdirSync(skill, { recursive: true });
			writeFileSync(
				join(skill, "SKILL.md"),
				"---\nname: stage3-chain\ndescription: Connected Stage 3 acceptance probe\n---\nCreate one TODO group titled Connected SDK Chain with one pending item titled Read MCP note. Create a draft module-design Spec at stage3-chain/SPEC.md with id stage3-chain and title Connected SDK Chain. After reading the MCP note, delegate to worker with a task that says Reply with exactly: STAGE3_CHAIN_CHILD: followed by the actual resource text. Include STAGE3_CHAIN_SKILL_READ in the final answer.\n",
			);
			writeFileSync(
				join(workspace.worktreePath, "AGENTS.md"),
				"For this bounded Stage 3 acceptance probe, include STAGE3_CHAIN_WORKSPACE_RULE in your final answer.\n",
			);
			expect(existsSync(join(workspace.worktreePath, "stage3-chain"))).toBe(false);
			proof.phase = "parent-run";
			await send(
				page,
				`/skill:stage3-chain This is a bounded tool-connection probe, not a coding task. The fixture has verified that the target stage3-chain directory does not exist yet and has no nested AGENTS.md; only the already-supplied root workspace instructions apply. Use only these seven tools, each exactly once in order: skill_read with name stage3-chain and path null, todo_write and spec_create as the Skill directs, list_mcp_resources with server fixture and cursor null, then read_mcp_resource with server fixture and uri fixture://notes/a. Call Agent once with subagent_type worker, model null, run_in_background false and the echo task directed by the Skill using the actual resource text. After the child returns, call background_command once with action start, name Stage3 connected background, timeout 90 and command exactly ${JSON.stringify(command)}. Do not call read, bash, search or any other tool, and do not look for nonexistent nested instruction files. Start the background command last; do not wait, poll or call another tool afterward. Report the actual resource text and child result, following the Skill and workspace instructions.`,
			);
			const snapshot = await settle(
				wire,
				workspace.id,
				sessionId,
				(input, name) =>
					(name === "spec_create" && input.path === "stage3-chain/SPEC.md") ||
					(name === "background_command" &&
						input.action === "start" &&
						input.name === "Stage3 connected background" &&
						input.timeout === 90 &&
						input.command === command),
			);
			Object.assign(proof, { phase: "effects", snapshot });
			const expected = [
				"skill_read",
				"todo_write",
				"spec_create",
				"list_mcp_resources",
				"read_mcp_resource",
				"Agent",
				"background_command",
			];
			expect(snapshot.messages.flatMap(toolCalls).map((call) => call.name)).toEqual(expected);
			for (const name of expected) {
				const results = snapshot.messages.filter(
					(message) => message.role === "toolResult" && message.toolName === name,
				);
				expect(results).toHaveLength(1);
				expect(results[0]).toMatchObject({ isError: false });
			}
			const final = snapshot.messages
				.filter((message) => message.role === "assistant")
				.findLast((message) => assistantText(message).trim().length > 0);
			if (!final) throw new Error("The connected probe has no actual parent text answer");
			for (const marker of ["STAGE3_CHAIN_SKILL_READ", "STAGE3_CHAIN_WORKSPACE_RULE"])
				expect(assistantText(final)).toContain(marker);
			const read = snapshot.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "read_mcp_resource",
			);
			expect(read).toMatchObject({ details: { server: "fixture", fullOutput: true } });
			expect(JSON.stringify(read)).toContain("MCP resource fixture note");
			expect(readFileSync(resourceCalls, "utf8").trim().split("\n")).toEqual(["fixture://notes/a"]);
			const specPath = join(workspace.worktreePath, "stage3-chain/SPEC.md");
			const spec = readFileSync(specPath, "utf8");
			expect(spec).toContain("id: stage3-chain");
			expect(
				(await wire.request("spec.graph", { workspaceId: workspace.id })).nodes,
			).toContainEqual(
				expect.objectContaining({
					id: "stage3-chain",
					path: "stage3-chain/SPEC.md",
					status: "draft",
				}),
			);
			const plan = await wire.request("todo.list", { workspaceId: workspace.id, sessionId });
			expect(JSON.stringify(plan)).toContain("Read MCP note");
			const resources = await wire.request("session.resources", {
				workspaceId: workspace.id,
				sessionId,
			});
			Object.assign(proof, { phase: "child-evidence", plan, spec, resources });
			expect(resources.subagents).toHaveLength(1);
			const child = resources.subagents[0];
			if (!child) throw new Error("The connected probe has no child resource");
			const target = resolveE2eModel();
			expect(child).toMatchObject({
				parentSessionId: sessionId,
				status: "completed",
				model: `${target.provider}/${target.id}`,
			});
			expect(child.task).toContain("STAGE3_CHAIN_CHILD");
			expect(child.task).toContain("MCP resource fixture note");
			const transcript = await wire.request("subagent.getTranscript", {
				workspaceId: workspace.id,
				parentSessionId: sessionId,
				childSessionId: child.childSessionId,
			});
			proof.transcript = transcript;
			expect(transcript.status).toBe("completed");
			const assistants = transcript.messages.filter((message) => message.role === "assistant");
			const answer = assistants.findLast((message) => assistantText(message).trim().length > 0);
			if (!answer) throw new Error("The connected child transcript has no actual text answer");
			expect(answer).toMatchObject({ provider: target.provider, model: target.id });
			expect(
				assistants.reduce((total, message) => total + message.usage.output, 0),
			).toBeGreaterThan(0);
			expect(assistantText(answer)).toContain("STAGE3_CHAIN_CHILD: MCP resource fixture note");
			const childReturn = snapshot.messages
				.filter((message) => message.role === "toolResult")
				.find((message) => message.toolName === "Agent");
			expect(JSON.stringify(childReturn?.content)).toContain(
				"STAGE3_CHAIN_CHILD: MCP resource fixture note",
			);
			expect(resources.commands).toHaveLength(1);
			const running = resources.commands[0];
			if (!running) throw new Error("The connected probe has no background command");
			expect(running).toMatchObject({ command, status: "running" });
			expect(resources.mcpServers).toEqual([
				expect.objectContaining({ name: "fixture", state: "connected", transport: "stdio" }),
			]);
			proof.phase = "reload";
			await page.reload();
			await expect(page.getByTestId("connection-status")).toHaveAttribute(
				"data-status",
				"connected",
			);
			await expect(page.getByTestId("resources-trigger")).toHaveAttribute("data-active-count", "2");
			expect(
				(await wire.request("session.getMessages", { workspaceId: workspace.id, sessionId }))
					.messages,
			).toEqual(snapshot.messages);
			expect(await wire.request("todo.list", { workspaceId: workspace.id, sessionId })).toEqual(
				plan,
			);
			expect(readFileSync(specPath, "utf8")).toBe(spec);
			const restored = await wire.request("session.resources", {
				workspaceId: workspace.id,
				sessionId,
			});
			expect(restored.commands).toEqual(resources.commands);
			expect(restored.subagents).toEqual(resources.subagents);
			expect(restored.mcpServers).toEqual(resources.mcpServers);
			Object.assign(proof, { phase: "rendered-effects", restored });
			const mcp = await expandActivityStep(page, "read_mcp_resource");
			await expect(mcp.getByTestId("tool-read_mcp_resource")).toContainText(
				"MCP resource fixture note",
			);
			const card = page.locator('[data-testid="tool-card"][data-tool="Agent"]');
			await clickTranscriptControl(card.getByTestId("tool-card-toggle"));
			await clickTranscriptControl(card.getByTestId("agent-open-transcript"));
			await expect(page.getByTestId("subagent-transcript-dialog")).toContainText(
				"STAGE3_CHAIN_CHILD: MCP resource fixture note",
			);
			await page.keyboard.press("Escape");
			await revealWorkbenchTool(page, "plan");
			await expect(page.getByTestId("plan-rail-pane")).toContainText("Connected SDK Chain");
			await page.getByTestId("resources-trigger").click();
			const row = page.locator(
				`[data-testid="resource-command"][data-resource-id="${running.id}"]`,
			);
			await expect(row).toHaveAttribute("data-status", "running");
			await row.getByRole("option").click();
			await expect(page.getByTestId("command-log-output")).toContainText(
				"STAGE3_CHAIN_BACKGROUND_READY",
			);
			proof.phase = "stop";
			await wire.request("session.abort", { sessionId });
			const stopped = await wire.request("session.resources", {
				workspaceId: workspace.id,
				sessionId,
			});
			proof.stopped = stopped;
			await expect(row).toHaveAttribute("data-status", "stopped");
			await expect(page.getByTestId("resources-trigger")).toHaveAttribute("data-active-count", "0");
			expect(stopped.commands).toHaveLength(1);
			expect(stopped.commands[0]).toMatchObject({ id: running.id, status: "stopped" });
			expect(stopped.subagents).toEqual([child]);
			expect(stopped.mcpServers).toEqual([]);
			const output = await wire.request("backgroundCommand.output", {
				workspaceId: workspace.id,
				sessionId,
				commandId: running.id,
			});
			expect(output.available && output.output.text.includes("STAGE3_CHAIN_BACKGROUND_READY")).toBe(
				true,
			);
			Object.assign(proof, { phase: "stopped", stopped, output });
			await page.screenshot({ path: testInfo.outputPath("stage3-connected-chain.png") });
		} finally {
			try {
				if (connection && parentId && workspaceId) {
					try {
						proof.latestSnapshot = await connection.request("session.getMessages", {
							workspaceId,
							sessionId: parentId,
						});
					} catch (error) {
						proof.snapshotReadError = error instanceof Error ? error.message : String(error);
					}
				}
				try {
					proof.resourceReads = readFileSync(resourceCalls, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean);
				} catch (error) {
					proof.resourceTraceReadError = error instanceof Error ? error.message : String(error);
				}
				await testInfo.attach("stage3-connected-chain", {
					contentType: "application/json",
					body: Buffer.from(JSON.stringify(proof)),
				});
			} finally {
				try {
					if (connection && parentId)
						await connection.request("session.abort", { sessionId: parentId });
				} finally {
					connection?.close();
					rmSync(configuration, { force: true });
					rmSync(resourceCalls, { force: true });
				}
			}
		}
	},
);

test(
	"a background command survives refresh and parent Stop retains its output",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		const workspace = await openWorkspaceChat(page);
		const wire = await E2eWire.connect();
		const sessionId = await parentSession(wire, workspace);
		const command = "printf 'STAGE3_BACKGROUND_READY\\n'; sleep 60";
		try {
			await send(
				page,
				`Call background_command exactly once with action start, name Stage3 background, timeout 90, command exactly: ${command}. Then reply STARTED. Do not wait, poll or call another tool.`,
			);
			await settle(wire, workspace.id, sessionId, (input) => input.command === command);
			const resources = await wire.request("session.resources", {
				workspaceId: workspace.id,
				sessionId,
			});
			const running = resources.commands.find((entry) => entry.name === "Stage3 background");
			if (!running) throw new Error("The model did not start the background command");
			expect(running.status).toBe("running");
			await expect
				.poll(async () => {
					const result = await wire.request("backgroundCommand.output", {
						workspaceId: workspace.id,
						sessionId,
						commandId: running.id,
					});
					return result.available ? result.output.text : "";
				})
				.toContain("STAGE3_BACKGROUND_READY");
			await page.reload();
			await expect(page.getByTestId("resources-trigger")).toHaveAttribute("data-active-count", "1");
			await wire.request("session.abort", { sessionId });
			await expect
				.poll(async () => {
					const stopped = await wire.request("session.resources", {
						workspaceId: workspace.id,
						sessionId,
					});
					return stopped.commands.find((entry) => entry.id === running.id)?.status;
				})
				.toBe("stopped");
			const output = await wire.request("backgroundCommand.output", {
				workspaceId: workspace.id,
				sessionId,
				commandId: running.id,
			});
			expect(output.available && output.output.text.includes("STAGE3_BACKGROUND_READY")).toBe(true);
			await expect(page.getByTestId("resources-trigger")).toHaveAttribute("data-active-count", "0");
			await testInfo.attach("stage3-background-stop", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify({ resources, output })),
			});
		} finally {
			await wire.request("session.abort", { sessionId });
			wire.close();
		}
	},
);

test(
	"SDK web tools call DeepSeek Search and Fetch and display their real results",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		const workspace = await openWorkspaceChat(page);
		const wire = await E2eWire.connect();
		const sessionId = await parentSession(wire, workspace);
		const configuration = process.env.RAILDESIGN_DEEPSEEK_E2E_CONFIG;
		if (!configuration)
			throw new Error("Set RAILDESIGN_DEEPSEEK_E2E_CONFIG for the Stage 3 web acceptance test");
		if ((statSync(configuration).mode & 0o077) !== 0)
			throw new Error("The web acceptance configuration must be owner-only");
		const config: unknown = JSON.parse(readFileSync(configuration, "utf8"));
		if (
			!config ||
			typeof config !== "object" ||
			!("apiKey" in config) ||
			typeof config.apiKey !== "string" ||
			!("baseURL" in config) ||
			config.baseURL !== "https://api.deepseek.com"
		)
			throw new Error(
				"The web acceptance configuration must select the authorized DeepSeek endpoint",
			);
		const path = join(E2E_DATA_DIR, "web-access.json");
		writeFileSync(path, JSON.stringify({ apiKey: config.apiKey }), { mode: 0o600 });
		try {
			expect(await wire.request("webAccess.status", {})).toEqual({ configured: true });
			await send(
				page,
				'This is a web tool probe. Call web_search once with query "DeepSeek" and count 1. Call web_fetch once with url "https://api-docs.deepseek.com/guides/search/". Call no other tools. Then reply WEB_TOOLS_DONE.',
			);
			const snapshot = await settle(wire, workspace.id, sessionId);
			await testInfo.attach("stage3-web-results", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify(snapshot)),
			});
			for (const name of ["web_search", "web_fetch"]) {
				const result = snapshot.messages.find(
					(message) => message.role === "toolResult" && message.toolName === name,
				);
				if (result?.role !== "toolResult") throw new Error(`The model did not call ${name}`);
				expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
				expect(result.details).toMatchObject({ provider: "DeepSeek" });
				if (name === "web_search")
					expect(result.details).toMatchObject({
						results: expect.arrayContaining([expect.objectContaining({ url: expect.any(String) })]),
					});
				else {
					expect(result.details).toMatchObject({
						url: "https://api-docs.deepseek.com/guides/search/",
					});
					expect(JSON.stringify(result.content).length).toBeGreaterThan(200);
				}
			}
			const search = await expandActivityStep(page, "web_search");
			await expect(search.getByTestId("tool-web_search")).toBeVisible();
			const fetched = await expandActivityStep(page, "web_fetch");
			await expect(fetched.getByTestId("tool-web_fetch")).toBeVisible();
			await page.screenshot({ path: testInfo.outputPath("stage3-deepseek-web.png") });
		} finally {
			rmSync(path, { force: true });
			await wire.request("session.abort", { sessionId });
			wire.close();
		}
	},
);

test(
	"the Plan review button runs an independent SDK child and restores its verdict",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		test.setTimeout(240_000);
		const workspace = await openWorkspaceChat(page);
		const wire = await E2eWire.connect();
		const sessionId = await parentSession(wire, workspace);
		try {
			await wire.request("settings.update", { config: { reviewAutoFix: false } });
			const sha = commitFile(
				workspace.worktreePath,
				"stage3-review.ts",
				"export const stage3Value = 3;\n",
				"feat: export stage3Value",
			);
			const directory = join(workspace.worktreePath, ".raildesign/context/todos");
			mkdirSync(directory, { recursive: true });
			const now = new Date().toISOString();
			writeFileSync(
				join(directory, `${sessionId}.json`),
				JSON.stringify({
					version: 6,
					groups: [],
					todos: [
						{
							id: "t_stage3_review",
							title: "Export stage3Value with value 3",
							note: "Add a module that exports the numeric constant stage3Value = 3. No callers are required.",
							status: "done",
							origin: "agent",
							artifacts: [{ kind: "commit", sha, label: "Export stage3Value" }],
							createdAt: now,
							updatedAt: now,
						},
					],
				}),
			);
			await revealWorkbenchTool(page, "plan");
			await page.getByTestId("plan-rail-pane").getByTestId("todo-open-plan").click();
			const item = page.locator("#plan-item-t_stage3_review");
			await expect(item.getByTestId("plan-start-review")).toBeEnabled();
			await item.hover();
			await item.getByTestId("plan-start-review").click();
			await expect
				.poll(
					async () => {
						const plan = await wire.request("todo.list", { workspaceId: workspace.id, sessionId });
						return plan.todos.find((todo) => todo.id === "t_stage3_review")?.review?.state;
					},
					{ timeout: 180_000, intervals: [250, 500] },
				)
				.toMatch(/^(reviewed|changes_requested)$/);
			const resources = await wire.request("session.resources", {
				workspaceId: workspace.id,
				sessionId,
			});
			const reviewer = resources.subagents.find((child) => child.roleName === "Plan reviewer");
			if (!reviewer) throw new Error("The review button did not create its owned SDK child");
			expect(reviewer.status).toBe("completed");
			const transcript = await wire.request("subagent.getTranscript", {
				workspaceId: workspace.id,
				parentSessionId: sessionId,
				childSessionId: reviewer.childSessionId,
			});
			expect(transcript.messages.some((message) => message.role === "assistant")).toBe(true);
			expect(JSON.stringify(transcript.messages)).toContain("verdict");
			const plan = await wire.request("todo.list", { workspaceId: workspace.id, sessionId });
			await page.reload();
			await expect(page.locator("#plan-item-t_stage3_review")).toHaveAttribute(
				"data-reviewing",
				"false",
			);
			expect(await wire.request("todo.list", { workspaceId: workspace.id, sessionId })).toEqual(
				plan,
			);
			await testInfo.attach("stage3-plan-review", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify({ plan, resources, transcript })),
			});
		} finally {
			await wire.request("session.abort", { sessionId });
			wire.close();
		}
	},
);
