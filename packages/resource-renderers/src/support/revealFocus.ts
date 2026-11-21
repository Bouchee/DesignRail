import { focusFirstControl, TABBABLE_SELECTOR, whenFocusReady } from "@thinkrail/ui/focus";

const CARD_FRAMES = 30;
const CARD_SELECTOR = "[data-comment-id]";
const CARD_LANDING = "[data-focus-row-primary]:not(:disabled)";

export function commentCard(root: ParentNode, commentId: string): HTMLElement | undefined {
	return Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR)).find(
		(element) => element.dataset.commentId === commentId,
	);
}

export function focusReviewCard(target: Element): boolean {
	const card = target.matches(CARD_SELECTOR) ? target : target.querySelector(CARD_SELECTOR);
	if (!(card instanceof HTMLElement)) return focusFirstControl(target);
	const landing = card.querySelector<HTMLElement>(CARD_LANDING) ?? card;
	if (
		!landing.isConnected ||
		landing.getClientRects().length === 0 ||
		landing.closest("[inert]") ||
		landing.matches(":disabled")
	)
		return false;
	landing.focus({ preventScroll: true });
	if (landing instanceof HTMLTextAreaElement) {
		const end = landing.value.length;
		landing.setSelectionRange(end, end);
	}
	return document.activeElement === landing;
}

export function revealReviewCard(
	scrollTarget: Element,
	moveFocus: boolean,
	focusTarget: Element = scrollTarget,
): boolean {
	scrollTarget.scrollIntoView({ block: "center" });
	return !moveFocus || focusReviewCard(focusTarget);
}

export function focusCommentCardWhenRendered(
	root: () => ParentNode | null,
	commentId: string,
	onFocused?: () => void,
): () => void {
	const request = new AbortController();
	const owner = root();
	whenFocusReady(
		() => {
			const scope = root();
			if (!scope || scope !== owner || (scope instanceof Element && !scope.isConnected)) {
				request.abort();
				return false;
			}
			const card = commentCard(scope, commentId);
			if (!card || !focusReviewCard(card)) return false;
			onFocused?.();
			return true;
		},
		CARD_FRAMES,
		request,
	);
	return () => request.abort();
}

export function focusLeftIn(root: Element | null): boolean {
	const active = document.activeElement;
	return (
		!active ||
		active === document.body ||
		active === document.documentElement ||
		(root?.contains(active) ?? false)
	);
}

export function focusBefore(element: Element): boolean {
	let previous: HTMLElement | null = null;
	for (const control of document.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)) {
		if (!(control.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
		if (control.closest(CARD_SELECTOR) || control.getClientRects().length === 0) continue;
		previous = control;
	}
	previous?.focus({ preventScroll: true });
	return previous !== null;
}
