import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";
import pg from "pg";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl, SUPPORT_EMAIL_DOMAIN } from "./env";
import { apiFor, createProject, signUp } from "./helpers";
import { rawEmail, receive } from "./inbound";

/** The kinds "Needs your attention" lists, in order. */
const groups = (page: Page) => page.getByRole("main").locator("section[aria-label]").evaluateAll((sections) => sections.map((s) => s.getAttribute("aria-label")));

test("Home: what needs the team by kind, customers waiting first, three of each; the numbers open their lists; on a phone each row reads in two lines", async ({ browser }, testInfo) => {
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
  // A sample post (as Home's "Add sample content" makes), with an update waiting on it below.
  await api("/posts", { board: "feature-requests", title: "Try exporting to PDF" });
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
    await db.query(`UPDATE post SET sample = true WHERE number = 9 AND "projectId" = (SELECT id FROM project WHERE slug = $1)`, [slug]);
    await db.query(
      `INSERT INTO code_change_action (id, "codeChangeId", kind, probability, status, "postId", payload)
       SELECT gen_random_uuid()::text, c.id, 'MOVES_FORWARD', 0.9, 'PENDING', p.id, '{"comment": "Soon."}'::jsonb
       FROM project pr JOIN code_change c ON c."projectId" = pr.id JOIN post p ON p."projectId" = pr.id AND p.number = 9 WHERE pr.slug = $1`,
      [slug],
    );
  } finally {
    await db.end();
  }

  await owner.goto(`/app/${slug}`);
  // Conversations, then Autopilot, then posts to triage.
  expect(await groups(owner)).toEqual(["Need a reply", "To review in Autopilot", "New posts to triage"]);
  // Three of the seven posts, oldest first, each with its action; See all opens Feedback's Needs triage.
  const triage = owner.getByRole("region", { name: "New posts to triage" });
  await expect(triage.getByRole("heading")).toHaveText("New posts to triage 7");
  await expect(triage.getByRole("listitem")).toHaveCount(3);
  await expect(triage.getByRole("listitem").first().getByRole("link", { name: "Triage" })).toHaveAttribute("href", `/app/${slug}/p/1`);
  await expect(triage.getByRole("link", { name: "See all: New posts to triage" })).toHaveAttribute("href", `/app/${slug}/feedback`);
  await expect(owner.getByRole("region", { name: "Need a reply" }).getByRole("link", { name: "See all: Need a reply" })).toHaveAttribute("href", `/app/${slug}/inbox`);
  // Autopilot's rows are To review's: a post or article each (here the two drafts, from one pull request), counted
  // as the tile above and the sidebar count them, each opening its review.
  const changes = owner.getByRole("region", { name: "To review in Autopilot" });
  await expect(changes.getByRole("heading")).toHaveText("To review in Autopilot 2");
  await expect(owner.getByRole("link", { name: /^2\s*Posts and articles to review$/ })).toBeVisible();
  await expect(owner.locator('[data-sidebar="menu-button"][href$="/autopilot"]')).toHaveAccessibleDescription("2 to review");
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

  // To review lists the sample post's update, labelled Sample, but counts as Home and the sidebar do: 2.
  await owner.goto(`/app/${slug}/autopilot`);
  const list = owner.getByRole("complementary", { name: "Changes" });
  await expect(list.getByRole("tab", { name: "To review 2" })).toBeVisible();
  await expect(list.getByRole("listitem").filter({ has: owner.getByRole("link", { name: "Try exporting to PDF" }) }).last().getByText("Sample", { exact: true })).toBeVisible();
  await expect(owner.locator('[data-sidebar="menu-button"][href$="/autopilot"]')).toHaveAccessibleDescription("2 to review");
  await owner.goto(`/app/${slug}`);

  // Stop, pressed with the keyboard, keeps focus while it runs (its request held here until that's checked), then it's done.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await owner.route(`**/app/${slug}`, async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });
  const stop = change.getByRole("button", { name: "Stop" });
  await stop.focus();
  await owner.keyboard.press("Enter");
  await expect(stop).toHaveAttribute("aria-disabled", "true");
  await expect(stop).toBeFocused();
  release();
  await expect(owner.getByText("Stopped: it waits for you")).toBeVisible();
  await owner.unroute(`**/app/${slug}`);

  // A number opens its list: every post, newest first.
  await owner.getByRole("link", { name: /^8\s*New posts this week$/ }).click();
  await owner.waitForURL(`**/app/${slug}/feedback?status=all&sort=new`);
  await expect(owner.getByRole("main").getByRole("listitem").getByRole("link", { name: /^(Dark mode|Exports)$/ })).toHaveText(["Exports", "Dark mode"]);
});

