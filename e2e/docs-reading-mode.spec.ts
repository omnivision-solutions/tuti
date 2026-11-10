import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

const text = (value: string) => ({ type: "text", text: value });
const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });
const heading = (value: string) => ({ type: "heading", attrs: { level: 2 }, content: [text(value)] });
const long = "Imports go into one calendar. Make a calendar for them first if you want to keep imported events apart from your own; you can merge them later, and nothing in your old calendar changes.";

test("navigating between articles with and without sections keeps the docs aligned", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/collections", { name: "Getting started", icon: "rocket" });
  for (const [title, content] of [
    ["Import events", [paragraph(long), heading("Before you start"), paragraph(long), heading("Import a file"), paragraph(long)]],
    ["Calendar basics", [paragraph(long)]],
  ] as const) {
    const { slug: article } = await api("/articles", { title, content: { type: "doc", content }, collection: "getting-started" });
    await api(`/articles/${article}/publish`, {});
  }

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1440, height: 900 });
  await reader.goto("/docs/import-events");
  const tree = reader.getByRole("navigation", { name: "Docs", exact: true });
  const outline = reader.getByRole("navigation", { name: "On this page" });
  const positions = async () => {
    const elements = [
      reader.locator("header").getByRole("link", { name: "Acme", exact: true }),
      tree,
      reader.getByRole("navigation", { name: "Breadcrumb" }),
      reader.getByRole("heading", { level: 1 }),
    ];
    return Promise.all(elements.map(async (element) => (await element.boundingBox())!.x));
  };
  for (const width of [1440, 1280]) {
    await reader.setViewportSize({ width, height: 900 });
    await expect(outline).toBeVisible();
    const withSections = await positions();
    await checkpoint(reader, `docs-with-sections-${width}`, { fullPage: false });
    await tree.getByRole("link", { name: "Calendar basics", exact: true }).click();
    await expect(reader.getByRole("heading", { name: "Calendar basics", level: 1 })).toBeVisible();
    await expect(outline).toBeHidden();
    await checkpoint(reader, `docs-without-sections-${width}`, { fullPage: false });
    expect(await positions()).toEqual(withSections);
    // Short articles keep the editor's measure; alignment doesn't stretch their lines.
    expect((await reader.getByRole("article").boundingBox())!.width).toBe(43 * 16);
    await tree.getByRole("link", { name: "Import events", exact: true }).click();
    await expect(outline).toBeVisible();
    expect(await positions()).toEqual(withSections);
  }
  // Below the desktop breakpoint the short article keeps its existing header and text widths.
  await reader.setViewportSize({ width: 1200, height: 900 });
  await tree.getByRole("link", { name: "Calendar basics", exact: true }).click();
  await expect(reader.getByRole("heading", { name: "Calendar basics", level: 1 })).toBeVisible();
  expect((await reader.locator("header").getByRole("link", { name: "Acme", exact: true }).boundingBox())!.x).toBe(48);
  expect((await reader.getByRole("article").boundingBox())!.width).toBe(43 * 16);

  // The overview fills the desktop container too: its first card lines up with the logo.
  await reader.setViewportSize({ width: 1440, height: 900 });
  await reader.goto("/docs");
  await expect(tree).toBeHidden();
  const collections = reader.getByRole("list", { name: "Collections", exact: true });
  const firstCard = collections.getByRole("link").first();
  await expect(firstCard).toBeVisible();
  const logo = (await reader.locator("header").getByRole("link", { name: "Acme", exact: true }).boundingBox())!;
  expect(Math.abs((await firstCard.boundingBox())!.x - logo.x)).toBeLessThanOrEqual(1);
  const container = (await reader.locator("[data-docs-layout]").boundingBox())!;
  const rightEdge = async () => {
    const box = (await collections.boundingBox())!;
    return box.x + box.width;
  };
  expect(Math.abs(await rightEdge() - (container.x + container.width))).toBeLessThanOrEqual(1);
  await checkpoint(reader, "docs-overview-1440", { fullPage: false });

  // With the team's links beside it, the overview fills the remaining space up to the same right edge.
  await api("/branding", { sidebarLinks: [{ label: "Status page", url: "https://status.example.com" }] }, "PATCH");
  await reader.reload();
  const links = reader.getByRole("list", { name: "Links", exact: true }).first();
  await expect(links).toBeVisible();
  expect(Math.abs((await links.boundingBox())!.x - logo.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((await firstCard.boundingBox())!.x - (logo.x + 18 * 16))).toBeLessThanOrEqual(1);
  expect(Math.abs(await rightEdge() - (container.x + container.width))).toBeLessThanOrEqual(1);
  await checkpoint(reader, "docs-overview-with-sidebar-links-1440", { fullPage: false });
});

