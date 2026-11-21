import { isImeComposing } from "@thinkrail/ui/keyboard";
import { cn } from "@thinkrail/ui/utils";

export interface SegmentedControlOption<T extends string> {
	id: T;
	label: string;
	testId?: string;
	disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
	name: string;
	label: string;
	options: readonly SegmentedControlOption<T>[];
	value: T | null;
	onSelect: (value: T) => void;
	disabled?: boolean;
	testId?: string;
}

export function SegmentedControl<T extends string>({
	name,
	label,
	options,
	value,
	onSelect,
	disabled = false,
	testId,
}: SegmentedControlProps<T>) {
	const selected = options.find((option) => option.id === value && !option.disabled);
	const tabStop = selected?.id ?? options.find((option) => !option.disabled)?.id;
	return (
		<div
			role="radiogroup"
			aria-label={label}
			data-testid={testId}
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
				const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
				if (!delta) return;
				const items = Array.from(
					event.currentTarget.querySelectorAll<HTMLInputElement>("input:not(:disabled)"),
				);
				const target = items[items.indexOf(event.target) + delta];
				if (!target) return;
				event.preventDefault();
				target.focus();
				target.click();
			}}
			className="inline-flex h-32 overflow-hidden rounded-sm bg-control-bg"
		>
			{options.map((option) => {
				const selected = value !== null && option.id === value;
				const optionDisabled = disabled || option.disabled === true;
				return (
					<label
						key={option.id}
						data-testid={option.testId}
						data-active={selected}
						className={cn(
							"relative cursor-pointer transition-colors",
							optionDisabled && "cursor-default",
						)}
					>
						<input
							type="radio"
							name={name}
							value={option.id}
							checked={selected}
							disabled={optionDisabled}
							tabIndex={tabStop === option.id ? 0 : -1}
							onChange={() => onSelect(option.id)}
							className="peer sr-only inset-0"
						/>
						<span
							className={cn(
								"flex h-32 items-center px-12 tr-text-ui transition-colors",
								selected
									? "rounded-sm bg-control-bg-selected text-text-default"
									: "text-text-muted hover:text-text-default",
								"peer-focus-visible:focus-ring-inset",
								"peer-disabled:text-control-disabled-text peer-disabled:hover:text-control-disabled-text",
							)}
						>
							{option.label}
						</span>
					</label>
				);
			})}
		</div>
	);
}
