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
  for (const [name, description, icon] of [
    ["Getting started", "Set up your calendar and your team in a few minutes.", "rocket"],
    ["Calendars and events", "Manage events and bring your calendars together.", "calendar"],
    ["Billing", "Plans, payments and seats.", "credit-card"],
    ["API", "Build with your calendar.", "code"],
  ])
    await api("/collections", { name, description, icon });
  await api("/tabs", { name: "Developers" });
  const plans =
    "Each plan has 5 seats. Add seats from Billing at any time.\n\nYou pay for the rest of the month for each seat you add.\n\nPeople are admins or members. Admins manage billing and seats; members use the calendar.";
  const articles = [
    ["Create your first calendar", "getting-started"],
    ["Invite your team", "getting-started"],
    ["Keyboard shortcuts", "getting-started"],
    ["Import an .ics file", "calendars-and-events"],
    ["Repeat an event", "calendars-and-events"],
    ["Change the theme", "calendars-and-events"],
    ["Sync with Google Calendar", "calendars-and-events"],
    ["Time zones", "calendars-and-events"],
    ["Plans and seats", "billing"],
    ["Invoices", "billing"],
    ["API keys", "api"],
    ["Contact support", null],
  ];
  const text = (text: string) => ({ type: "text", text });
  const p = (value: string) => ({ type: "paragraph", content: [text(value)] });
  const h = (value: string) => ({ type: "heading", attrs: { level: 2 }, content: [text(value)] });
  const sync = {
    type: "doc",
    content: [
      p("Acme Calendar can import a Google calendar once, as a file. Changes made later in Google don’t show up here."),
      h("Export from Google"),
      {
        type: "orderedList",
        content: ["Open Google Calendar’s Settings, then Import & export.", "Pick Export.", "Unzip it: there’s one .ics file per calendar."].map(
          (value) => ({ type: "listItem", content: [p(value)] }),
        ),
      },
      h("Import into Acme Calendar"),
      p("Open Settings, then Import, and upload the .ics file Google gives you."),
      h("What doesn’t come across"),
      {
        type: "bulletList",
        content: ["Event colours", "Guests’ replies", "Changes made later in Google"].map((value) => ({ type: "listItem", content: [p(value)] })),
      },
    ],
  };
  for (const [title, collection] of articles) {
    const articleSlug = title!.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await api("/articles", {
      title,
      collection,
      ...(title === "Sync with Google Calendar"
        ? { content: sync, description: "Bring your Google events into Acme Calendar." }
        : title === "Plans and seats"
          ? { body: plans, description: "How plans, billing and seats work." }
          : { body: "Open Settings to get started. Follow the steps to set up your calendar and invite your team." }),
    });
    await api(`/articles/${articleSlug}/publish`, {});
  }
  await api(
    "/articles/sync-with-google-calendar",
    { content: { ...sync, content: [...sync.content, p("Two-way sync is in progress. Follow it on the roadmap to hear when it ships.")] } },
    "PATCH",
  );
  await api("/articles/keyboard-shortcuts", { body: "Use keyboard shortcuts to get around faster." }, "PATCH");
  const repo = `acme/calendar-${randomUUID().slice(0, 8)}`;
  await connectGithub(team, slug, { repositories: [{ id: randomInt(1_000_000, 2_000_000_000), fullName: repo }] });
  const snapshot = await fetch(`${process.env.E2E_GITHUB_URL}/_fake/repository`, {
    method: "POST",
    body: JSON.stringify({
      repo,
      commit: "c0ffee1234567",
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
      if (path.includes("google") || path.includes("plans")) await expect(team.locator("#article-title textarea")).toBeVisible();
      await team.evaluate(() => document.fonts.ready);
      expect(await team.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if (path.includes("history")) await expect(team.getByRole("region", { name: "Changes since this version" })).toBeVisible();
      if (path.includes("verify")) await expect(team.getByText("Plans now include 10 seats.").first()).toBeVisible();
      await expect(team.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
      await checkpoint(team, `${name}-${width === 1440 ? "laptop" : "phone"}-${theme}`, { fullPage: false });
    }
    if (width === 390) {
      await team.getByRole("button", { name: "Browse docs" }).click();
      await expect(team.getByRole("dialog", { name: "Docs navigation" })).toBeVisible();
      await checkpoint(team, `tree-sheet-phone-${theme}`, { fullPage: false });
      await team.keyboard.press("Escape");
    }
  }
});
