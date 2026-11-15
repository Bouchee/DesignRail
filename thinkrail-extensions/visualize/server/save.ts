import type { WorkspaceFiles } from "@thinkrail/extension-api/server";
import type { VisualizeParams } from "@thinkrail/visualize";

const SLUG_MAX = 48;
const MAX_ATTEMPTS = 99;

function two(value: number): string {
	return String(value).padStart(2, "0");
}

export function visualizationStamp(date: Date): string {
	const day = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`;
	return `${day}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

export function visualizationSlug(params: VisualizeParams): string {
	const slug = (params.title ?? "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.slice(0, SLUG_MAX)
		.replace(/^-+|-+$/g, "");
	return slug || params.type;
}

export async function saveVisualization(
	files: WorkspaceFiles,
	params: VisualizeParams,
	markdown: string,
	now = new Date(),
): Promise<string> {
	const base = `${visualizationStamp(now)}-${visualizationSlug(params)}`;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const name = attempt === 1 ? `${base}.md` : `${base}-${attempt}.md`;
		try {
			return await files.createArtifact(name, `${markdown}\n`);
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
				throw error;
		}
	}
	throw new Error("No free name for the saved visualization");
}
