import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, signUp } from "./helpers";

test("sample content from the setup, labelled Sample in Feedback, Docs, Changelog, the Inbox and the portal, left out of Home's numbers, removed from Home in one click", async ({ browser }, testInfo) => {
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
  await expect(owner.getByText("Here to try things with, labelled Sample wherever it shows.")).toBeVisible();
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
  await owner.goto(`/app/${slug}/docs`);
  const collection = owner.getByRole("region", { name: "Getting started" });
  await expect(collection.getByText("Sample", { exact: true })).toHaveCount(3);
  await expect(collection.getByRole("link", { name: "Create your account" })).toBeVisible();
  await expect(collection.getByRole("link", { name: "Invite your team" })).toBeVisible();
  await checkpoint(owner, "docs-sample");
  await owner.goto(`/app/${slug}/changelog`);
  await expect(row("Welcome to our changelog").getByText("Sample", { exact: true })).toBeVisible();
  await checkpoint(owner, "changelog-sample");
  await owner.goto(`/app/${slug}/inbox`);
  await expect(row("Can I export my data?").getByText("Sample", { exact: true })).toBeVisible();
  await checkpoint(owner, "inbox-sample");
  // On the portal too.
  await owner.goto(`${portalUrl(slug)}/feedback/feature-requests`);
  await expect(row("Dark mode").getByText("Sample", { exact: true })).toBeVisible();
  await checkpoint(owner, "portal-sample");

  // Removed in one click; the team's own post stays.
  await owner.goto(`/app/${slug}`);
  await owner.getByRole("button", { name: "Remove sample content" }).click();
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
