import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { SessionRecord } from "@thinkrail/server/agent";
import { toolHomeEnv } from "@thinkrail/shared/toolHomes";
import { assertLivePlaywrightRunner } from "./agentRunPlan";
import { openPersistedChat, revealFirstProjectWorkspaces, worktreeRow } from "./fixtures/app";
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

interface LedgerEntry {
	id: string;
	phase: string;
	state: string;
	evidence?: { response_id?: string; function_calls?: string[] };
}
interface Ledger {
	request_cap: number;
	batch_start: number;
	requests: LedgerEntry[];
}

const CHAT_TITLE = "Handoff fixture";
// Fictitious fixture fact; the analyst repeats it so its answer is checkable.
const FIRST_PROMPT =
	"Transfer this conversation to the analyst agent now with your transfer tool; do not answer yourself. " +
	"Analyst: reply in one short sentence that the fictitious Lumen Gate fixture colour is teal.";
const SECOND_PROMPT =
	"In one short sentence, repeat the fictitious Lumen Gate fixture colour. Do not transfer.";

function assistantText(message: SessionRecord["messages"][number]): string {
	return message.role === "assistant"
		? message.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("")
				.trim()
		: "";
}

async function expectHandlerUi(page: Page): Promise<void> {
	const transfer = page.getByTestId("agent-transfer");
	await expect(transfer).toHaveCount(1);
	await expect(transfer).toContainText("DesignRail handed the conversation to analyst");
	await expect(page.getByTestId("active-agent")).toHaveText("Handled by analyst");
	await expect(page.getByTestId("assistant-agent").last()).toHaveText("analyst");
}

