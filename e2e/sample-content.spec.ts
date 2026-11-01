import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, signUp } from "./helpers";

test("sample content from the setup, labelled Sample in Feedback, Docs, Changelog, the Inbox and the portal, left out of Home's numbers, removed from Home in one go", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/new");
  await owner.getByLabel("Name").fill("Acme");
  await owner.getByLabel("URL").fill(slug);
  await owner.getByRole("button", { name: "Create project" }).click();

  // What will you use: all four, with sample content for them.
  await owner.waitForURL(`**/app/${slug}/setup`);
  for (const name of ["Feedback", "Docs", "Changelog", "Support"]) {
    await owner.getByRole("checkbox", { name: new RegExp(`^${name}`) }).check();
  }
  await owner.getByRole("checkbox", { name: /^Add sample content/ }).check();
  await checkpoint(owner, "setup-sample-content");
  await owner.getByRole("button", { name: "Continue" }).click();
  await owner.waitForURL(`**/app/${slug}/setup?step=widget`);
  await owner.getByRole("link", { name: "Skip setup" }).click();
  await owner.waitForURL(`**/app/${slug}`);

  // The team's own post, which removing leaves alone.
  const api = await apiFor(owner, slug);
  await api("/posts", { board: "feature-requests", title: "Single sign-on" });

  // Home: the sample content to remove, and numbers that count only the team's own post.
  await owner.goto(`/app/${slug}`);
  await expect(owner.getByText(/^Here to try things with, labelled Sample/)).toBeVisible();
  await expect(owner.getByRole("link", { name: /New posts this week/ })).toHaveText(/^1New posts this week/);
  await expect(owner.getByRole("link", { name: /Need a reply/ })).toHaveText(/^0Need a reply/);
  await checkpoint(owner, "home-sample-content");

  // Labelled Sample wherever it's listed; the team's own post isn't.
  const row = (text: string) => owner.getByRole("listitem").filter({ hasText: text });
  await owner.goto(`/app/${slug}/feedback?status=all`);
  for (const title of ["Dark mode", "Export reports to CSV", "Slack notifications"]) {
    await expect(row(title).getByText("Sample", { exact: true })).toBeVisible();
  }
  await expect(row("Single sign-on").getByText("Sample", { exact: true })).toHaveCount(0);
  await checkpoint(owner, "feedback-sample");
  // Completing a sample post emails nobody, and its dialog says so.
  await row("Export reports to CSV").getByRole("button", { name: "Status: Open" }).click();
  await owner.getByRole("menuitemradio", { name: "Completed" }).click();
  const complete = owner.getByRole("alertdialog", { name: "Mark “Export reports to CSV” completed?" });
  await expect(complete).toContainText("Nobody is emailed.");
  await checkpoint(owner, "feedback-sample-complete");
  await complete.getByRole("button", { name: "Cancel" }).click();
  await expect(owner.getByRole("alertdialog")).toHaveCount(0);
  await owner.goto(`/app/${slug}/docs`);
  const collection = owner.getByRole("region", { name: "Getting started" });
  await expect(collection.getByText("Sample", { exact: true })).toHaveCount(3);
  await expect(collection.getByRole("link", { name: "Create your account" })).toBeVisible();
  await expect(collection.getByRole("link", { name: "Invite your team" })).toBeVisible();
  await checkpoint(owner, "docs-sample");
  await owner.goto(`/app/${slug}/changelog`);
  await expect(row("Welcome to our changelog").getByText("Sample", { exact: true })).toBeVisible();
  await checkpoint(owner, "changelog-sample");
  // Published again, a sample update is never announced, and the dialog says so.
  await owner.getByRole("link", { name: "Welcome to our changelog" }).click();
  // Its editor says it's sample content too, beside when it was published.
  await owner.waitForURL(/\/changelog\/\d+$/);
  await expect(owner.locator("p", { hasText: /^Sample Published / }).getByText("Sample", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "Unpublish" }).click();
  await expect(owner.getByText("Unpublished", { exact: true })).toBeVisible();
  await owner.getByRole("button", { name: "Publish", exact: true }).click();
  const publish = owner.getByRole("alertdialog", { name: "Publish “Welcome to our changelog”?" });
  await expect(publish).toContainText("Sample updates are published without announcing.");
  await expect(publish.getByRole("button", { name: "Publish and announce" })).toHaveCount(0);
  await checkpoint(owner, "changelog-sample-publish");
  await publish.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(owner.getByText("Published without announcing", { exact: true })).toBeVisible();
  // The team's own update completing their own post, which nobody but the team asked for: Completed, nobody emailed,
  // and the dialog promises no email. (It couldn't take a sample post: those only go with the sample update.)
  const update = (await api("/changelog", { title: "Dark mode is here", body: "Try it in Settings.", posts: [4] })) as unknown as { number: number };
  await owner.goto(`/app/${slug}/changelog/${update.number}`);
  await owner.getByRole("button", { name: "Publish", exact: true }).click();
  const publishOwn = owner.getByRole("alertdialog", { name: "Publish “Dark mode is here”?" });
  await expect(publishOwn).toContainText("The post it completes becomes Completed.");
  await expect(publishOwn).not.toContainText("get an email");
  await checkpoint(owner, "changelog-sample-post-publish");
  await publishOwn.getByRole("button", { name: "Cancel" }).click();
  await owner.goto(`/app/${slug}/inbox`);
  await expect(row("Can I export my data?").getByText("Sample", { exact: true })).toBeVisible();
  await checkpoint(owner, "inbox-sample");
  // On the portal too.
  await owner.goto(`${portalUrl(slug)}/feedback/feature-requests`);
  await expect(row("Dark mode").getByText("Sample", { exact: true })).toBeVisible();
  await checkpoint(owner, "portal-sample");
  // The portal's docs: the sample collection's card and page say Sample too.
  await owner.goto(`${portalUrl(slug)}/docs`);
  const card = owner.getByRole("list", { name: "Collections" }).getByRole("listitem").filter({ hasText: "Getting started" });
  await expect(card.getByText("Sample", { exact: true })).toBeVisible();
  await card.getByRole("link").click();
  await owner.waitForURL("**/docs/getting-started");
  await expect(owner.getByRole("heading", { name: "Getting started", level: 1 })).toBeVisible();
  await expect(owner.getByText("Sample", { exact: true })).toBeVisible();
  await checkpoint(owner, "portal-docs-sample-collection");

  // Removed in one go, once Home has asked (it can't be undone); the team's own post stays.
  await owner.goto(`/app/${slug}`);
  await owner.getByRole("button", { name: "Remove sample content" }).click();
  const dialog = owner.getByRole("alertdialog", { name: "Remove the sample content?" });
  await expect(dialog).toContainText("Your own posts, articles and updates stay.");
  await checkpoint(owner, "home-remove-sample-asks");
  await dialog.getByRole("button", { name: "Remove sample content" }).click();
  await expect(owner.getByText("Sample content removed")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Add sample content" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Remove sample content" })).toHaveCount(0);
  await checkpoint(owner, "home-sample-removed");
  await owner.goto(`/app/${slug}/feedback?status=all`);
  await expect(owner.getByRole("link", { name: "Single sign-on" })).toBeVisible();
  await expect(owner.getByRole("link", { name: "Dark mode" })).toHaveCount(0);
  await owner.goto(`/app/${slug}/docs`);
  await expect(owner.getByRole("region", { name: "Getting started" })).toHaveCount(0);
  await owner.goto(`/app/${slug}/changelog`);
  await expect(owner.getByText("Welcome to our changelog")).toHaveCount(0);
  await owner.goto(`/app/${slug}/inbox`);
  await expect(owner.getByText("Can I export my data?")).toHaveCount(0);
  await checkpoint(owner, "inbox-sample-removed");
});
