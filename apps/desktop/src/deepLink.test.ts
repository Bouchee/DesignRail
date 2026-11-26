import { expect, test } from "bun:test";
import { parseDesignRailDeepLink } from "./deepLink";

test("parses a file path, line and column", () => {
	expect(
		parseDesignRailDeepLink(
			"raildesign://open?file=/Users/me/thinkrail/apps/web/src/main.tsx&line=12&column=3",
		),
	).toEqual({ file: "/Users/me/thinkrail/apps/web/src/main.tsx", line: 12, column: 3 });
});

test("defaults line to 1 and keeps column optional", () => {
	expect(parseDesignRailDeepLink("raildesign://open?file=/repo/src/a.ts")).toEqual({
		file: "/repo/src/a.ts",
		line: 1,
	});
	expect(parseDesignRailDeepLink("raildesign://open/?file=/repo/src/a.ts&line=7")).toEqual({
		file: "/repo/src/a.ts",
		line: 7,
	});
});

test("decodes percent-encoded and unencoded paths without turning + into a space", () => {
	expect(parseDesignRailDeepLink("raildesign://open?file=/repo/a%20b/c.tsx&line=2")).toEqual({
		file: "/repo/a b/c.tsx",
		line: 2,
	});
	expect(parseDesignRailDeepLink("raildesign://open?file=/repo/routes/+page.svelte")).toEqual({
		file: "/repo/routes/+page.svelte",
		line: 1,
	});
	expect(parseDesignRailDeepLink("raildesign://open?file=/repo/проект/a b.ts")).toEqual({
		file: "/repo/проект/a b.ts",
		line: 1,
	});
	expect(parseDesignRailDeepLink("raildesign://open?file=/repo/a%2Bb.ts&line=3")).toEqual({
		file: "/repo/a+b.ts",
		line: 3,
	});
});

test("accepts Windows absolute paths and ignores unknown parameters", () => {
	expect(parseDesignRailDeepLink("raildesign://open?file=C%3A%5Crepo%5Csrc%5Ca.ts&line=4")).toEqual(
		{
			file: "C:\\repo\\src\\a.ts",
			line: 4,
		},
	);
	expect(parseDesignRailDeepLink("raildesign://open?file=/repo/a.ts&source=locator")).toEqual({
		file: "/repo/a.ts",
		line: 1,
	});
	expect(
		parseDesignRailDeepLink(
			`raildesign://open?file=${encodeURIComponent("\\\\server\\share\\repo\\a.ts")}`,
		),
	).toEqual({
		file: "\\\\server\\share\\repo\\a.ts",
		line: 1,
	});
});

test("rejects other schemes, hosts, paths and URL parts", () => {
	const invalid = [
		"",
		"https://open?file=/repo/src/a.ts",
		"file:///repo/src/a.ts",
		"thinkrail://open?file=/repo/src/a.ts",
		"raildesign:\n//open?file=/repo/src/a.ts",
		"raildesign://other?file=/repo/src/a.ts",
		"raildesign://open:80?file=/repo/src/a.ts",
		"raildesign://user@open?file=/repo/src/a.ts",
		"raildesign://open/run?file=/repo/src/a.ts",
		"raildesign://open?file=/repo/src/a.ts#L3",
		`raildesign://open?file=/repo/${"a".repeat(9000)}.ts`,
	];
	for (const raw of invalid) expect(parseDesignRailDeepLink(raw)).toBeNull();
});

test("rejects Windows device namespaces before any path can reach the host", () => {
	for (const file of [
		"\\\\?\\C:\\repo\\a.ts",
		"\\\\.\\C:\\repo\\a.ts",
		"\\??\\C:\\repo\\a.ts",
		"//?/UNC/server/share/a.ts",
		"//./PhysicalDrive0",
		"\\\\server",
		"\\repo\\a.ts",
		"//server",
	]) {
		expect(
			parseDesignRailDeepLink(`raildesign://open?file=${encodeURIComponent(file)}`),
		).toBeNull();
	}
});

test("rejects DOS device aliases only in Windows filename components", () => {
	for (const file of [
		"C:\\repo\\COM1",
		"C:\\repo\\NUL.txt",
		"C:\\repo\\CON:stream",
		"\\\\server\\share\\LPT¹.txt",
	]) {
		expect(
			parseDesignRailDeepLink(`raildesign://open?file=${encodeURIComponent(file)}`),
		).toBeNull();
	}
	for (const file of ["/repo/CON", "\\\\aux\\share\\repo\\a.ts"]) {
		expect(parseDesignRailDeepLink(`raildesign://open?file=${encodeURIComponent(file)}`)).toEqual({
			file,
			line: 1,
		});
	}
});

test("rejects relative, escaping, ambiguous and malformed file paths", () => {
	const invalid = [
		"raildesign://open?file=src/a.ts",
		"raildesign://open?file=",
		"raildesign://open?file",
		"raildesign://open?line=3",
		"raildesign://open?file=/repo/../etc/passwd",
		"raildesign://open?file=/repo/%2E%2E/etc/passwd",
		"raildesign://open?file=C%3A%5Crepo%5C..%5Csecret.txt",
		"raildesign://open?file=/repo/a.ts%00.png",
		"raildesign://open?file=/repo/a%0A.ts",
		"raildesign://open?file=/repo/100%.ts",
		"raildesign://open?file=/repo/a.ts&file=/etc/passwd",
		`raildesign://open?file=/${"a".repeat(4100)}`,
	];
	for (const raw of invalid) expect(parseDesignRailDeepLink(raw)).toBeNull();
});

test("rejects malformed, zero, negative and huge positions", () => {
	const invalid = [
		"raildesign://open?file=/repo/src/a.ts&line=0",
		"raildesign://open?file=/repo/src/a.ts&line=-1",
		"raildesign://open?file=/repo/src/a.ts&line=1.5",
		"raildesign://open?file=/repo/src/a.ts&line=1e3",
		"raildesign://open?file=/repo/src/a.ts&line=",
		"raildesign://open?file=/repo/src/a.ts&line=2000001",
		"raildesign://open?file=/repo/src/a.ts&line=99999999999999999999",
		"raildesign://open?file=/repo/src/a.ts&line=3&line=4",
		"raildesign://open?file=/repo/src/a.ts&column=0",
		"raildesign://open?file=/repo/src/a.ts&column=x",
	];
	for (const raw of invalid) expect(parseDesignRailDeepLink(raw)).toBeNull();
	expect(parseDesignRailDeepLink("raildesign://open?file=/repo/a.ts&line=2000000")).toEqual({
		file: "/repo/a.ts",
		line: 2_000_000,
	});
});
