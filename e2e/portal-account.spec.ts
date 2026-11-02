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

  // The board's Get updates says so (on wide screens, where its sidebar is), and opens his Account to turn them back on.
  await bo.goto("/feedback/feature-requests");
  const updates = bo.getByRole("complementary", { name: "About this board" }).getByRole("region", { name: "Get updates" });
  await expect(updates).not.toContainText("Vote for an idea to get an email when it ships.");
  await checkpoint(bo, "board-get-updates-unsubscribed");
  await updates.getByRole("link", { name: "You've unsubscribed from these emails." }).click();
  await bo.waitForURL("**/account");
  await expect(followed).not.toBeChecked();

  // Clicked three times while the first save is still going, and it fails: the last click is what's saved and shown
  // (the failure doesn't put the switch back over the clicks after it). The first save fails once the clicks are done.
  const wrote = bo.getByRole("switch", { name: "Posts I wrote" });
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
  let seen = 0;
  await bo.route("**/account", async (route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }
    if (++seen === 1) {
      await firstHeld;
      return route.abort();
    }
    return route.fallback();
  });
  await wrote.click();
  await wrote.click();
  await wrote.click();
  releaseFirst();
  await expect(bo.getByText("Couldn't save your email settings. Try again.")).toBeVisible();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await expect(wrote).not.toBeChecked();
  await bo.unroute("**/account");
  await bo.reload();
  await expect(wrote).not.toBeChecked();
  await wrote.check();
  await expect(bo.getByText("Email settings saved")).toBeVisible();

  // A save that fails (offline, say) puts the switch back and says so. Clicked, not uncheck(): it goes back.
  await bo.route("**/account", (route) => (route.request().method() === "POST" ? route.abort() : route.fallback()));
  await wrote.click();
  await expect(bo.getByText("Couldn't save your email settings. Try again.")).toBeVisible();
  await expect(wrote).toBeChecked();
  await bo.unroute("**/account");
  await bo.reload();
  await expect(wrote).toBeChecked();

  // Bo gets the changelog from here: his address is confirmed, so no email asks him to confirm it again.
  const changelog = bo.getByRole("switch", { name: "The changelog" });
  await expect(changelog).not.toBeChecked();
  await changelog.check();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await bo.reload();
  await expect(changelog).toBeChecked();
  await checkpoint(bo, "portal-account-changelog");
  // The changelog page agrees: no form asking him to subscribe, a line saying he gets it, and its link back here.
  await bo.goto("/changelog");
  await expect(bo.getByText(`The changelog entries Acme emails to subscribers go to ${bo.email}.`)).toBeVisible();
  await expect(bo.getByRole("region", { name: "Get updates by email" })).toHaveCount(0);
  await checkpoint(bo, "portal-changelog-gets-it");
  const desktop = bo.viewportSize()!;
  await bo.setViewportSize({ width: 390, height: 844 });
  await checkpoint(bo, "portal-changelog-gets-it-phone");
  await bo.setViewportSize(desktop);
  await bo.getByRole("link", { name: "Manage", exact: true }).click();
  await bo.waitForURL("**/account");
  // Stopping the project's emails turns it off with them; turned back on (the page read while they were off), it shows on
  // again as the save says, without a reload.
  const stopBo = bo.getByRole("switch", { name: "Email me nothing from Acme" });
  await stopBo.check();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await bo.reload();
  await expect(changelog).not.toBeChecked();
  await expect(changelog).toBeDisabled();
  // There too: Stop wins, said as the subscription pages say it.
  await bo.goto("/changelog");
  await expect(bo.getByText(`You've turned off all of Acme's emails, so its changelog isn't emailed to ${bo.email} either.`)).toBeVisible();
  await checkpoint(bo, "portal-changelog-emails-off");
  await bo.goto("/account");
  await stopBo.uncheck();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await expect(changelog).toBeChecked();
  await expect(changelog).toBeEnabled();
  await bo.reload();
  await expect(changelog).toBeChecked();
  // An entry the team publishes with Email subscribers reaches him.
  const publish = async (title: string) => {
    await team.goto(`/app/${slug}/changelog/new`);
    await team.getByLabel("Title").fill(title);
    await team.getByRole("button", { name: "Save draft" }).first().click();
    await expect(team).toHaveURL(new RegExp(`/app/${slug}/changelog/\\d+$`));
    return team.getByRole("group", { name: "How it's announced" }).getByRole("checkbox", { name: "Email subscribers" });
  };
  const emailSubscribers = await publish("Dark mode is here");
  await expect(emailSubscribers).toBeChecked();
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  await latestEmailTo(bo.email, { subject: /^Acme: Dark mode is here$/ });
  // Turned off, he's unsubscribed: the next entry has nobody to email.
  await changelog.uncheck();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await bo.reload();
  await expect(changelog).not.toBeChecked();
  // Subscribed again with Stop on, he turns Stop off and, before that save comes back, the changelog on and off: his
  // last click (off) is what's saved and shown, not the changelog's state the Stop save answers with.
  await changelog.check();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await bo.reload();
  await stopBo.check();
  await expect(bo.getByText("Email settings saved")).toBeVisible();
  await bo.reload();
  let releaseStop!: () => void;
  const stopHeld = new Promise<void>((resolve) => (releaseStop = resolve));
  let sent = 0;
  await bo.route("**/account", async (route) => {
    if (route.request().method() === "POST" && ++sent === 1) {
      await stopHeld;
    }
    return route.fallback();
  });
  await stopBo.uncheck();
  await changelog.check();
  await changelog.uncheck();
  releaseStop();
  await expect(bo.getByText("Email settings saved")).toHaveCount(2);
  await expect(changelog).not.toBeChecked();
  await bo.unroute("**/account");
  await bo.reload();
  await expect(changelog).not.toBeChecked();
  await expect(stopBo).not.toBeChecked();
  await expect(await publish("Exports")).toBeDisabled();

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
      // Who's signed in, and Sign out, on the page.
      await expect(page.getByText(`Signed in as ${bo.email}`)).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
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

  // Ada asks Acme to email her nothing (the switch says what still arrives): the email's unsubscribe link says she already has.
  await ada.goto("/account");
  const stop = ada.getByRole("switch", { name: "Email me nothing from Acme" });
  await expect(stop).toHaveAccessibleDescription(
    "None of the emails above, whatever you follow. Replies to your messages and sign-in emails still arrive.",
  );
  await stop.check();
  await expect(ada.getByText("Email settings saved")).toBeVisible();
  await expect(ada.getByRole("switch", { name: "Posts I wrote" })).toBeDisabled();
  // The changelog's emails too: its switch off, until she turns them back on.
  await expect(ada.getByRole("switch", { name: "The changelog" })).not.toBeChecked();
  await expect(ada.getByRole("switch", { name: "The changelog" })).toBeDisabled();
  // The switches above it greyed with theirs, still readable.
  expect(await ada.locator('label[for="email-ownPosts"]').evaluate((label) => getComputedStyle(label).color)).not.toBe(
    await ada.locator('label[for="email-unsubscribed"]').evaluate((label) => getComputedStyle(label).color),
  );
  await checkpoint(ada, "portal-account-stopped");
  await ada.goto(linkIn(email, `${portalUrl(slug)}/unsubscribe`));
  await expect(ada.getByRole("heading", { name: "You're unsubscribed" })).toBeVisible();

  // Cy hasn't confirmed his address yet: the switches, and above them what's still needed, with Resend email.
  const cy = await signUp(browser, portalUrl(slug), "Cy");
  await cy.goto("/account");
  await expect(cy.getByText("Confirm your email address to get these.")).toBeVisible();
  await expect(cy.getByRole("switch", { name: "Posts I wrote" })).toBeChecked();
  // Stopping the project's emails waits for the confirmed address (it would count against the address).
  await expect(cy.getByRole("switch", { name: "Email me nothing from Acme" })).toBeDisabled();
  // So does the changelog: it's the address's subscription.
  await expect(cy.getByRole("switch", { name: "The changelog" })).toBeDisabled();
  await cy.getByRole("button", { name: "Resend email" }).click();
  await expect(cy.getByRole("button", { name: "Sent" })).toBeVisible();
  await checkpoint(cy, "portal-account-unconfirmed");
  // Sign out on the page: back on the portal's home, signed out.
  await cy.getByRole("button", { name: "Sign out" }).click();
  await expect(cy.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
  await cy.goto("/account");
  await cy.waitForURL("**/sign-in?**");
});
