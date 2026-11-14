import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	IMAGES_ROUTE,
	isRefImage,
	PROTOCOL_VERSION,
	type RefImage,
	type TranscriptMessage,
	type Workspace,
	WS_CHANNELS,
	type WsMethodName,
	type WsParams,
	type WsResult,
} from "@thinkrail/contracts";
import { sessionDirFor, writeFixtureSession } from "@thinkrail/server/history-test-fixtures";
import { hasSession, readSessionRecord, type SessionRecord, sessionImageSource } from "../agent";
import { resetImages, setImageSource } from "../images";
import { resetChatsStoreForTests } from "../persistence";
import { resetConfigCache } from "../settings";
import { setTrashImplementationForTests } from "../trash";
import { createChatRecord, resetChatIdCache } from "../workspaces";
import { createServer, type RunningServer } from "./server";
import { until } from "./testFixtures";

interface Frame {
	channel?: string;
	id?: string;
	ok?: boolean;
	result?: unknown;
	error?: string;
}

const SCREENSHOT = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
	Buffer.from("IHDR"),
	Buffer.from([0, 0, 3, 32, 0, 0, 2, 88]),
	Buffer.from("screenshot-bytes-that-must-not-ride-the-socket"),
]);
const DATA = SCREENSHOT.toString("base64");
const INLINE = { type: "image" as const, data: DATA, mimeType: "image/png" };
const savedDataDir = process.env.THINKRAIL_DATA_DIR;
let root: string;
let server: RunningServer;
let sockets: WebSocket[];

beforeEach(async () => {
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "raildesign-image-refs-")));
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	resetConfigCache();
	resetChatIdCache();
	resetChatsStoreForTests();
	sockets = [];
	setTrashImplementationForTests(async (input) => {
		for (const path of typeof input === "string" ? [input] : input) {
			rmSync(path, { recursive: true, force: true });
		}
	});
	server = await createServer({ port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
	try {
		for (const socket of sockets) socket.close();
		await server?.shutdown();
	} finally {
		setTrashImplementationForTests(undefined);
		resetConfigCache();
		resetChatIdCache();
		resetChatsStoreForTests();
		if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
		else process.env.THINKRAIL_DATA_DIR = savedDataDir;
		rmSync(root, { recursive: true, force: true });
	}
});

function url(ref: string): string {
	return `http://127.0.0.1:${server.port}${ref}`;
}

function imageRef(sessionId: string, data = DATA): string {
	const hash = createHash("sha256").update("image/png\0").update(data).digest("hex");
	return `${IMAGES_ROUTE}${sessionId}/${hash}`;
}

async function connect() {
	const socket = new WebSocket(
		`ws://127.0.0.1:${server.port}/ws?client=image-refs-${crypto.randomUUID()}&protocol=${PROTOCOL_VERSION}`,
	);
	sockets.push(socket);
	const replies = new Map<string, string>();
	let welcomed = false;
	socket.addEventListener("message", (event) => {
		const text = String(event.data);
		const frame = JSON.parse(text) as Frame;
		if (frame.channel === WS_CHANNELS.serverWelcome) welcomed = true;
		if (frame.id) replies.set(frame.id, text);
	});
	await until(() => welcomed, "image-reference client welcome");
	let sequence = 0;
	return {
		async request<M extends WsMethodName>(method: M, params: WsParams<M>) {
			const id = `image-${++sequence}`;
			socket.send(JSON.stringify({ id, method, params }));
			await until(() => replies.has(id), method);
			const text = replies.get(id);
			if (text === undefined) throw new Error(`No reply to ${method}`);
			const frame = JSON.parse(text) as Frame;
			if (!frame.ok) throw new Error(frame.error ?? `${method} failed`);
			return { result: frame.result as WsResult<M>, text };
		},
	};
}

async function openWorkspace(client: Awaited<ReturnType<typeof connect>>) {
	const path = join(root, `repo-${crypto.randomUUID()}`);
	mkdirSync(path);
	for (const args of [
		["init", "--quiet", "-b", "main"],
		[
			"-c",
			"user.email=image-refs@raildesign.invalid",
			"-c",
			"user.name=Image References Test",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--quiet",
			"--allow-empty",
			"-m",
			"fixture",
		],
	]) {
		const git = Bun.spawnSync(["git", ...args], { cwd: path, stdout: "pipe", stderr: "pipe" });
		if (!git.success) throw new Error(`Fixture git failed: ${git.stderr.toString()}`);
	}
	const { result: project } = await client.request("project.open", { path });
	const { result: workspaces } = await client.request("workspace.list", {
		projectId: project.id,
		includeDiffStats: false,
	});
	const workspace = workspaces.find((row) => row.kind === "default");
	if (!workspace) throw new Error("Opened project has no Default workspace");
	return workspace;
}

