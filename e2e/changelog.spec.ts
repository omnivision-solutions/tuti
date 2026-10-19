import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, signUp } from "./helpers";

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

  // Not on the portal until it's published.
  await ada.goto("/changelog");
  await expect(ada.getByText("Nothing here yet")).toBeVisible();

  await team.getByRole("button", { name: "Publish" }).click();
  const dialog = team.getByRole("alertdialog");
  await expect(dialog).toContainText("The post it completes becomes Completed");
  await dialog.getByRole("button", { name: "Publish" }).click();
  await expect(team.getByText("Published", { exact: true }).first()).toBeVisible();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();

  // On the portal: the entry, its tag and what it completes; the post says where it shipped.
  await ada.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Changelog" }).click();
  const entry = ada.getByRole("article", { name: "Dark mode is here" });
  await expect(entry.getByRole("heading", { name: "Easier on the eyes", level: 2 })).toBeVisible();
  await expect(entry).toContainText("New");
  await expect(entry).toContainText("Switch themes from your profile menu.");
  await checkpoint(ada, "portal-changelog");
  // Feed readers find it too.
  await expect(ada.locator('link[rel="alternate"][type="application/rss+xml"]')).toHaveAttribute("href", /\/changelog\/rss\.xml$/);
  const feed = await (await ada.request.get(`${portalUrl(slug)}/changelog/rss.xml`)).text();
  expect(feed).toContain("<title>Dark mode is here</title>");
  await entry.getByRole("link", { name: "Dark mode", exact: true }).click();
  await ada.waitForURL(/\/p\/dark-mode-1$/);
  await expect(ada.getByText("Completed").first()).toBeVisible();
  await expect(ada.getByRole("link", { name: "Dark mode is here" })).toHaveAttribute("href", "/changelog/1");
});
