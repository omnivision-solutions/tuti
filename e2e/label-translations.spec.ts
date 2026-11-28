import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
import { query } from "./db";
import { APP_URL } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, signUp } from "./helpers";
import { nextModelReply } from "./model";

/** Labels' translations (docs/plan.md, Languages, L13): a collection's name and description in the project's languages. */

test("a collection's settings show its name in each language: German kept up to date, French added by the team, then edited and kept up to date again; on a phone too", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  // In the description, so this journey's requests to the model are told apart from others running alongside.
  const token = randomUUID().slice(0, 8);
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/collections", { name: "Getting started", description: `The basics ${token}.` });

  // With the project's language alone, nothing to translate it into: no Translations.
  await owner.setViewportSize({ width: 1280, height: 800 });
  await owner.goto(`/app/${slug}/docs/collections/getting-started/settings`);
  await expect(owner.getByRole("textbox", { name: "Name" })).toHaveValue("Getting started");
  await expect(owner.getByRole("heading", { name: "Translations" })).toHaveCount(0);
  await expect(owner.getByRole("list", { name: "Translations" })).toHaveCount(0);

  // German kept up to date (Automatic for new pages), French written by the team.
  await nextModelReply(JSON.stringify({ segments: { "0.n": "Erste Schritte", "0.d": `Die Grundlagen ${token}.` } }), token);
  await api("/languages", { languages: [{ code: "de" }, { code: "fr", newPages: "manual" }] }, "PATCH");
  const card = owner.getByRole("list", { name: "Translations" });
  const row = (code: string) => card.getByRole("listitem").filter({ has: owner.getByText(code, { exact: true }) });
  // German, translated in the background as it was added.
  await expect(async () => {
    await owner.reload();
    await expect(row("de")).toContainText("Erste Schritte", { timeout: 1000 });
  }).toPass();
  await expect(row("de")).toContainText(`Die Grundlagen ${token}.`);
  await expect(row("de")).toContainText("Automatic");
  await expect(row("fr")).toContainText("Not translated: readers see the English name");
  await checkpoint(owner, "collection-translations", { fullPage: false });

  // French, the team's own.
  await owner.getByRole("button", { name: "Add Français" }).click();
  const dialog = owner.getByRole("dialog", { name: "In Français" });
  await expect(dialog.getByRole("switch", { name: "Keep up to date" })).not.toBeChecked();
  await dialog.getByRole("textbox", { name: "Name" }).fill("Premiers pas");
  await dialog.getByRole("textbox", { name: "Description" }).fill("Les bases.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Saved the Français name")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(row("fr")).toContainText("Premiers pas");
  await expect(row("fr")).toContainText("Edited");

  // German edited: typing turns Keep up to date off, so it's the team's now.
  await owner.getByRole("button", { name: "Edit Deutsch" }).click();
  const german = owner.getByRole("dialog", { name: "In Deutsch" });
  const keep = german.getByRole("switch", { name: "Keep up to date" });
  await expect(keep).toBeChecked();
  await german.getByRole("textbox", { name: "Name" }).fill("Los geht's");
  await expect(keep).not.toBeChecked();
  await german.getByRole("button", { name: "Save" }).click();
  await expect(german).toBeHidden();
  await expect(row("de")).toContainText("Los geht's");
  await expect(row("de")).toContainText("Edited");

  // Kept up to date again: translated anew, readers seeing the English name meanwhile.
  await nextModelReply(JSON.stringify({ segments: { "0.n": "Erste Schritte", "0.d": `Die Grundlagen ${token}.` } }), token);
  await owner.getByRole("button", { name: "Edit Deutsch" }).click();
  await keep.check();
  await german.getByRole("button", { name: "Save" }).click();
  await expect(german).toBeHidden();
  await expect(async () => {
    await owner.reload();
    await expect(row("de")).toContainText("Erste Schritte", { timeout: 1000 });
  }).toPass();
  await expect(row("de")).toContainText("Automatic");

  // Sample content is never translated: its dialog offers no Keep up to date.
  await query(`UPDATE collection c SET sample = true FROM project p WHERE p.id = c."projectId" AND p.slug = $1 AND c.slug = 'getting-started'`, [slug]);
  await owner.reload();
  await owner.getByRole("button", { name: "Edit Deutsch" }).click();
  await expect(german.getByRole("textbox", { name: "Name" })).toBeVisible();
  await expect(german.getByRole("switch", { name: "Keep up to date" })).toHaveCount(0);
  await german.getByRole("button", { name: "Cancel" }).click();
  await expect(german).toBeHidden();

  // On a phone: the rows fit, the names wrap.
  await owner.setViewportSize({ width: 390, height: 844 });
  await row("fr").scrollIntoViewIfNeeded();
  await expect(row("de").getByText("Automatic").filter({ visible: true })).toBeInViewport();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await checkpoint(owner, "collection-translations-phone", { fullPage: false });
});

