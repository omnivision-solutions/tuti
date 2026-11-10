import { randomUUID } from "node:crypto";

import { expect, test, type Browser } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

async function editor(browser: Browser) {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/articles", { title: "Invite your team", body: "Owners send invites from Settings." });
  await team.setViewportSize({ width: 1440, height: 900 });
  return { team, slug, api };
}

test("the app sidebar folds for saved and new article editors and opens elsewhere", async ({ browser }) => {
  const { team, slug } = await editor(browser);
  const sidebar = team.locator('[data-slot="sidebar"][data-state]');
  const tree = team.getByRole("navigation", { name: "Docs", exact: true });
  await team.goto(`/app/${slug}/docs`);
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await tree.getByRole("link", { name: "Invite your team" }).click();
  await team.waitForURL(`**/app/${slug}/docs/invite-your-team`);
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await team.locator('[data-slot="sidebar-rail"]').click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await team.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await team.getByRole("button", { name: "Add content" }).click();
  await team.getByRole("menuitem", { name: "New article", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/new`);
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await sidebar.getByRole("link", { name: "Settings", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/settings/general`);
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
});

test("an article editor keeps Save and Publish visible while its text scrolls", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const { team, slug, api } = await editor(browser);
  await api("/articles/invite-your-team", { body: "Owners send invites from Settings.\n\n".repeat(80) }, "PATCH");
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  await expect(team.getByRole("textbox", { name: "Article", exact: true })).toBeVisible();
  await team.evaluate(() => window.scrollTo(0, 700));
  expect(await team.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(700);
  await expect(team.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  await expect(team.getByRole("button", { name: "Publish", exact: true })).toBeInViewport();
  await checkpoint(team, "docs-editor-sticky-actions", { fullPage: false });
});

test("a short window keeps Save and Publish in reach while editing the end of a long article", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const { team, slug, api } = await editor(browser);
  await api("/articles/invite-your-team", { body: "Owners send invites from Settings.\n\n".repeat(80) }, "PATCH");
  await team.setViewportSize({ width: 1024, height: 450 });
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  const article = team.getByRole("textbox", { name: "Article", exact: true });
  await article.click();
  await team.keyboard.press("ControlOrMeta+End");
  await team.keyboard.type("Invite the rest of your team.");
  await expect(article.locator("p").last()).toContainText("Invite the rest of your team.");
  expect(await team.evaluate(() => window.scrollY)).toBeGreaterThan(700);
  const save = team.getByRole("button", { name: "Save", exact: true });
  await expect.soft(save).toBeInViewport();
  await expect.soft(team.getByRole("button", { name: "Publish", exact: true })).toBeInViewport();
  await expect.poll(() => team.locator("html").evaluate((element) => parseFloat(getComputedStyle(element).scrollPaddingTop))).toBeGreaterThan(0);
  await checkpoint(team, "docs-editor-short-window-actions", { fullPage: false });
  await save.click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  await team.reload();
  await expect(article.locator("p").last()).toContainText("Invite the rest of your team.");
});

test("the article text matches the portal's width at 1440px, with and without sections", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const { team, slug, api } = await editor(browser);
  const t = (text: string) => ({ type: "text", text });
  const h2 = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [t(text)] });
  const p = (text: string) => ({ type: "paragraph", content: [t(text)] });
  await api("/articles", { title: "Roles", content: { type: "doc", content: [p("Who can do what."), h2("Owners"), p("Everything."), h2("Members"), p("Their own posts.")] } });
  const text = team.getByRole("textbox", { name: "Article", exact: true });
  for (const [article, rem] of [["invite-your-team", 43], ["roles", 46]] as const) {
    await team.goto(`/app/${slug}/docs/${article}`);
    await expect(text).toBeVisible();
    await expect.poll(async () => Math.round((await text.boundingBox())!.width)).toBe(rem * 16);
    await checkpoint(team, `docs-editor-${article}`);
  }
  await team.getByRole("button", { name: "Hide the docs tree" }).click();
  await expect.poll(async () => Math.round((await text.boundingBox())!.width)).toBe(46 * 16);
  await checkpoint(team, "docs-editor-tree-folded");

  await team.getByRole("button", { name: "Show the docs tree" }).click();
  const tree = team.getByRole("navigation", { name: "Docs", exact: true });
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  await expect(text).toHaveText("Owners send invites from Settings.");
  await expect.poll(async () => Math.round((await text.boundingBox())!.width)).toBe(43 * 16);
  const revision = team.locator('#article-form input[name="revision"]');
  const before = await revision.inputValue();
  await text.fill("Owners send invites from Settings.");
  for (const heading of ["Invitations", "Permissions"]) {
    await team.keyboard.press("Enter");
    await team.keyboard.type("/head");
    await team.getByRole("listbox", { name: "Blocks" }).getByRole("option", { name: "Heading", exact: true }).click();
    await team.keyboard.type(heading);
    await team.keyboard.press("Enter");
    await team.keyboard.type("Owners can manage the team.");
  }
  await expect(text.locator("h2")).toHaveCount(2);
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  // Wait for the refreshed article to reach the form: its new sections must not rewrap the open editor.
  await expect(revision).not.toHaveValue(before);
  await expect.poll(async () => Math.round((await text.boundingBox())!.width)).toBe(43 * 16);
  await checkpoint(team, "docs-editor-saved-width");

  // A different article starts afresh; reopening the saved one now uses its sections too.
  await tree.getByRole("link", { name: "Roles" }).click();
  await team.waitForURL(`**/app/${slug}/docs/roles`);
  await expect(text.locator("h2")).toHaveText(["Owners", "Members"]);
  await expect.poll(async () => Math.round((await text.boundingBox())!.width)).toBe(46 * 16);
  await tree.getByRole("link", { name: "Invite your team" }).click();
  await team.waitForURL(`**/app/${slug}/docs/invite-your-team`);
  await expect(text.locator("h2")).toHaveText(["Invitations", "Permissions"]);
  await expect.poll(async () => Math.round((await text.boundingBox())!.width)).toBe(46 * 16);

  // The old History address opens the editor's panel; it is not a separate Docs page.
  const column = team.locator('[data-slot="pane-layout"] > div');
  const beforeHistory = (await column.boundingBox())!;
  // The toolbar and the article share one left edge and the same reading column.
  expect((await team.locator('[data-slot="page-header"]').boundingBox())!.x).toBe((await text.boundingBox())!.x);
  await team.goto(`/app/${slug}/docs/invite-your-team/history`);
  await team.waitForURL(`**/app/${slug}/docs/invite-your-team?history`);
  const history = team.getByRole("dialog", { name: "History", exact: true });
  await expect(history).toBeVisible();
  await expect.poll(async () => Math.round((await history.boundingBox())!.width)).toBe(36 * 16);
  await expect.poll(() => column.boundingBox()).toEqual(beforeHistory);
  // The panel hides the page from role queries, while the editor keeps its layout behind it.
  const article = team.locator('#article-form [role="textbox"][aria-label="Article"]');
  await expect.poll(async () => Math.round((await article.boundingBox())!.width)).toBe(46 * 16);
  await checkpoint(team, "docs-editor-history-width", { fullPage: false });
});

