import { assistantToolCallsAreExecutable } from "@thinkrail/contracts";
import { MCP_TOOL_PREFIX, readMcpToolDetails } from "./tools/mcp/mcpResult";
import type { ChatTurn, ToolResultState } from "./types";

const MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set([
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
]);

export interface McpServerCall {
	toolCallId: string;
	toolName: string;
	tool: string;
	args: Record<string, unknown>;
	result: ToolResultState | undefined;
	dead: boolean;
	streaming: boolean;
	at: number;
}

function ownerByToolName(
	toolName: string,
	servers: readonly string[],
): { server: string; tool: string } | null {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(toolName)) return null;
	const owners = servers
		.map((server) => ({ server, prefix: `${MCP_TOOL_PREFIX}${server.replace(/-/g, "_")}__` }))
		.filter(({ prefix }) => toolName.startsWith(prefix));
	const [owner] = owners;
	return owner && owners.length === 1
		? { server: owner.server, tool: toolName.slice(owner.prefix.length) }
		: null;
}

function callServer(
	toolName: string,
	args: Record<string, unknown>,
	result: unknown,
	servers: readonly string[],
): { server: string; tool: string } | null {
	if (toolName.startsWith(MCP_TOOL_PREFIX)) {
		const details = readMcpToolDetails(result);
		return details?.server
			? { server: details.server, tool: details.tool }
			: ownerByToolName(toolName, servers);
	}
	if (!MCP_RESOURCE_TOOLS.has(toolName)) return null;
	const details = readMcpToolDetails(result);
	const server = details ? details.server : typeof args.server === "string" ? args.server : "";
	return { server, tool: toolName };
}

export function mcpServerCalls(
	turns: readonly ChatTurn[],
	toolResults: Readonly<Record<string, ToolResultState>>,
	server: string,
	servers: readonly string[],
): McpServerCall[] {
	const calls: McpServerCall[] = [];
	for (const turn of turns) {
		if (turn.kind !== "assistant") continue;
		const { message } = turn;
		const dead = !assistantToolCallsAreExecutable(message.stopReason);
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const result = toolResults[block.id];
			const title = callServer(block.name, block.arguments, result?.raw, servers);
			if (!title || title.server !== server) continue;
			calls.push({
				toolCallId: block.id,
				toolName: block.name,
				tool: title.tool,
				args: block.arguments,
				result,
				dead,
				streaming: turn.streaming,
				at: message.timestamp,
			});
		}
	}
	return calls.reverse();
}
