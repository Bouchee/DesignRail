import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentInputItem } from "@openai/agents";
import type { AgentDefinition } from "./childDefinitions";
import {
	handoffHistory,
	loadHandoffGraph,
	resolveHandoffGraph,
	withoutToolHistory,
} from "./handoffGraph";

let root: string, cwd: string, agentDir: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "raildesign-handoffs-"));
	cwd = join(root, "project");
	agentDir = join(root, "data");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function write(path: string, content: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}
const definition = (name: string): AgentDefinition => ({
	name,
	description: `${name} role`,
	source: "personal",
	systemPrompt: `You are ${name}.`,
});
const source = { scope: "personal" as const, path: "/handoffs.json" };
const resolve = (document: unknown, names = ["analyst", "builder"]) =>
	resolveHandoffGraph(JSON.stringify(document), names.map(definition), source);
const graph = {
	version: 1,
	rootTargets: ["analyst"],
	agents: [
		{ definition: "analyst", targets: ["builder", "$root"], history: "all" },
		{ definition: "builder", targets: ["$root"], history: "without_tools" },
	],
};

test("a valid graph resolves definition data, edges and policies", () => {
	const resolved = resolve(graph);
	expect(resolved.rootTargets).toEqual(["analyst"]);
	expect(
		resolved.nodes.map((node) => [node.definition.systemPrompt, node.targets, node.history]),
	).toEqual([
		["You are analyst.", ["builder", "$root"], "all"],
		["You are builder.", ["$root"], "without_tools"],
	]);
});

test("history policy is defined for the root and declared nodes only", () => {
	const resolved = resolve(graph);
	expect(handoffHistory(resolved, "$root")).toBe("all");
	expect(handoffHistory(resolved, "builder")).toBe("without_tools");
	expect(() => handoffHistory(resolved, "ghost")).toThrow('no agent "ghost"');
});

test.each([
	["malformed JSON", "{", "not valid JSON"],
	["unknown version", { ...graph, version: 2 }, "Invalid"],
	["unknown keys", { ...graph, extra: true }, "Unrecognized"],
	[
		"unknown history policy",
		{ ...graph, agents: [{ ...graph.agents[0], history: "x" }] },
		"Invalid",
	],
	["empty root targets", { ...graph, rootTargets: [] }, "Invalid handoff configuration"],
	[
		"reserved root ID",
		{ ...graph, agents: [...graph.agents, { definition: "$root", targets: [], history: "all" }] },
		"reserved",
	],
	[
		"chat agent name",
		{
			...graph,
			agents: [...graph.agents, { definition: "DesignRail", targets: [], history: "all" }],
		},
		"chat agent's name",
	],
	["duplicate node", { ...graph, agents: [...graph.agents, graph.agents[1]] }, "declared twice"],
	["undeclared target", { ...graph, rootTargets: ["missing"] }, "undeclared agent"],
	["self transfer", { ...graph, rootTargets: ["$root"] }, "itself"],
	["repeated target", { ...graph, rootTargets: ["analyst", "analyst"] }, "twice"],
	[
		"unreachable node",
		{
			...graph,
			rootTargets: ["builder"],
			agents: [graph.agents[1], { definition: "analyst", targets: [], history: "all" }],
		},
		"not reachable",
	],
])("%s is rejected", (_name, document, message) => {
	expect(() =>
		typeof document === "string"
			? resolveHandoffGraph(document, [definition("analyst"), definition("builder")], source)
			: resolve(document),
	).toThrow(message);
});

test("a declaration for a missing definition is rejected", () => {
	expect(() => resolve(graph, ["analyst"])).toThrow('agent definition "builder" is unavailable');
});

test("a trusted project graph replaces the personal graph; untrusted project files are ignored", () => {
	const agent = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nYou are ${name}.`;
	write(join(agentDir, "agents", "analyst.md"), agent("analyst"));
	write(join(cwd, ".raildesign", "agents", "local.md"), agent("local"));
	write(
		join(agentDir, "handoffs.json"),
		JSON.stringify({
			version: 1,
			rootTargets: ["analyst"],
			agents: [{ definition: "analyst", targets: [], history: "all" }],
		}),
	);
	write(
		join(cwd, ".raildesign", "handoffs.json"),
		JSON.stringify({
			version: 1,
			rootTargets: ["local"],
			agents: [{ definition: "local", targets: ["$root"], history: "all" }],
		}),
	);
	const trusted = loadHandoffGraph({ cwd, agentDir, projectTrusted: true });
	expect(trusted?.source.scope).toBe("project");
	expect(trusted?.nodes.map((node) => node.definition.name)).toEqual(["local"]);
	const revoked = loadHandoffGraph({ cwd, agentDir, projectTrusted: false });
	expect(revoked?.source.scope).toBe("personal");
	expect(revoked?.nodes.map((node) => node.definition.name)).toEqual(["analyst"]);
	expect(revoked).not.toEqual(trusted);
});

test("absent documents supply no graph and a malformed one is not replaced by another source", () => {
	expect(loadHandoffGraph({ cwd, agentDir, projectTrusted: true })).toBeUndefined();
	write(join(agentDir, "handoffs.json"), JSON.stringify(graph));
	write(join(cwd, ".raildesign", "handoffs.json"), "not json");
	expect(() => loadHandoffGraph({ cwd, agentDir, projectTrusted: true })).toThrow("not valid JSON");
});

test("a builtin definition can be a node without granting any default edge", () => {
	write(
		join(agentDir, "handoffs.json"),
		JSON.stringify({
			version: 1,
			rootTargets: ["scout"],
			agents: [{ definition: "scout", targets: [], history: "all" }],
		}),
	);
	const loaded = loadHandoffGraph({ cwd, agentDir, projectTrusted: false });
	expect(loaded?.nodes.map((node) => [node.definition.source, node.targets])).toEqual([
		["builtin", []],
	]);
});

test("without_tools drops foreign call pairs with their reasoning and unproven summaries", () => {
	const items: AgentInputItem[] = [
		{ type: "message", role: "user", id: "summary_tools", content: "S1" },
		{ type: "message", role: "user", id: "summary_plain", content: "S2" },
		{ type: "message", role: "user", id: "u1", content: "hello" },
		{ type: "reasoning", content: [] },
		{ type: "function_call", callId: "old", name: "bash", arguments: "{}" },
		{
			type: "function_call_result",
			callId: "old",
			name: "bash",
			output: "secret",
			status: "completed",
		},
		{ type: "reasoning", content: [] },
		{ type: "message", role: "assistant", status: "completed", content: [] },
		{ type: "function_call", callId: "own", name: "bash", arguments: "{}" },
		{
			type: "function_call_result",
			callId: "own",
			name: "bash",
			output: "mine",
			status: "completed",
		},
	];
	const view = withoutToolHistory(items, new Set(["own"]), (id) => id === "plain");
	expect(view).toEqual([
		items[1],
		items[2],
		items[6],
		items[7],
		items[8],
		items[9],
	] as AgentInputItem[]);
	expect(view[0]).toBe(items[1] as AgentInputItem);
});
