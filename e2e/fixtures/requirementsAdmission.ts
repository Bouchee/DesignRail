import { appendFileSync, writeFileSync } from "node:fs";
import { responsesClientSettings } from "@thinkrail/server/agent";

const cap = Number(process.env.RAILDESIGN_REQUIREMENTS_REQUEST_CAP ?? "32");
if (!Number.isInteger(cap) || cap < 1 || cap > 32)
	throw new Error("Requirements acceptance request allowance must be an integer from 1 to 32");
const REQUEST_TIMEOUT_MS = 60_000;
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

writeFileSync(
	ledger,
	`${JSON.stringify({ cap, retries: 0, requestTimeoutMs: REQUEST_TIMEOUT_MS })}\n`,
	{
		flag: "wx",
		mode: 0o600,
	},
);
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
		append({
			event: "sent",
			number,
			startedAtMs: Date.now(),
			url: URL,
			model: MODEL,
			stream: body.stream === true,
			tools,
		});
		try {
			const response = await originalFetch(
				new Request(request, {
					signal: AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
				}),
			);
			append({
				event: "headers",
				number,
				status: response.status,
				elapsedMs: Math.round(performance.now() - started),
			});
			if (!response.ok) stopped = true;
			return response;
		} catch {
			append({ event: "transport_error", number });
			stopped = true;
			throw new Error("Requirements acceptance model transport failed");
		}
	},
	{ preconnect: originalFetch.preconnect },
);
