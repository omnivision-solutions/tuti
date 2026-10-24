import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { signUp } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";

async function submitFeedback(page: Page, title: string) {
  await page.getByRole("button", { name: "Submit post" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Submit post" }).click();
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
  // The portal's address shows as it's typed.
  await expect(team.getByText(`Your portal will be ${new URL(portalUrl(slug)).host}`, { exact: true })).toBeVisible();
  await checkpoint(team, "team-new-project-form");
  await team.getByRole("button", { name: "Create project" }).click();
  await team.waitForURL(`**/app/${slug}`);
  await checkpoint(team, "team-new-project");

  // Until they verify their email, the dashboard asks them to; the emailed link does it.
  const banner = team.getByRole("alert").filter({ hasText: "Verify your email" });
  await expect(banner).toContainText(team.email);
  const emailsBefore = countEmailsTo(team.email);
  await team.getByRole("button", { name: "Resend email" }).click();
  await expect(team.getByRole("button", { name: "Sent" })).toBeDisabled();
  await checkpoint(team, "team-verify-email-banner");
  const email = await latestEmailTo(team.email, { after: emailsBefore });
  expect(email.subject).toBe("Verify your email for Tuti");
  // Verified in another tab: this one notices when it's back in focus, without reloading.
  const otherTab = await team.context().newPage();
  await otherTab.goto(linkIn(email, `${APP_URL}/api/auth/verify-email`));
  await otherTab.waitForURL(`**/app/${slug}`); // /app opens the last project
  await otherTab.close();
  await team.bringToFront();
  // Better Auth refetches the session when the tab becomes visible, at most every 5 seconds.
  await expect(async () => {
    await team.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(banner).toHaveCount(0, { timeout: 500 });
  }).toPass({ timeout: 15_000 });

  // Two people post on the portal; the second also upvotes the first post.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await submitFeedback(ada, "Dark mode");
  await checkpoint(ada, "portal-first-post");

  const bo = await signUp(browser, portalUrl(slug), "Bo");
  await bo.goto("/feedback/feature-requests");
  await submitFeedback(bo, "Night theme for the editor");
  await checkpoint(bo, "portal-two-posts");
  await bo.getByRole("link", { name: "Dark mode" }).click();
  // The board list has vote buttons too: vote only once the post page is open.
  await bo.waitForURL(/\/feedback\/[a-z0-9-]+\/dark-mode-1$/);
  await bo.getByRole("button", { name: "Upvote" }).click();
  await expect(bo.getByRole("button", { name: "Remove vote" })).toHaveText("2");

  // The team merges the duplicate into the original…
  await team.goto(`/app/${slug}/p/2`);
  await team.getByRole("button", { name: "Merge into…" }).click();
  await team.getByRole("button", { name: /Dark mode/ }).click();
  await checkpoint(team, "team-merge-confirm", { fullPage: false });
  await team.getByRole("dialog").getByRole("button", { name: "Merge", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/p/1`);

  // …then answers and plans it.
  await team.getByRole("textbox", { name: "Comment" }).fill("Thanks! We're on it.");
  await team.getByRole("button", { name: "Comment" }).click();
  await team.getByLabel("Status").click();
  await team.getByRole("option", { name: "Planned" }).click();
  // Saved once the toast shows; the portal is opened only after that.
  await expect(team.getByText("Status: Planned")).toBeVisible();
  await checkpoint(team, "team-planned");

  // People on the portal see one post with both votes, the team's answer and the status.
  await bo.goto("/feedback/feature-requests/night-theme-for-the-editor-2");
  await expect(bo).toHaveURL(/\/feedback\/[a-z0-9-]+\/dark-mode-1$/);
  // Bo voted for both, so counts once: Ada + Bo.
  await expect(bo.getByRole("button", { name: "Remove vote" })).toHaveText("2");
  await expect(bo.getByText("Thanks! We're on it.")).toBeVisible();
  await expect(bo.getByText("Team", { exact: true })).toBeVisible();
  await expect(bo.getByText("Planned").first()).toBeVisible();
  await checkpoint(bo, "portal-merged-post");

  // The board's status filter finds it under Planned only.
  await bo.goto("/feedback/feature-requests?status=planned");
  await expect(bo.getByRole("link", { name: "Dark mode" })).toBeVisible();
  await bo.goto("/feedback/feature-requests?status=open");
  await expect(bo.getByRole("link", { name: "Dark mode" })).toHaveCount(0);
  await checkpoint(bo, "portal-filtered");

  // The portal's roadmap shows it as planned, with both votes.
  await bo.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Roadmap" }).click();
  const planned = bo.getByRole("region", { name: "Planned" });
  await expect(planned.getByRole("link", { name: "Dark mode" })).toHaveAttribute("href", "/feedback/feature-requests/dark-mode-1");
  await expect(planned).toContainText("2 votes · Feature requests");
  await expect(bo.getByRole("region", { name: "In progress" })).toContainText("Nothing here yet.");
  await checkpoint(bo, "portal-roadmap");

  // So does the team's feedback list; the merged duplicate isn't listed.
  await team.goto(`/app/${slug}/feedback?status=planned`);
  await expect(team.getByRole("link", { name: /Dark mode/ })).toBeVisible();
  // A link from when the list was the project's first page still finds it, filters and all.
  await team.goto(`/app/${slug}?status=open`);
  await team.waitForURL(`**/app/${slug}/feedback?status=open`);
  await expect(team.getByRole("link", { name: /Dark mode/ })).toHaveCount(0);
  await team.goto(`/app/${slug}/feedback`);
  await expect(team.getByRole("link", { name: /Night theme/ })).toHaveCount(0);
  await checkpoint(team, "team-feedback-list");
});
