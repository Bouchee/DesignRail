import { SUBAGENT_CATALOG_PROTOCOL_VERSION, type SubagentCatalogEntry } from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { useEffect, useState } from "react";
import { LEVEL_LABEL } from "@/chat/modelPicker";
import {
	selectActiveRepoWorkspaceId,
	selectContextProject,
	selectHostReachable,
	toast,
	useAppStore,
} from "@/store";
import { errorText, getTransport } from "@/transport";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./SettingsRow";
import { SettingsSwitch } from "./SettingsSwitch";

const SOURCE_LABELS: Record<SubagentCatalogEntry["source"], MessageKey> = {
	builtin: "settings.subagents.source.builtin",
	personal: "settings.subagents.source.personal",
	project: "settings.subagents.source.project",
};

export function AvailableAgents() {
	const t = useT();
	const workspaceId = useAppStore(selectActiveRepoWorkspaceId);
	const resourceTrust = useAppStore((state) => selectContextProject(state)?.resourceTrust);
	const welcomeGeneration = useAppStore((state) => state.welcomeGeneration);
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const connected = useAppStore(selectHostReachable);
	const disabledNames = useAppStore((state) => state.disabledSubagents);
	const [refresh, setRefresh] = useState(0);
	const key = JSON.stringify([workspaceId, resourceTrust, welcomeGeneration, refresh]);
	const [loaded, setLoaded] = useState<{
		key: string;
		entries: SubagentCatalogEntry[] | null;
	}>();
	const supported =
		protocolVersion !== null && protocolVersion >= SUBAGENT_CATALOG_PROTOCOL_VERSION;
	const entries = loaded?.key === key ? loaded.entries : undefined;
	useEffect(() => {
		if (!supported || !connected) return;
		let current = true;
		getTransport()
			.request("subagent.list", workspaceId === undefined ? {} : { workspaceId })
			.then(
				(entries) => {
					if (current) setLoaded({ key, entries });
				},
				() => {
					if (current) setLoaded({ key, entries: null });
				},
			);
		return () => {
			current = false;
		};
	}, [connected, key, supported, workspaceId]);

	if (!supported) return null;
	return (
		<SettingsGroup
			title={t("settings.subagents.available")}
			description={t("settings.subagents.catalogDescription")}
			testId="settings-agent-catalog"
		>
			<SettingsRow
				settingId="subagents-catalog"
				label={t("settings.subagents.available")}
				control={
					<Button
						variant="outline"
						size="s"
						disabled={!connected || entries === undefined}
						data-testid="agents-refresh"
						onClick={() => setRefresh((version) => version + 1)}
					>
						{t(entries === null ? "common.retry" : "settings.subagents.refresh")}
					</Button>
				}
				description={
					entries === undefined
						? t("settings.subagents.loading")
						: entries === null
							? t("settings.subagents.loadFailed")
							: entries.length === 0
								? t("settings.subagents.empty")
								: undefined
				}
			/>
			{entries?.map((entry) => (
				<SettingsRow
					key={entry.name}
					label={entry.name}
					testId={`agent-row-${entry.name}`}
					description={
						<>
							<span className="block text-text-subtle">{t(SOURCE_LABELS[entry.source])}</span>
							<span className="block">{entry.description}</span>
							<span className="block break-all text-text-subtle">
								{entry.model
									? t("settings.subagents.pinnedModel", { model: entry.model })
									: t("settings.subagents.parentModel")}
								{entry.thinking === undefined ? null : (
									<>
										{" · "}
										{t("settings.subagents.effort", { effort: t(LEVEL_LABEL[entry.thinking]) })}
									</>
								)}
							</span>
						</>
					}
					control={
						<SettingsSwitch
							checked={!disabledNames.includes(entry.name)}
							disabled={!connected}
							label={t("settings.subagents.enableGlobally", { name: entry.name })}
							testId={`agent-toggle-${entry.name}`}
							onChange={(enabled) => {
								getTransport()
									.request("subagent.setEnabled", { name: entry.name, enabled })
									.catch((error: unknown) =>
										toast.error(errorText(error), t("settings.subagents.saveFailed")),
									);
							}}
						/>
					}
				/>
			))}
		</SettingsGroup>
	);
}
