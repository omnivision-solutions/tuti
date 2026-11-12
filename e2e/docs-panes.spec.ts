import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

test("Docs pages are panes: the tree as the area's pane, views as pills, the editor's way back", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/collections", { name: "Getting started" });
  await api("/articles", { title: "Create your first calendar", body: "Open Calendars and pick New calendar.", collection: "getting-started" });
  await api("/articles", { title: "Contact support", body: "Write to us any time." });
  await api("/tabs", { name: "Guides" });
  await team.setViewportSize({ width: 1280, height: 900 });

  // The overview: the tree beside the page, each titled in its pane's header.
  await team.goto(`/app/${slug}/docs`);
  await expect(team.locator(".docs-tree-pane").getByRole("heading", { name: "Docs", level: 2, exact: true })).toBeVisible();
  const header = team.locator('[data-slot="docs-page-header"] [data-slot="pane-header"]');
  await expect(header.getByRole("heading", { name: "Overview", level: 1, exact: true })).toBeVisible();
  await expect(team.getByRole("button", { name: "Browse docs", exact: true })).toBeHidden();
  await checkpoint(team, "docs-overview", { fullPage: false });

  // A tab's views are pills in its header, each its own address.
  await team.goto(`/app/${slug}/docs/tabs/guides`);
  const views = team.getByRole("navigation", { name: "Tab", exact: true });
  await expect(views.getByRole("link", { name: "Content", exact: true })).toHaveAttribute("aria-current", "page");
  await views.getByRole("link", { name: "Access", exact: true }).click();
  await team.waitForURL(`**/docs/tabs/guides?view=access`);
  await expect(views.getByRole("link", { name: "Access", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(team.getByRole("region", { name: "Access", exact: true }).getByRole("radio", { name: "Inherit" })).toBeVisible();

  // A collection's too.
  await team.goto(`/app/${slug}/docs/collections/getting-started`);
  const collection = team.getByRole("navigation", { name: "Collection", exact: true });
  await expect(collection.getByRole("link", { name: "Content", exact: true })).toHaveAttribute("aria-current", "page");
  await checkpoint(team, "docs-collection", { fullPage: false });

  // An article's editor: back to its collection before the title, the title field in the text.
  await team.goto(`/app/${slug}/docs/create-your-first-calendar`);
  const editorHeader = team.locator('[data-slot="docs-page-header"]');
  await expect(editorHeader.getByRole("link", { name: "Getting started", exact: true })).toHaveAttribute("href", `/app/${slug}/docs/collections/getting-started`);
  // The title field shows the title: the heading is for screen readers.
  expect((await editorHeader.getByRole("heading", { name: "Create your first calendar", level: 1 }).boundingBox())!.width).toBeLessThanOrEqual(1);
  await expect(editorHeader.locator('[data-slot="pane-header"]')).toHaveAttribute("data-title-in-form", "true");
  await expect(team.locator(".docs-editor-scroll").getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Create your first calendar");
  await checkpoint(team, "docs-editor", { fullPage: false });
  // One in no collection goes back to all the articles.
  await team.goto(`/app/${slug}/docs/contact-support`);
  await expect(editorHeader.getByRole("link", { name: "Docs", exact: true })).toHaveAttribute("href", `/app/${slug}/docs`);

  // On a phone the header's Browse docs opens the tree; a page of one article shows only its way back.
  await team.setViewportSize({ width: 390, height: 844 });
  await team.goto(`/app/${slug}/docs`);
  await checkpoint(team, "docs-overview-phone", { fullPage: false });
  // "View on help center" stays in words: under More actions, the header keeping room for the page's title.
  await expect(header.getByRole("link", { name: "View on help center", exact: true })).toBeHidden();
  // Clicked again until it opens: a click before the page hydrates does nothing.
  const moreActions = header.getByRole("button", { name: "More actions", exact: true });
  await expect(async () => {
    await moreActions.click();
    await expect(moreActions).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
  }).toPass();
  await expect(header.getByRole("link", { name: "View on help center", exact: true })).toHaveText("View on help center");
  await moreActions.click();
  await header.getByRole("button", { name: "Browse docs", exact: true }).click();
  const tree = team.getByRole("dialog", { name: "Docs navigation", exact: true });
  await expect(tree.getByRole("link", { name: "Getting started", exact: true })).toBeVisible();
  await checkpoint(team, "docs-tree-phone", { fullPage: false });
  await tree.getByRole("link", { name: "Getting started", exact: true }).click();
  await team.waitForURL(`**/docs/collections/getting-started`);
  await team.goto(`/app/${slug}/docs/create-your-first-calendar`);
  await expect(editorHeader.getByRole("link", { name: "Getting started", exact: true })).toBeVisible();
  expect((await editorHeader.getByRole("heading", { name: "Create your first calendar", level: 1 }).boundingBox())!.width).toBeLessThanOrEqual(1);
  // Docs has no phone bar to repeat the title: the title field says it once.
  await expect(team.locator('[data-slot="bar-title"], [data-slot="bar-path"]')).toHaveCount(0);
  await checkpoint(team, "docs-editor-phone", { fullPage: false });

  // With unpublished changes the header's row still fits a phone: More actions inside the pane.
  await api("/articles/create-your-first-calendar/publish", {});
  await api("/articles/create-your-first-calendar", { body: "Open Calendars, then New calendar." }, "PATCH");
  await team.reload();
  await expect(editorHeader.getByRole("button", { name: "Manage unpublished changes", exact: true })).toBeVisible();
  const pane = (await editorHeader.boundingBox())!;
  const more = (await editorHeader.getByRole("button", { name: "More actions", exact: true }).boundingBox())!;
  expect(more.x + more.width).toBeLessThanOrEqual(pane.x + pane.width);
  await checkpoint(team, "docs-editor-changes-phone", { fullPage: false });

  // With the tree at its widest beside a 61rem shell, a collection's header keeps its title and pills whole.
  await team.evaluate(() => localStorage.setItem("tuti:docs-tree-width", "440"));
  await team.setViewportSize({ width: 1024, height: 900 });
  await team.goto(`/app/${slug}/docs/collections/getting-started`);
  await expect(team.locator(".docs-tree-pane")).toHaveCSS("width", "440px");
  const title = header.getByRole("heading", { name: "Getting started", level: 1 });
  await expect(title).toBeVisible();
  expect(await title.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  const pills = team.getByRole("navigation", { name: "Collection", exact: true });
  const row = (await pills.boundingBox())!;
  for (const name of ["Content", "Settings"]) {
    const pill = (await pills.getByRole("link", { name, exact: true }).boundingBox())!;
    expect(pill.x).toBeGreaterThanOrEqual(row.x);
    expect(pill.x + pill.width).toBeLessThanOrEqual(row.x + row.width);
  }
  await checkpoint(team, "docs-collection-wide-tree", { fullPage: false });

  // A narrow editor's row (the tree at its widest, the tools beside it) drops the state's details, never its actions.
  await team.setViewportSize({ width: 1280, height: 900 });
  await team.goto(`/app/${slug}/docs/create-your-first-calendar?history`);
  await expect(team.getByRole("complementary", { name: "Article tools" })).toBeVisible();
  const editor = (await team.locator(".docs-editor-page").boundingBox())!;
  for (const name of ["Publish changes", "More actions"]) {
    const button = (await editorHeader.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(button.x + button.width).toBeLessThanOrEqual(editor.x + editor.width);
  }
  await checkpoint(team, "docs-editor-narrow", { fullPage: false });
});

test("a long Docs page's sticky header, pills and all, never covers what's focused", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/collections", { name: "Getting started" });
  for (let i = 1; i <= 25; i++) await api("/articles", { title: `Guide ${i}`, body: "Instructions for your team.", collection: "getting-started" });
  await team.setViewportSize({ width: 1280, height: 900 });
  await team.goto(`/app/${slug}/docs/collections/getting-started`);
  const pane = team.locator(".docs-page-content");
  const header = team.locator('[data-slot="docs-page-header"]');
  await expect(header.getByRole("navigation", { name: "Collection", exact: true })).toBeVisible();
  await expect.poll(() => pane.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(600);
  // Before any script runs (an address with an #anchor lands then), the stylesheet's padding already clears the header and its pills.
  const bare = await browser.newContext({ javaScriptEnabled: false, storageState: await team.context().storageState(), viewport: { width: 1280, height: 900 } });
  const page = await bare.newPage();
  await page.goto(`${APP_URL}/app/${slug}/docs/collections/getting-started`);
  const height = (await page.locator('[data-slot="docs-page-header"]').boundingBox())!.height;
  expect(await page.locator(".docs-page-content").evaluate((element) => parseFloat(getComputedStyle(element).scrollPaddingTop))).toBeGreaterThanOrEqual(height);
  await bare.close();
  // Once the header has measured itself (its height before then is the stylesheet's).
  await expect.poll(() => pane.evaluate((element) => element.style.getPropertyValue("--docs-header-height"))).not.toBe("");
  // A row brought into view at the pane's top (as focus or a link to it does) lands below the header, not under it.
  const row = team.getByRole("region", { name: "Getting started" }).getByRole("link", { name: "Guide 5", exact: true });
  await row.evaluate((element) => element.scrollIntoView({ block: "start", container: "nearest" } as ScrollIntoViewOptions));
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const bottom = (await header.boundingBox())!;
  expect((await row.boundingBox())!.y).toBeGreaterThanOrEqual(bottom.y + bottom.height);
});
