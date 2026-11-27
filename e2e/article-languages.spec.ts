import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { query } from "./db";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";
import { nextModelReply } from "./model";

/**
 * An article in the reader's language (docs/plan.md, Languages, L8): its German version at its German address, and in
 * French, which it isn't translated into, the English with a line saying so. German and French are Manual for new pages
 * (nothing asks the model here); the German version is the team's, written straight to the database.
 */
test("a reader reads an article in German at its German address, and in French sees the English with a line saying so", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] }, "PATCH");
  await api("/articles", { title: "Billing", body: "Pay by card." });
  await api("/articles/billing/publish", {});
  const [{ id, projectId }] = await query(`SELECT a.id, a."projectId" FROM article a JOIN project p ON p.id = a."projectId" WHERE p.slug = $1 AND a.slug = 'billing'`, [slug]);
  const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Mit Karte zahlen." }] }] };
  await query(
    `INSERT INTO article_translation (id, "articleId", "projectId", language, automatic, title, slug, content, body, "publishedAt", "updatedAt")
     VALUES ($1, $2, $3, 'de', false, 'Abrechnung', 'abrechnung', $4, 'Mit Karte zahlen.', now(), now())`,
    [randomUUID(), id, projectId, JSON.stringify(content)],
  );

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto("/de/docs/abrechnung");
  const title = reader.getByRole("heading", { name: "Abrechnung", level: 1 });
  await expect(title).toBeVisible();
  await expect(title).toHaveAttribute("lang", "de");
  await expect(reader.getByText("Mit Karte zahlen.")).toBeVisible();
  // Search engines get each language it's in at its own address, and no other.
  await expect(reader.locator('link[rel="canonical"]')).toHaveAttribute("href", `${portalUrl(slug)}/de/docs/abrechnung`);
  await expect(reader.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute("href", `${portalUrl(slug)}/docs/billing`);
  await expect(reader.locator('link[rel="alternate"][hreflang="fr"]')).toHaveCount(0);
  await checkpoint(reader, "article-in-german");

  // Its English slug at the German address goes to its German one; in English, its English one.
  await reader.goto("/de/docs/billing");
  await expect(reader).toHaveURL(`${portalUrl(slug)}/de/docs/abrechnung`);

  // French: the English, its `lang` English, with a line in French saying so; canonical to the English.
  await reader.goto("/fr/docs/billing");
  await expect(reader.getByRole("heading", { name: "Billing", level: 1 })).toHaveAttribute("lang", "en");
  const line = reader.getByText("Cette page n'est pas encore disponible en français");
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute("lang", "fr");
  await expect(reader.locator('link[rel="canonical"]')).toHaveAttribute("href", `${portalUrl(slug)}/docs/billing`);
  await checkpoint(reader, "article-not-in-french");

  // Phones too: the line wraps above the title.
  await reader.setViewportSize({ width: 390, height: 844 });
  await expect(line).toBeVisible();
  await checkpoint(reader, "article-not-in-french-phone");
});

/** The team writes an article's German in its editor (docs/plan.md L11): the language pill, a draft, then published. */
test("the team writes a published article's German from its editor's language pill: a draft, then published", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // German written by the team (Manual): nothing goes to the model.
  await api("/languages", { languages: [{ code: "de", newPages: "manual" }] }, "PATCH");
  const { slug: article } = await api("/articles", { title: "Getting paid", body: "Payouts go out every Monday." });
  await api(`/articles/${article}/publish`, {});

  await team.setViewportSize({ width: 1280, height: 800 });
  await team.goto(`${APP_URL}/app/${slug}/docs/${article}`);
  // The pill: English, and Deutsch not written yet.
  await team.getByRole("button", { name: "Language: English" }).click();
  await expect(team.getByRole("menuitem", { name: /Deutsch/ })).toContainText("Not written");
  await team.getByRole("menuitem", { name: /Deutsch/ }).click();
  await expect(team).toHaveURL(/\?language=de$/);
  await expect(team.getByText("Not written yet: it starts as the English text.")).toBeVisible();
  // It starts as the English text, to write over.
  const title = team.getByRole("textbox", { name: "Title" });
  await expect(title).toHaveValue("Getting paid");
  await title.fill("Bezahlt werden");
  await team.getByRole("textbox", { name: "Text" }).fill("Auszahlungen gehen jeden Montag raus.");
  await checkpoint(team, "team-article-version");
  await team.getByRole("button", { name: "Save draft" }).click();
  await expect(team.getByText("Not published yet: readers get the English text until you publish it.")).toBeVisible();
  await expect(team.getByRole("switch", { name: /Keep up to date/ })).not.toBeChecked();

  await team.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByRole("region", { name: /Notifications/ }).getByText("Published", { exact: true })).toBeVisible();
  await team.getByRole("button", { name: "Language: Deutsch" }).click();
  await expect(team.getByRole("menuitem", { name: /Deutsch/ })).toContainText("Written by your team");
  await team.keyboard.press("Escape");

  // On a phone: the pill under the top bar, Save draft and Publish in it.
  await team.setViewportSize({ width: 390, height: 844 });
  await team.reload();
  await expect(team.getByRole("button", { name: "Language: Deutsch" })).toBeVisible();
  await expect(title).toHaveValue("Bezahlt werden");
  await checkpoint(team, "team-article-version-phone", { fullPage: false });
  // Back to English: its own editor.
  await team.getByRole("button", { name: "Language: Deutsch" }).click();
  await team.getByRole("menuitem", { name: /English/ }).click();
  await expect(team).not.toHaveURL(/language=/);
  await expect(team.getByRole("textbox", { name: "Title" })).toHaveValue("Getting paid");
});

