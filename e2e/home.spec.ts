import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";
import pg from "pg";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
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
  // A merged pull request with two new articles' drafts: one waiting for the team and one going out by itself.
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query(
      `WITH change AS (
         INSERT INTO code_change (id, "projectId", "repoId", repo, number, url, title, author, "mergedAt", state, "updatedAt")
         SELECT gen_random_uuid()::text, id, 1, 'acme/app', 7, 'https://github.com/acme/app/pull/7', 'Dark theme for the whole app', 'octo', now(), 'READY', now()
         FROM project WHERE slug = $1 RETURNING id
       )
       INSERT INTO code_change_action (id, "codeChangeId", kind, probability, status, "dueAt", payload)
       SELECT gen_random_uuid()::text, change.id, 'NEW_ARTICLE', 0.9, s.status::"CodeChangeActionStatus", s.due, jsonb_build_object('title', s.title) FROM change,
         (VALUES ('PENDING', NULL::timestamp, 'Pick a theme'), ('SCHEDULED', now() + interval '1 hour', 'Use the dark theme')) AS s(status, due, title)`,
      [slug],
    );
  } finally {
    await db.end();
  }

  await owner.goto(`/app/${slug}`);
  // Conversations, then Autopilot, then posts to triage.
  expect(await groups(owner)).toEqual(["Need a reply", "To review in Autopilot", "New posts to triage"]);
  // Five of the seven posts, oldest first, each with its action; See all opens Feedback's Needs triage.
  const triage = owner.getByRole("region", { name: "New posts to triage" });
  await expect(triage.getByRole("heading")).toHaveText("New posts to triage 7");
  await expect(triage.getByRole("listitem")).toHaveCount(5);
  await expect(triage.getByRole("listitem").first().getByRole("link", { name: "Triage" })).toHaveAttribute("href", `/app/${slug}/p/1`);
  await expect(triage.getByRole("link", { name: "See all: New posts to triage" })).toHaveAttribute("href", `/app/${slug}/feedback`);
  await expect(owner.getByRole("region", { name: "Need a reply" }).getByRole("link", { name: "See all: Need a reply" })).toHaveAttribute("href", `/app/${slug}/inbox`);
  // Autopilot's rows are To review's: a post or article each (here the two drafts, from one pull request), counted
  // as the tile above and the sidebar count them, each opening its review.
  const changes = owner.getByRole("region", { name: "To review in Autopilot" });
  await expect(changes.getByRole("heading")).toHaveText("To review in Autopilot 2");
  await expect(owner.getByRole("link", { name: /^2\s*Posts and articles to review$/ })).toBeVisible();
  await expect(owner.getByRole("link", { name: "Autopilot", exact: true })).toHaveAccessibleDescription("2 to review");
  await expect(changes.getByRole("listitem").getByRole("link", { name: "Pick a theme" })).toHaveAttribute("href", new RegExp(`^/app/${slug}/autopilot/articles/`));
  const change = changes.getByRole("listitem").filter({ hasText: "Use the dark theme" });
  await expect(change).toContainText(/(just now|ago) · 1 update goes out (today|tomorrow) at/);
  // Under way with posts of its own: Get set up for what's left, but no sample content offered.
  await expect(owner.getByRole("list", { name: "Get set up" }).getByRole("link", { name: "Get snippet" })).toHaveAttribute("href", `/app/${slug}/setup?step=widget`);
  await expect(owner.getByRole("button", { name: "Add sample content" })).toHaveCount(0);
  await checkpoint(owner, "home");

  // On a phone: a row's title and its meta read in two lines; Autopilot's buttons go under them, not beside.
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const title = change.getByRole("link", { name: "Use the dark theme" });
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

