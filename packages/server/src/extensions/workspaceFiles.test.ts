import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_CONTEXT_DIR } from "@thinkrail/shared/paths";
import { checkWorkspaceFile, createWorkspaceFiles, MOCKUP_DIR } from "./workspaceFiles";

describe("workspace file checks shared by extension server halves", () => {
	test("accepts workspace files and rejects missing, directory, and escaping paths", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "workspace-files-"));
		mkdirSync(join(cwd, MOCKUP_DIR), { recursive: true });
		writeFileSync(join(cwd, MOCKUP_DIR, "after.html"), "<p>after</p>");
		writeFileSync(join(cwd, "before.html"), "<p>before</p>");
		await expect(checkWorkspaceFile(`${MOCKUP_DIR}after.html`, cwd)).resolves.toBeUndefined();
		await expect(checkWorkspaceFile("before.html", cwd)).resolves.toBeUndefined();
		await expect(checkWorkspaceFile("missing.html", cwd)).rejects.toThrow("no such file");
		await expect(checkWorkspaceFile(".raildesign", cwd)).rejects.toThrow("not a regular file");
		await expect(checkWorkspaceFile("../outside.html", cwd)).rejects.toThrow("inside it");
		await expect(checkWorkspaceFile(join(cwd, "before.html"), cwd)).rejects.toThrow(
			"relative to the workspace",
		);
	});

	test("follows the host's read guard: dot-dot names pass, .git and escaping links do not", async () => {
		const root = mkdtempSync(join(tmpdir(), "workspace-guard-"));
		const cwd = join(root, "workspace");
		const outside = join(root, "outside");
		mkdirSync(join(cwd, ".git"), { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(cwd, "..draft.html"), "<p>draft</p>");
		writeFileSync(join(cwd, ".git", "config"), "[core]");
		writeFileSync(join(outside, "secret.html"), "<p>secret</p>");
		symlinkSync(outside, join(cwd, "linked"), "junction");
		await expect(checkWorkspaceFile("..draft.html", cwd)).resolves.toBeUndefined();
		await expect(checkWorkspaceFile(".git/config", cwd)).rejects.toThrow(
			".git directory is not shown",
		);
		await expect(checkWorkspaceFile("linked/secret.html", cwd)).rejects.toThrow(
			"a link points outside it",
		);
	});

	test("names the gitignored scratch directory for mockups", () => {
		expect(MOCKUP_DIR).toBe(".raildesign/context/mockups/");
		expect(MOCKUP_DIR.startsWith(`${WORKSPACE_CONTEXT_DIR}/`)).toBe(true);
	});
});

const savedDataDir = process.env.THINKRAIL_DATA_DIR;
const fixtures: string[] = [];
afterEach(() => {
	for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});
function artifactFixture() {
	const data = mkdtempSync(join(tmpdir(), "artifact-capability-"));
	fixtures.push(data);
	process.env.THINKRAIL_DATA_DIR = data;
	const cwd = join(data, "workspace");
	mkdirSync(cwd);
	const project = { id: "p", name: "P", path: cwd, lastOpened: 1 };
	writeFileSync(join(data, "projects.json"), JSON.stringify([project]));
	writeFileSync(
		join(data, "workspaces.json"),
		JSON.stringify([{ id: "w", projectId: "p", worktreePath: cwd, name: "W", createdAt: 1 }]),
	);
	let active = true;
	const files = createWorkspaceFiles("w", cwd, () => {
		if (!active) throw new Error("Stopped");
	});
	return {
		data,
		cwd,
		project,
		files,
		stop: () => {
			active = false;
		},
	};
}
test("the run-scoped capability seeds the folder and creates exclusive files without replacing user ignore rules", async () => {
	const { cwd, files } = artifactFixture();
	expect(await files.createArtifact("diagram.md", "v1")).toBe(
		".raildesign/context/visualize/diagram.md",
	);
	expect(readFileSync(join(cwd, ".raildesign/context/.gitignore"), "utf8")).toBe("*\n");
	writeFileSync(join(cwd, ".raildesign/context/.gitignore"), "custom\n");
	await expect(files.createArtifact("diagram.md", "v2")).rejects.toMatchObject({ code: "EEXIST" });
	expect(readFileSync(join(cwd, ".raildesign/context/visualize/diagram.md"), "utf8")).toBe("v1");
	expect(readFileSync(join(cwd, ".raildesign/context/.gitignore"), "utf8")).toBe("custom\n");
	for (const name of ["../escape.md", "x/y.md", "x\\y.md", "file.html"])
		await expect(files.createArtifact(name, "bad")).rejects.toThrow("Invalid artifact name");
});
test("Stop during asynchronous preparation prevents any artifact directories or bytes", async () => {
	const { cwd, files, stop } = artifactFixture();
	const saving = files.createArtifact("stopped.md", "bad");
	stop();
	await expect(saving).rejects.toThrow("Stopped");
	expect(existsSync(join(cwd, ".raildesign"))).toBe(false);
});
test("closing or replacing the workspace during preparation prevents a stale artifact save", async () => {
	const { data, cwd, files, project } = artifactFixture();
	const saving = files.createArtifact("closed.md", "bad");
	writeFileSync(join(data, "projects.json"), JSON.stringify([{ ...project, closed: true }]));
	await expect(saving).rejects.toThrow("no longer available");
	writeFileSync(join(data, "projects.json"), JSON.stringify([project]));
	const moved = files.createArtifact("moved.md", "bad");
	renameSync(cwd, `${cwd}-old`);
	mkdirSync(cwd);
	await expect(moved).rejects.toThrow("no longer available");
	expect(existsSync(join(cwd, ".raildesign"))).toBe(false);
});
test("an artifact context or visualization folder that is a symlink never writes outside", async () => {
	const { data, cwd, files } = artifactFixture();
	const outside = join(data, "outside");
	mkdirSync(outside);
	mkdirSync(join(cwd, ".raildesign"));
	symlinkSync(outside, join(cwd, ".raildesign", "context"), "junction");
	await expect(files.createArtifact("linked.md", "bad")).rejects.toThrow("not a real directory");
	rmSync(join(cwd, ".raildesign", "context"));
	mkdirSync(join(cwd, ".raildesign", "context"));
	symlinkSync(outside, join(cwd, ".raildesign", "context", "visualize"), "junction");
	await expect(files.createArtifact("linked.md", "bad")).rejects.toThrow("real directory");
	expect(existsSync(join(outside, "linked.md"))).toBe(false);
});
