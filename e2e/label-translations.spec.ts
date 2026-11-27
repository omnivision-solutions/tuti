import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
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
