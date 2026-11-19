import { tool } from "@openai/agents";
import type { Static, TObject } from "typebox";
import { Value } from "typebox/value";

export function defineTypeBoxTool<Schema extends TObject, Result>({
	parameters,
	invalidArgumentsMessage = "Invalid tool arguments",
	execute,
	...options
}: {
	name: string;
	description: string;
	parameters: Schema;
	needsApproval?: boolean;
	invalidArgumentsMessage?: string;
	execute: (args: Static<Schema>) => Promise<Result>;
}) {
	const schema: TObject = parameters;
	const sdkTool = tool({
		...options,
		strict: false,
		parameters: { ...schema, required: schema.required ?? [], additionalProperties: true },
		errorFunction: null,
		// The invoke boundary checks the TypeBox shape before the SDK calls execute.
		execute: execute as (args: unknown) => Promise<Result>,
	});
	const invoke = sdkTool.invoke;
	sdkTool.invoke = async (context, input, details) => {
		let args: unknown;
		try {
			args = JSON.parse(input);
		} catch {
			return invoke(context, input, details);
		}
		if (!Value.Check(parameters, args)) throw new Error(invalidArgumentsMessage);
		return invoke(context, input, details);
	};
	return sdkTool;
}
