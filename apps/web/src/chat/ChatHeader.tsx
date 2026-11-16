import type { SessionStats } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import type { ReactNode } from "react";
import { SessionStatsBar } from "./SessionStatsBar";
import { SkillsButton } from "./SkillsButton";

export function ChatHeader({
	stats,
	statusEntries,
	resources,
	onOpenSkills,
	skillsStale,
	activeAgent,
}: {
	stats: SessionStats | null;
	statusEntries: [string, string][];
	resources?: ReactNode;
	onOpenSkills?: () => void;
	skillsStale?: boolean;
	/** The accepted SDK Handoff owner; only chats with a Handoff graph have one. */
	activeAgent?: string | undefined;
}) {
	const t = useT();
	return (
		<div
			data-testid="chat-toolbar"
			className="flex h-panel-header-row shrink-0 items-center gap-12 overflow-clip border-border-muted border-b bg-container-workspace-bg px-12"
		>
			<div className="min-w-0 flex-1">
				{activeAgent ? (
					<span data-testid="active-agent" className="truncate text-text-muted tr-text-metadata">
						{t("chat.agent.active", { agent: activeAgent })}
					</span>
				) : null}
			</div>
			<div className="flex min-w-0 items-center justify-end gap-12 overflow-clip">
				{statusEntries.map(([key, text]) => (
					<span key={key} className="min-w-0 truncate text-text-muted tr-text-metadata">
						{text}
					</span>
				))}
				<SessionStatsBar stats={stats} />
			</div>
			{resources}
			{onOpenSkills ? (
				<SkillsButton onOpen={onOpenSkills} testId="open-skills" stale={skillsStale ?? false} />
			) : null}
		</div>
	);
}
