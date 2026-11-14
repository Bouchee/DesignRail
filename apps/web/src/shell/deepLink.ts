import {
	NATIVE_OPEN_FILE_LIMITS,
	type NativeDeepLinkBridge,
	type NativeOpenFileRequest,
} from "@thinkrail/contracts";
import { t } from "@thinkrail/locales/react";
import { supersedePendingRoute } from "../navigation";
import { openFileAtLine } from "../panels/openTabs";
import { resolveWorkspaceFile } from "../panels/workspaceForPath";
import { toast, useAppStore } from "../store";
import { paletteNavigator } from "./paletteNavigation";

const NATIVE_DEEP_LINKS_GLOBAL = "__THINKRAIL_NATIVE_DEEP_LINKS__";

function position(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= NATIVE_OPEN_FILE_LIMITS.position
		? value
		: undefined;
}

export function getNativeDeepLinkBridge(value: unknown): NativeDeepLinkBridge | null {
	if (typeof value !== "object" || value === null) return null;
	const subscribe = Reflect.get(value, "subscribe");
	return typeof subscribe === "function" ? (value as NativeDeepLinkBridge) : null;
}

function waitForWelcome(): Promise<void> {
	if (useAppStore.getState().welcomeGeneration > 0) return Promise.resolve();
	return new Promise((resolve) => {
		const unsubscribe = useAppStore.subscribe((state) => {
			if (state.welcomeGeneration === 0) return;
			unsubscribe();
			resolve();
		});
	});
}

function fileTabOpen(workspaceId: string, path: string): boolean {
	return (useAppStore.getState().tabsByWorkspace[workspaceId] ?? []).some(
		(tab) => tab.kind === "file" && tab.path === path,
	);
}

export async function openDeepLink(
	request: NativeOpenFileRequest,
	navigateToWorkspace = paletteNavigator.navigateToWorkspace,
): Promise<void> {
	supersedePendingRoute();
	const stillWanted = paletteNavigator.beginPick();
	await waitForWelcome();
	if (!stillWanted()) return;
	const found = await resolveWorkspaceFile(request.file).catch((error: unknown) => {
		if (stillWanted()) throw error;
		return null;
	});
	if (!stillWanted()) return;
	if (!found) {
		toast.error(t("shell.deepLink.notInProject", { path: request.file }));
		return;
	}
	const { workspaceId, projectId, relativePath } = found;
	if (!(await navigateToWorkspace({ id: workspaceId, projectId }))) return;
	const column = position(request.column);
	await openFileAtLine(
		workspaceId,
		relativePath,
		{ line: position(request.line) ?? 1, ...(column === undefined ? {} : { column }) },
		"keep",
	);
	if (!fileTabOpen(workspaceId, relativePath)) {
		toast.error(t("shell.deepLink.openFailed", { path: request.file }));
	}
}

export function installDeepLinks(
	bridge = getNativeDeepLinkBridge(Reflect.get(globalThis, NATIVE_DEEP_LINKS_GLOBAL)),
): void {
	if (!bridge) return;
	bridge.subscribe((request) => {
		void openDeepLink(request).catch(() => {
			toast.error(t("shell.deepLink.openFailed", { path: request.file }));
		});
	});
}
