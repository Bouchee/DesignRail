import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentInputItem } from "@openai/agents";
import { z } from "zod";
import { type AgentDefinition, discoverAgentDefinitions } from "./childDefinitions";

export const HANDOFF_ROOT = "$root";
export const ROOT_AGENT_NAME = "RailDesign";

export type HandoffHistory = "all" | "without_tools";

export interface HandoffGraphSnapshot {
	version: 1;
	source: { scope: "personal" | "project"; path: string };
	rootTargets: string[];
	nodes: { definition: AgentDefinition; targets: string[]; history: HandoffHistory }[];
}

const documentSchema = z.strictObject({
	version: z.literal(1),
	rootTargets: z.array(z.string().min(1)).min(1),
	agents: z.array(
		z.strictObject({
			definition: z.string().min(1),
			targets: z.array(z.string().min(1)),
			history: z.enum(["all", "without_tools"]),
		}),
	),
});

export function handoffTargets(graph: HandoffGraphSnapshot, node: string): string[] | undefined {
	return node === HANDOFF_ROOT
		? graph.rootTargets
		: graph.nodes.find((item) => item.definition.name === node)?.targets;
}

export function handoffHistory(graph: HandoffGraphSnapshot, node: string): HandoffHistory {
	return graph.nodes.find((item) => item.definition.name === node)?.history ?? "all";
}

/**
 * The `without_tools` model view: drops tool call/result pairs except `ownCalls`, the reasoning that
 * opens a dropped call, and summaries not proven tool-free. Kept items retain their object identity.
 */
export function withoutToolHistory(
	items: AgentInputItem[],
	ownCalls: ReadonlySet<string>,
	toolFreeSummary: (operationId: string) => boolean,
): AgentInputItem[] {
	const dropped = (item: AgentInputItem | undefined) =>
		(item?.type === "function_call" || item?.type === "function_call_result") &&
		!ownCalls.has(item.callId);
	return items.filter((item, index) => {
		if (dropped(item)) return false;
		if (item.type === "reasoning") {
			const next = items.slice(index + 1).find((candidate) => candidate.type !== "reasoning");
			return !(next?.type === "function_call" && dropped(next));
		}
		const id = "role" in item && item.role === "user" ? item.id : undefined;
		return !id?.startsWith("summary_") || toolFreeSummary(id.slice("summary_".length));
	});
}

export function resolveHandoffGraph(
	text: string,
	definitions: readonly AgentDefinition[],
	source: HandoffGraphSnapshot["source"],
): HandoffGraphSnapshot {
	const fail = (reason: string): never => {
		throw new Error(`Invalid handoff configuration ${source.path}: ${reason}`);
	};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return fail("not valid JSON");
	}
	const result = documentSchema.safeParse(parsed);
	if (!result.success) return fail(result.error.issues[0]?.message ?? "invalid document");
	const document = result.data;
	const ids = new Set<string>();
	for (const { definition } of document.agents) {
		if (definition === HANDOFF_ROOT) fail(`"${HANDOFF_ROOT}" is reserved for the chat agent`);
		if (definition === ROOT_AGENT_NAME) fail(`"${ROOT_AGENT_NAME}" is the chat agent's name`);
		if (ids.has(definition)) fail(`agent "${definition}" is declared twice`);
		ids.add(definition);
	}
	const checkTargets = (from: string, targets: readonly string[]) => {
		if (new Set(targets).size !== targets.length) fail(`"${from}" lists a target twice`);
		for (const target of targets) {
			if (target === from) fail(`"${from}" cannot transfer to itself`);
			if (target !== HANDOFF_ROOT && !ids.has(target))
				fail(`"${from}" targets undeclared agent "${target}"`);
		}
	};
	checkTargets(HANDOFF_ROOT, document.rootTargets);
	const nodes = document.agents.map((node) => {
		checkTargets(node.definition, node.targets);
		const definition = definitions.find((item) => item.name === node.definition);
		if (!definition) return fail(`agent definition "${node.definition}" is unavailable`);
		return {
			definition: structuredClone(definition),
			targets: node.targets,
			history: node.history,
		};
	});
	const reached = new Set([HANDOFF_ROOT]);
	const pending = [...document.rootTargets];
	for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
		if (reached.has(next)) continue;
		reached.add(next);
		pending.push(...(document.agents.find((node) => node.definition === next)?.targets ?? []));
	}
	for (const id of ids) if (!reached.has(id)) fail(`agent "${id}" is not reachable from the chat`);
	return { version: 1, source, rootTargets: document.rootTargets, nodes };
}

/** A trusted project document replaces the personal one; absent documents supply no Handoffs. */
export function loadHandoffGraph(options: {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}): HandoffGraphSnapshot | undefined {
	const sources: HandoffGraphSnapshot["source"][] = [
		...(options.projectTrusted
			? [{ scope: "project" as const, path: join(options.cwd, ".raildesign", "handoffs.json") }]
			: []),
		{ scope: "personal", path: join(options.agentDir, "handoffs.json") },
	];
	for (const source of sources) {
		let text: string;
		try {
			text = readFileSync(source.path, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		return resolveHandoffGraph(
			text,
			discoverAgentDefinitions({
				cwd: options.cwd,
				agentDir: options.agentDir,
				includeProject: options.projectTrusted,
			}),
			source,
		);
	}
	return undefined;
}
