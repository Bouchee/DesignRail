import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Agent,
	AgentsError,
	type Model,
	ModelBehaviorError,
	ModelRefusalError,
	type ModelResponse,
	Runner,
} from "@openai/agents";
import { assistantMessage, modelResponse, ScriptedModel } from "@openai/agents/testing";
import { isPlanReviewOutput, type PlanReviewOutput } from "@thinkrail/contracts";
import {
	createConfiguredModel,
	listAvailableModels,
	responsesClientSettings,
} from "./modelConfiguration";
import { assertCompletedPlanReviewResponse, planReviewOutput } from "./planReviewOutput";
import { abortSession, liveSessionIdsOf } from "./sdkSessionManager";

export const REVIEW_COMPATIBILITY_INPUT =
	"Review this fictitious complete change: a documentation typo was corrected and its spelling check passed. Return verdict approve, summary 'The fixture change is complete.', readingOrder [], findings []. No repository access is needed.";
export const REVIEW_COMPATIBILITY_OUTPUT: PlanReviewOutput = {
	verdict: "approve",
	summary: "The fixture change is complete.",
	readingOrder: [],
	findings: [],
};

export function buildReviewCompatibilityAgent(model: Model) {
	return new Agent({
		name: "Plan review compatibility fixture",
		model,
		outputType: planReviewOutput,
		modelSettings: {
			...responsesClientSettings,
			maxTokens: 512,
			timeoutMs: 30_000,
			retry: { maxRetries: 0 },
		},
		tools: [],
	});
}

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const sdk = dirname(require.resolve("@openai/agents"));
const sdkRequire = createRequire(join(sdk, "index.mjs"));
const core = dirname(sdkRequire.resolve("@openai/agents-core"));
const adapter = dirname(sdkRequire.resolve("@openai/agents-openai"));
const openai = dirname(require.resolve("openai"));
const sourcePaths = [
	"packages/contracts/src/domain.ts",
	"packages/contracts/src/domain.test.ts",
	"packages/contracts/src/index.ts",
	"packages/server/src/agent/planReviewOutput.ts",
	"packages/server/src/agent/planReviewOutput.test.ts",
	"packages/server/src/agent/structuredReviewTestFixtures.ts",
	"packages/server/src/agent/structuredReviewTestFixtures.test.ts",
	"packages/server/src/agent/modelConfiguration.ts",
	"packages/server/package.json",
	"e2e/structured-review-compatibility.live.spec.ts",
	"e2e/run-agent.ts",
	"e2e/agentRunPlan.ts",
	"e2e/fixtures/sdkAgent.ts",
	"e2e/playwright.config.ts",
];

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function responseEvidence(response: ModelResponse | undefined) {
	const messages = response?.output.filter(
		(item): item is Extract<ModelResponse["output"][number], { role: "assistant" }> =>
			item.type === "message" && item.role === "assistant",
	);
	return {
		response_id: response?.responseId,
		message_statuses: messages?.map((item) => item.status),
		refusal: messages?.some((item) => item.content.some((part) => part.type === "refusal")),
	};
}

function failureClassification(
	stage: string,
	status: number | undefined,
	aborted: boolean,
	error: unknown,
): string {
	if (aborted) return "cancelled";
	if (status === 401 || status === 403) return "authentication";
	if (status === 429) return "quota_or_rate_limit";
	if (status === 404) return "routing";
	if (status === 400 || status === 422) return "schema_or_parameter_rejected";
	if (status !== undefined && status >= 500) return "provider_error";
	if (stage === "transport" && status === undefined) return "network";
	if (error instanceof ModelRefusalError) return "refusal";
	if (error instanceof ModelBehaviorError && error.message.startsWith("Invalid output type:"))
		return "local_validation";
	if (
		error instanceof ModelBehaviorError &&
		error.message.startsWith("OpenAI Responses request ended with unsuccessful terminal state")
	)
		return "terminal_rejected";
	return stage;
}

