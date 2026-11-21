import { RiCloseLine, RiSearchLine } from "@remixicon/react";
import { useT } from "@thinkrail/locales/react";
import { IconButton } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { focusFirstControl } from "@thinkrail/ui/focus";
import { isImeComposing } from "@thinkrail/ui/keyboard";
import { useLocalKeys } from "@thinkrail/ui/local-keys";
import { cn } from "@thinkrail/ui/utils";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { LOCAL_KEY_DEFAULTS } from "@/keybindings";
import { SettingsSection, useAppStore } from "@/store";
import { AppearanceSettings } from "./AppearanceSettings";
import { ArtifactsSettings } from "./ArtifactsSettings";
import { ChatSettings } from "./ChatSettings";
import { EnvironmentSettings } from "./EnvironmentSettings";
import { ExtensionsSettings } from "./ExtensionsSettings";
import { GithubSettings } from "./GithubSettings";
import { jumpToSetting } from "./jumpToSetting";
import { LanguageSettings } from "./LanguageSettings";
import { McpSettings } from "./McpSettings";
import { ModelsSettings } from "./ModelsSettings";
import { NotificationsSettings } from "./NotificationsSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { SettingsSearchResults } from "./SettingsSearchView";
import { SettingsDialogContainer } from "./settingsDialogContainer";
import { holdSettingsEscape } from "./settingsEscape";
import { navAction, navIndex, walkAction, walkKey } from "./settingsKeys";
import { resolveSettingsSection, settingsNavGroups } from "./settingsNav";
import { searchSettings, settingsSearchEntries, settingsSectionLabels } from "./settingsSearch";
import { focusSettingRow, performWalk, rowIdOf, sideOf, textEntryKind } from "./settingsWalk";
import { TemplatesSettings } from "./TemplatesSettings";
import { TerminalSettings } from "./TerminalSettings";
import { VoiceSettings } from "./VoiceSettings";
import { WorkspacesSettings } from "./WorkspacesSettings";

interface SettingsDialogProps {
	layoutSettings: ReactNode;
	keyboardSettings: ReactNode;
	updateSettings?: ReactNode;
}

export function SettingsDialog(props: SettingsDialogProps) {
	const open = useAppStore((s) => s.settingsOpen);
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) useAppStore.getState().closeSettings();
			}}
		>
			{open ? <SettingsDialogContent {...props} /> : null}
		</Dialog>
	);
}

