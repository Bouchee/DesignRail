import { randomUUID } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	copyFileSync,
	type Dirent,
	fchmodSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	ArtifactRound,
	Workspace,
	WorkspaceArtifact,
	WorkspaceArtifactsSnapshot,
	WorkspaceIgnoredOutput,
} from "@thinkrail/contracts";
import { seedArtifactsDir } from "@thinkrail/shared/artifactsDir";
import { CodedError } from "@thinkrail/shared/codedError";
import {
	DELETE_CLAIM_PREFIX,
	WORKSPACE_CONTEXT_DIR,
	WORKSPACE_TODOS_DIR,
} from "@thinkrail/shared/paths";
import { resolveWorktreeFile } from "../fs";
import { logger } from "../log";
import { dataDir, isChatWorkspace, loadProjects, loadWorkspaces } from "../persistence";
import { trashFile } from "../trash";
import {
	countOutputFiles,
	DEPENDENCY_AND_CACHE_DIRS,
	listIgnoredRoots,
	type OutputKind,
	outputChangedSince,
} from "./outputs";
import { artifactRole, type Presented, replyPathCandidates } from "./roles";

const log = logger("artifacts");

const STORAGE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;
const STORE_VERSION = 1;
const CONTEXT_PREFIX = `${WORKSPACE_CONTEXT_DIR}/`;
const SCAFFOLD = `${WORKSPACE_CONTEXT_DIR}/.gitignore`;
const MAX_ARTIFACT_SCAN_ENTRIES = 5_000;
const COPY_LIMITS = { perFile: 100 * 1024 * 1024, perWorkspace: 1024 * 1024 * 1024 };
let copyLimits = COPY_LIMITS;
const BUILD_DIRS: ReadonlySet<string> = new Set([
	"dist",
	"build",
	"out",
	".next",
	"target",
	"coverage",
]);
const LINK_UNSUPPORTED = new Set<unknown>(["EXDEV", "EPERM", "EMLINK", "ENOTSUP", "EOPNOTSUPP"]);
const WRITER_TOOLS = new Set(["apply_patch", "spec_create"]);
const MAX_ROUNDS = 16;

interface ArtifactRecord {
	path: string;
	state: "live" | "deleted";
	dev: string;
	ino: string;
	size: number;
	mtimeMs: number;
	changedAt: number;
	firstSeenAt: number;
	sessionId?: string;
	kept?: string;
	keptCopy?: true;
	presented?: Presented;
	picked?: true;
	rounds?: ArtifactRound[];
}

interface OutputRecord {
	path: string;
	kind: OutputKind;
	firstSeenAt: number;
	changedAt: number;
	files: number;
	filesTruncated: boolean;
	sessionId?: string;
}

interface WorkspaceArtifacts {
	lastDeletedAt: number;
	records: Map<string, ArtifactRecord>;
	outputs: Map<string, OutputRecord>;
}

interface ScannedFile {
	path: string;
	dev: string;
	ino: string;
	size: number;
	mtimeMs: number;
}

interface RunWindow {
	startedAt: number;
	sessions: Set<string>;
	rootsAtStart: Promise<Map<string, OutputKind> | null>;
}

export type ArtifactSessionEvent =
	| { type: "agent_start" }
	| { type: "agent_settled" }
	| { type: "round_start"; at: number }
	| { type: "assistant_message"; text: string }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			presented?: readonly string[];
			picked?: readonly string[];
	  };

const states = new Map<string, WorkspaceArtifacts>();
const running = new Map<string, Map<string, string>>();
const writers = new Map<
	string,
	Map<string, { sessionId: string; producerId: string; toolCallId: string }>
>();
const windows = new Map<string, RunWindow>();
const roundStarts = new Map<string, Map<string, ArtifactRound>>();
const replies = new Map<string, Map<string, string>>();
const removals = new Map<string, Map<string, number>>();
const generations = new Map<string, number>();
let publisher: ((workspaceId: string) => void) | null = null;

export function setArtifactsPublisher(publish: ((workspaceId: string) => void) | null): void {
	publisher = publish;
}

function publish(workspaceId: string): void {
	try {
		publisher?.(workspaceId);
	} catch (error) {
		log.warn("artifacts publish failed", error);
	}
}