test("an SDK Handoff moves the chat to the analyst, which keeps the next turn @agent", async ({
	page,
}) => {
	test.setTimeout(240_000);
	const info = test.info();
	expect(isLiveAgentE2e()).toBe(true);
	expect(info.retry).toBe(0);
	expect(info.project.retries).toBe(0);
	assertLivePlaywrightRunner(process.env, process.argv);
	const ledgerPath = process.env.RAILDESIGN_HANDOFF_LEDGER;
	const resultPath = process.env.RAILDESIGN_HANDOFF_RESULT;
	if (!ledgerPath || !resultPath)
		throw new Error("Supply RAILDESIGN_HANDOFF_LEDGER and RAILDESIGN_HANDOFF_RESULT");
	const readLedger = (): Ledger => JSON.parse(readFileSync(ledgerPath, "utf8"));
	const initial = readLedger();
	expect(initial.request_cap).toBe(8);
	expect(initial.batch_start).toBe(0);
	expect(initial.requests.every((entry) => entry.state !== "reserved")).toBe(true);
	// The shortest pass needs three requests: transfer call, analyst answer, second-turn answer.
	expect(initial.request_cap - initial.requests.length).toBeGreaterThanOrEqual(3);
	const runStart = initial.requests.length;
	const setPhase = (phase: string) => writeFileSync(`${ledgerPath}.phase`, phase);
	setPhase("host_setup");

	rmSync(E2E_RESTART_DATA_DIR, { recursive: true, force: true });
	const home = join(E2E_RESTART_DATA_DIR, "home"),
		repository = join(E2E_RESTART_DATA_DIR, "repository");
	mkdirSync(home, { recursive: true });
	mkdirSync(repository);
	gitAs(repository, "init", "--initial-branch=main");
	commitFile(repository, "README.md", "# Lumen Gate fixture\n", "fixture baseline");
	seedAgentConfiguration(E2E_RESTART_DATA_DIR);
	const modelsPath = join(E2E_RESTART_DATA_DIR, "models.json"),
		models = JSON.parse(readFileSync(modelsPath, "utf8"));
	models.endpoints[0].models[0].maxTokens = 1024;
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
	mkdirSync(join(E2E_RESTART_DATA_DIR, "agents"));
	writeFileSync(
		join(E2E_RESTART_DATA_DIR, "agents", "analyst.md"),
		"---\nname: analyst\ndescription: Fictitious fixture analyst for the Lumen Gate fixture.\ntools: read\n---\n" +
			"You are the analyst. Answer the user directly in one short sentence. Do not use tools or transfer.\n",
	);
	writeFileSync(
		join(E2E_RESTART_DATA_DIR, "handoffs.json"),
		JSON.stringify({
			version: 1,
			rootTargets: ["analyst"],
			agents: [{ definition: "analyst", targets: ["$root"], history: "all" }],
		}),
	);

	const log = openSync(E2E_RESTART_HOST_LOG, "w", 0o600);
	const host = spawn(
		resolveBunExecutable(),
		["--preload", "./e2e/fixtures/handoffAdmission.ts", "packages/server/src/dev.ts"],
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
	const result: Record<string, unknown> = { phase: "host_setup", runStart };
	const recordPath = (sessionId: string) =>
		join(E2E_RESTART_DATA_DIR, "sessions", `${sessionId}.json`);
	try {
		await expect
			.poll(
				async () => {
					if (host.exitCode !== null || host.signalCode !== null)
						throw new Error("Owned handoff host failed preflight");
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
		await wire.request("session.rename", {
			workspaceId: workspace.id,
			sessionId: session.sessionId,
			title: CHAT_TITLE,
		});
		result.sessionId = session.sessionId;
		const readRecord = (): SessionRecord =>
			JSON.parse(readFileSync(recordPath(session.sessionId), "utf8"));
		await expect.poll(() => readRecord().handoffs?.activeNode, { timeout: 5000 }).toBe("$root");

		await page.goto(origin);
		await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
		await revealFirstProjectWorkspaces(page);
		await worktreeRow(page, workspace.name).getByRole("treeitem").click();
		await openPersistedChat(page, CHAT_TITLE);

		const outcomes = page.locator('[data-testid="turn-divider-status"]');
		const sendTurn = async (phase: string, text: string, turn: number) => {
			result.phase = phase;
			setPhase(phase);
			await page.getByTestId("chat-input").fill(text);
			await page.getByTestId("chat-send").click();
			await expect(outcomes).toHaveCount(turn, { timeout: 100_000 });
			await expect(outcomes.nth(turn - 1)).toHaveAttribute("data-outcome", "done");
		};

		await sendTurn("turn1_transfer", FIRST_PROMPT, 1);
		let record = readRecord();
		expect(record.handoffs?.activeNode).toBe("analyst");
		expect(record.handoffs?.transfers).toHaveLength(1);
		expect(record.handoffs?.transfers[0]).toMatchObject({ from: "$root", to: "analyst" });
		const firstAnswer = record.messages.findLast((message) => message.role === "assistant");
		expect(firstAnswer?.role === "assistant" && firstAnswer.agent).toBe("analyst");
		expect(firstAnswer ? assistantText(firstAnswer) : "").not.toBe("");
		const turn1 = readLedger().requests.slice(runStart);
		expect(turn1.every((entry) => entry.phase === "turn1_transfer")).toBe(true);
		expect(turn1.flatMap((entry) => entry.evidence?.function_calls ?? [])).toContain(
			"transfer_to_analyst",
		);
		await expectHandlerUi(page);

		const firstCount = record.messages.length;
		await sendTurn("turn2_owner", SECOND_PROMPT, 2);
		record = readRecord();
		expect(record.handoffs?.activeNode).toBe("analyst");
		expect(record.handoffs?.transfers).toHaveLength(1);
		const turn2Answers = record.messages
			.slice(firstCount)
			.flatMap((message) => (message.role === "assistant" ? [message] : []));
		expect(turn2Answers.length).toBeGreaterThan(0);
		expect(turn2Answers.every((message) => message.agent === "analyst")).toBe(true);
		const secondAnswer = turn2Answers.at(-1);
		expect(secondAnswer ? assistantText(secondAnswer) : "").not.toBe("");
		const turn2 = readLedger().requests.filter((entry) => entry.phase === "turn2_owner");
		expect(turn2.length).toBeGreaterThan(0);
		expect(turn2.flatMap((entry) => entry.evidence?.function_calls ?? [])).not.toContainEqual(
			expect.stringMatching(/^transfer_to_/),
		);
		await expectHandlerUi(page);

		result.phase = "refresh";
		setPhase("refresh");
		const beforeRefresh = readLedger().requests.length;
		await page.reload();
		await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
		await expectHandlerUi(page);
		await expect(page.getByTestId("assistant-agent").last()).toHaveText("analyst");
		const ledger = readLedger();
		expect(ledger.requests).toHaveLength(beforeRefresh);
		const run = ledger.requests.slice(runStart);
		expect(run.every((entry) => entry.state === "completed")).toBe(true);
		Object.assign(result, {
			phase: "completed",
			requests: ledger.requests.length,
			newRequests: run.length,
			responses: run.map((entry) => ({
				phase: entry.phase,
				response_id: entry.evidence?.response_id,
				function_calls: entry.evidence?.function_calls,
			})),
			transfer: record.handoffs?.transfers[0],
			assistantMessageIds: record.messages.flatMap((message) =>
				message.role === "assistant" ? [{ id: message.id, agent: message.agent }] : [],
			),
		});
	} finally {
		writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
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
			rmSync(`${ledgerPath}.phase`, { force: true });
			rmSync(E2E_RESTART_DATA_DIR, { recursive: true, force: true });
		}
	}
});
