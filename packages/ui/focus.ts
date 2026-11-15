export const TABBABLE_SELECTOR = [
	"button:not(:disabled)",
	"a[href]",
	"input:not(:disabled)",
	"select:not(:disabled)",
	"textarea:not(:disabled)",
	'[contenteditable="true"]',
	'[tabindex]:not([tabindex="-1"])',
].join(",");

export function focusFirstControl(container: Element): boolean {
	const control = container.querySelector<HTMLElement>(TABBABLE_SELECTOR);
	if (
		!control?.isConnected ||
		control.getClientRects().length === 0 ||
		control.closest("[inert]") ||
		control.matches(":disabled")
	)
		return false;
	control.focus({ preventScroll: true });
	return true;
}

const MODAL_SELECTOR =
	'[aria-modal="true"], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

export function watchFocusIntent(request: AbortController): void {
	if (request.signal.aborted) return;
	const closingLayers = new Set(document.querySelectorAll(MODAL_SELECTOR));
	const cancel = () => request.abort();
	const onKeyDown = (event: KeyboardEvent) => {
		if (!event.repeat) cancel();
	};
	const checkLayers = () => {
		const layers = [...document.querySelectorAll(MODAL_SELECTOR)];
		for (const layer of closingLayers) if (!layers.includes(layer)) closingLayers.delete(layer);
		if (layers.some((layer) => !closingLayers.has(layer))) cancel();
	};
	const observer = new MutationObserver(checkLayers);
	observer.observe(document.body, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["aria-modal", "role", "data-state"],
	});
	request.signal.addEventListener(
		"abort",
		() => {
			observer.disconnect();
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("pointerdown", cancel, true);
			window.removeEventListener("blur", cancel);
		},
		{ once: true },
	);
	window.addEventListener("keydown", onKeyDown, true);
	window.addEventListener("pointerdown", cancel, true);
	window.addEventListener("blur", cancel);
}

export function whenFocusReady(
	attempt: () => boolean,
	frames: number,
	request: AbortController,
): void {
	if (request.signal.aborted) return;
	watchFocusIntent(request);
	let frame = 0;
	request.signal.addEventListener("abort", () => cancelAnimationFrame(frame), { once: true });
	const check = () => {
		if (request.signal.aborted) return;
		if (document.querySelector(MODAL_SELECTOR) === null && attempt()) {
			request.abort();
			return;
		}
		if (request.signal.aborted) return;
		if (frames-- > 0) frame = requestAnimationFrame(check);
		else request.abort();
	};
	frame = requestAnimationFrame(check);
}
