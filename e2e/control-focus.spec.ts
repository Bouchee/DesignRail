import { expect, type Locator, type Page, test } from "@playwright/test";
import { openFixtureProject, openWorkspaceChat } from "./fixtures/app";

test.use({ viewport: { width: 1440, height: 900 } });

async function tabTo(page: Page, target: Locator, key: "Tab" | "Shift+Tab" = "Tab"): Promise<void> {
	await expect(target).toBeVisible();
	for (let step = 0; step < 60; step += 1) {
		await page.keyboard.press(key);
		if (!(await target.evaluate((element) => element === document.activeElement))) continue;
		await expect(target).toBeFocused();
		expect(await target.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
		return;
	}
	throw new Error(`Keyboard navigation did not reach ${target}`);
}

async function expectOutline(target: Locator, offset: string): Promise<void> {
	await expect(target).toHaveCSS("outline-style", "solid");
	await expect(target).toHaveCSS("outline-width", "1px");
	await expect(target).toHaveCSS("outline-offset", offset);
}

test("Tab gives a flush toolbar icon an inset ring and a settings button an outset ring", async ({
	page,
}) => {
	await openFixtureProject(page);
	const settings = page.getByTestId("open-settings");
	await tabTo(page, settings, "Shift+Tab");
	await expectOutline(settings, "-1px");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("settings-dialog")).toBeVisible();

	await tabTo(page, page.getByTestId("settings-nav-providers"));
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("settings-providers")).toBeVisible();
	const addEndpoint = page.getByTestId("custom-endpoints-add");
	await tabTo(page, addEndpoint);
	await expectOutline(addEndpoint, "1px");
});

test("Tab rings the selected chat tab inside its underline and the composer only on its frame", async ({
	page,
}) => {
	await openWorkspaceChat(page);
	const input = page.getByTestId("chat-input");
	await input.click();
	const chatTab = page.locator('[data-testid="editor-tab"][data-kind="chat"][data-active="true"]');
	const tab = chatTab.getByRole("tab");
	await tabTo(page, tab, "Shift+Tab");
	await expect(tab).toHaveAttribute("aria-selected", "true");
	await expectOutline(chatTab, "-4px");
	await expect(tab).toHaveCSS("outline-style", "none");

	await tabTo(page, input);
	await expectOutline(page.getByTestId("chat-composer-shell"), "1px");
	await expect(input).toHaveCSS("outline-style", "none");
	await expect(input).toHaveCSS("box-shadow", "none");
	const outlinedAncestors = await input.evaluate((element) => {
		const outlined: string[] = [];
		for (let node: Element | null = element; node; node = node.parentElement) {
			const style = getComputedStyle(node);
			if (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) {
				outlined.push(node.getAttribute("data-testid") ?? node.tagName);
			}
			if (node.getAttribute("data-testid") === "chat-composer-shell") break;
		}
		return outlined;
	});
	expect(outlinedAncestors).toEqual(["chat-composer-shell"]);
});
