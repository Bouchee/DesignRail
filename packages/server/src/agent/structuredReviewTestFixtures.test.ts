import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, Runner, tool } from "@openai/agents";
import { z } from "zod";
import {
	createConfiguredModel,
	listAvailableModels,
	responsesClientSettings,
	saveCustomEndpoint,
} from "./modelConfiguration";
import { planReviewOutput } from "./planReviewOutput";
import {
	finishReviewRequest,
	installHostReviewAdmission,
	REVIEW_COMPATIBILITY_OUTPUT,
	reserveReviewRequest,
	reviewCompatibilityFreeze,
	reviewIntegrationFreeze,
	runReviewCompatibility,
} from "./structuredReviewTestFixtures";

let directory: string;
let ledgerPath: string;
let previous: (string | undefined)[];
const keys = ["THINKRAIL_DATA_DIR", "OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAI_API_KEY"] as const;
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "raildesign-review-fixture-"));
	previous = keys.map((key) => process.env[key]);
	for (const key of keys) delete process.env[key];
	process.env.THINKRAIL_DATA_DIR = directory;
	ledgerPath = join(directory, "ledger.json");
	writeFileSync(ledgerPath, JSON.stringify({ request_cap: 5, batch_start: 0, requests: [] }));
	await saveCustomEndpoint({
		name: "Fixture",
		baseUrl: "https://opencode.ai/inference/go/openai/v1",
		apiKey: "secret-sentinel",
		models: [
			{
				id: "deepseek-v4.1-flash",
				contextWindow: null,
				maxTokens: 512,
				reasoning: null,
				vision: null,
				tools: true,
			},
		],
	});
});

async function hostAdmissionFixture() {
	for (const mode of ["nonstream", "stream"] as const)
		finishReviewRequest(
			ledgerPath,
			reserveReviewRequest(ledgerPath, "compatibility", mode, {}),
			true,
			{},
		);
	for (let index = 0; index < 3; index++)
		finishReviewRequest(
			ledgerPath,
			reserveReviewRequest(ledgerPath, "host_review", "stream", {}),
			true,
			{},
		);
	const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
	writeFileSync(ledgerPath, JSON.stringify({ ...ledger, request_cap: 25, batch_start: 5 }));
	const compatibilityPath = join(directory, "compatibility.json"),
		freezePath = join(directory, "integration.json");
	writeFileSync(compatibilityPath, JSON.stringify(await reviewCompatibilityFreeze()));
	writeFileSync(freezePath, JSON.stringify(await reviewIntegrationFreeze(compatibilityPath)));
	return { ledgerPath, freezePath, compatibilityPath };
}

async function hostAgent() {
	const model = (await listAvailableModels())[0];
	if (!model) throw new Error("Missing model");
	return new Agent({
		name: "Plan reviewer",
		outputType: planReviewOutput,
		model: createConfiguredModel(model, "owned-review-fixture"),
		modelSettings: { ...responsesClientSettings, maxTokens: 512, retry: { maxRetries: 0 } },
		tools: [
			tool({
				name: "read",
				description: "Read fixture",
				parameters: z.object({ path: z.string() }),
				execute: () => "fixture bytes",
			}),
		],
	});
}