function seedSession(
	workspace: Workspace,
	messages: SessionRecord["messages"] = [{ role: "user", content: [INLINE], timestamp: 1 }],
	childRun?: SessionRecord["childRun"],
) {
	const fixture = writeFixtureSession(sessionDirFor(join(root, "data")), {
		workspaceId: workspace.id,
		cwd: workspace.worktreePath,
		messages: [],
	});
	const record = readSessionRecord(fixture.id);
	if (!record) throw new Error("Missing fresh session fixture");
	record.messages = messages.map((message, index) => ({
		...message,
		id: `${fixture.id}-m${index}`,
	}));
	if (childRun) record.childRun = childRun;
	writeFileSync(fixture.path, `${JSON.stringify(record)}\n`);
	expect(readSessionRecord(fixture.id)?.messages).toEqual(record.messages);
	return fixture;
}

function refs(messages: TranscriptMessage[]): RefImage[] {
	return messages.flatMap((message) =>
		"content" in message && Array.isArray(message.content)
			? message.content.filter(
					(block): block is RefImage => block.type === "image" && isRefImage(block),
				)
			: [],
	);
}

test("real transcript replies replace user, tool and custom images while GET and HEAD serve raw bytes", async () => {
	const client = await connect();
	const workspace = await openWorkspace(client);
	const fixture = seedSession(workspace, [
		{ role: "user", content: [{ type: "text", text: "screenshot" }, INLINE], timestamp: 1 },
		{
			role: "toolResult",
			toolCallId: "screenshot-call",
			toolName: "fixture",
			content: [INLINE],
			isError: false,
			timestamp: 2,
		},
		{ role: "custom", customType: "fixture", content: [INLINE], display: true, timestamp: 3 },
	]);
	const { result, text } = await client.request("session.getMessages", {
		workspaceId: workspace.id,
		sessionId: fixture.id,
	});
	expect(text).not.toContain(DATA);
	expect(text).not.toContain('"data":');
	const images = refs(result.messages);
	expect(images).toHaveLength(3);
	for (const image of images) {
		expect(image.ref).toBe(imageRef(fixture.id));
		expect({ width: image.width, height: image.height }).toEqual({ width: 800, height: 600 });
	}
	expect(readFileSync(fixture.path, "utf8")).toContain(DATA);
	expect(readSessionRecord(fixture.id)?.messages[0]).toMatchObject({
		content: [{ type: "text" }, INLINE],
	});
	for (const method of ["GET", "HEAD"]) {
		const response = await fetch(url(imageRef(fixture.id)), { method });
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("image/png");
		expect(response.headers.get("Content-Length")).toBe(String(SCREENSHOT.byteLength));
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(
			method === "GET" ? SCREENSHOT : Buffer.alloc(0),
		);
	}
	for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
		const response = await fetch(url(imageRef(fixture.id)), { method });
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET, HEAD");
	}
}, 30_000);

test("a stored session remains unservable until its own workspace attaches it, and hashes stay chat-scoped", async () => {
	const client = await connect();
	const workspace = await openWorkspace(client);
	const otherWorkspace = await openWorkspace(client);
	const fixture = seedSession(workspace);
	expect(hasSession(fixture.id)).toBe(false);
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(404);
	await expect(
		client.request("session.getMessages", {
			workspaceId: otherWorkspace.id,
			sessionId: fixture.id,
		}),
	).rejects.toThrow();
	expect(hasSession(fixture.id)).toBe(false);
	await client.request("session.getMessages", { workspaceId: workspace.id, sessionId: fixture.id });
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(200);
	const other = seedSession(workspace, []);
	await client.request("session.getMessages", { workspaceId: workspace.id, sessionId: other.id });
	expect((await fetch(url(imageRef(other.id)))).status).toBe(404);
}, 30_000);

test("an LRU miss heals from the attached canonical transcript without its on-disk record", async () => {
	const client = await connect();
	const workspace = await openWorkspace(client);
	const otherData = Buffer.concat([SCREENSHOT, Buffer.from("another image")]).toString("base64");
	resetImages({ cacheLimitChars: otherData.length });
	setImageSource(sessionImageSource);
	const first = seedSession(workspace);
	const second = seedSession(workspace, [
		{ role: "user", content: [{ ...INLINE, data: otherData }], timestamp: 1 },
	]);
	await client.request("session.getMessages", { workspaceId: workspace.id, sessionId: first.id });
	await client.request("session.getMessages", { workspaceId: workspace.id, sessionId: second.id });
	rmSync(first.path);
	const find = spyOn(sessionImageSource, "find");
	try {
		const response = await fetch(url(imageRef(first.id)));
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(SCREENSHOT);
		expect(find).toHaveBeenCalledWith(first.id, imageRef(first.id).split("/").at(-1));
	} finally {
		find.mockRestore();
	}
}, 30_000);

test("disposing an attached chat refuses already cached images while preserving its record", async () => {
	const client = await connect();
	const workspace = await openWorkspace(client);
	const fixture = seedSession(workspace);
	await client.request("session.getMessages", { workspaceId: workspace.id, sessionId: fixture.id });
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(200);
	await client.request("session.dispose", { sessionId: fixture.id });
	expect(existsSync(fixture.path)).toBe(true);
	expect(hasSession(fixture.id)).toBe(false);
	const response = await fetch(url(imageRef(fixture.id)));
	expect(response.status).toBe(404);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(hasSession(fixture.id)).toBe(false);
}, 30_000);

