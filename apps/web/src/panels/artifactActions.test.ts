import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Workspace, WorkspaceArtifact, WsErrorCode } from "@thinkrail/contracts";
import { useAppStore } from "../store";
import { RequestError } from "../transport";
import * as wireTransport from "../transport/wireTransport";
import { openArtifact, restoreDeletedArtifact } from "./artifactActions";

const initial = useAppStore.getInitialState();
const PATH = ".raildesign/context/report.md";
const requests: string[] = [];
let restoreFailure: WsErrorCode | null = null;
let restoreGate: Promise<void> = Promise.resolve();
let restoreTransport = () => {};
const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
	id: "w1",
	projectId: "p1",
	name: "workspace-1",
	branch: "workspace-1",
	worktreePath: "/wt/w1",
	baseBranch: "main",
	...overrides,
});
const deleted = (deletedAt = 1): WorkspaceArtifact => ({
	path: PATH,
	state: "deleted",
	size: 1,
	changedAt: deletedAt,
	firstSeenAt: 1,
});
function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const restore = (artifact = deleted()) => restoreDeletedArtifact("w1", artifact);

beforeEach(() => {
	useAppStore.setState(initial, true);
	useAppStore.setState({
		status: "connected",
		connectionGeneration: 1,
		activeWorkspaceId: "w1",
		workspaces: { p1: [workspace()] },
		layoutAttentionByWorkspace: {
			w1: {
				selectedByGroup: {},
				lastFocusedCenterGroupId: "center",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: { center: 0 },
			},
		},
	});
	requests.length = 0;
	restoreFailure = null;
	restoreGate = Promise.resolve();
	const transport = {
		request: async (method: string) => {
			requests.push(method);
			if (method === "artifacts.restore") {
				const failure = restoreFailure;
				await restoreGate;
				if (failure) throw new RequestError(failure, "refused");
				return { ok: true };
			}
			if (method === "fs.readFile") {
				return {
					content: { kind: "text", text: "restored" },
					meta: { hash: "h", byteLength: 8, text: true },
				};
			}
			throw new Error(`Unexpected request: ${method}`);
		},
	} as unknown as ReturnType<typeof wireTransport.getTransport>;
	const spy = spyOn(wireTransport, "getTransport").mockReturnValue(transport);
	restoreTransport = () => spy.mockRestore();
});

afterEach(() => {
	restoreTransport();
	useAppStore.setState(initial, true);
});

test("opening a deleted artifact restores it before reading it", async () => {
	await openArtifact("w1", deleted(), "preview");
	expect(requests).toEqual(["artifacts.restore", "fs.readFile"]);
	expect(useAppStore.getState().toasts).toEqual([]);
	expect(useAppStore.getState().tabsByWorkspace.w1).toEqual([
		expect.objectContaining({
			kind: "file",
			path: PATH,
			content: { kind: "text", text: "restored" },
		}),
	]);
});

test("opening a live artifact uses the existing file open without restoring", async () => {
	await openArtifact("w1", { ...deleted(), state: "live" }, "keep");
	expect(requests).toEqual(["fs.readFile"]);
});

test("a taken path is not read or opened and reports why its kept copy cannot restore", async () => {
	restoreFailure = "ENTRY_EXISTS";
	await openArtifact("w1", deleted(), "keep");
	expect(requests).toEqual(["artifacts.restore"]);
	expect(useAppStore.getState().tabsByWorkspace.w1).toBeUndefined();
	expect(useAppStore.getState().toasts).toEqual([
		expect.objectContaining({
			variant: "error",
			title: "Couldn't restore",
			message: "report.md exists again, so its kept copy was not restored.",
		}),
	]);
});

test("a later navigation overtakes a restoring preview before its file read", async () => {
	const gate = deferred();
	restoreGate = gate.promise;
	const opened = openArtifact("w1", deleted(), "preview");
	useAppStore.getState().beginCenterNavigation("w1");
	gate.resolve();
	await opened;
	expect(requests).toEqual(["artifacts.restore"]);
	expect(useAppStore.getState().tabsByWorkspace.w1).toBeUndefined();
});

test("an overtaken kept open installs a background tab without activating it", async () => {
	const gate = deferred();
	restoreGate = gate.promise;
	const opened = openArtifact("w1", deleted(), "keep");
	useAppStore.getState().beginCenterNavigation("w1");
	gate.resolve();
	await opened;
	expect(requests).toEqual(["artifacts.restore", "fs.readFile"]);
	expect(useAppStore.getState().layoutIntents).toEqual([
		expect.objectContaining({ kind: "open", intent: "keep", activate: false }),
	]);
});

