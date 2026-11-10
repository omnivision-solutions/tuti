import pg from "pg";
import { randomInt, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { checkpoints } from "./checkpoint";
import { connectGithub } from "./github";
import { nextModelReply } from "./model";
import { verifyEmail } from "./mail";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

test("Docs surfaces in laptop light, laptop dark and phone layouts", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Olive Owner");
  await verifyEmail(team);
  await createProject(team, "Acme Calendar", slug);
  const api = await apiFor(team, slug);
  // Use a fictional public address so shared captures contain no local hostnames.
  const addressDb = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await addressDb.connect();
  try {
    await addressDb.query(`INSERT INTO custom_domain (id, "projectId", hostname, "verificationToken", "verifiedAt", certificate) SELECT $2, id, 'help.acme.example', 'fictional-verification', now(), 'ACTIVE' FROM project WHERE slug = $1`, [slug, randomUUID()]);
  } finally { await addressDb.end(); }

  for (const [name, description, icon] of [
    ["Getting started", "Set up your calendar and your team in a few minutes.", "rocket"],
    ["Calendars and events", "Manage events and bring your calendars together.", "calendar"],
    ["Billing", "Plans, payments and seats.", "credit-card"],
    ["API", "Build with your calendar.", "code"],
  ])
    await api("/collections", { name, description, icon, ...(name === "Getting started" && { noAccess: "lock" }) });
  await api("/tabs", { name: "Developers" });
  const plans =
    "Each plan has 5 seats. Add seats from Billing at any time.\n\nYou pay for the rest of the month for each seat you add.\n\nPeople are admins or members. Admins manage billing and seats; members use the calendar.";
  const articles = [
    ["Create your first calendar", "getting-started"],
    ["Invite your team", "getting-started"],
    ["Keyboard shortcuts", "getting-started"],
    ["Repeat an event", "calendars-and-events"],
    ["Change the theme", "calendars-and-events"],
    ["Sync with Google Calendar", "calendars-and-events"],
    ["Time zones", "calendars-and-events"],
    ["Plans and seats", "billing"],
    ["Download invoices", "billing"],
    ["Authenticate with an API key", "api"],
    ["List events", "api"],
    ["Contact support", null],
  ];
  const text = (text: string) => ({ type: "text", text });
  const p = (value: string) => ({ type: "paragraph", content: [text(value)] });
  const rich = (parts: (string | [string, string])[]) => ({ type: "paragraph", content: parts.map((part) => typeof part === "string" ? text(part) : { ...text(part[0]), marks: [{ type: part[1] }] }) });
  const link = (value: string, href: string) => ({ ...text(value), marks: [{ type: "link", attrs: { href } }] });
  const callout = { type: "blockquote", content: [{ type: "paragraph", content: [text("Two-way sync is in progress. "), link("Follow it on the roadmap", "https://acme.example/roadmap"), text(" to hear when it ships.")] }] };
  const h = (value: string) => ({ type: "heading", attrs: { level: 2 }, content: [text(value)] });
  const sync = {
    type: "doc",
    content: [
      p("Bring your Google events into Acme Calendar."),
      p("Acme Calendar can import a Google calendar once, as a file. Changes made later in Google don’t show up here."),
      h("Export from Google"),
      {
        type: "orderedList",
        content: [
          rich(["Open Google Calendar’s ", ["Settings", "bold"], ", then ", ["Import & export", "bold"], "."]),
          rich(["Pick ", ["Export", "bold"], "."]),
          rich(["Unzip it: there’s one ", [".ics", "code"], " file per calendar."]),
        ].map((paragraph) => ({ type: "listItem", content: [paragraph] })),
      },
      h("Import into Acme Calendar"),
      rich(["Open ", ["Settings", "bold"], ", then ", ["Import", "bold"], ", and upload the ", [".ics", "code"], " file Google gives you."]),
      callout,
      h("What doesn’t come across"),
      {
        type: "bulletList",
        content: ["Event colours", "Guests’ replies", "Changes made later in Google"].map((value) => ({ type: "listItem", content: [p(value)] })),
      },
      { type: "paragraph" },
    ],
  };
  for (const [title, collection] of articles) {
    const articleSlug = title!.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await api("/articles", {
      title,
      collection,
      ...(title === "Sync with Google Calendar"
        ? { content: { ...sync, content: sync.content.map((block) => block === callout ? p("Google sync is on the roadmap.") : block) }, description: "Bring your Google events into Acme Calendar." }
        : title === "Plans and seats"
          ? { body: plans, description: "How plans, billing and seats work." }
          : { body: "Open Settings to get started. Follow the steps to set up your calendar and invite your team." }),
    });
    if (title === "Sync with Google Calendar") {
      const previous = { ...sync, content: sync.content.map((block) => block === callout ? p("Google sync is on the roadmap.") : block) };
      await api(`/articles/${articleSlug}`, { content: { ...previous, content: previous.content.map((block, index) => index === 0 ? p("Acme Calendar imports a Google calendar from an exported file.") : block) } }, "PATCH");
      await api(`/articles/${articleSlug}`, { content: previous }, "PATCH");
    }
    await api(`/articles/${articleSlug}/publish`, {});
  }
  await api(
    "/articles/sync-with-google-calendar",
    { content: sync },
    "PATCH",
  );
  await api("/articles/keyboard-shortcuts", { body: "Use keyboard shortcuts to get around faster." }, "PATCH");
  for (const article of ["time-zones", "change-the-theme"]) await api(`/articles/${article}`, { body: "Open Settings to adjust your calendar." }, "PATCH");
  await api("/articles", { title: "Old calendar guide", body: "An older guide." });
  await api("/articles/old-calendar-guide", undefined, "DELETE");
  const repo = "acme/app";
  await connectGithub(team, slug, { repositories: [{ id: randomInt(1_000_000, 2_000_000_000), fullName: repo }] });
  const snapshot = await fetch(`${process.env.E2E_GITHUB_URL}/_fake/repository`, {
    method: "POST",
    body: JSON.stringify({
      repo,
      commit: "4be1c0f1234567",
      files: {
        "src/billing/plans.ts": "export const SEATS_PER_PLAN = 10;",
        "src/billing/seats.ts": "export const PRORATE = true;",
        "src/team/roles.ts": "export const roles = ['admin', 'member'];",
      },
    }),
  });
  expect(snapshot.ok).toBe(true);
  await nextModelReply(JSON.stringify({ files: ["src/billing/plans.ts", "src/billing/seats.ts", "src/team/roles.ts"] }), "Plans and seats");
  await nextModelReply(
    JSON.stringify({
      statements: [
        { statement: "Each plan has 5 seats", verdict: "outdated", evidence: ["src/billing/plans.ts"], note: "Plans now include 10 seats." },
        {
          statement: "You pay for the rest of the month for each seat you add",
          verdict: "unclear",
          evidence: ["src/billing/seats.ts"],
          note: "Billing uses prorating, but the billing provider decides the charge.",
        },
        { statement: "People are admins or members", verdict: "current", evidence: ["src/team/roles.ts"], note: "Both roles are supported." },
      ],
      reason: "Plans now include 10 seats.",
      sections: { "1": plans.replace("5 seats", "10 seats") },
    }),
    "Plans and seats",
  );
  await team.goto(`/app/${slug}/docs/plans-and-seats?verify`);
  await team.locator(".docs-tools-scroll").getByRole("button", { name: "Verify", exact: true }).click();
  await expect(team.getByText("Verified: 1 out of date, its fix waits for you")).toBeVisible();
  // A teammate keeps editing the checked wording while the suggested fix waits for review.
  const { revisions } = await api("/articles/plans-and-seats/revisions", undefined, "GET") as unknown as { revisions: { id: string }[] };
  await api("/articles/plans-and-seats", { revision: revisions[0]!.id, content: { type: "doc", content: [
    p("What each plan includes, and how seats are billed."),
    rich(["Each plan has 5 seats. Add seats from ", ["Billing", "bold"], " at any time."]),
    p("You pay for the rest of the month for each seat you add."),
    p("People are admins or members. Admins manage billing and seats; members use the calendar."),
    h("Change your plan"),
    rich(["Open ", ["Billing", "bold"], ", pick ", ["Change plan", "bold"], " and choose the one you need. The new price starts on your next invoice."]),
    { type: "blockquote", content: [{ type: "paragraph", content: [text("Need more than 50 seats? "), link("Contact support", "https://acme.example/support"), text(" for a yearly plan.")] }] },
    { type: "paragraph" },
  ] }, description: "What each plan includes, and how seats are billed." }, "PATCH");
  // Fictional readership and save times make every state visible in the design fixture.
  const database = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await database.connect();
  try {
    for (const [article, views, helpful] of [
      ["create-your-first-calendar", 1023, 1], ["invite-your-team", 648, 4], ["keyboard-shortcuts", 353, 0],
      ["repeat-an-event", 812, 3], ["change-the-theme", 274, 1], ["sync-with-google-calendar", 1240, 5],
      ["time-zones", 391, 2], ["plans-and-seats", 506, 3], ["download-invoices", 318, 2],
      ["authenticate-with-an-api-key", 223, 1], ["list-events", 146, 0], ["contact-support", 236, 1],
    ] as const) {
      await database.query(`INSERT INTO article_view_day ("articleId", day, views) SELECT a.id, CURRENT_DATE, $3 FROM article a JOIN project p ON p.id = a."projectId" WHERE p.slug = $1 AND a.slug = $2`, [slug, article, views]);
      for (let index = 0; index < helpful; index++) await database.query(`INSERT INTO article_feedback ("articleId", "readerId", helpful, "updatedAt") SELECT a.id, $3, true, now() FROM article a JOIN project p ON p.id = a."projectId" WHERE p.slug = $1 AND a.slug = $2`, [slug, article, `fictional-reader-${index}`]);
    }
    await database.query(`UPDATE article_revision SET "createdAt" = "createdAt" - interval '4 days' WHERE "articleId" IN (SELECT a.id FROM article a JOIN project p ON p.id = a."projectId" WHERE p.slug = $1)`, [slug]);
    for (const [article, hours] of [["plans-and-seats", 2], ["sync-with-google-calendar", 2.1], ["keyboard-shortcuts", 24], ["time-zones", 25], ["change-the-theme", 72]] as const)
      { await database.query(`WITH ranked AS (SELECT r.id, row_number() OVER (ORDER BY r."createdAt" DESC, r.id DESC) AS n FROM article_revision r JOIN article a ON a.id = r."articleId" JOIN project p ON p.id = a."projectId" WHERE p.slug = $1 AND a.slug = $2) UPDATE article_revision r SET "createdAt" = now() - ($3::double precision + (ranked.n - 1) * 24) * interval '1 hour' FROM ranked WHERE ranked.id = r.id`, [slug, article, hours]);
      await database.query(`UPDATE article_changes c SET "updatedAt" = now() - $3 * interval '1 hour' FROM article a JOIN project p ON p.id = a."projectId" WHERE c."articleId" = a.id AND p.slug = $1 AND a.slug = $2`, [slug, article, hours]); }
    await database.query(`UPDATE article SET "publishedAt" = '2026-11-02' WHERE "projectId" = (SELECT id FROM project WHERE slug = $1) AND "publishedAt" IS NOT NULL`, [slug]);
  } finally { await database.end(); }
  for (const [theme, width, height] of [
    ["light", 1440, 900],
    ["dark", 1440, 900],
    ["light", 390, 844],
    ["dark", 390, 844],
  ] as const) {
    await team.setViewportSize({ width, height });
    await team.emulateMedia({ colorScheme: theme });
    await team.evaluate((mode) => {
      localStorage.setItem("theme", mode);
    }, theme);
    for (const [name, path] of [
      ["01-overview", ""],
      ["02-collection", "/collections/getting-started"],
      ["03-collection-settings", "/collections/getting-started/settings"],
      ["04-editor-history", "/sync-with-google-calendar?history"],
      ["05-editor-collapsed", "/sync-with-google-calendar"],
      ["06-editor-verify", "/plans-and-seats?verify"],
      ["07-new-article", "/new"],
    ]) {
      await team.goto(`/app/${slug}/docs${path}`);
      await expect(team.locator(".docs-workspace")).toBeVisible();
      if (path.includes("google") || path.includes("plans")) {
        await expect(team.locator("#article-title textarea")).toBeVisible();
        await expect(team.locator('.docs-editor-actions .docs-article-save')).toHaveText("Saved");
      }
      if (path.endsWith("/settings")) {
        await team.getByRole("region", { name: "Access", exact: true }).getByRole("radio", { name: "Signed-in readers", exact: true }).check();
        await expect(team.getByText("1 unsaved change", { exact: true })).toBeVisible();
      }
      if (name === "01-overview") await expect(async () => {
        // Portal links cache their address briefly; wait for the seeded domain to take over.
        await team.reload();
        await expect(team.locator(".docs-live-footer")).toContainText("help.acme.example", { timeout: 1000 });
      }).toPass({ timeout: 20_000 });
      await team.evaluate(() => document.fonts.ready);
      expect(await team.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (path.includes("history")) await expect(team.getByRole("region", { name: "Changes since this version" })).toBeVisible();
      if (path.includes("verify")) {
        await expect(team.getByText("Plans now include 10 seats.").first()).toBeVisible();
        const finding = team.locator("li").filter({ has: team.getByText("Each plan has 5 seats", { exact: true }) });
        await expect(finding.getByRole("link", { name: "Review it" })).toBeVisible();
        await expect(team.locator('[data-verdict="unclear"]')).toHaveCount(1);
        await expect(team.locator('[data-verdict="outdated"]')).toHaveCount(1);
        await expect(team.locator('.docs-editor-page [data-finding] > [aria-hidden="true"]')).toHaveText(["1", "2"]);
      }
      if (width === 1440) {
        await expect(team.getByRole("button", { name: "Developers", exact: true })).toBeVisible();
        await expect(team.getByRole("button", { name: "Add to your docs" })).toBeVisible();
        await expect(team.locator(".docs-tree-footer").getByText("New article", { exact: true })).toHaveCount(0);
        await expect(team.getByRole("link", { name: "Open help center", exact: true })).toBeVisible();
      }
      await expect(team.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
      await team.locator(".docs-page-content").evaluate((element) => { element.scrollTop = 0; });
      await checkpoint(team, `${name}-${width === 1440 ? "laptop" : "phone"}-${theme}`, { fullPage: false });
    }
    if (width === 390) {
      await team.goto(`/app/${slug}/docs`);
      await team.getByRole("button", { name: "Browse docs" }).click();
      await expect(team.getByRole("dialog", { name: "Docs navigation" })).toBeVisible();
      await checkpoint(team, `tree-sheet-phone-${theme}`, { fullPage: false });
      await team.keyboard.press("Escape");
    }
  }
});