test("deleting a session retires its cached images and its durable record", async () => {
	const client = await connect();
	const workspace = await openWorkspace(client);
	const fixture = seedSession(workspace);
	await client.request("session.getMessages", { workspaceId: workspace.id, sessionId: fixture.id });
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(200);
	await client.request("session.delete", { workspaceId: workspace.id, sessionId: fixture.id });
	expect(existsSync(fixture.path)).toBe(false);
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(404);
}, 30_000);

test("closing the owning project rejects cache hits even while its session remains attached", async () => {
	const client = await connect();
	const workspace = await openWorkspace(client);
	const fixture = seedSession(workspace);
	await client.request("session.getMessages", { workspaceId: workspace.id, sessionId: fixture.id });
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(200);
	await client.request("project.close", { id: workspace.projectId });
	expect(hasSession(fixture.id)).toBe(true);
	expect(existsSync(fixture.path)).toBe(true);
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(404);
}, 30_000);

test("removing a workspace retires its cached image before asynchronous archive teardown", async () => {
	const client = await connect();
	const parent = await openWorkspace(client);
	const { result: workspace } = await client.request("workspace.create", {
		projectId: parent.projectId,
		name: "image-workspace",
	});
	const fixture = seedSession(workspace);
	await client.request("session.getMessages", { workspaceId: workspace.id, sessionId: fixture.id });
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(200);
	await client.request("workspace.remove", { id: workspace.id });
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(404);
}, 30_000);

test("a projectless chat serves its own image and deletion retires the cached reference", async () => {
	const client = await connect();
	const workspace = createChatRecord();
	const fixture = seedSession(workspace);
	await client.request("session.getMessages", { workspaceId: workspace.id, sessionId: fixture.id });
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(200);
	await client.request("chat.delete", { workspaceId: workspace.id });
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(404);
	expect(existsSync(fixture.path)).toBe(false);
}, 30_000);

test("a restarted host never attaches sessions from image GETs or session-list reads", async () => {
	let client = await connect();
	const workspace = await openWorkspace(client);
	const fixture = seedSession(workspace);
	await client.request("session.getMessages", { workspaceId: workspace.id, sessionId: fixture.id });
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(200);
	await server.shutdown();
	server = await createServer({ port: 0, host: "127.0.0.1" });
	client = await connect();
	expect(hasSession(fixture.id)).toBe(false);
	expect(existsSync(fixture.path)).toBe(true);
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(404);
	await client.request("session.list", { workspaceId: workspace.id });
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(404);
	expect(hasSession(fixture.id)).toBe(false);
	const { result, text } = await client.request("session.getMessages", {
		workspaceId: workspace.id,
		sessionId: fixture.id,
	});
	expect(text).not.toContain(DATA);
	expect(refs(result.messages)[0]?.ref).toBe(imageRef(fixture.id));
	expect((await fetch(url(imageRef(fixture.id)))).status).toBe(200);
}, 30_000);

test("reading a child transcript attaches its parent first and registers only parent-owned references", async () => {
	let client = await connect();
	const workspace = await openWorkspace(client);
	const parent = seedSession(workspace, [
		{ role: "user", content: "inspect child image", timestamp: 1 },
	]);
	const unrelatedParent = seedSession(workspace, []);
	const child = seedSession(workspace, undefined, {
		parentSessionId: parent.id,
		toolCallId: "child-call",
		task: "inspect image",
		definition: {
			name: "worker",
			description: "fixture child",
			source: "builtin",
			systemPrompt: "Inspect fixture.",
		},
		enabledExtensions: [],
		detached: false,
		createdAt: new Date(0).toISOString(),
		status: "completed",
		finishedAt: 2,
		completionDelivered: true,
		collected: true,
	});
	await expect(
		client.request("subagent.getTranscript", {
			workspaceId: workspace.id,
			parentSessionId: unrelatedParent.id,
			childSessionId: child.id,
		}),
	).rejects.toThrow();
	for (let iteration = 0; iteration < 2; iteration++) {
		expect(hasSession(parent.id)).toBe(false);
		expect((await fetch(url(imageRef(parent.id)))).status).toBe(404);
		const { result, text } = await client.request("subagent.getTranscript", {
			workspaceId: workspace.id,
			parentSessionId: parent.id,
			childSessionId: child.id,
		});
		expect(text).not.toContain(DATA);
		expect(text).not.toContain('"data":');
		expect(hasSession(parent.id)).toBe(true);
		expect(result.status).toBe("completed");
		expect(refs(result.messages)[0]?.ref).toBe(imageRef(parent.id));
		const served = await fetch(url(imageRef(parent.id)));
		expect(served.status).toBe(200);
		expect(Buffer.from(await served.arrayBuffer())).toEqual(SCREENSHOT);
		expect((await fetch(url(imageRef(child.id)))).status).toBe(404);
		if (iteration === 0) {
			await server.shutdown();
			server = await createServer({ port: 0, host: "127.0.0.1" });
			client = await connect();
		}
	}
	await client.request("session.dispose", { sessionId: parent.id });
	expect((await fetch(url(imageRef(parent.id)))).status).toBe(404);
}, 30_000);