test("a row shares one pending and completed promise through DTO refreshes, until a new deletion", async () => {
	const gate = deferred();
	restoreGate = gate.promise;
	const first = restore();
	expect(restore(deleted())).toBe(first);
	useAppStore.getState().setWorkspaces("p1", [workspace({ name: "renamed" })]);
	expect(restore(deleted())).toBe(first);
	gate.resolve();
	expect(await first).toBe(true);
	expect(restore(deleted())).toBe(first);
	expect(requests).toEqual(["artifacts.restore"]);
	expect(await restore(deleted(2))).toBe(true);
	expect(requests).toEqual(["artifacts.restore", "artifacts.restore"]);
});

test("a failed restore can be retried by the next open", async () => {
	restoreFailure = "ARTIFACT_UNKNOWN";
	await openArtifact("w1", deleted(), "keep");
	expect(requests).toEqual(["artifacts.restore"]);
	restoreFailure = null;
	await openArtifact("w1", deleted(), "keep");
	expect(requests).toEqual(["artifacts.restore", "artifacts.restore", "fs.readFile"]);
});

test("an older failure does not evict the newer deletion's pending or successful promise", async () => {
	const old = deferred();
	restoreGate = old.promise;
	restoreFailure = "ARTIFACT_UNKNOWN";
	const first = restore(deleted(1));
	const current = deferred();
	restoreGate = current.promise;
	restoreFailure = null;
	const second = restore(deleted(2));
	old.resolve();
	expect(await first).toBe(false);
	expect(restore(deleted(2))).toBe(second);
	current.resolve();
	expect(await second).toBe(true);
	expect(restore(deleted(2))).toBe(second);
	expect(requests).toEqual(["artifacts.restore", "artifacts.restore"]);
});

test("an older successful restore cannot open after a newer deletion replaced it", async () => {
	const old = deferred();
	restoreGate = old.promise;
	const opened = openArtifact("w1", deleted(1), "keep");
	restoreGate = Promise.resolve();
	expect(await restore(deleted(2))).toBe(true);
	old.resolve();
	await opened;
	expect(requests).toEqual(["artifacts.restore", "artifacts.restore"]);
});

test("disconnect abandons a pending kept open, and reconnect issues a new restore", async () => {
	const gate = deferred();
	restoreGate = gate.promise;
	const opened = openArtifact("w1", deleted(), "keep");
	useAppStore.getState().setStatus("disconnected");
	gate.resolve();
	await opened;
	expect(requests).toEqual(["artifacts.restore"]);
	useAppStore.getState().setStatus("connected");
	expect(await restore()).toBe(true);
	expect(requests).toEqual(["artifacts.restore", "artifacts.restore"]);
});

test("a completed result does not survive reconnect", async () => {
	const first = restore();
	expect(await first).toBe(true);
	useAppStore.getState().setStatus("disconnected");
	useAppStore.getState().setStatus("connected");
	const second = restore();
	expect(second).not.toBe(first);
	expect(await second).toBe(true);
	expect(requests).toEqual(["artifacts.restore", "artifacts.restore"]);
});

test("workspace removal abandons a pending kept open even when the same id and root return", async () => {
	const gate = deferred();
	restoreGate = gate.promise;
	const opened = openArtifact("w1", deleted(), "keep");
	useAppStore.getState().applyWorkspaceRemoved("p1", "w1");
	useAppStore.setState({ removedWorkspaceIds: {}, workspaces: { p1: [workspace()] } });
	gate.resolve();
	await opened;
	expect(requests).toEqual(["artifacts.restore"]);
	expect(await restore()).toBe(true);
	expect(requests).toEqual(["artifacts.restore", "artifacts.restore"]);
});

for (const replacement of [
	workspace({ worktreePath: "/wt/replaced" }),
	workspace({ projectId: "p2" }),
]) {
	test(`a replacement workspace does not inherit the ${replacement.projectId}:${replacement.worktreePath} restore`, async () => {
		const gate = deferred();
		restoreGate = gate.promise;
		const opened = openArtifact("w1", deleted(), "keep");
		useAppStore.setState({ workspaces: { [replacement.projectId]: [replacement] } });
		gate.resolve();
		await opened;
		expect(requests).toEqual(["artifacts.restore"]);
		expect(await restore()).toBe(true);
		expect(requests).toEqual(["artifacts.restore", "artifacts.restore"]);
	});
}

test("missing or deleting workspaces do not restore", async () => {
	useAppStore.getState().updateWorkspace(workspace({ deletionPending: true }));
	expect(await restore()).toBe(false);
	useAppStore.setState({ workspaces: {} });
	expect(await restore()).toBe(false);
	expect(requests).toEqual([]);
});
