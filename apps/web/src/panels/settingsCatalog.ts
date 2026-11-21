import {
	AUTO_SUMMARY_SETTINGS_PROTOCOL_VERSION,
	EXTENSION_SETTINGS_PROTOCOL_VERSION,
	FONTS_PROTOCOL_VERSION,
	type HostPlatform,
	OTHER_AGENT_SKILLS_PROTOCOL_VERSION,
	QUESTION_PANEL_PROTOCOL_VERSION,
	SUBAGENT_CATALOG_PROTOCOL_VERSION,
	SUBAGENT_CONCURRENCY_PROTOCOL_VERSION,
	SUBAGENT_SETTINGS_PROTOCOL_VERSION,
	THEME_SYSTEM_PROTOCOL_VERSION,
	WINDOWS_SHELL_SETTINGS_PROTOCOL_VERSION,
} from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { SettingsSection, selectActiveWorkspace, type useAppStore } from "@/store";
import type { SettingsNavGroup } from "./settingsNav";

interface SettingVisibility {
	activeWorkspace: boolean;
	systemTheme: boolean;
	themeFolder: boolean;
	fontFolder: boolean;
	localeFolder: boolean;
	voiceFiles: boolean;
}

export interface SettingsCatalogContext extends SettingVisibility {
	protocolVersion: number | null;
	hostPlatform: HostPlatform | null;
	voiceAvailable: boolean;
	voiceEnabled: boolean;
}

export function selectSettingsCatalogContext(
	state: ReturnType<typeof useAppStore.getState>,
): SettingsCatalogContext {
	return {
		protocolVersion: state.protocolVersion,
		hostPlatform: state.hostPlatform,
		voiceAvailable: state.speech?.supported === true,
		voiceEnabled: state.voiceInputEnabled,
		activeWorkspace: selectActiveWorkspace(state) !== null,
		systemTheme:
			(state.protocolVersion ?? 0) >= THEME_SYSTEM_PROTOCOL_VERSION && state.themeMode === "system",
		themeFolder: state.userThemes !== null,
		fontFolder: state.userFonts !== null,
		localeFolder: Boolean(state.localLocales?.dir),
		voiceFiles: (state.speech?.diskBytes ?? 0) > 0,
	};
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
	visibleWhen?: keyof SettingVisibility;
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
		id: "subagents-catalog",
		section: SettingsSection.Chat,
		label: "settings.subagents.available",
		description: "settings.subagents.catalogDescription",
		keywords: ["subagents", "agent catalog"],
		requiresProtocolVersion: SUBAGENT_CATALOG_PROTOCOL_VERSION,
	},
	{
		id: "subagents-workspace",
		section: SettingsSection.Chat,
		label: "settings.catalog.subagentsWorkspace.label",
		requiresProtocolVersion: SUBAGENT_SETTINGS_PROTOCOL_VERSION,
		visibleWhen: "activeWorkspace",
	},
	{
		id: "subagents-workspace-limit",
		section: SettingsSection.Chat,
		label: "settings.catalog.subagentsWorkspaceLimit.label",
		requiresProtocolVersion: SUBAGENT_CONCURRENCY_PROTOCOL_VERSION,
		visibleWhen: "activeWorkspace",
	},
	{
		id: "rich-previews",
		section: SettingsSection.Extensions,
		label: "settings.extensions.ask-user-question.richPreviews.title",
		description: "settings.extensions.ask-user-question.richPreviews.description",
		requiresProtocolVersion: EXTENSION_SETTINGS_PROTOCOL_VERSION,
	},
	{
		id: "visible-models",
		section: SettingsSection.Models,
		label: "settings.visibleModels.title",
	},
	{
		id: "mcp-add",
		section: SettingsSection.Mcp,
		label: "mcp.addDialog.title",
		visibleWhen: "activeWorkspace",
	},
	{
		id: "project-templates",
		section: SettingsSection.Templates,
		label: "settings.templates.projectTitle",
		visibleWhen: "activeWorkspace",
	},
	{
		id: "global-templates",
		section: SettingsSection.Templates,
		label: "settings.templates.globalTitle",
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
		label: "settings.catalog.interfaceFont.label",
		requiresProtocolVersion: FONTS_PROTOCOL_VERSION,
	},
	{
		id: "code-font",
		section: SettingsSection.Appearance,
		label: "settings.catalog.codeFont.label",
		requiresProtocolVersion: FONTS_PROTOCOL_VERSION,
	},
	{
		id: "interface-fallbacks",
		section: SettingsSection.Appearance,
		label: "settings.appearance.fonts.interfaceFallbacks",
		requiresProtocolVersion: FONTS_PROTOCOL_VERSION,
	},
	{
		id: "code-fallbacks",
		section: SettingsSection.Appearance,
		label: "settings.appearance.fonts.codeFallbacks",
		requiresProtocolVersion: FONTS_PROTOCOL_VERSION,
	},
	{
		id: "custom-fonts",
		section: SettingsSection.Appearance,
		label: "settings.appearance.customFonts.title",
		requiresProtocolVersion: FONTS_PROTOCOL_VERSION,
		visibleWhen: "fontFolder",
	},
	{
		id: "fonts-folder",
		section: SettingsSection.Appearance,
		label: "settings.appearance.customFonts.folder",
		requiresProtocolVersion: FONTS_PROTOCOL_VERSION,
		visibleWhen: "fontFolder",
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
		keywords: ["theme pair"],
	},
	{
		id: "light-theme",
		section: SettingsSection.Appearance,
		label: "settings.appearance.lightTheme",
		visibleWhen: "systemTheme",
	},
	{
		id: "dark-theme",
		section: SettingsSection.Appearance,
		label: "settings.appearance.darkTheme",
		visibleWhen: "systemTheme",
	},
	{
		id: "theme-folder",
		section: SettingsSection.Appearance,
		label: "settings.appearance.custom.folder",
		visibleWhen: "themeFolder",
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
		id: "keyboard-shortcuts",
		section: SettingsSection.Keyboard,
		label: "settings.keyboard.shortcuts",
	},
	{
		id: "language-folder",
		section: SettingsSection.Language,
		label: "settings.language.folder.label",
		visibleWhen: "localeFolder",
	},
	{
		id: "voice-files",
		section: SettingsSection.Voice,
		label: "settings.voice.delete",
		visibleWhen: "voiceFiles",
		voice: "available",
	},
	{
		id: "layout-presets",
		section: SettingsSection.Layout,
		label: "settings.catalog.layoutPresets.label",
	},
	{
		id: "layout-group-limits",
		section: SettingsSection.Layout,
		label: "workbench.layoutSettings.groupLimits",
		description: "workbench.layoutSettings.groupLimitsDescription",
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
		({ section, windowsOnly, requiresProtocolVersion, voice, visibleWhen }) =>
			sections.has(section) &&
			(!voice || (context.voiceAvailable && (voice !== "enabled" || context.voiceEnabled))) &&
			(!visibleWhen || context[visibleWhen]) &&
			(!windowsOnly || context.hostPlatform === "win32") &&
			(requiresProtocolVersion === undefined ||
				(context.protocolVersion ?? 0) >= requiresProtocolVersion),
	);
}
