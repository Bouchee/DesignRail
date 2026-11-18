import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent, RunContext } from "@openai/agents";
import {
	GuardrailConfigurationError,
	type GuardrailPolicy,
	loadGuardrailPolicy,
} from "./guardrails";

let root: string, cwd: string, dataDir: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "raildesign-guardrails-"));
	cwd = join(root, "project");
	dataDir = join(root, "data");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function write(path: string, content: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}
const KEY = "configured-model-key-0123456789";
const TOKEN = "ghp_abcdefghijklmnop";
const agent = new Agent({ name: "probe" });
const context = new RunContext({});
const load = (projectTrusted = false, credentials: string[] = [KEY]) =>
	loadGuardrailPolicy({ cwd, dataDir, projectTrusted, credentials });
const call = (args: unknown) => ({
	type: "function_call" as const,
	callId: "call",
	name: "bash",
	arguments: JSON.stringify(args),
});

/** Every observable decision of a policy for one text, plus everything the SDK would retain. */
async function decide(policy: GuardrailPolicy, text: string) {
	const retained: unknown[] = [];
	const first = async <T>(
		items: T[],
		run: (item: T) => Promise<{ verdict: string; info: unknown }>,
	) => {
		for (const item of items) {
			const { verdict, info } = await run(item);
			retained.push(info);
			if (verdict !== "allow") return verdict;
		}
		return "allow";
	};
	return {
		userInput: await first(policy.agentInput, async (guardrail) => {
			const out = await guardrail.execute({
				agent,
				context,
				input: [{ role: "user", content: text }],
			});
			return {
				verdict: out.tripwireTriggered ? `stop:${guardrail.name}` : "allow",
				info: out.outputInfo,
			};
		}),
		finalOutput: await first([policy.output], async (gate) => {
			const hit = gate.match(text);
			return { verdict: hit ? `stop:${hit.rule}` : "allow", info: hit };
		}),
		toolInput: await first(policy.toolInput, async (guardrail) => {
			const out = await guardrail.run({ agent, context, toolCall: call({ command: text }) });
			return {
				verdict: out.behavior.type === "rejectContent" ? `reject:${guardrail.name}` : "allow",
				info: out,
			};
		}),
		toolOutput: await first(policy.toolOutput, async (guardrail) => {
			const out = await guardrail.run({ agent, context, toolCall: call({}), output: text });
			return {
				verdict: out.behavior.type === "rejectContent" ? `withhold:${guardrail.name}` : "allow",
				info: out,
			};
		}),
		retained: JSON.stringify(retained),
	};
}

test("without a rule file only the built-in secret rule applies, per stage", async () => {
	const policy = load();
	expect(await decide(policy, `key ${KEY}`)).toMatchObject({
		userInput: "allow",
		finalOutput: "stop:secret",
		toolInput: "reject:secret",
		toolOutput: "withhold:secret",
	});
	expect(await decide(policy, `token ${TOKEN}`)).toMatchObject({
		userInput: "allow",
		finalOutput: "stop:secret",
		toolInput: "allow",
		toolOutput: "withhold:secret",
	});
	expect(await decide(policy, "ordinary text")).toMatchObject({
		userInput: "allow",
		finalOutput: "allow",
		toolInput: "allow",
		toolOutput: "allow",
	});
});

test("retained guardrail information names the rule and never the matched text", async () => {
	write(
		join(dataDir, "guardrails.json"),
		JSON.stringify({
			version: 1,
			rules: [
				{
					name: "codename",
					stages: ["userInput", "finalOutput", "toolInput", "toolOutput"],
					literal: "BLUEBIRD",
				},
			],
		}),
	);
	for (const text of [`key ${KEY}`, `token ${TOKEN}`, "call BLUEBIRD now"]) {
		const { retained } = await decide(load(), text);
		expect(retained).not.toContain(KEY);
		expect(retained).not.toContain(TOKEN);
		expect(retained).not.toContain("BLUEBIRD");
	}
	const { retained } = await decide(load(), "call BLUEBIRD now");
	expect(retained).toContain('"rule":"codename"');
});

