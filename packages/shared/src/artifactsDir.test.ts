import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedArtifactsDir } from "./artifactsDir";

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "trpi-artifacts-dir-")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

test("seeds the artifacts folder with a self-ignoring .gitignore, again after it was removed", () => {
	const dir = seedArtifactsDir(root);
	expect(dir).toBe(join(root, ".raildesign", "context"));
	expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
	rmSync(join(root, ".raildesign"), { recursive: true });
	seedArtifactsDir(root);
	expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("*\n");
});

test("never clobbers an existing .gitignore and never follows a link", () => {
	mkdirSync(join(root, ".raildesign", "context"), { recursive: true });
	writeFileSync(join(root, ".raildesign", "context", ".gitignore"), "mine\n");
	seedArtifactsDir(root);
	expect(readFileSync(join(root, ".raildesign", "context", ".gitignore"), "utf8")).toBe("mine\n");
	rmSync(join(root, ".raildesign"), { recursive: true });
	mkdirSync(join(root, "elsewhere"));
	symlinkSync(join(root, "elsewhere"), join(root, ".raildesign"));
	expect(() => seedArtifactsDir(root)).toThrow("not a real directory");
});
