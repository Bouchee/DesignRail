import { isAbsolute, win32 } from "node:path";
import {
	isWindowsDeviceName,
	NATIVE_OPEN_FILE_LIMITS,
	type NativeOpenFileRequest,
} from "@thinkrail/contracts";

const MAX_URL_LENGTH = 8 * 1024;
const PARAMS = new Set(["file", "line", "column"]);

function positiveInteger(value: string): number | null {
	if (!/^\d{1,7}$/.test(value)) return null;
	const parsed = Number(value);
	return parsed > 0 && parsed <= NATIVE_OPEN_FILE_LIMITS.position ? parsed : null;
}

function queryParams(search: string): Map<string, string> | null {
	const params = new Map<string, string>();
	for (const pair of search.slice(1).split("&")) {
		const separator = pair.indexOf("=");
		const name = separator === -1 ? pair : pair.slice(0, separator);
		if (!PARAMS.has(name)) continue;
		if (separator === -1 || params.has(name)) return null;
		try {
			params.set(name, decodeURIComponent(pair.slice(separator + 1)));
		} catch {
			return null;
		}
	}
	return params;
}

function acceptablePath(file: string | undefined): file is string {
	if (file === undefined) return false;
	const windowsPath = /^(?:[A-Za-z]:[/\\]|[/\\]{2})/.test(file);
	const tail = windowsPath ? file.slice(win32.parse(file).root.length) : "";
	return (
		file.length > 0 &&
		file.length <= NATIVE_OPEN_FILE_LIMITS.fileLength &&
		!/\p{Cc}/u.test(file) &&
		(isAbsolute(file) || win32.isAbsolute(file)) &&
		!/^\\(?!\\)/.test(file) &&
		(!/^[/\\]{2}/.test(file) || /^[/\\]{2}[^/\\]+[/\\][^/\\]+(?:[/\\]|$)/.test(file)) &&
		!file.split(/[\\/]/).includes("..") &&
		!/^[/\\]{2}[?.][/\\]|^[/\\]\?\?[/\\]/.test(file) &&
		!tail.split(/[\\/]/).some((part) => isWindowsDeviceName(part.split(":")[0] ?? ""))
	);
}

export function parseDesignRailDeepLink(raw: string): NativeOpenFileRequest | null {
	if (
		typeof raw !== "string" ||
		raw.length === 0 ||
		raw.length > MAX_URL_LENGTH ||
		/\p{Cc}/u.test(raw)
	)
		return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "raildesign:" || url.host !== "open" || url.username || url.password) {
		return null;
	}
	if ((url.pathname !== "" && url.pathname !== "/") || url.hash !== "") return null;
	const params = queryParams(url.search);
	const file = params?.get("file");
	if (!params || !acceptablePath(file)) return null;
	const rawLine = params.get("line");
	const line = rawLine === undefined ? 1 : positiveInteger(rawLine);
	const rawColumn = params.get("column");
	const column = rawColumn === undefined ? undefined : positiveInteger(rawColumn);
	if (line === null || column === null) return null;
	return { file, line, ...(column === undefined ? {} : { column }) };
}
