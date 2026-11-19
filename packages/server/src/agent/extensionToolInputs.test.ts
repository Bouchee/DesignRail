import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@openai/agents";
import visualize from "@thinkrail/ext-visualize/server";
import type { SdkToolServices } from "@thinkrail/extension-api/server";
import { createSpecTools } from "@thinkrail/spec-graph";
import { createTodoTools } from "@thinkrail/todos";
import { TodoStore } from "@thinkrail/todos/core";

test("extension tool schemas reject invalid input before the registered SDK execute callback", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "raildesign-tool-inputs-"));
	const counts = new Map<string, number>();
	const original = sdk.tool;
	const probe = spyOn(sdk, "tool").mockImplementation(
		new Proxy(original, {
			apply(target, receiver, [options]) {
				return Reflect.apply(target, receiver, [
					{
						...options,
						execute(...args: unknown[]) {
							counts.set(options.name, (counts.get(options.name) ?? 0) + 1);
							return Reflect.apply(options.execute, this, args);
						},
					},
				]);
			},
		}),
	);
	try {
		const services = {
			cwd,
			sessionId: "tool-inputs",
			assertActive: () => {},
		};
		const plan = new TodoStore(cwd, services.sessionId);
		const step = plan.add({ title: "Update then remove" });
		const loose = plan.add({ title: "Promote", origin: "user" });
		writeFileSync(
			join(cwd, "SPEC.md"),
			"---\nid: root\ntype: module-design\ntitle: Fixture\n---\n\n# Fixture\n\nProbe needle.\n",
		);
		const checked: string[] = [];
		const unavailable = async () => {
			throw new Error("Unused fixture service");
		};
		const visuals = {
			...services,
			webAccess: { search: unavailable, fetch: unavailable },
			toolResponse: () => ({ kind: "deferred" }),
			setting: () => false,
			workspaceFiles: {
				check: async (path) => {
					checked.push(path);
				},
				createArtifact: unavailable,
				scratchDir: ".raildesign/context/mockups/",
				artifactsDir: ".raildesign/context/",
			},
		} satisfies SdkToolServices;
		const tools = [
			...createTodoTools(services),
			...createSpecTools(services),
			...visualize.sdkTools(visuals),
		];
		const inputs = {
			todo_list: { valid: { extra: true }, invalid: { offset: -1 } },
			todo_add: { valid: { title: "Added" }, invalid: {} },
			todo_update: { valid: { id: step.id, title: "Updated" }, invalid: { id: false } },
			todo_remove: { valid: { id: step.id }, invalid: {} },
			todo_promote: { valid: { id: loose.id }, invalid: { id: [], title: "Wrong" } },
			todo_write: {
				valid: { groups: [{ title: "Plan", todos: [{ title: "One" }] }] },
				invalid: { groups: [{ title: "Plan", todos: [{ title: 1 }] }] },
			},
			todo_plan_summary: { valid: { summary: "Application checked." }, invalid: { summary: null } },
			spec_grep: { valid: { pattern: "needle" }, invalid: { pattern: 12 } },
			spec_search: { valid: { query: ["needle"] }, invalid: { query: [false] } },
			spec_get: { valid: { id: "root" }, invalid: {} },
			spec_graph: {
				valid: { root: "root", direction: "subtree" },
				invalid: { root: "root", direction: "wrong" },
			},
			spec_create: {
				valid: { path: "child/SPEC.md", id: "child", type: "module-design", title: "Child" },
				invalid: {
					path: "child/SPEC.md",
					id: "child",
					type: "module-design",
					title: "Child",
					tags: [false],
				},
			},
			spec_update: { valid: { id: "child", set: { title: "Updated child" } }, invalid: { id: 2 } },
			spec_delete: { valid: { id: "child" }, invalid: {} },
			spec_validate: { valid: {}, invalid: null },
			visualize: { valid: { type: "file", path: "SPEC.md" }, invalid: { type: "file", path: [] } },
		};
		const fixtures = new Map(Object.entries(inputs));
		expect(tools.map(({ name }) => name).sort()).toEqual([...fixtures.keys()].sort());
		const snapshot = () =>
			readdirSync(cwd, { recursive: true }).map((entry) => {
				const file = join(cwd, String(entry));
				return [entry, statSync(file).isFile() ? readFileSync(file, "utf8") : null];
			});
		const before = snapshot();
		const context = new sdk.RunContext();
		for (const tool of tools) {
			const fixture = fixtures.get(tool.name);
			if (!fixture) throw new Error(`Missing fixture: ${tool.name}`);
			expect(tool.strict).toBe(false);
			expect(tool.parameters.additionalProperties).toBe(true);
			const message =
				tool.name === "visualize" ? "Invalid visualization arguments" : "Invalid tool arguments";
			await expect(tool.invoke(context, "[]")).rejects.toThrow(message);
			await expect(tool.invoke(context, JSON.stringify(fixture.invalid))).rejects.toThrow(message);
			await expect(tool.invoke(context, "{")).rejects.toThrow("Invalid JSON input for tool");
			await expect(tool.invoke(context, "")).rejects.toThrow("Invalid JSON input for tool");
			expect(counts.get(tool.name) ?? 0).toBe(0);
		}
		expect(snapshot()).toEqual(before);
		expect(checked).toEqual([]);
		for (const [name, { valid }] of fixtures) {
			const tool = tools.find((tool) => tool.name === name);
			if (!tool) throw new Error(`Missing tool: ${name}`);
			const result = await tool.invoke(context, JSON.stringify(valid));
			expect(counts.get(name)).toBe(1);
			expect(result).not.toHaveProperty("isError", true);
			expect(result).toHaveProperty("content");
		}
		expect(checked).toEqual(["SPEC.md"]);
		expect(plan.read().summary).toBe("Application checked.");
	} finally {
		probe.mockRestore();
		rmSync(cwd, { recursive: true, force: true });
	}
});
