import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_WIDGET_SLUG, CLOUD_URL, cloudPortalUrl } from "./env";
import { createProject, signUp } from "./helpers";

// On Tuti's cloud, whose team app shows its own project's widget (APP_WIDGET_PROJECT).
test("Tuti's own widget in the team app signs people in with their account once SSO is on, and isn't on the signed-out pages", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Tuti", APP_WIDGET_SLUG, cloudPortalUrl);
  // The launcher, not the home page's Feedback tab.
  const launcher = owner.locator('body > button[aria-controls="tuti-widget"]');
  const panel = owner.frameLocator('iframe[title="Feedback"]');

  // SSO off: the panel asks to sign in on the portal.
  await launcher.click();
  await panel.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(panel.getByRole("button", { name: "Sign in to post" })).toBeVisible();

  // Not on Customize, whose previews show the project's own widget: opened there, the app doesn't install it…
  const appLauncher = owner.locator('body > button[aria-controls="tuti-widget"]');
  const script = owner.locator('script[src*="/widget.js"]');
  const sidebar = owner.locator('[data-slot="sidebar"][data-state]');
  await owner.goto(`/app/${APP_WIDGET_SLUG}/customize/widget`);
  const previewLauncher = owner.getByRole("figure", { name: "Widget preview" }).getByRole("button", { name: "Launcher: Feedback" });
  await expect(previewLauncher).toBeVisible();
  await checkpoint(owner, "app-widget-customize-widget", { fullPage: false });
  // The preview's panel closing means the page is hydrated, so the app would have added the script by now
  // (a click before that does nothing: clicked again until it closes).
  await expect(async () => {
    await previewLauncher.click();
    await expect(previewLauncher).toHaveAttribute("aria-expanded", "false", { timeout: 1_000 });
  }).toPass();
  await expect(script).toHaveCount(0);
  await expect(appLauncher).toHaveCount(0);
  // …it comes on leaving, and when Customize opens from another page it's closed (if it was open) and away; back after.
  await sidebar.getByRole("link", { name: "Settings", exact: true }).click();
  // Waited for: until it's there, "Feedback" also names the preview's launcher, still on the page.
  await expect(appLauncher).toBeVisible();
  // Under the app's dialogs (⌘K's here), still over the page.
  const onTop = () =>
    appLauncher.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    });
  expect(await onTop()).toBe(true);
  await owner.keyboard.press("ControlOrMeta+k");
  await expect(owner.getByRole("dialog")).toBeVisible();
  expect(await onTop()).toBe(false);
  await checkpoint(owner, "app-widget-under-dialog", { fullPage: false });
  await owner.keyboard.press("Escape");
  // On a phone, scrolled to its end, the page ends clear of it.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const pageEnd = await owner.evaluate(() => {
    const page = document.querySelector("[data-app-widget]")!.parentElement!;
    return Math.max(...[...page.children].filter((child) => child.tagName !== "STYLE").map((child) => child.getBoundingClientRect().bottom));
  });
  expect(pageEnd).toBeLessThanOrEqual((await appLauncher.boundingBox())!.y);
  await checkpoint(owner, "app-widget-phone-page-end", { fullPage: false });
  // Over the tab bar on a list, its More still in reach; with a little more room, the floating panel opens above it.
  await owner.goto(`/app/${APP_WIDGET_SLUG}/feedback`);
  const tabBar = owner.getByRole("navigation", { name: "Main" });
  const more = tabBar.getByRole("button", { name: "More" });
  await expect.poll(async () => (await appLauncher.boundingBox())!.y + (await appLauncher.boundingBox())!.height).toBeLessThanOrEqual((await tabBar.boundingBox())!.y);
  // However long the list, its end scrolls clear of the raised launcher: the page leaves that much room at its bottom.
  const room = await owner.evaluate(() => parseFloat(getComputedStyle(document.querySelector("[data-app-widget]")!.parentElement!).paddingBottom));
  expect(room).toBeGreaterThanOrEqual(844 - (await appLauncher.boundingBox())!.y);
  const moreBox = (await more.boundingBox())!;
  expect(await more.evaluate((button, [x, y]) => button.contains(document.elementFromPoint(x!, y!)), [moreBox.x + moreBox.width / 2, moreBox.y + moreBox.height / 2])).toBe(true);
  await owner.setViewportSize({ width: 700, height: 900 });
  await launcher.click();
  const floating = owner.locator("#tuti-widget");
  await expect(floating).toBeVisible();
  await expect.poll(async () => (await floating.boundingBox())!.y + (await floating.boundingBox())!.height).toBeLessThanOrEqual((await appLauncher.boundingBox())!.y);
  await launcher.click();
  await expect(floating).toBeHidden();
  await owner.setViewportSize({ width: 1280, height: 720 });
  await launcher.click();
  await expect(panel.getByRole("navigation", { name: "Widget" })).toBeVisible();
  await sidebar.getByRole("link", { name: "Customize", exact: true }).click();
  await expect(owner.getByRole("navigation", { name: "Customize" })).toBeVisible();
  await expect(appLauncher).toBeAttached();
  await expect(appLauncher).toBeHidden();
  await expect(owner.locator("#tuti-widget")).toBeHidden();
  await sidebar.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(appLauncher).toBeVisible();
  await expect(appLauncher).toHaveAttribute("aria-expanded", "false");
  await expect(owner.locator("#tuti-widget")).toBeHidden();
  // Nor in the Inbox, where the team chats with its own customers.
  await sidebar.getByRole("link", { name: /^Inbox/ }).click();
  await expect(owner).toHaveURL(/\/inbox/);
  await expect(appLauncher).toBeHidden();
  await checkpoint(owner, "app-widget-not-in-inbox", { fullPage: false });
  await sidebar.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(appLauncher).toBeVisible();

  // On, the app signs them in to the widget (Tuti.identify), as any app does.
  await owner.goto(`/app/${APP_WIDGET_SLUG}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" })).toBeVisible();
  await owner.reload();
  await launcher.click();
  await panel.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await panel.getByLabel("Title").fill("Export to CSV");
  await panel.getByRole("button", { name: "Submit post" }).click();
  await expect(panel.getByText("Feedback posted")).toBeVisible();
  await checkpoint(owner, "app-widget-signed-in");
  await expect(owner.locator('script[src$="/widget.js"]')).toHaveCount(1);

  // Signing out goes to signing in without a reload, so the launcher stays: its panel is signed out too.
  await launcher.click();
  await owner.getByRole("button", { name: /Olive Owner/ }).click();
  await owner.getByRole("menuitem", { name: "Sign out" }).press("Enter");
  await owner.waitForURL(`${CLOUD_URL}/app/auth/sign-in`);
  await launcher.click();
  await expect(panel.getByRole("button", { name: "Sign in to post" })).toBeVisible();

  // Not on the signed-out pages, loaded afresh: no script (the launcher would only come after it loads).
  await owner.goto("/app/auth/sign-in");
  await expect(owner.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(script).toHaveCount(0);
  await expect(launcher).toHaveCount(0);
  await owner.goto(`${cloudPortalUrl(APP_WIDGET_SLUG)}/feedback/feature-requests`);
  await expect(owner.getByRole("link", { name: "Export to CSV" })).toBeVisible();
  // On a portal, the project's own widget (Customize → Widget, on by default) as any site has it: one script, not the app's too.
  await expect(script).toHaveCount(1);
  await expect(script).toHaveAttribute("data-project", APP_WIDGET_SLUG);
});
