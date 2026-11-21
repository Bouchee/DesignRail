import { watchFocusIntent, whenFocusReady } from "@thinkrail/ui/focus";
import { isNavigationChange, useAppStore } from "../store";

function focusRequest(isCurrent: () => boolean = () => true): AbortController {
	const request = new AbortController();
	const unsubscribe = useAppStore.subscribe((state, previous) => {
		if (isNavigationChange(state, previous) || !isCurrent()) request.abort();
	});
	request.signal.addEventListener("abort", unsubscribe, { once: true });
	return request;
}

export function focusWhenRevealed(
	find: () => HTMLElement | null | undefined,
	scope: Element,
): () => void {
	const request = focusRequest();
	whenFocusReady(
		() => {
			if (!scope.isConnected) {
				request.abort();
				return false;
			}
			const target = find();
			if (
				!target?.isConnected ||
				target.getClientRects().length === 0 ||
				target.closest("[inert]") ||
				target.matches(":disabled")
			)
				return false;
			target.focus({ preventScroll: true });
			return document.activeElement === target;
		},
		60,
		request,
	);
	return () => request.abort();
}

export function clearOwnedReviewFocus(
	owned: NonNullable<ReturnType<typeof useAppStore.getState>["reviewFocusRequest"]>,
): void {
	const state = useAppStore.getState();
	if (state.reviewFocusRequest === owned) state.clearReviewFocus(owned.commentId);
}

export function guardReviewFocus(
	owned: NonNullable<ReturnType<typeof useAppStore.getState>["reviewFocusRequest"]>,
): () => void {
	const request = focusRequest(() => useAppStore.getState().reviewFocusRequest === owned);
	request.signal.addEventListener(
		"abort",
		() => {
			clearOwnedReviewFocus(owned);
		},
		{ once: true },
	);
	watchFocusIntent(request);
	if (useAppStore.getState().reviewFocusRequest !== owned) request.abort();
	return () => request.abort();
}

export function guardComposerFocus(
	owned: NonNullable<ReturnType<typeof useAppStore.getState>["composerFocusRequest"]>,
): void {
	const request = focusRequest(() => useAppStore.getState().composerFocusRequest === owned);
	request.signal.addEventListener(
		"abort",
		() => {
			const state = useAppStore.getState();
			if (state.composerFocusRequest === owned) state.clearComposerFocusRequest();
		},
		{ once: true },
	);
	watchFocusIntent(request);
	if (useAppStore.getState().composerFocusRequest !== owned) request.abort();
}
