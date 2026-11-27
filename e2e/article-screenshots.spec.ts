import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { query } from "./db";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const heading = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
const doc = (...blocks: object[]) => ({ type: "doc", content: blocks });

/**
 * Help center articles' "[Screenshot: …]" lines filled with screenshots of the team's app (docs/plan.md, SC3), in the
 * article editor, with Browser Use's fake: what a line asks for steers it ("a screen that isn't there" is never reached,
 * "a screen that takes a while" waits to be released).
 */

test("an article's screenshot lines are filled from the editor; one not taken stays with why, and Publish is refused while it does", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // As the docs agent leaves a draft: where a picture belongs.
  const { slug: article } = (await api("/articles", {
    title: "Billing and reports",
    content: doc(paragraph("Open Billing from the menu."), paragraph("[Screenshot: the billing page]"), heading("Reports"), paragraph("Open Reports."), paragraph("[Screenshot: a screen that isn't there, the reports page]")),
  })) as unknown as { slug: string };
  const section = team.getByRole("region", { name: "Screenshots" });
  const text = team.getByRole("textbox", { name: "Article", exact: true });

  // Without Screenshots set up: where to set it up.
  await team.goto(`/app/${slug}/docs/${article}`);
  // Each line highlighted in the text, where it is.
  await expect(text.locator("[data-fill-in]")).toHaveText(["[Screenshot: the billing page]", "[Screenshot: a screen that isn't there, the reports page]"]);
  await expect(section).toContainText("2 lines ask for a screenshot. Tuti can take them: set up your app in Settings → Screenshots.");
  await expect(section.getByRole("link", { name: "set up your app in Settings → Screenshots" })).toHaveAttribute("href", `/app/${slug}/settings/screenshots`);

  // Set up: Take screenshots lists the lines it sends, to read first; each one taken is in the text in place of its line.
  await api("/screenshots/settings", { appUrl: "https://app.example.com", signIn: "none" }, "PATCH");
  await team.reload();
  await section.getByRole("button", { name: "Take screenshots…" }).click();
  const confirm = team.getByRole("alertdialog");
  await expect(confirm.getByRole("heading")).toHaveText("Take these 2 screenshots?");
  await expect(confirm.getByRole("listitem")).toHaveText(["the billing page", "a screen that isn't there, the reports page"]);
  await checkpoint(team, "team-article-screenshots-confirm");
  await confirm.getByRole("button", { name: "Take 2 screenshots" }).click();
  await expect(text.getByRole("img", { name: "The screen: the billing page" })).toBeVisible({ timeout: 30_000 });
  await expect(section).toContainText("1 line asks for a screenshot.");
  await expect(section.getByRole("listitem")).toHaveText("“a screen that isn't there, the reports page”: There's no such screen in the app.");
  await expect(text).toContainText("[Screenshot: a screen that isn't there, the reports page]");
  await expect(text).not.toContainText("[Screenshot: the billing page");
  await checkpoint(team, "team-article-screenshots");
  await team.setViewportSize({ width: 390, height: 844 });
  await section.scrollIntoViewIfNeeded();
  expect(await team.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await checkpoint(team, "team-article-screenshots-phone", { fullPage: false });
  await team.setViewportSize({ width: 1280, height: 720 });

  // The line not taken still holds publishing back: readers would see it.
  await team.getByRole("button", { name: "Publish", exact: true }).first().click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Replace or remove the screenshot line in its text first: [Screenshot: a screen that isn't there, the reports page]")).toBeVisible();
  expect((await query(`SELECT "publishedAt" FROM article WHERE slug = $1 AND "projectId" = (SELECT id FROM project WHERE slug = $2)`, [article, slug]))[0].publishedAt).toBeNull();
});

test("screenshots taken while the article editor is open come in once they're done, and text not saved yet is kept and saved beside them", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/screenshots/settings", { appUrl: "https://app.example.com", signIn: "none" }, "PATCH");
  // Browser Use's fake holds a run asking for this until it's released.
  const { slug: article } = (await api("/articles", {
    title: "The dashboard",
    content: doc(paragraph("The dashboard shows your week."), paragraph("[Screenshot: a screen that takes a while, the dashboard]"), heading("Reports"), paragraph("Open Reports.")),
  })) as unknown as { slug: string };
  const release = async () => expect((await fetch(`${process.env.E2E_BROWSER_USE_URL}/_fake/release`, { method: "POST" })).ok).toBe(true);
  const runs = async () => Number((await query(`SELECT count(*) FROM screenshot_run WHERE "projectId" = (SELECT id FROM project WHERE slug = $1)`, [slug]))[0].count);
  const text = team.getByRole("textbox", { name: "Article", exact: true });
  const section = team.getByRole("region", { name: "Screenshots" });

  // Started from the API (its job runs inline here, so the request ends with the run), the editor shows it running.
  const taking = api(`/articles/${article}/screenshots`, { shots: [{ show: "a screen that takes a while, the dashboard" }] });
  await expect.poll(runs).toBe(1);
  await team.goto(`/app/${slug}/docs/${article}`);
  await expect(section.getByRole("status")).toHaveText("Taking 1 screenshot. This takes a few minutes; you can leave this page.");
  await expect(section.getByRole("button", { name: "Taking screenshots…" })).toBeDisabled();
  // Typed in another section meanwhile, not saved: once it's done the typing stays, and the editor says it was saved since.
  await text.getByText("Open Reports.").click();
  await team.keyboard.press("End");
  await team.keyboard.type(" Typed while it ran.");
  await release();
  await taking;
  // The editor asks every 5 seconds: given longer than an assertion's default.
  await expect(team.getByText("It was saved since you opened it. Your text is kept: save it to see whether anything needs merging.")).toBeVisible({ timeout: 15_000 });
  await expect(text).toContainText("Typed while it ran.");
  await checkpoint(team, "team-article-screenshots-done-unsaved");
  // Saved: on top of the screenshot's version by section, so both are in.
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByRole("region", { name: /Notifications/ }).getByText("Saved", { exact: true })).toBeVisible();
  await team.reload();
  await expect(text.getByRole("img", { name: /^The screen: a screen that takes a while/ })).toBeVisible();
  await expect(text).toContainText("Typed while it ran.");
  await expect(text).not.toContainText("[Screenshot:");
  await expect(section).toContainText("No lines left to fill with a screenshot.");
});
