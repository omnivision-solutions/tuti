import { randomUUID } from "node:crypto";
import { type Browser, expect, test } from "@playwright/test";
import pg from "pg";
import { APP_URL } from "./env";
import { checkpoints } from "./checkpoint";
import { apiFor, createProject, signUp } from "./helpers";
import { verifyEmail } from "./mail";
import { sesComplaint } from "./ses";

async function inbox(browser: Browser) {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await verifyEmail(owner);
  // A support address, so replies are emailed at all (replyRecipient).
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  await expect(owner.getByText("No email received yet.")).toBeVisible();
  const api = await apiFor(owner, slug);
  await api("/conversations", { email: "e2e-reader@example.com", subject: "Reports", body: "First message" });
  await owner.setViewportSize({ width: 1440, height: 900 });
  return { owner, slug, api, url: `/app/${slug}/inbox/1` };
}

async function update(sql: string, values: unknown[]) {
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try { await db.query(sql, values); } finally { await db.end(); }
}

test("blocked recipients have no composer promise that replies are emailed", async ({ browser }) => {
  const { owner, slug, url } = await inbox(browser);
  await owner.goto(url);
  await expect(owner.getByText("Replies are emailed to e2e-reader@example.com.", { exact: true })).toBeVisible();
  await sesComplaint(slug, "E2E-Reader@example.com");
  await owner.reload();
  await expect(owner.getByText(/^(Replies are emailed|Emailed) to/)).toHaveCount(0);
});

test("sample conversations have no composer promise that replies are emailed: the reply job skips them", async ({ browser }) => {
  const { owner, slug, url } = await inbox(browser);
  await owner.goto(url);
  await expect(owner.getByText("Replies are emailed to e2e-reader@example.com.", { exact: true })).toBeVisible();
  await update(`UPDATE conversation c SET sample = true FROM project p WHERE c."projectId" = p.id AND p.slug = $1`, [slug]);
  await owner.reload();
  await expect(owner.getByText(/^(Replies are emailed|Emailed) to/)).toHaveCount(0);
});

