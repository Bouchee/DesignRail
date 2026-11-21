import { opensChatRound, type SessionEvent } from "@thinkrail/contracts";
import type { ArtifactSessionEvent } from "../artifacts";
import type { ArtifactTools } from "../extensions";
import { logger } from "../log";

const log = logger("host");

function readPaths(
	reader: (() => readonly string[] | undefined) | undefined,
): readonly string[] | undefined {
	try {
		return reader?.();
	} catch (error) {
		log.warn("artifact tool result could not be projected", error);
		return undefined;
	}
}

export function createArtifactEventMapper(tools: () => ArtifactTools) {
	const argsBySession = new Map<string, Map<string, unknown>>();
	return (sessionId: string, event: SessionEvent): ArtifactSessionEvent | null => {
		switch (event.type) {
			case "agent_start":
				return { type: event.type };
			case "agent_settled":
				argsBySession.delete(sessionId);
				return { type: event.type };
			case "message_end": {
				const { message } = event;
				if (opensChatRound(message) && Number.isFinite(message.timestamp))
					return { type: "round_start", at: message.timestamp };
				if (message.role !== "assistant") return null;
				const text = message.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("\n");
				return { type: "assistant_message", text };
			}
			case "tool_execution_start": {
				const { toolName, toolCallId, args } = event;
				if (tools().has(toolName)) {
					const pending = argsBySession.get(sessionId) ?? new Map();
					pending.set(toolCallId, args);
					argsBySession.set(sessionId, pending);
				}
				return { type: event.type, toolName, toolCallId, args };
			}
			case "tool_execution_end": {
				const { toolName, toolCallId, result } = event;
				const pending = argsBySession.get(sessionId);
				const args = pending?.get(toolCallId);
				pending?.delete(toolCallId);
				if (pending?.size === 0) argsBySession.delete(sessionId);
				const tool = event.isError || event.guardrail ? undefined : tools().get(toolName);
				const details =
					result && typeof result === "object" && "details" in result ? result.details : undefined;
				const presented = readPaths(tool?.presented && (() => tool.presented?.(args, details)));
				const picked = readPaths(tool?.picked && (() => tool.picked?.(args, details)));
				return {
					type: event.type,
					toolName,
					toolCallId,
					...(presented?.length ? { presented } : {}),
					...(picked?.length ? { picked } : {}),
				};
			}
			default:
				return null;
		}
	};
}