function normalizedPath(path: string): boolean {
	return (
		path.length > 0 &&
		!isAbsolute(path) &&
		!/[\\\0]/.test(path) &&
		path
			.split("/")
			.every(
				(part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
			)
	);
}

export function isArtifactPath(path: string): boolean {
	if (!normalizedPath(path)) return false;
	if (!path.startsWith(CONTEXT_PREFIX) || path === SCAFFOLD) return false;
	return path !== WORKSPACE_TODOS_DIR && !path.startsWith(`${WORKSPACE_TODOS_DIR}/`);
}

export function touchesArtifacts(path: string): boolean {
	return isArtifactPath(path) || CONTEXT_PREFIX.startsWith(`${path}/`);
}

export function artifactsStoreRoot(): string {
	return join(dataDir(), "artifacts");
}

function storeDir(workspaceId: string): string | null {
	if (!STORAGE_ID.test(workspaceId)) return null;
	const root = artifactsStoreRoot();
	const dir = join(root, workspaceId);
	for (const path of [root, dir, join(dir, "kept"), join(dir, "discard")]) {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (stat && !stat.isDirectory())
			throw new Error("The artifacts store must use real directories");
	}
	return dir;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseArtifact(value: unknown): ArtifactRecord | null {
	if (!isObject(value)) return null;
	const { path, state, dev, ino, size, mtimeMs, changedAt, firstSeenAt, sessionId, kept } = value;
	if (
		typeof path !== "string" ||
		!isArtifactPath(path) ||
		(state !== "live" && state !== "deleted") ||
		typeof dev !== "string" ||
		typeof ino !== "string" ||
		typeof size !== "number" ||
		!Number.isFinite(size) ||
		size < 0 ||
		typeof mtimeMs !== "number" ||
		!Number.isFinite(mtimeMs) ||
		typeof changedAt !== "number" ||
		!Number.isFinite(changedAt) ||
		typeof firstSeenAt !== "number" ||
		!Number.isFinite(firstSeenAt) ||
		(sessionId !== undefined && typeof sessionId !== "string") ||
		(kept !== undefined && (typeof kept !== "string" || !STORAGE_ID.test(kept)))
	)
		return null;
	return {
		path,
		state,
		dev,
		ino,
		size,
		mtimeMs,
		changedAt,
		firstSeenAt,
		...(sessionId ? { sessionId } : {}),
		...(kept ? { kept } : {}),
		...(value.keptCopy === true ? { keptCopy: true as const } : {}),
		...(value.presented === "shown" || value.presented === "linked"
			? { presented: value.presented }
			: {}),
		...(value.picked === true ? { picked: true as const } : {}),
		...parseRounds(value.rounds),
	};
}

function parseRounds(value: unknown): { rounds?: ArtifactRound[] } {
	if (!Array.isArray(value)) return {};
	const rounds = value
		.filter(
			(round): round is ArtifactRound =>
				isObject(round) &&
				typeof round.sessionId === "string" &&
				STORAGE_ID.test(round.sessionId) &&
				typeof round.startedAt === "number" &&
				Number.isFinite(round.startedAt),
		)
		.map(({ sessionId, startedAt }) => ({ sessionId, startedAt }))
		.slice(-MAX_ROUNDS);
	return rounds.length ? { rounds } : {};
}

function parseOutput(value: unknown): OutputRecord | null {
	if (!isObject(value)) return null;
	const { path, kind, firstSeenAt, changedAt, files, filesTruncated, sessionId } = value;
	if (
		typeof path !== "string" ||
		!normalizedPath(path) ||
		(kind !== "file" && kind !== "dir") ||
		typeof firstSeenAt !== "number" ||
		!Number.isFinite(firstSeenAt) ||
		typeof changedAt !== "number" ||
		!Number.isFinite(changedAt) ||
		typeof files !== "number" ||
		typeof filesTruncated !== "boolean" ||
		(sessionId !== undefined && typeof sessionId !== "string")
	)
		return null;
	return {
		path,
		kind,
		firstSeenAt,
		changedAt,
		files,
		filesTruncated,
		...(sessionId ? { sessionId } : {}),
	};
}

function load(workspaceId: string): WorkspaceArtifacts {
	const cached = states.get(workspaceId);
	if (cached) return cached;
	const state: WorkspaceArtifacts = { lastDeletedAt: 0, records: new Map(), outputs: new Map() };
	const dir = storeDir(workspaceId);
	if (dir) {
		try {
			const index = join(dir, "index.json");
			const stat = lstatSync(index, { throwIfNoEntry: false });
			if (stat && !stat.isFile()) throw new Error("The artifacts index must be a regular file");
			const raw: unknown = JSON.parse(readFileSync(index, "utf8"));
			if (
				!isObject(raw) ||
				raw.version !== STORE_VERSION ||
				!Array.isArray(raw.artifacts) ||
				!Array.isArray(raw.outputs)
			)
				throw new Error("Unsupported or malformed artifacts index");
			if (typeof raw.lastDeletedAt === "number" && Number.isFinite(raw.lastDeletedAt))
				state.lastDeletedAt = raw.lastDeletedAt;
			for (const item of raw.artifacts) {
				const record = parseArtifact(item);
				if (record) {
					state.records.set(record.path, record);
					if (record.state === "deleted")
						state.lastDeletedAt = Math.max(state.lastDeletedAt, record.changedAt);
				}
			}
			for (const item of raw.outputs) {
				const record = parseOutput(item);
				if (record) state.outputs.set(record.path, record);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	states.set(workspaceId, state);
	return state;
}

function copyState(state: WorkspaceArtifacts): WorkspaceArtifacts {
	return {
		lastDeletedAt: state.lastDeletedAt,
		records: new Map([...state.records].map(([path, record]) => [path, { ...record }])),
		outputs: new Map([...state.outputs].map(([path, record]) => [path, { ...record }])),
	};
}

function save(workspaceId: string, state: WorkspaceArtifacts): void {
	const dir = storeDir(workspaceId);
	if (!dir) throw new Error("Invalid workspace id");
	const prior = load(workspaceId);
	const before = new Set(
		[...prior.records.values()].flatMap((record) => (record.kept ? [record.kept] : [])),
	);
	const after = new Set(
		[...state.records.values()].flatMap((record) => (record.kept ? [record.kept] : [])),
	);
	const file = join(dir, "index.json");
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dir, { recursive: true });
		const existing = lstatSync(file, { throwIfNoEntry: false });
		if (existing && !existing.isFile())
			throw new Error("The artifacts index must be a regular file");
		const mode = existing?.mode ?? 0o600;
		const fd = openSync(temp, "wx", mode);
		try {
			fchmodSync(fd, mode);
			writeFileSync(
				fd,
				`${JSON.stringify({ version: STORE_VERSION, lastDeletedAt: state.lastDeletedAt, artifacts: [...state.records.values()], outputs: [...state.outputs.values()] })}\n`,
			);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, file);
	} catch (error) {
		for (const name of after) if (!before.has(name)) removeQuietly(join(dir, "kept", name));
		throw error;
	} finally {
		removeQuietly(temp);
	}
	states.set(workspaceId, state);
	for (const name of before) if (!after.has(name)) removeQuietly(join(dir, "kept", name));
}

function workspaceOf(workspaceId: string): Workspace | null {
	const workspace = loadWorkspaces().find((workspace) => workspace.id === workspaceId);
	if (!workspace || workspace.deletionPending) return null;
	const project = loadProjects().find((project) => project.id === workspace.projectId);
	return project && !project.closed ? workspace : null;
}

function requireWorkspace(workspaceId: string): Workspace {
	const workspace = workspaceOf(workspaceId);
	if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
	return workspace;
}

function statFile(root: string, path: string): ScannedFile | null {
	const stat = lstatSync(join(root, path), { bigint: true, throwIfNoEntry: false });
	if (!stat?.isFile()) return null;
	return {
		path,
		dev: String(stat.dev),
		ino: String(stat.ino),
		size: Number(stat.size),
		mtimeMs: Number(stat.mtimeMs),
	};
}

function contextFolder(root: string): "real" | "missing" | "foreign" {
	let dir = root;
	for (const part of WORKSPACE_CONTEXT_DIR.split("/")) {
		dir = join(dir, part);
		const entry = lstatSync(dir, { throwIfNoEntry: false });
		if (!entry) return "missing";
		if (!entry.isDirectory()) return "foreign";
	}
	return "real";
}

function skippedEntry(entry: Dirent): boolean {
	return (
		entry.name.startsWith(DELETE_CLAIM_PREFIX) ||
		(entry.isDirectory() &&
			(DEPENDENCY_AND_CACHE_DIRS.has(entry.name.toLowerCase()) || BUILD_DIRS.has(entry.name)))
	);
}

function scanContext(root: string): { files: Map<string, ScannedFile>; complete: boolean } {
	const files = new Map<string, ScannedFile>();
	if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) return { files, complete: false };
	const folder = contextFolder(root);
	if (folder !== "real") return { files, complete: folder === "missing" };
	const queue = [WORKSPACE_CONTEXT_DIR];
	let seen = 0;
	for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
		let entries: Dirent[];
		try {
			entries = readdirSync(join(root, dir), { withFileTypes: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") continue;
			return { files, complete: false };
		}
		for (const entry of entries) {
			if (skippedEntry(entry)) continue;
			if (++seen > MAX_ARTIFACT_SCAN_ENTRIES) return { files, complete: false };
			const path = `${dir}/${entry.name}`;
			if (!isArtifactPath(path)) continue;
			if (entry.isDirectory()) {
				queue.push(path);
				continue;
			}
			if (!entry.isFile()) continue;
			const file = statFile(root, path);
			if (file) files.set(path, file);
		}
	}
	return { files, complete: true };
}

function keptPath(workspaceId: string, name: string): string | null {
	const dir = storeDir(workspaceId);
	return dir ? join(dir, "kept", name) : null;
}

function removeQuietly(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true });
	} catch (error) {
		log.warn("artifacts store entry not removed", error);
	}
}

