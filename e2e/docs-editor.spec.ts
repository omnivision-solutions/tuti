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
  await team.locator("header").getByRole("button", { name: "Toggle Sidebar" }).click();
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