test("a new project: Home leads with sample content and each setup step's action, no numbers; empty Feedback and Changelog each say what to do", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await expect(owner.getByText("Nothing here yet")).toBeVisible();
  await expect(owner.getByText("Share your portal or add the widget: new posts show up here. Or add sample content to try things with.")).toBeVisible();
  await expect(owner.getByText("You're all caught up")).toHaveCount(0);
  // No row of four 0s before there's anything to count.
  await expect(owner.getByRole("link", { name: /New posts this week/ })).toHaveCount(0);
  // Add sample content is the empty card's main action, Set up your project to its left.
  const attention = owner.locator('[data-slot="card"]', { hasText: "Needs your attention" });
  await expect(attention.getByRole("button", { name: "Add sample content" })).toHaveClass(/\bbg-primary\b/);
  await expect(attention.getByRole("link", { name: "Set up your project" })).toHaveAttribute("href", `/app/${slug}/setup`);
  // The primary on the right, Set up your project to its left.
  expect((await attention.getByRole("link", { name: "Set up your project" }).boundingBox())!.x).toBeLessThan((await attention.getByRole("button", { name: "Add sample content" }).boundingBox())!.x);
  await expect(owner.getByRole("button", { name: "Add sample content" })).toHaveCount(1);
  // Get set up: each step left with its own button, done ones without.
  const setup = owner.getByRole("list", { name: "Get set up" });
  await expect(setup.getByRole("link")).toHaveText(["Verify", "Get snippet", "Connect", "Set up", "New article", "Invite"]);
  await expect(setup.getByRole("link", { name: "New article" })).toHaveAttribute("href", `/app/${slug}/docs/new`);
  await expect(setup.getByRole("link", { name: "Invite" })).toHaveAttribute("href", `/app/${slug}/settings/team`);
  // Each button is read with its step.
  await expect(setup.getByRole("link", { name: "Connect" })).toHaveAccessibleDescription("Connect GitHub");
  await checkpoint(owner, "home-new-project");
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // On a phone too, each step's button sits at the end of its row.
  const row = setup.getByRole("listitem").filter({ hasText: "Publish an article" });
  const button = (await row.getByRole("link").boundingBox())!;
  const item = (await row.boundingBox())!;
  expect(button.x + button.width).toBeCloseTo(item.x + item.width, 0);
  await checkpoint(owner, "home-new-project-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });

  // Feedback with nothing in it: the portal's link to copy, and New post on the portal.
  await owner.goto(`/app/${slug}/feedback`);
  await expect(owner.getByText("No feedback yet")).toBeVisible();
  await owner.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await owner.getByRole("button", { name: "Copy portal link" }).click();
  await expect(owner.getByText("Copied")).toBeVisible();
  expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(portalUrl(slug));
  await expect(owner.getByRole("main").getByRole("link", { name: "New post (on your portal)" }).last()).toHaveAttribute("href", `${portalUrl(slug)}/feedback`);
  await checkpoint(owner, "feedback-empty");

  // The changelog with nothing in it: write the first entry.
  await owner.goto(`/app/${slug}/changelog`);
  await expect(owner.getByText("No entries yet")).toBeVisible();
  await expect(owner.getByRole("link", { name: "Write the first entry" })).toHaveAttribute("href", `/app/${slug}/changelog/new`);
  await checkpoint(owner, "changelog-empty");

  // A number that isn't 0 (a reader's search of the docs that found nothing) brings the numbers back, before the project has anything of its own.
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query(`INSERT INTO docs_search_day ("projectId", day, searches, failed) SELECT id, current_date, 1, 1 FROM project WHERE slug = $1`, [slug]);
    // Its query, listed under Needs your attention.
    await db.query(`INSERT INTO docs_failed_search_day ("projectId", day, query, count) SELECT id, current_date, 'pricing', 1 FROM project WHERE slug = $1`, [slug]);
  } finally {
    await db.end();
  }
  await owner.goto(`/app/${slug}`);
  await expect(owner.getByRole("link", { name: /Searches that found nothing/ })).toHaveText(/^1Searches that found nothing/);
  // With something in Needs your attention, sample content is still offered, in that card's header (so with Get set up done too), while there's nothing of the project's own.
  await expect(owner.getByRole("region", { name: "Queries that found nothing" })).toBeVisible();
  await expect(attention.getByRole("button", { name: "Add sample content" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Add sample content" })).toHaveCount(1);
});
