import { randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	applyDiff,
	defineToolInputGuardrail,
	ToolGuardrailFunctionOutputFactory,
	tool,
} from "@openai/agents";
import type { UnixLocalSandboxSession } from "@openai/agents/sandbox/local";
import { truncateHead } from "@thinkrail/shared/toolOutput";
import { z } from "zod";
import { classifyBytes, decodeText, readFile, resolveWorktreeFile } from "../fs";
import { runBounded } from "../subprocess";
import { modelKeyEnvironmentNames } from "./modelConfiguration";

export interface ToolGrant {
	workspaceId: string;
	cwd: string;
	signal: AbortSignal;
	assertActive: () => void;
}

const FILE_LIMIT = 262144;
const OUTPUT_LIMIT = 32768;
// SDK 0.21 registers a running process for stop() only once the initial exec yields.
const SANDBOX_EXEC_YIELD_MS = 1000;
const bashParameters = z.object({
	command: z.string().min(1).max(16000),
	timeoutMs: z.number().int().min(1).max(120000),
});

// The SDK can ask for manual approval when a dynamic policy receives malformed JSON.
const sandboxBashInput = defineToolInputGuardrail({
	name: "sandbox-bash-input",
	async run({ toolCall }) {
		try {
			if (bashParameters.safeParse(JSON.parse(toolCall.arguments)).success) {
				return ToolGuardrailFunctionOutputFactory.allow();
			}
		} catch {
			// Invalid JSON is rejected below.
		}
		return ToolGuardrailFunctionOutputFactory.rejectContent(
			"Sandbox bash requires a command string and an integer timeoutMs between 1 and 120000.",
		);
	},
});

type SandboxCommand = { risk: "low" | "high"; cmd: string } | { risk: "unknown"; reason: string };

function sandboxCommand(grant: ToolGrant, command: string): SandboxCommand {
	if (command === "pwd") return { risk: "low", cmd: command };
	const match = /^rm -- ([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*)$/.exec(command);
	const relative = match?.[0] === command ? match[1] : undefined;
	if (
		relative === undefined ||
		relative.split("/").some((segment) => segment === "." || segment === "..")
	) {
		return {
			risk: "unknown",
			reason:
				"Sandbox bash accepts only bare pwd or rm -- <relative-file>. Use an unambiguous worktree path.",
		};
	}
	try {
		const path = target(grant, relative);
		if (
			!lstatSync(path).isFile() ||
			realpathSync(path) !== resolve(realpathSync(grant.cwd), relative)
		) {
			return {
				risk: "unknown",
				reason: "Sandbox rm requires one regular worktree file reached without symbolic links.",
			};
		}
	} catch (error) {
		return { risk: "unknown", reason: error instanceof Error ? error.message : String(error) };
	}
	return { risk: "high", cmd: `exec /bin/rm -- './${relative}'` };
}

async function readSandboxFile(grant: ToolGrant, session: UnixLocalSandboxSession, path: string) {
	const canonical = realpathSync(target(grant, path));
	if (canonical.trimEnd() !== canonical)
		throw new Error("Sandbox cannot read paths ending in whitespace because the SDK trims them");
	const stat = statSync(canonical);
	if (!stat.isFile()) throw new Error("Read target must be a file");
	if (stat.size > FILE_LIMIT) throw new Error("The file is larger than the read allows");
	const bytes = await session.readFile({ path: canonical, maxBytes: FILE_LIMIT + 1 });
	grant.assertActive();
	grant.signal.throwIfAborted();
	if (bytes.byteLength > FILE_LIMIT) throw new Error("The file is larger than the read allows");
	if (!classifyBytes(bytes).text) throw new Error("File is not text");
	return decodeText(bytes);
}

async function runSandboxCommand(
	grant: ToolGrant,
	session: UnixLocalSandboxSession,
	cmd: string,
	timeoutMs: number,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const result = await session.exec({
		cmd,
		workdir: realpathSync(grant.cwd),
		shell: "/bin/sh",
		login: false,
		tty: false,
		yieldTimeMs: Math.min(timeoutMs, SANDBOX_EXEC_YIELD_MS),
	});
	const timedOut = result.sessionId !== undefined;
	if (timedOut) await session.stop();
	grant.assertActive();
	signal.throwIfAborted();
	const out = truncateHead(result.stdout ?? "", { maxBytes: OUTPUT_LIMIT });
	const err = truncateHead(result.stderr ?? "", { maxBytes: OUTPUT_LIMIT });
	const ok = !timedOut && result.exitCode === 0 && !out.truncated && !err.truncated;
	return {
		ok,
		isError: !ok,
		out: out.content,
		err: err.content,
		timedOut,
		launchFailed: false,
		waitedMs: Math.round(result.wallTimeSeconds * 1000),
		...(out.truncated || err.truncated ? { outputLimitExceeded: true } : {}),
	};
}

export function toolEnvironment(
	modelKeys: ReadonlySet<string>,
): Record<string, string | undefined> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) =>
				!modelKeys.has(name.toUpperCase()) &&
				!/(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?|AUTHORIZATION)$/i.test(name),
		),
	);
}

function target(grant: ToolGrant, path: string): string {
	grant.assertActive();
	grant.signal.throwIfAborted();
	if (isAbsolute(path)) throw new Error("Use a path relative to the assigned worktree");
	return resolveWorktreeFile(grant.workspaceId, path);
}

