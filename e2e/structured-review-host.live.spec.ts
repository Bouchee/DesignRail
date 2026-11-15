import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { type AssistantMessage, isPlanReviewOutput } from "@thinkrail/contracts";
import { toolHomeEnv } from "@thinkrail/shared/toolHomes";
import { assertLivePlaywrightRunner } from "./agentRunPlan";
import {
	openPersistedChat,
	revealFirstProjectWorkspaces,
	revealWorkbenchTool,
	worktreeRow,
} from "./fixtures/app";
import { E2E_BASE_CONFIG } from "./fixtures/appConfig";
import { hermeticE2ePath, hermeticE2eShell, resolveBunExecutable } from "./fixtures/executables";
import { commitFile, gitAs } from "./fixtures/git";
import {
	E2E_FAKE_BIN_DIR,
	E2E_RESTART_DATA_DIR,
	E2E_RESTART_HOST_LOG,
	E2E_RESTART_PORT,
} from "./fixtures/paths";
import { isLiveAgentE2e, seedAgentConfiguration, seedE2eDefaultModel } from "./fixtures/sdkAgent";
import { E2eWire } from "./fixtures/wire";

test("actual Plan review inspects a fixture and persists typed output and refreshed review UI @agent", async ({
	page,
}) => {
	test.setTimeout(110_000);
	const info = test.info();
	expect(isLiveAgentE2e()).toBe(true);
	expect(info.retry).toBe(0);
	expect(info.project.retries).toBe(0);
	assertLivePlaywrightRunner(process.env, process.argv);
	const ledgerPath = process.env.RAILDESIGN_STRUCTURED_REVIEW_LEDGER;
	if (
		!ledgerPath ||
		!process.env.RAILDESIGN_STRUCTURED_REVIEW_FREEZE ||
		!process.env.RAILDESIGN_STRUCTURED_REVIEW_INTEGRATION_FREEZE
	)
		throw new Error("Supply the approved ledger and both frozen manifests");
	const initialLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
	const batchStart: number = initialLedger.batch_start,
		requestCap: number = initialLedger.request_cap;
	expect(batchStart).toBe(5);
	expect(requestCap).toBe(25);
	expect(initialLedger.requests).toHaveLength(batchStart);
	const prefixHash = createHash("sha256")
		.update(JSON.stringify(initialLedger.requests.slice(0, batchStart)))
		.digest("hex");
	rmSync(E2E_RESTART_DATA_DIR, { recursive: true, force: true });
	const home = join(E2E_RESTART_DATA_DIR, "home"),
		repository = join(E2E_RESTART_DATA_DIR, "repository");
	mkdirSync(home, { recursive: true });
	mkdirSync(repository);
	gitAs(repository, "init", "--initial-branch=main");
	commitFile(repository, "a.ts", "export const count = 1;\n", "fixture baseline");
	const sha = commitFile(
		repository,
		"a.ts",
		"export const count = 2;\n",
		"fixture requested count",
	);
	seedAgentConfiguration(E2E_RESTART_DATA_DIR);
	const modelsPath = join(E2E_RESTART_DATA_DIR, "models.json"),
		models = JSON.parse(readFileSync(modelsPath, "utf8"));
	models.endpoints[0].models[0].maxTokens = 512;
	writeFileSync(modelsPath, JSON.stringify(models), { mode: 0o600 });
	writeFileSync(
		join(E2E_RESTART_DATA_DIR, "config.json"),
		JSON.stringify({
			...E2E_BASE_CONFIG,
			sdkTracingEnabled: false,
			agentReviewEnabled: false,
			reviewAutoFix: false,
		}),
	);
	const log = openSync(E2E_RESTART_HOST_LOG, "w", 0o600);
	const host = spawn(
		resolveBunExecutable(),
		["--preload", "./e2e/fixtures/structuredReviewAdmission.ts", "packages/server/src/dev.ts"],
		{
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			env: {
				...process.env,
				...toolHomeEnv(home),
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
		},
	);
	closeSync(log);
	const origin = `http://localhost:${E2E_RESTART_PORT}`;
	let wire: E2eWire | undefined;
	const proof: Record<string, unknown> = {
		phase: "host_preflight",
		batchStart,
		requestCap,
		prefixHash,
	};
	const proofPath = info.outputPath("selected-review-host-proof.json");
	try {
		await expect
			.poll(
				async () => {
					if (host.exitCode !== null || host.signalCode !== null)
						throw new Error("Owned structured review host failed preflight");
					return fetch(`${origin}/health`)
						.then((response) => response.status)
						.catch(() => 0);
				},
				{ timeout: 30_000 },
			)
			.toBe(200);
		wire = await E2eWire.connect(E2E_RESTART_PORT);
		await seedE2eDefaultModel(wire);
		const project = await wire.request("project.open", { path: repository });
		const workspace = await wire.request("workspace.create", { projectId: project.id }, 30_000);
		const session = await wire.request("session.create", { workspaceId: workspace.id });
		proof.parentSessionId = session.sessionId;
		await wire.request("session.rename", {
			workspaceId: workspace.id,
			sessionId: session.sessionId,
			title: "Structured review fixture",
		});
		const todos = join(workspace.worktreePath, ".raildesign/context/todos");
		mkdirSync(todos, { recursive: true });
		writeFileSync(
			join(todos, `${session.sessionId}.json`),
			JSON.stringify({
				version: 6,
				groups: [],
				todos: [
					{
						id: "review-fixture-step",
						title: "Use read on a.ts, then review the requested count change from 1 to 2",
						status: "done",
						origin: "agent",
						summary:
							"The fictitious requested value is 2. Inspect a.ts using read before returning the schema verdict.",
						verification: "No command was run; this is fixture data.",
						artifacts: [{ kind: "commit", sha, label: "Requested count" }],
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					},
				],
			}),
		);
		proof.phase = "workspace_navigation";
		writeFileSync(proofPath, JSON.stringify(proof, null, 2));
		await page.goto(origin);
		await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
		await revealFirstProjectWorkspaces(page);
		await worktreeRow(page, workspace.name).getByRole("treeitem").click();
		proof.phase = "chat_navigation";
		writeFileSync(proofPath, JSON.stringify(proof, null, 2));
		await openPersistedChat(page, "Structured review fixture");
		await revealWorkbenchTool(page, "plan");
		await page.getByTestId("plan-rail-pane").getByTestId("todo-open-plan").click();
		await expect(page.getByTestId("plan-pane")).toContainText("requested count");
		proof.phase = "review_execution";
		writeFileSync(proofPath, JSON.stringify(proof, null, 2));
		await wire.request("todo.startReview", {
			workspaceId: workspace.id,
			sessionId: session.sessionId,
			id: "review-fixture-step",
		});
		const ownedWire = wire;
		await expect
			.poll(
				async () => {
					const records = readdirSync(join(E2E_RESTART_DATA_DIR, "sessions"))
						.filter((name) => name.endsWith(".json"))
						.map((name) =>
							JSON.parse(readFileSync(join(E2E_RESTART_DATA_DIR, "sessions", name), "utf8")),
						);
					const child = records.find(
						(record) =>
							record.childRun?.purpose === "review" &&
							record.childRun.parentSessionId === session.sessionId,
					);
					if (child)
						proof.child = {
							sessionId: child.sessionId,
							status: child.childRun.status,
							completion: child.state.completion,
						};
					if (child?.childRun.finishedAt && child.childRun.status !== "completed")
						throw new Error("The actual review child failed; no retry is authorized");
					return child?.childRun.status ?? "waiting";
				},
				{ timeout: 50_000, intervals: [100, 250] },
			)
			.toBe("completed");
		const records = readdirSync(join(E2E_RESTART_DATA_DIR, "sessions"))
			.filter((name) => name.endsWith(".json"))
			.map((name) =>
				JSON.parse(readFileSync(join(E2E_RESTART_DATA_DIR, "sessions", name), "utf8")),
			);
		const child = records.find(
			(record) =>
				record.childRun?.purpose === "review" &&
				record.childRun.parentSessionId === session.sessionId,
		);
		expect(child).toBeDefined();
		const binding = child.childRun.reviewOutput;
		const message: AssistantMessage | undefined = child.messages.find(
			(message: { id?: string }) => message.id === binding?.messageId,
		);
		proof.phase = "typed_child_and_effects";
		proof.child = {
			sessionId: child.sessionId,
			status: child.childRun.status,
			completion: child.state.completion,
			binding,
			output: isPlanReviewOutput(message?.planReview) ? message.planReview : undefined,
			readEffects: Object.entries(child.effects).flatMap(([id, effect]) =>
				typeof effect === "object" && effect !== null && "name" in effect && effect.name === "read"
					? [{ id, status: "status" in effect ? effect.status : undefined }]
					: [],
			),
		};
		expect(message?.stopReason).toBe("stop");
		expect(isPlanReviewOutput(message?.planReview)).toBe(true);
		expect(
			Object.values(child.effects).some(
				(effect) =>
					typeof effect === "object" &&
					effect !== null &&
					"name" in effect &&
					effect.name === "read" &&
					"status" in effect &&
					effect.status === "completed",
			),
		).toBe(true);
		await expect
			.poll(
				async () =>
					(
						await ownedWire.request("todo.list", {
							workspaceId: workspace.id,
							sessionId: session.sessionId,
						})
					).todos[0]?.review?.state,
				{ timeout: 5000 },
			)
			.toBe(message?.planReview?.verdict === "approve" ? "reviewed" : "changes_requested");
		const review = await wire.request("review.get", { workspaceId: workspace.id });
		proof.review = {
			state: message?.planReview?.verdict === "approve" ? "reviewed" : "changes_requested",
			canonicalFindings: review.comments.map((comment) => comment.id),
			guide: review.review.guide,
		};
		if (message?.planReview?.verdict === "request_changes") {
			expect(review.comments.length).toBeGreaterThan(0);
			expect(review.comments.every((comment) => comment.id.startsWith("rc_"))).toBe(true);
		}
		expect(review.review.guide?.summary ?? "").toBe(message?.planReview?.summary ?? "");
		const before = JSON.parse(readFileSync(ledgerPath, "utf8")).requests.length;
		proof.phase = "refresh";
		await page.reload();
		await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
		await revealWorkbenchTool(page, "plan");
		const item = page
			.getByTestId("plan-pane")
			.getByTestId("plan-item")
			.filter({ hasText: "requested count" });
		const approved = message?.planReview?.verdict === "approve";
		await expect(item).toHaveAttribute("data-reviewed", String(approved));
		await expect(item).toHaveAttribute("data-changes-requested", String(!approved));
		await expect(
			item.getByTestId(approved ? "plan-item-verified" : "plan-item-changes-requested"),
		).toBeVisible();
		await page
			.locator('[data-testid="editor-tab"][data-kind="chat"]')
			.filter({ hasText: "Structured review fixture" })
			.getByRole("tab")
			.click();
		await page.getByTestId("resources-trigger").click();
		const inspector = page.getByTestId("resources-inspector");
		await inspector
			.getByTestId("resource-subagent")
			.filter({ hasText: "Plan reviewer" })
			.getByRole("option")
			.click();
		await expect(inspector.getByTestId("plan-review-output")).toHaveAttribute(
			"data-verdict",
			message?.planReview?.verdict ?? "",
		);
		const transcript = await wire.request("subagent.getTranscript", {
			workspaceId: workspace.id,
			parentSessionId: session.sessionId,
			childSessionId: child.sessionId,
		});
		expect(
			transcript.messages.find((item) => "id" in item && item.id === binding.messageId),
		).toEqual(message);
		const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
		expect(ledger.requests).toHaveLength(before);
		expect(before - batchStart).toBeLessThanOrEqual(requestCap - batchStart);
		expect(
			createHash("sha256")
				.update(JSON.stringify(ledger.requests.slice(0, batchStart)))
				.digest("hex"),
		).toBe(prefixHash);
		expect(
			ledger.requests
				.slice(batchStart)
				.filter((entry: { phase: string }) => entry.phase === "host_review").length,
		).toBeGreaterThanOrEqual(2);
		proof.phase = "completed";
		proof.requests = before;
		proof.newRequests = before - batchStart;
		proof.refreshUnchanged = true;
	} finally {
		writeFileSync(proofPath, JSON.stringify(proof, null, 2));
		try {
			wire?.close();
			if (host.exitCode === null && host.signalCode === null) {
				host.kill("SIGTERM");
				try {
					await expect
						.poll(() => host.exitCode !== null || host.signalCode !== null, { timeout: 10_000 })
						.toBe(true);
				} finally {
					if (host.exitCode === null && host.signalCode === null) {
						host.kill("SIGKILL");
						await once(host, "exit");
					}
				}
			}
		} finally {
			try {
				await info.attach("selected-review-host-proof", {
					contentType: "application/json",
					body: Buffer.from(JSON.stringify(proof, null, 2)),
				});
			} finally {
				rmSync(E2E_RESTART_DATA_DIR, { recursive: true, force: true });
			}
		}
	}
});
