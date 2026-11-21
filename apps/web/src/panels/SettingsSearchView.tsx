import { type RemixiconComponentType, RiSettings3Line } from "@remixicon/react";
import { useT } from "@thinkrail/locales/react";
import type { KeyboardEvent, MouseEvent, Ref } from "react";
import { highlightRanges } from "@/components/MatchHighlight";
import type { SettingsSection } from "@/store";
import type { SettingsSearchResult } from "./settingsSearch";

export interface SettingsSearchResultsProps {
	readonly query: string;
	readonly results: readonly SettingsSearchResult[];
	readonly active: number;
	readonly icons: ReadonlyMap<SettingsSection, RemixiconComponentType>;
	readonly onActive: (index: number) => void;
	readonly onJump: (index: number) => void;
	readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>, index: number) => void;
	readonly ref?: Ref<HTMLDivElement>;
}

const indexOf = (target: EventTarget) =>
	target instanceof HTMLElement ? Number(target.dataset.resultIndex ?? Number.NaN) : Number.NaN;

export function SettingsSearchResults({
	query,
	results,
	active,
	icons,
	onActive,
	onJump,
	onKeyDown,
	ref,
}: SettingsSearchResultsProps) {
	const t = useT();
	const current = Math.min(active, results.length - 1);
	return (
		<section
			data-settings-search=""
			data-testid="settings-search-results"
			className="flex flex-col gap-16"
		>
			<header className="flex flex-wrap items-baseline gap-x-8 gap-y-4 pr-[2rem]">
				<h2 className="tr-heading-sm text-text-default">
					{t("settings.search.results", { count: results.length })}
				</h2>
				<span className="min-w-0 wrap-anywhere tr-text-metadata text-text-muted">
					{t("settings.search.scope", { query: query.trim() })}
				</span>
			</header>
			{results.length === 0 ? (
				<p className="tr-text-ui text-text-muted">
					{t("settings.search.none", { query: query.trim() })}
				</p>
			) : (
				<div
					ref={ref}
					role="listbox"
					aria-label={t("settings.search.resultsLabel")}
					data-key-scope="settings"
					className="flex flex-col border-border-muted border-t"
					onKeyDown={(event) => {
						const index = indexOf(event.target);
						if (!Number.isNaN(index)) onKeyDown(event, index);
					}}
				>
					{results.map((result, index) => {
						const Icon = icons.get(result.entry.section) ?? RiSettings3Line;
						const { label, description } = result.entry;
						return (
							<button
								key={result.entry.id}
								type="button"
								role="option"
								aria-selected={index === current}
								tabIndex={index === current ? 0 : -1}
								data-testid="settings-search-result"
								data-result-id={result.entry.id}
								data-result-index={index}
								className="flex flex-col gap-2 border-border-muted border-b px-12 py-8 text-left transition-colors hover:bg-control-bg-hovered focus-visible:focus-ring-inset"
								onFocus={() => onActive(index)}
								onClick={(event: MouseEvent<HTMLButtonElement>) => {
									event.preventDefault();
									onJump(index);
								}}
							>
								<span className="flex items-center gap-4 tr-text-metadata text-text-muted">
									<Icon aria-hidden className="size-12 shrink-0" />
									<span className="min-w-0 wrap-anywhere">
										{highlightRanges(result.sectionLabel, result.ranges.section)}
									</span>
								</span>
								<span className="wrap-anywhere tr-text-ui text-text-default">
									{highlightRanges(label, result.ranges.label)}
								</span>
								{description ? (
									<span className="wrap-anywhere tr-text-metadata text-text-muted">
										{highlightRanges(description, result.ranges.description)}
									</span>
								) : null}
							</button>
						);
					})}
				</div>
			)}
		</section>
	);
}