test("Get set up's cards wrap a long project name inside the card, on a phone and two to a row", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "AcmeAnalyticsPlatformForEnterpriseTeamsAndPartnersWorldwide", slug);
  const list = owner.getByRole("list", { name: "Get set up" });
  const card = list.getByRole("listitem").filter({ hasText: "Set up single sign-on" });
  await expect(card).toContainText("Users sign in with their AcmeAnalyticsPlatformForEnterpriseTeamsAndPartnersWorldwide account");
  // The card stays inside the list, and its text inside the card.
  const fits = async () => {
    const [box, outer] = [(await card.boundingBox())!, (await list.boundingBox())!];
    expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
    expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  };
  await fits();
  await owner.setViewportSize({ width: 390, height: 844 });
  await fits();
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
  await expect(setup.getByRole("link")).toHaveText(["Get snippet", "Connect", "Set up", "New article", "Invite"]);
  await expect(setup.getByRole("link", { name: "New article" })).toHaveAttribute("href", `/app/${slug}/docs/new`);
  await expect(setup.getByRole("link", { name: "Invite" })).toHaveAttribute("href", `/app/${slug}/settings/team`);
  // Each button is read with its step.
  await expect(setup.getByRole("link", { name: "Connect" })).toHaveAccessibleDescription("Connect GitHub");
  // A card per step, two to a row, each saying what it's for. Their buttons are outlines: Add sample content stays the page's one primary.
  const widget = setup.getByRole("listitem").filter({ hasText: "Add the widget to your site" });
  const github = setup.getByRole("listitem").filter({ hasText: "Connect GitHub" });
  await expect(github).toContainText("Autopilot reads your merged pull requests and suggests updates to your posts, docs and changelog.");
  expect((await github.boundingBox())!.y).toBeCloseTo((await widget.boundingBox())!.y, 0);
  await expect(setup.getByRole("link").and(owner.locator(".bg-primary"))).toHaveCount(0);
  await expect(owner.getByRole("progressbar", { name: "Steps done" })).toHaveAttribute("aria-valuenow", "0");
  await checkpoint(owner, "home-new-project");
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // On a phone, one card to a row, as wide as the list.
  const card = (await setup.getByRole("listitem").filter({ hasText: "Publish an article" }).boundingBox())!;
  expect(card.width).toBeCloseTo((await setup.boundingBox())!.width, 0);
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

test("Get set up's support step waits for the inbox's first email once it's on, and is done when it arrives", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/setup?step=use`);
  await owner.getByRole("checkbox", { name: /^Support/ }).check();
  await owner.getByRole("button", { name: "Continue" }).click();
  await owner.waitForURL(`**/app/${slug}/setup?step=widget`);

  // On (which gives it its address): still to do, waiting for the first email.
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("switch", { name: "Messages in the widget" }).click();
  await expect(owner.getByText("Messages on")).toBeVisible();
  await expect(owner.getByText("No email received yet.")).toBeVisible();
  await owner.goto(`/app/${slug}`);
  const card = owner.getByRole("list", { name: "Get set up" }).getByRole("listitem").filter({ hasText: "Set up your support inbox" });
  await expect(card).toContainText("(to do)");
  await expect(card).toContainText("Waiting for your first email");
  await expect(card.getByRole("link", { name: "Set up" })).toBeVisible();
  await checkpoint(owner, "home-support-waiting");

  // The first email in: done.
  await receive(`support@${slug}.${SUPPORT_EMAIL_DOMAIN}`, rawEmail("Kim Lee <e2e-kim@example.com>", "Hello", "Is this the right address?"));
  await owner.reload();
  await expect(card).toContainText("(done)");
  await expect(card).not.toContainText("Waiting for your first email");
});
