import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { signUp } from "./helpers";
import { latestEmailTo } from "./mail";

test("after Create project, the team starts fresh, picks what it will use, gets the widget's snippet and invites a teammate; Home's Get set up follows", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const teammate = `e2e-${randomUUID()}@example.com`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();

  // Where are you coming from: starting fresh (picked to begin with).
  await owner.waitForURL(`**/app/${slug}/setup`);
  await expect(owner.getByRole("heading", { name: "Set up Acme" })).toBeVisible();
  await expect(owner.getByText("Step 1 of 4")).toBeVisible();
  await expect(owner.getByRole("radio", { name: /^Starting fresh/ })).toBeChecked();
  await checkpoint(owner, "setup-coming-from");
  await owner.getByRole("link", { name: "Continue" }).click();

  // What will you use: several at once.
  await owner.waitForURL(`**/app/${slug}/setup?step=use`);
  await expect(owner.getByText("Step 2 of 4")).toBeVisible();
  for (const name of ["Feedback", "Docs", "Changelog", "Support"]) {
    await expect(owner.getByRole("checkbox", { name: new RegExp(`^${name}`) })).not.toBeChecked();
  }
  // Nothing picked, Continue would only do what Skip does: it waits for a pick.
  const next = owner.getByRole("button", { name: "Continue" });
  await expect(next).toBeDisabled();
  // Sample content alone is something to continue with (sample content for everything).
  await owner.getByRole("checkbox", { name: /^Add sample content/ }).check();
  await expect(next).toBeEnabled();
  await owner.getByRole("checkbox", { name: /^Add sample content/ }).uncheck();
  await expect(next).toBeDisabled();
  await owner.getByRole("checkbox", { name: /^Feedback/ }).check();
  await expect(next).toBeEnabled();
  await owner.getByRole("checkbox", { name: /^Changelog/ }).check();
  await checkpoint(owner, "setup-what-you-use");
  // On a phone and in dark mode too, nothing wider than the screen.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.emulateMedia({ colorScheme: "dark" });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "setup-what-you-use-phone-dark");
  await owner.setViewportSize({ width: 1280, height: 720 });
  await owner.emulateMedia({ colorScheme: "light" });
  await owner.getByRole("button", { name: "Continue" }).click();
  await owner.waitForURL(`**/app/${slug}/setup?step=widget`);
  // Back to the question, the picks are there as saved, and Continue keeps them.
  await owner.goBack();
  await owner.waitForURL(`**/app/${slug}/setup?step=use`);
  await expect(owner.getByRole("checkbox", { name: /^Feedback/ })).toBeChecked();
  await expect(owner.getByRole("checkbox", { name: /^Changelog/ })).toBeChecked();
  await expect(owner.getByRole("checkbox", { name: /^Docs/ })).not.toBeChecked();
  await owner.getByRole("button", { name: "Continue" }).click();

  // The widget's script tag, to copy.
  await owner.waitForURL(`**/app/${slug}/setup?step=widget`);
  await expect(owner.getByText("Step 3 of 4")).toBeVisible();
  const snippet = `<script src="${APP_URL}/widget.js" data-project="${slug}" async></script>`;
  await expect(owner.getByText(snippet)).toBeVisible();
  await owner.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await owner.getByRole("button", { name: "Copy the widget's script tag" }).click();
  await expect(owner.getByText("Copied")).toBeVisible();
  expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(snippet);
  await checkpoint(owner, "setup-widget");
  // Not on the site yet: skipped.
  await owner.getByRole("link", { name: "Skip", exact: true }).click();

  // Invite the team: the invitation Settings → Team sends.
  await owner.waitForURL(`**/app/${slug}/setup?step=team`);
  await expect(owner.getByText("Step 4 of 4")).toBeVisible();
  await owner.getByRole("textbox", { name: "Email of the person to invite" }).fill(teammate);
  await owner.getByRole("button", { name: "Send invite" }).click();
  await expect(owner.getByText(`Invite sent to ${teammate}`)).toBeVisible();
  expect((await latestEmailTo(teammate)).subject).toBe("Olive Owner invited you to Acme on Tuti");
  await checkpoint(owner, "setup-invite-team");
  await owner.getByRole("link", { name: "Go to Home" }).click();

  // Home's Get set up follows the picks: the changelog's step, no article's (Docs wasn't picked), the invite done.
  await owner.waitForURL(`**/app/${slug}`);
  const setup = owner.getByRole("list", { name: "Get set up" });
  await expect(setup.getByRole("listitem")).toHaveText([
    "Verify your email(to do)Verify",
    "Add the widget to your site(to do)Get snippet",
    "Connect GitHub(to do)Connect",
    "Set up single sign-on(to do)Set up",
    "Publish an update(to do)New entry",
    "Invite your team(done)",
  ]);
  await checkpoint(owner, "home-get-set-up");

  // Back in setup, the picks are kept, and unticking them all can still be saved (all of Get set up again); Skip setup goes straight to Home.
  await owner.goto(`/app/${slug}/setup?step=use`);
  await expect(owner.getByRole("checkbox", { name: /^Changelog/ })).toBeChecked();
  await expect(owner.getByRole("checkbox", { name: /^Docs/ })).not.toBeChecked();
  await owner.getByRole("checkbox", { name: /^Feedback/ }).uncheck();
  await owner.getByRole("checkbox", { name: /^Changelog/ }).uncheck();
  await expect(owner.getByRole("button", { name: "Continue" })).toBeEnabled();
  await owner.getByRole("link", { name: "Skip setup" }).click();
  await owner.waitForURL(`**/app/${slug}`);
});