function dropKept(record: ArtifactRecord): void {
	if (!record.kept) return;
	delete record.kept;
	delete record.keptCopy;
}

function copyFits(state: WorkspaceArtifacts, record: ArtifactRecord): boolean {
	if (record.size > copyLimits.perFile) return false;
	let copied = 0;
	for (const other of state.records.values())
		if (other !== record && other.keptCopy) copied += other.size;
	return copied + record.size <= copyLimits.perWorkspace;
}

function keep(
	workspaceId: string,
	root: string,
	record: ArtifactRecord,
	state: WorkspaceArtifacts,
): void {
	dropKept(record);
	const name = randomUUID();
	const target = keptPath(workspaceId, name);
	if (!target) return;
	const source = join(root, record.path);
	try {
		mkdirSync(dirname(target), { recursive: true });
		linkSync(source, target);
		record.kept = name;
		return;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (!LINK_UNSUPPORTED.has(code)) {
			if (code !== "ENOENT") log.warn("artifact copy not kept", error);
			return;
		}
	}
	if (!copyFits(state, record)) return;
	try {
		copyFileSync(source, target);
		record.kept = name;
		record.keptCopy = true;
	} catch (error) {
		removeQuietly(target);
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			log.warn("artifact copy not kept", error);
	}
}

function covered(marks: Map<string, number> | undefined, path: string): boolean {
	if (!marks) return false;
	for (const mark of marks.keys()) if (path === mark || path.startsWith(`${mark}/`)) return true;
	return false;
}

