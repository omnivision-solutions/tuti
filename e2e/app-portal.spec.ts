import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_PORTAL_SLUG, APP_URL, portalUrl } from "./env";
import { createProject, signUp } from "./helpers";

test("Tuti's own portal on the app's domain: one sign-in for the app and the portal, and the rest of the app as it was", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Tuti", APP_PORTAL_SLUG);

  // Signed in on the app, so signed in on its portal too.
  await owner.goto("/feedback/feature-requests");
  await expect(owner.getByRole("heading", { name: "Feature requests" })).toBeVisible();
  await owner.getByLabel("Title").fill("Dark mode for the dashboard");
  await owner.getByRole("button", { name: "Submit feedback" }).click();
  await owner.getByRole("link", { name: "Dark mode for the dashboard" }).click();
  await owner.waitForURL(`${APP_URL}/feedback/feature-requests/dark-mode-for-the-dashboard-1`);
  await checkpoint(owner, "app-portal-post");
  // The account is the app's.
  await owner.getByRole("button", { name: "Account" }).click();
  await owner.getByRole("menuitem", { name: "Account settings" }).click();
  await owner.waitForURL(`${APP_URL}/app/account`);

  // The rest of the app is as it was: its home, and the API reference under /docs.
  await owner.goto("/docs/api");
  await expect(owner.getByRole("heading", { level: 1 })).toBeVisible();
  expect(owner.url()).toBe(`${APP_URL}/docs/api`);

  // Its Tuti address shows it too (production sends people on to the app's domain, see
  // app-portal.db.test.ts; locally Next.js would make that redirect a loop).
  const visitor = await browser.newPage();
  await visitor.goto(`${portalUrl(APP_PORTAL_SLUG)}/roadmap`);
  await expect(visitor.getByRole("heading", { name: "Roadmap" })).toBeVisible();
});
