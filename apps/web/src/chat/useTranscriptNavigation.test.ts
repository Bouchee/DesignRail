import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ChatRow } from "./rows";
import {
	createTranscriptNavigation,
	type TranscriptNavigationController,
	type TranscriptNavigationOptions,
} from "./useTranscriptNavigation";

const originals = new Map<string, PropertyDescriptor | undefined>();
const frames = new Map<number, FrameRequestCallback>();
const observers = new Set<() => void>();
let browser: EventTarget;
let doc: {
	body: FakeElement;
	activeElement: FakeElement;
	querySelectorAll: () => object[];
	querySelector: () => object | null;
	addEventListener: EventTarget["addEventListener"];
	removeEventListener: EventTarget["removeEventListener"];
};
let scroller: FakeElement;
let feed: FakeElement;
let mounted: Map<string, FakeElement>;
let modal: object | null;
let frameId = 0;
let latest = 0;
let nav: TranscriptNavigationController;
let options: TranscriptNavigationOptions;
let stop = () => {};
const reveals: {
	done: Parameters<TranscriptNavigationOptions["revealRow"]>[3];
	cancelled: boolean;
}[] = [];

class FakeElement extends EventTarget {
	isConnected = true;
	inert = false;
	tabIndex = -1;
	clientHeight = 100;
	parentElement: FakeElement | null = null;
	dataset: { transcriptItem?: string } = {};
	readonly kind: string;
	constructor(kind: string) {
		super();
		this.kind = kind;
	}
	contains(node: unknown): boolean {
		return node instanceof FakeElement && (node === this || this.contains(node.parentElement));
	}
	closest(selector: string): FakeElement | null {
		if (selector === "[inert]")
			return this.inert ? this : (this.parentElement?.closest(selector) ?? null);
		if (selector === "[data-transcript-item]")
			return this.dataset.transcriptItem ? this : (this.parentElement?.closest(selector) ?? null);
		return null;
	}
	getBoundingClientRect() {
		return this.kind === "scroller" ? { top: 0, bottom: 100 } : { top: 10, bottom: 30 };
	}
	getClientRects() {
		return [{}];
	}
	matches() {
		return false;
	}
	getAttribute() {
		return null;
	}
	querySelector(selector: string): FakeElement | null {
		if (selector === "[data-transcript-feed]") return feed;
		const match = selector.match(/^\[data-transcript-item="(.*)"\]$/);
		return match ? (mounted.get(match[1] ?? "") ?? null) : null;
	}
	querySelectorAll(selector: string) {
		return selector === "[data-transcript-item]" ? [...mounted.values()] : [];
	}
	focus() {
		doc.activeElement = this;
		if (scroller.contains(this)) emit(scroller, "focusin", this);
	}
}

function emit(
	target: EventTarget,
	type: string,
	source: FakeElement,
	props: Record<string, unknown> = {},
) {
	const event = new Event(type, { cancelable: true });
	Object.defineProperty(event, "target", { value: source });
	Object.assign(event, props);
	target.dispatchEvent(event);
	return event;
}
function key(target: FakeElement, value: string, props: Record<string, unknown> = {}) {
	const event = emit(browser, "keydown", target, {
		key: value,
		isComposing: false,
		keyCode: 0,
		shiftKey: false,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		repeat: false,
		...props,
	});
	scroller.dispatchEvent(event);
	return event;
}
function mount(id: string) {
	const element = new FakeElement("item");
	element.dataset.transcriptItem = id;
	element.parentElement = feed;
	mounted.set(id, element);
	return element;
}
function frame() {
	const callbacks = [...frames.values()];
	frames.clear();
	for (const callback of callbacks) callback(0);
}
function configure(scope = "w:s") {
	nav.configure({ ...options, scope });
}
function pendingRow() {
	const a = mount("a");
	nav.focusRow("a");
	key(a, "ArrowDown");
	const reveal = reveals.at(-1);
	if (!reveal) throw new Error("Expected a real controller reveal");
	return { a, reveal };
}

