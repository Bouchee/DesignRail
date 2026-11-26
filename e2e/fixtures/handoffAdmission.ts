// Test-only host preload for `agent-handoffs.live.spec.ts`: every outgoing host fetch is reserved in
// the supplied ledger before transport, and the run stops at the first failure or at the request cap.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { abortSession, liveSessionIdsOf, responsesClientSettings } from "@thinkrail/server/agent";

const HANDOFF_REQUEST_CAP = 8;
const RESPONSES_URL = "https://opencode.ai/inference/go/openai/v1/responses";
const MODEL = "deepseek-v4.1-flash";

interface HandoffLedgerEntry {
	id: string;
	phase: string;
	started_at: string;
	state: "reserved" | "completed" | "failed";
	request: Record<string, unknown>;
	evidence?: Record<string, unknown>;
}
interface HandoffLedger {
	request_cap: number;
	batch_start: number;
	requests: HandoffLedgerEntry[];
}

function assertHandoffLedger(ledger: HandoffLedger): void {
	assert.equal(ledger.request_cap, HANDOFF_REQUEST_CAP, "Unexpected request allowance");
	assert.equal(ledger.batch_start, 0, "Unexpected request batch boundary");
	assert(Array.isArray(ledger.requests), "Invalid request ledger");
	assert(ledger.requests.length <= ledger.request_cap, "Request ledger exceeds its allowance");
	assert.equal(
		new Set(ledger.requests.map((entry) => entry.id)).size,
		ledger.requests.length,
		"Duplicate request identity",
	);
}

function updateLedger<T>(path: string, update: (ledger: HandoffLedger) => T): T {
	const fd = openSync(`${path}.lock`, "wx", 0o600);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const ledger: HandoffLedger = JSON.parse(readFileSync(path, "utf8"));
		assertHandoffLedger(ledger);
		const result = update(ledger);
		assertHandoffLedger(ledger);
		writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, path);
		return result;
	} finally {
		rmSync(temporary, { force: true });
		closeSync(fd);
		rmSync(`${path}.lock`);
	}
}

function currentPhase(path: string): string {
	try {
		return readFileSync(`${path}.phase`, "utf8").trim() || "unknown";
	} catch {
		return "unknown";
	}
}

const finite = (value: unknown) => (Number.isFinite(value) ? (value as number) : undefined);

