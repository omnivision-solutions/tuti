import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_WIDGET_SLUG, CLOUD_URL, cloudPortalUrl } from "./env";
import { createProject, signUp } from "./helpers";

// On Tuti's cloud, which shows its own project's widget (APP_WIDGET_PROJECT) on its pages.
test("Tuti's own widget is on its home and the team app, and not on a team's portal", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Tuti", APP_WIDGET_SLUG, cloudPortalUrl);

  await owner.goto(`/app/${APP_WIDGET_SLUG}`);
  const launcher = owner.getByRole("button", { name: "Feedback" });
  await launcher.click();
  // The panel is on the project's portal, another host, so it asks to sign in there.
  await expect(owner.frameLocator('iframe[title="Feedback"]').getByRole("link", { name: "Sign in to post feedback" })).toBeVisible();
  await checkpoint(owner, "app-widget-team-app");

  await owner.goto("/");
  await expect(launcher).toBeVisible();

  await owner.goto(`${cloudPortalUrl(APP_WIDGET_SLUG)}/feedback/feature-requests`);
  await expect(owner.getByRole("heading", { name: "Feature requests" })).toBeVisible();
  await expect(launcher).toHaveCount(0);
});
