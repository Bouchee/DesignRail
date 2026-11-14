import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { NativeOpenFileRequest } from "@thinkrail/contracts";

const emitter = new EventEmitter();
mock.module("electrobun/main/events", () => ({ electrobunEventEmitter: emitter }));
const { deliverDeepLinkWhenReady } = await import("./deepLinkBootstrap");

const openUrl = (url: string) => emitter.emit("open-url", { data: { url } });

test("holds cold-launch links until delivery is ready, then forwards later ones directly", () => {
	openUrl("raildesign://open?file=/repo/a.ts&line=2");
	openUrl("https://example.com/?file=/repo/b.ts");
	openUrl("raildesign://open?file=/repo/../etc/passwd");
	openUrl("raildesign://open?file=/repo/c.ts");
	const delivered: NativeOpenFileRequest[] = [];
	deliverDeepLinkWhenReady((request) => delivered.push(request));
	expect(delivered).toEqual([
		{ file: "/repo/a.ts", line: 2 },
		{ file: "/repo/c.ts", line: 1 },
	]);
	openUrl("raildesign://open?file=/repo/d.ts&line=9&column=4");
	expect(delivered.at(-1)).toEqual({ file: "/repo/d.ts", line: 9, column: 4 });
	expect(delivered).toHaveLength(3);
});
