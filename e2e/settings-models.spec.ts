import { expect, type Page, test } from "@playwright/test";
import { openWorkspaceChat } from "./fixtures/app";
import { installChannelHold } from "./fixtures/channelHold";
import { E2eWire } from "./fixtures/wire";

async function openModels(page: Page) {
	if (!(await page.getByTestId("settings-dialog").isVisible()))
		await page.getByTestId("open-settings").click();
	await page.getByTestId("settings-nav-models").click();
	await expect(page.getByTestId("settings-auto-summary")).toBeVisible();
}

test("model settings expose the accepted default without unavailable agent controls", async ({
	page,
}) => {
	await openWorkspaceChat(page);
	await page.getByTestId("open-settings").click();
	await page.getByTestId("settings-nav-models").click();
	await expect(page.getByTestId("settings-models")).toBeVisible();
	await expect(page.getByTestId("default-model-row")).toContainText("deepseek-v4.1-flash");
	await expect(page.getByTestId("models-review-group")).toHaveCount(0);
	await expect(page.getByTestId("settings-cache-warming")).toHaveCount(0);
});

test("summary timing converges on broadcast across windows and survives reopen and reload", async ({
	page,
	context,
}) => {
	const hold = await installChannelHold(page);
	await openWorkspaceChat(page);
	const wire = await E2eWire.connect();
	const peer = await context.newPage();
	let release = () => {};
	try {
		await wire.request("settings.update", { config: { autoSummaryThresholdPercent: 75 } });
		await peer.goto(page.url());
		await expect(peer.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
		await openModels(page);
		await openModels(peer);
		await expect(page.getByTestId("auto-summary-75")).toContainText("Default");
		await expect(page.getByTestId("settings-auto-summary")).toContainText("estimated");
		const frame = hold.arm("settings.changed");
		release = frame.release;
		await page.getByTestId("auto-summary-50").click();
		await frame.held;
		await expect(page.getByTestId("auto-summary-75")).toHaveAttribute("data-active", "true");
		await expect(peer.getByTestId("auto-summary-50")).toHaveAttribute("data-active", "true");
		release();
		await expect(page.getByTestId("auto-summary-50")).toHaveAttribute("data-active", "true");
		await page.getByTestId("settings-dialog").getByRole("button", { name: "Close" }).click();
		await openModels(page);
		await expect(page.getByTestId("auto-summary-50")).toHaveAttribute("data-active", "true");
		await page.reload();
		await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
		await openModels(page);
		await expect(page.getByTestId("auto-summary-50")).toHaveAttribute("data-active", "true");
		await page.getByTestId("auto-summary-90").click();
		await expect(page.getByTestId("auto-summary-90")).toHaveAttribute("data-active", "true");
		await expect(peer.getByTestId("auto-summary-90")).toHaveAttribute("data-active", "true");
	} finally {
		release();
		await wire.request("settings.update", { config: { autoSummaryThresholdPercent: 75 } });
		wire.close();
		await peer.close();
	}
});

test("summary timing disables pending writes and preserves the host choice on save failure", async ({
	page,
}) => {
	const pending = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let rejected = false;
	await page.routeWebSocket(/\/ws(\?|$)/, (browser) => {
		const server = browser.connectToServer();
		browser.onMessage((message) => {
			const frame = JSON.parse(message.toString()) as {
				id?: string;
				method?: string;
				params?: { config?: { autoSummaryThresholdPercent?: number } };
			};
			if (
				!rejected &&
				frame.id &&
				frame.method === "settings.update" &&
				frame.params?.config?.autoSummaryThresholdPercent === 50
			) {
				rejected = true;
				pending.resolve();
				void release.promise.then(() =>
					browser.send(
						JSON.stringify({ id: frame.id, ok: false, error: "Fixture settings write failed" }),
					),
				);
				return;
			}
			server.send(message);
		});
		server.onMessage((message) => browser.send(message));
	});
	await openWorkspaceChat(page);
	const wire = await E2eWire.connect();
	try {
		await wire.request("settings.update", { config: { autoSummaryThresholdPercent: 75 } });
		await openModels(page);
		await page.getByTestId("auto-summary-50").click();
		await pending.promise;
		for (const percent of [50, 75, 90])
			await expect(page.getByTestId(`auto-summary-${percent}`).getByRole("radio")).toBeDisabled();
		await expect(page.getByTestId("auto-summary-75")).toHaveAttribute("data-active", "true");
		release.resolve();
		await expect(page.getByText("Fixture settings write failed")).toBeVisible();
		await expect(page.getByTestId("auto-summary-50").getByRole("radio")).toBeEnabled();
		await expect(page.getByTestId("auto-summary-75")).toHaveAttribute("data-active", "true");
		await page.getByTestId("auto-summary-50").click();
		await expect(page.getByTestId("auto-summary-50")).toHaveAttribute("data-active", "true");
	} finally {
		release.resolve();
		await wire.request("settings.update", { config: { autoSummaryThresholdPercent: 75 } });
		wire.close();
	}
});
