import { randomUUID } from "node:crypto";

import type { Locator } from "@playwright/test";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { query } from "./db";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

test("a reader chooses German in the portal's header and its text follows, on desktop and on phones", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto("/");
  // One language: no switcher.
  await expect(reader.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(reader.getByRole("button", { name: /^Language/ })).toHaveCount(0);

  // German live, French offline: only the live ones are offered.
  await api("/languages", { languages: [{ code: "de", live: true }, { code: "fr" }] }, "PATCH");
  await reader.reload();
  const switcher = reader.getByRole("button", { name: "Language: English" });
  await switcher.click();
  const menu = reader.getByRole("menu");
  await expect(menu.getByRole("menuitemradio")).toHaveText(["English", "Deutsch"]);
  await expect(menu.getByRole("menuitemradio", { name: "English" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: "Deutsch" })).toHaveAttribute("lang", "de");
  await checkpoint(reader, "switcher-open", { fullPage: false });
  await menu.getByRole("menuitemradio", { name: "Deutsch" }).click();

  await expect(reader.getByRole("link", { name: "Anmelden" })).toBeVisible();
  // Its name in the page's language, and focus kept on it (it's never taken out of the tab order while saving).
  const german = reader.getByRole("button", { name: "Sprache: Deutsch" });
  await expect(german).toHaveAttribute("lang", "de");
  await expect(german).toBeFocused();
  await expect(reader.getByRole("link", { name: "Anmelden" }).locator("[lang=de]")).toHaveText("Anmelden");
  // The header's parts and the footer follow it too, each in its language.
  const parts = reader.getByRole("navigation", { name: "Portal" });
  await expect(parts).toHaveAttribute("lang", "de");
  await expect(parts.getByRole("link", { name: "Dokumentation" })).toBeVisible();
  const footer = reader.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: /^Bereitgestellt von/ })).toHaveAttribute("lang", "de");
  const theme = footer.getByRole("radiogroup", { name: "Darstellung" });
  await expect(theme).toHaveAttribute("lang", "de");
  await expect(theme.getByRole("radio")).toHaveCount(3);
  await expect(theme.getByRole("radio", { name: "Dunkel" })).toBeAttached();
  await checkpoint(reader, "header-in-german", { fullPage: false });
  await checkpoint(reader, "footer-in-german");
  // Kept: another page, and the next visit.
  await reader.goto("/changelog");
  await expect(reader.getByRole("link", { name: "Anmelden" })).toBeVisible();

  // On phones it's in the menu.
  await reader.setViewportSize({ width: 390, height: 844 });
  await expect(reader.getByRole("button", { name: "Sprache: Deutsch" })).toBeHidden();
  const menuButton = reader.getByRole("button", { name: "Menü" });
  await expect(menuButton).toHaveAttribute("lang", "de");
  await menuButton.click();
  const dialog = reader.getByRole("dialog", { name: "Menü" });
  await expect(dialog.getByRole("button", { name: "Menü schließen" })).toHaveAttribute("lang", "de");
  const languages = dialog.getByRole("group", { name: "Sprache" });
  await expect(languages).toHaveAttribute("lang", "de");
  await expect(languages.getByRole("button", { name: "Deutsch" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Dokumentation" })).toBeVisible();
  await checkpoint(reader, "phone-menu-in-german", { fullPage: false });
  // The menu stays open, now in English.
  const english = reader.getByRole("dialog").getByRole("button", { name: "English", exact: true });
  await english.click();
  await expect(reader.getByRole("button", { name: "Close the menu" })).toHaveAttribute("lang", "en");
  await expect(english).toHaveAttribute("aria-pressed", "true");
  await expect(english).toBeFocused();
  await reader.getByRole("button", { name: "Close the menu" }).click();
  await expect(reader.getByRole("link", { name: "Sign in" })).toBeVisible();

  // Taken offline: back to the default.
  await reader.setViewportSize({ width: 1280, height: 800 });
  await api("/languages", { languages: [{ code: "de", live: false }, { code: "fr" }] }, "PATCH");
  await reader.reload();
  await expect(reader.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(reader.getByRole("button", { name: /^Language/ })).toHaveCount(0);
});

test("on a private portal's sign-in page, a phone can still choose the language from the menu", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true }] }, "PATCH");
  await query(`UPDATE project SET "portalAccess" = 'PRIVATE' WHERE slug = $1`, [slug]);

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.goto("/sign-in");
  // Nothing of the portal's in the menu: only the languages.
  await reader.getByRole("button", { name: "Menu" }).click();
  await reader.getByRole("dialog").getByRole("group", { name: "Language" }).getByRole("button", { name: "Deutsch" }).click();
  await expect(reader.getByRole("dialog").getByRole("group", { name: "Sprache" })).toBeVisible();
  await expect(reader.getByRole("dialog").getByRole("navigation", { name: "Portal" })).toHaveCount(0);
});

