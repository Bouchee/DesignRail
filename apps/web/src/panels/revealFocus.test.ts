import { afterEach, beforeEach, expect, test } from "bun:test";
import { selectComposerFocusRequested, useAppStore } from "../store";
import { mentionArtifact, selectArtifactMentionTarget } from "./artifactActions";
import {
	clearOwnedReviewFocus,
	focusWhenRevealed,
	guardComposerFocus,
	guardReviewFocus,
} from "./revealFocus";

class NodeFixture {
	isConnected = true;
	disabled = false;
	control: NodeFixture | null = null;
	cards: NodeFixture[] = [];
	dataset: { commentId?: string } = {};
	querySelector() {
		return this.control;
	}
	querySelectorAll() {
		return this.cards;
	}
	getClientRects() {
		return [{}];
	}
	closest() {
		return null;
	}
	matches() {
		return this.disabled;
	}
	focus() {
		focused = this;
	}
}
let focused: NodeFixture | null;
let browser: EventTarget;
let layers: object[];
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
const observers = new Set<ObserverFixture>();
const originals = new Map<string, PropertyDescriptor | undefined>();
const disposers: (() => void)[] = [];
class ObserverFixture {
	readonly notify: () => void;
	constructor(notify: () => void) {
		this.notify = notify;
	}
	observe() {
		observers.add(this);
	}
	disconnect() {
		observers.delete(this);
	}
}
const replace = (name: string, value: unknown) => {
	originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};
