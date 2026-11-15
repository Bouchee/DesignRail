import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { selectComposerFocusRequested, useAppStore } from "../store";
import { focusChatComposer, focusProjects, focusTerminal, showFiles } from "./chordActions";
import { reconcileAttention, selectTab, type WorkspaceLayoutDocument } from "./layout";
import { cancelPendingRegionFocus, orderRegions, type RegionKind, whenSettled } from "./regions";

const region = (name: string, kind: RegionKind, top: number, left: number) => ({
	name,
	kind,
	rect: { top, left },
});

const names = (regions: ReadonlyArray<{ name: string }>) => regions.map(({ name }) => name);

describe("region ring order", () => {
	test("runs top bar, left top to bottom, center, right, then bottom left to right", () => {
		const shuffled = [
			region("bottom-right", "bottom", 700, 900),
			region("right", "right", 40, 1200),
			region("center-a", "center", 40, 300),
			region("left-lower", "left", 400, 40),
			region("bottom-left", "bottom", 700, 300),
			region("topbar", "topbar", 0, 0),
			region("left-upper", "left", 40, 40),
			region("center-b", "center", 40, 800),
		];
		expect(names(orderRegions(shuffled))).toEqual([
			"topbar",
			"left-upper",
			"left-lower",
			"center-a",
			"center-b",
			"right",
			"bottom-left",
			"bottom-right",
		]);
	});

	test("keeps center groups in document order, the order Ctrl+F6 walks", () => {
		const nested = [
			region("first", "center", 40, 300),
			region("below-first", "center", 400, 300),
			region("beside", "center", 40, 800),
		];
		expect(names(orderRegions(nested))).toEqual(["first", "below-first", "beside"]);
	});

	test("puts the Project Home pane right after the top bar", () => {
		expect(
			names(orderRegions([region("projects", "home", 40, 40), region("topbar", "topbar", 0, 0)])),
		).toEqual(["topbar", "projects"]);
	});
});

