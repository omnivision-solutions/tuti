import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";
import pg from "pg";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

/** The kinds "Needs your attention" lists, in order. */
const groups = (page: Page) => page.getByRole("main").locator("section[aria-label]").evaluateAll((sections) => sections.map((s) => s.getAttribute("aria-label")));

test("Home: what needs the team by kind, customers waiting first, five of each; the numbers open their lists; on a phone each row reads in two lines", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  // Seven posts waiting for triage (more than Home lists of a kind), and one already planned.
  const titles = ["Dark mode", "Exports", "Merge accounts from the same company", "Slack alerts", "Single sign-on", "Jira sync", "Weekly digest"];
  for (const title of titles) {
    await api("/posts", { board: "feature-requests", title });
  }
  await api("/posts", { board: "feature-requests", title: "Calendar view" });
  await api("/posts/8", { status: "planned" }, "PATCH");
  // A customer waiting for a reply, after them.
  await api("/conversations", { email: "e2e-asker@example.com", body: "Do you have a discount for nonprofits?" });
  // A merged pull request with an update waiting for the team and one going out by itself.
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query(
      `WITH change AS (
         INSERT INTO code_change (id, "projectId", "repoId", repo, number, url, title, author, "mergedAt", state, "updatedAt")
         SELECT gen_random_uuid()::text, id, 1, 'acme/app', 7, 'https://github.com/acme/app/pull/7', 'Dark theme for the whole app', 'octo', now(), 'READY', now()
         FROM project WHERE slug = $1 RETURNING id
       )
       INSERT INTO code_change_action (id, "codeChangeId", kind, probability, status, "dueAt")
       SELECT gen_random_uuid()::text, change.id, 'LINKS', 0.9, s.status::"CodeChangeActionStatus", s.due FROM change,
         (VALUES ('PENDING', NULL::timestamp), ('SCHEDULED', now() + interval '1 hour')) AS s(status, due)`,
      [slug],
    );
  } finally {
    await db.end();
  }

  await owner.goto(`/app/${slug}`);
  // Conversations, then Autopilot, then posts to triage.
  expect(await groups(owner)).toEqual(["Need a reply", "Autopilot's changes", "New posts to triage"]);
  // Five of the seven posts, oldest first, each with its action; See all opens Feedback's Needs triage.
  const triage = owner.getByRole("region", { name: "New posts to triage" });
  await expect(triage.getByRole("heading")).toHaveText("New posts to triage 7");
  await expect(triage.getByRole("listitem")).toHaveCount(5);
  await expect(triage.getByRole("listitem").first().getByRole("link", { name: "Triage" })).toHaveAttribute("href", `/app/${slug}/p/1`);
  await expect(triage.getByRole("link", { name: "See all: New posts to triage" })).toHaveAttribute("href", `/app/${slug}/feedback`);
  await expect(owner.getByRole("region", { name: "Need a reply" }).getByRole("link", { name: "See all: Need a reply" })).toHaveAttribute("href", `/app/${slug}/inbox`);
  // Counted as changes, as its rows are (the tile above counts the updates waiting in them).
  const changes = owner.getByRole("region", { name: "Autopilot's changes" });
  await expect(changes.getByRole("heading")).toHaveText("Autopilot's changes 1");
  const change = changes.getByRole("listitem");
  await expect(change).toContainText("Dark theme for the whole app · 1 update");
  await expect(change).toContainText(/(just now|ago) · 1 update goes out (today|tomorrow) at/);
  // Under way with posts of its own: Get set up for what's left, but no sample content offered.
  await expect(owner.getByRole("list", { name: "Get set up" }).getByRole("link", { name: "Add the widget to your site" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Add sample content" })).toHaveCount(0);
  await checkpoint(owner, "home");

  // On a phone: a row's title and its meta read in two lines; Autopilot's buttons go under them, not beside.
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const title = change.getByRole("link", { name: "Dark theme for the whole app · 1 update" });
  const lineHeight = await title.evaluate((link) => parseFloat(getComputedStyle(link).lineHeight));
  expect((await title.boundingBox())!.height).toBeLessThanOrEqual(lineHeight * 1.5);
  const publish = change.getByRole("button", { name: "Publish now" });
  expect((await publish.boundingBox())!.y).toBeGreaterThan((await title.boundingBox())!.y + (await title.boundingBox())!.height);
  for (const row of await owner.getByRole("main").locator("section[aria-label] li").all()) {
    expect((await row.locator("a").first().boundingBox())!.height).toBeLessThanOrEqual(lineHeight * 2.5);
  }
  await checkpoint(owner, "home-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });

  // A number opens its list: every post, newest first.
  await owner.getByRole("link", { name: /^8\s*New posts this week$/ }).click();
  await owner.waitForURL(`**/app/${slug}/feedback?status=all&sort=new`);
  await expect(owner.getByRole("main").getByRole("listitem").getByRole("link", { name: /^(Dark mode|Exports)$/ })).toHaveText(["Exports", "Dark mode"]);
});

test("Home on a new project says how to start, with Get set up and sample content; not that the team is all caught up", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await expect(owner.getByText("Nothing here yet")).toBeVisible();
  await expect(owner.getByText("Share your portal or add the widget: new posts show up here.")).toBeVisible();
  await expect(owner.getByText("You're all caught up")).toHaveCount(0);
  await expect(owner.getByRole("link", { name: "Set up your project" })).toHaveAttribute("href", `/app/${slug}/setup`);
  // Get set up: what's left, each a link to do it, and sample content to try things with.
  const setup = owner.getByRole("list", { name: "Get set up" });
  await expect(setup.getByRole("link", { name: "Publish an article" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Add sample content" })).toBeVisible();
  await checkpoint(owner, "home-new-project");
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "home-new-project-phone");
});