/** A text of paragraphs and sections ([heading, text]). */
const textOf = (intro: string, ...parts: [string, string][]) => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: intro }] },
    ...parts.flatMap(([heading, text]) => [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
      { type: "paragraph", content: [{ type: "text", text }] },
    ]),
  ],
});

/** Sections behind English (docs/plan.md L11): the orange line, Show changes, Publish asking keep or take, Update those sections. */
test("English changes a section of the team's German: the orange line shows what changed, Publish asks to keep the edit, and Update those sections translates it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", newPages: "manual" }] }, "PATCH");
  const { slug: article } = await api("/articles", { title: "Getting paid", content: textOf("Payouts go out every Monday.", ["Fees", "There are no fees."]) });
  await api(`/articles/${article}/publish`, {});
  // The team's German, written and published.
  const blank = (await api(`/articles/${article}/languages/de`, undefined, "GET")) as unknown as { version: string };
  await api(`/articles/${article}/languages/de/draft`, { title: "Bezahlt werden", content: textOf("Auszahlungen gehen jeden Montag raus.", ["Gebühren", "Es gibt keine Gebühren."]), version: blank.version }, "PATCH");
  await api(`/articles/${article}/languages/de/publish`, {});
  // English changes its Fees.
  await api(`/articles/${article}`, { content: textOf("Payouts go out every Monday.", ["Fees", "Fees are free for a year."]), publish: true }, "PATCH");

  await team.setViewportSize({ width: 1280, height: 800 });
  await team.goto(`${APP_URL}/app/${slug}/docs/${article}?language=de`);
  await expect(team.getByText("English changed in 1 section since this was edited.")).toBeVisible();
  // Show changes: Fees' English then and now.
  await team.getByRole("button", { name: "Show changes" }).click();
  const changes = team.getByRole("dialog", { name: "What changed in English" });
  await expect(changes.getByText("Fees", { exact: true })).toBeVisible();
  await expect(changes.getByText("Fees are free for a year.")).toBeVisible();
  await checkpoint(team, "team-article-version-changes");
  await team.keyboard.press("Escape");

  // A draft, then Publish: it asks about Fees; unticked, the team's edit is kept (and stays behind).
  await team.getByRole("textbox", { name: "Title" }).fill("Bezahlt werden, jede Woche");
  await team.getByRole("button", { name: "Save draft" }).click();
  await expect(team.getByRole("region", { name: /Notifications/ }).getByText("Saved", { exact: true })).toBeVisible();
  await team.getByRole("button", { name: "Publish", exact: true }).click();
  const asking = team.getByRole("alertdialog", { name: "English changed in 1 section" });
  const fees = asking.getByRole("checkbox", { name: "Fees" });
  await expect(fees).toBeChecked();
  await checkpoint(team, "team-article-version-publish-asks");
  await fees.uncheck();
  await asking.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByRole("region", { name: /Notifications/ }).getByText("Published", { exact: true })).toBeVisible();
  await expect(team.getByText("English changed in 1 section since this was edited.")).toBeVisible();
  await expect(team.getByRole("textbox", { name: "Text" })).toContainText("Es gibt keine Gebühren.");

  // On a phone: the line and its actions wrap under it.
  await team.setViewportSize({ width: 390, height: 844 });
  await checkpoint(team, "team-article-version-behind-phone", { fullPage: false });

  // Update those sections: Fees translated again.
  // Only that section is asked for: its heading and its paragraph.
  await nextModelReply(JSON.stringify({ segments: { 1: "Gebühren", 2: "Gebühren sind ein Jahr lang kostenlos." } }), "Fees are free for a year.");
  await team.getByRole("button", { name: "Update those sections" }).click();
  await team.getByRole("alertdialog", { name: "Translate those sections again?" }).getByRole("button", { name: "Translate again" }).click();
  await expect(team.getByRole("region", { name: /Notifications/ }).getByText("Sections sent for translation")).toBeVisible();
  // Translated in the background: there once the page is read again.
  await expect(async () => {
    await team.reload();
    await expect(team.getByRole("textbox", { name: "Text" })).toContainText("Gebühren sind ein Jahr lang kostenlos.", { timeout: 1000 });
  }).toPass();
  await expect(team.getByText("English changed in 1 section since this was edited.")).toBeHidden();
});