function writerOf(
	workspaceId: string,
	path: string,
): { sessionId: string; round?: ArtifactRound } | undefined {
	const rounds = roundStarts.get(workspaceId);
	const explicit = writers.get(workspaceId)?.get(path);
	if (explicit) {
		const round = rounds?.get(explicit.producerId);
		return { sessionId: explicit.sessionId, ...(round ? { round } : {}) };
	}
	const active = running.get(workspaceId);
	const owners = new Set(active?.values());
	if (!active || owners.size !== 1) return undefined;
	const sessionId = [...owners][0];
	if (!sessionId) return undefined;
	const starts = new Set([...active.keys()].map((producer) => rounds?.get(producer)));
	const round = starts.size === 1 ? [...starts][0] : undefined;
	return { sessionId, ...(round ? { round } : {}) };
}

export function isSameFile(
	record: Pick<ArtifactRecord, "dev" | "ino" | "size" | "mtimeMs" | "kept" | "keptCopy">,
	file: Pick<ScannedFile, "dev" | "ino" | "size" | "mtimeMs">,
): boolean {
	if (file.dev !== record.dev || file.ino !== record.ino) return false;
	if (record.kept && !record.keptCopy) return true;
	return file.size === record.size && file.mtimeMs === record.mtimeMs;
}

function applyStat(record: ArtifactRecord, file: ScannedFile): void {
	record.dev = file.dev;
	record.ino = file.ino;
	record.size = file.size;
	record.mtimeMs = file.mtimeMs;
	record.changedAt = Math.round(file.mtimeMs);
}

function attribute(record: ArtifactRecord, writer: ReturnType<typeof writerOf>): void {
	if (!writer) return;
	record.sessionId = writer.sessionId;
	const { round } = writer;
	if (!round) return;
	const rounds = record.rounds ?? [];
	if (
		rounds.some((item) => item.sessionId === round.sessionId && item.startedAt === round.startedAt)
	)
		return;
	record.rounds = [...rounds, round].slice(-MAX_ROUNDS);
}

function reconcile(workspace: Workspace): boolean {
	const workspaceId = workspace.id;
	const root = workspace.worktreePath;
	const state = copyState(load(workspaceId));
	const { files, complete } = scanContext(root);
	const unseen = new Map(files);
	const missing: ArtifactRecord[] = [];
	let changed = false;

	for (const record of state.records.values()) {
		if (record.state !== "live") continue;
		const file = files.get(record.path);
		if (!file) {
			missing.push(record);
			continue;
		}
		unseen.delete(record.path);
		const relinked = file.dev !== record.dev || file.ino !== record.ino;
		if (!relinked && file.size === record.size && file.mtimeMs === record.mtimeMs) continue;
		applyStat(record, file);
		attribute(record, writerOf(workspaceId, record.path));
		if (relinked || record.keptCopy || !record.kept) keep(workspaceId, root, record, state);
		changed = true;
	}

	for (const record of missing.splice(0)) {
		const moved = [...unseen.values()].find((file) => isSameFile(record, file));
		if (!moved) {
			missing.push(record);
			continue;
		}
		const replaced = state.records.get(moved.path);
		if (replaced) dropKept(replaced);
		state.records.delete(record.path);
		record.path = moved.path;
		applyStat(record, moved);
		if (record.keptCopy || !record.kept) keep(workspaceId, root, record, state);
		state.records.set(record.path, record);
		unseen.delete(moved.path);
		changed = true;
	}

	if (complete) {
		const now = Date.now();
		const marks = removals.get(workspaceId);
		for (const record of missing) {
			if (covered(marks, record.path) || !record.kept) {
				dropKept(record);
				state.records.delete(record.path);
			} else {
				record.state = "deleted";
				state.lastDeletedAt = Math.max(now, state.lastDeletedAt + 1);
				record.changedAt = state.lastDeletedAt;
			}
			changed = true;
		}
	}

	for (const file of unseen.values()) {
		const prior = state.records.get(file.path);
		if (prior) dropKept(prior);
		const record: ArtifactRecord = {
			path: file.path,
			state: "live",
			dev: file.dev,
			ino: file.ino,
			size: file.size,
			mtimeMs: file.mtimeMs,
			changedAt: Math.round(file.mtimeMs),
			firstSeenAt: prior?.firstSeenAt ?? Date.now(),
			...(prior?.sessionId ? { sessionId: prior.sessionId } : {}),
			...(prior?.presented ? { presented: prior.presented } : {}),
			...(prior?.picked ? { picked: prior.picked } : {}),
			...(prior?.rounds ? { rounds: prior.rounds } : {}),
		};
		attribute(record, writerOf(workspaceId, file.path));
		keep(workspaceId, root, record, state);
		state.records.set(file.path, record);
		changed = true;
	}

	if (changed) save(workspaceId, state);
	return changed;
}

export function reconcileArtifacts(workspaceId: string): boolean {
	const workspace = workspaceOf(workspaceId);
	if (!workspace) return false;
	const changed = reconcile(workspace);
	if (changed) publish(workspaceId);
	return changed;
}

