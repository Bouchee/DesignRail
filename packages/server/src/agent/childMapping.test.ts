import { expect, test } from "bun:test";
import { type AgentDefinition, parseAgentDefinition } from "./childDefinitions";
import { toSpawnMapping } from "./childMapping";

const worker: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	source: "builtin",
	systemPrompt: "Complete the assigned task.",
	thinking: "low",
};
const available = [
	{ provider: "provider-a", id: "alpha" },
	{ provider: "provider-b", id: "beta" },
];

for (const model of ["", " ", "\t\n"]) {
	test(`blank invocation ${JSON.stringify(model)} leaves model selection to the parent`, () => {
		for (const availableModels of [available, available.slice(0, 1), []]) {
			const mapped = toSpawnMapping(worker, { cwd: import.meta.dir, availableModels, model });
			expect(mapped.session).not.toHaveProperty("model");
			expect(mapped.session.thinkingLevel).toBe("low");
		}
	});
}

test("a definition pin wins over a blank or unknown invocation model", () => {
	for (const model of ["", " ", "\t\n", "missing"]) {
		const mapped = toSpawnMapping(
			{ ...worker, model: "provider-b/beta" },
			{ cwd: import.meta.dir, availableModels: available, model },
		);
		expect(mapped.session.model).toEqual({ provider: "provider-b", id: "beta" });
	}
});

test("an omitted model and parent-model words keep their existing inheritance behavior", () => {
	for (const model of [undefined, "inherit", "PARENT", "DeFaUlT"]) {
		expect(
			toSpawnMapping(worker, {
				cwd: import.meta.dir,
				availableModels: available,
				...(model === undefined ? {} : { model }),
			}).session,
		).not.toHaveProperty("model");
	}
});

test("nonblank references are resolved as written without trimming or silent fallback", () => {
	expect(
		toSpawnMapping(worker, {
			cwd: import.meta.dir,
			availableModels: available,
			model: "provider-a/alpha",
		}).session.model,
	).toEqual({ provider: "provider-a", id: "alpha" });
	for (const model of ["missing", " alpha", "alpha ", " inherit "]) {
		expect(() =>
			toSpawnMapping(worker, { cwd: import.meta.dir, availableModels: available, model }),
		).toThrow("is not available");
	}
	expect(() =>
		toSpawnMapping(
			{ ...worker, model: "provider-a/missing" },
			{ cwd: import.meta.dir, availableModels: available, model: "" },
		),
	).toThrow('pins model "provider-a/missing"');
});

test("a blank model field in a definition remains unpinned", () => {
	for (const field of ["model:\n", 'model: ""\n', "model: '  '\n"]) {
		const definition = parseAgentDefinition(
			`---\nname: worker\ndescription: Test worker\n${field}---\nComplete the assigned task.`,
			"personal",
		);
		expect(definition?.name).toBe("worker");
		expect(definition).not.toHaveProperty("model");
	}
});