const frame = () => {
	const pending = [...frames.values()];
	frames.clear();
	for (const callback of pending) callback(0);
};
const gesture = (type: string) => browser.dispatchEvent(new Event(type));
const mutate = () => {
	for (const observer of [...observers]) observer.notify();
};
const element = (node: NodeFixture) => node as unknown as Element;
beforeEach(() => {
	focused = null;
	browser = new EventTarget();
	layers = [];
	frameId = 0;
	frames.clear();
	replace("window", browser);
	replace("document", {
		body: {},
		querySelector: () => layers[0] ?? null,
		querySelectorAll: () => layers,
	});
	replace("Element", NodeFixture);
	replace("MutationObserver", ObserverFixture);
	replace("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	replace("cancelAnimationFrame", (id: number) => {
		frames.delete(id);
	});
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	expect(observers.size).toBe(0);
	expect(frames.size).toBe(0);
	for (const [name, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originals.clear();
});

const initial = useAppStore.getInitialState();
beforeEach(() => {
	useAppStore.setState(initial, true);
	useAppStore.setState({ activeWorkspaceId: "w" });
});
afterEach(() => useAppStore.setState(initial, true));
const requestReview = () => {
	useAppStore.getState().requestReviewFocus("w", "comment", { kind: "inline" });
	const request = useAppStore.getState().reviewFocusRequest;
	if (!request) throw new Error("Missing request fixture");
	return request;
};

test("a normal delayed header lands on its first enabled control", () => {
	const scope = new NodeFixture();
	const container = new NodeFixture();
	const input = new NodeFixture();
	let ready = false;
	container.control = input;
	disposers.push(focusWhenRevealed(() => (ready ? element(container) : null), element(scope)));
	frame();
	expect(focused).toBeNull();
	ready = true;
	frame();
	expect(focused).toBe(input);
});

for (const type of ["keydown", "pointerdown", "blur"])
	test(`a ${type} before rendering permanently cancels the old header`, () => {
		const scope = new NodeFixture();
		const container = new NodeFixture();
		container.control = new NodeFixture();
		let ready = false;
		disposers.push(focusWhenRevealed(() => (ready ? element(container) : null), element(scope)));
		gesture(type);
		ready = true;
		frame();
		expect(focused).toBeNull();
	});

test("navigation away and back cancels a pending header", () => {
	const scope = new NodeFixture();
	const container = new NodeFixture();
	container.control = new NodeFixture();
	let ready = false;
	disposers.push(focusWhenRevealed(() => (ready ? element(container) : null), element(scope)));
	useAppStore.setState({ activeWorkspaceId: "other" });
	useAppStore.setState({ activeWorkspaceId: "w" });
	ready = true;
	frame();
	expect(focused).toBeNull();
});

test("unmount and a newer header request supersede the previous one", () => {
	const scope = new NodeFixture();
	const old = new NodeFixture();
	old.control = new NodeFixture();
	const cancel = focusWhenRevealed(() => element(old), element(scope));
	disposers.push(cancel);
	cancel();
	const current = new NodeFixture();
	current.control = new NodeFixture();
	disposers.push(focusWhenRevealed(() => element(current), element(scope)));
	frame();
	expect(focused).toBe(current.control);
	focused = null;
	const removed = new NodeFixture();
	disposers.push(focusWhenRevealed(() => element(old), element(removed)));
	removed.isConnected = false;
	frame();
	expect(focused).toBeNull();
});

test("a new blocking modal cancels a pending header across its later dismissal", () => {
	const scope = new NodeFixture();
	const container = new NodeFixture();
	container.control = new NodeFixture();
	let ready = false;
	disposers.push(focusWhenRevealed(() => (ready ? element(container) : null), element(scope)));
	layers = [{}];
	mutate();
	layers = [];
	mutate();
	ready = true;
	frame();
	expect(focused).toBeNull();
});

test("a cold Show remains owned past the DOM budget and may land after its own navigation", () => {
	const request = requestReview();
	useAppStore.getState().noteNavigation("w");
	disposers.push(guardReviewFocus(request));
	for (let count = 0; count < 250; count++) frame();
	expect(useAppStore.getState().reviewFocusRequest).toBe(request);
	const scope = new NodeFixture();
	const card = new NodeFixture();
	card.control = new NodeFixture();
	disposers.push(focusWhenRevealed(() => element(card), element(scope)));
	frame();
	expect(focused).toBe(card.control);
	useAppStore.getState().clearReviewFocus("comment");
	expect(observers.size).toBe(0);
});

for (const type of ["keydown", "pointerdown"])
	test(`a cold Show loses its moveFocus request when ${type} precedes renderer creation`, () => {
		const request = requestReview();
		disposers.push(guardReviewFocus(request));
		gesture(type);
		for (let count = 0; count < 250; count++) frame();
		expect(useAppStore.getState().reviewFocusRequest).toBeNull();
		expect(focused).toBeNull();
	});

test("cancelling an old Show does not clear a newer request", () => {
	const old = requestReview();
	const cancel = guardReviewFocus(old);
	disposers.push(cancel);
	const current = requestReview();
	disposers.push(guardReviewFocus(current));
	cancel();
	expect(useAppStore.getState().reviewFocusRequest).toBe(current);
});

test("release of an older passive reveal preserves a new same-comment owner", () => {
	const request = requestReview();
	const passive = { ...request, moveFocus: false };
	useAppStore.setState({ reviewFocusRequest: passive });
	const newer = requestReview();
	clearOwnedReviewFocus(passive);
	expect(useAppStore.getState().reviewFocusRequest).toBe(newer);
	clearOwnedReviewFocus(newer);
	expect(useAppStore.getState().reviewFocusRequest).toBeNull();
});

function attendedChat() {
	useAppStore.setState({
		activeWorkspaceId: "w",
		layoutDocumentsByWorkspace: {
			w: {
				version: 2,
				center: {
					kind: "group",
					id: "center",
					tabs: [{ kind: "chat", id: "chat", name: "Chat", sessionId: "s" }],
				},
				left: { visible: false, width: 0.2, groups: [] },
				right: { visible: false, width: 0.2, groups: [] },
				bottom: { visible: false, height: 0.3, alignment: "center", groups: [] },
				toolRestoreTargets: {},
			},
		},
		layoutAttentionByWorkspace: {
			w: {
				selectedByGroup: { center: "chat" },
				lastFocusedCenterGroupId: "center",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: {},
			},
		},
	});
}

test("Mention waits as one guarded paste/focus request, preserving its target until normal consumption", () => {
	attendedChat();
	mentionArtifact("w", ".raildesign/context/plan.md");
	expect(useAppStore.getState().composerFocusRequest).toMatchObject({
		workspaceId: "w",
		sessionId: "s",
		dismissHistory: true,
		pasteText: "@.raildesign/context/plan.md ",
	});
	expect(selectComposerFocusRequested(useAppStore.getState(), "w", "s")).toBe(true);
	useAppStore.getState().clearComposerFocusRequest();
	expect(observers.size).toBe(0);
});

for (const event of ["pointerdown", "keydown", "blur"])
	test(`a cold Mention cancelled by ${event} leaves no late paste or focus payload`, () => {
		attendedChat();
		mentionArtifact("w", ".raildesign/context/plan.md");
		gesture(event);
		expect(useAppStore.getState().composerFocusRequest).toBeNull();
		expect(selectComposerFocusRequested(useAppStore.getState(), "w", "s")).toBe(false);
	});

test("Mention only targets the currently active workspace and a newer request survives old cleanup", () => {
	attendedChat();
	expect(
		selectArtifactMentionTarget({ ...useAppStore.getState(), activeWorkspaceId: "other" }, "w"),
	).toBeNull();
	mentionArtifact("w", "first.md");
	const old = useAppStore.getState().composerFocusRequest;
	if (!old) throw new Error("Missing Mention request");
	useAppStore.getState().requestComposerFocus("w", "s", { pasteText: "new" });
	guardComposerFocus(old);
	expect(useAppStore.getState().composerFocusRequest?.pasteText).toBe("new");
	useAppStore.getState().clearComposerFocusRequest();
});

test("navigation away and back permanently cancels a cold Mention", () => {
	attendedChat();
	mentionArtifact("w", "plan.md");
	useAppStore.setState({ activeWorkspaceId: "other" });
	useAppStore.setState({ activeWorkspaceId: "w" });
	expect(useAppStore.getState().composerFocusRequest).toBeNull();
});
