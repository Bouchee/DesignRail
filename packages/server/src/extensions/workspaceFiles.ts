import { lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WORKSPACE_MOCKUP_DIR } from "@thinkrail/contracts";
import type { WorkspaceFiles } from "@thinkrail/extension-api/server";
import { seedArtifactsDir } from "@thinkrail/shared/artifactsDir";
import { WORKSPACE_CONTEXT_DIR } from "@thinkrail/shared/paths";
import { loadProjects, loadWorkspaces } from "../persistence";

export const MOCKUP_DIR = `${WORKSPACE_MOCKUP_DIR}/`;

function inside(root: string, candidate: string): string | null {
	const rel = relative(root, candidate);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
	return rel;
}

export async function checkWorkspaceFile(path: string, cwd: string): Promise<void> {
	const absolute = resolve(cwd, path);
	const rel = isAbsolute(path) ? null : inside(resolve(cwd), absolute);
	if (rel === null)
		throw new Error("the path must be relative to the workspace and stay inside it");
	if (rel.split(sep).some((part) => part.toLowerCase() === ".git"))
		throw new Error("the .git directory is not shown");
	const info = await stat(absolute).catch(() => undefined);
	if (!info) throw new Error("no such file");
	if (!info.isFile()) throw new Error("not a regular file");
	if (inside(await realpath(cwd), await realpath(absolute)) === null) {
		throw new Error("the path must stay inside the workspace (a link points outside it)");
	}
}

export function createWorkspaceFiles(
	workspaceId: string,
	cwd: string,
	assertActive: () => void,
): WorkspaceFiles {
	const root = realpathSync(cwd);
	const identity = statSync(root, { bigint: true });
	const assertCurrent = () => {
		assertActive();
		const workspace = loadWorkspaces().find((item) => item.id === workspaceId);
		const project = loadProjects().find((item) => item.id === workspace?.projectId);
		const current = statSync(cwd, { bigint: true, throwIfNoEntry: false });
		if (
			!workspace ||
			workspace.deletionPending ||
			resolve(workspace.worktreePath) !== resolve(cwd) ||
			!project ||
			project.closed ||
			current?.dev !== identity.dev ||
			current.ino !== identity.ino ||
			realpathSync(cwd) !== root
		)
			throw new Error("The artifact workspace is no longer available");
	};
	return {
		check: checkWorkspaceFile,
		scratchDir: MOCKUP_DIR,
		artifactsDir: `${WORKSPACE_CONTEXT_DIR}/`,
		async createArtifact(name, content) {
			assertCurrent();
			if (!name || basename(name) !== name || /[/\\\0]/.test(name) || !name.endsWith(".md"))
				throw new Error("Invalid artifact name");
			await realpath(cwd).catch((error: unknown) => {
				assertCurrent();
				throw error;
			});
			assertCurrent();
			const context = seedArtifactsDir(root);
			const dir = join(context, "visualize");
			if (!lstatSync(dir, { throwIfNoEntry: false })) mkdirSync(dir);
			if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir)
				throw new Error("The visualization folder must be a real directory");
			assertCurrent();
			writeFileSync(join(dir, name), content, { flag: "wx" });
			return `${WORKSPACE_CONTEXT_DIR}/visualize/${name}`;
		},
	};
}
