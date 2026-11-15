import { expect, test } from "bun:test";
import type { PlanReviewResult, TodoItem, TodoPlan } from "@thinkrail/contracts";
import { composeText, itemTitleOf, normalizeVerdict } from "./requestReview";

const ID = "t_1";
const TITLE = "Wire login redirect";

test("normalizeVerdict stamps host identity and keeps finding normalization", () => {
	const result = normalizeVerdict(
		{
			verdict: "request_changes",
			summary: "off-by-one",
			findings: [{ id: "f1", path: "src/a.ts", startLine: 4, endLine: 6, body: "loop bound" }],
		},
		ID,
		TITLE,
	);
	expect(result).toMatchObject({
		itemId: ID,
		itemTitle: TITLE,
		verdict: "request_changes",
		findings: [
			{ id: "f1", kind: "inline", body: "loop bound", path: "src/a.ts", startLine: 4, endLine: 6 },
		],
	});
});
test("normalizeVerdict normalizes paths and accepts an approve without findings", () => {
	const result = normalizeVerdict(
		{
			verdict: "request_changes",
			findings: [{ id: "f1", path: "src\\x.ts", startLine: 2, body: "b" }],
			readingOrder: [{ path: "C:\\repo\\src\\x.ts", why: "w" }],
		},
		ID,
		TITLE,
	);
	expect(result?.findings[0]?.path).toBe("src/x.ts");
	expect(result?.readingOrder).toEqual([{ path: "C:/repo/src/x.ts", why: "w" }]);
	expect(normalizeVerdict({ verdict: "approve", findings: [] }, ID, TITLE)?.verdict).toBe(
		"approve",
	);
});
test("normalizeVerdict rejects obsolete text and invalid model objects", () => {
	for (const output of [
		undefined,
		"no json",
		"```json\n{}\n```",
		'{"verdict":"approve","findings":[]}',
		{ verdict: "maybe", findings: [] },
		{ verdict: "approve", findings: [{ id: "f1" }] },
		{ verdict: "request_changes", findings: [] },
	])
		expect(normalizeVerdict(output, ID, TITLE)).toBeNull();
});

const CHANGES: PlanReviewResult = {
	itemId: "t_1",
	itemTitle: "Wire login",
	verdict: "request_changes",
	summary: "one bug",
	findings: [
		{ id: "f1", kind: "inline", body: "off-by-one", path: "a.ts", startLine: 4, endLine: 6 },
	],
};

test("composeText tracks the fix budget: a live cycle tells the worker to fix, a spent one to wait", () => {
	const on = composeText(CHANGES, { kind: "changes", canAutoFix: true });
	expect(on).toContain("REQUEST_CHANGES");
	expect(on).toContain("request_review again");
	expect(on).toContain("[f1] (a.ts:4-6) off-by-one");

	const off = composeText(CHANGES, { kind: "changes", canAutoFix: false });
	expect(off).toContain("spent or auto-fix is off");
	expect(off).toContain("do NOT fix now");
	expect(off).not.toContain("request_review again");
});

test("an approve the host refused to settle tells the worker to resolve, not that it is done", () => {
	const text = composeText(
		{ ...CHANGES, verdict: "approve", findings: [] },
		{
			kind: "approve-blocked",
			openFindings: 2,
		},
	);
	expect(text).toContain("NOT settled");
	expect(text).toContain("2 earlier findings");
	expect(text).toContain("resolve_comment");
});

test("composeText for approve names the step and never asks for a fix", () => {
	const text = composeText({ ...CHANGES, verdict: "approve", findings: [] }, { kind: "approved" });
	expect(text).toContain("APPROVE");
	expect(text).not.toContain("REQUEST_CHANGES");
});

test("normalizeVerdict rejects model host-only fields and defaults optional finding kind", () => {
	expect(
		normalizeVerdict({ verdict: "approve", findings: [], blockedByOpenFindings: 5 }, ID, TITLE),
	).toBeNull();
	expect(
		normalizeVerdict({ verdict: "approve", findings: [], itemId: "forged" }, ID, TITLE),
	).toBeNull();
	expect(
		normalizeVerdict(
			{ verdict: "request_changes", findings: [{ id: "local", body: "no location" }] },
			ID,
			TITLE,
		)?.findings[0],
	).toEqual({ id: "local", kind: "inline", body: "no location" });
});

test("itemTitleOf resolves stored, grouped and adopted items while retaining an unknown id", async () => {
	const item = (id: string): TodoItem => ({
		id,
		title: `Title ${id}`,
		status: "done",
		origin: "agent",
		createdAt: "",
		updatedAt: "",
	});
	const plan: TodoPlan = {
		todos: [item("stored")],
		groups: [{ id: "g", title: "Group", status: "done", todos: [item("grouped")] }],
		adoptedCommits: [item("commit:abc")],
	};
	const scopes: Array<{ workspaceId: string; sessionId: string }> = [];
	for (const id of ["stored", "grouped", "commit:abc", "missing"]) {
		const title = await itemTitleOf("workspace", "session", id, async (scope) => {
			scopes.push(scope);
			return plan;
		});
		expect(title).toBe(id === "missing" ? id : `Title ${id}`);
	}
	expect(scopes).toEqual(
		Array.from({ length: 4 }, () => ({ workspaceId: "workspace", sessionId: "session" })),
	);
});
