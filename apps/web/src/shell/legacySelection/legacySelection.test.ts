import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { act, createElement, type ReactNode, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DOUBLE_CLICK_SETTLE_MS, firstClickOnly } from "../../lib";
import { selectActiveFilePath, useAppStore } from "../../store";
import type { WorkspaceLayoutDocument } from "../layout";
import {
	type AuxiliaryView,
	scheduleReviewReveal,
	useLegacySelectionAdapter,
} from "./legacySelection";

const WINDOW_MS = 30;

type ReactGlobals = { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined; window?: unknown };
const globals = globalThis as ReactGlobals;
const savedGlobals = { act: globals.IS_REACT_ACT_ENVIRONMENT, window: globals.window };
let savedState: ReturnType<typeof useAppStore.getState>;
let roots: Root[] = [];

beforeAll(() => {
	globals.IS_REACT_ACT_ENVIRONMENT = true;
	globals.window = {
		event: undefined,
		HTMLIFrameElement: class {},
		document: { activeElement: null },
	};
});
beforeEach(() => {
	savedState = useAppStore.getState();
	firstClickOnly(
		() => {},
		() => Number.NEGATIVE_INFINITY,
	)({ detail: 1 });
});
afterEach(async () => {
	await act(async () => {
		for (const root of roots) root.unmount();
	});
	roots = [];
	useAppStore.setState(savedState, true);
	firstClickOnly(
		() => {},
		() => Number.NEGATIVE_INFINITY,
	)({ detail: 1 });
});
afterAll(() => {
	globals.IS_REACT_ACT_ENVIRONMENT = savedGlobals.act;
	globals.window = savedGlobals.window;
});

function headlessContainer(): Element {
	const noop = () => {};
	return {
		nodeType: 1,
		nodeName: "DIV",
		tagName: "DIV",
		namespaceURI: "http://www.w3.org/1999/xhtml",
		textContent: "",
		addEventListener: noop,
		removeEventListener: noop,
		ownerDocument: { nodeType: 9, addEventListener: noop, removeEventListener: noop },
	} as unknown as Element;
}

async function mount(node: ReactNode) {
	const root = createRoot(headlessContainer());
	roots.push(root);
	await act(async () => root.render(createElement(StrictMode, null, node)));
	return (next: ReactNode) => act(async () => root.render(createElement(StrictMode, null, next)));
}

function Adapter(props: {
	workspaceId: string;
	readActiveReviewedPath: () => string | null;
	readAuxiliary: () => AuxiliaryView;
}) {
	useLegacySelectionAdapter(
		props.workspaceId,
		props.readActiveReviewedPath(),
		props.readActiveReviewedPath,
		props.readAuxiliary,
	);
	return null;
}

function selectedFiles() {
	const workspaceId = "legacy-selection-test";
	const tabs = ["a", "b"].map((id) => ({
		kind: "file" as const,
		id,
		workspaceId,
		name: `${id}.ts`,
		path: `${id}.ts`,
		content: "",
	}));
	const document: WorkspaceLayoutDocument = {
		version: 2,
		center: { kind: "group", id: "center", tabs },
		left: { visible: false, width: 0.2, groups: [] },
		right: { visible: false, width: 0.2, groups: [] },
		bottom: { visible: false, height: 0.3, alignment: "center", groups: [] },
		toolRestoreTargets: {},
	};
	useAppStore.setState({
		activeWorkspaceId: workspaceId,
		tabsByWorkspace: { [workspaceId]: tabs },
		layoutDocumentsByWorkspace: { [workspaceId]: document },
		layoutIntents: [],
		removedWorkspaceIds: {},
	});
	const select = (id: string) =>
		useAppStore.setState({
			activeTabByWorkspace: { [workspaceId]: id },
			activeTerminalByWorkspace: { [workspaceId]: null },
			layoutAttentionByWorkspace: {
				[workspaceId]: {
					selectedByGroup: { center: id },
					lastFocusedCenterGroupId: "center",
					lastFocusedSideGroupId: {},
					navigationClockByGroup: { center: 0 },
				},
			},
		});
	select("a");
	const reviewed = new Set<string>();
	const props = {
		workspaceId,
		readActiveReviewedPath: () => {
			const path = selectActiveFilePath(useAppStore.getState(), workspaceId);
			return path && reviewed.has(path) ? path : null;
		},
		readAuxiliary: auxiliary(specsShowing).read,
	};
	return { reviewed, props, select };
}

