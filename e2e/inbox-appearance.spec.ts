import { randomUUID } from "node:crypto";

import pg from "pg";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { expect, type Page, test } from "./fixtures";
import { apiFor, createProject, signUp } from "./helpers";

/** Labels fit on one line, the counts share a right edge, and the popup ends at the trigger. */
async function expectViewsMenu(page: Page) {
  const menu = page.getByRole("menu");
  await menu.evaluate(async (popup) => { await Promise.all(popup.getAnimations({ subtree: true }).map((animation) => animation.finished)); });
  const trigger = page.getByRole("navigation", { name: "Views", exact: true }).getByRole("button", { name: "More", exact: true });
  const items = menu.getByRole("menuitem");
  const rightEdges: number[] = [];
  for (const item of await items.all()) {
    const label = (await item.locator("span").first().boundingBox())!;
    const count = (await item.locator("span").last().boundingBox())!;
    expect.soft(label.height).toBeLessThanOrEqual(22);
    expect.soft(Math.abs(label.y + label.height / 2 - count.y - count.height / 2)).toBeLessThanOrEqual(1);
    rightEdges.push(count.x + count.width);
  }
  expect.soft(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThanOrEqual(1);
  const popup = (await menu.boundingBox())!;
  const button = (await trigger.boundingBox())!;
  expect.soft(Math.abs(popup.x + popup.width - button.x - button.width)).toBeLessThanOrEqual(1);
  expect.soft(popup.x).toBeGreaterThanOrEqual(0);
  expect.soft(popup.x + popup.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test("Inbox list, composer and views at laptop and phone widths in light and dark", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/support", { inbox: true }, "PATCH");
  await api("/conversations", { user: { id: "sam", name: "Sam Smith", email: "e2e-sam@example.com" }, subject: "Exporting reports", body: "Can I export a report as a spreadsheet?" });
  await api("/conversations", { user: { id: "kim", name: "Kim Lee", email: "e2e-kim@example.com" }, subject: "Inviting a teammate", body: "Where can I invite someone to the project?" });
  await api("/conversations", { email: "e2e-billing@example.com", subject: "Finding an invoice", body: "Where can I download last month's invoice?" });
  // Four-digit counts exercise the menu's intrinsic width, without hundreds of API requests.
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query(`INSERT INTO conversation (id, "projectId", number, subject, status, origin, "updatedAt")
      SELECT 'fixture-' || p.id || '-' || n, p.id, n, 'Answered question', 'WAITING', 'API', now()
      FROM project p CROSS JOIN generate_series(4, 1237) n WHERE p.slug = $1`, [slug]);
  } finally {
    await db.end();
  }

  for (const theme of ["light", "dark"] as const) {
    await team.emulateMedia({ colorScheme: theme });
    await team.evaluate((mode) => localStorage.setItem("theme", mode), theme);
    await team.setViewportSize({ width: 1366, height: 900 });
    await team.goto(`/app/${slug}/inbox/1`);
    await expect(team.getByRole("textbox", { name: "Reply", exact: true })).toBeVisible();
    await expect(team.locator('[data-row-link="1"]')).not.toHaveAccessibleName(/unread/i);
    await checkpoint(team, `composer-laptop-${theme}`, { fullPage: false });
    const send = team.getByRole("button", { name: "Send", exact: true });
    const dropdown = team.getByRole("button", { name: "More ways to send", exact: true });
    const left = (await send.boundingBox())!;
    const right = (await dropdown.boundingBox())!;
    expect.soft(Math.abs(left.x + left.width - right.x)).toBeLessThanOrEqual(0.5);
    await expect.soft(send).toHaveCSS("border-right-width", "0px");
    await expect.soft(send).toHaveCSS("border-top-right-radius", "0px");
    await expect.soft(send).toHaveCSS("border-bottom-right-radius", "0px");
    await expect.soft(dropdown).toHaveCSS("border-top-left-radius", "0px");
    await expect.soft(dropdown).toHaveCSS("border-bottom-left-radius", "0px");
    await expect.soft(dropdown).toHaveCSS("border-left-width", "1px");
    expect.soft(await send.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(0);
    expect.soft(await dropdown.evaluate((el) => parseFloat(getComputedStyle(el).borderTopRightRadius))).toBeGreaterThan(0);
    const uploaded = Promise.withResolvers<void>();
    await team.route("**/*", async (route) => {
      if (route.request().method() === "PUT") await uploaded.promise;
      await route.fallback();
    });
    try {
      await team.getByLabel("Files to attach").setInputFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fixture") });
      await expect(team.getByRole("list", { name: "Files to send" })).toContainText("Uploading…");
      await expect(send).toHaveAttribute("aria-disabled", "true");
      await expect(dropdown).toHaveAttribute("aria-disabled", "true");
      await expect(send).toHaveCSS("opacity", "0.5");
      await expect(dropdown).toHaveCSS("opacity", "0.5");
      // The fill fades with the buttons: an opaque wrapper would keep the green fully painted underneath.
      await expect.soft(send.locator("..")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await checkpoint(team, `composer-disabled-laptop-${theme}`, { fullPage: false });
    } finally {
      uploaded.resolve();
      await team.unrouteAll({ behavior: "wait" });
    }
    await expect(team.getByRole("list", { name: "Files to send" })).not.toContainText("Uploading…");
    await team.getByRole("button", { name: "Remove invoice.pdf", exact: true }).click();
    await expect(send).toHaveAttribute("aria-disabled", "false");
    await team.goto(`/app/${slug}/inbox`);
    await checkpoint(team, `list-laptop-${theme}`, { fullPage: false });
    const views = team.getByRole("navigation", { name: "Views", exact: true });
    await views.getByRole("button", { name: "More", exact: true }).click();
    await expect(team.getByRole("menuitem", { name: "Waiting on user 1234" })).toBeVisible();
    await checkpoint(team, `views-laptop-${theme}`, { fullPage: false });
    await expectViewsMenu(team);
    await team.keyboard.press("Escape");
    await team.setViewportSize({ width: 390, height: 844 });
    await views.getByRole("button", { name: "More", exact: true }).click();
    await checkpoint(team, `views-phone-${theme}`, { fullPage: false });
    await expectViewsMenu(team);
    await team.getByRole("menuitem", { name: "Waiting on user 1234" }).click();
    const selected = views.getByRole("button", { name: "Waiting on user 1234" });
    await expect(selected).toHaveAttribute("aria-current", "page");
    await expect.soft(selected).toHaveText(/^Waiting\s*1234$/);
    await checkpoint(team, `view-count-phone-${theme}`, { fullPage: false });
  }
});