function entryPath(workspaceId: string, path: string): string {
	const workspace = workspaceOf(workspaceId);
	if (!workspace) return path;
	try {
		const root = realpathSync(workspace.worktreePath);
		const abs = resolve(workspace.worktreePath, path);
		const entry = join(realpathSync(dirname(abs)), basename(abs));
		return isInside(root, entry) ? relative(root, entry).split(sep).join("/") : path;
	} catch {
		return path;
	}
}

export function prepareArtifactsDestination(workspaceId: string, directory: string): void {
	const workspace = workspaceOf(workspaceId);
	if (!workspace) return;
	const path = entryPath(workspaceId, directory);
	if (path === WORKSPACE_CONTEXT_DIR || isArtifactPath(path))
		seedArtifactsDir(workspace.worktreePath);
}

export async function withUserRemoval<T>(
	workspaceId: string,
	requested: string,
	mutation: () => Promise<T>,
): Promise<T> {
	const path = entryPath(workspaceId, requested);
	if (!touchesArtifacts(path)) return mutation();
	let marks = removals.get(workspaceId);
	if (!marks) {
		marks = new Map();
		removals.set(workspaceId, marks);
	}
	marks.set(path, (marks.get(path) ?? 0) + 1);
	try {
		const result = await mutation();
		try {
			reconcileArtifacts(workspaceId);
		} catch (error) {
			log.warn("artifacts reconcile after a user change failed", error);
		}
		return result;
	} finally {
		const count = (marks.get(path) ?? 1) - 1;
		if (count > 0) marks.set(path, count);
		else marks.delete(path);
		if (marks.size === 0) removals.delete(workspaceId);
	}
}

function toWire(record: ArtifactRecord): WorkspaceArtifact {
	const { role, reason } = artifactRole(record.path.slice(CONTEXT_PREFIX.length), record);
	return {
		path: record.path,
		state: record.state,
		size: record.size,
		changedAt: record.changedAt,
		firstSeenAt: record.firstSeenAt,
		...(record.sessionId ? { sessionId: record.sessionId } : {}),
		role,
		reason,
		...(record.rounds ? { rounds: record.rounds } : {}),
	};
}

function current(
	workspace: Workspace,
	generation: number,
	identity: Pick<BigIntStats, "dev" | "ino">,
): boolean {
	const live = workspaceOf(workspace.id);
	const stat = statSync(workspace.worktreePath, { bigint: true, throwIfNoEntry: false });
	return (
		(generations.get(workspace.id) ?? 0) === generation &&
		live?.worktreePath === workspace.worktreePath &&
		live.projectId === workspace.projectId &&
		stat?.dev === identity.dev &&
		stat.ino === identity.ino
	);
}

async function detectOutputs(workspace: Workspace, window: RunWindow): Promise<boolean> {
	const generation = generations.get(workspace.id) ?? 0;
	const identity = statSync(workspace.worktreePath, { bigint: true });
	const before = await window.rootsAtStart;
	if (!before || !current(workspace, generation, identity)) return false;
	const roots = await listIgnoredRoots(workspace.worktreePath);
	if (!roots || !current(workspace, generation, identity)) return false;
	const sessionId = window.sessions.size === 1 ? [...window.sessions][0] : undefined;
	let changed = false;
	for (const [path, kind] of roots) {
		const prior = load(workspace.id).outputs.get(path);
		if (prior && prior.changedAt >= window.startedAt && prior.kind === kind) continue;
		let abs: string;
		try {
			abs = resolveWorktreeFile(workspace.id, path);
		} catch {
			continue;
		}
		const source = lstatSync(abs, { throwIfNoEntry: false });
		if (!source || source.isSymbolicLink()) continue;
		if (before.has(path) && !(await outputChangedSince(abs, kind, window.startedAt))) continue;
		const { files, truncated } = await countOutputFiles(abs, kind);
		if (!current(workspace, generation, identity)) return false;
		const writer = sessionId ?? prior?.sessionId;
		const state = copyState(load(workspace.id));
		state.outputs.set(path, {
			path,
			kind,
			firstSeenAt: prior?.firstSeenAt ?? Date.now(),
			changedAt: Date.now(),
			files,
			filesTruncated: truncated,
			...(writer ? { sessionId: writer } : {}),
		});
		save(workspace.id, state);
		changed = true;
	}
	return changed;
}