test("a tab's settings show its name in each language: German kept up to date, French added by the team (a name only); on a phone too", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  // In its name, so this journey's requests to the model are told apart from others running alongside.
  const token = randomUUID().slice(0, 8);
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/languages", { languages: [{ code: "de" }, { code: "fr", newPages: "manual" }] }, "PATCH");
  await nextModelReply(JSON.stringify({ segments: { "0.n": `Anleitungen ${token}` } }), token);
  const tab = (await api("/tabs", { name: `Guides ${token}` })) as { slug: string };

  await owner.setViewportSize({ width: 1280, height: 800 });
  await owner.goto(`/app/${slug}/docs/tabs/${tab.slug}?view=settings`);
  const card = owner.getByRole("list", { name: "Translations" });
  const row = (code: string) => card.getByRole("listitem").filter({ has: owner.getByText(code, { exact: true }) });
  await expect(async () => {
    await owner.reload();
    await expect(row("de")).toContainText(`Anleitungen ${token}`, { timeout: 1000 });
  }).toPass();
  await expect(row("de")).toContainText("Automatic");
  await expect(row("fr")).toContainText("Not translated: readers see the English name");
  await checkpoint(owner, "tab-translations", { fullPage: false });

  // French, the team's own: a tab has a name only.
  await owner.getByRole("button", { name: "Add Français" }).click();
  const dialog = owner.getByRole("dialog", { name: "In Français" });
  await expect(dialog.getByRole("textbox", { name: "Description" })).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Name" }).fill("Guides pratiques");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(row("fr")).toContainText("Guides pratiques");
  await expect(row("fr")).toContainText("Edited");
  // Its toast gone, so the screenshot shows the page.
  await expect(owner.getByText("Saved the Français name")).toBeHidden({ timeout: 10_000 });

  await owner.setViewportSize({ width: 390, height: 844 });
  await row("fr").scrollIntoViewIfNeeded();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await checkpoint(owner, "tab-translations-phone", { fullPage: false });
});

test("a board's settings show its name in each language, after its details: German kept up to date, French added by the team; on a phone too", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  // Its first board, Feature requests, translated into German as the language is added (global-setup's standing reply).
  await api("/languages", { languages: [{ code: "de" }, { code: "fr", newPages: "manual" }] }, "PATCH");

  await owner.setViewportSize({ width: 1280, height: 800 });
  await owner.goto(`/app/${slug}/feedback/boards`);
  const edit = owner.getByRole("dialog", { name: "Edit board" });
  const card = edit.getByRole("list", { name: "Translations" });
  const row = (code: string) => card.getByRole("listitem").filter({ has: owner.getByText(code, { exact: true }) });
  await expect(async () => {
    await owner.reload();
    await owner.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(row("de")).toContainText("Funktionswünsche", { timeout: 1000 });
  }).toPass();
  await expect(row("de")).toContainText("Automatic");
  await expect(row("fr")).toContainText("Not translated: readers see the English name");
  await card.scrollIntoViewIfNeeded();
  await checkpoint(owner, "board-translations", { fullPage: false });

  // French, the team's own: a name and a description, saved on its own (not the board's form).
  await row("fr").getByRole("button", { name: "Add Français" }).click();
  const dialog = owner.getByRole("dialog", { name: "In Français" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Idées");
  await dialog.getByRole("textbox", { name: "Description" }).fill("Ce qu'il faut construire.");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Saved the Français name")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(row("fr")).toContainText("Idées");
  await expect(row("fr")).toContainText("Ce qu'il faut construire.");
  await expect(row("fr")).toContainText("Edited");
  await expect(owner.getByText("Board updated")).toHaveCount(0);
  await expect(edit).toBeVisible();
  await expect(owner.getByText("Saved the Français name")).toBeHidden({ timeout: 10_000 });
  // The board's own Save, after its Translations, still saves its details (its button's words: nothing to translate again).
  await edit.getByRole("textbox", { name: "Button" }).fill("Request a feature");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(owner.getByText("Board updated")).toBeVisible();
  await expect(edit).toBeHidden();
  await owner.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(edit.getByRole("textbox", { name: "Button" })).toHaveValue("Request a feature");
  await expect(owner.getByText("Board updated")).toBeHidden({ timeout: 10_000 });

  // On a phone: the rows fit.
  await owner.setViewportSize({ width: 390, height: 844 });
  await row("fr").scrollIntoViewIfNeeded();
  await expect(row("de").getByText("Automatic").filter({ visible: true })).toBeInViewport();
  expect(await edit.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await checkpoint(owner, "board-translations-phone", { fullPage: false });

  // Only the team's: readers don't see it, so nothing translates it (no Keep up to date, as on a sample collection).
  await query(`UPDATE board b SET "postVisibility" = 'TEAM', translations = '{}' FROM project p WHERE p.id = b."projectId" AND p.slug = $1`, [slug]);
  await owner.reload();
  await owner.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(row("de")).toContainText("Not translated: readers see the English name");
  await row("de").getByRole("button", { name: "Add Deutsch" }).click();
  const german = owner.getByRole("dialog", { name: "In Deutsch" });
  await expect(german.getByRole("textbox", { name: "Name" })).toBeVisible();
  await expect(german.getByRole("switch", { name: "Keep up to date" })).toHaveCount(0);
  await german.getByRole("button", { name: "Cancel" }).click();
  await expect(german).toBeHidden();
});