export async function reviewCompatibilityFreeze() {
	const model = new ScriptedModel([
		modelResponse([assistantMessage(JSON.stringify(REVIEW_COMPATIBILITY_OUTPUT))]),
	]);
	const result = await new Runner({ tracingDisabled: true }).run(
		buildReviewCompatibilityAgent(model),
		REVIEW_COMPATIBILITY_INPUT,
		{ maxTurns: 1 },
	);
	assert.deepEqual(result.finalOutput, REVIEW_COMPATIBILITY_OUTPUT);
	const wire = model.calls[0]?.request.outputType;
	assert(wire && typeof wire === "object" && wire.type === "json_schema" && wire.strict === true);
	const installed = [
		join(sdk, "../package.json"),
		join(core, "../package.json"),
		join(adapter, "../package.json"),
		join(openai, "package.json"),
		join(openai, "client.mjs"),
		join(core, "agent.mjs"),
		join(core, "run.mjs"),
		join(core, "result.mjs"),
		join(core, "utils/standardSchema.mjs"),
		join(core, "utils/finalOutputError.mjs"),
		join(core, "utils/strictToolSchema.mjs"),
		join(core, "utils/tools.mjs"),
		join(core, "runner/turnResolution.mjs"),
		join(adapter, "openaiResponsesModel.mjs"),
	];
	return {
		version: 1,
		sdk_version: JSON.parse(readFileSync(join(sdk, "../package.json"), "utf8")).version,
		openai_version: JSON.parse(readFileSync(join(openai, "package.json"), "utf8")).version,
		natural_schema: planReviewOutput["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
		wire_format: { ...wire, name: "output" },
		schema_sha256: sha256(JSON.stringify(wire.schema)),
		input: REVIEW_COMPATIBILITY_INPUT,
		output: REVIEW_COMPATIBILITY_OUTPUT,
		sources: Object.fromEntries(
			[...sourcePaths.map((path) => join(root, path)), ...installed].map((path) => [
				path,
				sha256(readFileSync(path)),
			]),
		),
	};
}

interface RequestEntry {
	id: string;
	phase: "compatibility" | "host_review";
	mode: "nonstream" | "stream";
	started_at: string;
	state: "reserved" | "completed" | "failed";
	request: Record<string, unknown>;
	evidence?: Record<string, unknown>;
}

interface Ledger {
	request_cap: number;
	batch_start: number;
	requests: RequestEntry[];
}

function assertReviewLedger(ledger: Ledger): void {
	assert(ledger.batch_start === 0 || ledger.batch_start === 5, "Invalid request batch boundary");
	assert.equal(
		ledger.request_cap,
		ledger.batch_start === 0 ? 5 : 25,
		"Unexpected request allowance",
	);
	assert(
		Array.isArray(ledger.requests) &&
			ledger.requests.length >= ledger.batch_start &&
			ledger.requests.length <= ledger.request_cap,
		"Invalid request ledger size",
	);
	assert.equal(
		new Set(ledger.requests.map((entry) => entry.id)).size,
		ledger.requests.length,
		"Duplicate request identity",
	);
	assert(
		ledger.requests.every(
			(entry, index) =>
				typeof entry.id === "string" &&
				entry.id.length > 0 &&
				entry.phase === (index < 2 ? "compatibility" : "host_review") &&
				entry.mode === (index === 0 ? "nonstream" : "stream") &&
				["reserved", "completed", "failed"].includes(entry.state),
		),
		"Invalid request phase/order/state",
	);
	assert(
		ledger.requests.slice(0, ledger.batch_start).every((entry) => entry.state === "completed"),
		"Invalid closed request prefix",
	);
}

function updateLedger<T>(path: string, update: (ledger: Ledger) => T): T {
	const lock = `${path}.lock`;
	const fd = openSync(lock, "wx", 0o600);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const ledger: Ledger = JSON.parse(readFileSync(path, "utf8"));
		assertReviewLedger(ledger);
		const prefixHash = sha256(JSON.stringify(ledger.requests.slice(0, ledger.batch_start)));
		const result = update(ledger);
		assertReviewLedger(ledger);
		assert.equal(
			sha256(JSON.stringify(ledger.requests.slice(0, ledger.batch_start))),
			prefixHash,
			"Closed request prefix changed",
		);
		writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, path);
		return result;
	} finally {
		rmSync(temporary, { force: true });
		closeSync(fd);
		rmSync(lock);
	}
}

