import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { dataDir } from "../persistence";
import { runBounded } from "../subprocess";
import { modelKeyEnvironmentNames } from "./modelConfiguration";
import { type ToolGrant, toolEnvironment } from "./sdkTools";
import { readAdmittedSkill, type SkillToolOptions } from "./skillTools";

export type WorkflowReview = {
	workflow: "requirements" | "scheme";
	id: string;
	markdown: string;
	applyCallId?: string | undefined;
	applyAccepted?: true | undefined;
};

export const workflowScratchPrefix = ".workflow-input-";

export function applicationWorkflowSkill(options: SkillToolOptions, name: string) {
	try {
		const skill = readAdmittedSkill(options, name, null);
		const root = join(realpathSync(dataDir()), "skills", name);
		if (skill.path === join(root, "SKILL.md")) return { root, guidance: skill.text };
	} catch {
		options.assertActive();
		options.signal.throwIfAborted();
	}
	throw new Error(`Install and enable ${name} in the RailDesign application skills directory.`);
}

export function createWorkflowHost(grant: ToolGrant, skills: SkillToolOptions) {
	let busy = false;
	const env = toolEnvironment(
		new Set(modelKeyEnvironmentNames().map((name) => name.toUpperCase())),
	);

	function assertActive(signal?: AbortSignal) {
		grant.assertActive();
		signal?.throwIfAborted();
		if (!skills.admission().resourceTrusted) throw new Error("Project resources are not trusted");
	}

	async function perform<Result>(
		signal: AbortSignal | undefined,
		operation: () => Promise<Result>,
	) {
		assertActive(signal);
		if (busy) throw new Error("Wait for the previous engineering workflow tool to finish");
		busy = true;
		try {
			return await operation();
		} finally {
			busy = false;
		}
	}

	function installed(name: string) {
		return applicationWorkflowSkill(skills, name);
	}

	function script(skill: string, name: string): string {
		const path = join(installed(skill).root, "scripts", name);
		if (realpathSync(path) !== path || !statSync(path).isFile())
			throw new Error(`Reinstall the application Skill containing ${name}.`);
		return path;
	}

	async function run(skill: string, name: string, args: string[], signal?: AbortSignal) {
		assertActive(signal);
		const path = (env.PATH ?? env.Path ?? "").split(delimiter).filter(isAbsolute).join(delimiter);
		const python =
			path && Bun.which(process.platform === "win32" ? "python" : "python3", { PATH: path });
		if (!python)
			throw new Error("Install Python 3.11 or later and add it to the RailDesign host PATH");
		const output = await runBounded(
			[python, "-E", "-s", "-B", "-X", "utf8", script(skill, name), ...args],
			{
				cwd: grant.cwd,
				env,
				maxOutputBytes: 4 * 1024 * 1024,
				timeoutMs: 60_000,
				signal: signal ? AbortSignal.any([signal, grant.signal]) : grant.signal,
			},
		);
		assertActive(signal);
		if (output.launchFailed || output.timedOut || output.aborted || output.outputLimitExceeded)
			throw new Error(
				`${skill} runner did not finish. Check the current workflow before retrying.`,
			);
		const data: unknown = JSON.parse(output.out);
		return { ok: output.ok, data, raw: output.out };
	}

	async function withScratch<Result>(action: (relativePath: string) => Promise<Result>) {
		assertActive();
		const directory = mkdtempSync(join(grant.cwd, workflowScratchPrefix));
		try {
			return await action(basename(directory));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}

	return { grant, assertActive, perform, installed, script, run, withScratch };
}

export type WorkflowHost = ReturnType<typeof createWorkflowHost>;
