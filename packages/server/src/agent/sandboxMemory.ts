import {
	type Agent,
	type AgentInputItem,
	type AgentOutputType,
	type Model,
	type NonStreamRunOptions,
	type RunConfig,
	Runner,
	type RunResult,
	type RunState,
	type StreamedRunResult,
	type StreamRunOptions,
	type Tool,
	tool,
} from "@openai/agents";
import { memory, SandboxAgent, shell } from "@openai/agents/sandbox";
import type { UnixLocalSandboxSession } from "@openai/agents/sandbox/local";
import { z } from "zod";

const MAX_REQUESTS = 8;
const GENERATION_MS = 120_000;
const FILE_BYTES = 32_768;
const SUMMARY = "memories/memory_summary.md";
const MEMORY_INDEX = "memories/MEMORY.md";
const PHASE_TWO_SELECTION = "memories/phase_two_selection.json";
const writableMemoryPath = z.enum([SUMMARY, MEMORY_INDEX]);
export const SANDBOX_ARCHIVE_BYTES = 1024 * 1024;
export const sandboxArchiveLimits = {
	maxInputBytes: SANDBOX_ARCHIVE_BYTES,
	maxExtractedBytes: 8 * SANDBOX_ARCHIVE_BYTES,
	maxMembers: 512,
};

interface MemoryAuthority {
	session(): UnixLocalSandboxSession;
	assertActive(): void;
	canGenerate(): boolean;
	signal(): AbortSignal;
	workspaceTools(signal: AbortSignal): Tool[];
	approve(
		call: { callId: string; name: string; arguments: string },
		signal: AbortSignal,
	): Promise<boolean>;
	trackTools(agent: Agent): void;
}

export class SandboxMemory {
	readonly model: Model;
	readonly capabilities;
	private requestCount = 0;
	private deadline?: AbortSignal;
	private wroteSummary = false;
	private readonly authority: MemoryAuthority;
	private allowedTools = new Set<string>();
	completed = false;
	failed = false;

	constructor(model: Model, authority: MemoryAuthority) {
		this.authority = authority;
		this.model = {
			getResponse: async (request) => {
				this.assertGenerationAllowed();
				if (this.requestCount >= MAX_REQUESTS) throw new Error("Memory request limit reached");
				this.requestCount++;
				if (
					request.tools.some(
						(candidate) => candidate.type !== "function" || !this.allowedTools.has(candidate.name),
					)
				)
					throw new Error("Unexpected native tool in memory generation");
				const response = await model.getResponse({
					...request,
					signal: request.signal ? AbortSignal.any([this.signal(), request.signal]) : this.signal(),
				});
				this.assertGenerationAllowed();
				if (
					response.output.some(
						(item) =>
							item.type !== "message" &&
							item.type !== "reasoning" &&
							(item.type !== "function_call" || !this.allowedTools.has(item.name)),
					)
				)
					throw new Error("The model requested a tool outside the memory policy");
				return response;
			},
			getStreamedResponse() {
				throw new Error("Memory generation must use a non-streaming run");
			},
		};
		this.capabilities = [
			shell({ configureTools: () => [] }),
			memory({
				read: { liveUpdate: false },
				generate: {
					phaseOneModel: this.model,
					phaseTwoModel: this.model,
					phaseOneModelSettings: { maxTokens: 4096, retry: { maxRetries: 0 } },
					phaseTwoModelSettings: {
						maxTokens: 4096,
						parallelToolCalls: false,
						retry: { maxRetries: 0 },
					},
					phaseTwoMaxTurns: MAX_REQUESTS - 1,
					maxRawMemoriesForConsolidation: 4,
				},
			}),
		];
	}

	owns(agent: { model?: string | Model }): boolean {
		return typeof agent.model === "object" && agent.model.getResponse === this.model.getResponse;
	}

