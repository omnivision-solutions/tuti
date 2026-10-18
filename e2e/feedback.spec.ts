import { randomUUID } from "node:crypto";

import { type Browser, expect, type Page, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";

/** A new browser session that signed up at `baseUrl` (the app or a portal). */
async function signUp(browser: Browser, baseUrl: string, name: string): Promise<Page> {
  const page = await (await browser.newContext({ baseURL: baseUrl })).newPage();
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(`e2e-${randomUUID()}@example.com`);
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-up"));
  return page;
}

async function submitFeedback(page: Page, title: string) {
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Submit feedback" }).click();
  await expect(page.getByRole("link", { name: title })).toBeVisible();
}

test("a team collects feedback, merges a duplicate and plans it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  // The team creates a project.
  const team = await signUp(browser, APP_URL, "Tess Team");
  await team.goto("/app/new");
  await team.getByLabel("Name").fill("Acme");
  await team.getByLabel("URL").fill(slug);
  await team.getByRole("button", { name: "Create project" }).click();
  await team.waitForURL(`**/app/${slug}`);
  await checkpoint(team, "team-new-project");

  // Two people post on the portal; the second also upvotes the first post.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/b/feature-requests");
  await submitFeedback(ada, "Dark mode");
  await checkpoint(ada, "portal-first-post");

  const bo = await signUp(browser, portalUrl(slug), "Bo");
  await bo.goto("/b/feature-requests");
  await submitFeedback(bo, "Night theme for the editor");
  await checkpoint(bo, "portal-two-posts");
  await bo.getByRole("link", { name: "Dark mode" }).click();
  await bo.getByRole("button", { name: "Upvote" }).click();
  await expect(bo.getByRole("button", { name: "Remove vote" })).toHaveText("2");

  // The team merges the duplicate into the original…
  await team.goto(`/app/${slug}/p/2`);
  await team.getByRole("button", { name: "Merge into…" }).click();
  await team.getByRole("button", { name: /Dark mode/ }).click();
  await checkpoint(team, "team-merge-confirm");
  await team.getByRole("dialog").getByRole("button", { name: "Merge", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/p/1`);

  // …then answers and plans it.
  await team.getByRole("textbox", { name: "Comment" }).fill("Thanks! We're on it.");
  await team.getByRole("button", { name: "Comment" }).click();
  await team.getByLabel("Status").click();
  await team.getByRole("option", { name: "Planned" }).click();
  await checkpoint(team, "team-planned");

  // People on the portal see one post with both votes, the team's answer and the status.
  await bo.goto("/p/night-theme-for-the-editor-2");
  await expect(bo).toHaveURL(/\/p\/dark-mode-1$/);
  // Bo voted for both, so counts once: Ada + Bo.
  await expect(bo.getByRole("button", { name: "Remove vote" })).toHaveText("2");
  await expect(bo.getByText("Thanks! We're on it.")).toBeVisible();
  await expect(bo.getByText("Team", { exact: true })).toBeVisible();
  await expect(bo.getByText("Planned").first()).toBeVisible();
  await checkpoint(bo, "portal-merged-post");

  // The board's status filter finds it under Planned only.
  await bo.goto("/b/feature-requests?status=planned");
  await expect(bo.getByRole("link", { name: "Dark mode" })).toBeVisible();
  await bo.goto("/b/feature-requests?status=open");
  await expect(bo.getByRole("link", { name: "Dark mode" })).toHaveCount(0);
  await checkpoint(bo, "portal-filtered");

  // So does the team's feedback list; the merged duplicate isn't listed.
  await team.goto(`/app/${slug}?status=planned`);
  await expect(team.getByRole("link", { name: /Dark mode/ })).toBeVisible();
  await team.goto(`/app/${slug}?status=open`);
  await expect(team.getByRole("link", { name: /Dark mode/ })).toHaveCount(0);
  await team.goto(`/app/${slug}`);
  await expect(team.getByRole("link", { name: /Night theme/ })).toHaveCount(0);
  await checkpoint(team, "team-feedback-list");
});
