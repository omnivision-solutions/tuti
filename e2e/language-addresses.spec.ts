import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

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

  // French is offline: its addresses are the default language's pages, in English.
  await reader.goto("/fr/changelog");
  await expect(reader).toHaveURL(`${portalUrl(slug)}/changelog`);
  await expect(reader.locator("html")).toHaveAttribute("lang", "en");
  await checkpoint(reader, "french-offline-redirected");
});
