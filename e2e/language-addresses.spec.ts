import { createHmac, randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { query } from "./db";
import { APP_URL, portalUrl, serverEnv } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

/** Customize's preview token for the project's owner (lib/preview-session.ts), signed as the server signs it. */
async function previewToken(slug: string) {
  const [{ projectId, userId }] = await query(`SELECT p.id AS "projectId", m."userId" FROM project p JOIN team_member m ON m."projectId" = p.id WHERE p.slug = $1`, [slug]);
  const payload = [projectId, userId, "e2e", String(Math.floor(Date.now() / 1000) + 3600)].join(".");
  return `${payload}.${createHmac("sha256", `tuti:preview:${serverEnv.BETTER_AUTH_SECRET}`).update(payload).digest("base64url")}`;
}

test("a reader opens the portal's German addresses while German is live; an offline language's go to the default language's page", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true }, { code: "fr" }] }, "PATCH");

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto("/de/roadmap");
  await expect(reader).toHaveURL(`${portalUrl(slug)}/de/roadmap`);
  await expect(reader.locator("html")).toHaveAttribute("lang", "de");
  await expect(reader.getByRole("heading", { name: "Roadmap", level: 1 })).toBeVisible();
  await expect(reader.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute("href", `${portalUrl(slug)}/roadmap`);
  await checkpoint(reader, "german-roadmap");
  // The portal's links keep the reader in German.
  await reader.getByRole("link", { name: "Changelog" }).first().click();
  await expect(reader).toHaveURL(`${portalUrl(slug)}/de/changelog`);
  await expect(reader.locator("html")).toHaveAttribute("lang", "de");
  // The page it's on, without the prefix, is the current part.
  await expect(reader.getByRole("link", { name: "Changelog" }).first()).toHaveAttribute("aria-current", "page");

  // French is offline: its addresses are the default language's pages, in English.
  await reader.goto("/fr/changelog");
  await expect(reader).toHaveURL(`${portalUrl(slug)}/changelog`);
  await expect(reader.locator("html")).toHaveAttribute("lang", "en");
  await checkpoint(reader, "french-offline-redirected");

  // The team's preview of French (Customize's preview token): its pages, marked and kept from search engines.
  const preview = await newPerson(browser, portalUrl(slug));
  await preview.goto(`/fr/changelog?preview-token=${await previewToken(slug)}`);
  await expect(preview).toHaveURL(`${portalUrl(slug)}/fr/changelog`);
  await expect(preview.locator("html")).toHaveAttribute("lang", "fr");
  await expect(preview.getByRole("status").filter({ hasText: "Not live yet." })).toHaveText("Not live yet. Only your team sees the portal in French until it goes live.");
  await expect(preview.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  await checkpoint(preview, "french-preview");
});
