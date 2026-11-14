import { useEffect, useRef } from "react";
import { doubleClickPendingMs } from "../../lib";
import {
	selectActiveFilePath,
	selectAttentionCenterResourceCacheKey,
	selectAttentionCenterTab,
	useAppStore,
} from "../../store";
import type { LayoutCenterTab } from "../layout";

function syncLegacySelectedResource(
	workspaceId: string,
	tab: LayoutCenterTab | null,
	cacheKey: string | null,
): void {
	const state = useAppStore.getState();
	if (!tab) {
		state.syncLegacySelection(workspaceId, null);
		return;
	}
	if (tab.kind === "terminal") {
		state.syncLegacySelection(
			workspaceId,
			cacheKey === tab.tabKey ? { kind: "terminal", tabKey: tab.tabKey } : null,
		);
		return;
	}
	const cache = cacheKey
		? state.tabsByWorkspace[workspaceId]?.find((candidate) => candidate.id === cacheKey)
		: undefined;
	state.syncLegacySelection(workspaceId, cache ? { kind: "editor", tabId: cache.id } : null);
}

export function syncLegacySelectionFromAttention(workspaceId: string): void {
	const state = useAppStore.getState();
	syncLegacySelectedResource(
		workspaceId,
		selectAttentionCenterTab(state, workspaceId),
		selectAttentionCenterResourceCacheKey(state, workspaceId),
	);
}

export interface AuxiliaryView {
	reviewShowing: boolean;
	showingKey: string;
}

export function scheduleReviewReveal(
	reveal: () => void,
	readAuxiliary: () => AuxiliaryView,
	pending = doubleClickPendingMs(),
): (() => void) | undefined {
	const scheduled = readAuxiliary();
	if (scheduled.reviewShowing || pending === 0) {
		reveal();
		return;
	}
	const timer = setTimeout(() => {
		if (readAuxiliary().showingKey === scheduled.showingKey) reveal();
	}, pending);
	return () => clearTimeout(timer);
}

export function useLegacySelectionAdapter(
	workspaceId: string,
	activeReviewedPath: string | null,
	readActiveReviewedPath: () => string | null,
	readAuxiliary: () => AuxiliaryView,
): void {
	const selectedCenterTab = useAppStore((state) => selectAttentionCenterTab(state, workspaceId));
	const selectedCenterResourceCacheKey = useAppStore((state) =>
		selectAttentionCenterResourceCacheKey(state, workspaceId),
	);
	const activeLegacyTabId = useAppStore((state) => state.activeTabByWorkspace[workspaceId] ?? null);
	const activeFilePath = useAppStore((state) => selectActiveFilePath(state, workspaceId));
	const previousSelection = useRef<{
		workspaceId: string;
		selection: string | null;
	} | null>(null);

	useEffect(() => {
		const selection = activeLegacyTabId
			? JSON.stringify([activeLegacyTabId, activeFilePath])
			: null;
		const previous =
			previousSelection.current?.workspaceId === workspaceId
				? previousSelection.current.selection
				: null;
		previousSelection.current = { workspaceId, selection };
		if (!selection || !activeReviewedPath || selection === previous) return;
		const revealReview = () => {
			const state = useAppStore.getState();
			const currentActiveTabId = state.activeTabByWorkspace[workspaceId];
			const currentReviewedPath = readActiveReviewedPath();
			const currentSelection = currentActiveTabId
				? JSON.stringify([currentActiveTabId, selectActiveFilePath(state, workspaceId)])
				: null;
			if (currentSelection !== selection || currentReviewedPath !== activeReviewedPath) return;
			state.enqueueLayoutIntent({ kind: "reveal-tool", workspaceId, tool: "review" });
		};
		let revealed = false;
		const cancel = scheduleReviewReveal(() => {
			revealed = true;
			revealReview();
		}, readAuxiliary);
		return () => {
			cancel?.();
			if (!revealed && previousSelection.current?.selection === selection) {
				previousSelection.current = null;
			}
		};
	}, [
		activeLegacyTabId,
		activeFilePath,
		activeReviewedPath,
		readActiveReviewedPath,
		readAuxiliary,
		workspaceId,
	]);

	useEffect(() => {
		syncLegacySelectedResource(workspaceId, selectedCenterTab, selectedCenterResourceCacheKey);
	}, [selectedCenterResourceCacheKey, selectedCenterTab, workspaceId]);
}