function install(ledgerPath: string): () => void {
	const initial: HandoffLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
	assertHandoffLedger(initial);
	assert(
		initial.requests.every((entry) => entry.state !== "reserved"),
		"An unfinished reservation blocks this run",
	);
	// One SDK attempt per ledger entry: the host's retry owner is shared by every run in this process.
	responsesClientSettings.retry.maxRetries = 0;
	const originalFetch = globalThis.fetch;
	const controller = new AbortController();
	let admitted = true;
	let cleanup: Promise<unknown> = Promise.resolve();
	const stop = () => {
		if (!admitted) return;
		admitted = false;
		controller.abort();
		cleanup = Promise.allSettled(liveSessionIdsOf().map((id) => abortSession(id)));
	};
	const settle = (id: string, state: "completed" | "failed", evidence: Record<string, unknown>) =>
		updateLedger(ledgerPath, (ledger) => {
			const entry = ledger.requests.find((candidate) => candidate.id === id);
			assert(entry?.state === "reserved", "Request reservation is not pending");
			entry.state = state;
			entry.evidence = evidence;
		});

	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			assert(admitted, "Handoff live admission revoked");
			const request = new Request(input, init);
			const body = await request
				.clone()
				.json()
				.catch(() => ({}));
			let id: string;
			try {
				id = updateLedger(ledgerPath, (ledger) => {
					assert(ledger.requests.length < ledger.request_cap, "Request allowance exhausted");
					const entry: HandoffLedgerEntry = {
						id: randomUUID(),
						phase: currentPhase(ledgerPath),
						started_at: new Date().toISOString(),
						state: "reserved",
						request: {
							url: request.url === RESPONSES_URL ? request.url : "unexpected_destination",
							method: request.method,
							model: body.model === MODEL ? body.model : "unexpected_model",
							stream: body.stream === true,
							tool_names: Array.isArray(body.tools)
								? body.tools.map((item: { name?: unknown }) => String(item.name))
								: [],
							session_id: request.headers.get("x-opencode-session"),
						},
					};
					ledger.requests.push(entry);
					return entry.id;
				});
			} catch {
				stop();
				throw new Error("Handoff request refused before transport");
			}
			const started = performance.now();
			let settled = false;
			let httpStatus: number | undefined;
			const fail = (stage: string) => {
				if (!settled) {
					settled = true;
					settle(id, "failed", {
						stage,
						http_status: httpStatus,
						elapsed_ms: Math.round(performance.now() - started),
						cancelled: controller.signal.aborted,
					});
				}
				stop();
			};
			try {
				assert.equal(request.url, RESPONSES_URL);
				assert.equal(request.method, "POST");
				assert.equal(body.model, MODEL);
				assert.equal(body.stream, true);
				assert.equal(request.headers.get("user-agent"), "DesignRail/0.1");
				assert(
					Array.isArray(body.tools) &&
						body.tools.every((item: { type?: unknown }) => item.type === "function"),
					"Only ordinary function tools are admitted",
				);
			} catch {
				fail("request_contract");
				throw new Error("Unexpected host request; run stopped before transport");
			}
			const signal = AbortSignal.any([
				request.signal,
				controller.signal,
				AbortSignal.timeout(60_000),
			]);
			let response: Response;
			try {
				response = await originalFetch(new Request(request, { signal }));
				httpStatus = response.status;
				assert(response.ok && response.body, "Model transport failed");
			} catch (error) {
				fail("transport");
				throw error;
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let terminal = false;
			const stream = new ReadableStream<Uint8Array>({
				async pull(destination) {
					try {
						const next = await reader.read();
						if (next.done) {
							assert(terminal, "Missing terminal model event");
							destination.close();
							return;
						}
						buffer += decoder.decode(next.value, { stream: true });
						for (
							let boundary = /\r?\n\r?\n/.exec(buffer);
							boundary;
							boundary = /\r?\n\r?\n/.exec(buffer)
						) {
							const data = buffer
								.slice(0, boundary.index)
								.split(/\r?\n/)
								.filter((line) => line.startsWith("data:"))
								.map((line) => line.slice(5).trimStart())
								.join("\n");
							buffer = buffer.slice(boundary.index + boundary[0].length);
							if (!data || data === "[DONE]") continue;
							const event = JSON.parse(data);
							if (
								!["response.completed", "response.failed", "response.incomplete", "error"].includes(
									event.type,
								)
							)
								continue;
							terminal = true;
							const result = event.response;
							assert.equal(event.type, "response.completed", "Model response did not complete");
							const output: { type?: string; name?: string; role?: string }[] = result.output ?? [];
							settled = true;
							settle(id, "completed", {
								http_status: httpStatus,
								elapsed_ms: Math.round(performance.now() - started),
								response_id: result.id,
								response_status: result.status,
								output_types: output.map((item) => item.type),
								function_calls: output
									.filter((item) => item.type === "function_call")
									.map((item) => item.name),
								usage: {
									input_tokens: finite(result.usage?.input_tokens),
									output_tokens: finite(result.usage?.output_tokens),
									total_tokens: finite(result.usage?.total_tokens),
								},
							});
						}
						destination.enqueue(next.value);
					} catch {
						fail(terminal ? "terminal_rejected" : "stream");
						await reader.cancel().catch(() => {});
						destination.error(new Error("Handoff live transport stopped"));
					}
				},
				async cancel() {
					if (!terminal) fail("stream_cancelled");
					await reader.cancel();
				},
			});
			return new Response(stream, { status: response.status, headers: response.headers });
		},
		{ preconnect: originalFetch.preconnect },
	);
	return () => {
		// Synchronous so the receipt survives the host's own shutdown.
		updateLedger(ledgerPath, (ledger) => {
			for (const entry of ledger.requests)
				if (entry.state === "reserved") {
					entry.state = "failed";
					entry.evidence = { stage: "host_stopped" };
				}
		});
		stop();
		void cleanup.then(() => {
			globalThis.fetch = originalFetch;
		});
	};
}

if (
	process.env.RAILDESIGN_E2E_LIVE !== "1" ||
	process.env.RAILDESIGN_E2E_LIVE_RUNNER_AUTHORIZED !== "1"
)
	throw new Error("Handoff admission requires the protected public live runner");
const ledgerPath = process.env.RAILDESIGN_HANDOFF_LEDGER;
if (!ledgerPath) throw new Error("Set RAILDESIGN_HANDOFF_LEDGER to the approved request ledger");
const shutdown = install(ledgerPath);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
