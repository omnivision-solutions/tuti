import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, postFeedback, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";

test("a portal's Account: email settings the emails follow, and the reader's posts and votes", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // Ada (email verified) posts two ideas; Bo (verified too) posts one and votes for hers.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto(linkIn(await latestEmailTo(ada.email), "http"));
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, "Dark mode");
  await postFeedback(ada, "Offline mode");
  const bo = await signUp(browser, portalUrl(slug), "Bo");
  await bo.goto(linkIn(await latestEmailTo(bo.email), "http"));
  await bo.goto("/feedback/feature-requests");
  await postFeedback(bo, "Export invoices");
  for (const path of ["dark-mode-1", "offline-mode-2"]) {
    await bo.goto(`/feedback/feature-requests/${path}`);
    await bo.getByRole("button", { name: "Upvote" }).click();
    await expect(bo.getByRole("button", { name: "Remove vote" })).toBeEnabled();
  }

  // From the account menu: Bo's posts and votes, each linking to it.
  await bo.getByRole("button", { name: "Account" }).click();
  await bo.getByRole("menuitem", { name: "Account settings" }).click();
  await bo.waitForURL("**/account");
  await expect(bo.getByRole("region", { name: "My posts" }).getByRole("link")).toHaveText(["Export invoices"]);
  await expect(bo.getByRole("region", { name: "My votes" }).getByRole("link")).toHaveText(["Offline mode", "Dark mode"]);
  await bo.getByRole("region", { name: "My votes" }).getByRole("link", { name: "Dark mode" }).click();
  await expect(bo.getByRole("heading", { level: 1 })).toHaveText("Dark mode");

  // Bo stops emails about posts he voted on; it's kept.
  await bo.goto("/account");
  const followed = bo.getByRole("switch", { name: "Posts I voted on or follow" });
  await expect(followed).toBeChecked();
  // From the keyboard, which keeps its focus while it saves.
  await followed.focus();
  await bo.keyboard.press("Space");
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await expect(followed).toBeFocused();
  await bo.reload();
  await expect(followed).not.toBeChecked();
  await expect(bo.getByRole("switch", { name: "Posts I wrote" })).toBeChecked();

  // At desktop and phone widths, light and dark.
  const signedIn = await bo.context().storageState();
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await (await browser.newContext({ baseURL: portalUrl(slug), viewport, colorScheme, storageState: signedIn })).newPage();
      await page.goto("/account");
      await expect(page.getByRole("switch", { name: "Posts I voted on or follow" })).not.toBeChecked();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await checkpoint(page, `portal-account-${name}-${colorScheme}`);
      await page.context().close();
    }
  }

  // Shipping Dark mode tells Ada, who wrote it, and not Bo, who voted for it: the team is told it emails one person.
  await team.goto(`/app/${slug}/p/1`);
  await team.getByLabel("Status").click();
  await team.getByRole("option", { name: "Completed" }).click();
  const ask = team.getByRole("alertdialog", { name: "Mark “Dark mode” completed?" });
  await expect(ask).toContainText("This emails up to 1 person who asked for it that it shipped.");
  await ask.getByRole("button", { name: "Mark completed" }).click();
  await expect(team.getByText("Status: Completed")).toBeVisible();
  const email = await latestEmailTo(ada.email, { subject: /^Done: Dark mode$/ });

  // Ada stops every email from Acme: the email's unsubscribe link says she already has.
  await ada.goto("/account");
  await ada.getByRole("switch", { name: "Stop all emails from Acme" }).check();
  await expect(ada.getByText("Email settings saved")).toBeVisible();
  await expect(ada.getByRole("switch", { name: "Posts I wrote" })).toBeDisabled();
  await checkpoint(ada, "portal-account-stopped");
  await ada.goto(linkIn(email, `${portalUrl(slug)}/unsubscribe`));
  await expect(ada.getByRole("heading", { name: "You're unsubscribed" })).toBeVisible();
});