describe("delayed explicit focus", () => {
	const initial = useAppStore.getInitialState();
	const originals = new Map<string, PropertyDescriptor | undefined>();
	const frames = new Map<number, FrameRequestCallback>();
	let frameId = 0;
	let browser: EventTarget;
	let doc: EventTarget & {
		querySelectorAll: (selector: string) => object[];
		querySelector: (selector: string) => object | null;
	};
	let layers: object[];
	let body: FocusNode | null;
	let terminals: FocusNode[];
	let chats: FocusNode[];
	let focused: FocusNode | null;

	class FocusNode {
		readonly isConnected = true;
		readonly dataset: { tabKey?: string; chatWorkspace?: string; chatSession?: string } = {};
		mode = "all";
		child: FocusNode | null = null;

		getClientRects() {
			return [{}];
		}
		getBoundingClientRect() {
			return { width: 100, height: 100 };
		}
		closest() {
			return null;
		}
		matches(selector: string) {
			return selector !== ":disabled";
		}
		hasAttribute() {
			return false;
		}
		querySelectorAll() {
			return [];
		}
		querySelector(selector: string) {
			return selector.includes("data-files-mode")
				? selector.includes(`"${this.mode}"`)
					? this
					: null
				: this.child;
		}
		focus() {
			focused = this;
			doc.dispatchEvent(new Event("focusin"));
		}
	}

	const replace = (name: string, value: unknown) => {
		originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	};
	const frame = () => {
		const queued = [...frames.values()];
		frames.clear();
		for (const callback of queued) callback(0);
	};
	const gesture = (type: string, repeat = false) => {
		const event = new Event(type);
		Object.defineProperty(event, "repeat", { value: repeat });
		browser.dispatchEvent(event);
	};
	const chat = {
		kind: "chat" as const,
		id: "chat",
		name: "Chat",
		sessionId: "s",
		workspaceId: "w",
	};
	const document: WorkspaceLayoutDocument = {
		version: 2,
		center: {
			kind: "group",
			id: "center",
			tabs: [{ kind: "file", id: "file", name: "a", path: "a" }, chat],
		},
		left: { visible: false, width: 0.2, groups: [] },
		right: { visible: false, width: 0.2, groups: [] },
		bottom: { visible: false, height: 0.3, alignment: "center", groups: [] },
		toolRestoreTargets: {},
	};
	const showChat = () => {
		const attention = useAppStore.getState().layoutAttentionByWorkspace.w;
		if (!attention) throw new Error("Missing attention fixture");
		useAppStore.setState({
			layoutAttentionByWorkspace: {
				w: selectTab(attention, { area: "center", groupId: "center" }, chat.id, false),
			},
		});
	};

	const mountComposer = () => {
		const view = new FocusNode();
		view.dataset.chatWorkspace = "w";
		view.dataset.chatSession = "s";
		view.child = new FocusNode();
		chats = [view];
	};

	beforeEach(() => {
		frames.clear();
		frameId = 0;
		layers = [];
		body = null;
		terminals = [];
		chats = [];
		focused = null;
		browser = new EventTarget();
		doc = Object.assign(new EventTarget(), {
			querySelectorAll: (selector: string) =>
				selector.includes("data-tab-key")
					? terminals
					: selector.includes("data-chat-session")
						? chats
						: layers,
			querySelector: (selector: string) => (selector.includes("data-tool-body") ? body : null),
		});
		replace("window", browser);
		replace("document", doc);
		replace("Element", FocusNode);
		replace("HTMLElement", FocusNode);
		replace("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.set(++frameId, callback);
			return frameId;
		});
		replace("cancelAnimationFrame", (id: number) => {
			frames.delete(id);
		});
		useAppStore.setState(initial, true);
		useAppStore.setState({
			activeWorkspaceId: "w",
			selectedProjectId: "p",
			tabsByWorkspace: { w: [chat] },
			layoutDocumentsByWorkspace: { w: document },
			layoutAttentionByWorkspace: { w: reconcileAttention(document, undefined) },
		});
	});
	afterEach(() => {
		cancelPendingRegionFocus();
		useAppStore.setState(initial, true);
		for (const [name, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
		originals.clear();
	});

	test("composer waits through its own synchronous navigation and delayed attention, including history", () => {
		focusChatComposer();
		expect(useAppStore.getState().navTickByWorkspace.w).toBeGreaterThan(0);
		expect(useAppStore.getState().composerFocusRequest).toBeNull();
		showChat();
		mountComposer();
		frame();
		expect(useAppStore.getState().composerFocusRequest).toMatchObject({
			workspaceId: "w",
			sessionId: "s",
			dismissHistory: true,
		});
		expect(selectComposerFocusRequested(useAppStore.getState(), "w", "s")).toBe(true);
		useAppStore.getState().clearComposerFocusRequest();
		frame();
		expect(frames.size).toBe(0);
	});

	test("leaving and returning never revives an old composer wait", () => {
		focusChatComposer();
		useAppStore.setState({ activeWorkspaceId: "other" });
		useAppStore.setState({ activeWorkspaceId: "w" });
		showChat();
		frame();
		expect(useAppStore.getState().composerFocusRequest).toBeNull();
		expect(frames.size).toBe(0);
	});

	test("a cold composer cannot take focus after the user moves to Projects", () => {
		showChat();
		focusChatComposer();
		expect(useAppStore.getState().composerFocusRequest).toBeNull();
		gesture("pointerdown");
		body = new FocusNode();
		focusProjects(() => {});
		mountComposer();
		frame();
		expect(focused).toBe(body);
		expect(selectComposerFocusRequested(useAppStore.getState(), "w", "s")).toBe(false);
	});

	for (const newer of ["pointer", "chord"]) {
		test(`a ${newer} cancels its own ready but unconsumed composer request`, () => {
			showChat();
			mountComposer();
			focusChatComposer();
			expect(useAppStore.getState().composerFocusRequest).not.toBeNull();
			if (newer === "pointer") gesture("pointerdown");
			else {
				body = new FocusNode();
				focusProjects(() => {});
			}
			frame();
			expect(useAppStore.getState().composerFocusRequest).toBeNull();
			expect(selectComposerFocusRequested(useAppStore.getState(), "w", "s")).toBe(false);
		});
	}

	test("Files waits for its requested mode and allows the layout's own programmatic focus", () => {
		body = new FocusNode();
		showFiles("changed");
		expect(focused).toBeNull();
		doc.dispatchEvent(new Event("focusin"));
		frame();
		expect(focused).toBeNull();
		body.mode = "changed";
		frame();
		expect(focused).toBe(body);
		expect(useAppStore.getState().filesMode).toBe("changed");
	});

	test("a composer from another workspace or chat never satisfies the target", () => {
		showChat();
		mountComposer();
		const view = chats[0];
		if (!view) throw new Error("Missing composer fixture");
		view.dataset.chatSession = "other-session";
		focusChatComposer();
		frame();
		expect(useAppStore.getState().composerFocusRequest).toBeNull();
		view.dataset.chatSession = "s";
		view.dataset.chatWorkspace = "other-workspace";
		frame();
		expect(useAppStore.getState().composerFocusRequest).toBeNull();
	});

	test("cancelling an old wait preserves a newer owner's composer request", () => {
		showChat();
		mountComposer();
		focusChatComposer();
		useAppStore.getState().requestComposerFocus("w", "s");
		const newer = useAppStore.getState().composerFocusRequest;
		gesture("pointerdown");
		frame();
		expect(useAppStore.getState().composerFocusRequest).toBe(newer);
	});

	test("a hidden terminal uses its select intent and focuses its later rendered input", () => {
		useAppStore.setState({
			activeTerminalByWorkspace: { w: "term" },
			terminalsByWorkspace: { w: [{ tabKey: "term", workspaceId: "w", title: "Terminal" }] },
		});
		focusTerminal();
		expect(useAppStore.getState().layoutIntents.at(-1)).toMatchObject({
			kind: "select-terminal",
			workspaceId: "w",
			tabKey: "term",
		});
		const terminal = new FocusNode();
		terminal.dataset.tabKey = "term";
		const input = new FocusNode();
		terminal.child = input;
		terminals = [terminal];
		doc.dispatchEvent(new Event("focusin"));
		frame();
		expect(focused).toBe(input);
	});

	for (const type of ["keydown", "pointerdown", "blur"]) {
		test(`a user's ${type} permanently cancels an older Files wait`, () => {
			showFiles("changed");
			gesture(type);
			body = new FocusNode();
			body.mode = "changed";
			frame();
			expect(focused).toBeNull();
			expect(frames.size).toBe(0);
		});
	}

	test("a newer explicit focus replaces an older pending tool focus", () => {
		showFiles("changed");
		let newer = 0;
		whenSettled(
			() => true,
			() => {
				newer++;
			},
		);
		body = new FocusNode();
		body.mode = "changed";
		frame();
		expect(newer).toBe(1);
		expect(focused).toBeNull();
	});

	test("a counted tab switch permanently cancels pending tool focus", () => {
		showFiles("changed");
		useAppStore.getState().noteNavigation("w");
		body = new FocusNode();
		body.mode = "changed";
		frame();
		expect(focused).toBeNull();
	});

	test("repeat keys do not kill the first pending focus", () => {
		showFiles("changed");
		gesture("keydown", true);
		body = new FocusNode();
		body.mode = "changed";
		frame();
		expect(focused).toBe(body);
	});

	test("a new blocking modal permanently cancels the wait, even after it closes", () => {
		showFiles("changed");
		layers = [{}];
		frame();
		layers = [];
		body = new FocusNode();
		body.mode = "changed";
		frame();
		expect(focused).toBeNull();
		expect(frames.size).toBe(0);
	});

	test("a palette layer already closing may disappear before the focus lands", () => {
		layers = [{}];
		showFiles("changed");
		body = new FocusNode();
		body.mode = "changed";
		frame();
		expect(focused).toBeNull();
		layers = [];
		frame();
		expect(focused).toBe(body);
	});

	test("an unavailable target expires and releases the frame wait", () => {
		showFiles("changed");
		for (let step = 0; step < 125; step++) frame();
		expect(frames.size).toBe(0);
		body = new FocusNode();
		body.mode = "changed";
		frame();
		expect(focused).toBeNull();
	});
});
