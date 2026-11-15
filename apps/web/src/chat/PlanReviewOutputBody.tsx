import type { PlanReviewOutput } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";

export function PlanReviewOutputBody({ value }: { value: PlanReviewOutput }) {
	const t = useT();
	return (
		<div
			data-testid="plan-review-output"
			data-verdict={value.verdict}
			className="flex flex-col gap-8 tr-text-reading text-text-default"
		>
			<strong>
				{t(
					value.verdict === "approve"
						? "tools.requestReview.approved"
						: "tools.requestReview.changesRequested",
				)}
			</strong>
			{value.summary ? <p className="whitespace-pre-wrap">{value.summary}</p> : null}
			{value.findings.length ? (
				<ul className="list-inside list-disc space-y-4">
					{value.findings.map((finding, index) => (
						<li key={`${index}:${finding.id}`} className="whitespace-pre-wrap">
							{finding.path ? (
								<span className="tr-code-text text-text-muted">
									{finding.path}
									{finding.startLine
										? `:${finding.startLine}${finding.endLine ? `-${finding.endLine}` : ""}`
										: ""}{" "}
								</span>
							) : null}
							{finding.body}
						</li>
					))}
				</ul>
			) : null}
			{value.readingOrder?.length ? (
				<div>
					<span className="text-text-muted">{t("changes.guide.readingOrder")}</span>
					<ol className="mt-4 list-inside list-decimal">
						{value.readingOrder.map((step, index) => (
							<li key={`${index}:${step.path}`}>
								<span className="tr-code-text">{step.path}</span> {step.why}
							</li>
						))}
					</ol>
				</div>
			) : null}
		</div>
	);
}
