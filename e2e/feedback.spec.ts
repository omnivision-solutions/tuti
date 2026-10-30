import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, postFeedback, signUp } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";

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
  const banner = team.getByRole("status").filter({ hasText: "Verify your email" });
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
  await postFeedback(ada, "Dark mode");
  await checkpoint(ada, "portal-first-post");

  const bo = await signUp(browser, portalUrl(slug), "Bo");
  await bo.goto("/feedback/feature-requests");
  await postFeedback(bo, "Night theme for the editor");
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
  // Its badge has Planned's dark green dot beside it.
  const dot = bo.getByRole("main").locator("[data-status-dot]");
  const plannedColor = await bo.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.backgroundColor = "var(--status-planned)";
    return getComputedStyle(probe).backgroundColor;
  });
  expect(plannedColor).not.toBe("rgba(0, 0, 0, 0)");
  await expect(dot).toHaveCSS("background-color", plannedColor);
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
  // A row shows values, no form controls: its board as text, its status as a badge that opens a menu.
  const row = team.getByRole("main").getByRole("listitem").filter({ hasText: "Dark mode" });
  await expect(row).toContainText("#1 · Feature requests · Ada");
  await expect(row.getByRole("combobox")).toHaveCount(0);
  await row.getByRole("button", { name: "Status: Planned" }).click();
  await checkpoint(team, "team-feedback-status-menu");
  await team.getByRole("menuitemradio", { name: "In progress" }).click();
  // Picked, the menu closes.
  await expect(team.getByRole("menu")).toHaveCount(0);
  await expect(team.getByText("Status: In progress")).toBeVisible();
  await expect(row.getByRole("button", { name: "Status: In progress" })).toBeVisible();
  await checkpoint(team, "team-feedback-list");
});

test("long lists load 50 posts at a time, keeping the place in the address", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // 51 posts, "Idea 1" the oldest: with one vote each, the newest come first and it's the one on page two.
  await api("/posts", { board: "feature-requests", title: "Idea 1" });
  for (let start = 2; start <= 51; start += 10) {
    const numbers = Array.from({ length: 10 }, (_, i) => start + i);
    await Promise.all(numbers.map((n) => api("/posts", { board: "feature-requests", title: `Idea ${n}` })));
  }

  const portal = await signUp(browser, portalUrl(slug), "Ada");
  for (const [page, list] of [
    [portal, "/feedback/feature-requests"],
    [team, `/app/${slug}/feedback`],
  ] as const) {
    await page.goto(list);
    await expect(page.getByRole("link", { name: "Idea 51", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Idea 1", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Load more" }).click();
    await page.waitForURL(/\?page=2$/);
    await expect(page.getByRole("link", { name: "Idea 1", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Load more" })).toHaveCount(0);
    await checkpoint(page, page === portal ? "portal-board-page-two" : "team-feedback-page-two");
    // Back from a post on page two comes back to the whole list.
    await page.getByRole("link", { name: "Idea 1", exact: true }).click();
    await page.waitForURL((url) => !url.search.includes("page"));
    await page.goBack();
    await expect(page.getByRole("link", { name: "Idea 1", exact: true })).toBeVisible();
  }
});

test("a board opens on the ideas not done yet, with completed ones in Recently shipped, and its box finds similar ideas", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await api("/posts", { board: "feature-requests", title: "Export to CSV" });
  await api("/posts/2", { status: "completed" }, "PATCH");

  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/feedback/feature-requests");
  const main = visitor.getByRole("main");
  // The list has what's not done yet; what shipped is in its own card.
  await expect(main.getByRole("link", { name: "Dark mode" })).toBeVisible();
  const shipped = main.getByRole("region", { name: "Recently shipped" });
  await expect(shipped.getByRole("link", { name: "Export to CSV" })).toBeVisible();
  await expect(shipped).toContainText("Completed");
  await expect(main.getByRole("link", { name: "Export to CSV" })).toHaveCount(1);
  // Signed out, the box takes an idea and shows the similar ones as it's typed.
  await main.getByLabel("Title").fill("Dark theme");
  await expect(main.getByRole("status").filter({ hasText: "Already posted? Vote on it instead:" })).toContainText("Dark mode");
  await checkpoint(visitor, "portal-board-share-idea");
  // Signing in to post (Enter does it too) comes back to the board as it was: its sort, and the idea in the box.
  await visitor.goto("/feedback/feature-requests?sort=new");
  await main.getByLabel("Title").fill("Dark theme");
  await main.getByLabel("Title").press("Enter");
  await visitor.waitForURL(/\/sign-in\?next=/);
  expect(new URL(visitor.url()).searchParams.get("next")).toBe("/feedback/feature-requests?sort=new&title=Dark+theme");
  // Before the page's script runs (here, without JavaScript), Enter still goes to sign-in, back to the board as it was.
  const noScript = await browser.newContext({ baseURL: portalUrl(slug), javaScriptEnabled: false });
  const early = await noScript.newPage();
  await early.goto("/feedback/feature-requests?sort=new");
  await early.getByRole("main").getByLabel("Title").fill("Dark theme");
  await early.getByRole("main").getByLabel("Title").press("Enter");
  await early.waitForURL(/\/sign-in\?/);
  expect(new URL(early.url()).searchParams.get("next")).toBe("/feedback/feature-requests?sort=new");
  // Signing in there comes back with the title too (the "Continue" link carries where it goes).
  await expect(early.getByRole("link", { name: "Continue with your Tuti account" })).toHaveAttribute(
    "href",
    `/continue?${new URLSearchParams({ redirect: "/feedback/feature-requests?sort=new&title=Dark+theme" })}`,
  );
  await noScript.close();
  await visitor.goto("/feedback/feature-requests");
  // All statuses lists the completed one too.
  await visitor.getByRole("combobox", { name: "Status" }).click();
  await visitor.getByRole("option", { name: "All statuses" }).click();
  await visitor.waitForURL(/\?status=all$/);
  await expect(main.getByRole("link", { name: "Export to CSV" })).toHaveCount(1);
  await expect(shipped).toHaveCount(0);
  // The default list asked for by name (or with a status it doesn't know) has the card too.
  await visitor.goto("/feedback/feature-requests?status=active");
  await expect(shipped.getByRole("link", { name: "Export to CSV" })).toBeVisible();
});