test("credentials shorter than eight characters, empty and duplicate values are not matched", async () => {
	const policy = load(false, ["", "short", "short"]);
	expect(await decide(policy, "a short answer")).toMatchObject({
		finalOutput: "allow",
		toolInput: "allow",
		toolOutput: "allow",
	});
	expect(policy.redact("a short answer")).toBe("***");
	expect(policy.redact("ordinary answer")).toBe("ordinary answer");
});

test("a credential inside JSON-escaped tool arguments is still rejected", async () => {
	const policy = load(false, ['quote"and\\slash-secret']);
	const [secret] = policy.toolInput;
	const out = await secret?.run({
		agent,
		context,
		toolCall: call({ text: 'quote"and\\slash-secret' }),
	});
	expect(out?.behavior.type).toBe("rejectContent");
});

test("rule-file rules apply only to their declared stages, as literal or regex", async () => {
	write(
		join(dataDir, "guardrails.json"),
		JSON.stringify({
			version: 1,
			rules: [
				{ name: "no-input", stages: ["userInput"], literal: "FORBIDDEN_IN" },
				{ name: "no-answer", stages: ["finalOutput"], literal: "internal.corp" },
				{ name: "no-args", stages: ["toolInput"], literal: "rm -rf /" },
				{ name: "no-results", stages: ["toolOutput"], regex: "PRIVATE-\\d{4}" },
			],
		}),
	);
	const policy = load();
	expect(await decide(policy, "say FORBIDDEN_IN")).toMatchObject({
		userInput: "stop:no-input",
		finalOutput: "allow",
		toolInput: "allow",
		toolOutput: "allow",
	});
	expect(await decide(policy, "see host.internal.corp")).toMatchObject({
		userInput: "allow",
		finalOutput: "stop:no-answer",
	});
	expect((await decide(policy, "rm -rf /")).toolInput).toBe("reject:no-args");
	expect(await decide(policy, "id PRIVATE-1234")).toMatchObject({
		toolInput: "allow",
		toolOutput: "withhold:no-results",
	});
});

test("the user-input stage examines only the newest user messages, not earlier history", async () => {
	write(
		join(dataDir, "guardrails.json"),
		JSON.stringify({
			version: 1,
			rules: [{ name: "stop", stages: ["userInput"], literal: "STOPWORD" }],
		}),
	);
	const [guardrail] = load().agentInput;
	const run = (input: Parameters<NonNullable<typeof guardrail>["execute"]>[0]["input"]) =>
		guardrail?.execute({ agent, context, input }).then((out) => out.tripwireTriggered);
	expect(guardrail?.runInParallel).toBe(false);
	expect(await run("STOPWORD")).toBe(true);
	const earlier = [
		{ role: "user" as const, content: "STOPWORD" },
		{
			type: "message" as const,
			role: "assistant" as const,
			status: "completed" as const,
			content: [{ type: "output_text" as const, text: "ok" }],
		},
	];
	expect(await run([...earlier, { role: "user", content: "next" }])).toBe(false);
	expect(
		await run([
			...earlier,
			{ role: "user", content: "first" },
			{ role: "user", content: [{ type: "input_text", text: "then STOPWORD" }] },
		]),
	).toBe(true);
});

test("a trusted project file replaces the personal file; an untrusted one is ignored", async () => {
	const rules = (name: string, literal: string) =>
		JSON.stringify({ version: 1, rules: [{ name, stages: ["toolOutput"], literal }] });
	write(join(dataDir, "guardrails.json"), rules("personal", "PERSONAL"));
	write(join(cwd, ".raildesign", "guardrails.json"), rules("project", "PROJECT"));
	expect((await decide(load(false), "PERSONAL")).toolOutput).toBe("withhold:personal");
	expect((await decide(load(false), "PROJECT")).toolOutput).toBe("allow");
	expect((await decide(load(true), "PROJECT")).toolOutput).toBe("withhold:project");
	expect((await decide(load(true), "PERSONAL")).toolOutput).toBe("allow");
	expect((await decide(load(true), `x ${KEY}`)).toolOutput).toBe("withhold:secret");
});