beforeEach(() => {
	const replace = (name: string, value: unknown) => {
		originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, value });
	};
	browser = new EventTarget();
	mounted = new Map();
	modal = null;
	frameId = 0;
	latest = 0;
	frames.clear();
	observers.clear();
	reveals.length = 0;
	const events = new EventTarget();
	const body = new FakeElement("body");
	doc = {
		body,
		activeElement: body,
		querySelectorAll: () => (modal ? [modal] : []),
		querySelector: () => modal,
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
	};
	scroller = new FakeElement("scroller");
	feed = new FakeElement("feed");
	feed.parentElement = scroller;
	replace("window", browser);
	replace("document", doc);
	replace("Element", FakeElement);
	replace("HTMLElement", FakeElement);
	replace("CSS", { escape: (value: string) => value });
	replace(
		"MutationObserver",
		class {
			readonly callback: () => void;
			constructor(callback: () => void) {
				this.callback = callback;
			}
			observe() {
				observers.add(this.callback);
			}
			disconnect() {
				observers.delete(this.callback);
			}
		},
	);
	replace("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	replace("cancelAnimationFrame", (id: number) => frames.delete(id));
	options = {
		scope: "w:s",
		rows: ["a", "b", "c"].map((id): ChatRow => ({ kind: "markdown", id, text: id })),
		newestRowId: "c",
		latestRowId: "c",
		revealRow: (_id, _index, _align, done) => {
			const entry = { done, cancelled: false };
			reveals.push(entry);
			return () => {
				entry.cancelled = true;
			};
		},
		revealElement: () => {},
		scrollToLatest: () => {
			latest++;
		},
		focusComposer: () => {},
		fileTarget: (path) => path,
		openFile: () => {},
		onCopied: () => {},
	};
	nav = createTranscriptNavigation();
	configure();
	stop = nav.attach(scroller as unknown as HTMLElement);
});
afterEach(() => {
	stop();
	for (const [name, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originals.clear();
});

test("a pending virtual row reveals and focuses through the real controller", () => {
	const { reveal } = pendingRow();
	const b = mount("b");
	reveal.done("found");
	expect(doc.activeElement).toBe(b);
	expect(reveal.cancelled).toBe(true);
});
test("same-transcript pointer focus permanently cancels an older virtual reveal", () => {
	const { a, reveal } = pendingRow();
	emit(browser, "pointerdown", a);
	a.focus();
	mount("b");
	reveal.done("found");
	expect(doc.activeElement).toBe(a);
	expect(reveal.cancelled).toBe(true);
});
test("an older reveal callback cannot cancel a newer request", () => {
	const { a, reveal } = pendingRow();
	key(a, "End");
	mount("b");
	reveal.done("found");
	const c = mount("c");
	frame();
	expect(doc.activeElement).toBe(c);
	expect(frames.size).toBe(0);
});
test("the latest-row mount wait focuses its target without self-cancelling", () => {
	nav.focusNewest();
	expect(doc.activeElement).toBe(feed);
	expect(latest).toBe(1);
	const c = mount("c");
	frame();
	expect(doc.activeElement).toBe(c);
	expect(observers.size).toBe(0);
});
test("a pointer before latest mounts prevents late focus even after returning to the feed", () => {
	nav.focusNewest();
	const a = mount("a");
	emit(browser, "pointerdown", a);
	a.focus();
	feed.focus();
	mount("c");
	frame();
	expect(doc.activeElement).toBe(feed);
	expect(frames.size).toBe(0);
});
test("navigation invalidation and scope A→B→A cannot revive a held result", () => {
	const { a, reveal } = pendingRow();
	nav.cancel();
	configure("w:other");
	configure();
	mount("b");
	reveal.done("found");
	expect(doc.activeElement).toBe(a);
});
test("an inert transcript cannot begin a hidden focus or scroll", () => {
	scroller.inert = true;
	nav.focusNewest();
	nav.focusRow("a");
	expect(latest).toBe(0);
	expect(doc.activeElement).toBe(doc.body);
	expect(frames.size).toBe(0);
});
test("becoming inert during a mount wait permanently cancels it", () => {
	nav.focusNewest();
	scroller.inert = true;
	frame();
	scroller.inert = false;
	mount("c");
	frame();
	expect(doc.activeElement).toBe(feed);
	expect(frames.size).toBe(0);
});
test("a new modal cancels the pending job even when it closes before the result", () => {
	const { a, reveal } = pendingRow();
	modal = {};
	for (const check of [...observers]) check();
	modal = null;
	mount("b");
	reveal.done("found");
	expect(doc.activeElement).toBe(a);
	expect(reveal.cancelled).toBe(true);
});
test("detach cancels pending reveal and its late callback", () => {
	const { a, reveal } = pendingRow();
	stop();
	mount("b");
	reveal.done("found");
	expect(doc.activeElement).toBe(a);
	expect(reveal.cancelled).toBe(true);
	expect(observers.size).toBe(0);
});
test("a normal menu dismissal returns to its own item", () => {
	const a = mount("a");
	nav.focusRow("a");
	key(a, "F10", { shiftKey: true });
	const menu = nav.menuFor("a");
	if (!menu) throw new Error("Menu missing");
	nav.closeMenu(menu);
	doc.activeElement = doc.body;
	nav.restoreFocus(menu);
	expect(doc.activeElement).toBe(a);
});
test("menu close cannot reclaim a newer row focus or clear a newer same-row menu", () => {
	const a = mount("a");
	const b = mount("b");
	nav.focusRow("a");
	key(a, "F10", { shiftKey: true });
	const old = nav.menuFor("a");
	if (!old) throw new Error("Menu missing");
	emit(browser, "pointerdown", b);
	b.focus();
	nav.restoreFocus(old);
	expect(doc.activeElement).toBe(b);
	nav.focusRow("a");
	key(a, "F10", { shiftKey: true });
	const current = nav.menuFor("a");
	nav.closeMenu(old);
	expect(nav.menuFor("a")).toBe(current);
});
test("a blur invalidates a menu's delayed return", () => {
	const a = mount("a");
	nav.focusRow("a");
	key(a, "F10", { shiftKey: true });
	const menu = nav.menuFor("a");
	if (!menu) throw new Error("Menu missing");
	browser.dispatchEvent(new Event("blur"));
	doc.activeElement = doc.body;
	nav.restoreFocus(menu);
	expect(doc.activeElement).toBe(doc.body);
});
