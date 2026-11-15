import type { WorkspaceArtifact } from "@thinkrail/contracts";
import { t } from "@thinkrail/locales/react";
import { fileName, tupleKey } from "../lib";
import { selectAttentionCenterTab, selectWorkspaceById, toast, useAppStore } from "../store";
import { errorText, getTransport, wsErrorCode } from "../transport";
import { mentionText } from "./artifactsModel";
import { openFileInTab } from "./openTabs";
import { guardComposerFocus } from "./revealFocus";

export function selectArtifactMentionTarget(
	state: ReturnType<typeof useAppStore.getState>,
	workspaceId: string,
): string | null {
	if (state.activeWorkspaceId !== workspaceId) return null;
	const tab = selectAttentionCenterTab(state, workspaceId);
	return tab?.kind === "chat" ? tab.sessionId : null;
}

export function mentionArtifact(workspaceId: string, path: string): void {
	const store = useAppStore.getState();
	const sessionId = selectArtifactMentionTarget(store, workspaceId);
	if (!sessionId) return;
	store.requestComposerFocus(workspaceId, sessionId, {
		dismissHistory: true,
		pasteText: mentionText(path),
	});
	const owned = useAppStore.getState().composerFocusRequest;
	if (owned) guardComposerFocus(owned);
}

export function revealArtifact(workspaceId: string, path: string): void {
	const store = useAppStore.getState();
	store.setFilesMode("all");
	store.revealInFiles(workspaceId, path);
	store.requestToolView(workspaceId, "files");
}

async function restoreArtifact(workspaceId: string, path: string): Promise<boolean> {
	try {
		await getTransport().request("artifacts.restore", { workspaceId, path });
		return true;
	} catch (error) {
		toast.error(
			wsErrorCode(error) === "ENTRY_EXISTS"
				? t("panels.artifacts.restoreTaken", { name: fileName(path) })
				: errorText(error),
			t("panels.artifacts.restoreFailed"),
		);
		return false;
	}
}

interface PendingRestore {
	workspaceId: string;
	projectId: string;
	worktreePath: string;
	connectionGeneration: number;
	deletedAt: number;
	restore: Promise<boolean>;
}

const pendingRestores = new Map<string, PendingRestore>();

useAppStore.subscribe((state, previous) => {
	if (
		state.status === previous.status &&
		state.connectionGeneration === previous.connectionGeneration &&
		state.workspaces === previous.workspaces &&
		state.removedWorkspaceIds === previous.removedWorkspaceIds
	)
		return;
	for (const [key, entry] of pendingRestores) {
		const workspace = selectWorkspaceById(state, entry.workspaceId);
		if (
			state.status !== "connected" ||
			state.connectionGeneration !== entry.connectionGeneration ||
			state.removedWorkspaceIds[entry.workspaceId] ||
			!workspace ||
			workspace.deletionPending ||
			workspace.projectId !== entry.projectId ||
			workspace.worktreePath !== entry.worktreePath
		)
			pendingRestores.delete(key);
	}
});

export function restoreDeletedArtifact(
	workspaceId: string,
	artifact: WorkspaceArtifact,
): Promise<boolean> {
	const state = useAppStore.getState();
	const workspace = selectWorkspaceById(state, workspaceId);
	if (
		state.status !== "connected" ||
		state.removedWorkspaceIds[workspaceId] ||
		!workspace ||
		workspace.deletionPending
	) {
		return Promise.resolve(false);
	}
	const key = tupleKey("artifact", workspaceId, artifact.path);
	const pending = pendingRestores.get(key);
	if (pending?.deletedAt === artifact.changedAt) return pending.restore;
	const entry: PendingRestore = {
		workspaceId,
		projectId: workspace.projectId,
		worktreePath: workspace.worktreePath,
		connectionGeneration: state.connectionGeneration,
		deletedAt: artifact.changedAt,
		restore: Promise.resolve(false),
	};
	entry.restore = restoreArtifact(workspaceId, artifact.path).then((restored) => {
		if (pendingRestores.get(key) !== entry) return false;
		if (!restored) pendingRestores.delete(key);
		return restored;
	});
	pendingRestores.set(key, entry);
	return entry.restore;
}

export async function openArtifact(
	workspaceId: string,
	artifact: WorkspaceArtifact,
	intent: "preview" | "keep",
): Promise<void> {
	if (artifact.state !== "deleted") return openFileInTab(workspaceId, artifact.path, intent);
	const navigation = useAppStore.getState().beginCenterNavigation(workspaceId);
	const restore = restoreDeletedArtifact(workspaceId, artifact);
	if (
		!(await restore) ||
		pendingRestores.get(tupleKey("artifact", workspaceId, artifact.path))?.restore !== restore
	)
		return;
	await openFileInTab(workspaceId, artifact.path, intent, navigation);
}

export async function discardArtifact(workspaceId: string, path: string): Promise<void> {
	try {
		await getTransport().request("artifacts.discard", { workspaceId, path });
	} catch (error) {
		toast.error(errorText(error), t("panels.artifacts.discardFailed"));
	}
}
