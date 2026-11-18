import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	defineToolInputGuardrail,
	defineToolOutputGuardrail,
	type InputGuardrail,
	ToolGuardrailFunctionOutputFactory,
	type ToolInputGuardrailDefinition,
	type ToolOutputGuardrailDefinition,
} from "@openai/agents";
import { z } from "zod";
import { redactMcpText, TOKEN_LITERAL } from "./mcp";

/**
 * One run's guardrails. The SDK definitions are named after the rule they enforce. `output` is the host
 * gate for model-written assistant text (not an SDK output guardrail): `match` decides a whole text, and
 * a match can need at most `window` trailing characters, so text older than `window - 1` characters at
 * the end of a growing message is final.
 */
export interface GuardrailPolicy {
	agentInput: InputGuardrail[];
	toolInput: ToolInputGuardrailDefinition[];
	toolOutput: ToolOutputGuardrailDefinition[];
	output: { window: number; match: (text: string) => { rule: string } | undefined };
	redact: (text: string) => string;
}

/** Assistant text that the output gate refused; the run settles with the guardrail outcome. */
export class GuardrailOutputBlockedError extends Error {
	readonly rule: string;
	constructor(rule: string) {
		super(`Assistant output blocked by guardrail "${rule}"`);
		this.rule = rule;
		this.name = "GuardrailOutputBlockedError";
	}
}

export class GuardrailConfigurationError extends Error {
	constructor(path: string, reason: string) {
		super(`Invalid guardrail configuration ${path}: ${reason}`);
		this.name = "GuardrailConfigurationError";
	}
}

/** The built-in rule's name; rule files cannot reuse it. */
export const SECRET_RULE = "secret";
const STAGES = ["userInput", "finalOutput", "toolInput", "toolOutput"] as const;
type Stage = (typeof STAGES)[number];
const MAX_FILE_BYTES = 64 * 1024;
const MAX_PATTERN = 1024;
const MIN_CREDENTIAL = 8;
const TOKEN = new RegExp(String.raw`\b${TOKEN_LITERAL}`);
// The longest TOKEN_LITERAL prefix (`github_pat_`), its eight required characters and the boundary before it.
const TOKEN_WINDOW = 11 + 8 + 1;

const ruleBase = {
	name: z
		.string()
		.regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "rule names use 1-64 letters, digits, _ . -")
		.refine((name) => name !== SECRET_RULE, `"${SECRET_RULE}" is the built-in rule`),
	stages: z
		.array(z.enum(STAGES))
		.min(1)
		.refine((stages) => new Set(stages).size === stages.length, "a stage is listed twice"),
};
const documentSchema = z.strictObject({
	version: z.literal(1),
	rules: z
		.array(
			z
				.strictObject({
					...ruleBase,
					literal: z.string().min(1).max(MAX_PATTERN).optional(),
					regex: z.string().min(1).max(MAX_PATTERN).optional(),
				})
				.refine(
					(rule) => (rule.literal === undefined) !== (rule.regex === undefined),
					"a rule has exactly one of literal or regex",
				),
		)
		.max(200)
		.refine(
			(rules) => new Set(rules.map((rule) => rule.name)).size === rules.length,
			"a rule name is declared twice",
		),
});

interface Rule {
	name: string;
	stages: ReadonlySet<Stage>;
	literal?: string;
	matches: (text: string) => boolean;
}

function readRules(options: { cwd?: string; dataDir: string; projectTrusted: boolean }): Rule[] {
	const paths = [
		...(options.cwd && options.projectTrusted
			? [join(options.cwd, ".raildesign", "guardrails.json")]
			: []),
		join(options.dataDir, "guardrails.json"),
	];
	for (const path of paths) {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		const fail = (reason: string): never => {
			throw new GuardrailConfigurationError(path, reason);
		};
		if (Buffer.byteLength(text) > MAX_FILE_BYTES) fail(`larger than ${MAX_FILE_BYTES} bytes`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			fail("not valid JSON");
		}
		const result = documentSchema.safeParse(parsed);
		if (!result.success) {
			const issue = result.error.issues[0];
			return fail(
				issue ? `${issue.path.join(".") || "document"}: ${issue.message}` : "invalid document",
			);
		}
		return result.data.rules.map((rule) => {
			const { literal, regex = "" } = rule;
			if (literal === undefined && rule.stages.includes("finalOutput"))
				fail(`rule "${rule.name}": finalOutput rules accept literal strings only`);
			let matches: (text: string) => boolean;
			if (literal !== undefined) matches = (text) => text.includes(literal);
			else {
				let pattern: RegExp;
				try {
					pattern = new RegExp(regex, "u");
				} catch {
					return fail(`rule "${rule.name}" has an invalid regular expression`);
				}
				matches = (text) => pattern.test(text);
			}
			return {
				name: rule.name,
				stages: new Set(rule.stages),
				...(literal !== undefined ? { literal } : {}),
				matches,
			};
		});
	}
	return [];
}

