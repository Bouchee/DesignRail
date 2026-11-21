import { RiCheckLine as Check } from "@remixicon/react";
import { useT } from "@thinkrail/locales/react";
import { isImeComposing } from "@thinkrail/ui/keyboard";
import { cn } from "@thinkrail/ui/utils";
import { useState } from "react";

export interface SettingsRadioChoice<T extends string> {
	id: T;
	label: string;
	hint?: string;
	description: string;
	testId: string;
	disabled?: boolean;
}

export function SettingsRadioCards<T extends string>({
	name,
	label,
	choices,
	value,
	disabled = false,
	confirmChoice = false,
	onSelect,
}: {
	name: string;
	label: string;
	choices: readonly SettingsRadioChoice<T>[];
	value: T;
	disabled?: boolean;
	confirmChoice?: boolean;
	onSelect: (value: T) => void;
}) {
	const t = useT();
	const [pending, setPending] = useState<string | null>(null);
	const applied = choices.find((choice) => choice.id === value && !choice.disabled);
	const tabStop = pending ?? applied?.id ?? choices.find((choice) => !choice.disabled)?.id;
	return (
		<div
			role="radiogroup"
			aria-label={label}
			className="flex flex-col gap-4"
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setPending(null);
			}}
			onKeyDown={(event) => {
				if (
					isImeComposing(event.nativeEvent) ||
					event.altKey ||
					event.ctrlKey ||
					event.metaKey ||
					event.shiftKey
				)
					return;
				if (!(event.target instanceof HTMLInputElement)) return;
				const items = Array.from(
					event.currentTarget.querySelectorAll<HTMLInputElement>("input:not(:disabled)"),
				);
				const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
				if (delta) {
					const target = items[items.indexOf(event.target) + delta];
					if (!target) return;
					event.preventDefault();
					target.focus();
					if (confirmChoice) setPending(target.value === value ? null : target.value);
					else target.click();
				} else if (confirmChoice && pending !== null && event.key === "Escape") {
					event.preventDefault();
					setPending(null);
					(items.find((item) => item.value === value) ?? items[0])?.focus();
				} else if (confirmChoice && pending !== null && event.key === "Enter") {
					event.preventDefault();
					event.target.click();
				}
			}}
		>
			{choices.map((choice) => {
				const active = choice.id === value;
				const choiceDisabled = disabled || choice.disabled === true;
				return (
					<label
						key={choice.id}
						data-testid={choice.testId}
						data-active={active}
						data-pending={pending === choice.id || undefined}
						className={cn(
							"flex items-center gap-8 rounded-sm border px-12 py-8 text-left transition-colors has-[:focus-visible]:focus-ring",
							choiceDisabled ? "cursor-default" : "cursor-pointer",
							active
								? "border-primary-muted bg-clip-padding bg-primary-subtle"
								: "border-border-default hover:bg-control-bg-hovered",
						)}
					>
						<input
							type="radio"
							name={name}
							value={choice.id}
							checked={active}
							disabled={choiceDisabled}
							tabIndex={choice.id === tabStop ? 0 : -1}
							onChange={() => {
								setPending(null);
								onSelect(choice.id);
							}}
							className="sr-only"
						/>
						<span className="min-w-0 flex-1">
							<span className="flex items-center gap-4 tr-title-compact text-text-default">
								{choice.label}
								{choice.hint ? (
									<span className="text-text-muted tr-text-metadata">{choice.hint}</span>
								) : null}
							</span>
							<span className="block text-text-muted tr-text-metadata">{choice.description}</span>
						</span>
						{active ? <Check className="size-16 shrink-0 text-primary" /> : null}
					</label>
				);
			})}
			{pending !== null ? (
				<p role="status" className="text-text-muted tr-text-metadata">
					{t("settings.row.apply")}
				</p>
			) : null}
		</div>
	);
}