test("tree-less short articles and search results keep their capped widths", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/tabs", { name: "Guides" });
  // The project's only published article is unlisted: no tree, and the first tab has no listed articles.
  const { slug: article } = await api("/articles", { title: "Calendar basics", content: { type: "doc", content: [paragraph(long)] }, listing: "unlisted" });
  await api(`/articles/${article}/publish`, {});

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1440, height: 900 });
  const tree = reader.getByRole("navigation", { name: "Docs", exact: true });
  await reader.goto(`/docs/${article}`);
  await expect(reader.getByRole("heading", { name: "Calendar basics", level: 1 })).toBeVisible();
  await expect(tree).toBeHidden();
  expect.soft((await reader.getByRole("article").boundingBox())!.width).toBe(71 * 16);
  // Capped, but from the logo's left edge like every other docs page.
  const logo = (await reader.locator("header").getByRole("link", { name: "Acme", exact: true }).boundingBox())!;
  expect(Math.abs((await reader.getByRole("article").boundingBox())!.x - logo.x)).toBeLessThanOrEqual(1);
  await checkpoint(reader, "docs-tree-less-short-article-1440", { fullPage: false });

  await reader.goto("/docs?q=calendar");
  await expect(reader.getByRole("heading", { name: "Results for “calendar”", level: 1 })).toBeVisible();
  await expect(tree).toBeHidden();
  // Search also has no current page; that doesn't make it an overview or give it the full 79rem.
  expect.soft((await reader.locator("[data-docs-layout] > div").boundingBox())!.width).toBe(71 * 16);
  expect(Math.abs((await reader.locator("[data-docs-layout] > div").boundingBox())!.x - logo.x)).toBeLessThanOrEqual(1);
  await checkpoint(reader, "docs-tree-less-search-results-1440", { fullPage: false });
});

