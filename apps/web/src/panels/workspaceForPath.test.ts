import { expect, mock, test } from "bun:test";
import type { WorkspacePathMatch } from "@thinkrail/contracts";

const requests: unknown[] = [];
let answer: WorkspacePathMatch | null = null;
let failure: Error | null = null;
const actualTransport = await import("../transport");
mock.module("../transport", () => ({
	...actualTransport,
	getTransport: () => ({
		request: (method: string, params: unknown) => {
			requests.push({ method, params });
			return failure ? Promise.reject(failure) : Promise.resolve(answer);
		},
	}),
}));
const { resolveWorkspaceFile } = await import("./workspaceForPath");

test("uses the host's authoritative real-path match without listing or matching roots locally", async () => {
	answer = { workspaceId: "wt", projectId: "repo", relativePath: "src/a.ts" };
	expect(await resolveWorkspaceFile("/private/tmp/repo/src/a.ts")).toEqual(answer);
	answer = null;
	expect(await resolveWorkspaceFile("/outside/a.ts")).toBeNull();
	expect(requests).toEqual([
		{ method: "workspace.resolvePath", params: { path: "/private/tmp/repo/src/a.ts" } },
		{ method: "workspace.resolvePath", params: { path: "/outside/a.ts" } },
	]);
});

test("propagates a failed authoritative read without a lexical fallback", async () => {
	failure = new Error("unreachable");
	await expect(resolveWorkspaceFile("/repo/a.ts")).rejects.toThrow("unreachable");
	failure = null;
});
