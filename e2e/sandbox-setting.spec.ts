import { expect, test } from "@playwright/test";
import { createWorkspaceViaDialog, openFixtureProject } from "./fixtures/app";
import { E2eWire } from "./fixtures/wire";

test("the Sandbox selection uses saved session state and survives browser refresh", async ({
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
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		expect((await snapshot()).summary.state?.sandbox).toBe(true);

		await page.reload();
		await expect(toggle).toHaveAttribute("aria-pressed", "true");
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-pressed", "false");
		expect((await snapshot()).summary.state?.sandbox).toBeUndefined();
	} finally {
		wire.close();
	}
});