test("a reader gets an article with room to read, turns on reading mode to read it alone, and it stays on", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/collections", { name: "Getting started", icon: "rocket" });
  const content = { type: "doc", content: [paragraph(long), heading("Before you start"), paragraph(long), heading("Import a file"), paragraph(long)] };
  const { slug: article } = await api("/articles", { title: "Import events", content, collection: "getting-started" });
  await api(`/articles/${article}/publish`, {});

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1440, height: 900 });
  await reader.goto(`/docs/${article}`);
  const page = reader.getByRole("article", { name: "Import events" });
  const tree = reader.getByRole("navigation", { name: "Docs", exact: true });
  const onThisPage = reader.getByRole("navigation", { name: "On this page" });
  await expect(tree).toBeVisible();
  await expect(onThisPage).toBeVisible();
  // With the tree and "On this page" beside it, its lines still have room: about 70 characters, not a narrow strip.
  const firstLine = page.getByText(long).first();
  expect((await firstLine.boundingBox())!.width).toBeGreaterThan(700);
  await checkpoint(reader, "portal-docs-article-wide", { fullPage: false });

  // Reading mode, from the keyboard: the tree and "On this page" go, the article stays.
  const reading = reader.getByRole("button", { name: "Reading mode" });
  await expect(reading).toHaveAttribute("aria-pressed", "false");
  // An icon, named on focus as on hover.
  await reading.focus();
  await expect(reader.getByText("Reading mode: hide the columns beside the article and read it alone")).toBeVisible();
  await reader.keyboard.press("Enter");
  await expect(reading).toHaveAttribute("aria-pressed", "true");
  await expect(tree).toBeHidden();
  await expect(onThisPage).toBeHidden();
  await expect(page.getByRole("heading", { name: "Import a file" })).toBeVisible();
  await checkpoint(reader, "portal-docs-article-reading-mode", { fullPage: false });
  // The sections stay one click away: the compact menu under the title takes the column's place.
  await page.getByText("On this page", { exact: true }).click();
  await page.getByRole("link", { name: "Import a file" }).click();
  await reader.waitForURL(/#import-a-file$/);
  await expect(page.getByRole("heading", { name: "Import a file" })).toBeInViewport();

  // Remembered in this browser: on the next article page too, from its first paint.
  await reader.reload();
  await expect(tree).toBeHidden();
  await expect(reader.getByRole("button", { name: "Reading mode" })).toHaveAttribute("aria-pressed", "true");
  // It's the article's alone: a collection's page keeps its tree.
  await reader.goto("/docs/getting-started");
  await expect(tree).toBeVisible();

  // The same button brings them back.
  await reader.goto(`/docs/${article}`);
  await reader.getByRole("button", { name: "Reading mode" }).click();
  await expect(tree).toBeVisible();
  await expect(onThisPage).toBeVisible();
  await reader.reload();
  await expect(tree).toBeVisible();

  // Below 1280px "On this page" is a compact menu under the title, so the text keeps its width.
  await reader.setViewportSize({ width: 1100, height: 800 });
  await expect(onThisPage).toBeHidden();
  const sections = page.getByText("On this page", { exact: true });
  await sections.click();
  await page.getByRole("link", { name: "Import a file" }).click();
  await reader.waitForURL(/#import-a-file$/);
  await expect(page.getByRole("heading", { name: "Import a file" })).toBeInViewport();
  // In reading mode too: the compact menu isn't beside the article, so it stays, the one way to a section.
  await reader.goto(`/docs/${article}`);
  await reader.getByRole("button", { name: "Reading mode" }).click();
  await expect(reader.getByRole("button", { name: "Reading mode" })).toHaveAttribute("aria-pressed", "true");
  await sections.click();
  await page.getByRole("link", { name: "Import a file" }).click();
  await reader.waitForURL(/#import-a-file$/);
  await expect(page.getByRole("heading", { name: "Import a file" })).toBeInViewport();
});

test("an article with sections keeps its measure with no tree beside it: the team's links alone, and in reading mode", async ({ browser }) => {
  test.setTimeout(120_000);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/branding", { sidebarLinks: [{ label: "Status page", url: "https://status.example.com" }] }, "PATCH");
  // Unlisted, all its collection has: no tree for readers.
  await api("/collections", { name: "Hidden away", icon: "rocket" });
  const content = { type: "doc", content: [paragraph(long), heading("Before you start"), paragraph(long), heading("Import a file"), paragraph(long)] };
  const { slug: article } = await api("/articles", { title: "Import events", content, collection: "hidden-away", listing: "unlisted" });
  await api(`/articles/${article}/publish`, {});

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1440, height: 900 });
  await reader.goto(`/docs/${article}`);
  const links = reader.getByRole("list", { name: "Links" }).first();
  await expect(links).toBeVisible();
  await expect(reader.getByRole("navigation", { name: "Docs", exact: true })).toBeHidden();
  await expect(reader.getByRole("navigation", { name: "On this page" })).toBeVisible();
  // Between the links and "On this page", about 70 characters a line (the 46rem column), not squeezed and not stretched.
  const firstLine = reader.getByRole("article", { name: "Import events" }).getByText(long).first();
  const width = async () => (await firstLine.boundingBox())!.width;
  expect(await width()).toBeGreaterThan(700);
  expect(await width()).toBeLessThan(760);
  // Reading mode hides what's beside it; the lines don't grow.
  await reader.getByRole("button", { name: "Reading mode" }).click();
  await expect(links).toBeHidden();
  expect(await width()).toBeGreaterThan(700);
  expect(await width()).toBeLessThan(760);
});
