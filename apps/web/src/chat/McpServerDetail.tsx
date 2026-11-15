import {
	RiArrowRightSLine as ChevronRight,
	RiCheckLine,
	RiCloseLine,
	RiLoader4Line,
	RiTimeLine,
} from "@remixicon/react";
import type { McpServerStatus } from "@thinkrail/contracts";
import type { ToolStatus } from "@thinkrail/extension-api/web";
import { useT } from "@thinkrail/locales/react";
import { cn } from "@thinkrail/ui/utils";
import { useState } from "react";
import { mcpStatusLabel, turnTimeLabel } from "@/lib";
import type { McpServerCall } from "./mcpServerCalls";
import { ToolRendererBody } from "./ToolRendererBody";
import { mcpArgsSummary } from "./tools/mcp/mcpResult";

function CallStatus({ status, pending }: { status: ToolStatus; pending: boolean }) {
	const t = useT();
	return (
		<>
			{pending ? (
				<RiTimeLine className="size-12 shrink-0 text-text-muted" />
			) : status === "running" ? (
				<RiLoader4Line className="size-12 shrink-0 animate-spin text-text-muted motion-reduce:animate-none" />
			) : status === "error" ? (
				<RiCloseLine className="size-12 shrink-0 text-feedback-error" />
			) : (
				<RiCheckLine className="size-12 shrink-0 text-feedback-success" />
			)}
			<span className="sr-only">
				{pending
					? t("resources.state.queued")
					: status === "running"
						? t("resources.state.running")
						: status === "error"
							? t("resources.state.failed")
							: t("resources.state.done")}
			</span>
		</>
	);
}

function McpCallRow({ call }: { call: McpServerCall }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const status: ToolStatus = call.result?.status ?? (call.dead ? "error" : "running");
	const pending = !call.result && !call.dead;
	return (
		<li
			data-testid="resource-mcp-call"
			data-tool-call-id={call.toolCallId}
			data-status={pending ? "pending" : status}
			data-expanded={expanded}
			className="rounded-sm border border-border-default bg-container-elevated-bg"
		>
			<button
				type="button"
				data-testid="resource-mcp-call-toggle"
				aria-expanded={expanded}
				onClick={() => setExpanded(!expanded)}
				className="flex w-full cursor-pointer select-none items-center gap-8 px-8 py-4 text-left tr-text-metadata focus-visible:focus-ring-inset"
			>
				<CallStatus status={status} pending={pending} />
				<span className="shrink-0 text-text-default">{call.tool}</span>
				<span className="min-w-0 flex-1 truncate text-text-muted tr-code-text-small">
					{mcpArgsSummary(call.args)}
				</span>
				<span className="shrink-0 text-text-subtle tabular-nums">{turnTimeLabel(t, call.at)}</span>
				<ChevronRight
					className={cn(
						"size-16 shrink-0 text-text-muted transition-transform",
						expanded && "rotate-90",
					)}
				/>
			</button>
			{expanded && !pending ? (
				<div className={cn("px-8 pb-4", status === "error" && "text-feedback-error")}>
					<ToolRendererBody
						toolCallId={call.toolCallId}
						toolName={call.toolName}
						args={call.args}
						result={call.result?.raw}
						status={status}
						streaming={call.streaming}
						imageLabel={call.tool}
					/>
				</div>
			) : null}
		</li>
	);
}

export function McpServerDetail({
	status,
	calls,
}: {
	status: McpServerStatus | undefined;
	calls: readonly McpServerCall[];
}) {
	const t = useT();
	const heading = "flex items-baseline gap-4 tr-text-eyebrow text-text-subtle";
	return (
		<div
			data-testid="resource-mcp-body"
			className="flex min-h-0 flex-1 flex-col gap-12 overflow-y-auto"
		>
			{status ? (
				<section data-testid="resource-mcp-status" className="flex flex-col gap-4">
					<h3 className={heading}>
						{t("resources.mcp.statusAt", { time: turnTimeLabel(t, status.updatedAt) })}
					</h3>
					<pre className="whitespace-pre-wrap break-words rounded-sm border border-border-default bg-container-header-bg px-8 py-4 tr-code-text-small text-text-default">
						{status.detail || mcpStatusLabel(t, status.state, status.toolCount)}
					</pre>
				</section>
			) : null}
			<section data-testid="resource-mcp-calls" className="flex flex-col gap-4">
				<h3 className={heading}>
					{t("resources.mcp.calls")}
					<span className="tr-text-metadata">· {calls.length}</span>
				</h3>
				{calls.length === 0 ? (
					<p className="text-text-subtle tr-text-metadata">{t("resources.mcp.callsEmpty")}</p>
				) : (
					<ul className="flex flex-col gap-4">
						{calls.map((call) => (
							<McpCallRow key={call.toolCallId} call={call} />
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
