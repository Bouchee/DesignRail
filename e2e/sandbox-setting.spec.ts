import { expect, test } from "@playwright/test";
import { createWorkspaceViaDialog, openFixtureProject } from "./fixtures/app";
import { E2eWire } from "./fixtures/wire";

test("Sandbox and retained memory use saved session state after browser refresh", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const wire = await E2eWire.connect();
	try {
		const [session] = await wire.request("session.list", { workspaceId: workspace.id });
		if (!session) throw new Error("The workspace has no session");
		const snapshot = () =>
			wire.request("session.getMessages", {
				workspaceId: workspace.id,
				sessionId: session.sessionId,
			});
		const toggle = page.getByRole("button", { name: "Sandbox", exact: true });
		const memory = page.getByRole("button", { name: "Retained memory", exact: true });
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await expect(memory).toHaveCount(0);
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		expect((await snapshot()).summary.state?.sandbox).toBe(true);
		await expect(memory).toHaveAttribute("aria-pressed", "false");
		await memory.click();
		await expect(memory).toHaveAttribute("aria-pressed", "true");
		expect((await snapshot()).summary.state?.sandboxMemory).toBe(true);

		await page.reload();
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		await expect(memory).toHaveAttribute("aria-pressed", "true");
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await expect(memory).toHaveCount(0);
		const state = (await snapshot()).summary.state;
		expect(state?.sandbox).toBeUndefined();
		expect(state?.sandboxMemory).toBeUndefined();
	} finally {
		wire.close();
	}
});
