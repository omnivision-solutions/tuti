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
  // Manual for new pages: this journey is about addresses, and nothing here asks the model for translations.
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", newPages: "manual" }] }, "PATCH");
  await api("/changelog", { title: "CSV export is here" });
  await api("/changelog/1/publish", {});
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await api("/articles", { title: "Invite your team", body: "Owners send invites from Settings." });
  await api("/articles/invite-your-team/publish", {});

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto("/de/roadmap");
  await expect(reader).toHaveURL(`${portalUrl(slug)}/de/roadmap`);
  await expect(reader.locator("html")).toHaveAttribute("lang", "de");
  await expect(reader.getByRole("heading", { name: "Roadmap", level: 1 })).toBeVisible();
  await expect(reader.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute("href", `${portalUrl(slug)}/roadmap`);
  await checkpoint(reader, "german-roadmap");
  // Its links, made on the server and in the browser, keep the language; signing in comes back to the page in it.
  await expect(reader.getByRole("link", { name: "Acme" }).first()).toHaveAttribute("href", "/de");
  await expect(reader.getByRole("banner").getByRole("link", { name: "Anmelden" })).toHaveAttribute("href", `/de/sign-in?next=${encodeURIComponent("/de/roadmap")}`);
  // The portal's links keep the reader in German.
  await reader.getByRole("link", { name: "Changelog" }).first().click();
  await expect(reader).toHaveURL(`${portalUrl(slug)}/de/changelog`);
  await expect(reader.locator("html")).toHaveAttribute("lang", "de");
  // The page it's on, without the prefix, is the current part.
  await expect(reader.getByRole("link", { name: "Changelog" }).first()).toHaveAttribute("aria-current", "page");
  // Its entries' links too, and the entry's page; its text is still English, marked so under the German page.
  await expect(reader.getByRole("link", { name: "CSV export is here" })).toHaveAttribute("href", "/de/changelog/1");
  await reader.getByRole("link", { name: "CSV export is here" }).click();
  await expect(reader).toHaveURL(`${portalUrl(slug)}/de/changelog/1`);
  await expect(reader.getByRole("heading", { name: "CSV export is here", level: 1 }).locator("[lang]")).toHaveAttribute("lang", "en");
  await expect(reader.getByRole("link", { name: "Changelog" }).first()).toHaveAttribute("href", "/de/changelog");

  // The team's and people's words stay in the default language, marked so (a post's title, an article's link); the portal's own
  // text around them is the page's (a vote button, the docs' search box).
  const langOf = (locator: import("@playwright/test").Locator) => locator.evaluate((element) => element.closest("[lang]")?.getAttribute("lang"));
  await reader.goto("/de/feedback/feature-requests");
  expect(await langOf(reader.getByRole("link", { name: "Dark mode" }))).toBe("en");
  expect(await langOf(reader.getByRole("main").locator("[aria-label*=\"Abstimmen\"]").first())).toBe("de");
  // Posting signed out comes back to the board in German after signing in, and so does the account page.
  await expect(reader.locator('input[type="hidden"][name="next"]').first()).toHaveValue("/de/feedback/feature-requests");
  await reader.goto("/de/docs");
  expect(await langOf(reader.getByRole("main").getByRole("link", { name: "Invite your team" }).first().locator("span[lang], [lang]").first())).toBe("en");
  expect(await langOf(reader.locator("[data-docs-hero]").locator("[aria-label*=\"search\" i]").first())).toBe("de");
  await reader.goto("/de/account");
  await expect(reader).toHaveURL(`${portalUrl(slug)}/de/sign-in?next=${encodeURIComponent("/de/account")}`);

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
