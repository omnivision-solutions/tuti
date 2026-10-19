import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, signUp } from "./helpers";
import { nextModelReply } from "./model";

test("the team writes what shipped, publishes it, and people see it on the portal", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/b/feature-requests");
  await ada.getByLabel("Title").fill("Dark mode");
  await ada.getByRole("button", { name: "Submit feedback" }).click();
  await expect(ada.getByRole("link", { name: "Dark mode" })).toBeVisible();

  // The team plans it, so the changelog can pick it.
  await team.goto(`/app/${slug}/p/1`);
  await team.getByLabel("Status").click();
  await team.getByRole("option", { name: "Planned" }).click();
  await expect(team.getByText("Status: Planned")).toBeVisible();

  // A draft: title, tag, text with a heading, and the post it completes.
  await team.getByRole("link", { name: "Changelog" }).click();
  await team.getByRole("link", { name: "New entry" }).click();
  await team.getByLabel("Title").fill("Dark mode is here");
  await team.getByRole("checkbox", { name: "New" }).check();
  const editor = team.getByRole("textbox", { name: "What changed" });
  await editor.click();
  await team.getByRole("button", { name: "Heading", exact: true }).click();
  await team.keyboard.type("Easier on the eyes");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Switch themes from your profile menu.");
  await team.getByRole("checkbox", { name: /#1 Dark mode/ }).check();
  await checkpoint(team, "team-changelog-draft");
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/changelog/1`);
  await expect(team.getByText("Draft", { exact: true })).toBeVisible();

  // AI rewrites the text into release notes, after asking; the title the team gave stays.
  await nextModelReply(
    JSON.stringify({
      title: "Dark mode",
      notes: "## A darker look\n\nSwitch to the dark theme from your profile menu.\n\n- Easier on the eyes at night",
    }),
  );
  await team.getByRole("button", { name: "Draft with AI" }).click();
  const confirm = team.getByRole("alertdialog");
  await expect(confirm).toContainText("Replace the text with an AI draft?");
  await checkpoint(team, "team-changelog-ai-draft-confirm", { fullPage: false });
  await confirm.getByRole("button", { name: "Replace the text" }).click();
  await expect(team.getByText("Drafted with AI")).toBeVisible();
  await expect(editor.getByRole("heading", { name: "A darker look" })).toBeVisible();
  await expect(editor.getByRole("listitem")).toHaveText("Easier on the eyes at night");
  await expect(editor.getByRole("heading", { name: "Easier on the eyes" })).toHaveCount(0);
  await expect(editor).not.toContainText("Switch themes");
  await expect(team.getByLabel("Title")).toHaveValue("Dark mode is here");
  await checkpoint(team, "team-changelog-ai-draft");

  // Not on the portal until it's published.
  await ada.goto("/changelog");
  await expect(ada.getByText("Nothing here yet")).toBeVisible();

  // Publishing keeps an edit that isn't saved yet (and publishes what's saved).
  await team.getByLabel("Title").fill("Dark mode is here, at last");
  await team.getByRole("button", { name: "Publish" }).click();
  const dialog = team.getByRole("alertdialog");
  await expect(dialog).toContainText("The post it completes becomes Completed");
  await expect(dialog).toContainText("Announced, it also shows as new in your widget.");
  await dialog.getByRole("button", { name: "Publish and announce" }).click();
  await expect(team.getByText("Published and announced")).toBeVisible();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();
  await expect(team.getByLabel("Title")).toHaveValue("Dark mode is here, at last");
  // The team's list shows it with its tag.
  await team.getByRole("link", { name: "Changelog" }).click();
  await expect(team.getByRole("listitem").filter({ hasText: "Dark mode is here" }).getByText("New", { exact: true })).toBeVisible();

  // On the portal: the entry, its tag and what it completes; the post says where it shipped.
  await ada.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Changelog" }).click();
  const entry = ada.getByRole("article", { name: "Dark mode is here" });
  await expect(entry.getByRole("heading", { name: "A darker look", level: 2 })).toBeVisible();
  await expect(entry).toContainText("New");
  await expect(entry).toContainText("Switch to the dark theme from your profile menu.");
  await checkpoint(ada, "portal-changelog");
  // Feed readers find it too.
  await expect(ada.locator('link[rel="alternate"][type="application/rss+xml"]')).toHaveAttribute("href", `${portalUrl(slug)}/changelog/rss.xml`);
  const feed = await (await ada.request.get(`${portalUrl(slug)}/changelog/rss.xml`)).text();
  expect(feed).toContain("<title>Dark mode is here</title>");
  await entry.getByRole("link", { name: "Dark mode", exact: true }).click();
  await ada.waitForURL(/\/p\/dark-mode-1$/);
  await expect(ada.getByText("Completed").first()).toBeVisible();
  await expect(ada.getByRole("link", { name: "Dark mode is here" })).toHaveAttribute("href", "/changelog/1");
});
