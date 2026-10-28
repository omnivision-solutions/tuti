import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_WIDGET_SLUG, CLOUD_URL, cloudPortalUrl } from "./env";
import { createProject, signUp } from "./helpers";

// On Tuti's cloud, whose team app shows its own project's widget (APP_WIDGET_PROJECT).
test("Tuti's own widget in the team app signs people in with their account once SSO is on, and isn't on portals", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Tuti", APP_WIDGET_SLUG, cloudPortalUrl);
  const launcher = owner.getByRole("button", { name: "Feedback" });
  const panel = owner.frameLocator('iframe[title="Feedback"]');

  // SSO off: the panel asks to sign in on the portal.
  await launcher.click();
  await expect(panel.getByRole("link", { name: "Sign in to post feedback" })).toBeVisible();

  // On, the app signs them in to the widget (Tuti.identify), as any app does.
  await owner.goto(`/app/${APP_WIDGET_SLUG}/settings/sso`);
  await owner.getByRole("button", { name: "Enable SSO" }).click();
  await expect(owner.getByRole("alert").filter({ hasText: "Copy your SSO secret now" })).toBeVisible();
  await owner.reload();
  await launcher.click();
  await panel.getByLabel("Title").fill("Export to CSV");
  await panel.getByRole("button", { name: "Submit post" }).click();
  await expect(panel.getByText("Feedback posted")).toBeVisible();
  await checkpoint(owner, "app-widget-signed-in");
  await expect(owner.locator('script[src$="/widget.js"]')).toHaveCount(1);

  // Signing out goes home without a reload, so the launcher stays: its panel is signed out too.
  await launcher.click();
  await owner.getByRole("button", { name: /Olive Owner/ }).click();
  await owner.getByRole("menuitem", { name: "Sign out" }).press("Enter");
  await owner.waitForURL(`${CLOUD_URL}/`);
  await launcher.click();
  await expect(panel.getByRole("link", { name: "Sign in to post feedback" })).toBeVisible();

  // Not on the marketing pages, nor on a portal: no script (the launcher would only come after it loads).
  const script = owner.locator('script[src$="/widget.js"]');
  await owner.goto("/");
  await expect(owner.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(script).toHaveCount(0);
  await expect(launcher).toHaveCount(0);
  await owner.goto(`${cloudPortalUrl(APP_WIDGET_SLUG)}/feedback/feature-requests`);
  await expect(owner.getByRole("link", { name: "Export to CSV" })).toBeVisible();
  await expect(script).toHaveCount(0);
  await expect(launcher).toHaveCount(0);
});
