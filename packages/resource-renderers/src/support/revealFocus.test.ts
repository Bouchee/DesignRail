import { afterEach, beforeEach, expect, test } from "bun:test";
import { focusCommentCardWhenRendered, revealReviewCard } from "./revealFocus";

class NodeFixture {
	isConnected = true;
	disabled = false;
	visible = true;
	inert = false;
	scrolls = 0;
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
		return this.visible ? [{}] : [];
	}
	closest() {
		return this.inert ? {} : null;
	}
	scrollIntoView() {
		this.scrolls++;
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

const scopeWithCard = (id: string) => {
	const scope = new NodeFixture();
	const card = new NodeFixture();
	card.dataset.commentId = id;
	card.control = new NodeFixture();
	scope.cards = [card];
	return { scope, card };
};
const parent = (node: NodeFixture) => node as unknown as ParentNode;

test("a delayed card focuses its first control after becoming available", () => {
	const { scope, card } = scopeWithCard("c");
	scope.cards = [];
	disposers.push(focusCommentCardWhenRendered(() => parent(scope), "c"));
	frame();
	expect(focused).toBeNull();
	scope.cards = [card];
	frame();
	expect(focused).toBe(card.control);
});

for (const type of ["keydown", "pointerdown", "blur"])
	test(`a ${type} cancels a card that mounts later`, () => {
		const { scope, card } = scopeWithCard("c");
		scope.cards = [];
		disposers.push(focusCommentCardWhenRendered(() => parent(scope), "c"));
		gesture(type);
		scope.cards = [card];
		frame();
		expect(focused).toBeNull();
	});

test("a root replacement or unmount cannot satisfy the old resource request", () => {
	const first = scopeWithCard("c");
	first.scope.cards = [];
	const second = scopeWithCard("c");
	let current = first.scope;
	disposers.push(focusCommentCardWhenRendered(() => parent(current), "c"));
	current = second.scope;
	frame();
	expect(focused).toBeNull();
	disposers.push(focusCommentCardWhenRendered(() => parent(current), "c"));
	current.isConnected = false;
	frame();
	expect(focused).toBeNull();
});

test("a newer request cancels the previous card while preserving normal landing", () => {
	const { scope, card } = scopeWithCard("new");
	const old = focusCommentCardWhenRendered(() => parent(scope), "old");
	disposers.push(old);
	old();
	disposers.push(focusCommentCardWhenRendered(() => parent(scope), "new"));
	frame();
	expect(focused).toBe(card.control);
});

test("a new modal cancels a card and closing it never revives that request", () => {
	const { scope, card } = scopeWithCard("c");
	scope.cards = [];
	disposers.push(focusCommentCardWhenRendered(() => parent(scope), "c"));
	layers = [{}];
	mutate();
	layers = [];
	mutate();
	scope.cards = [card];
	frame();
	expect(focused).toBeNull();
});

test("an already closing layer may finish and a disabled control may become ready", () => {
	const { scope, card } = scopeWithCard("c");
	layers = [{}];
	if (!card.control) throw new Error("Missing control fixture");
	card.control.disabled = true;
	disposers.push(focusCommentCardWhenRendered(() => parent(scope), "c"));
	frame();
	expect(focused).toBeNull();
	layers = [];
	mutate();
	frame();
	expect(focused).toBeNull();
	card.control.disabled = false;
	frame();
	expect(focused).toBe(card.control);
});

test("an explicit card reveal is not handled until its first control has rects and is not inert", () => {
	const { card } = scopeWithCard("c");
	const control = card.control;
	if (!control) throw new Error("Missing control fixture");
	control.visible = false;
	expect(revealReviewCard(card as unknown as Element, true)).toBe(false);
	expect(focused).toBeNull();
	control.visible = true;
	control.inert = true;
	expect(revealReviewCard(card as unknown as Element, true)).toBe(false);
	expect(focused).toBeNull();
	control.inert = false;
	expect(revealReviewCard(card as unknown as Element, true)).toBe(true);
	expect(focused).toBe(control);
});

test("a scroll-only card reveal completes while preserving focus", () => {
	const { card } = scopeWithCard("c");
	card.control = null;
	expect(revealReviewCard(card as unknown as Element, false)).toBe(true);
	expect(card.scrolls).toBe(1);
	expect(focused).toBeNull();
});

test("a delayed card acknowledges only after its first control becomes focusable", () => {
	const { scope, card } = scopeWithCard("c");
	const control = card.control;
	if (!control) throw new Error("Missing control fixture");
	let handled = 0;
	control.visible = false;
	disposers.push(
		focusCommentCardWhenRendered(
			() => parent(scope),
			"c",
			() => {
				handled++;
			},
		),
	);
	frame();
	expect(handled).toBe(0);
	control.visible = true;
	control.inert = true;
	frame();
	expect(handled).toBe(0);
	control.inert = false;
	frame();
	expect(handled).toBe(1);
	expect(focused).toBe(control);
});
