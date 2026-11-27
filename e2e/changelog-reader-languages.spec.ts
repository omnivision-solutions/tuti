import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

/**
 * The changelog in the reader's language (docs/plan.md L17): an entry translated into German reads in German at its German
 * address, in its list too; in French, which it isn't translated into, the English with a line in French saying so.
 * German and French are Manual (nothing asks the model); the German version is the team's, written through the API.
 */
test("a reader reads a changelog entry in German at its German address, and in French sees the English with a line saying so", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] }, "PATCH");
  const { number } = (await api("/changelog", { title: "Dark mode", body: "Switch themes from your profile menu." })) as unknown as { number: number };
  await api(`/changelog/${number}/publish`, {});
  const { version } = (await api(`/changelog/${number}/languages/de`, undefined, "GET")) as unknown as { version: string };
  const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Wechsle das Design im Profilmenü." }] }] };
  await api(`/changelog/${number}/languages/de`, { title: "Dunkler Modus", content, version }, "PATCH");

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto(`/de/changelog/${number}`);
  const title = reader.getByRole("heading", { name: "Dunkler Modus", level: 1 });
  await expect(title).toBeVisible();
  await expect(title.locator("span[lang]")).toHaveAttribute("lang", "de");
  await expect(reader.getByText("Wechsle das Design im Profilmenü.")).toBeVisible();
  await expect(reader.locator('link[rel="canonical"]')).toHaveAttribute("href", `${portalUrl(slug)}/de/changelog/${number}`);
  await expect(reader.locator('link[rel="alternate"][hreflang="fr"]')).toHaveCount(0);
  await checkpoint(reader, "changelog-entry-in-german");
  // The list too.
  await reader.goto("/de/changelog");
  await expect(reader.getByRole("link", { name: "Dunkler Modus" })).toBeVisible();

  // French: the English, with a line in French saying so; its canonical the English address.
  await reader.goto(`/fr/changelog/${number}`);
  await expect(reader.getByRole("heading", { name: "Dark mode", level: 1 })).toBeVisible();
  const line = reader.getByText("Cette page n'est pas encore disponible en français");
  await expect(line).toBeVisible();
  await expect(line).toHaveAttribute("lang", "fr");
  await expect(reader.locator('link[rel="canonical"]')).toHaveAttribute("href", `${portalUrl(slug)}/changelog/${number}`);
  await checkpoint(reader, "changelog-entry-not-in-french");

  // Phones too: the line above the entry.
  await reader.setViewportSize({ width: 390, height: 844 });
  await expect(line).toBeVisible();
  await checkpoint(reader, "changelog-entry-not-in-french-phone", { fullPage: false });
  await reader.goto(`/de/changelog/${number}`);
  await expect(reader.getByRole("heading", { name: "Dunkler Modus", level: 1 })).toBeVisible();
  await checkpoint(reader, "changelog-entry-in-german-phone", { fullPage: false });
});
