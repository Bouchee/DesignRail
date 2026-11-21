import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { cn } from "@thinkrail/ui/utils";
import type { ReactNode } from "react";
import { focusUnitStop } from "./settingsWalk";

export const SETTINGS_ROWS_CONTAINER = "flex flex-col [&>*:last-child]:border-b-0";

export interface SettingsRowProps {
	label: string;
	description?: ReactNode;
	control: ReactNode;
	testId?: string;
	settingId?: string;
	reset?: { changed: boolean; onReset: () => void };
	noBorder?: boolean;
	className?: string;
}

export function SettingsRow({
	label,
	description,
	control,
	testId,
	settingId,
	reset,
	noBorder = false,
	className,
}: SettingsRowProps) {
	const t = useT();
	return (
		<div
			data-testid={testId}
			data-setting-row={settingId ?? testId ?? label}
			data-setting-id={settingId}
			data-changed={reset?.changed || undefined}
			className={cn(
				"flex flex-wrap items-center justify-between gap-12 py-12",
				!noBorder && "border-border-muted border-b",
				className,
			)}
		>
			<div className="flex min-w-160 flex-1 flex-col gap-2">
				<span className="flex flex-wrap items-center gap-4 tr-text-ui text-text-default">
					{label}
					{reset?.changed ? (
						<span className="text-primary tr-text-label-pill">{t("settings.row.changed")}</span>
					) : null}
				</span>
				{description ? (
					<span className="tr-text-metadata text-text-muted">{description}</span>
				) : null}
			</div>
			<div className="flex max-w-full flex-wrap items-center gap-4">
				<div data-setting-control="" className="max-w-full">
					{control}
				</div>
				{reset?.changed ? (
					<Button
						type="button"
						size="s"
						variant="ghost"
						tabIndex={0}
						aria-label={t("settings.row.resetLabel", { label })}
						data-setting-side=""
						data-setting-reset=""
						data-testid={settingId ? `settings-reset-${settingId}` : undefined}
						onClick={(event) => {
							focusUnitStop<HTMLElement>(event.currentTarget);
							reset.onReset();
						}}
					>
						{t("settings.row.reset")}
					</Button>
				) : null}
			</div>
		</div>
	);
}
