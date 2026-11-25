import { appendFileSync, writeFileSync } from "node:fs";
import { responsesClientSettings } from "@thinkrail/server/agent";

const cap = Number(process.env.RAILDESIGN_REQUIREMENTS_REQUEST_CAP ?? "32");
if (!Number.isInteger(cap) || cap < 1 || cap > 32)
	throw new Error("Requirements acceptance request allowance must be an integer from 1 to 32");
const requestTimeoutMs = Number(process.env.RAILDESIGN_REQUIREMENTS_REQUEST_TIMEOUT_MS ?? 60_000);
if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 150_000)
	throw new Error("Requirements acceptance request timeout must be an integer from 1 to 150000 ms");
const URL = "https://opencode.ai/inference/go/openai/v1/responses";
const MODEL = "deepseek-v4.1-flash";
const ledger = process.env.RAILDESIGN_REQUIREMENTS_LEDGER;
if (
	!ledger ||
	process.env.RAILDESIGN_E2E_LIVE !== "1" ||
	process.env.RAILDESIGN_E2E_LIVE_RUNNER_AUTHORIZED !== "1"
) {
	throw new Error("Requirements acceptance admission requires the public live runner and a ledger");
}

const append = (entry: Record<string, unknown>) =>
	appendFileSync(ledger, `${JSON.stringify(entry)}\n`);
const tokenCount = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const terminalTypes = new Set(["response.completed", "response.incomplete", "response.failed"]);
const incompleteReasons = new Set([
	"max_output_tokens",
	"max_messages",
	"content_filter",
	"steered",
]);

function observeTerminal(response: Response, number: number, started: number): Response {
	if (!response.ok || !response.body) return response;
	const decoder = new TextDecoder();
	let buffer = "";
	let observed = false;
	const stream = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, destination) {
				destination.enqueue(chunk);
				if (observed) return;
				buffer += decoder.decode(chunk, { stream: true });
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
					try {
						const event = JSON.parse(data);
						if (!terminalTypes.has(event?.type)) continue;
						observed = true;
						buffer = "";
						const reason = event.response?.incomplete_details?.reason;
						const usage = event.response?.usage;
						append({
							event: event.type,
							number,
							elapsedMs: Math.round(performance.now() - started),
							incomplete_details: incompleteReasons.has(reason) ? { reason } : undefined,
							usage: {
								input_tokens: tokenCount(usage?.input_tokens),
								output_tokens: tokenCount(usage?.output_tokens),
								total_tokens: tokenCount(usage?.total_tokens),
								reasoning_tokens: tokenCount(usage?.output_tokens_details?.reasoning_tokens),
							},
						});
					} catch {
						// Observation errors must not interrupt the SDK stream.
					}
				}
			},
		}),
	);
	return new Response(stream, response);
}

writeFileSync(ledger, `${JSON.stringify({ cap, retries: 0, requestTimeoutMs })}\n`, {
	flag: "wx",
	mode: 0o600,
});
responsesClientSettings.retry.maxRetries = 0;
const originalFetch = globalThis.fetch;
let requests = 0;
let stopped = false;
globalThis.fetch = Object.assign(
	async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const request = new Request(input, init);
		const body = await request
			.clone()
			.json()
			.catch(() => null);
		if (
			stopped ||
			requests >= cap ||
			request.url !== URL ||
			request.method !== "POST" ||
			body?.model !== MODEL
		) {
			append({ event: "refused", requests });
			stopped = true;
			throw new Error("Requirements acceptance refused a request before transport");
		}
		const tools = Array.isArray(body.tools)
			? body.tools.flatMap((item: { name?: unknown }) =>
					typeof item?.name === "string" ? [item.name] : [],
				)
			: [];
		if (tools.includes("read") && !tools.includes("requirements_prepare")) {
			append({ event: "refused_missing_requirements", tools });
			stopped = true;
			throw new Error("Requirements tools were absent from the live workspace request");
		}
		const number = ++requests;
		const started = performance.now();
		const effort = body.reasoning?.effort;
		append({
			event: "sent",
			number,
			startedAtMs: Date.now(),
			url: URL,
			model: MODEL,
			stream: body.stream === true,
			reasoning_effort: effort === "none" ? "none" : effort === undefined ? null : "other",
			max_output_tokens: tokenCount(body.max_output_tokens) ?? null,
			tools,
		});
		try {
			const response = await originalFetch(
				new Request(request, {
					signal: AbortSignal.any([request.signal, AbortSignal.timeout(requestTimeoutMs)]),
				}),
			);
			append({
				event: "headers",
				number,
				status: response.status,
				elapsedMs: Math.round(performance.now() - started),
			});
			if (!response.ok) stopped = true;
			return body.stream === true ? observeTerminal(response, number, started) : response;
		} catch {
			append({ event: "transport_error", number });
			stopped = true;
			throw new Error("Requirements acceptance model transport failed");
		}
	},
	{ preconnect: originalFetch.preconnect },
);