function auxiliary(initial: AuxiliaryView) {
	let view = initial;
	return {
		read: () => view,
		set: (next: AuxiliaryView) => {
			view = next;
		},
	};
}

const specsShowing = { reviewShowing: false, showingKey: "specs" };

function afterWindow(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, WINDOW_MS + 1));
}

test("scheduleReviewReveal reveals at once when no double-click can arrive", () => {
	let reveals = 0;
	const cancel = scheduleReviewReveal(
		() => {
			reveals += 1;
		},
		auxiliary(specsShowing).read,
		0,
	);
	expect(reveals).toBe(1);
	expect(cancel).toBeUndefined();
});

test("scheduleReviewReveal waits out a browse row's double-click window", async () => {
	let reveals = 0;
	scheduleReviewReveal(
		() => {
			reveals += 1;
		},
		auxiliary(specsShowing).read,
		WINDOW_MS,
	);
	expect(reveals).toBe(0);
	await afterWindow();
	expect(reveals).toBe(1);
});

test("scheduleReviewReveal cleanup cancels a pending reveal", async () => {
	let reveals = 0;
	const cancel = scheduleReviewReveal(
		() => {
			reveals += 1;
		},
		auxiliary(specsShowing).read,
		WINDOW_MS,
	);
	cancel?.();
	await afterWindow();
	expect(reveals).toBe(0);
});

test("a deferred reveal yields to an auxiliary tool the user picked inside the window", async () => {
	const view = auxiliary({ reviewShowing: false, showingKey: "files" });
	let reveals = 0;
	scheduleReviewReveal(
		() => {
			reveals += 1;
		},
		view.read,
		WINDOW_MS,
	);
	view.set(specsShowing);
	await afterWindow();
	expect(reveals).toBe(0);
});

test("scheduleReviewReveal reveals at once when Review already shows, even mid double-click", () => {
	let reveals = 0;
	const cancel = scheduleReviewReveal(
		() => {
			reveals += 1;
		},
		auxiliary({ reviewShowing: true, showingKey: "review" }).read,
		DOUBLE_CLICK_SETTLE_MS,
	);
	expect(reveals).toBe(1);
	expect(cancel).toBeUndefined();
});

test("saving the first draft in the selected file does not reveal Review", async () => {
	const fixture = selectedFiles();
	const render = await mount(createElement(Adapter, fixture.props));
	expect(useAppStore.getState().layoutIntents).toHaveLength(0);
	fixture.reviewed.add("a.ts");
	await render(createElement(Adapter, fixture.props));
	expect(useAppStore.getState().layoutIntents).toHaveLength(0);
});

test("navigating to an already reviewed file reveals Review once", async () => {
	const fixture = selectedFiles();
	fixture.reviewed.add("b.ts");
	const render = await mount(createElement(Adapter, fixture.props));
	await act(async () => fixture.select("b"));
	await render(createElement(Adapter, fixture.props));
	expect(useAppStore.getState().layoutIntents).toEqual([
		expect.objectContaining({
			kind: "reveal-tool",
			workspaceId: fixture.props.workspaceId,
			tool: "review",
		}),
	]);
});

test("StrictMode replays a cancelled deferred reveal for the same activation", async () => {
	const fixture = selectedFiles();
	fixture.reviewed.add("a.ts");
	firstClickOnly(() => {})({ detail: 1 });
	await mount(createElement(Adapter, fixture.props));
	expect(useAppStore.getState().layoutIntents).toHaveLength(0);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_SETTLE_MS + 1));
	});
	expect(useAppStore.getState().layoutIntents).toHaveLength(1);
});

test("a deferred activation does not reveal a path that is no longer reviewed", async () => {
	const fixture = selectedFiles();
	fixture.reviewed.add("a.ts");
	firstClickOnly(() => {})({ detail: 1 });
	await mount(createElement(Adapter, fixture.props));
	fixture.reviewed.clear();
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, DOUBLE_CLICK_SETTLE_MS + 1));
	});
	expect(useAppStore.getState().layoutIntents).toHaveLength(0);
});