test("each message day is grouped in the viewer's time zone", async ({ browser }) => {
  const { owner, slug, api, url } = await inbox(browser);
  await api("/conversations/1/messages", { body: "Second message" });
  await api("/conversations/1/messages", { body: "Third message" });
  await update(`UPDATE conversation_message m SET "createdAt" = CASE m.body WHEN 'First message' THEN '2026-03-08T07:30:00Z'::timestamptz WHEN 'Second message' THEN '2026-03-08T08:30:00Z'::timestamptz ELSE '2026-03-08T09:30:00Z'::timestamptz END FROM conversation c, project p WHERE m."conversationId" = c.id AND c."projectId" = p.id AND p.slug = $1`, [slug]);
  const context = await browser.newContext({ storageState: await owner.context().storageState(), timezoneId: "America/Los_Angeles" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-03-09T19:00:00Z"));
  await page.goto(`${APP_URL}${url}`);
  await expect(page.locator(".inbox-day")).toHaveText(["7 March", "Yesterday · 8 March"]);
  const messages = page.getByRole("list", { name: "Messages" }).locator(":scope > li");
  await expect(messages).toHaveCount(3);
  await expect(messages.nth(0).locator(".inbox-day")).toHaveText("7 March");
  await expect(messages.nth(1).locator(".inbox-day")).toHaveText("Yesterday · 8 March");
  await expect(messages.nth(2).locator(".inbox-day")).toHaveCount(0);
  await context.close();
});

for (const state of ["closed", "spam"] as const) {
  test(`${state} conversations with a lingering snooze use the Snooze label`, async ({ browser }) => {
    const { owner, slug, url } = await inbox(browser);
    await update(`UPDATE conversation c SET "snoozedUntil" = NOW() + interval '1 day', status = $2::"ConversationStatus", spam = $3 FROM project p WHERE c."projectId" = p.id AND p.slug = $1`, [slug, state === "closed" ? "CLOSED" : "OPEN", state === "spam"]);
    await owner.goto(url);
    const triage = owner.locator(".inbox-triage");
    await expect(triage).toContainText("Not snoozed");
    await expect(triage.getByText("Snooze", { exact: true })).toBeVisible();
    await expect(triage.getByText("Waiting until", { exact: true })).toHaveCount(0);
  });
}

test("triage accessible names include the visible values", async ({ browser }) => {
  const { owner, url } = await inbox(browser);
  await owner.goto(url);
  const details = owner.getByRole("complementary", { name: "Conversation details", exact: true });
  await expect.soft(details.getByRole("button", { name: /Unassigned/ })).toBeVisible();
  await expect.soft(details.getByRole("button", { name: "Needs reply, change status" })).toBeVisible();
  await expect.soft(details.getByRole("button", { name: "Not snoozed", exact: true })).toBeVisible();
});

test("a details sheet stays closed after widening then narrowing", async ({ browser }) => {
  const { owner, url } = await inbox(browser);
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(url);
  await owner.getByRole("button", { name: "Show details" }).click();
  const sheet = owner.getByRole("dialog", { name: "Conversation details" });
  await expect(sheet).toBeVisible();
  await owner.setViewportSize({ width: 1440, height: 900 });
  await expect(sheet).toBeHidden();
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(sheet).toBeHidden();
  await owner.getByRole("button", { name: "Show details" }).click();
  await expect(sheet).toBeVisible();
});

test("the details sheet close target uses the dense 32px size", async ({ browser }) => {
  const { owner, url } = await inbox(browser);
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(url);
  await owner.getByRole("button", { name: "Show details" }).click();
  const close = owner.getByRole("dialog", { name: "Conversation details" }).getByRole("button", { name: "Close", exact: true });
  await expect(close).toHaveCSS("height", "32px");
  await expect(close).toHaveCSS("width", "32px");
});

test("overview keeps one page heading and small stat labels with captions", async ({ browser }) => {
  const { owner, slug } = await inbox(browser);
  await owner.goto(`/app/${slug}/inbox`);
  await expect.soft(owner.getByRole("heading", { level: 1 })).toHaveText(["Inbox"]);
  const stats = owner.locator(".inbox-overview-stats");
  await expect.soft(stats.getByText("Waiting for a reply", { exact: true })).toHaveCSS("font-size", "13px");
  await expect.soft(stats.getByText("New conversations this week", { exact: true })).toHaveCSS("font-size", "13px");
  await expect.soft(stats.getByText("Conversations started", { exact: true })).toBeVisible();
});

test("an unverified sender is marked in the conversation header", async ({ browser }) => {
  const { owner, url } = await inbox(browser);
  await owner.goto(url);
  await expect(owner.locator("header[data-inbox-header]")).toContainText("(not verified)");
});

test("only needs reply uses the attention colour in header and status picker", async ({ browser }) => {
  const { owner, api, url } = await inbox(browser);
  await owner.goto(url);
  const pill = owner.locator(".inbox-conversation-state");
  const dot = owner.locator(".inbox-triage .inbox-status-dot");
  const attention = await pill.evaluate((el) => getComputedStyle(el).backgroundColor);
  const attentionDot = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
  for (const status of ["waiting", "closed"] as const) {
    if (status === "waiting") await api("/conversations/1/messages", { body: "Reply" });
    else await api("/conversations/1", { status }, "PATCH");
    await owner.reload();
    expect.soft(await pill.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(attention);
    expect.soft(await dot.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(attentionDot);
  }
});

test("inline link trigger retains keyboard focus when dismissed while saving", async ({ browser }) => {
  const { owner, api, url } = await inbox(browser);
  await api("/users", { users: [{ id: "author", name: "Sam", email: "e2e-author@example.com" }] });
  await api("/posts", { board: "feature-requests", title: "Report exports", body: "Export reports", author: { id: "author" } });
  await owner.goto(url);
  const trigger = owner.getByRole("button", { name: "Link a post to this conversation", includeHidden: true });
  await trigger.click();
  const dialog = owner.getByRole("dialog", { name: "Link a post" });
  await dialog.getByRole("textbox").fill("Report");
  const candidate = dialog.getByRole("button", { name: /Report exports/ });
  await expect(candidate).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await owner.route("**/*", async (route) => {
    if (!route.request().headers()["next-action"]) return route.fallback();
    await held;
    await route.abort();
  });
  try {
    await candidate.click();
    await expect(trigger).toHaveAttribute("aria-disabled", "true");
    await owner.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  } finally { release(); }
  await expect(owner.getByText("Couldn't reach Tuti. Try again.")).toBeVisible();
});


test("other conversations use a status dot alongside the text", async ({ browser }) => {
  const { owner, api, url } = await inbox(browser);
  await api("/conversations", { email: "e2e-reader@example.com", subject: "Previous question", body: "All sorted" });
  await api("/conversations/2", { status: "closed" }, "PATCH");
  await owner.goto(url);
  await owner.locator("summary", { hasText: "Other conversations from this person" }).click();
  const other = owner.getByRole("region", { name: "Other conversations", exact: true });
  await expect(other).toContainText("Closed");
  await expect(other.locator(".bg-status-closed")).toBeVisible();
});


test("the AI-answer origin stays visible with details collapsed and on phones", async ({ browser }) => {
  const { owner, slug, url } = await inbox(browser);
  await update(`UPDATE conversation c SET origin = 'ESCALATION' FROM project p WHERE c."projectId" = p.id AND p.slug = $1`, [slug]);
  await owner.goto(url);
  await owner.getByRole("button", { name: "Hide details" }).click();
  const origin = owner.locator("header[data-inbox-header]").getByText(/started from an AI answer/);
  await expect(origin).toBeVisible();
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(origin).toBeVisible();
});


test("conversation dates use the viewer's day and a written month", async ({ browser }, testInfo) => {
  const { owner, slug, api, url } = await inbox(browser);
  await api("/conversations", { email: "e2e-reader@example.com", subject: "Previous question", body: "All sorted" });
  await update(`UPDATE conversation c SET "createdAt" = '2026-03-08T07:30:00Z', "lastMessageAt" = '2026-03-08T07:30:00Z' FROM project p WHERE c."projectId" = p.id AND p.slug = $1`, [slug]);
  const context = await browser.newContext({ storageState: await owner.context().storageState(), timezoneId: "America/Los_Angeles", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-03-09T19:00:00Z"));
  await page.goto(`${APP_URL}${url}`);
  await page.locator("summary", { hasText: "Conversation attributes" }).click();
  const started = page.getByText("Started", { exact: true }).locator("+ dd");
  await expect.soft(started).toHaveText("7 March 2026");
  await page.locator("summary", { hasText: "Other conversations from this person" }).click();
  const other = page.getByRole("region", { name: "Other conversations", exact: true });
  await expect.soft(other).toContainText("#2 · 7 March");
  await checkpoints(testInfo)(page, "viewer-local-conversation-dates");
  await context.close();
});

for (const label of ["More actions", "Inbox options"]) {
  test(`${label} closes when tabbing out and leaves Escape in the reply box alone`, async ({ browser }, testInfo) => {
    const { owner, url } = await inbox(browser);
    await owner.goto(url);
    const trigger = owner.getByRole("button", { name: label, exact: true });
    const action = owner.getByText(label === "More actions" ? "Link a post…" : "Stop emailing me new conversations", { exact: true });
    await trigger.click();
    await expect(action).toBeVisible();
    await checkpoints(testInfo)(owner, "actions-menu");
    // Shift+Tab exits the popup even when focus starts on the trigger in the old implementation.
    await owner.keyboard.press("Shift+Tab");
    await expect.soft(action).toBeHidden();
    if (await action.isVisible()) await trigger.click();
    await trigger.click();
    await expect(action).toBeVisible();
    const reply = owner.getByRole("textbox", { name: "Reply", exact: true });
    // Keyboard/programmatic focus leaving the popup must dismiss it, just like a pointer click.
    await reply.focus();
    await reply.press("Escape");
    await expect.soft(reply).toBeFocused();
    await expect.soft(action).toBeHidden();
  });
}
