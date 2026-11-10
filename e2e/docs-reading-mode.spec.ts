import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

const text = (value: string) => ({ type: "text", text: value });
const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });
const heading = (value: string) => ({ type: "heading", attrs: { level: 2 }, content: [text(value)] });
const long = "Imports go into one calendar. Make a calendar for them first if you want to keep imported events apart from your own; you can merge them later, and nothing in your old calendar changes.";

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
  await expect(reader.getByText("Reading mode: hide the docs menu and read the article alone")).toBeVisible();
  await reader.keyboard.press("Enter");
  await expect(reading).toHaveAttribute("aria-pressed", "true");
  await expect(tree).toBeHidden();
  await expect(onThisPage).toBeHidden();
  await expect(page.getByRole("heading", { name: "Import a file" })).toBeVisible();
  await checkpoint(reader, "portal-docs-article-reading-mode", { fullPage: false });

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
});