function SettingsDialogContent({
	layoutSettings,
	keyboardSettings,
	updateSettings,
}: SettingsDialogProps) {
	const t = useT();
	const navKeys = useLocalKeys("settings.nav", LOCAL_KEY_DEFAULTS["settings.nav"]);
	const rowKeys = useLocalKeys("settings", LOCAL_KEY_DEFAULTS.settings);
	const section = useAppStore((s) => s.settingsSection);
	const settingTarget = useAppStore((s) => s.settingsTarget);
	const protocolVersion = useAppStore((s) => s.protocolVersion);
	const hostPlatform = useAppStore((s) => s.hostPlatform);
	const voiceAvailable = useAppStore((s) => s.speech?.supported === true);
	const voiceEnabled = useAppStore((s) => s.voiceInputEnabled);
	const filteredGroups = settingsNavGroups(protocolVersion, updateSettings !== undefined);
	const selectedSection = resolveSettingsSection(section, filteredGroups);
	const sections = filteredGroups.flatMap((group) => group.sections);
	const sectionLabel = sections.find(({ id }) => id === selectedSection)?.label;
	const [contentEl, setContentEl] = useState<HTMLElement | null>(null);
	const nav = useRef<HTMLDivElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const resultList = useRef<HTMLDivElement>(null);
	const [pane, setPane] = useState<HTMLDivElement | null>(null);
	const lastFocused = useRef(new Map<SettingsSection, string>());
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [landing, setLanding] = useState<{
		id: string;
		section: SettingsSection;
	} | null>(() => (settingTarget ? { id: settingTarget, section } : null));
	const [showingResults, setShowingResults] = useState(false);
	const results = searchSettings(
		query,
		settingsSearchEntries(t, filteredGroups, {
			protocolVersion,
			hostPlatform,
			voiceAvailable,
			voiceEnabled,
		}),
		settingsSectionLabels(t, filteredGroups),
	);
	const icons = new Map(sections.map(({ id, icon }) => [id, icon]));
	const hasSearch = query.trim().length > 0;
	const showResults = hasSearch && showingResults;

	function focusTab(id = selectedSection) {
		nav.current?.querySelector<HTMLButtonElement>(`[data-settings-section="${id}"]`)?.focus();
	}

	useEffect(() => {
		const root = pane;
		if (!root || !landing || landing.section !== selectedSection) return;
		if (landing.id.startsWith("section:")) {
			if (!focusSettingRow<HTMLElement>(root, null) && !focusFirstControl(root)) root.focus();
			return;
		}
		const controller = new AbortController();
		const frame = requestAnimationFrame(() => {
			void jumpToSetting(root, landing.id, controller.signal).then((found) => {
				if (!found && !controller.signal.aborted) root.focus();
			});
		});
		return () => {
			cancelAnimationFrame(frame);
			controller.abort();
		};
	}, [landing, pane, selectedSection]);

	function selectSection(id: SettingsSection) {
		setLanding(null);
		setQuery("");
		setShowingResults(false);
		useAppStore.getState().setSettingsSection(id);
		focusTab(id);
	}

	function focusResult(index: number) {
		if (results.length === 0) return;
		const clamped = Math.min(results.length - 1, Math.max(0, index));
		setActive(clamped);
		requestAnimationFrame(() => {
			resultList.current
				?.querySelector<HTMLButtonElement>(`[data-result-index="${clamped}"]`)
				?.focus();
		});
	}

	function jump(index: number) {
		const result = results[index];
		if (!result) return;
		focusTab(result.entry.section);
		setActive(index);
		setShowingResults(false);
		setLanding({ id: result.entry.id, section: result.entry.section });
		useAppStore.getState().setSettingsSection(result.entry.section);
	}

	function clearSearch() {
		setQuery("");
		setActive(0);
		setLanding(null);
		setShowingResults(false);
		search.current?.focus();
	}

	function onNavKey(event: KeyboardEvent<HTMLDivElement>) {
		if (event.defaultPrevented || !(event.target instanceof HTMLButtonElement)) return;
		const focusedSection = event.target.dataset.settingsSection;
		const index = sections.findIndex(({ id }) => id === focusedSection);
		if (index < 0) return;
		const local = navKeys.match(event.nativeEvent);
		const action = navAction(event.nativeEvent, local);
		if (!action) return;
		event.preventDefault();
		if (action.kind === "search") {
			search.current?.focus();
		} else if (action.kind === "enter") {
			const root = pane;
			if (
				root &&
				!focusSettingRow<HTMLElement>(root, lastFocused.current.get(selectedSection) ?? null) &&
				!focusFirstControl(root)
			)
				root.focus();
		} else {
			const target = navIndex(action, index, sections.length);
			const next = target === null ? undefined : sections[target];
			if (next) selectSection(next.id);
		}
	}

	function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
		if (event.defaultPrevented || isImeComposing(event.nativeEvent)) return;
		const action = walkKey(
			event.nativeEvent,
			rowKeys.match(event.nativeEvent, { textEntry: true }),
		);
		if (action === "escape") {
			event.preventDefault();
			if (hasSearch) clearSearch();
			else focusTab();
		} else if (action === "down" && results.length > 0) {
			event.preventDefault();
			setShowingResults(true);
			focusResult(active);
		} else if (event.key === "Enter" && results.length > 0) {
			event.preventDefault();
			jump(Math.min(active, results.length - 1));
		}
	}

	function onResultsKey(event: KeyboardEvent<HTMLDivElement>, index: number) {
		if (event.defaultPrevented) return;
		const action = walkKey(event.nativeEvent, rowKeys.match(event.nativeEvent));
		if (!action) return;
		if (action === "escape") clearSearch();
		else if (action === "up" && index === 0) search.current?.focus();
		else if (action === "up" || action === "down") focusResult(index + (action === "up" ? -1 : 1));
		else if (action === "home" || action === "end")
			focusResult(action === "home" ? 0 : results.length - 1);
		else return;
		event.preventDefault();
	}

	function onPaneKey(event: KeyboardEvent<HTMLDivElement>) {
		if (event.defaultPrevented || !(event.target instanceof HTMLElement)) return;
		if (!event.currentTarget.contains(event.target)) return;
		const entry = textEntryKind(event.target);
		const action = walkAction(
			walkKey(event.nativeEvent, rowKeys.match(event.nativeEvent, { textEntry: entry !== null })),
			{
				textEntry: entry !== null,
				multiline: entry === "multi",
				onSide: sideOf(event.target) !== null,
			},
		);
		if (!action) return;
		const toResults =
			landing && hasSearch
				? () => {
						setShowingResults(true);
						focusResult(active);
					}
				: undefined;
		if (
			performWalk(event.currentTarget, event.target, action, { toNav: () => focusTab(), toResults })
		)
			event.preventDefault();
	}

	return (
		<DialogContent
			ref={setContentEl}
			data-testid="settings-dialog"
			data-settings-dialog=""
			hideClose
			aria-describedby={undefined}
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				focusTab();
			}}
			onEscapeKeyDown={(event) => {
				if (isImeComposing(event)) {
					event.preventDefault();
					return;
				}
				holdSettingsEscape(event);
			}}
			className="h-[80vh] max-w-[52rem] gap-0 overflow-hidden p-0"
		>
			<DialogHeader className="flex-row items-center justify-between gap-8 border-border-default border-b px-16 py-8">
				<DialogTitle>{t("settings.dialog.title")}</DialogTitle>
				<label className="flex min-w-0 flex-1 items-center gap-4 rounded-sm border border-control-border-default px-8 focus-within:focus-ring">
					<RiSearchLine aria-hidden className="size-14 shrink-0 text-text-muted" />
					<input
						ref={search}
						type="search"
						data-settings-search=""
						data-testid="settings-search"
						data-key-scope="settings"
						aria-label={t("settings.search.label")}
						aria-keyshortcuts={navKeys.aria("settings.nav.search")}
						placeholder={t("settings.search.label")}
						value={query}
						onChange={(event) => {
							setQuery(event.currentTarget.value);
							setActive(0);
							setLanding(null);
							setShowingResults(true);
						}}
						onFocus={() => setShowingResults(true)}
						onKeyDown={onSearchKey}
						className="min-h-28 min-w-0 flex-1 bg-transparent tr-text-ui outline-none"
					/>
				</label>
				<DialogClose asChild>
					<IconButton icon={RiCloseLine} label={t("common.close")} tabIndex={0} />
				</DialogClose>
			</DialogHeader>
			<div className="flex min-h-0 flex-1 flex-col md:flex-row">
				<nav className="shrink-0 overflow-x-auto border-border-default border-b md:w-216 md:overflow-x-hidden md:overflow-y-auto md:border-r md:border-b-0 md:bg-container-elevated-bg">
					<div
						ref={nav}
						role="tablist"
						data-key-scope="settings.nav"
						aria-label={t("settings.dialog.sectionsLabel")}
						onKeyDown={onNavKey}
						className="flex gap-4 p-8 md:flex-col md:gap-12 md:p-12"
					>
						{filteredGroups.map((group) => (
							<div key={group.label} className="flex shrink-0 md:flex-col">
								<span
									aria-hidden
									className="hidden h-28 py-4 tr-text-label-pill text-text-subtle uppercase md:block"
								>
									{t(group.label)}
								</span>
								<div className="flex gap-4 md:flex-col md:gap-2">
									{group.sections.map(({ id, label, icon: Icon }) => {
										const selected = selectedSection === id;
										return (
											<button
												key={id}
												id={`settings-tab-${id}`}
												type="button"
												role="tab"
												tabIndex={selected ? 0 : -1}
												aria-controls="settings-panel"
												aria-selected={selected}
												data-settings-section={id}
												data-testid={`settings-nav-${id}`}
												data-active={selected}
												onClick={() => selectSection(id)}
												className={cn(
													"flex shrink-0 items-center gap-4 rounded-sm px-4 py-4 text-left tr-text-ui transition-colors focus-visible:focus-ring-inset md:min-h-28 md:w-full md:px-8 md:py-0",
													selected
														? "bg-primary-subtle text-primary"
														: "text-text-muted hover:bg-control-bg-hovered hover:text-text-default",
												)}
											>
												<Icon aria-hidden className="size-14 shrink-0" />
												<span className="min-w-0 wrap-anywhere">{t(label)}</span>
											</button>
										);
									})}
								</div>
							</div>
						))}
					</div>
				</nav>
				{showResults ? (
					<div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-16">
						<SettingsSearchResults
							ref={resultList}
							query={query}
							results={results}
							active={active}
							icons={icons}
							onActive={setActive}
							onJump={jump}
							onKeyDown={onResultsKey}
						/>
					</div>
				) : (
					<div
						id="settings-panel"
						ref={setPane}
						role="tabpanel"
						tabIndex={-1}
						aria-labelledby={`settings-tab-${selectedSection}`}
						data-settings-content=""
						data-key-scope="settings"
						onKeyDown={onPaneKey}
						onFocus={(event) => {
							if (!event.currentTarget.contains(event.target)) return;
							const row = rowIdOf<HTMLElement>(event.target);
							if (row !== null) lastFocused.current.set(selectedSection, row);
						}}
						className="min-h-0 min-w-0 flex-1 overflow-y-auto p-16 focus-visible:outline-none"
					>
						{sectionLabel ? (
							<h2 className="pb-16 tr-heading-sm text-text-default">{t(sectionLabel)}</h2>
						) : null}
						<SettingsDialogContainer value={contentEl}>
							{selectedSection === SettingsSection.Models ? (
								<ModelsSettings />
							) : selectedSection === SettingsSection.Providers ? (
								<ProvidersSettings />
							) : selectedSection === SettingsSection.Mcp ? (
								<McpSettings />
							) : selectedSection === SettingsSection.Templates ? (
								<TemplatesSettings />
							) : selectedSection === SettingsSection.Environment ? (
								<EnvironmentSettings />
							) : selectedSection === SettingsSection.Extensions ? (
								<ExtensionsSettings />
							) : selectedSection === SettingsSection.Chat ? (
								<ChatSettings />
							) : selectedSection === SettingsSection.Appearance ? (
								<AppearanceSettings />
							) : selectedSection === SettingsSection.Language ? (
								<LanguageSettings />
							) : selectedSection === SettingsSection.Layout ? (
								layoutSettings
							) : selectedSection === SettingsSection.Keyboard ? (
								keyboardSettings
							) : selectedSection === SettingsSection.Terminal ? (
								<TerminalSettings />
							) : selectedSection === SettingsSection.Artifacts ? (
								<ArtifactsSettings />
							) : selectedSection === SettingsSection.Voice ? (
								<VoiceSettings />
							) : selectedSection === SettingsSection.Workspaces ? (
								<WorkspacesSettings />
							) : selectedSection === SettingsSection.Github ? (
								<GithubSettings />
							) : selectedSection === SettingsSection.Notifications ? (
								<NotificationsSettings />
							) : selectedSection === SettingsSection.Updates && updateSettings !== undefined ? (
								updateSettings
							) : (
								<AppearanceSettings />
							)}
						</SettingsDialogContainer>
					</div>
				)}
			</div>
		</DialogContent>
	);
}
