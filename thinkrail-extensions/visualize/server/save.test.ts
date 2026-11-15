import { expect, test } from "bun:test";
import type { WorkspaceFiles } from "@thinkrail/extension-api/server";
import { saveVisualization, visualizationSlug, visualizationStamp } from "./save";

test("visualization names are bounded readable names with local timestamps", () => {
	expect(visualizationStamp(new Date(2026, 10, 15, 1, 2, 3))).toBe("20261115-010203");
	expect(visualizationSlug({ type: "diagram", title: " A / B 中文 " })).toBe("a-b-中文");
	expect(visualizationSlug({ type: "comparison", title: "?" })).toBe("comparison");
	expect(visualizationSlug({ type: "diagram", title: "a".repeat(100) }).length).toBe(48);
});
test("saving retries only occupied exclusive names and returns the actual host-owned path", async () => {
	const saved = new Map<string, string>();
	const files: WorkspaceFiles = {
		artifactsDir: ".raildesign/context/",
		scratchDir: "",
		check: async () => {},
		createArtifact: async (name, content) => {
			if (saved.has(name)) throw Object.assign(new Error("taken"), { code: "EEXIST" });
			saved.set(name, content);
			return `.raildesign/context/visualize/${name}`;
		},
	};
	const now = new Date(2026, 10, 15, 1, 2, 3);
	const params = { type: "diagram" as const, title: "Flow" };
	expect(await saveVisualization(files, params, "one", now)).toEndWith("-flow.md");
	expect(await saveVisualization(files, params, "two", now)).toEndWith("-flow-2.md");
	expect([...saved.values()]).toEqual(["one\n", "two\n"]);
});
test("authorization failures stop saving without retrying", async () => {
	let attempts = 0;
	const files: WorkspaceFiles = {
		artifactsDir: "",
		scratchDir: "",
		check: async () => {},
		createArtifact: async () => {
			attempts++;
			throw new Error("Stopped");
		},
	};
	await expect(saveVisualization(files, { type: "diagram" }, "bad")).rejects.toThrow("Stopped");
	expect(attempts).toBe(1);
});