export function applyWorkspacePatch(
	grant: ToolGrant,
	input: { path: string; diff: string; original: string | null },
): string {
	const path = target(grant, input.path);
	let previous: string | null = null;
	try {
		if (!statSync(path).isFile()) throw new Error("Patch target must be a file");
		previous = readFileSync(path, "utf8");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (previous !== input.original) throw new Error("Original text changed; read the file again");
	const content = applyDiff(previous ?? "", input.diff, previous === null ? "create" : "default");
	mkdirSync(dirname(path), { recursive: true });
	target(grant, input.path);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, {
			mode: previous === null ? 0o644 : statSync(path).mode & 0o777,
		});
		target(grant, input.path);
		if (previous !== null && readFileSync(path, "utf8") !== previous)
			throw new Error("Original text changed; read the file again");
		if (previous === null) {
			try {
				statSync(path);
				throw new Error("Patch target appeared; read the file again");
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
	return `Updated ${input.path}`;
}

export function workspaceTools(grant: ToolGrant, sandbox?: () => UnixLocalSandboxSession) {
	const modelKeys = new Set(modelKeyEnvironmentNames().map((name) => name.toUpperCase()));
	return [
		tool({
			errorFunction: null,
			name: "read",
			description:
				"Read a UTF-8 file in the assigned worktree. Read the original content before editing.",
			parameters: z.object({ path: z.string().min(1) }),
			execute({ path }) {
				if (sandbox) return readSandboxFile(grant, sandbox(), path);
				target(grant, path);
				const result = readFile(grant.workspaceId, path, { maxBytes: FILE_LIMIT });
				if (!result.meta.text) throw new Error("File is not text");
				return result.content;
			},
		}),
		tool({
			errorFunction: null,
			name: "search",
			description:
				"Search tracked and untracked worktree files with a literal text query. Git metadata and ignored files are excluded.",
			parameters: z.object({ query: z.string().min(1).max(1000) }),
			async execute({ query }, _context, details) {
				grant.assertActive();
				const result = await runBounded(
					[
						"git",
						"grep",
						"--no-index",
						"--exclude-standard",
						"-n",
						"-I",
						"-F",
						"--",
						query,
						".",
						":(exclude).git",
					],
					{
						cwd: grant.cwd,
						env: toolEnvironment(modelKeys),
						maxOutputBytes: 32768,
						timeoutMs: 10000,
						signal: details?.signal
							? AbortSignal.any([grant.signal, details.signal])
							: grant.signal,
					},
				);
				grant.assertActive();
				if (result.timedOut || result.launchFailed || result.aborted)
					throw new Error("Search did not complete");
				if (result.outputLimitExceeded)
					return `${result.out}\n[Search output truncated at 32768 bytes]`;
				if (!result.ok && (result.out || result.err))
					throw new Error(`Search failed: ${result.err || result.out}`);
				return result.out;
			},
		}),
		tool({
			errorFunction: null,
			name: "bash",
			description: sandbox
				? "In Sandbox mode, run bare pwd directly or request approval for rm -- <relative-file> to delete one regular worktree file. Other command forms are rejected. Supported commands have a maximum one-second timeout."
				: "Run a shell command in the assigned worktree, including project tests. Host permissions apply. Requires user approval.",
			parameters: bashParameters,
			...(sandbox ? { inputGuardrails: [sandboxBashInput] } : {}),
			needsApproval: sandbox
				? async (_context, args) => {
						const input = bashParameters.safeParse(args);
						return input.success && sandboxCommand(grant, input.data.command).risk === "high";
					}
				: true,
			async execute({ command, timeoutMs }, context, details) {
				grant.assertActive();
				const signal = details?.signal
					? AbortSignal.any([grant.signal, details.signal])
					: grant.signal;
				if (sandbox) {
					const classified = sandboxCommand(grant, command);
					if (classified.risk === "unknown") throw new Error(classified.reason);
					const callId = details?.toolCall?.callId;
					if (
						classified.risk === "high" &&
						(!callId || context?.isToolApproved({ toolName: "bash", callId }) !== true)
					) {
						throw new Error("Deleting a worktree file requires approval for this command");
					}
					return runSandboxCommand(grant, sandbox(), classified.cmd, timeoutMs, signal);
				}
				const result = await runBounded(
					process.platform === "win32"
						? ["cmd.exe", "/d", "/s", "/c", command]
						: ["/bin/sh", "-c", command],
					{
						cwd: grant.cwd,
						env: toolEnvironment(modelKeys),
						maxOutputBytes: 32768,
						signal,
						timeoutMs,
					},
				);
				grant.assertActive();
				return {
					...result,
					isError: !result.ok,
					out: result.out.slice(0, 32768),
					err: result.err.slice(0, 32768),
				};
			},
		}),
		tool({
			errorFunction: null,
			name: "apply_patch",
			description:
				"Create or update one file with a V4A diff. Supply exact original file text, or null for a new file. Requires user approval.",
			parameters: z.object({
				path: z.string().min(1),
				diff: z
					.string()
					.min(1)
					.max(524288)
					.describe(
						"Headerless V4A diff, not full replacement text. For an existing file, start each section with @@ and prefix every following line with '-' (remove), '+' (add), or a space (context). Example: @@\n-before\n+after\n. For a new file, prefix every line with '+', e.g. +first line\n+second line\n. Omit file headers and numbered unified-diff headers.",
					),
				original: z
					.string()
					.max(262144)
					.nullable()
					.describe(
						"Exact entire original UTF-8 file content from read, including whitespace and trailing newlines. Use null only when creating a new file.",
					),
			}),
			needsApproval: true,
			execute(input) {
				return applyWorkspacePatch(grant, input);
			},
		}),
	];
}
