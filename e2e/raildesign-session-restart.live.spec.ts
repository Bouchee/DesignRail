import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { toolHomeEnv } from "@thinkrail/shared/toolHomes";
import { hermeticE2ePath, hermeticE2eShell, resolveBunExecutable } from "./fixtures/executables";
import {
	E2E_FAKE_BIN_DIR,
	E2E_FIXTURE_REPO,
	E2E_RESTART_DATA_DIR,
	E2E_RESTART_HOST_LOG,
	E2E_RESTART_PORT,
} from "./fixtures/paths";
import { seedAgentConfiguration, seedE2eDefaultModel } from "./fixtures/sdkAgent";
import { E2eWire, E2eWireTransientError } from "./fixtures/wire";

const restartCases = {
	ordinary: "host restart restores approval and queue without repeating a completed effect",
	sandbox: "Sandbox host restart restores approval and settles interrupted effects",
	memory: "Sandbox host restart restores SDK-generated memory and the current worktree",
};

for (const [mode, title] of Object.entries(restartCases)) {
	const sandbox = mode !== "ordinary";
	test(
		title,
		{
			tag: "@agent",
		},
		async ({ page }, testInfo) => {
			test.skip(
				sandbox && process.platform === "win32",
				"The Unix-local SDK requires macOS or Linux",
			);
			test.setTimeout(sandbox ? 300_000 : 240_000);
			rmSync(E2E_RESTART_DATA_DIR, { recursive: true, force: true });
			mkdirSync(join(E2E_RESTART_DATA_DIR, "home"), { recursive: true });
			seedAgentConfiguration(E2E_RESTART_DATA_DIR);
			const origin = `http://localhost:${E2E_RESTART_PORT}`;
			const lock = join(E2E_RESTART_DATA_DIR, "host.lock");
			const startHost = () => {
				const log = openSync(E2E_RESTART_HOST_LOG, "a", 0o600);
				try {
					const preload = process.env.RAILDESIGN_SANDBOX_LIVE_PREFLIGHT;
					const args = preload
						? ["--preload", preload, "packages/server/src/dev.ts"]
						: ["packages/server/src/dev.ts"];
					return spawn(resolveBunExecutable(), args, {
						cwd: fileURLToPath(new URL("..", import.meta.url)),
						env: {
							...process.env,
							...toolHomeEnv(join(E2E_RESTART_DATA_DIR, "home")),
							THINKRAIL_HOST: "localhost",
							THINKRAIL_PORT: String(E2E_RESTART_PORT),
							THINKRAIL_DATA_DIR: E2E_RESTART_DATA_DIR,
							THINKRAIL_STATIC_DIR: fileURLToPath(new URL("../apps/web/dist", import.meta.url)),
							THINKRAIL_GH_OFFLINE: "1",
							PATH: hermeticE2ePath(E2E_FAKE_BIN_DIR),
							SHELL: hermeticE2eShell(E2E_FAKE_BIN_DIR),
							DISPLAY: "",
							WAYLAND_DISPLAY: "",
							CI: "1",
						},
						stdio: ["ignore", log, log],
					});
				} finally {
					closeSync(log);
				}
			};
			let host = startHost();
			let wire: E2eWire | undefined;
			const waitForHost = async () => {
				await expect
					.poll(
						async () => {
							if (host.exitCode !== null || host.signalCode !== null)
								throw new Error("The isolated restart host exited before readiness");
							return fetch(`${origin}/health`)
								.then((response) => response.status)
								.catch(() => 0);
						},
						{ timeout: 30_000 },
					)
					.toBe(200);
			};
			const crash = async () => {
				host.kill("SIGKILL");
				await once(host, "exit");
				await expect
					.poll(() => (existsSync(lock) ? Date.now() - statSync(lock).mtimeMs : 11_000), {
						timeout: 20_000,
					})
					.toBeGreaterThan(10_000);
			};
			try {
				await waitForHost();
				wire = await E2eWire.connect(E2E_RESTART_PORT);
				await seedE2eDefaultModel(wire);
				const project = await wire.request("project.open", { path: E2E_FIXTURE_REPO });
				const workspace = await wire.request("workspace.create", { projectId: project.id }, 30_000);
				const { sessionId } = await wire.request("session.create", { workspaceId: workspace.id });
				if (mode === "memory") {
					await wire.request("session.setSandbox", { sessionId, enabled: true });
					await wire.request("session.setSandboxMemory", { sessionId, enabled: true });
					const tag = "COBALT-INSPECTION-4108";
					const query = { sessionId, workspaceId: workspace.id };
					await wire.request(
						"session.prompt",
						{
							sessionId,
							messageId: "native-memory-save",
							text: `From now on, prefix every sample inspection report in this chat with ${tag}. This is my standing preference for future reports. Reply with just the prefix. No tool is needed for this message.`,
						},
						140_000,
					);
					const storage = join(E2E_RESTART_DATA_DIR, "sessions", `${sessionId}.json`);
					await expect
						.poll(
							() => {
								const { sandboxArchive } = JSON.parse(readFileSync(storage, "utf8"));
								return Boolean(sandboxArchive?.data && sandboxArchive?.sessionId === sessionId);
							},
							{ timeout: 140_000 },
						)
						.toBe(true);
					wire.close();
					await crash();
					host = startHost();
					await waitForHost();
					wire = await E2eWire.connect(E2E_RESTART_PORT);
					const file = { workspaceId: workspace.id, path: "README.md" };
					const newer = "# README after the SDK memory archive\n";
					writeFileSync(join(workspace.worktreePath, file.path), newer);
					const restored = await wire.request("session.getMessages", query);
					expect(restored.summary.state?.sandboxMemory).toBe(true);
					const previousMessageIds = new Set(restored.messages.map(({ id }) => id));
					await wire.request(
						"session.prompt",
						{
							sessionId,
							messageId: "native-memory-restore",
							text: "Use read_memory on memories/memory_summary.md exactly once. Report the saved sample inspection label from the tool result.",
						},
						140_000,
					);
					const restoredWire = wire;
					const readSavedMemory = async () => {
						const snapshot = await restoredWire.request("session.getMessages", query);
						if (snapshot.summary.state?.completion?.outcome !== "succeeded") return undefined;
						const newMessages = snapshot.messages.filter(({ id }) => !previousMessageIds.has(id));
						return newMessages.find(
							(message, index) =>
								message.role === "toolResult" &&
								message.toolName === "read_memory" &&
								!message.isError &&
								newMessages.some(
									(call) =>
										call.role === "assistant" &&
										call.content.some(
											(item) =>
												item.type === "toolCall" &&
												item.id === message.toolCallId &&
												item.name === "read_memory" &&
												item.arguments?.path === "memories/memory_summary.md",
										),
								) &&
								JSON.stringify(message.content).includes(tag) &&
								newMessages
									.slice(index + 1)
									.some(
										(answer) =>
											answer.role === "assistant" &&
											answer.content.some(
												(item) => item.type === "text" && item.text.includes(tag),
											),
									),
						);
					};
					await expect.poll(readSavedMemory, { timeout: 140_000 }).toBeDefined();
					const memoryResult = await readSavedMemory();
					expect((await wire.request("fs.readFile", file)).content).toBe(newer);
					expect((await wire.request("git.diffFile", file)).modified).toBe(newer);
					await testInfo.attach("native-memory-proof", {
						contentType: "application/json",
						body: Buffer.from(JSON.stringify({ sessionId, memoryResult, currentWorktree: newer })),
					});
					return;
				}
				const marker = join(workspace.worktreePath, "restart-effect.marker");
				if (sandbox) {
					await wire.request("session.setSandbox", { sessionId, enabled: true });
					writeFileSync(marker, "Pending approved removal\n");
				}
				const command = sandbox
					? "rm -- restart-effect.marker"
					: "printf 'RESTART_EFFECT\\n' >> restart-effect.marker";
				const prompt = wire
					.request(
						"session.prompt",
						{
							sessionId,
							messageId: "restart-initial",
							text: `Use bash exactly once, timeoutMs 10000, command exactly: ${command}. Use no other tool. Then reply RESTART_DONE.`,
						},
						120_000,
					)
					.catch((error: unknown) => error);
				const initialWire = wire;
				await expect
					.poll(
						async () =>
							(
								await initialWire.request("session.getMessages", {
									sessionId,
									workspaceId: workspace.id,
								})
							).summary.state?.needsInput?.kind,
						{ timeout: 60_000 },
					)
					.toBe("dialog");
				await wire.request("session.followUp", {
					sessionId,
					messageId: "restart-followup",
					text: "Reply only RESTART_FOLLOWUP. Use no tools.",
				});
				const waiting = await wire.request("session.getMessages", {
					sessionId,
					workspaceId: workspace.id,
				});
				const pending = waiting.summary.state?.needsInput;
				if (pending?.kind !== "dialog" || pending.request.kind !== "confirm")
					throw new Error("No pending tool approval before restart");
				if (sandbox) expect(readFileSync(marker, "utf8")).toBe("Pending approved removal\n");
				const { runId, revision, toolCallId } = pending.request;
				if (!runId || revision === undefined || !toolCallId)
					throw new Error("The saved tool approval has incomplete ownership");
				expect(pending.request.toolInput?.command).toBe(command);
				wire.close();
				const submission = await prompt;
				if (sandbox && !(submission instanceof Error)) expect(submission).toEqual({ ok: true });
				else expect(submission).toBeInstanceOf(E2eWireTransientError);
				await crash();
				host = startHost();
				await waitForHost();
				wire = await E2eWire.connect(E2E_RESTART_PORT);
				const recovered = await wire.request("session.getMessages", {
					sessionId,
					workspaceId: workspace.id,
				});
				expect(recovered.messages).toEqual(waiting.messages);
				expect(recovered.summary.state?.needsInput).toEqual(pending);
				expect(recovered.summary.queue).toEqual(waiting.summary.queue);
				await page.goto(origin);
				await expect(page.getByTestId("connection-status")).toHaveAttribute(
					"data-status",
					"connected",
				);
				const response = {
					sessionId,
					id: pending.interactionId,
					runId,
					revision,
					toolCallId,
					value: true,
				};
				await wire.request("session.extUiReply", { response });
				const resumedWire = wire;
				await expect
					.poll(
						async () => {
							const snapshot = await resumedWire.request("session.getMessages", {
								sessionId,
								workspaceId: workspace.id,
							});
							return (
								snapshot.summary.state?.completion?.outcome === "succeeded" &&
								snapshot.messages.some(
									(message) =>
										message.role === "assistant" &&
										JSON.stringify(message.content).includes("RESTART_FOLLOWUP"),
								)
							);
						},
						{ timeout: 120_000 },
					)
					.toBe(true);
				if (sandbox) expect(existsSync(marker)).toBe(false);
				else expect(readFileSync(marker, "utf8")).toBe("RESTART_EFFECT\n");
				const finished = await wire.request("session.getMessages", {
					sessionId,
					workspaceId: workspace.id,
				});
				wire.close();
				await crash();
				host = startHost();
				await waitForHost();
				wire = await E2eWire.connect(E2E_RESTART_PORT);
				if (sandbox) writeFileSync(marker, "Recreated after completed removal\n");
				await wire.request("session.extUiReply", { response });
				const restored = await wire.request("session.getMessages", {
					sessionId,
					workspaceId: workspace.id,
				});
				expect(restored.messages).toEqual(finished.messages);
				expect(
					restored.messages.filter((message) => message.id === "restart-followup"),
				).toHaveLength(1);
				if (sandbox)
					expect(readFileSync(marker, "utf8")).toBe("Recreated after completed removal\n");
				else expect(readFileSync(marker, "utf8")).toBe("RESTART_EFFECT\n");

				if (sandbox) {
					wire.close();
					await crash();
					const recordPath = join(E2E_RESTART_DATA_DIR, "sessions", `${sessionId}.json`);
					const record = JSON.parse(readFileSync(recordPath, "utf8"));
					record.state.execution = "running";
					record.state.runId = "interrupted-sandbox";
					record.effects["interrupted-call"] = {
						runId: "interrupted-sandbox",
						name: "bash",
						arguments: { command, timeoutMs: 1000 },
						status: "started",
					};
					writeFileSync(recordPath, JSON.stringify(record));
					host = startHost();
					await waitForHost();
					wire = await E2eWire.connect(E2E_RESTART_PORT);
					const interrupted = await wire.request("session.getMessages", {
						sessionId,
						workspaceId: workspace.id,
					});
					expect(interrupted.summary.state?.completion?.outcome).toBe("interrupted");
					const settled = JSON.parse(readFileSync(recordPath, "utf8"));
					expect(settled.effects["interrupted-call"].status).toBe("unknown");
					expect(readFileSync(marker, "utf8")).toBe("Recreated after completed removal\n");
					await testInfo.attach("unknown-effect-proof", {
						contentType: "application/json",
						body: Buffer.from(
							JSON.stringify({ sessionId, outcome: "interrupted", effect: "unknown" }),
						),
					});
				}
				await testInfo.attach("restart-proof", {
					contentType: "application/json",
					body: Buffer.from(JSON.stringify({ sessionId, recovered, restored }, null, 2)),
				});
			} finally {
				wire?.close();
				if (host.exitCode === null && host.signalCode === null) {
					host.kill("SIGTERM");
					try {
						await expect
							.poll(() => host.exitCode !== null || host.signalCode !== null, { timeout: 15_000 })
							.toBe(true);
					} finally {
						if (host.exitCode === null && host.signalCode === null) {
							host.kill("SIGKILL");
							await once(host, "exit");
						}
					}
				}
				rmSync(E2E_RESTART_DATA_DIR, { recursive: true, force: true });
			}
		},
	);
}
