import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_PORTAL_OWNER, APP_PORTAL_SLUG, APP_URL, portalUrl } from "./env";
import { createProject, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";

test("Tuti's own portal under its path on the app's domain: one sign-in for the app and the portal, and the rest of the app as it was", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  // Only its owner can create the project, once their address is verified.
  const owner = await signUp(browser, APP_URL, "Olive Owner", APP_PORTAL_OWNER);
  await owner.goto(linkIn(await latestEmailTo(APP_PORTAL_OWNER), `${APP_URL}/api/auth/verify-email`));
  await createProject(owner, "Tuti", APP_PORTAL_SLUG);
  const own = `${APP_URL}/${APP_PORTAL_SLUG}`;

  // Signed in on the app, so signed in on its portal too.
  await owner.goto(`${own}/feedback/feature-requests`);
  await expect(owner.getByRole("heading", { name: "Feature requests" })).toBeVisible();
  await owner.getByLabel("Title").fill("Dark mode for the dashboard");
  await owner.getByRole("button", { name: "Submit feedback" }).click();
  await owner.getByRole("link", { name: "Dark mode for the dashboard" }).click();
  await owner.waitForURL(`${own}/feedback/feature-requests/dark-mode-for-the-dashboard-1`);
  await checkpoint(owner, "app-portal-post");
  // Its name in the header goes to the portal's home, under the path.
  await owner.getByRole("banner").getByRole("link", { name: "Tuti" }).click();
  await owner.waitForURL(`${own}/feedback/feature-requests`);
  await owner.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Help" }).click();
  await owner.waitForURL(`${own}/docs`);
  // The account, with its password, is the app's.
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