export function reserveReviewRequest(
	path: string,
	phase: RequestEntry["phase"],
	mode: RequestEntry["mode"],
	request: RequestEntry["request"],
): string {
	return updateLedger(path, (ledger) => {
		assert(
			ledger.requests.slice(ledger.batch_start).every((entry) => entry.state === "completed"),
			"A failed or unfinished request blocks this batch",
		);
		assert(
			ledger.requests.length - ledger.batch_start < ledger.request_cap - ledger.batch_start,
			"Total request allowance exhausted",
		);
		const previous = ledger.requests
			.slice(ledger.batch_start)
			.filter((entry) => entry.phase === phase);
		assert(
			previous.length < (phase === "compatibility" ? 2 : ledger.request_cap - ledger.batch_start),
			"Phase allowance exhausted",
		);
		if (phase === "compatibility") {
			assert.equal(
				ledger.requests.length,
				previous.length,
				"Compatibility must precede host review",
			);
			assert.equal(
				mode,
				previous.length === 0 ? "nonstream" : "stream",
				"Unexpected compatibility order",
			);
		} else {
			assert.equal(
				ledger.requests.filter((entry) => entry.phase === "compatibility").length,
				2,
				"Compatibility is incomplete",
			);
		}
		const id = randomUUID();
		ledger.requests.push({
			id,
			phase,
			mode,
			started_at: new Date().toISOString(),
			state: "reserved",
			request,
		});
		return id;
	});
}

export function finishReviewRequest(
	path: string,
	id: string,
	succeeded: boolean,
	evidence: Record<string, unknown>,
): void {
	updateLedger(path, (ledger) => {
		const index = ledger.requests.findIndex((candidate) => candidate.id === id);
		assert(index >= ledger.batch_start, "Historical requests cannot be finalized again");
		const entry = ledger.requests[index];
		assert(entry?.state === "reserved", "Request reservation is not pending");
		entry.state = succeeded ? "completed" : "failed";
		entry.evidence = evidence;
	});
}

