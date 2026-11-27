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
