import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { query } from "./db";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

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
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
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
