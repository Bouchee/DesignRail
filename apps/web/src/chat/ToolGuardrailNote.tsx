import { RiShieldLine as Shield } from "@remixicon/react";
import type { ToolGuardrailOutcome } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { cn } from "@thinkrail/ui/utils";

export function ToolGuardrailNote({
	outcome,
	className,
}: {
	outcome: ToolGuardrailOutcome;
	className?: string;
}) {
	const t = useT();
	return (
		<div
			data-testid="tool-guardrail"
			data-stage={outcome.stage}
			className={cn("flex items-center gap-4 text-text-muted tr-text-metadata", className)}
		>
			<Shield className="size-12 shrink-0" />
			<span className="min-w-0">
				{t(outcome.stage === "input" ? "chat.toolGuardrail.input" : "chat.toolGuardrail.output", {
					rule: outcome.rule,
				})}
			</span>
		</div>
	);
}