test("host admission preserves incremental deltas and gates terminal delivery on ledger commit", async () => {
	const options = await hostAdmissionFixture(),
		release = Promise.withResolvers<void>();
	const mock = spyOn(globalThis, "fetch").mockImplementation(
		mockedFetch(async (request) => {
			expect(JSON.parse(readFileSync(ledgerPath, "utf8")).requests.at(-1).state).toBe("reserved");
			const terminal = await reply(true).text();
			return new Response(
				new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "fixture-message", output_index: 0, delta: "provisional" })}\n\n`,
							),
						);
						await release.promise;
						if (request.signal.aborted) {
							controller.close();
							return;
						}
						controller.enqueue(new TextEncoder().encode(terminal));
						controller.close();
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}),
	);
	let cleanup: (() => Promise<void>) | undefined;
	try {
		cleanup = await installHostReviewAdmission(options);
		const result = await new Runner({ tracingDisabled: true }).run(await hostAgent(), "Fixture", {
			stream: true,
			maxTurns: 1,
		});
		let provisional = false;
		for await (const event of result) {
			if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta") {
				provisional = true;
				expect(JSON.parse(readFileSync(ledgerPath, "utf8")).requests.at(-1).state).toBe("reserved");
				release.resolve();
			}
			if (event.type === "raw_model_stream_event" && event.data.type === "response_done")
				expect(JSON.parse(readFileSync(ledgerPath, "utf8")).requests.at(-1).state).toBe(
					"completed",
				);
		}
		await result.completed;
		expect(provisional).toBe(true);
		expect(result.finalOutput).toEqual(REVIEW_COMPATIBILITY_OUTPUT);
		expect(mock).toHaveBeenCalledTimes(1);
	} finally {
		release.resolve();
		await cleanup?.();
		mock.mockRestore();
	}
});

test("host admission rejects malformed/nonterminal SSE and retains failure before allowing another request", async () => {
	for (const terminal of [
		"data: invalid-json\n\n",
		`data: ${JSON.stringify({ type: "response.created", response: { id: "partial", status: "in_progress" } })}\n\n`,
	]) {
		writeFileSync(ledgerPath, JSON.stringify({ request_cap: 5, batch_start: 0, requests: [] }));
		const options = await hostAdmissionFixture();
		const mock = spyOn(globalThis, "fetch").mockImplementation(
			mockedFetch(
				() => new Response(terminal, { headers: { "Content-Type": "text/event-stream" } }),
			),
		);
		let cleanup: (() => Promise<void>) | undefined;
		try {
			cleanup = await installHostReviewAdmission(options);
			const run = async () => {
				const result = await new Runner({ tracingDisabled: true }).run(
					await hostAgent(),
					"Fixture",
					{ stream: true, maxTurns: 1 },
				);
				const completed = result.completed.catch(() => undefined);
				try {
					for await (const _event of result) {
					}
				} finally {
					await completed;
				}
				await result.completed;
			};
			await expect(run()).rejects.toThrow();
			expect(mock).toHaveBeenCalledTimes(1);
			expect(JSON.parse(readFileSync(ledgerPath, "utf8")).requests.at(-1).state).toBe("failed");
		} finally {
			await cleanup?.();
			mock.mockRestore();
		}
	}
});

test("host request timeout remains active through the streamed body and blocks further transport", async () => {
	const options = await hostAdmissionFixture();
	const timeout = new AbortController();
	const clock = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
		expect(milliseconds).toBe(30_000);
		return timeout.signal;
	});
	const mock = spyOn(globalThis, "fetch").mockImplementation(
		mockedFetch(
			(request) =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							request.signal.addEventListener(
								"abort",
								() => controller.error(request.signal.reason),
								{
									once: true,
								},
							);
							controller.enqueue(
								new TextEncoder().encode(
									`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "fixture-message", output_index: 0, delta: "provisional" })}\n\n`,
								),
							);
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				),
		),
	);
	let cleanup: (() => Promise<void>) | undefined;
	try {
		cleanup = await installHostReviewAdmission(options);
		const run = async () => {
			const result = await new Runner({ tracingDisabled: true }).run(await hostAgent(), "Fixture", {
				stream: true,
				maxTurns: 1,
			});
			const completed = result.completed.catch(() => undefined);
			try {
				for await (const event of result)
					if (event.type === "raw_model_stream_event" && event.data.type === "output_text_delta")
						timeout.abort(new DOMException("Fixture deadline", "TimeoutError"));
			} finally {
				await completed;
			}
			await result.completed;
		};
		await expect(run()).rejects.toThrow();
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).requests.at(-1)).toMatchObject({
			state: "failed",
			evidence: { model_timeout: true, cancelled: true },
		});
		await expect(run()).rejects.toThrow();
		expect(mock).toHaveBeenCalledTimes(1);
	} finally {
		await cleanup?.();
		clock.mockRestore();
		mock.mockRestore();
	}
});

test("host admission refuses an exhausted actual transport allowance before fetch and revokes further admission", async () => {
	const options = await hostAdmissionFixture();
	const mock = spyOn(globalThis, "fetch").mockImplementation(
		mockedFetch(() => {
			throw new Error("Unexpected network");
		}),
	);
	let cleanup: (() => Promise<void>) | undefined;
	try {
		cleanup = await installHostReviewAdmission(options);
		for (let i = 0; i < 20; i++)
			finishReviewRequest(
				ledgerPath,
				reserveReviewRequest(ledgerPath, "host_review", "stream", {}),
				true,
				{},
			);
		await expect(
			new Runner({ tracingDisabled: true }).run(await hostAgent(), "Fixture", { maxTurns: 1 }),
		).rejects.toThrow();
		expect(mock).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).requests).toHaveLength(25);
	} finally {
		await cleanup?.();
		mock.mockRestore();
	}
});

test("follow-up admits at most twenty new requests, preserves the closed prefix hash and blocks a repeated host case", async () => {
	const options = await hostAdmissionFixture();
	const initial = JSON.parse(readFileSync(ledgerPath, "utf8"));
	const prefixHash = createHash("sha256").update(JSON.stringify(initial.requests)).digest("hex");
	expect(() => finishReviewRequest(ledgerPath, initial.requests[0].id, false, {})).toThrow(
		"Historical",
	);
	expect(() => reserveReviewRequest(ledgerPath, "compatibility", "nonstream", {})).toThrow();
	for (let index = 0; index < initial.request_cap - initial.batch_start; index++) {
		const id = reserveReviewRequest(ledgerPath, "host_review", "stream", {});
		expect(() => reserveReviewRequest(ledgerPath, "host_review", "stream", {})).toThrow(
			"unfinished",
		);
		finishReviewRequest(ledgerPath, id, true, {});
	}
	const completed = JSON.parse(readFileSync(ledgerPath, "utf8"));
	expect(completed.requests.length - completed.batch_start).toBe(20);
	expect(completed.requests).toHaveLength(25);
	expect(
		createHash("sha256")
			.update(JSON.stringify(completed.requests.slice(0, completed.batch_start)))
			.digest("hex"),
	).toBe(prefixHash);
	expect(() => reserveReviewRequest(ledgerPath, "host_review", "stream", {})).toThrow("Total");
	await expect(installHostReviewAdmission(options)).rejects.toThrow("fresh request batch");
});

test("invalid follow-up boundaries, caps, prefix order and duplicate historical entries cannot change the ledger", async () => {
	await hostAdmissionFixture();
	const initial = JSON.parse(readFileSync(ledgerPath, "utf8"));
	const variants = [
		{ ...initial, batch_start: undefined },
		{ ...initial, batch_start: 4 },
		{ ...initial, request_cap: 26 },
		{ ...initial, requests: initial.requests.slice(0, 4) },
		{
			...initial,
			requests: [{ ...initial.requests[0], phase: "host_review" }, ...initial.requests.slice(1)],
		},
		{
			...initial,
			requests: [
				initial.requests[0],
				{ ...initial.requests[1], mode: "nonstream" },
				...initial.requests.slice(2),
			],
		},
		{
			...initial,
			requests: [{ ...initial.requests[0], state: "failed" }, ...initial.requests.slice(1)],
		},
		{ ...initial, requests: [...initial.requests, initial.requests[0]] },
	];
	for (const invalid of variants) {
		const bytes = JSON.stringify(invalid);
		writeFileSync(ledgerPath, bytes);
		expect(() => reserveReviewRequest(ledgerPath, "host_review", "stream", {})).toThrow();
		expect(readFileSync(ledgerPath, "utf8")).toBe(bytes);
	}
	writeFileSync(ledgerPath, JSON.stringify(initial));
	finishReviewRequest(
		ledgerPath,
		reserveReviewRequest(ledgerPath, "host_review", "stream", {}),
		false,
		{},
	);
	expect(() => reserveReviewRequest(ledgerPath, "host_review", "stream", {})).toThrow("failed");
	expect(
		JSON.parse(readFileSync(ledgerPath, "utf8")).requests.slice(0, initial.batch_start),
	).toEqual(initial.requests);
});
afterEach(() => {
	keys.forEach((key, index) => {
		const value = previous[index];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	});
	rmSync(directory, { recursive: true, force: true });
});

function reply(stream: boolean, status = "completed", refusal = false) {
	const response = {
		id: "fixture-response",
		object: "response",
		created_at: 1,
		status,
		model: "deepseek-v4.1-flash",
		output: [
			{
				type: "message",
				role: "assistant",
				status: "completed",
				id: "fixture-message",
				content: [
					{
						type: "output_text",
						text: JSON.stringify(REVIEW_COMPATIBILITY_OUTPUT),
						annotations: [],
					},
					...(refusal ? [{ type: "refusal", refusal: "Declined" }] : []),
				],
			},
		],
		usage: { input_tokens: 10, output_tokens: 12, total_tokens: 22 },
	};
	if (!stream) return Response.json(response, { headers: { "x-request-id": "fixture-request" } });
	return new Response(
		[
			{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
			{ type: "response.completed", response },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "Content-Type": "text/event-stream", "x-request-id": "fixture-request" } },
	);
}

function mockedFetch(handler: (request: Request) => Response | Promise<Response>): typeof fetch {
	return Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
			handler(new Request(input, init)),
		{
			preconnect: () => {
				throw new Error("Unexpected preconnect");
			},
		},
	);
}

test("atomic ledger bounds phase/total allowance, requires compatibility order and blocks unfinished or failed batches", () => {
	expect(() => reserveReviewRequest(ledgerPath, "compatibility", "stream", {})).toThrow();
	expect(() => reserveReviewRequest(ledgerPath, "host_review", "stream", {})).toThrow();
	const first = reserveReviewRequest(ledgerPath, "compatibility", "nonstream", {});
	expect(() => reserveReviewRequest(ledgerPath, "compatibility", "stream", {})).toThrow(
		"unfinished",
	);
	finishReviewRequest(ledgerPath, first, true, {});
	const second = reserveReviewRequest(ledgerPath, "compatibility", "stream", {});
	finishReviewRequest(ledgerPath, second, true, {});
	expect(() => reserveReviewRequest(ledgerPath, "compatibility", "stream", {})).toThrow();
	for (let index = 0; index < 3; index++)
		finishReviewRequest(
			ledgerPath,
			reserveReviewRequest(ledgerPath, "host_review", "stream", {}),
			true,
			{},
		);
	expect(() => reserveReviewRequest(ledgerPath, "host_review", "stream", {})).toThrow("Total");
	writeFileSync(ledgerPath, JSON.stringify({ request_cap: 5, batch_start: 0, requests: [] }));
	finishReviewRequest(
		ledgerPath,
		reserveReviewRequest(ledgerPath, "compatibility", "nonstream", {}),
		false,
		{},
	);
	expect(() => reserveReviewRequest(ledgerPath, "compatibility", "stream", {})).toThrow("failed");
	writeFileSync(`${ledgerPath}.lock`, "");
	expect(() => reserveReviewRequest(ledgerPath, "compatibility", "stream", {})).toThrow();
});

test("public configured Responses HTTP capture uses the frozen actual strict schema in both modes, with one reservation before each transport", async () => {
	const freezePath = join(directory, "freeze.json");
	const frozen = await reviewCompatibilityFreeze();
	writeFileSync(freezePath, JSON.stringify(frozen));
	const bodies: Record<string, unknown>[] = [];
	const mock = spyOn(globalThis, "fetch").mockImplementation(
		mockedFetch(async (request) => {
			const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
			expect(ledger.requests.at(-1).state).toBe("reserved");
			const body = await request.json();
			bodies.push(body);
			expect(body.text.format).toEqual(frozen.wire_format);
			expect(request.headers.get("authorization")).toBe("Bearer secret-sentinel");
			return reply(body.stream);
		}),
	);
	try {
		expect(await runReviewCompatibility({ ledgerPath, freezePath })).toEqual([
			REVIEW_COMPATIBILITY_OUTPUT,
			REVIEW_COMPATIBILITY_OUTPUT,
		]);
		expect(bodies.map((body) => body.stream)).toEqual([false, true]);
		const raw = readFileSync(ledgerPath, "utf8");
		expect(raw).not.toContain("secret-sentinel");
		const ledger = JSON.parse(raw);
		expect(ledger.requests.map((entry: { state: string }) => entry.state)).toEqual([
			"completed",
			"completed",
		]);
		expect(ledger.requests[1].evidence.event_types).toContain("response_done");
		expect(ledger.requests[1].evidence.usage.requests).toBe(1);
	} finally {
		mock.mockRestore();
	}
});

test("SDK and client retries remain zero; first HTTP failure stops before stream admission", async () => {
	const freezePath = join(directory, "freeze.json");
	writeFileSync(freezePath, JSON.stringify(await reviewCompatibilityFreeze()));
	const mock = spyOn(globalThis, "fetch").mockImplementation(
		mockedFetch(() =>
			Response.json(
				{ error: { message: "private-provider-detail", type: "server_error" } },
				{ status: 500 },
			),
		),
	);
	try {
		await expect(runReviewCompatibility({ ledgerPath, freezePath })).rejects.toThrow(
			"batch stopped",
		);
		expect(mock).toHaveBeenCalledTimes(1);
		const raw = readFileSync(ledgerPath, "utf8");
		expect(raw).not.toContain("private-provider-detail");
		expect(JSON.parse(raw).requests[0].state).toBe("failed");
		expect(JSON.parse(raw).requests[0].evidence.classification).toBe("provider_error");
	} finally {
		mock.mockRestore();
	}
});

test("failure evidence classifies schema, authentication, routing, quota and network without retaining provider prose", async () => {
	const freezePath = join(directory, "freeze.json");
	writeFileSync(freezePath, JSON.stringify(await reviewCompatibilityFreeze()));
	for (const [status, classification] of [
		[400, "schema_or_parameter_rejected"],
		[401, "authentication"],
		[404, "routing"],
		[429, "quota_or_rate_limit"],
		[0, "network"],
	] as const) {
		writeFileSync(ledgerPath, JSON.stringify({ request_cap: 5, batch_start: 0, requests: [] }));
		const mock = spyOn(globalThis, "fetch").mockImplementation(
			mockedFetch(() => {
				if (status === 0) throw new Error("secret-sentinel network detail");
				return Response.json({ error: { message: "secret-sentinel provider detail" } }, { status });
			}),
		);
		try {
			await expect(runReviewCompatibility({ ledgerPath, freezePath })).rejects.toThrow(
				"batch stopped",
			);
			expect(mock).toHaveBeenCalledTimes(1);
			const raw = readFileSync(ledgerPath, "utf8");
			expect(raw).not.toContain("secret-sentinel");
			expect(JSON.parse(raw).requests[0].evidence.classification).toBe(classification);
		} finally {
			mock.mockRestore();
		}
	}
});

test("completed JSON mixed with refusal and unexpected response status are rejected without another request", async () => {
	const freezePath = join(directory, "freeze.json");
	writeFileSync(freezePath, JSON.stringify(await reviewCompatibilityFreeze()));
	for (const [status, refusal] of [
		["completed", true],
		["in_progress", false],
		["cancelled", false],
		["incomplete", false],
	] as const) {
		writeFileSync(ledgerPath, JSON.stringify({ request_cap: 5, batch_start: 0, requests: [] }));
		const mock = spyOn(globalThis, "fetch").mockImplementation(
			mockedFetch(() => reply(false, status, refusal)),
		);
		try {
			await expect(runReviewCompatibility({ ledgerPath, freezePath })).rejects.toThrow(
				"batch stopped",
			);
			expect(mock).toHaveBeenCalledTimes(1);
			expect(JSON.parse(readFileSync(ledgerPath, "utf8")).requests[0].state).toBe("failed");
		} finally {
			mock.mockRestore();
		}
	}
});

test("Stop rejects a late valid response, revokes subsequent admission and preserves the failed reservation", async () => {
	const freezePath = join(directory, "freeze.json");
	writeFileSync(freezePath, JSON.stringify(await reviewCompatibilityFreeze()));
	const controller = new AbortController();
	const mock = spyOn(globalThis, "fetch").mockImplementation(
		mockedFetch(() => {
			controller.abort();
			return reply(false);
		}),
	);
	try {
		await expect(
			runReviewCompatibility({ ledgerPath, freezePath, signal: controller.signal }),
		).rejects.toThrow("batch stopped");
		expect(mock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).requests[0].state).toBe("failed");
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).requests[0].evidence.classification).toBe(
			"cancelled",
		);
	} finally {
		mock.mockRestore();
	}
});

test("a schema-shaped but invalid verdict is classified as local validation, not a provider schema failure", async () => {
	const freezePath = join(directory, "freeze.json");
	writeFileSync(freezePath, JSON.stringify(await reviewCompatibilityFreeze()));
	const mock = spyOn(globalThis, "fetch").mockImplementation(
		mockedFetch(async () => {
			const body = await reply(false).json();
			body.output[0].content[0].text = '{"verdict":"request_changes","findings":[]}';
			return Response.json(body);
		}),
	);
	try {
		await expect(runReviewCompatibility({ ledgerPath, freezePath })).rejects.toThrow(
			"batch stopped",
		);
		expect(mock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).requests[0].evidence.classification).toBe(
			"local_validation",
		);
	} finally {
		mock.mockRestore();
	}
});

test("a changed frozen checker refuses transport", async () => {
	const freezePath = join(directory, "freeze.json");
	const frozen = await reviewCompatibilityFreeze();
	writeFileSync(freezePath, JSON.stringify({ ...frozen, schema_sha256: "changed" }));
	const mock = spyOn(globalThis, "fetch").mockImplementation(
		mockedFetch(() => {
			throw new Error("Unexpected transport");
		}),
	);
	try {
		await expect(runReviewCompatibility({ ledgerPath, freezePath })).rejects.toThrow("Frozen");
		expect(mock).not.toHaveBeenCalled();
	} finally {
		mock.mockRestore();
	}
});
