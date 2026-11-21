import {
	AUTO_SUMMARY_SETTINGS_PROTOCOL_VERSION,
	FONTS_PROTOCOL_VERSION,
	type HostPlatform,
	OTHER_AGENT_SKILLS_PROTOCOL_VERSION,
	QUESTION_PANEL_PROTOCOL_VERSION,
	SUBAGENT_CONCURRENCY_PROTOCOL_VERSION,
	SUBAGENT_SETTINGS_PROTOCOL_VERSION,
	WINDOWS_SHELL_SETTINGS_PROTOCOL_VERSION,
} from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { SettingsSection } from "@/store";
import type { SettingsNavGroup } from "./settingsNav";

export interface SettingsCatalogContext {
	protocolVersion: number | null;
	hostPlatform: HostPlatform | null;
	voiceAvailable: boolean;
	voiceEnabled: boolean;
}

interface SettingEntry {
	id: string;
	section: SettingsSection;
	label: MessageKey;
	description?: MessageKey;
	keywords?: readonly string[];
	requiresProtocolVersion?: number;
	windowsOnly?: true;
	voice?: "available" | "enabled";
}

const SETTINGS: readonly SettingEntry[] = [
	{
		id: "interface-language",
		section: SettingsSection.Language,
		label: "settings.language.title",
		description: "settings.language.description",
	},
	{
		id: "windows-shell",
		section: SettingsSection.Terminal,
		label: "settings.terminal.shell.title",
		description: "settings.terminal.shell.description",
		requiresProtocolVersion: WINDOWS_SHELL_SETTINGS_PROTOCOL_VERSION,
		windowsOnly: true,
	},
	{
		id: "message-order",
		section: SettingsSection.Chat,
		label: "settings.chat.messageOrder",
		description: "settings.chat.messageOrderDescription",
	},
	{
		id: "composer-size",
		section: SettingsSection.Chat,
		label: "settings.chat.composerSize",
	},
	{
		id: "question-panel-height",
		section: SettingsSection.Chat,
		label: "settings.chat.questionPanelHeight",
		description: "settings.chat.questionPanelHeightDescription",
		keywords: ["question", "dock"],
		requiresProtocolVersion: QUESTION_PANEL_PROTOCOL_VERSION,
	},
	{
		id: "sdk-tracing",
		section: SettingsSection.Chat,
		label: "settings.chat.sdkTracing",
		description: "settings.chat.sdkTracingDescription",
	},
	{
		id: "subagents-allow",
		section: SettingsSection.Chat,
		label: "settings.subagents.allow",
		requiresProtocolVersion: SUBAGENT_SETTINGS_PROTOCOL_VERSION,
	},
	{
		id: "subagents-per-chat",
		section: SettingsSection.Chat,
		label: "settings.subagents.perChat",
		requiresProtocolVersion: SUBAGENT_CONCURRENCY_PROTOCOL_VERSION,
	},
	{
		id: "theme-mode",
		section: SettingsSection.Appearance,
		label: "settings.appearance.themeMode",
	},
	{
		id: "contrast",
		section: SettingsSection.Appearance,
		label: "settings.appearance.contrastLevel",
	},
	{
		id: "markdown-outline",
		section: SettingsSection.Appearance,
		label: "settings.appearance.markdownOutlineSide",
		keywords: ["side", "table of contents"],
	},
	{
		id: "code-size",
		section: SettingsSection.Appearance,
		label: "settings.appearance.fonts.size",
		requiresProtocolVersion: FONTS_PROTOCOL_VERSION,
	},
	{
		id: "interface-font",
		section: SettingsSection.Appearance,
		label: "settings.appearance.fonts.font",
		requiresProtocolVersion: FONTS_PROTOCOL_VERSION,
	},
	{
		id: "ligatures",
		section: SettingsSection.Appearance,
		label: "settings.appearance.fonts.ligatures",
		requiresProtocolVersion: FONTS_PROTOCOL_VERSION,
	},
	{
		id: "voice-input",
		voice: "available",
		section: SettingsSection.Voice,
		label: "settings.voice.enable",
	},
	{
		id: "voice-language",
		voice: "enabled",
		section: SettingsSection.Voice,
		label: "settings.voice.language",
	},
	{
		id: "voice-shortcut",
		voice: "enabled",
		section: SettingsSection.Voice,
		label: "settings.voice.shortcut",
	},
	{
		id: "chat-line-width",
		section: SettingsSection.Chat,
		label: "settings.lineWidth.chat.inputLabel",
		description: "settings.lineWidth.chat.description",
	},
	{
		id: "chat-fit-to-pane",
		section: SettingsSection.Chat,
		label: "settings.lineWidth.chat.boundedLabel",
	},
	{
		id: "file-line-width",
		section: SettingsSection.Appearance,
		label: "settings.lineWidth.file.inputLabel",
		description: "settings.lineWidth.file.description",
	},
	{
		id: "file-fit-to-pane",
		section: SettingsSection.Appearance,
		label: "settings.lineWidth.file.boundedLabel",
	},
	{
		id: "theme-colors",
		section: SettingsSection.Appearance,
		label: "settings.appearance.theme",
		keywords: ["theme pair", "dark theme", "light theme"],
	},
	{
		id: "font-weight",
		section: SettingsSection.Appearance,
		label: "settings.appearance.fonts.weight",
		description: "settings.appearance.fonts.weightDescription",
		requiresProtocolVersion: FONTS_PROTOCOL_VERSION,
	},
	{
		id: "smart-artifacts",
		section: SettingsSection.Artifacts,
		label: "settings.artifacts.smart",
		description: "settings.artifacts.smartHint",
	},
	{
		id: "layout-add",
		section: SettingsSection.Layout,
		label: "workbench.layoutSettings.addNew",
		description: "workbench.layoutSettings.addNewDescription",
	},
	{
		id: "notifications-enabled",
		section: SettingsSection.Notifications,
		label: "settings.notifications.enable",
	},
	{
		id: "language-contribute",
		section: SettingsSection.Language,
		label: "settings.language.contribute.label",
	},
	{
		id: "layout-reset",
		section: SettingsSection.Layout,
		label: "workbench.layoutSettings.resetToDefault",
	},
	{
		id: "chat-model",
		section: SettingsSection.Models,
		label: "settings.models.chatModel",
		keywords: ["default model", "effort", "reasoning"],
	},
	{
		id: "custom-servers",
		section: SettingsSection.Providers,
		label: "settings.customEndpoints.title",
		keywords: ["provider", "API key", "endpoint"],
	},
	{
		id: "auto-summary",
		section: SettingsSection.Models,
		label: "settings.models.summary.title",
		requiresProtocolVersion: AUTO_SUMMARY_SETTINGS_PROTOCOL_VERSION,
	},
	{
		id: "environment-variables",
		section: SettingsSection.Environment,
		label: "settings.environment.vars.label",
		description: "settings.environment.description",
		keywords: ["environment", "env"],
	},
	{
		id: "other-agent-skills",
		section: SettingsSection.Extensions,
		label: "settings.extensions.otherAgentSkills",
		description: "settings.extensions.otherAgentSkillsDescription",
		requiresProtocolVersion: OTHER_AGENT_SKILLS_PROTOCOL_VERSION,
	},
	{
		id: "bundled-extensions",
		section: SettingsSection.Extensions,
		label: "settings.extensions.group.bundled",
	},
	{
		id: "scrollback",
		section: SettingsSection.Terminal,
		label: "settings.terminal.scrollback.title",
		description: "settings.terminal.scrollback.description",
	},
	{
		id: "double-shift",
		section: SettingsSection.Keyboard,
		label: "settings.keyboard.doubleShift",
		description: "settings.keyboard.doubleShiftHint",
	},
	{
		id: "settle-idle",
		section: SettingsSection.Workspaces,
		label: "settings.workspaces.title",
	},
	{
		id: "github-cli",
		section: SettingsSection.Github,
		label: "settings.github.title",
	},
	{
		id: "software-updates",
		section: SettingsSection.Updates,
		label: "updates.settings.title",
		keywords: ["release", "version"],
	},
];

export function availableSettings(
	groups: readonly SettingsNavGroup[],
	context: SettingsCatalogContext,
): readonly SettingEntry[] {
	const sections = new Set(groups.flatMap(({ sections }) => sections.map(({ id }) => id)));
	return SETTINGS.filter(
		({ section, windowsOnly, requiresProtocolVersion, voice }) =>
			sections.has(section) &&
			(!voice || (context.voiceAvailable && (voice !== "enabled" || context.voiceEnabled))) &&
			(!windowsOnly || context.hostPlatform === "win32") &&
			(requiresProtocolVersion === undefined ||
				(context.protocolVersion ?? 0) >= requiresProtocolVersion),
	);
}
