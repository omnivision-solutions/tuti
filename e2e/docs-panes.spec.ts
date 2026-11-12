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
  // The title field shows the title: the heading is for screen readers, and the phone bar doesn't repeat it.
  expect((await editorHeader.getByRole("heading", { name: "Create your first calendar", level: 1 }).boundingBox())!.width).toBeLessThanOrEqual(1);
  await expect(editorHeader.locator('[data-slot="pane-header"]')).toHaveAttribute("data-title-in-form", "true");
  await expect(team.locator(".docs-editor-scroll").getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Create your first calendar");
  await checkpoint(team, "docs-editor", { fullPage: false });
  // One in no collection goes back to all the articles.
  await team.goto(`/app/${slug}/docs/contact-support`);
  await expect(editorHeader.getByRole("link", { name: "All articles", exact: true })).toHaveAttribute("href", `/app/${slug}/docs`);

  // On a phone the header's Browse docs opens the tree; a page of one article shows only its way back.
  await team.setViewportSize({ width: 390, height: 844 });
  await team.goto(`/app/${slug}/docs`);
  await checkpoint(team, "docs-overview-phone", { fullPage: false });
  await header.getByRole("button", { name: "Browse docs", exact: true }).click();
  const tree = team.getByRole("dialog", { name: "Docs navigation", exact: true });
  await expect(tree.getByRole("link", { name: "Getting started", exact: true })).toBeVisible();
  await checkpoint(team, "docs-tree-phone", { fullPage: false });
  await tree.getByRole("link", { name: "Getting started", exact: true }).click();
  await team.waitForURL(`**/docs/collections/getting-started`);
  await team.goto(`/app/${slug}/docs/create-your-first-calendar`);
  await expect(editorHeader.getByRole("link", { name: "Getting started", exact: true })).toBeVisible();
  expect((await editorHeader.getByRole("heading", { name: "Create your first calendar", level: 1 }).boundingBox())!.width).toBeLessThanOrEqual(1);
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
});