/** String leaves of a JSON-like value; image payloads are skipped. */
function leaves(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) leaves(item, out);
	else if (value && typeof value === "object") {
		const type = (value as { type?: unknown }).type;
		if (type === "image" || type === "input_image") return out;
		for (const item of Object.values(value)) leaves(item, out);
	}
	return out;
}

function argumentText(raw: string): string {
	try {
		return [raw, ...leaves(JSON.parse(raw))].join("\n");
	} catch {
		return raw;
	}
}

/** The newest input: the trailing user messages after the last model or tool item. */
function newestUserText(input: string | readonly unknown[]): string {
	if (typeof input === "string") return input;
	const trailing: unknown[] = [];
	for (let index = input.length - 1; index >= 0; index--) {
		const item = input[index] as { role?: unknown; type?: unknown };
		if (item?.role !== "user" || (item.type !== undefined && item.type !== "message")) break;
		trailing.unshift(item);
	}
	return leaves(trailing).join("\n");
}

const info = (rule: string) => ({ rule });

/**
 * Reads the personal or trusted project rule file (the project file replaces the personal one) and adds
 * the always-on secret rule. Absent files add no rules; a malformed file throws
 * `GuardrailConfigurationError`. Execution guards match credentials of eight or more characters;
 * diagnostics redact every nonempty credential.
 */
export function loadGuardrailPolicy(input: {
	cwd?: string;
	dataDir: string;
	projectTrusted: boolean;
	credentials: readonly string[];
}): GuardrailPolicy {
	const credentials = [...new Set(input.credentials)].filter((value) => value.length > 0);
	const hasCredential = (text: string, minimumLength = MIN_CREDENTIAL) =>
		credentials.some((value) => value.length >= minimumLength && text.includes(value));
	const secretInput = { name: SECRET_RULE, matches: hasCredential };
	const secretOutput = {
		name: SECRET_RULE,
		matches: (text: string) => hasCredential(text) || TOKEN.test(text),
	};
	const rules = readRules(input);
	const at = (stage: Stage) => rules.filter((rule) => rule.stages.has(stage));
	const outputRules = at("finalOutput");
	return {
		redact: (text) => (hasCredential(text, 1) ? "***" : redactMcpText(text)),
		agentInput: at("userInput").map((rule) => ({
			name: rule.name,
			runInParallel: false,
			execute: async ({ input: items }) => ({
				tripwireTriggered: rule.matches(newestUserText(items)),
				outputInfo: info(rule.name),
			}),
		})),
		toolInput: [secretInput, ...at("toolInput")].map((rule) =>
			defineToolInputGuardrail({
				name: rule.name,
				run: async ({ toolCall }) =>
					rule.matches(argumentText(toolCall.arguments))
						? ToolGuardrailFunctionOutputFactory.rejectContent(
								`Tool call rejected by guardrail "${rule.name}"; it was not run. Do not put credentials or blocked content in tool arguments.`,
								info(rule.name),
							)
						: ToolGuardrailFunctionOutputFactory.allow(),
			}),
		),
		toolOutput: [secretOutput, ...at("toolOutput")].map((rule) =>
			defineToolOutputGuardrail({
				name: rule.name,
				run: async ({ output }) =>
					rule.matches(leaves(output).join("\n"))
						? ToolGuardrailFunctionOutputFactory.rejectContent(
								`Tool result withheld by guardrail "${rule.name}". The tool ran; its result may contain a credential or blocked content and is not shown to the model.`,
								info(rule.name),
							)
						: ToolGuardrailFunctionOutputFactory.allow(),
			}),
		),
		output: {
			window: Math.max(
				TOKEN_WINDOW,
				...credentials.map((value) => value.length),
				...outputRules.map((rule) => rule.literal?.length ?? 0),
			),
			match: (text) => {
				const rule = [secretOutput, ...outputRules].find((candidate) => candidate.matches(text));
				return rule && { rule: rule.name };
			},
		},
	};
}