test("a signed-in reader's account menu, the changelog's New and the phone menu's boards follow their language", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true }] }, "PATCH");
  // A second board, so the phone menu lists the boards.
  await query(
    `INSERT INTO board (id, "projectId", slug, name, "updatedAt") SELECT $2, id, 'bugs', 'Bugs', now() FROM project WHERE slug = $1`,
    [slug, randomUUID()],
  );

  const reader = await signUp(browser, portalUrl(slug), "Rita Reader");
  // An announcement she hasn't seen.
  await api("/changelog", { title: "CSV export is here" });
  await api("/changelog/1/publish", {});
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto("/");
  await reader.getByRole("button", { name: "Language: English" }).click();
  await reader.getByRole("menuitemradio", { name: "Deutsch" }).click();
  const account = reader.getByRole("button", { name: "Konto" });
  await expect(account).toHaveAttribute("lang", "de");
  await expect(reader.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: /^Changelog/ })).toContainText("Neu");
  // On a phone, the menu on Feedback: its description, and its boards named in German, each board's name in the project's language.
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.goto("/feedback");
  await reader.getByRole("banner").getByRole("button", { name: "Menü" }).click();
  const menu = reader.getByRole("dialog", { name: "Menü" });
  await expect(menu).toHaveAccessibleDescription("Acme: Wohin als Nächstes?");
  const boards = menu.getByRole("navigation", { name: "Boards" });
  await expect(boards).toHaveAttribute("lang", "de");
  await expect(boards.getByRole("link", { name: "Bugs" })).toHaveAttribute("lang", "en");
  await expect(menu.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: /^Changelog/ })).toContainText("Neu");
  await reader.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await reader.setViewportSize({ width: 1280, height: 800 });
  await account.click();
  await expect(reader.getByRole("menuitem", { name: "Kontoeinstellungen" })).toHaveAttribute("lang", "de");
  // Signing out fails (never sent): the toast says so in German, in its language.
  await reader.route("**/sign-out", (route) => route.abort());
  await reader.getByRole("menuitem", { name: "Abmelden" }).click();
  const failed = reader.locator("[data-sonner-toast] [lang=de]", { hasText: "Abmelden fehlgeschlagen. Bitte erneut versuchen." });
  await expect(failed).toBeVisible();
});

test("the landmarks of the team's links are named in the reader's language, and the links keep the project's", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "fr", live: true }] }, "PATCH");
  await api(
    "/branding",
    { headerLinks: [{ label: "Pricing", url: "https://example.com/pricing" }], footerLinks: [{ label: "Privacy", url: "https://example.com/privacy" }] },
    "PATCH",
  );

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto("/");
  await reader.getByRole("button", { name: "Language: English" }).click();
  await reader.getByRole("menuitemradio", { name: "Français" }).click();
  /** The landmark is in French (its name with it), the team's links in the project's language. */
  const namedInFrench = async (nav: Locator) => {
    await expect(nav).toHaveAttribute("lang", "fr");
    await expect(nav.getByRole("link").first()).toHaveAttribute("lang", "en");
  };
  const links = reader.getByRole("banner").getByRole("navigation", { name: "Liens" });
  await expect(links.getByRole("link", { name: "Pricing" })).toBeVisible();
  await namedInFrench(links);
  const footer = reader.getByRole("contentinfo").getByRole("navigation", { name: "Pied de page" });
  await expect(footer.getByRole("link", { name: "Privacy" })).toBeVisible();
  await namedInFrench(footer);

  // On phones, in the menu.
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.getByRole("button", { name: "Menu" }).click();
  const menuLinks = reader.getByRole("dialog").getByRole("navigation", { name: "Liens" });
  await expect(menuLinks.getByRole("link", { name: "Pricing" })).toBeVisible();
  await namedInFrench(menuLinks);

  // Without JavaScript, the row the links get on phones instead of the menu (the same browser's language).
  const noScript = await browser.newContext({ javaScriptEnabled: false, baseURL: portalUrl(slug), viewport: { width: 390, height: 844 } });
  await noScript.addCookies(await reader.context().cookies());
  const plain = await noScript.newPage();
  await plain.goto("/");
  const row = plain.getByRole("navigation", { name: "Liens" });
  await expect(row.getByRole("link", { name: "Pricing" })).toBeVisible();
  await expect(row).toHaveAttribute("lang", "fr");
  await expect(row.getByRole("link", { name: "Pricing" })).toHaveAttribute("lang", "en");
});
