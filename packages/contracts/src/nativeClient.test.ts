import { expect, test } from "bun:test";
import { isNativeOpenFileRequest } from "./nativeClient";

test("native file requests retain bounded one-based positions and literal paths", () => {
	for (const value of [
		{ file: "/repo/+page.svelte", line: 1 },
		{ file: "C:\\repo\\a.ts", line: 2_000_000, column: 3 },
	])
		expect(isNativeOpenFileRequest(value)).toBe(true);
	for (const value of [
		null,
		[],
		{},
		{ file: 7, line: 1 },
		{ file: "", line: 1 },
		{ file: "/a\n.ts", line: 1 },
		{ file: "/".repeat(4097), line: 1 },
		{ file: "/a.ts", line: "1" },
		{ file: "/a.ts", line: 0 },
		{ file: "/a.ts", line: Infinity },
		{ file: "/a.ts", line: 1.5 },
		{ file: "/a.ts", line: 2_000_001 },
		{ file: "/a.ts", line: 1, column: null },
		{ file: "/a.ts", line: 1, column: -2 },
	])
		expect(isNativeOpenFileRequest(value)).toBe(false);
});
