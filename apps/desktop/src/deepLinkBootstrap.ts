import type { NativeOpenFileRequest } from "@thinkrail/contracts";
import type Electrobun from "electrobun/main";
import { electrobunEventEmitter } from "electrobun/main/events";
import { parseDesignRailDeepLink } from "./deepLink";

const earlyDeepLinks: NativeOpenFileRequest[] = [];
let deliverDeepLink: ((request: NativeOpenFileRequest) => void) | null = null;

// Must evaluate before `electrobun/main` — see electrobun-compatibility.md.
electrobunEventEmitter.on(
	"open-url",
	(event: ReturnType<typeof Electrobun.events.events.app.openUrl>) => {
		const request = parseDesignRailDeepLink(event.data.url);
		if (!request) return;
		if (deliverDeepLink) deliverDeepLink(request);
		else earlyDeepLinks.push(request);
	},
);

export function deliverDeepLinkWhenReady(callback: (request: NativeOpenFileRequest) => void): void {
	deliverDeepLink = callback;
	for (const request of earlyDeepLinks.splice(0)) callback(request);
}