export async function runReviewCompatibility(options: {
	ledgerPath: string;
	freezePath: string;
	signal?: AbortSignal;
}) {
	const frozen = JSON.parse(readFileSync(options.freezePath, "utf8"));
	assert.deepEqual(await reviewCompatibilityFreeze(), frozen, "Frozen schema/source changed");
	const model = (await listAvailableModels()).find(
		(candidate) => candidate.id === "deepseek-v4.1-flash",
	);
	assert(model, "The protected runner must configure the accepted Go target");
	const outputs: PlanReviewOutput[] = [];
	const originalFetch = globalThis.fetch;
	let admission = true;
	const controller = new AbortController();
	const stop = () => {
		admission = false;
		controller.abort();
	};
	options.signal?.addEventListener("abort", stop, { once: true });
	if (options.signal?.aborted) stop();
	try {
		for (const mode of ["nonstream", "stream"] as const) {
			const started = performance.now();
			let reservation: string | undefined;
			let httpStatus: number | undefined;
			let requestId: string | null = null;
			const eventTypes = new Set<string>();
			let completion: { responseId: string | undefined; status?: unknown } | undefined;
			let stage = "sdk_execution";
			let pendingCompletion: Promise<unknown> | undefined;
			let readEvidence: (() => Record<string, unknown>) | undefined;
			const sessionId = `structured-review-fixture-${randomUUID()}`;
			const timer = setTimeout(stop, 45_000);
			globalThis.fetch = Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
					stage = "request_contract";
					assert(admission && !controller.signal.aborted, "Fixture admission revoked");
					assert(!reservation, "Case permits exactly one outgoing request");
					const request = new Request(input, init);
					const body = await request.clone().json();
					assert.equal(request.url, "https://opencode.ai/inference/go/openai/v1/responses");
					assert.equal(request.method, "POST");
					assert.equal(request.headers.get("user-agent"), "DesignRail/0.1");
					assert.equal(request.headers.get("x-opencode-session"), sessionId);
					assert.equal(body.model, "deepseek-v4.1-flash");
					assert.deepEqual(body.input, [{ role: "user", content: REVIEW_COMPATIBILITY_INPUT }]);
					assert.equal(body.stream, mode === "stream");
					assert.equal(body.max_output_tokens, 512);
					assert.deepEqual(body.text, { format: frozen.wire_format });
					assert.deepEqual(body.tools, []);
					assert.deepEqual(body.include, []);
					assert(
						Object.keys(body).every((key) =>
							[
								"model",
								"input",
								"include",
								"tools",
								"stream",
								"text",
								"max_output_tokens",
							].includes(key),
						),
						"Unexpected request field",
					);
					assert(admission && !controller.signal.aborted, "Fixture admission revoked");
					reservation = reserveReviewRequest(options.ledgerPath, "compatibility", mode, {
						url: request.url,
						model: body.model,
						stream: body.stream,
						max_output_tokens: body.max_output_tokens,
						schema_sha256: frozen.schema_sha256,
						user_agent: request.headers.get("user-agent"),
						session_id: sessionId,
					});
					stage = "transport";
					const response = await originalFetch(request);
					httpStatus = response.status;
					requestId = response.headers.get("x-request-id");
					stage = "sdk_execution";
					return response;
				},
				{ preconnect: originalFetch.preconnect },
			);
			try {
				assert(admission, "Fixture admission revoked");
				const agent = buildReviewCompatibilityAgent(createConfiguredModel(model, sessionId));
				const runner = new Runner({ tracingDisabled: true });
				const result =
					mode === "stream"
						? await runner.run(agent, REVIEW_COMPATIBILITY_INPUT, {
								stream: true,
								maxTurns: 1,
								signal: controller.signal,
							})
						: await runner.run(agent, REVIEW_COMPATIBILITY_INPUT, {
								maxTurns: 1,
								signal: controller.signal,
							});
				readEvidence = () => {
					const usage = result.state.usage;
					return {
						...responseEvidence(result.rawResponses.at(-1)),
						usage: {
							requests: usage.requests,
							input_tokens: usage.inputTokens,
							output_tokens: usage.outputTokens,
							total_tokens: usage.totalTokens,
						},
					};
				};
				if ("completed" in result) {
					pendingCompletion = result.completed.catch(() => undefined);
					try {
						for await (const event of result) {
							eventTypes.add(event.type);
							if (event.type === "raw_model_stream_event") {
								eventTypes.add(event.data.type);
								if (event.data.type === "response_done")
									completion = {
										responseId: event.data.response.id,
										status: event.data.response.providerData?.status,
									};
							}
						}
					} finally {
						await pendingCompletion;
					}
					await result.completed;
					assert(!result.cancelled && !result.error, "Stream did not settle successfully");
				} else {
					const response = result.rawResponses.at(-1);
					completion = { responseId: response?.responseId, status: response?.providerData?.status };
				}
				assert(admission && !controller.signal.aborted, "Fixture admission revoked");
				assert.equal(result.interruptions.length, 0, "Review fixture interrupted");
				const response = result.rawResponses.at(-1);
				stage = "terminal_rejected";
				assertCompletedPlanReviewResponse(response, completion);
				stage = "local_validation";
				const output = result.finalOutput;
				assert(isPlanReviewOutput(output), "Local review validation failed");
				stage = "fixture_output_mismatch";
				assert.deepEqual(output, REVIEW_COMPATIBILITY_OUTPUT);
				if (outputs.length) assert.deepEqual(outputs[0], output, "Stream/nonstream outputs differ");
				assert(reservation, "No outgoing request was captured");
				finishReviewRequest(options.ledgerPath, reservation, true, {
					http_status: httpStatus,
					request_id: requestId,
					...readEvidence(),
					response_status: completion?.status,
					event_types: [...eventTypes],
					refusal: false,
					validated: true,
					output,
					elapsed_ms: Math.round(performance.now() - started),
					cancelled: false,
				});
				outputs.push(output);
			} catch (error) {
				const cancelled = controller.signal.aborted;
				stop();
				await pendingCompletion;
				const errorClass =
					error instanceof Error && /^[A-Za-z]+$/.test(error.constructor.name)
						? error.constructor.name
						: "Error";
				const failureUsage = error instanceof AgentsError ? error.state?.usage : undefined;
				if (reservation)
					finishReviewRequest(options.ledgerPath, reservation, false, {
						http_status: httpStatus,
						request_id: requestId,
						error_class: errorClass,
						classification: failureClassification(stage, httpStatus, cancelled, error),
						...(failureUsage
							? {
									usage: {
										requests: failureUsage.requests,
										input_tokens: failureUsage.inputTokens,
										output_tokens: failureUsage.outputTokens,
										total_tokens: failureUsage.totalTokens,
									},
								}
							: {}),
						...readEvidence?.(),
						response_status: typeof completion?.status === "string" ? completion.status : undefined,
						event_types: [...eventTypes],
						validated: false,
						elapsed_ms: Math.round(performance.now() - started),
						cancelled,
					});
				throw new Error(
					`Selected review compatibility failed (${mode}, ${errorClass}, HTTP ${httpStatus ?? "unavailable"}); batch stopped`,
				);
			} finally {
				clearTimeout(timer);
				globalThis.fetch = originalFetch;
			}
		}
		return outputs;
	} finally {
		stop();
		globalThis.fetch = originalFetch;
		options.signal?.removeEventListener("abort", stop);
	}
}