	private signal(): AbortSignal {
		this.deadline ??= AbortSignal.timeout(GENERATION_MS);
		return AbortSignal.any([this.authority.signal(), this.deadline]);
	}

	private assertGenerationAllowed(): void {
		this.authority.assertActive();
		if (!this.authority.canGenerate())
			throw new Error("Memory generation requires a successful chat run");
		this.signal().throwIfAborted();
	}

	readTool(session: () => UnixLocalSandboxSession, assertActive: () => void) {
		return tool({
			name: "read_memory",
			description: "Read a text file under memories/ in this session's private SDK workspace.",
			parameters: z.object({
				path: z
					.string()
					.max(256)
					.regex(/^memories\/(?:[\w-]+\/)*[\w.-]+\.md$/),
			}),
			execute: async ({ path }) => {
				assertActive();
				const bytes = await session().readFile({ path, maxBytes: FILE_BYTES + 1 });
				assertActive();
				if (bytes.byteLength > FILE_BYTES) throw new Error("Memory file exceeds the read limit");
				return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			},
		});
	}

	private writeTool() {
		return tool({
			name: "save_memory",
			description:
				"Replace the SDK's private memory index or summary. Use only for retained memory.",
			parameters: z.object({
				path: writableMemoryPath,
				content: z.string().min(1).max(FILE_BYTES),
			}),
			execute: async ({ path, content }) => {
				this.assertGenerationAllowed();
				const newText = content.replace(/\r\n/g, "\n").trimEnd();
				if (!newText || newText.includes("\r") || Buffer.byteLength(newText) >= FILE_BYTES)
					throw new Error("Memory file is empty, invalid, or exceeds the write limit");
				const session = this.authority.session();
				const bytes = await session.readFile({ path, maxBytes: FILE_BYTES + 1 });
				if (bytes.byteLength > FILE_BYTES) throw new Error("Memory file exceeds the write limit");
				const oldText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				const previous = oldText.replace(/\n$/, "");
				const before = previous ? previous.split("\n").map((line) => `-${line}`) : [];
				const after = newText.split("\n").map((line) => `+${line}`);
				this.assertGenerationAllowed();
				const result = await session.createEditor().updateFile({
					type: "update_file",
					path,
					diff: ["@@", ...before, ...after].join("\n"),
				});
				this.assertGenerationAllowed();
				if (result?.status === "failed")
					throw new Error(result.output ?? "Memory file update failed");
				if (path === SUMMARY) this.wroteSummary = true;
				return "Memory file saved.";
			},
		});
	}

	configurePhase(agent: SandboxAgent): AbortSignal {
		this.assertGenerationAllowed();
		if (agent.name !== "sandbox-memory-phase-one" && agent.name !== "sandbox-memory-phase-two")
			throw new Error("Unknown native memory phase");
		const signal = this.signal();
		agent.baseInstructions = "";
		agent.capabilities = [];
		if (agent.name === "sandbox-memory-phase-two") {
			agent.instructions = [
				"Use read_memory and save_memory for private SDK memory files.",
				"Start by calling read_memory with path memories/raw_memories.md. Use that file and the rollout_summary_file entries under 'Current selected Phase 1 inputs' as the complete input inventory for this update.",
				"Each successful read_memory call returns the entire file within its size limit. Read selected rollout summaries as needed, prefixing the listed path with memories/. Skip line counts, chunked reads, shell inventory, and skills directory searches.",
				`Read ${MEMORY_INDEX} and ${SUMMARY} as needed to preserve relevant existing notes.`,
				`Once you have enough evidence, stop inventorying. Use save_memory with the full Markdown content for ${MEMORY_INDEX} and ${SUMMARY}. Save the summary last, then finish.`,
				"Use project worktree tools only for operations on the project worktree under its existing permissions.",
			].join("\n");
			agent.tools = [
				...this.authority.workspaceTools(signal),
				this.readTool(
					() => this.authority.session(),
					() => this.assertGenerationAllowed(),
				),
				this.writeTool(),
			];
		} else {
			agent.tools = [];
			if (typeof agent.instructions === "string") {
				agent.instructions +=
					'\n\nReturn exactly one JSON object with three string fields named rollout_summary, rollout_slug, and raw_memory. Omit Markdown wrappers and explanations. Apply the minimum-signal gate above. If the rollout falls below that gate, return {"rollout_summary":"","rollout_slug":"","raw_memory":""}.';
			}
		}
		this.allowedTools = new Set(agent.tools.map((candidate) => candidate.name));
		this.authority.trackTools(agent);
		return signal;
	}

