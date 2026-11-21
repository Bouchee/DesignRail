import { defineServerExtension } from "@thinkrail/extension-api/server";
import { defineTypeBoxTool } from "@thinkrail/extension-api/server/typeBoxTool";
import {
	comparisonMarkdown,
	fileMarkdown,
	fileSources,
	mermaidFence,
	mermaidSources,
	VisualizeSchema,
	validateShape,
} from "@thinkrail/visualize";
import { strictMermaidValidator } from "./mermaid";
import { saveVisualization } from "./save";

function presentedPaths(args: unknown, details: unknown): string[] {
	if (
		args &&
		typeof args === "object" &&
		"type" in args &&
		args.type === "file" &&
		"path" in args &&
		typeof args.path === "string"
	) {
		return [
			args.path,
			...("before" in args && typeof args.before === "string" ? [args.before] : []),
		];
	}
	if (
		details &&
		typeof details === "object" &&
		"savedPath" in details &&
		typeof details.savedPath === "string"
	)
		return [details.savedPath];
	return [];
}

export default defineServerExtension({
	name: "visualize",
	title: "Visualize",
	description:
		"Lets the agent draw Mermaid diagrams, side-by-side option comparisons, and rendered file previews or before/after mockups in chat.",
	artifactTools: { visualize: { presented: presentedPaths } },
	sdkTools: (session) => [
		defineTypeBoxTool({
			name: "visualize",
			description: `Show a rich visualization. Use type 'diagram' with raw Mermaid source, 'comparison' with named options and pros/cons, or 'file' with an existing workspace-relative path. Set 'before' to another file for a before/after comparison. For UI proposals, write self-contained HTML mockups under \`${session.workspaceFiles.scratchDir}\` with inline CSS, inline scripts and data images only. Browser mockups can run scripts without network access. Desktop previews are static, so keep a useful static view. Diagrams and comparisons are also saved as Markdown artifacts in \`${session.workspaceFiles.artifactsDir}visualize/\`. File previews use the current file contents; copy a file to preserve an earlier proposal.`,
			parameters: VisualizeSchema,
			invalidArgumentsMessage: "Invalid visualization arguments",
			async execute(params) {
				session.assertActive();
				validateShape(params);
				for (const { location, source } of mermaidSources(params)) {
					try {
						await strictMermaidValidator(source);
					} catch (error) {
						throw new Error(
							`visualize: invalid Mermaid syntax in \`${location}\`: ${error instanceof Error ? error.message : String(error)}\nCorrect the syntax and call \`visualize\` again.`,
						);
					}
				}
				for (const { location, path } of fileSources(params)) {
					try {
						await session.workspaceFiles.check(path, session.cwd);
					} catch (error) {
						throw new Error(
							`visualize: cannot show \`${location}\` (${path}): ${error instanceof Error ? error.message : String(error)}\nWrite the file first, then call \`visualize\` again.`,
						);
					}
				}
				session.assertActive();
				const text =
					params.type === "diagram"
						? mermaidFence(params.title, params.mermaid ?? "")
						: params.type === "file"
							? fileMarkdown(params)
							: comparisonMarkdown(params.title, params.options ?? []);
				let savedPath: string | null = null;
				if (params.type !== "file") {
					try {
						savedPath = await saveVisualization(session.workspaceFiles, params, text);
					} catch {}
				}
				session.assertActive();
				return {
					content: [
						{ type: "text", text: savedPath ? `${text}\n\nSaved to \`${savedPath}\`.` : text },
					],
					details: savedPath ? { ...params, savedPath } : params,
				};
			},
		}),
	],
});