const integrationPaths = [
	"packages/contracts/src/sessionProtocol.ts",
	"packages/server/src/agent/sdkSessionManager.ts",
	"packages/server/src/agent/sessionStore.ts",
	"packages/server/src/agent/structuredReviewSession.test.ts",
	"packages/server/src/host/requestReview.ts",
	"packages/server/src/host/planReview.test.ts",
	"packages/server/src/host/requestReview.test.ts",
	"packages/server/src/agent/sessionStore.test.ts",
	"packages/server/src/host/reviewerRole.ts",
	"packages/server/src/history/testFixtures.ts",
	"packages/server/src/history/testFixtures.test.ts",
	"apps/web/src/chat/rows.ts",
	"apps/web/src/chat/turns.tsx",
	"apps/web/src/chat/PlanReviewOutputBody.tsx",
	"apps/web/src/store/sessionProjection.test.ts",
	"apps/web/src/chat/rows.test.ts",
	"apps/web/src/chat/turns.test.tsx",
	"e2e/plan-review.spec.ts",
	"e2e/structured-review-host.live.spec.ts",
	"e2e/fixtures/structuredReviewAdmission.ts",
];

export async function reviewIntegrationFreeze(compatibilityPath: string) {
	const compatibility = JSON.parse(readFileSync(compatibilityPath, "utf8"));
	const current = await reviewCompatibilityFreeze();
	assert.deepEqual(
		current.natural_schema,
		compatibility.natural_schema,
		"Selected natural schema changed",
	);
	assert.deepEqual(current.wire_format, compatibility.wire_format, "Selected wire schema changed");
	for (const path of [
		"packages/contracts/src/domain.ts",
		"packages/server/src/agent/planReviewOutput.ts",
	])
		assert.equal(
			current.sources[join(root, path)],
			compatibility.sources[join(root, path)],
			"Selected DTO/validator changed",
		);
	return {
		...current,
		compatibility_freeze_sha256: sha256(readFileSync(compatibilityPath)),
		sources: {
			...current.sources,
			...Object.fromEntries(
				[
					...integrationPaths.map((path) => join(root, path)),
					join(core, "runner/modelRetry.mjs"),
				].map((path) => [path, sha256(readFileSync(path))]),
			),
		},
	};
}

