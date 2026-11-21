import { expect, type Page, test } from "@playwright/test";
import { resetKeybindings, setKeybindings } from "./fixtures/keybindings";
import { E2eWire } from "./fixtures/wire";

async function openSettings(page: Page, section: string) {
	await page.goto("/");
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await page.getByTestId("open-settings").click();
	await page.getByTestId(`settings-nav-${section}`).click();
}

test("search jumps to the setting and Escape returns through the results and nav", async ({
	page,
}) => {
	await openSettings(page, "appearance");
	const dialog = page.getByTestId("settings-dialog");
	const search = page.getByTestId("settings-search");
	await page.keyboard.press("s");
	await expect(search).toBeFocused();
	await search.fill("message order");
	for (const key of ["ArrowDown", "Escape", "Enter"]) {
		await search.dispatchEvent("keydown", { key, isComposing: true });
		await expect(search).toBeFocused();
		await expect(search).toHaveValue("message order");
	}
	const hit = dialog.locator('[data-result-id="message-order"]');
	await expect(hit).toContainText("Chat");
	await expect(hit.locator("mark").first()).toHaveText(/message/i);
	await page.keyboard.press("ArrowDown");
	await expect(hit).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("settings-nav-chat")).toHaveAttribute("data-active", "true");
	await expect(dialog.locator('[data-setting-id="message-order"]')).toHaveAttribute(
		"data-setting-flash",
		"",
	);
	await expect(page.getByTestId("chat-order-oldest-first").locator("input")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(hit).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(search).toHaveValue("");
	await expect(search).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("settings-nav-chat")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
});

test("arrows walk from the settings nav into rows, and Delete resets the selected row", async ({
	page,
}) => {
	await openSettings(page, "chat");
	const nav = page.getByTestId("settings-nav-chat");
	const oldest = page.getByTestId("chat-order-oldest-first");
	const newest = page.getByTestId("chat-order-newest-first");
	const reset = page.getByTestId("settings-reset-message-order");
	await expect(nav).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(oldest.locator("input")).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(newest).toHaveAttribute("data-active", "true");
	await expect(newest.locator("input")).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(reset).toBeFocused();
	await page.keyboard.press("Delete");
	await expect(reset).toHaveCount(0);
	await expect(oldest).toHaveAttribute("data-active", "true");
	await page.keyboard.press("ArrowDown");
	await expect(
		page.getByTestId("composer-growth-control").locator('input[tabindex="0"]'),
	).toBeFocused();
});

test("Settings search, arrow aliases and reset use the current shortcuts", async ({ page }) => {
	await openSettings(page, "chat");
	const nav = page.getByTestId("settings-nav-chat");
	const search = page.getByTestId("settings-search");
	const newest = page.getByTestId("chat-order-newest-first");
	await setKeybindings(page, {
		"settings.nav.search": ["KeyQ"],
		"arrows.right": ["KeyW"],
		"settings.reset": ["KeyX"],
	});
	try {
		await expect(search).toHaveAttribute("aria-keyshortcuts", "Q");
		await page.keyboard.press("s");
		await expect(nav).toBeFocused();
		await page.keyboard.press("q");
		await expect(search).toBeFocused();
		await page.keyboard.press("Escape");
		await page.keyboard.press("w");
		await expect(page.getByTestId("chat-order-oldest-first").locator("input")).toBeFocused();
		await page.keyboard.press("ArrowRight");
		await expect(newest).toHaveAttribute("data-active", "true");
		await page.keyboard.press("Delete");
		await expect(newest).toHaveAttribute("data-active", "true");
		await page.keyboard.press("x");
		await expect(page.getByTestId("chat-order-oldest-first")).toHaveAttribute(
			"data-active",
			"true",
		);
	} finally {
		await resetKeybindings(page);
	}
});

test.describe("expensive settings choices", () => {
	test.afterEach(async ({ baseURL }) => {
		if (!baseURL) throw new Error("Settings keyboard fixtures require the isolated host URL");
		const wire = await E2eWire.connect(Number(new URL(baseURL).port));
		try {
			await wire.request("settings.update", { config: { locale: "system" } });
		} finally {
			wire.close();
		}
	});

	test("language arrows preview without applying and Enter applies the pending choice", async ({
		page,
	}) => {
		await openSettings(page, "language");
		const system = page.getByTestId("language-system");
		const english = page.getByTestId("language-en");
		await expect(system).toHaveAttribute("data-active", "true");
		await page.keyboard.press("ArrowRight");
		await expect(system.locator("input")).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(english.locator("input")).toBeFocused();
		await expect(english).toHaveAttribute("data-pending", "true");
		await expect(system).toHaveAttribute("data-active", "true");
		await page.keyboard.press("Escape");
		await expect(system.locator("input")).toBeFocused();
		await expect(english).not.toHaveAttribute("data-pending", "true");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await expect(english).toHaveAttribute("data-active", "true");
		await page.keyboard.press("Delete");
		await expect(system).toHaveAttribute("data-active", "true");
	});
});
