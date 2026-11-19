import { defineTypeBoxTool } from "@thinkrail/extension-api/server/typeBoxTool";
import { Type } from "typebox";
import { isValid, validateGraph } from "../core/index.ts";
import type { SpecToolServices } from "./shared.ts";
import { getIndex, textResult } from "./shared.ts";

const parameters = Type.Object({});

export function createSpecValidate(services: SpecToolServices) {
	return defineTypeBoxTool({
		name: "spec_validate",
		description:
			"Validate the spec-graph: report dangling parent/depends-on/references/implements links, duplicate ids, and parent cycles.",
		parameters,
		async execute() {
			services.assertActive();
			const report = validateGraph(getIndex(services.cwd).graph());
			if (isValid(report)) return textResult("Spec-graph is valid: no issues found.", report);

			const sections: string[] = [];
			if (report.duplicateIds.length) {
				sections.push(
					`Duplicate ids (${report.duplicateIds.length}):\n${report.duplicateIds
						.map((d) => `  ${d.id}: ${d.paths.join(", ")}`)
						.join("\n")}`,
				);
			}
			if (report.danglingLinks.length) {
				sections.push(
					`Dangling links (${report.danglingLinks.length}):\n${report.danglingLinks
						.map((d) => `  ${d.from} (${d.fromPath}) --${d.kind}--> ${d.target} [missing]`)
						.join("\n")}`,
				);
			}
			if (report.parentCycles.length) {
				sections.push(
					`Parent cycles (${report.parentCycles.length}):\n${report.parentCycles
						.map((c) => `  ${c.ids.join(" -> ")} -> ${c.ids[0]}`)
						.join("\n")}`,
				);
			}
			return textResult(sections.join("\n\n"), report);
		},
	});
}