export async function installHostReviewAdmission(options: {
	ledgerPath: string;
	freezePath: string;
	compatibilityPath: string;
}) {
	const frozen = JSON.parse(readFileSync(options.freezePath, "utf8"));
	assert.deepEqual(
		await reviewIntegrationFreeze(options.compatibilityPath),
		frozen,
		"Integration freeze changed",
	);
	const ledger: Ledger = JSON.parse(readFileSync(options.ledgerPath, "utf8"));
	assertReviewLedger(ledger);
	assert.equal(ledger.batch_start, 5, "Host follow-up requires its closed five-request prefix");
	assert.equal(ledger.request_cap, 25, "Host follow-up requires the approved lifetime allowance");
	assert.equal(
		ledger.requests.length,
		ledger.batch_start,
		"The single host review case requires a fresh request batch",
	);
	const originalFetch = globalThis.fetch;
	const controller = new AbortController();
	let admitted = true,
		caseTimer: ReturnType<typeof setTimeout> | undefined,
		cleanup: Promise<unknown> = Promise.resolve();
	let sessionId: string | null = null;
	const stop = () => {
		admitted = false;
		controller.abort();
		if (caseTimer) clearTimeout(caseTimer);
		cleanup = Promise.allSettled(liveSessionIdsOf().map((id) => abortSession(id)));
	};
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			assert(admitted && !controller.signal.aborted, "Host review admission revoked");
			const request = new Request(input, init),
				body = await request
					.clone()
					.json()
					.catch(() => {
						stop();
						throw new Error("Unexpected host request body; batch stopped");
					});
			const started = performance.now();
			let id: string;
			try {
				id = reserveReviewRequest(
					options.ledgerPath,
					"host_review",
					body.stream ? "stream" : "nonstream",
					{
						url:
							request.url === "https://opencode.ai/inference/go/openai/v1/responses"
								? request.url
								: "unexpected_destination",
						model: body.model === "deepseek-v4.1-flash" ? body.model : "unexpected_model",
						stream: body.stream === true,
						max_output_tokens: body.max_output_tokens === 512 ? 512 : null,
						schema_sha256: body.text?.format?.schema
							? sha256(JSON.stringify(body.text.format.schema))
							: null,
						user_agent: request.headers.get("user-agent"),
						session_id: request.headers.get("x-opencode-session"),
					},
				);
			} catch {
				stop();
				throw new Error("Host review allowance refused before transport");
			}
			let settled = false,
				httpStatus: number | undefined;
			let stage = "host_request_contract",
				requestSignal: AbortSignal | undefined,
				requestTimeout: AbortSignal | undefined;
			const finish = (succeeded: boolean, evidence: Record<string, unknown>) => {
				if (settled) return;
				settled = true;
				finishReviewRequest(options.ledgerPath, id, succeeded, {
					http_status: httpStatus,
					elapsed_ms: Math.round(performance.now() - started),
					...evidence,
				});
			};
			const fail = (error: unknown) => {
				const evidence = {
					classification: failureClassification(
						stage,
						httpStatus,
						controller.signal.aborted || requestSignal?.aborted === true,
						error,
					),
					validated: false,
					cancelled: controller.signal.aborted || requestSignal?.aborted === true,
					model_timeout: requestTimeout?.aborted === true,
				};
				if (settled)
					updateLedger(options.ledgerPath, (ledger) => {
						const entry = ledger.requests.find((entry) => entry.id === id);
						assert(entry);
						entry.state = "failed";
						entry.evidence = { ...entry.evidence, ...evidence };
					});
				else finish(false, evidence);
				stop();
			};
			try {
				assert.equal(request.url, "https://opencode.ai/inference/go/openai/v1/responses");
				assert.equal(request.method, "POST");
				assert.equal(body.model, "deepseek-v4.1-flash");
				assert.equal(body.stream, true);
				assert.equal(body.max_output_tokens, 512);
				assert.deepEqual(body.text, { format: frozen.wire_format });
				assert.deepEqual(body.include, []);
				assert.equal(request.headers.get("user-agent"), "DesignRail/0.1");
				const currentSession = request.headers.get("x-opencode-session");
				assert(currentSession);
				if (sessionId) assert.equal(currentSession, sessionId, "Unexpected helper model call");
				else sessionId = currentSession;
				const allowed = [
					"read",
					"search",
					"spec_search",
					"spec_grep",
					"spec_get",
					"spec_graph",
					"spec_validate",
				];
				assert(
					Array.isArray(body.tools) &&
						body.tools.length &&
						body.tools.every(
							(item: { type?: unknown; name?: string }) =>
								item.type === "function" && allowed.includes(item.name ?? ""),
						),
					"Review tools must be ordinary and read-only",
				);
				assert(
					Object.keys(body).every((key) =>
						[
							"model",
							"instructions",
							"input",
							"include",
							"tools",
							"max_output_tokens",
							"stream",
							"text",
						].includes(key),
					),
					"Unexpected host model field",
				);
				assert(admitted && !controller.signal.aborted, "Host review admission revoked");
				caseTimer ??= setTimeout(stop, 45_000);
				requestTimeout = AbortSignal.timeout(30_000);
				const signal = AbortSignal.any([request.signal, controller.signal, requestTimeout]);
				requestSignal = signal;
				stage = "transport";
				const response = await originalFetch(new Request(request, { signal }));
				httpStatus = response.status;
				stage = "host_transport";
				assert(response.ok && response.body, "Model transport failed");
				const reader = response.body.getReader(),
					decoder = new TextDecoder();
				let buffer = "",
					bytes = 0,
					terminal = false;
				const events = new Set<string>();
				const stream = new ReadableStream<Uint8Array>({
					async pull(destination) {
						try {
							assert(admitted && !signal.aborted, "Host review transport cancelled");
							const next = await reader.read();
							if (next.done) {
								assert(terminal, "Missing terminal model event");
								destination.close();
								return;
							}
							bytes += next.value.byteLength;
							assert(bytes <= 1_048_576, "Fixture response exceeded its bound");
							buffer += decoder.decode(next.value, { stream: true });
							let boundary = /\r?\n\r?\n/.exec(buffer);
							while (boundary?.index !== undefined) {
								const frame = buffer.slice(0, boundary.index);
								buffer = buffer.slice(boundary.index + boundary[0].length);
								const data = frame
									.split(/\r?\n/)
									.filter((line) => line.startsWith("data:"))
									.map((line) => line.slice(5).trimStart())
									.join("\n");
								if (data && data !== "[DONE]") {
									const event = JSON.parse(data);
									assert(typeof event.type === "string");
									assert(/^[a-z_][a-z0-9_.-]{0,100}$/i.test(event.type), "Unexpected event type");
									events.add(event.type);
									if (
										[
											"response.completed",
											"response.failed",
											"response.incomplete",
											"response.error",
											"error",
										].includes(event.type)
									) {
										assert(!terminal, "Repeated terminal model event");
										terminal = true;
										const result = event.response;
										stage = "terminal_rejected";
										assert.equal(event.type, "response.completed");
										assert.equal(result?.status, "completed");
										assert(Array.isArray(result.output));
										assert(
											typeof result.id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(result.id),
											"Invalid response identity",
										);
										const calls = result.output.filter(
											(item: { type?: unknown }) => item.type === "function_call",
										);
										assert(
											calls.every((item: { name?: string }) => allowed.includes(item.name ?? "")),
											"Unexpected model tool call",
										);
										const messages = result.output.filter(
											(item: { type?: unknown; role?: unknown }) =>
												item.type === "message" && item.role === "assistant",
										);
										assert(
											messages.every(
												(message: { status?: unknown; content: { type?: unknown }[] }) =>
													message.status === "completed" &&
													!message.content.some((part) => part.type === "refusal"),
											),
											"Refused or incomplete review message",
										);
										if (!calls.length) {
											stage = "local_validation";
											const text = messages
												.flatMap((message: { content: { type?: unknown; text?: string }[] }) =>
													message.content
														.filter((part) => part.type === "output_text")
														.map((part) => part.text ?? ""),
												)
												.join("");
											const output = new Agent({
												name: "Review fixture validator",
												outputType: planReviewOutput,
											}).processFinalOutput(text);
											assert(isPlanReviewOutput(output));
										}
										assert(admitted && !signal.aborted, "Late model result after Stop");
										finish(true, {
											response_id: result.id,
											request_id: /^[A-Za-z0-9_.:-]{1,200}$/.test(
												response.headers.get("x-request-id") ?? "",
											)
												? response.headers.get("x-request-id")
												: undefined,
											response_status: result.status,
											message_statuses: messages.map(
												(message: { status: string }) => message.status,
											),
											tool_names: calls.map((call: { name: string }) => call.name),
											event_types: [...events],
											refusal: false,
											final_output_validated: !calls.length,
											usage: {
												input_tokens: Number.isFinite(result.usage?.input_tokens)
													? result.usage.input_tokens
													: undefined,
												output_tokens: Number.isFinite(result.usage?.output_tokens)
													? result.usage.output_tokens
													: undefined,
												total_tokens: Number.isFinite(result.usage?.total_tokens)
													? result.usage.total_tokens
													: undefined,
											},
											cancelled: false,
										});
									}
								}
								boundary = /\r?\n\r?\n/.exec(buffer);
							}
							destination.enqueue(next.value);
						} catch (error) {
							fail(error);
							await reader.cancel().catch(() => {});
							destination.error(new Error("Host review transport stopped"));
						}
					},
					async cancel() {
						if (!terminal) fail(new Error("Host review stream cancelled"));
						await reader.cancel();
					},
				});
				return new Response(stream, { status: response.status, headers: response.headers });
			} catch (error) {
				fail(error);
				throw new Error("Host review request rejected; batch stopped");
			}
		},
		{ preconnect: originalFetch.preconnect },
	);
	return async () => {
		stop();
		await cleanup;
		globalThis.fetch = originalFetch;
	};
}

if (import.meta.main) {
	const mode = process.argv[2];
	assert(
		mode === "freeze" || mode === "freeze-integration",
		"Only deterministic freeze is available directly",
	);
	const path = process.argv[mode === "freeze" ? 3 : 4];
	assert(path, "Supply the freeze path");
	const result =
		mode === "freeze"
			? await reviewCompatibilityFreeze()
			: await reviewIntegrationFreeze(process.argv[3] ?? "");
	writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}