function overlaps(root: string, path: string): boolean {
	return path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`);
}

async function refreshOutputs(workspace: Workspace, roots: readonly string[]): Promise<void> {
	const generation = generations.get(workspace.id) ?? 0;
	const identity = statSync(workspace.worktreePath, { bigint: true });
	let changed = false;
	for (const root of roots) {
		let abs: string;
		try {
			abs = resolveWorktreeFile(workspace.id, root);
		} catch {
			continue;
		}
		const stat = lstatSync(abs, { throwIfNoEntry: false });
		const kind: OutputKind | null = stat?.isDirectory() ? "dir" : stat?.isFile() ? "file" : null;
		const counted = kind ? await countOutputFiles(abs, kind) : null;
		if (!current(workspace, generation, identity)) return;
		const state = copyState(load(workspace.id));
		const outputs = state.outputs;
		const record = outputs.get(root);
		if (!record) continue;
		if (!kind || !counted) outputs.delete(root);
		else
			outputs.set(root, {
				...record,
				kind,
				files: counted.files,
				filesTruncated: counted.truncated,
			});
		save(workspace.id, state);
		changed = true;
	}
	if (!changed) return;
	publish(workspace.id);
}

export function noteArtifactPathsChanged(
	workspaceId: string,
	paths: readonly string[],
	truncated: boolean,
): void {
	const workspace = workspaceOf(workspaceId);
	if (!workspace) return;
	if (truncated || paths.some(touchesArtifacts)) {
		try {
			if (reconcile(workspace)) publish(workspaceId);
		} catch (error) {
			log.warn("artifacts reconcile failed", error);
		}
	}
	const roots = [...load(workspaceId).outputs.keys()].filter((root) =>
		paths.some((path) => overlaps(root, path)),
	);
	if (roots.length > 0)
		void refreshOutputs(workspace, roots).catch((error) =>
			log.warn("ignored outputs refresh failed", error),
		);
}

function liveOutputs(workspace: Workspace): WorkspaceIgnoredOutput[] {
	const state = copyState(load(workspace.id));
	const outputs: WorkspaceIgnoredOutput[] = [];
	let changed = false;
	for (const record of state.outputs.values()) {
		if (!lstatSync(join(workspace.worktreePath, record.path), { throwIfNoEntry: false })) {
			state.outputs.delete(record.path);
			changed = true;
			continue;
		}
		outputs.push({
			path: record.path,
			kind: record.kind,
			files: record.files,
			filesTruncated: record.filesTruncated,
			changedAt: record.changedAt,
			...(record.sessionId ? { sessionId: record.sessionId } : {}),
		});
	}
	if (changed) save(workspace.id, state);
	return outputs.sort((a, b) => b.changedAt - a.changedAt);
}

export function listArtifacts(workspaceId: string): WorkspaceArtifactsSnapshot {
	const workspace = requireWorkspace(workspaceId);
	if (reconcile(workspace)) publish(workspaceId);
	const outputs = isChatWorkspace(workspace) ? null : liveOutputs(workspace);
	const artifacts = [...load(workspaceId).records.values()]
		.map(toWire)
		.sort((a, b) => b.changedAt - a.changedAt);
	return { workspaceId, dir: WORKSPACE_CONTEXT_DIR, artifacts, outputs };
}

function deletedRecord(
	workspaceId: string,
	path: string,
): { record: ArtifactRecord; kept: string; dir: string } {
	const record = load(workspaceId).records.get(path);
	const dir = storeDir(workspaceId);
	if (record?.state !== "deleted" || !record.kept || !dir)
		throw new CodedError("ARTIFACT_UNKNOWN", `No kept copy of ${path}`);
	return { record, kept: join(dir, "kept", record.kept), dir };
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function restoreArtifact(workspaceId: string, path: string): void {
	const workspace = requireWorkspace(workspaceId);
	const { kept } = deletedRecord(workspaceId, path);
	const state = copyState(load(workspaceId));
	const record = state.records.get(path);
	if (!record || !isArtifactPath(path))
		throw new CodedError("ARTIFACT_UNKNOWN", `No kept copy of ${path}`);
	const root = workspace.worktreePath;
	const target = resolve(root, path);
	if (lstatSync(target, { throwIfNoEntry: false }))
		throw new CodedError("ENTRY_EXISTS", `${path} already exists`);
	seedArtifactsDir(root);
	resolveWorktreeFile(workspaceId, path);
	let existing = dirname(target);
	while (!lstatSync(existing, { throwIfNoEntry: false })) existing = dirname(existing);
	if (!isInside(realpathSync(root), realpathSync(existing)))
		throw new Error("Path escapes the worktree");
	mkdirSync(dirname(target), { recursive: true });
	resolveWorktreeFile(workspaceId, path);
	const keptStat = lstatSync(kept);
	if (!keptStat.isFile()) throw new Error("The kept entry is not a regular file");
	const shared = keptStat.nlink > 1;
	let linked = false;
	if (!record.keptCopy && !shared) {
		try {
			linkSync(kept, target);
			linked = true;
		} catch (error) {
			if (!LINK_UNSUPPORTED.has((error as NodeJS.ErrnoException).code)) throw error;
		}
	}
	if (!linked) copyFileSync(kept, target, constants.COPYFILE_EXCL);
	const restored = statFile(root, path);
	if (restored) applyStat(record, restored);
	record.state = "live";
	if (shared) keep(workspaceId, root, record, state);
	save(workspaceId, state);
	reconcile(workspace);
	publish(workspaceId);
}

export async function discardArtifact(workspaceId: string, path: string): Promise<void> {
	const workspace = requireWorkspace(workspaceId);
	const generation = generations.get(workspaceId) ?? 0;
	const identity = statSync(workspace.worktreePath, { bigint: true });
	const { record, kept, dir } = deletedRecord(workspaceId, path);
	const staging = join(dir, "discard", randomUUID());
	const staged = join(staging, basename(path));
	mkdirSync(staging, { recursive: true });
	const directories = [artifactsStoreRoot(), dir, join(dir, "kept"), dirname(staging), staging].map(
		(path) => ({
			path,
			identity: lstatSync(path, { bigint: true }),
		}),
	);
	let sameStore = false;
	const keptIdentity = lstatSync(kept, { bigint: true });
	if (!keptIdentity.isFile()) throw new Error("The kept entry is not a regular file");
	try {
		try {
			linkSync(kept, staged);
		} catch (error) {
			if (!LINK_UNSUPPORTED.has((error as NodeJS.ErrnoException).code)) throw error;
			copyFileSync(kept, staged, constants.COPYFILE_EXCL);
		}
		await trashFile(staged);
	} finally {
		sameStore = directories.every(({ path, identity }) => {
			const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
			return stat?.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino;
		});
		if (sameStore) removeQuietly(staging);
	}
	if (!current(workspace, generation, identity)) return;
	if (!sameStore)
		throw new CodedError("ENTRY_CHANGED", "The artifacts store changed during discard");
	const prior = load(workspaceId);
	const currentRecord = prior.records.get(path);
	if (
		currentRecord?.state !== "deleted" ||
		currentRecord.kept !== record.kept ||
		currentRecord.changedAt !== record.changedAt
	)
		return;
	const currentKept = sameStore
		? lstatSync(kept, { bigint: true, throwIfNoEntry: false })
		: undefined;
	if (
		!sameStore ||
		!currentKept?.isFile() ||
		currentKept.dev !== keptIdentity.dev ||
		currentKept.ino !== keptIdentity.ino
	)
		throw new CodedError("ENTRY_CHANGED", "The artifacts store changed during discard");
	const state = copyState(prior);
	state.records.delete(path);
	save(workspaceId, state);
	publish(workspaceId);
}

function toolPath(args: unknown): string | null {
	if (!isObject(args)) return null;
	const path = args.path;
	return typeof path === "string" && path ? path : null;
}

function artifactPathOf(workspace: Workspace, path: string | null): string | null {
	if (!path) return null;
	const root = resolve(workspace.worktreePath);
	const abs = resolve(root, path.startsWith("@") ? path.slice(1) : path);
	if (!isInside(root, abs)) return null;
	const rel = relative(root, abs).split(sep).join("/");
	return isArtifactPath(rel) ? rel : null;
}

function rememberWriter(
	workspace: Workspace,
	sessionId: string,
	producerId: string,
	toolCallId: string,
	args: unknown,
): void {
	const rel = artifactPathOf(workspace, toolPath(args));
	if (!rel) return;
	let map = writers.get(workspace.id);
	if (!map) {
		map = new Map();
		writers.set(workspace.id, map);
	}
	map.set(rel, { sessionId, producerId, toolCallId });
}

function forgetToolWriter(workspaceId: string, producerId: string, toolCallId: string): void {
	const map = writers.get(workspaceId);
	if (!map) return;
	for (const [path, writer] of map)
		if (writer.toolCallId === toolCallId && writer.producerId === producerId) map.delete(path);
	if (map.size === 0) writers.delete(workspaceId);
}

function forgetWriters(workspaceId: string, sessionId: string): void {
	const map = writers.get(workspaceId);
	if (!map) return;
	for (const [path, writer] of map) if (writer.producerId === sessionId) map.delete(path);
	if (map.size === 0) writers.delete(workspaceId);
}

function openWindow(workspace: Workspace, sessionId: string): void {
	const open = windows.get(workspace.id);
	if (open) {
		open.sessions.add(sessionId);
		return;
	}
	const rootsAtStart = isChatWorkspace(workspace)
		? Promise.resolve(null)
		: listIgnoredRoots(workspace.worktreePath).catch((error) => {
				log.warn("ignored outputs baseline failed", error);
				return null;
			});
	windows.set(workspace.id, {
		startedAt: Date.now(),
		sessions: new Set([sessionId]),
		rootsAtStart,
	});
}

function markRecords(
	state: WorkspaceArtifacts,
	paths: Iterable<string>,
	mark: (record: ArtifactRecord) => boolean,
): boolean {
	const records = state.records;
	let changed = false;
	for (const path of paths) {
		const record = records.get(path);
		if (record?.state === "live" && mark(record)) changed = true;
	}
	return changed;
}

function toolArtifactPaths(workspace: Workspace, raw: readonly string[] | undefined): string[] {
	return (raw ?? []).flatMap((path) => artifactPathOf(workspace, path) ?? []);
}

function replyArtifactPaths(workspace: Workspace, text: string): string[] {
	const paths = new Set<string>();
	for (const candidate of replyPathCandidates(text)) {
		const direct = artifactPathOf(workspace, candidate);
		if (direct) paths.add(direct);
		if (!isAbsolute(candidate) && !candidate.startsWith(CONTEXT_PREFIX))
			paths.add(`${CONTEXT_PREFIX}${candidate}`);
	}
	return [...paths];
}

const markShown = (record: ArtifactRecord) => {
	if (record.presented === "shown") return false;
	record.presented = "shown";
	return true;
};

const markLinked = (record: ArtifactRecord) => {
	if (record.presented) return false;
	record.presented = "linked";
	return true;
};

const markPicked = (record: ArtifactRecord) => {
	if (record.picked) return false;
	record.picked = true;
	return true;
};

function markReply(workspace: Workspace, sessionId: string): boolean {
	const reply = replies.get(workspace.id)?.get(sessionId);
	forgetSession(replies, workspace.id, sessionId);
	if (!reply) return false;
	const state = copyState(load(workspace.id));
	if (!markRecords(state, replyArtifactPaths(workspace, reply), markLinked)) return false;
	save(workspace.id, state);
	return true;
}

function sessionMap<T>(maps: Map<string, Map<string, T>>, workspaceId: string): Map<string, T> {
	let map = maps.get(workspaceId);
	if (!map) {
		map = new Map();
		maps.set(workspaceId, map);
	}
	return map;
}

function forgetSession<T>(
	maps: Map<string, Map<string, T>>,
	workspaceId: string,
	sessionId: string,
): void {
	const map = maps.get(workspaceId);
	map?.delete(sessionId);
	if (map?.size === 0) maps.delete(workspaceId);
}

export async function observeArtifactSessionEvent(
	workspaceId: string,
	sessionId: string,
	event: ArtifactSessionEvent,
	ownerSessionId = sessionId,
): Promise<void> {
	const workspace = workspaceOf(workspaceId);
	if (!workspace) {
		if (event.type === "tool_execution_end")
			forgetToolWriter(workspaceId, sessionId, event.toolCallId);
		if (event.type === "agent_settled") {
			forgetWriters(workspaceId, sessionId);
			forgetSession(roundStarts, workspaceId, sessionId);
			forgetSession(replies, workspaceId, sessionId);
			const active = running.get(workspaceId);
			active?.delete(sessionId);
			if (active?.size === 0) {
				running.delete(workspaceId);
				windows.delete(workspaceId);
			}
		}
		return;
	}
	switch (event.type) {
		case "agent_start": {
			let active = running.get(workspaceId);
			if (!active) {
				active = new Map();
				running.set(workspaceId, active);
			}
			active.set(sessionId, ownerSessionId);
			openWindow(workspace, ownerSessionId);
			if (reconcile(workspace)) publish(workspaceId);
			const rounds = sessionMap(roundStarts, workspaceId);
			if (!rounds.has(sessionId)) {
				const round = rounds.get(ownerSessionId);
				if (round) rounds.set(sessionId, round);
				else if (sessionId === ownerSessionId)
					rounds.set(sessionId, { sessionId, startedAt: Date.now() });
			}
			return;
		}
		case "assistant_message":
			if (event.text.trim()) sessionMap(replies, workspaceId).set(sessionId, event.text);
			else forgetSession(replies, workspaceId, sessionId);
			return;
		case "round_start": {
			if (sessionId !== ownerSessionId) return;
			const changed = reconcile(workspace);
			const linked = markReply(workspace, sessionId);
			sessionMap(roundStarts, workspaceId).set(sessionId, { sessionId, startedAt: event.at });
			if (changed || linked) publish(workspaceId);
			return;
		}
		case "tool_execution_start":
			if (WRITER_TOOLS.has(event.toolName))
				rememberWriter(workspace, ownerSessionId, sessionId, event.toolCallId, event.args);
			return;
		case "tool_execution_end": {
			let changed: boolean;
			try {
				changed = reconcile(workspace);
			} finally {
				forgetToolWriter(workspaceId, sessionId, event.toolCallId);
			}
			if (event.presented?.length || event.picked?.length) {
				const state = copyState(load(workspaceId));
				const shown = markRecords(state, toolArtifactPaths(workspace, event.presented), markShown);
				const picked = markRecords(state, toolArtifactPaths(workspace, event.picked), markPicked);
				if (shown || picked) {
					save(workspaceId, state);
					changed = true;
				}
			}
			if (changed) publish(workspaceId);
			return;
		}
		case "agent_settled": {
			let changed = false;
			let window: RunWindow | undefined;
			try {
				changed = reconcile(workspace);
				changed = markReply(workspace, sessionId) || changed;
			} finally {
				forgetWriters(workspaceId, sessionId);
				forgetSession(roundStarts, workspaceId, sessionId);
				forgetSession(replies, workspaceId, sessionId);
				const active = running.get(workspaceId);
				active?.delete(sessionId);
				if (active?.size === 0) {
					running.delete(workspaceId);
					window = windows.get(workspaceId);
					windows.delete(workspaceId);
				}
			}
			if (window && !isChatWorkspace(workspace))
				changed = (await detectOutputs(workspace, window)) || changed;
			if (changed) publish(workspaceId);
			return;
		}
	}
}

export function removeWorkspaceArtifacts(workspaceId: string): void {
	generations.set(workspaceId, (generations.get(workspaceId) ?? 0) + 1);
	states.delete(workspaceId);
	running.delete(workspaceId);
	writers.delete(workspaceId);
	windows.delete(workspaceId);
	roundStarts.delete(workspaceId);
	replies.delete(workspaceId);
	removals.delete(workspaceId);
	try {
		const dir = storeDir(workspaceId);
		if (dir) removeQuietly(dir);
	} catch (error) {
		log.warn("artifacts store not removed", error);
	}
}

export function setCopyLimitsForTests(limits: typeof COPY_LIMITS | null): void {
	copyLimits = limits ?? COPY_LIMITS;
}

export function resetArtifactsForTests(): void {
	states.clear();
	running.clear();
	writers.clear();
	windows.clear();
	roundStarts.clear();
	replies.clear();
	removals.clear();
	generations.clear();
	publisher = null;
}