test.each([
	["malformed JSON", "{", "not valid JSON"],
	["unknown version", { version: 2, rules: [] }, "version"],
	["unknown keys", { version: 1, rules: [], extra: true }, "Unrecognized"],
	["no stages", { version: 1, rules: [{ name: "a", stages: [], literal: "x" }] }, "stages"],
	[
		"unknown stage",
		{ version: 1, rules: [{ name: "a", stages: ["any"], literal: "x" }] },
		"stages",
	],
	[
		"both literal and regex",
		{ version: 1, rules: [{ name: "a", stages: ["toolInput"], literal: "x", regex: "x" }] },
		"exactly one",
	],
	[
		"invalid regex",
		{ version: 1, rules: [{ name: "a", stages: ["toolInput"], regex: "(" }] },
		"invalid regular expression",
	],
	[
		"reserved name",
		{ version: 1, rules: [{ name: "secret", stages: ["toolInput"], literal: "x" }] },
		"built-in",
	],
	[
		"duplicate name",
		{
			version: 1,
			rules: [
				{ name: "a", stages: ["toolInput"], literal: "x" },
				{ name: "a", stages: ["toolOutput"], literal: "y" },
			],
		},
		"declared twice",
	],
	[
		"pattern too long",
		{ version: 1, rules: [{ name: "a", stages: ["toolInput"], literal: "x".repeat(1025) }] },
		"rules",
	],
	["file too large", { version: 1, rules: [], pad: "x".repeat(70_000) }, "larger than"],
])("a %s fails with a named error that cites the file", (_label, document, reason) => {
	const path = join(dataDir, "guardrails.json");
	write(path, typeof document === "string" ? document : JSON.stringify(document));
	let error: unknown;
	try {
		load();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(GuardrailConfigurationError);
	expect((error as Error).message).toContain(path);
	expect((error as Error).message).toContain(reason);
});

test("a malformed untrusted project file is ignored, not reported", () => {
	write(join(cwd, ".raildesign", "guardrails.json"), "{");
	expect(() => load(false)).not.toThrow();
	expect(() => load(true)).toThrow(GuardrailConfigurationError);
});

test("an output-stage regex rule fails to load; output literals stay literal", () => {
	write(
		join(dataDir, "guardrails.json"),
		JSON.stringify({
			version: 1,
			rules: [{ name: "a", stages: ["toolOutput", "finalOutput"], regex: "x+" }],
		}),
	);
	expect(() => load()).toThrow("finalOutput rules accept literal strings only");
	write(
		join(dataDir, "guardrails.json"),
		JSON.stringify({
			version: 1,
			rules: [{ name: "dots", stages: ["finalOutput"], literal: "a.b" }],
		}),
	);
	expect(load().output.match("axb")).toBeUndefined();
	expect(load().output.match("see a.b")).toEqual({ rule: "dots" });
});

test("the output window covers the longest credential, output literal and token shape", () => {
	expect(load(false, []).output.window).toBe(20);
	expect(load(false, ["k".repeat(40)]).output.window).toBe(40);
	write(
		join(dataDir, "guardrails.json"),
		JSON.stringify({
			version: 1,
			rules: [{ name: "long", stages: ["finalOutput"], literal: "z".repeat(64) }],
		}),
	);
	expect(load(false, []).output.window).toBe(64);
	rmSync(join(dataDir, "guardrails.json"));
	const { window, match } = load(false, [KEY]).output;
	expect(window).toBe(KEY.length);
	expect(match(`prefix ${KEY.slice(0, -1)}`)).toBeUndefined();
	expect(match(`prefix ${KEY}`)).toEqual({ rule: "secret" });
});