test("the docs tree remembers its fold across reloads and app pages and unfolds again", async ({ browser }) => {
  const { team, slug } = await editor(browser);
  const tree = team.getByRole("navigation", { name: "Docs", exact: true });
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  await team.getByRole("button", { name: "Hide the docs tree" }).click();
  await expect(tree).toBeHidden();
  await team.reload();
  await expect(team.getByRole("textbox", { name: "Article", exact: true })).toBeVisible();
  await expect(tree).toBeHidden();
  // Opening another app page first must also restore the saved fold before navigating back to Docs.
  await team.goto(`/app/${slug}/settings/general`);
  await team.locator('[data-slot="sidebar"][data-state]').getByRole("link", { name: "Docs", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs`);
  await expect(tree).toBeHidden();
  // A fresh marketing document must restore the saved fold when its app link navigates on the client.
  await team.goto("/");
  await team.locator("header").getByRole("link", { name: "Open app", exact: true }).click();
  await team.waitForURL(`**/app/${slug}`);
  // The app entry restores the preference before a Docs page can render, rather than folding after its first paint.
  await expect(team.locator("html")).toHaveAttribute("data-docs-tree-folded", "");
  await team.locator('[data-slot="sidebar"][data-state]').getByRole("link", { name: "Docs", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs`);
  await expect(team.getByRole("button", { name: "Show the docs tree" })).toBeVisible();
  await expect(tree).toBeHidden();
  await team.getByRole("button", { name: "Show the docs tree" }).click();
  await expect(tree).toBeVisible();
  await team.reload();
  await expect(tree).toBeVisible();
  await expect(team.getByRole("button", { name: "Show the docs tree" })).toBeHidden();
});

test("folding and unfolding the docs tree keeps keyboard focus on the button that reverses it", async ({ browser }) => {
  const { team, slug } = await editor(browser);
  await team.goto(`/app/${slug}/docs/invite-your-team`);
  const hide = team.getByRole("button", { name: "Hide the docs tree" });
  const show = team.getByRole("button", { name: "Show the docs tree" });
  await hide.focus();
  await team.keyboard.press("Enter");
  await expect.soft(show).toBeFocused();
  await expect(show).toHaveAttribute("aria-expanded", "false");
  // Check the reverse direction even if the first focus assertion failed.
  await show.focus();
  await team.keyboard.press("Space");
  await expect.soft(hide).toBeFocused();
  await expect(hide).toHaveAttribute("aria-expanded", "true");
});
