import { focusFirstControl, whenFocusReady } from "@thinkrail/ui/focus";

const CARD_FRAMES = 30;

export function commentCard(root: ParentNode, commentId: string): HTMLElement | undefined {
	return Array.from(root.querySelectorAll<HTMLElement>("[data-comment-id]")).find(
		(element) => element.dataset.commentId === commentId,
	);
}

export function revealReviewCard(
	scrollTarget: Element,
	moveFocus: boolean,
	focusTarget: Element = scrollTarget,
): boolean {
	scrollTarget.scrollIntoView({ block: "center" });
	return !moveFocus || focusFirstControl(focusTarget);
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
			if (!card || !focusFirstControl(card)) return false;
			onFocused?.();
			return true;
		},
		CARD_FRAMES,
		request,
	);
	return () => request.abort();
}