	approve(
		call: { callId: string; name: string; arguments: string },
		signal: AbortSignal,
	): Promise<boolean> {
		this.assertGenerationAllowed();
		return this.authority.approve(call, signal);
	}

	phaseCompleted(name: string): void {
		this.assertGenerationAllowed();
		if (name !== "sandbox-memory-phase-two") return;

		// The SDK writes its selection after the Runner returns and catches write errors.
		const session = this.authority.session();
		const materializeEntry = session.materializeEntry;
		session.materializeEntry = async (args) => {
			if (args.path !== PHASE_TWO_SELECTION) return materializeEntry.call(session, args);
			session.materializeEntry = materializeEntry;
			try {
				this.assertGenerationAllowed();
				await materializeEntry.call(session, args);
				this.assertGenerationAllowed();
				this.completed = this.wroteSummary;
			} catch (error) {
				this.failed = true;
				throw error;
			}
		};
	}
}

// The native SDK calls both memory agents through the Runner that owns the parent run.
export class SandboxMemoryRunner extends Runner {
	private readonly memory: SandboxMemory;
	constructor(config: Partial<RunConfig>, memory: SandboxMemory) {
		super(config);
		this.memory = memory;
	}

	override run<TContext, TAgent extends Agent<TContext, AgentOutputType>>(
		agent: TAgent,
		input: string | AgentInputItem[] | RunState<TContext, TAgent>,
		options?: NonStreamRunOptions<TContext, TAgent>,
	): Promise<RunResult<TContext, TAgent>>;
	override run<TContext, TAgent extends Agent<TContext, AgentOutputType>>(
		agent: TAgent,
		input: string | AgentInputItem[] | RunState<TContext, TAgent>,
		options?: StreamRunOptions<TContext, TAgent>,
	): Promise<StreamedRunResult<TContext, TAgent>>;
	override async run<TContext, TAgent extends Agent<TContext, AgentOutputType>>(
		agent: TAgent,
		input: string | AgentInputItem[] | RunState<TContext, TAgent>,
		options?: NonStreamRunOptions<TContext, TAgent> | StreamRunOptions<TContext, TAgent>,
	): Promise<RunResult<TContext, TAgent> | StreamedRunResult<TContext, TAgent>> {
		if (!this.memory.owns(agent)) {
			return options?.stream === true
				? super.run(agent, input, options)
				: super.run(agent, input, options);
		}
		if (!(agent instanceof SandboxAgent) || options?.stream === true)
			throw new Error("Unexpected SDK memory agent");
		try {
			const signal = this.memory.configurePhase(agent);
			const phaseOptions = { ...options, signal };
			let result = await super.run(agent, input, phaseOptions);
			while (result.interruptions.length) {
				for (const interruption of result.interruptions) {
					const call = interruption.rawItem;
					if (call.type !== "function_call") throw new Error("Unsupported memory approval type");
					const approved = await this.memory.approve(call, signal);
					signal.throwIfAborted();
					if (approved) result.state.approve(interruption);
					else result.state.reject(interruption);
				}
				result = await super.run(agent, result.state, phaseOptions);
			}
			this.memory.phaseCompleted(agent.name);
			return result;
		} catch (error) {
			this.memory.failed = true;
			throw error;
		}
	}
}
