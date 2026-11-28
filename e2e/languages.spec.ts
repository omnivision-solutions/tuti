import { randomUUID } from "node:crypto";

import { startApiFake } from "@tuti/testkit";

import type { Locator } from "@playwright/test";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { query } from "./db";
import { apiFor, createProject, newPerson, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";
import { nextModelReply } from "./model";
import { similar } from "./openai";

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
  // Its name in the page's language.
  const german = reader.getByRole("button", { name: "Sprache: Deutsch" });
  await expect(german).toHaveAttribute("lang", "de");
  await expect(reader.getByRole("link", { name: "Anmelden" }).locator("[lang=de]")).toHaveText("Anmelden");
  // The same page at its German address (L3).
  await expect(reader).toHaveURL(new RegExp(`^${portalUrl(slug)}/de(/|$)`));
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
  // Kept: the portal's links stay in German.
  await reader.getByRole("link", { name: "Changelog" }).first().click();
  await expect(reader).toHaveURL(`${portalUrl(slug)}/de/changelog`);
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
  // English: the same page at its English address.
  await reader.getByRole("dialog").getByRole("button", { name: "English", exact: true }).click();
  await expect(reader).toHaveURL(`${portalUrl(slug)}/changelog`);
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
  await expect(reader).toHaveURL(`${portalUrl(slug)}/de/sign-in`);
  await reader.getByRole("button", { name: "Menü" }).click();
  await expect(reader.getByRole("dialog").getByRole("group", { name: "Sprache" })).toBeVisible();
  await expect(reader.getByRole("dialog").getByRole("navigation", { name: "Portal" })).toHaveCount(0);
});

test("a signed-in reader's account menu, the changelog's New and the phone menu's boards follow their language", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // Manual for new pages: the changelog entry published below would otherwise be translated (asking the model).
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }] }, "PATCH");
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
  // The page's language is its address's (L3): Feedback in German is /de/feedback.
  await reader.goto("/de/feedback");
  // Its description for search engines and shared links, in German too.
  const description = reader.locator('meta[name="description"]');
  await expect(description).toHaveAttribute("content", "Stimme für die Ideen ab, die dir am wichtigsten sind, oder teile deine eigenen.");
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

  // Without JavaScript, the row the links get on phones instead of the menu (the page in French: its address, L3).
  const noScript = await browser.newContext({ javaScriptEnabled: false, baseURL: portalUrl(slug), viewport: { width: 390, height: 844 } });
  await noScript.addCookies(await reader.context().cookies());
  const plain = await noScript.newPage();
  await plain.goto("/fr");
  const row = plain.getByRole("navigation", { name: "Liens" });
  await expect(row.getByRole("link", { name: "Pricing" })).toBeVisible();
  await expect(row).toHaveAttribute("lang", "fr");
  await expect(row.getByRole("link", { name: "Pricing" })).toHaveAttribute("lang", "en");
});

test("Feedback, a board and a post in German: their words, counts and times, and a comment posted in it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true }] }, "PATCH");
  // Its author's vote counts: 1. Planned, so the post's history has a status change.
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await api("/posts/1", { status: "planned" }, "PATCH");
  // One shipped: the board's Recently shipped.
  await api("/posts", { board: "feature-requests", title: "CSV export" });
  await api("/posts/2", { status: "completed" }, "PATCH");
  // A second board, so Feedback is the boards' overview.
  await query(
    `INSERT INTO board (id, "projectId", slug, name, "updatedAt") SELECT $2, id, 'bugs', 'Bugs', now() FROM project WHERE slug = $1`,
    [slug, randomUUID()],
  );
  // The boards' names in German (docs/plan.md L14): Bugs' the team's own; Feature requests' made by AI from its name as it is
  // (current only for that name and its description, so every place showing it must read both). The same words the labels
  // job's standing reply writes (e2e/global-setup.ts), so its run alongside leaves what's shown as it is.
  await query(
    `UPDATE board b SET translations = CASE b.slug
       WHEN 'bugs' THEN jsonb_build_object('de', jsonb_build_object('name', 'Fehler', 'description', '', 'auto', false, 'source', NULL))
       ELSE jsonb_build_object('de', jsonb_build_object('name', 'Funktionswünsche', 'description', '', 'auto', true, 'source', md5(b.name || chr(31) || coalesce(b.description, ''))))
     END
     FROM project p WHERE p.id = b."projectId" AND p.slug = $1`,
    [slug],
  );

  const reader = await signUp(browser, portalUrl(slug), "Rita Reader");
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto("/de/feedback");
  await expect(reader.locator("html")).toHaveAttribute("lang", "de");

  // The overview: the boards' pills and cards, how many ideas are still to come, and a board with none.
  await expect(reader.getByRole("navigation", { name: "Boards" }).getByRole("link", { name: "Alle Boards 1" })).toBeVisible();
  await expect(reader.getByText("1 Idee steht noch aus")).toBeVisible();
  await expect(reader.getByText("Noch keine Ideen. Teile die erste.")).toBeVisible();
  await expect(reader.getByRole("link", { name: "Board öffnen" })).toHaveCount(2);
  // The boards' names in German, marked as German: their cards and pills.
  for (const name of ["Funktionswünsche", "Fehler"]) {
    await expect(reader.getByRole("heading", { level: 2, name })).toHaveAttribute("lang", "de");
    await expect(reader.getByRole("navigation", { name: "Boards" }).getByRole("link", { name: new RegExp(`^${name}`) }).locator("[lang=de]")).toHaveText(name);
  }
  await checkpoint(reader, "overview-in-german", { fullPage: false });
  // The English page sends the browser no other language's names (the menu gets only what it shows).
  expect(await (await reader.request.get("/feedback")).text()).not.toContain("Funktionswünsche");
  // New post's menu: each board's name in German too.
  await reader.getByRole("button", { name: "Neuer Beitrag" }).click();
  await expect(reader.getByRole("menuitem").getByText("Fehler", { exact: true })).toHaveAttribute("lang", "de");
  await reader.keyboard.press("Escape");
  // Get updates, in its popover.
  await reader.getByRole("button", { name: "Updates erhalten" }).click();
  await expect(reader.getByRole("dialog", { name: "Updates erhalten" }).getByRole("link", { name: "Changelog lesen" })).toBeVisible();
  await reader.keyboard.press("Escape");
  await reader.getByRole("link", { name: "Board öffnen" }).first().click();
  await expect(reader).toHaveURL(/\/de\/feedback\/feature-requests$/);
  // Recently shipped, in German; the idea's title in the project's language.
  const shipped = reader.getByRole("region", { name: "Kürzlich veröffentlicht" });
  await expect(shipped).toContainText(/^Veröffentlicht am \d+\. \S+:/);
  await expect(shipped.getByRole("link", { name: "CSV export" })).toHaveAttribute("lang", "en");

  // The board: its name in German, its description, sorts, status filter, search and the idea's vote, in German.
  await expect(reader.getByRole("heading", { level: 1, name: "Funktionswünsche" }).locator("[lang=de]")).toHaveText("Funktionswünsche");
  await expect(reader.getByText("Stimme für die Ideen ab, die dir am wichtigsten sind, oder teile deine eigenen.")).toBeVisible();
  await expect(reader.getByRole("navigation", { name: "Sortieren" }).getByRole("link")).toHaveText(["Im Trend", "Top", "Neu", "Meine"]);
  await expect(reader.getByRole("button", { name: "Status: Noch nicht erledigt, 1 Idee" })).toBeVisible();
  await expect(reader.getByRole("searchbox", { name: "Ideen durchsuchen" })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Abstimmen (1 Stimme)" })).toBeVisible();
  // The idea's title is the team's words, in the project's language.
  await expect(reader.getByRole("link", { name: "Dark mode" })).toHaveAttribute("lang", "en");
  await checkpoint(reader, "board-in-german", { fullPage: false });
  // The sidebar's boards: each named in German, then how many ideas are open (in browse mode too, not only on focus).
  const sideBoards = reader.getByRole("complementary").getByRole("navigation", { name: "Boards" }).getByRole("link");
  await expect(sideBoards.first()).toHaveAccessibleName(/^Funktionswünsche ?, 1 offene Idee$/);
  await expect(sideBoards.first().locator("[lang=de]")).toHaveText("Funktionswünsche");
  await reader.getByRole("button", { name: "Neuer Beitrag" }).click();
  await expect(reader.getByRole("dialog", { name: "Idee teilen" })).toBeVisible();
  await expect(reader.getByRole("textbox", { name: "Titel" })).toHaveAttribute("placeholder", "Kurzer, aussagekräftiger Titel");
  // A similar idea while typing: its board's name in German, marked as German.
  await reader.getByRole("textbox", { name: "Titel" }).fill("Dark mode");
  await expect(reader.getByRole("dialog", { name: "Idee teilen" }).getByRole("listitem").filter({ hasText: "Dark mode" }).getByText("Funktionswünsche", { exact: true })).toHaveAttribute("lang", "de");
  await reader.getByRole("textbox", { name: "Titel" }).fill("");
  // The editor's own words: a new line's hint, the / menu (filtered by its German names) and the bar over selected text.
  const details = reader.getByRole("dialog", { name: "Idee teilen" }).getByRole("textbox", { name: "Details" });
  await details.click();
  await details.pressSequentially("Erste Zeile");
  await reader.keyboard.press("Enter");
  await expect(details.locator("p.is-empty")).toHaveAttribute("data-placeholder", "Tippe / für Listen, Bilder und mehr");
  await details.pressSequentially("/");
  const blocks = reader.getByRole("listbox", { name: "Blöcke" });
  await expect(blocks.getByRole("option")).toHaveText(["Aufzählung", "Nummerierte Liste", "Codeblock", "Bild", "Video"]);
  await details.pressSequentially("num");
  await expect(blocks.getByRole("option")).toHaveText(["Nummerierte Liste"]);
  await checkpoint(reader, "post-editor-menu-in-german", { fullPage: false });
  for (let i = 0; i < 4; i++) await reader.keyboard.press("Backspace");
  await expect(blocks).toBeHidden();
  await reader.keyboard.press("ArrowUp");
  await reader.keyboard.press("Home");
  await reader.keyboard.press("Shift+End");
  await expect(reader.getByRole("toolbar", { name: "Formatierung" }).getByRole("button", { name: "Fett" })).toBeVisible();
  await reader.keyboard.press("Escape");
  await expect(reader.getByRole("dialog", { name: "Idee teilen" })).toBeHidden();

  // The post: its rail, a vote, and a comment posted with its time in German.
  await reader.getByRole("link", { name: "Dark mode" }).click();
  await expect(reader).toHaveURL(/\/de\/feedback\/feature-requests\/dark-mode-1$/);
  const rail = reader.getByRole("complementary", { name: "Über diese Idee" });
  // Its board, named in German: the way back to it, and the rail's.
  await expect(reader.getByRole("link", { name: "Funktionswünsche" }).locator("[lang=de]").first()).toBeVisible();
  await expect(rail.getByText("Funktionswünsche", { exact: true })).toHaveAttribute("lang", "de");
  await rail.getByRole("button", { name: "Abstimmen (1 Stimme)" }).click();
  await expect(rail.getByRole("button", { name: "Abgestimmt (2 Stimmen)" })).toBeVisible();
  const comments = reader.getByRole("region", { name: "Kommentare" });
  await expect(comments.getByRole("heading", { name: "0 Kommentare" })).toBeVisible();
  // Its history: the status change, without who made it.
  await expect(comments.getByText(/^Auf Geplant gesetzt · (jetzt|vor \d+ Minuten?)$/)).toBeVisible();
  // The comment box's toolbar and its link dialog.
  const toolbar = comments.getByRole("toolbar", { name: "Formatierung" });
  await expect(toolbar.getByRole("button", { name: "Kursiv" })).toBeVisible();
  await toolbar.getByRole("button", { name: "Link", exact: true }).click();
  const linkDialog = reader.getByRole("dialog", { name: "Link hinzufügen" });
  await expect(linkDialog.getByRole("button", { name: "Link hinzufügen" })).toBeVisible();
  await linkDialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(linkDialog).toBeHidden();
  await reader.setViewportSize({ width: 390, height: 800 });
  await toolbar.scrollIntoViewIfNeeded();
  await checkpoint(reader, "comment-editor-in-german-phone", { fullPage: false });
  await reader.setViewportSize({ width: 1280, height: 800 });
  await comments.getByRole("textbox", { name: "Kommentieren" }).fill("Bitte auch für die App");
  await comments.getByRole("button", { name: "Kommentieren" }).click();
  await expect(reader.locator("[data-sonner-toast]", { hasText: "Kommentar gepostet" })).toBeVisible();
  await expect(comments.getByRole("heading", { name: "1 Kommentar" })).toBeVisible();
  // The new comment's own time (the status change's comes first in the thread).
  const posted = comments.getByRole("listitem").filter({ hasText: "Bitte auch für die App" });
  await expect(posted.locator("time")).toHaveText(/^(jetzt|vor \d+ (Sekunden?|Minuten?))$/);
  await expect(comments.getByRole("button", { name: "Kommentar von Rita Reader gefällt mir (0 Likes)" })).toBeVisible();
  await checkpoint(reader, "post-in-german", { fullPage: false });

  // The roadmap: the planned idea's card and the board pills name its board in German.
  await reader.goto("/de/roadmap");
  await expect(reader.getByRole("listitem").filter({ hasText: "Dark mode" }).getByText("Funktionswünsche", { exact: true })).toHaveAttribute("lang", "de");
  await expect(reader.getByRole("link", { name: /^Fehler/ }).locator("[lang=de]")).toHaveText("Fehler");

  // On a phone.
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.goto("/de/feedback/feature-requests");
  await expect(reader.getByRole("button", { name: "Neuer Beitrag" })).toBeVisible();
  // The menu's boards, named in German.
  await reader.getByRole("button", { name: "Menü" }).click();
  const menu = reader.getByRole("dialog", { name: "Menü" });
  await expect(menu.getByRole("link", { name: "Funktionswünsche" })).toHaveAttribute("lang", "de");
  await menu.getByRole("button", { name: "Menü schließen" }).click();
  // A board with no description of its own: the German one, under the board's own name.
  await expect(reader.locator('meta[name="description"]')).toHaveAttribute("content", "Stimme für die Ideen ab, die dir am wichtigsten sind, oder teile deine eigenen.");
  // The board switcher named by its content: "Board:" in the page's language, the board's name marked with its own.
  const switcher = reader.getByRole("button", { name: "Board: Funktionswünsche" });
  await expect(switcher).not.toHaveAttribute("aria-label");
  await expect(switcher.locator("[lang=de]")).toHaveText("Funktionswünsche");
  // Its long German name hyphenated to fit, not cut anywhere.
  await expect(reader.getByRole("heading", { level: 1 }).locator("[lang=de]")).toHaveCSS("hyphens", "auto");
  await checkpoint(reader, "board-in-german-phone", { fullPage: false });
});

test("Docs in German: the docs tabs' lock and the sidebar's links, named in German, the team's links in theirs", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // Written by the team (Manual): nothing asks the model to translate its article.
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] }, "PATCH");
  await api("/branding", { sidebarLinks: [{ label: "Status page", url: "https://status.example.com" }] }, "PATCH");
  // Two tabs; Enterprise is for signed-in readers, shown to others with a lock.
  await api("/tabs", { name: "Guides" });
  await api("/tabs", { name: "Enterprise", access: "signed_in", noAccess: "lock" });
  await api("/collections", { name: "Basics", tab: "guides" });
  await api("/collections", { name: "SAML", tab: "enterprise" });
  const article = await api("/articles", { title: "Getting started", body: "Start here.", collection: "basics" });
  await api(`/articles/${article.slug}/publish`, {});
  const saml = await api("/articles", { title: "Setting up SAML", body: "SAML.", collection: "saml" });
  await api(`/articles/${saml.slug}/publish`, {});

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto(`/de/docs/${article.slug}`);
  await expect(reader.locator("html")).toHaveAttribute("lang", "de");
  await expect(reader.getByRole("link", { name: /^Enterprise\s*Gesperrt$/ })).toBeVisible();
  const links = reader.getByRole("list", { name: "Links" }).first();
  await expect(links).toHaveAttribute("lang", "de");
  await expect(links.getByRole("link", { name: "Status page" })).toHaveAttribute("lang", "en");
  // German's word is English's too: in French the list's name shows it's translated.
  await reader.goto(`/fr/docs/${article.slug}`);
  await expect(reader.getByRole("list", { name: "Liens" }).first()).toHaveAttribute("lang", "fr");
  await reader.goto(`/de/docs/${article.slug}`);

  // On a phone the tree and the links are in the header's menu, a size up (data-sidebar-links).
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.getByRole("banner").getByRole("button", { name: "Menü" }).click();
  const menuLinks = reader.getByRole("dialog").locator("ul[data-sidebar-links]");
  await expect(menuLinks.getByRole("link", { name: "Status page" })).toBeVisible();
  await expect(menuLinks).toHaveCSS("font-size", "16px");
});

test("the Roadmap in German: its columns, their meanings, ETAs, votes and the changelog's links, on desktop and on phones", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] }, "PATCH");
  await api("/posts", { board: "feature-requests", title: "Dark mode" }); // 1
  await api("/posts", { board: "feature-requests", title: "CSV export" }); // 2
  await api("/posts/1", { status: "planned", eta: "2099-06" }, "PATCH");
  // CSV export shipped in a published entry.
  await api("/changelog", { title: "CSV export is here", posts: [2] });
  await api("/changelog/1/publish", {});

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto("/de/roadmap");
  await expect(reader.locator("html")).toHaveAttribute("lang", "de");
  // Its description for search engines and links' previews too.
  await expect(reader.locator('meta[name="description"]')).toHaveAttribute("content", "Was geplant ist, woran wir arbeiten und was fertig ist.");
  await expect(reader.getByText(/^Was geplant ist, woran wir arbeiten und was fertig ist\. Melde dich an, um abzustimmen\.$/)).toBeVisible();
  const planned = reader.getByRole("region", { name: "Geplant" });
  await expect(planned).toContainText("Diese werden wir umsetzen.");
  await expect(planned).toContainText("Erwartet im Juni 2099");
  // Signed out, the card's vote is a way to sign in; the idea's title is the team's words.
  await expect(planned.getByRole("link", { name: "Zum Abstimmen anmelden (1 Stimme)" })).toBeVisible();
  await expect(planned.getByRole("link", { name: "Dark mode" })).toHaveAttribute("lang", "en");
  await expect(reader.getByRole("region", { name: "In Arbeit" })).toContainText("Hier ist noch nichts.");
  await expect(reader.getByRole("region", { name: "Erledigt" }).getByRole("link", { name: "Im Changelog: CSV export is here" })).toBeVisible();
  await checkpoint(reader, "roadmap-in-german", { fullPage: false });

  // On a phone, a column at a time.
  await reader.setViewportSize({ width: 390, height: 844 });
  await expect(reader.getByRole("navigation", { name: "Spalten" }).getByRole("link")).toHaveText(["Geplant 1", "In Arbeit 0", "Erledigt 1"]);
  await checkpoint(reader, "roadmap-in-german-phone", { fullPage: false });

  // Its title follows the page's language (in French, where the word isn't "Roadmap").
  await reader.goto("/fr/roadmap");
  await expect(reader).toHaveTitle(/^Feuille de route · /);
});

test("the changelog in German: its list, tags, months, pages, an entry's page, the email box, a subscriber, the menu and the RSS feed", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] }, "PATCH");
  await api("/posts", { board: "feature-requests", title: "Dark mode" }); // 1
  await api("/posts", { board: "feature-requests", title: "CSV export" }); // 2
  // 21 entries: the month index (from 9) and a second page (past 20). The two with ideas are the newest.
  for (let n = 1; n <= 19; n++) {
    await api("/changelog", { title: `Update ${n}`, body: "Small fixes." });
    await api(`/changelog/${n}/publish`, {});
  }
  await api("/changelog", { title: "Dark mode is here", body: "Switch themes from your profile menu.", tags: ["new"], posts: [1] });
  await api("/changelog/20/publish", {});
  await api("/changelog", { title: "Faster exports", body: "Exports finish in seconds.", tags: ["improved"], posts: [1, 2] });
  await api("/changelog/21/publish", {});

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto("/de/changelog");
  await expect(reader.locator("html")).toHaveAttribute("lang", "de");
  await expect(reader.getByText("Was neu, besser und behoben ist bei Acme.")).toBeVisible();
  await expect(reader.getByRole("navigation", { name: "Tags" }).getByRole("link")).toHaveText(["Alle 21", "Neu 1", "Verbessert 1"]);
  await expect(reader.getByRole("link", { name: "RSS-Feed" })).toBeVisible();
  // Feed readers discover the feed in the page's language.
  const discovered = reader.locator('link[rel="alternate"][type="application/rss+xml"]');
  await expect(discovered).toHaveAttribute("href", `${portalUrl(slug)}/de/changelog/rss.xml`);
  // The entries: their tags and dates in German, their ideas' titles in the project's language.
  const darkMode = reader.getByRole("article", { name: "Dark mode is here" });
  await expect(darkMode.getByText("Neu", { exact: true })).toBeVisible();
  await expect(darkMode.locator("time").first()).toHaveText(/^\d+\. \S+ \d{4}$/);
  await expect(darkMode.getByRole("link", { name: /^Aus einer Idee entstanden · 1 Stimme\s*:\s*Dark mode$/ })).toBeVisible();
  await expect(darkMode.locator(".sr-only [lang=en]")).toHaveText("Dark mode");
  const exports = reader.getByRole("article", { name: "Faster exports" });
  await expect(exports.getByRole("link", { name: "CSV export · 1 Stimme" }).locator("[lang=en]")).toHaveText("CSV export");
  await checkpoint(reader, "changelog-in-german", { fullPage: false });
  // The email box, in Subscribe's popover.
  await reader.getByRole("button", { name: "Abonnieren" }).click();
  const box = reader.getByRole("region", { name: "Updates per E-Mail erhalten" });
  const subscriber = `e2e-${randomUUID()}@example.com`;
  await box.getByRole("textbox", { name: "E-Mail" }).fill(subscriber);
  await box.getByRole("button", { name: "Abonnieren" }).click();
  await expect(box.getByRole("status")).toContainText("Sieh in dein Postfach: Wir haben einen Bestätigungslink an");
  await reader.keyboard.press("Escape");
  // Its email is German, and its link opens the subscription's page at the German address, in German (on a phone).
  const confirmation = await latestEmailTo(subscriber);
  expect(confirmation.subject).toBe("Updates von Acme per E-Mail bestätigen");
  const confirmLink = linkIn(confirmation, portalUrl(slug));
  expect(new URL(confirmLink).pathname).toBe("/de/changelog/subscription");
  const inbox = await newPerson(browser, portalUrl(slug));
  await inbox.setViewportSize({ width: 390, height: 844 });
  await inbox.goto(confirmLink);
  await expect(inbox).toHaveTitle(/^Changelog-E-Mails/);
  await expect(inbox.getByRole("heading", { name: "Updates von Acme per E-Mail bekommen?" })).toBeVisible();
  await checkpoint(inbox, "changelog-subscription-in-german-phone", { fullPage: false });
  await inbox.getByRole("button", { name: "Abo bestätigen" }).click();
  await expect(inbox).toHaveURL(/\/de\/changelog\/subscription\?token=/);
  await expect(inbox.getByRole("heading", { name: "Du bekommst die Updates von Acme per E-Mail" })).toBeVisible();

  // An entry's page: the way back, its reactions and comments.
  await darkMode.getByRole("link", { name: "Dark mode is here" }).click();
  await expect(reader).toHaveURL(/\/de\/changelog\/20$/);
  await expect(reader.getByRole("link", { name: "Changelog" }).first()).toBeVisible();
  await expect(reader.getByRole("button", { name: /^Mit .+ reagieren$/ }).first()).toHaveAttribute("title", "Zum Reagieren anmelden");
  const comments = reader.getByRole("region", { name: "Kommentare" });
  await expect(comments.getByRole("heading", { name: "0 Kommentare" })).toBeVisible();
  await expect(comments.getByText("Melde dich an, um zu kommentieren.")).toBeVisible();
  await checkpoint(reader, "changelog-entry-in-german", { fullPage: false });

  // On a phone, the header's menu lists the entries, their titles in the project's language.
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.getByRole("banner").getByRole("button", { name: "Menü" }).click();
  const entries = reader.getByRole("dialog").getByRole("navigation", { name: "Changelog-Einträge" });
  await expect(entries.getByText("Dark mode is here")).toHaveAttribute("lang", "en");
  await checkpoint(reader, "changelog-menu-in-german-phone", { fullPage: false });

  // The RSS feed under the German address: its title, description and the entries' tags in German, its links to the German pages.
  const feed = await (await reader.request.get("/de/changelog/rss.xml")).text();
  expect(feed).toContain("<title>Changelog von Acme</title>");
  expect(feed).toContain("<description>Was neu, besser und behoben ist bei Acme.</description>");
  expect(feed).toContain("<category>Neu</category>");
  expect(feed).toMatch(/<atom:link href="[^"]*\/de\/changelog\/rss\.xml" rel="self"/);
  expect(feed).toMatch(/<link>[^<]*\/de\/changelog\/21<\/link>/);

  // The month index and the pages, in French (a month's name differs from English there): "novembre 2026, 21 entrées".
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto("/fr/changelog");
  const months = reader.getByRole("navigation", { name: "Mois" });
  await expect(months.getByRole("heading", { name: "Aller au mois" })).toBeVisible();
  // Its newest month (the entries span two if a month ends while they're made).
  await expect(months.getByRole("link").first()).toHaveAccessibleName(/^[a-zéû]+ \d{4}, \d+ entrées?$/);
  await reader.getByRole("link", { name: "Entrées plus anciennes" }).click();
  await expect(reader).toHaveURL(/\/fr\/changelog\/page\/2$/);
  // On a phone, the pages' links fit (they wrap rather than run off the screen).
  await reader.setViewportSize({ width: 390, height: 844 });
  await expect(reader.getByRole("link", { name: "Entrées plus récentes" })).toBeVisible();
  expect(await reader.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // A signed-in subscriber: where they stand instead of the form, and their own comment deleted, in German.
  const member = await signUp(browser, portalUrl(slug), "Mia Member");
  await api("/changelog-subscribers", { emails: [member.email] });
  await member.setViewportSize({ width: 1280, height: 800 });
  await member.goto("/de/changelog");
  const standing = member.getByRole("complementary", { name: "Changelog folgen" });
  await expect(standing).toContainText(`Die Changelog-Einträge, die Acme an Abonnenten mailt, gehen an ${member.email}.`);
  await expect(standing.getByRole("link", { name: "Verwalten" })).toBeVisible();
  await member.goto("/de/changelog/20");
  const thread = member.getByRole("region", { name: "Kommentare" });
  await thread.getByRole("textbox", { name: "Kommentieren" }).fill("Endlich!");
  await thread.getByRole("button", { name: "Kommentieren" }).click();
  await expect(thread.getByRole("heading", { name: "1 Kommentar" })).toBeVisible();
  await thread.getByRole("button", { name: "Deinen Kommentar löschen" }).click();
  const confirm = member.getByRole("alertdialog", { name: "Diesen Kommentar löschen?" });
  await expect(confirm).toContainText("Er ist dann für alle endgültig weg.");
  await confirm.getByRole("button", { name: "Kommentar löschen" }).click();
  await expect(member.locator("[data-sonner-toast]", { hasText: "Kommentar gelöscht" })).toBeVisible();
  await expect(thread.getByRole("heading", { name: "0 Kommentare" })).toBeVisible();
});

test("on a phone, a changelog page with both its page links fits, in French's long words", async ({ browser }) => {
  test.setTimeout(120_000);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "fr", live: true, newPages: "manual" }] }, "PATCH");
  // 41 entries: page 2 of 3 has both Newer and Older.
  // One at a time: each publish takes the project's lock.
  for (let n = 1; n <= 41; n++) {
    await api("/changelog", { title: `Update ${n}`, body: "Small fixes." });
    await api(`/changelog/${n}/publish`, {});
  }

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.goto("/fr/changelog/page/2");
  await expect(reader.getByRole("link", { name: "Entrées plus récentes" })).toBeVisible();
  await expect(reader.getByRole("link", { name: "Entrées plus anciennes" })).toBeVisible();
  expect(await reader.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("the docs in German: the home, search (box, dialog and page), a collection, locked tabs and an empty home", async ({ browser }, testInfo) => {
  // Two projects: one with tabs, one without.
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // Written by the team (Manual): nothing asks the model to translate the articles.
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }, { code: "fr", live: true, newPages: "manual" }] }, "PATCH");
  await api("/tabs", { name: "Guides" });
  await api("/tabs", { name: "Enterprise", access: "signed_in", noAccess: "lock" });
  // A tab for a group of readers only: a signed-in reader outside it has no access.
  await api("/groups", { name: "Partners", conditions: [{ property: "plan", op: "is", value: "partner" }] });
  await api("/tabs", { name: "Partner guides", access: "groups", groups: ["partners"], noAccess: "lock" });
  await api("/collections", { name: "Reselling", tab: "partner-guides" });
  const reselling = await api("/articles", { title: "Reselling Acme", body: "Margins.", collection: "reselling" });
  await api(`/articles/${reselling.slug}/publish`, {});
  await api("/collections", { name: "Basics", tab: "guides" });
  await api("/collections", { name: "SAML", tab: "enterprise" });
  for (const title of ["Getting started", "Inviting your team"]) {
    const article = await api("/articles", { title, body: `${title}: how it works.`, collection: "basics" });
    await api(`/articles/${article.slug}/publish`, {});
  }
  // One in no collection: "More articles" on the home.
  const loose = await api("/articles", { title: "Release notes", body: "What changed." });
  await api(`/articles/${loose.slug}/publish`, {});
  const saml = await api("/articles", { title: "Setting up SAML", body: "SAML.", collection: "saml" });
  await api(`/articles/${saml.slug}/publish`, {});

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto("/de/docs");
  await expect(reader.locator("html")).toHaveAttribute("lang", "de");
  // Its title (what a search result or a tab shows) in German too.
  await expect(reader).toHaveTitle(/^Dokumentation/);
  await expect(reader.getByRole("heading", { level: 1, name: "Wie können wir helfen?" })).toBeVisible();
  await expect(reader.getByText("Anleitungen und Antworten auf häufige Fragen.")).toBeVisible();
  // The default heading is the portal's words: the page's language, no lang of its own.
  await expect(reader.getByRole("heading", { level: 1 })).not.toHaveAttribute("lang");
  await expect(reader.getByText("Anleitungen und Antworten auf häufige Fragen.")).not.toHaveAttribute("lang");
  const collections = reader.getByRole("list", { name: "Sammlungen" });
  await expect(collections.getByRole("link", { name: /Basics/ })).toContainText("2 Artikel");
  await expect(collections.getByRole("heading", { name: "Basics" }).locator("[lang=en]")).toHaveText("Basics");
  await expect(reader.getByRole("heading", { name: "Weitere Artikel" })).toBeVisible();
  // The docs' tabs under the header, named in German.
  await expect(reader.getByRole("navigation", { name: "Dokumentationsbereiche" }).getByRole("link", { name: "Guides", exact: true })).toBeVisible();
  await checkpoint(reader, "docs-home-in-german", { fullPage: false });

  // The search dialog: as typed, nothing found, then an article (its title the team's words).
  await reader.getByRole("main").getByRole("button", { name: /^(Dokumentation durchsuchen|Suchen oder KI fragen)$/ }).click();
  const dialog = reader.getByRole("dialog");
  const box = dialog.getByRole("combobox");
  await expect(dialog.getByText(/^Tippe, um die Dokumentation zu durchsuchen( oder die KI zu fragen)?\.$/)).toBeVisible();
  await box.fill("zebra");
  await expect(dialog.getByText("Keine Artikel zu „zebra“.")).toBeVisible();
  await box.fill("inviting");
  const results = dialog.getByRole("listbox", { name: "Suchergebnisse" });
  await expect(results.getByRole("option").first()).toContainText(/^(KI fragen:|Alle Ergebnisse für)\s*inviting/);
  await expect(results.getByRole("option", { name: /Inviting your team/ }).locator("[lang=en]").first()).toHaveText("Inviting your team");
  await reader.keyboard.press("Escape");
  // The results' page.
  await reader.goto("/de/docs?q=zebra");
  await expect(reader.getByRole("heading", { level: 1, name: "Ergebnisse für „zebra“" })).toBeVisible();
  await expect(reader).toHaveTitle(/^Ergebnisse für „zebra“ · Dokumentation/);
  await expect(reader.getByText("Keine Artikel zu „zebra“", { exact: true })).toBeVisible();
  await expect(reader.getByRole("link", { name: "Alle Artikel" })).toBeVisible();

  // A collection: its articles' list.
  await reader.goto("/de/docs/basics");
  await expect(reader.getByRole("main").getByRole("list", { name: "Artikel" }).getByRole("link")).toHaveCount(2);
  await expect(reader).toHaveTitle(/^Basics · Dokumentation/);
  // Its breadcrumb for search engines: German words, German addresses.
  const breadcrumb = JSON.parse((await reader.locator('script[type="application/ld+json"]').textContent())!) as { itemListElement: { name: string; item: string }[] };
  expect(breadcrumb.itemListElement.map(({ name, item }) => [name, new URL(item).pathname])).toEqual([
    ["Dokumentation", "/de/docs"],
    ["Basics", "/de/docs/basics"],
  ]);
  // The tree beside it, named in German.
  await expect(reader.getByRole("navigation", { name: "Dokumentation", exact: true }).getByRole("link", { name: /Getting started/ })).toBeVisible();

  // A locked tab: signing in to read it.
  await reader.goto("/de/docs/enterprise");
  await expect(reader.getByText("Melde dich an, um das zu lesen.")).toBeVisible();
  await expect(reader.getByRole("main").getByRole("link", { name: "Anmelden" })).toBeVisible();

  // Signed in but not in the tab's group: no access, said so.
  const member = await signUp(browser, portalUrl(slug), "Mia Member");
  await member.goto("/de/docs/partner-guides");
  await expect(member.getByText("Du hast keinen Zugriff darauf.")).toBeVisible();

  // Without JavaScript (where the header's menu can't open), a collection's tree opens from a summary: in German.
  await reader.goto("/de/docs/basics");
  expect(await reader.content()).toContain(">Dokumentation durchstöbern</summary>");
  // And on an article's page.
  await reader.goto(`/de/docs/${loose.slug}`);
  expect(await reader.content()).toContain(">Dokumentation durchstöbern</summary>");

  // On a phone.
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.goto("/de/docs");
  await expect(reader.getByRole("heading", { level: 1, name: "Wie können wir helfen?" })).toBeVisible();
  await checkpoint(reader, "docs-home-in-german-phone", { fullPage: false });

  // The team's own heading (Customize → Docs home) is the team's words: in the project's language.
  await api("/branding", { docsHome: { title: "Acme Help", subtitle: "Answers for Acme customers." } }, "PATCH");
  await reader.goto("/de/docs");
  await expect(reader.getByRole("heading", { level: 1, name: "Acme Help" })).toHaveAttribute("lang", "en");
  await expect(reader.getByText("Answers for Acme customers.")).toHaveAttribute("lang", "en");

  // The home's box in French, whose "Demander à l’IA" is wider than "Ask AI": the button leaves the box's words and its
  // shortcut uncovered, on desktop and on a phone.
  await reader.goto("/fr/docs");
  const hero = reader.locator("[data-docs-hero] [role=search]");
  const askAI = hero.getByRole("button", { name: "Demander à l’IA", exact: true });
  for (const width of [1280, 390]) {
    await reader.setViewportSize({ width, height: 844 });
    await expect(askAI).toBeVisible();
    const button = (await askAI.boundingBox())!;
    for (const covered of [hero.locator("button span.truncate"), hero.locator("kbd")]) {
      if (await covered.isVisible()) {
        const box = (await covered.boundingBox())!;
        expect(box.x + box.width, `${width}px`).toBeLessThanOrEqual(button.x);
      }
    }
  }

  // Without tabs, the way up from a collection's page is the docs' home: "Alle Sammlungen".
  const plain = `e2e-${randomUUID().slice(0, 8)}`;
  await createProject(team, "Plain", plain);
  const plainApi = await apiFor(team, plain);
  await plainApi("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }] }, "PATCH");
  // Nothing published yet: the docs' home says so.
  const visitor = await newPerson(browser, portalUrl(plain));
  await visitor.setViewportSize({ width: 1280, height: 800 });
  await visitor.goto("/de/docs");
  await expect(visitor.getByText("Hier ist noch nichts", { exact: true })).toBeVisible();
  await expect(visitor.getByText("Artikel erscheinen hier, sobald sie veröffentlicht sind.")).toBeVisible();
  await plainApi("/collections", { name: "Basics" });
  const intro = await plainApi("/articles", { title: "Intro", body: "Hello.", collection: "basics" });
  await plainApi(`/articles/${intro.slug}/publish`, {});
  await visitor.goto("/de/docs/basics");
  await expect(visitor.getByRole("main").getByRole("link", { name: "Alle Sammlungen" })).toBeVisible();
  // An article in no collection: its breadcrumb's way up is the docs' home too.
  const uncollected = await plainApi("/articles", { title: "Loose", body: "In no collection." });
  await plainApi(`/articles/${uncollected.slug}/publish`, {});
  await visitor.goto(`/de/docs/${uncollected.slug}`);
  await expect(visitor.getByRole("navigation", { name: "Navigationspfad" }).getByRole("link", { name: "Alle Sammlungen" })).toBeVisible();
  // In a collection: Dokumentation, then the collection.
  await visitor.goto(`/de/docs/${intro.slug}`);
  await expect(visitor.getByRole("navigation", { name: "Navigationspfad" }).getByRole("link")).toHaveText(["Dokumentation", "Basics"]);
});

test("signing in, signing up and resetting a password in German, the sign-in link's page and single sign-on's error, on desktop and on phones", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true }] }, "PATCH");

  // Signing in: its title, its fields and ways, all in German.
  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto("/de/sign-in");
  await expect(reader).toHaveTitle(/^Anmelden/);
  await expect(reader.getByText("Bei Acme anmelden", { exact: true })).toBeVisible();
  await expect(reader.getByText("Stimme ab, kommentiere und folge Ideen. Wir mailen dir, wenn es vorangeht und sobald sie veröffentlicht sind.")).toBeVisible();
  await expect(reader.getByRole("link", { name: "Stattdessen ein Passwort verwenden" })).toBeVisible();
  await expect(reader.getByRole("link", { name: "Passwort vergessen?" })).toBeVisible();
  await expect(reader.getByText(/^Neu hier\?\s*Konto erstellen$/)).toBeVisible();
  await expect(reader.getByText(/^Im Team\?\s*Mit Tuti anmelden$/)).toBeVisible();
  await checkpoint(reader, "sign-in-in-german", { fullPage: false });
  // The sent link's card.
  const email = `e2e-${randomUUID()}@example.com`;
  await reader.getByLabel("E-Mail").fill(email);
  await reader.getByRole("button", { name: "Anmeldelink per E-Mail senden" }).click();
  await expect(reader.getByText("Sieh in dein Postfach", { exact: true })).toBeVisible();
  await expect(reader.getByText(/^Wir haben einen Anmeldelink an .+ gesendet\. Er funktioniert einmal, in den nächsten \d+ Minuten\.$/)).toBeVisible();
  await expect(reader.getByRole("button", { name: "Neuen Link senden" })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Andere E-Mail-Adresse verwenden" })).toBeVisible();
  await expect(reader.getByRole("link", { name: "Zurück zu Acme" })).toBeVisible();
  // The link as it was emailed: asked on a German page, it opens at the German address, and its page asks to confirm in German.
  // Its email is in German too.
  const signInEmail = await latestEmailTo(email);
  expect(signInEmail.subject).toBe("Bei Acme anmelden");
  const link = linkIn(signInEmail, portalUrl(slug));
  expect(new URL(link).pathname).toBe("/de/sign-in/link");
  await reader.goto(link);
  await expect(reader.locator("html")).toHaveAttribute("lang", "de");
  await expect(reader.getByText(`als ${email}`)).toBeVisible();
  await expect(reader.getByRole("button", { name: "Anmelden" })).toBeVisible();
  // A dead link there goes back to signing in, still in German.
  await reader.goto("/de/sign-in/link?token=used-up");
  await expect(reader).toHaveURL(/\/de\/sign-in\?link=failed/);
  await expect(reader.getByText("Dieser Anmeldelink ist abgelaufen oder wurde schon verwendet. Fordere einen neuen an.")).toBeVisible();

  // A sign-in link or sign-in that didn't work says so.
  await reader.goto("/de/sign-in?link=failed");
  await expect(reader.getByText("Dieser Anmeldelink ist abgelaufen oder wurde schon verwendet. Fordere einen neuen an.")).toBeVisible();
  await reader.goto("/de/sign-in?continue=failed");
  await expect(reader.getByText("Die Anmeldung hat nicht geklappt. Bitte versuche es erneut.")).toBeVisible();

  // Signing up.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.setViewportSize({ width: 390, height: 844 });
  await visitor.goto("/de/sign-up");
  await expect(visitor).toHaveTitle(/^Registrieren/);
  await expect(visitor.getByText("Acme beitreten", { exact: true })).toBeVisible();
  await expect(visitor.getByLabel("Name")).toHaveAttribute("placeholder", "Dein Name");
  await expect(visitor.getByRole("button", { name: "Registrierungslink per E-Mail senden" })).toBeVisible();
  await expect(visitor.getByText(/^Schon ein Konto\?\s*Anmelden$/)).toBeVisible();
  await checkpoint(visitor, "sign-up-in-german-phone", { fullPage: false });
  // Resetting a password: for an account, so its email (in German) is sent.
  const account = await signUp(browser, portalUrl(slug), "Rita Reader");
  await visitor.goto("/de/forgot-password");
  await expect(visitor).toHaveTitle(/^Passwort zurücksetzen/);
  await expect(visitor.getByText("Wir mailen dir einen Link, um ein neues festzulegen.")).toBeVisible();
  await visitor.getByLabel("E-Mail").fill(account.email);
  await visitor.getByRole("button", { name: "Link per E-Mail senden" }).click();
  await expect(visitor.getByText(new RegExp(`^Falls es ein Konto für ${account.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} gibt`))).toBeVisible();
  expect((await latestEmailTo(account.email, { subject: /Passwort/ })).subject).toBe("Passwort zurücksetzen");
  await visitor.goto("/de/forgot-password?link=failed");
  await expect(visitor.getByText("Dieser Link ist abgelaufen oder wurde schon verwendet. Fordere einen neuen an.")).toBeVisible();
  // Single sign-on's error: the reader's words in German, what went wrong for whoever set it up in English.
  await visitor.goto("/de/sso/error?code=invalid_token");
  await expect(visitor.getByRole("heading", { name: "Anmeldung fehlgeschlagen" })).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Erneut versuchen" })).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Weiter zum Board" })).toBeVisible();

  // A private portal says so, to someone signed out and to an account without access.
  const member = await signUp(browser, portalUrl(slug), "Mia Member");
  await query(`UPDATE project SET "portalAccess" = 'PRIVATE' WHERE slug = $1`, [slug]);
  await visitor.goto("/de/sign-in");
  await expect(visitor.getByText("Acme ist privat. Melde dich an, um es zu sehen.")).toBeVisible();
  await member.goto("/de/sign-in");
  await expect(member.getByText(`Acme ist privat, und ${member.email} hat keinen Zugriff.`, { exact: false })).toBeVisible();

  // With single sign-on, its button first, then "oder" and the emailed link (the page kept with ?with=email).
  await query(`UPDATE project SET "portalAccess" = 'PUBLIC', "ssoSecret" = 'e2e-secret', "ssoSignInUrl" = 'https://app.example.com/sign-in' WHERE slug = $1`, [slug]);
  await visitor.goto("/de/sign-in?with=email");
  await expect(visitor.getByRole("link", { name: "Weiter mit Acme" })).toBeVisible();
  await expect(visitor.getByText("oder", { exact: true })).toBeVisible();
});

test("a reader's account in German: its sections, profile, email settings and lists, on desktop and on phones", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true }] }, "PATCH");
  await api("/posts", { board: "feature-requests", title: "Dark mode" });

  // A vote, for the votes list.
  const reader = await signUp(browser, portalUrl(slug), "Rita Reader");
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto("/de/feedback/feature-requests");
  await reader.getByRole("button", { name: "Abstimmen (1 Stimme)" }).click();
  await expect(reader.getByRole("button", { name: "Stimme zurückziehen (2 Stimmen)" })).toBeVisible();
  // Saved (not only shown): still there after a reload.
  await expect(async () => {
    await reader.reload();
    await expect(reader.getByRole("button", { name: "Stimme zurückziehen (2 Stimmen)" })).toBeVisible({ timeout: 1000 });
  }).toPass();

  await reader.goto("/de/account");
  await expect(reader).toHaveTitle(/^Konto/);
  await expect(reader.getByRole("heading", { level: 1, name: "Konto" })).toBeVisible();
  await expect(reader.getByText(`Angemeldet als ${reader.email}`)).toBeVisible();
  await expect(reader.getByRole("navigation", { name: "Kontobereiche" }).last().getByRole("link")).toHaveText(["Profil", "E-Mails", "Deine Beiträge 0", "Deine Stimmen 1"]);
  // Profile.
  const profile = reader.getByRole("region", { name: "Profil" });
  await expect(profile).toContainText("Wird bei deinen Beiträgen und Kommentaren angezeigt.");
  await expect(profile.getByRole("link", { name: "Ändere deinen Namen in deinem Tuti-Konto" })).toBeVisible();
  await expect(profile.getByRole("button", { name: "Abmelden" })).toBeVisible();
  // Email settings: their switches, and one saved.
  const emails = reader.getByRole("region", { name: "E-Mails" });
  await expect(emails).toContainText("Worüber Acme dir E-Mails schickt.");
  await expect(emails.getByRole("switch", { name: "Meine Beiträge" })).toBeVisible();
  await expect(emails.getByRole("switch", { name: "Beiträge, für die ich gestimmt habe oder denen ich folge" })).toBeVisible();
  await emails.getByRole("switch", { name: "Keine E-Mails von Acme" }).click();
  await expect(reader.locator("[data-sonner-toast]", { hasText: "E-Mail-Einstellungen gespeichert" })).toBeVisible();
  // The lists: none posted yet, and the vote's count read out in German.
  const posts = reader.getByRole("region", { name: "Deine Beiträge" });
  await expect(posts).toContainText("Du hast hier noch nichts gepostet.");
  await expect(posts.getByRole("link", { name: "Ideen ansehen" })).toBeVisible();
  await expect(reader.getByRole("region", { name: "Deine Stimmen" }).getByText("2 Stimmen")).toBeAttached();
  await checkpoint(reader, "account-in-german", { fullPage: false });

  // On a phone.
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.goto("/de/account");
  await expect(reader.getByRole("heading", { level: 1, name: "Konto" })).toBeVisible();
  await checkpoint(reader, "account-in-german-phone", { fullPage: false });
});

test("an API reference in German: its overview, an operation's page and Try it, the spec's words the team's, on desktop and on phones", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  // An API that lets browsers call it, for Try it's answer.
  const fake = await startApiFake({ cors: true });
  try {
    const slug = `e2e-${randomUUID().slice(0, 8)}`;
    const team = await signUp(browser, APP_URL, "Tess Team");
    await createProject(team, "Acme", slug);
    const api = await apiFor(team, slug);
    await api("/languages", { languages: [{ code: "de", live: true }] }, "PATCH");
    await api("/api-references", {
      name: "Reference",
      spec: `
openapi: 3.1.0
info: { title: Acme API, version: "2" }
servers: [{ url: "${fake.origin}/v1" }]
components: { securitySchemes: { key: { type: http, scheme: bearer } } }
security: [{ key: [] }]
paths:
  /posts/{id}:
    get:
      tags: [Posts]
      summary: Get a post
      parameters: [{ name: id, in: path, required: true, schema: { type: integer }, example: 1 }]
      responses: { "200": { description: The post, content: { application/json: { schema: { type: object, properties: { post: { type: object, properties: { title: { type: string } } }, note: { type: [string, "null"] } } }, example: { post: { title: Dark mode } } } } } }
  /files/large:
    get:
      tags: [Files]
      summary: Get a file
      parameters: [{ name: size, in: query, required: true, schema: { type: integer }, example: 4200 }]
      responses: { "200": { description: The file } }
`,
    });

    const reader = await newPerson(browser, portalUrl(slug));
    await reader.setViewportSize({ width: 1440, height: 900 });
    // The overview: the page's words in German, the spec's and the team's names in the team's language.
    await reader.goto("/de/docs/reference");
    const main = reader.getByRole("main");
    await expect(main.locator("article")).toContainText("API-Referenz");
    await expect(main.getByText("Version 2 · OpenAPI")).toBeVisible();
    await expect(main.getByRole("heading", { level: 1, name: "Reference" })).toHaveAttribute("lang", "en");
    await expect(main.getByRole("region", { name: "Wohin Anfragen gehen" })).toBeVisible();
    await expect(main.getByRole("region", { name: "Wie Anfragen signiert werden" })).toContainText("Bearer-Token im Header Authorization");
    await expect(main.getByRole("heading", { level: 2, name: "Endpunkte" })).toBeVisible();
    await expect(main.getByRole("heading", { level: 3, name: "Posts" })).toHaveAttribute("lang", "en");
    await expect(reader.getByRole("link", { name: "Übersicht" })).toBeVisible();
    // Without JavaScript, the tree's toggle is in German too.
    // The summary itself, inside <noscript> (the messages sent to the browser have the words too).
    expect(await reader.content()).toMatch(/<noscript>(?:(?!<\/noscript>)[\s\S])*>Dokumentation durchstöbern<\/summary>/);

    // An operation's page.
    await reader.goto("/de/docs/reference/get-a-post");
    await expect(main.getByRole("heading", { level: 1, name: "Get a post" })).toHaveAttribute("lang", "en");
    await expect(main.getByText("Autorisierung Bearer-Token")).toBeVisible();
    await expect(main.getByRole("region", { name: "Pfadparameter" })).toContainText("erforderlich");
    const responses = main.getByRole("region", { name: "Antworten" });
    await expect(responses.getByText("The post")).toHaveAttribute("lang", "en");
    await expect(responses.getByText("1 Eigenschaft anzeigen")).toBeAttached();
    await expect(responses.getByText("string · kann null sein")).toBeAttached();
    await expect(reader.getByRole("region", { name: "Beispielanfrage" })).toBeVisible();
    await expect(reader.getByRole("region", { name: "Beispielantwort" })).toBeVisible();
    await checkpoint(reader, "api-reference-in-german", { fullPage: false });

    // Try it: its fields, and an answer.
    await main.getByRole("button", { name: "Ausprobieren" }).click();
    const panel = reader.getByRole("dialog", { name: "Ausprobieren" });
    await expect(panel.getByText("Nur in diesem Tab gespeichert.")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Schließen" })).toBeVisible();
    await expect(panel.getByRole("region", { name: "Parameter" })).toContainText("Pfad · erforderlich");
    await panel.getByLabel("Bearer-Token").fill("sk_test_123");
    await panel.getByRole("button", { name: "Senden", exact: true }).click();
    const answer = panel.getByRole("region", { name: "Antwort" });
    await expect(answer.getByText("201 Created")).toBeVisible();
    await expect(answer.getByLabel("Antwort-Body")).toBeVisible();
    // Copying says so in German, whether the browser lets it or not.
    await panel.getByRole("button", { name: "Als cURL kopieren" }).click();
    await expect(reader.locator("[data-sonner-toast]", { hasText: /^(Kopiert|Kopieren nicht möglich\.)/ })).toBeVisible();
    await checkpoint(reader, "api-reference-try-it-in-german", { fullPage: false });

    // A bigger answer: its size in German numbers ("4,2 KB", not "4.2 KB"), on screen.
    await reader.goto("/de/docs/reference/get-a-file");
    await main.getByRole("button", { name: "Ausprobieren" }).click();
    await panel.getByRole("button", { name: "Senden", exact: true }).click();
    await expect(panel.getByRole("region", { name: "Antwort" }).getByText("4,2 KB", { exact: true })).toBeVisible();

    // On a phone.
    await reader.setViewportSize({ width: 390, height: 844 });
    await reader.goto("/de/docs/reference/get-a-post");
    await expect(main.getByRole("heading", { level: 1, name: "Get a post" })).toBeVisible();
    await checkpoint(reader, "api-reference-in-german-phone", { fullPage: false });
  } finally {
    await fake.close();
  }
});

test("the docs in German: tabs' and collections' names translated on the home, a collection's page and an article's, marked as German", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // Two tabs: Handbooks translated, Plans not. Invoicing (translated) with Receipts in it (translated too).
  await api("/tabs", { name: "Handbooks" });
  // Plans for signed-in readers only: a signed-out one sees its page locked.
  await api("/tabs", { name: "Plans", access: "signed_in", noAccess: "lock" });
  await api("/collections", { name: "Invoicing", description: "Paying and receipts.", tab: "handbooks" });
  await api("/collections", { name: "Receipts", description: "What you get.", parent: "invoicing" });
  await api("/collections", { name: "Pricing", tab: "plans" });
  for (const [title, collection] of [["Paying an invoice", "invoicing"], ["Downloading a receipt", "receipts"], ["Our plans", "pricing"]]) {
    const article = await api("/articles", { title, body: `${title}.`, collection });
    await api(`/articles/${article.slug}/publish`, {});
  }
  // An unlisted article alone in its collection (Notes, in Handbooks): readable at its link, its collection in no list.
  await api("/collections", { name: "Notes", tab: "handbooks" });
  const unlisted = await api("/articles", { title: "Internal notes", body: "Notes.", collection: "notes", listing: "unlisted" });
  await api(`/articles/${unlisted.slug}/publish`, {});
  // German written by the team: nothing asks the model. Its names as the team wrote them (L13's settings, later).
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }] }, "PATCH");
  const german = (name: string, description?: string) => JSON.stringify({ de: { name, ...(description !== undefined && { description }), auto: false, source: null } });
  await query(`UPDATE collection SET translations = $1 WHERE slug = 'invoicing' AND "projectId" = (SELECT id FROM project WHERE slug = $2)`, [german("Rechnungen", "Bezahlen und Belege."), slug]);
  await query(`UPDATE collection SET translations = $1 WHERE slug = 'receipts' AND "projectId" = (SELECT id FROM project WHERE slug = $2)`, [german("Belege", "Was du bekommst."), slug]);
  await query(`UPDATE docs_tab SET translations = $1 WHERE slug = 'handbooks' AND "projectId" = (SELECT id FROM project WHERE slug = $2)`, [german("Handbücher"), slug]);

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto("/de/docs");
  const collections = reader.getByRole("list", { name: "Sammlungen" });
  await expect(collections.getByRole("heading", { name: "Rechnungen" }).locator("[lang=de]")).toHaveText("Rechnungen");
  await expect(collections.getByText("Bezahlen und Belege.")).toHaveAttribute("lang", "de");
  // The tabs: one in German, the other in the team's English, each marked so.
  const tabs = reader.getByRole("navigation", { name: "Dokumentationsbereiche" });
  await expect(tabs.getByRole("link", { name: "Handbücher" }).locator("[lang=de]")).toHaveText("Handbücher");
  await expect(tabs.getByRole("link", { name: "Plans" }).locator("[lang=en]")).toHaveText("Plans");
  await checkpoint(reader, "docs-home-names-in-german", { fullPage: false });
  // A collection's page: its heading and description, the one in it, and its link up to its tab.
  await reader.goto("/de/docs/invoicing");
  await expect(reader.getByRole("heading", { level: 1 }).locator("[lang=de]")).toHaveText("Rechnungen");
  await expect(reader.getByRole("main").getByText("Bezahlen und Belege.")).toHaveAttribute("lang", "de");
  await expect(reader.getByRole("main").getByRole("heading", { name: "Belege" }).locator("[lang=de]")).toHaveText("Belege");
  await expect(reader.getByRole("main").getByText("Was du bekommst.")).toHaveAttribute("lang", "de");
  await expect(reader.getByRole("main").getByRole("link", { name: "Handbücher", exact: true })).toHaveAttribute("lang", "de");
  await checkpoint(reader, "docs-collection-names-in-german", { fullPage: false });
  // The one in it: its link up to Rechnungen.
  await reader.goto("/de/docs/receipts");
  // (Not the tree's link to it, which has its name as its title.)
  await expect(reader.getByRole("main").getByRole("link", { name: "Rechnungen", exact: true }).and(reader.locator("a:not([title])"))).toHaveAttribute("lang", "de");
  // An article in Invoicing: the breadcrumb's link to it, and the sidebar's tree.
  await reader.goto("/de/docs/paying-an-invoice");
  await expect(reader.getByRole("navigation", { name: "Navigationspfad" }).getByRole("link", { name: "Rechnungen" })).toHaveAttribute("lang", "de");
  await expect(reader.getByRole("navigation", { name: "Dokumentation" }).locator("[lang=de]", { hasText: "Rechnungen" })).toBeVisible();
  // That unlisted one: its collection not listed, its breadcrumb's link up is to its tab, Handbücher.
  await reader.goto(`/de/docs/${unlisted.slug}`);
  await expect(reader.getByRole("navigation", { name: "Navigationspfad" }).getByRole("link", { name: "Handbücher" })).toHaveAttribute("lang", "de");
  // The tab not translated, locked for this reader: its page's heading in the team's English.
  await reader.goto("/de/docs/plans");
  await expect(reader.getByRole("heading", { level: 1 }).locator("[lang=en]")).toHaveText("Plans");
  // At the default language's address, the team's names.
  await reader.goto("/docs");
  await expect(reader.getByRole("list", { name: "Collections" }).getByRole("heading", { name: "Invoicing" })).toBeVisible();
});

test("AI answers in German: an answer with its sources and rating, one it can't give, Ask a person, and Still stuck?, on desktop and on phones", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // Written by the team (Manual): nothing asks the model to translate the article.
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }] }, "PATCH");
  // The article's only section is close to the question the reader asks.
  const answered = "Wie lade ich mein Team ein?";
  await similar(answered, "Getting started\n\nStart here: invite your team from the Team page.", 0.8);
  const article = await api("/articles", { title: "Getting started", body: "Start here: invite your team from the Team page." });
  await api(`/articles/${article.slug}/publish`, {});
  // Messages on: Ask a person after an answer, and Contact us.
  await team.goto(`/app/${slug}/settings/support`);
  await team.getByRole("switch", { name: "Messages in the widget" }).click();
  await expect(team.getByText("Messages on")).toBeVisible();

  const reader = await signUp(browser, portalUrl(slug), "Rita Reader");
  await reader.setViewportSize({ width: 1280, height: 800 });
  // An answer: its sources (the article's title the team's words) and its rating.
  await reader.goto(`/de/docs?${new URLSearchParams({ q: answered })}`);
  const answer = reader.getByRole("region", { name: "KI-Antwort" });
  await expect(answer).toContainText("Erhalte eine kurze Antwort aus der Dokumentation, geschrieben von KI.");
  await nextModelReply(JSON.stringify({ answer: "Über die Team-Seite.", sources: ["s1"] }), answered);
  await answer.getByRole("button", { name: "KI fragen" }).click();
  await expect(answer.getByText("Über die Team-Seite.")).toBeVisible();
  const sources = answer.getByRole("list", { name: "Quellen" });
  await expect(sources.getByRole("link", { name: "Getting started" })).toHaveAttribute("lang", "en");
  await expect(answer).toContainText("Von KI aus den Artikeln oben geschrieben. War das hilfreich?");
  await answer.getByRole("button", { name: "Hilfreich", exact: true }).click();
  // Focus moves to it from the button that's gone.
  await expect(answer.getByText("Danke für dein Feedback.")).toBeFocused();
  await checkpoint(reader, "ai-answer-in-german", { fullPage: false });

  // One it can't give: Post this as feedback, and Ask a person, sent.
  const unanswered = "Gibt es einen Dunkelmodus?";
  await reader.goto(`/de/docs?${new URLSearchParams({ q: unanswered })}`);
  await answer.getByRole("button", { name: "KI fragen" }).click();
  await expect(answer.getByText("Das weiß ich nicht")).toBeVisible();
  await expect(answer).toContainText("Dazu steht noch nichts in der Dokumentation. Poste es als Feedback, damit das Team es sieht.");
  await expect(answer.getByRole("link", { name: "Als Feedback posten" })).toBeVisible();
  await answer.getByRole("button", { name: "Eine Person fragen" }).click();
  const form = answer.getByRole("form", { name: "Eine Person fragen" });
  await expect(form).toContainText("Wir geben deine Frage und die Antwort der KI ans Team weiter. Die Antwort kommt in Nachrichten.");
  await expect(form.getByLabel("Deine E-Mail-Adresse")).toHaveValue(reader.email);
  await form.getByLabel("Noch etwas hinzuzufügen? (optional)").fill("Für die App.");
  await nextModelReply("They ask about a dark mode.", unanswered);
  await form.getByRole("button", { name: "An das Team senden" }).click();
  await expect(answer.getByText("Wir haben das ans Team weitergegeben. Die Antwort erscheint in Nachrichten.")).toBeVisible();
  await expect(answer.getByRole("link", { name: "Nachrichten öffnen" })).toBeVisible();

  // Under an article: Still stuck?, with Ask AI and Contact us; on the docs' home, Can't find it?
  await reader.goto(`/de/docs/${article.slug}`);
  const stuck = reader.getByRole("region", { name: "Noch Fragen?" });
  await expect(stuck).toContainText("Frag die KI nach einer schnellen Antwort oder schreib dem Team.");
  await expect(stuck.getByRole("button", { name: "KI fragen" })).toBeVisible();
  await expect(stuck.getByRole("link", { name: "Kontakt" })).toBeVisible();
  await reader.goto("/de/docs");
  await expect(reader.getByRole("region", { name: "Nicht gefunden?" })).toContainText("Schreib dem Team, wir helfen dir.");

  // On a phone.
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.goto(`/de/docs?${new URLSearchParams({ q: unanswered })}`);
  await expect(reader.getByRole("region", { name: "KI-Antwort" })).toBeVisible();
  await checkpoint(reader, "ai-answer-in-german-phone", { fullPage: false });
});

test("The widget's assistant marks its sources' titles in the project's default language", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { default: "fr" }, "PATCH");
  const question = "Comment inviter mon équipe ?";
  await similar(question, "Premiers pas\n\nInvitez votre équipe depuis la page Équipe.", 0.8);
  const article = await api("/articles", { title: "Premiers pas", body: "Invitez votre équipe depuis la page Équipe." });
  await api(`/articles/${article.slug}/publish`, {});

  const visitor = await signUp(browser, portalUrl(slug), "Vera Visitor");
  await visitor.goto("/docs");
  await visitor.getByRole("main").getByRole("button", { name: "Demander à l’IA", exact: true }).click();
  // The widget's own words are the project's default language's too now (French); the titles are the team's French.
  const assistant = visitor.frameLocator('iframe[title="Feedback"]').getByRole("dialog", { name: "Assistant" });
  await nextModelReply(JSON.stringify({ answer: "Depuis la page Équipe.", sources: ["s1"] }), question);
  await assistant.getByRole("textbox", { name: "Poser une question" }).fill(question);
  await assistant.getByRole("button", { name: "Envoyer" }).click();
  const source = assistant.getByRole("list", { name: "Sources" }).getByRole("link", { name: "Premiers pas" });
  await expect(source).toHaveAttribute("lang", "fr");
  await checkpoint(visitor, "widget-assistant-french-sources", { fullPage: false });
});

test("searching the docs in German finds the articles translated there by their German, at their German address", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // German written by the team: nothing asks the model. Billing's German version as the editor will save it (L11).
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }] }, "PATCH");
  const billing = await api("/articles", { title: "Billing", body: "Pay by card." });
  await api(`/articles/${billing.slug}/publish`, {});
  const setup = await api("/articles", { title: "Setup", body: "Install the app." });
  await api(`/articles/${setup.slug}/publish`, {});
  await query(
    `INSERT INTO article_translation (id, "articleId", "projectId", language, title, slug, body, automatic, "publishedAt", "updatedAt")
     SELECT gen_random_uuid()::text, a.id, a."projectId", 'de', 'Abrechnung', 'abrechnung', 'Mit Karte zahlen.', false, now(), now()
     FROM article a JOIN project p ON p.id = a."projectId" WHERE p.slug = $1 AND a.slug = $2`,
    [slug, billing.slug],
  );

  const reader = await newPerson(browser, portalUrl(slug));
  // The search dialog as the reader types: the German title, marked German.
  await reader.goto("/de/docs");
  await reader.getByRole("main").getByRole("button", { name: /^(Dokumentation durchsuchen|Suchen oder KI fragen)$/ }).click();
  await reader.getByRole("dialog").getByRole("combobox").fill("Karte");
  await expect(reader.getByRole("dialog").getByRole("option", { name: /Abrechnung/ }).locator("[lang=de]").first()).toHaveText("Abrechnung");
  await reader.keyboard.press("Escape");
  // The results' page.
  await reader.goto("/de/docs?q=Karte");
  const result = reader.getByRole("list", { name: "Suchergebnisse" }).getByRole("link", { name: "Abrechnung" });
  await expect(result).toHaveAttribute("href", "/de/docs/abrechnung");
  await expect(result.locator("[lang=de]")).toHaveText("Abrechnung");
  await checkpoint(reader, "docs-search-in-german", { fullPage: false });
  // An article not translated: found by its English, marked as the team's.
  await reader.goto("/de/docs?q=install");
  await expect(reader.getByRole("list", { name: "Suchergebnisse" }).getByRole("link", { name: "Setup" }).locator("[lang=en]")).toHaveText("Setup");
});

test("a post's news to a reader who chose German: its email in German, and its unsubscribe page and button at the German address, on a phone", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }] }, "PATCH");
  const post = await api("/posts", { board: "feature-requests", title: "Dark mode" });

  // Signed in, they choose German in the header (saved on their account), and vote.
  const reader = await signUp(browser, portalUrl(slug), "Rita Reader");
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto("/feedback/feature-requests");
  await reader.getByRole("button", { name: "Language: English" }).click();
  await reader.getByRole("menuitemradio", { name: "Deutsch" }).click();
  await expect(reader).toHaveURL(/\/de\/feedback\/feature-requests$/);
  await reader.getByRole("button", { name: "Abstimmen (1 Stimme)" }).click();
  await expect(reader.getByRole("button", { name: "Stimme zurückziehen (2 Stimmen)" })).toBeVisible();
  await expect(async () => {
    await reader.reload();
    await expect(reader.getByRole("button", { name: "Stimme zurückziehen (2 Stimmen)" })).toBeVisible({ timeout: 1000 });
  }).toPass();

  // The team starts it: the reader's email is German.
  await api(`/posts/${post.number}`, { status: "in_progress" }, "PATCH");
  const email = await latestEmailTo(reader.email, { subject: /Dark mode/ });
  expect(email.subject).toBe("In Arbeit: Dark mode");
  expect(email.text).toContain("Das Team hat mit der Umsetzung begonnen.");
  // Its unsubscribe link opens the page at the German address, in German; its button stays there.
  const unsubscribe = linkIn(email, `${portalUrl(slug)}/de/unsubscribe?token=`);
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.goto(unsubscribe);
  await expect(reader.getByRole("heading", { name: "Keine E-Mails mehr von Acme?" })).toBeVisible();
  await checkpoint(reader, "unsubscribe-in-german-phone", { fullPage: false });
  await reader.getByRole("button", { name: "Abbestellen" }).click();
  await expect(reader).toHaveURL(/\/de\/unsubscribe\?token=/);
  await expect(reader.getByRole("heading", { name: "Du hast abbestellt" })).toBeVisible();
});

test("the widget's panel in German at its language's address (/de/widget): its tabs, Home, Feedback and What's new, the team's words in theirs", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }] }, "PATCH");
  const darkMode = await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await api("/posts", { board: "feature-requests", title: "Offline mode" });
  // An update (the team's words, in the default language): on Home's What's new row, and in What's new. It completes Dark mode.
  await api("/changelog", { title: "CSV export is here", posts: [darkMode.number] });
  await api("/changelog/1/publish", {});

  // The panel as the widget's frame shows it, at a phone's width.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.setViewportSize({ width: 390, height: 700 });
  await visitor.goto("/de/widget");
  await expect(visitor.locator("html")).toHaveAttribute("lang", "de");
  const tabs = visitor.getByRole("navigation", { name: "Widget" });
  await expect(tabs.getByRole("link")).toHaveText(["Start", "Feedback"]);
  await expect(tabs.getByRole("link", { name: "Feedback" })).toHaveAttribute("href", "/de/widget?tab=feedback");
  await expect(visitor.getByText("Hallo 👋")).toBeVisible();
  await expect(visitor.getByText("Wie können wir helfen?")).toBeVisible();
  await expect(visitor.getByRole("link", { name: /Teile eine Idee/ })).toBeVisible();
  await expect(visitor.getByText("Schlag eine Funktion vor oder melde ein Problem")).toBeVisible();
  await expect(visitor.getByRole("button", { name: "Schließen" })).toBeAttached();
  await expect(visitor.getByRole("link", { name: /Bereitgestellt von/ })).toBeVisible();
  // The team's words keep their language: the update's title.
  await expect(visitor.getByText("CSV export is here", { exact: true })).toHaveAttribute("lang", "en");
  await checkpoint(visitor, "widget-home-in-german-phone", { fullPage: false });

  // The team's own greeting, heading and quick link: their words, in their language; and Messages on.
  await api("/widget", { greeting: "Welcome to Acme", title: "Questions about Acme?", links: [{ label: "Status", url: "https://status.example.com" }] }, "PATCH");
  await team.goto(`/app/${slug}/settings/support`);
  await team.getByRole("switch", { name: "Messages in the widget" }).click();
  await expect(team.getByText("Messages on")).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByText("Welcome to Acme")).toHaveAttribute("lang", "en");
  await expect(visitor.getByText("Questions about Acme?")).toHaveAttribute("lang", "en");
  await expect(visitor.getByRole("navigation", { name: "Schnelllinks" }).getByText("Status")).toHaveAttribute("lang", "en");
  await expect(tabs.getByRole("link")).toHaveText(["Start", "Feedback", "Nachrichten"]);
  await expect(visitor.getByRole("link", { name: /Schreib uns eine Nachricht/ })).toBeVisible();
  await tabs.getByRole("link", { name: "Nachrichten" }).click();
  await expect(visitor.getByRole("region", { name: "Das Team" })).toContainText("Das Team von Acme");
  await visitor.goto("/de/widget");

  // Feedback: suggesting an idea, and the ideas (the post's title the team's words).
  await tabs.getByRole("link", { name: "Feedback" }).click();
  await expect(visitor).toHaveURL(/\/de\/widget\?tab=feedback$/);
  await expect(visitor.getByRole("heading", { name: "Schlag eine Idee vor" })).toBeVisible();
  await expect(visitor.getByRole("heading", { name: "Beliebt" })).toBeVisible();
  // The board's words for posting, the team hasn't set its own: the page's language's.
  await expect(visitor.getByPlaceholder("Kurzer, aussagekräftiger Titel")).toBeVisible();
  await expect(visitor.getByRole("region", { name: "Ideen" }).getByRole("link", { name: "Offline mode" })).toHaveAttribute("lang", "en");
  await checkpoint(visitor, "widget-feedback-in-german-phone", { fullPage: false });
  // Signed in on the portal: Trending or theirs.
  const reader = await signUp(browser, portalUrl(slug), "Rita Reader");
  await reader.goto("/de/widget?tab=feedback");
  await expect(reader.getByRole("group", { name: "Anzeigen" }).getByRole("button")).toHaveText(["Beliebt", "Meine"]);

  // What's new: the update, its title the team's words, Read more in German.
  await visitor.goto("/de/widget?tab=whats-new");
  await expect(visitor.getByText("Neuigkeiten", { exact: true }).first()).toBeVisible();
  await expect(visitor.getByRole("heading", { name: "CSV export is here" })).toHaveAttribute("lang", "en");
  const readMore = visitor.getByRole("link", { name: "Weiterlesen über CSV export is here" });
  await expect(readMore.locator("[lang=en]")).toHaveText("CSV export is here");
  await expect(visitor.getByRole("link", { name: "Start" }).first()).toBeVisible();
  // The update's page: the way back, its comments, and signing in to comment (nobody signed in here).
  await readMore.click();
  await expect(visitor).toHaveURL(/\/de\/widget\?tab=whats-new&entry=1$/);
  await expect(visitor.getByRole("link", { name: "Neuigkeiten" })).toHaveAttribute("href", "/de/widget?tab=whats-new");
  await expect(visitor.getByRole("heading", { name: "0 Kommentare" })).toBeVisible();
  // The entry's date and its empty comments in German; its title the team's words.
  await expect(visitor.getByRole("heading", { level: 1, name: "CSV export is here" })).toHaveAttribute("lang", "en");
  await expect(visitor.locator("time").first()).toHaveText(/^\d{1,2}\. [A-ZÄÖÜ][a-zäöü]+ \d{4}$/);
  await expect(visitor.getByText("Noch keine Kommentare.")).toBeVisible();
  // The idea it completes, at the German address.
  await expect(visitor.getByRole("main").getByRole("link", { name: /Dark mode/ }).first()).toHaveAttribute("href", /^\/de\/feedback\//);
  await expect(visitor.getByText("Melde dich an, um zu kommentieren.")).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Anmelden" })).toBeVisible();

  // A private portal's panel, for someone who may not read it: signing in, in German.
  await query(`UPDATE project SET "portalAccess" = 'PRIVATE' WHERE slug = $1`, [slug]);
  await visitor.goto("/de/widget");
  await expect(visitor.getByText("Melde dich an, um das zu sehen. Das öffnet sich in einem neuen Tab.")).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Anmelden" })).toHaveAttribute("href", /\/de\/sign-in$/);
  await expect(visitor.getByRole("button", { name: "Schließen" })).toBeAttached();
});

test("the widget's panel in German framed by a page: a portal reader's named greeting and Your ideas, and a failed sign-in said in German", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }] }, "PATCH");
  const post = await api("/posts", { board: "feature-requests", title: "Dark mode" });

  // A reader signed in on the portal votes, and the team plans the idea.
  const reader = await signUp(browser, portalUrl(slug), "Rita Reader");
  await reader.goto(`/feedback/feature-requests/dark-mode-${post.number}`);
  const voted = reader.waitForResponse((response) => response.request().method() === "POST" && !!response.request().headers()["next-action"]);
  await reader.getByRole("button", { name: /^Upvote/ }).click();
  expect((await voted).ok()).toBe(true);
  await api(`/posts/${post.number}`, { status: "planned" }, "PATCH");

  // A page of the portal's site framing the German panel, which says it signs nobody in: Home shows the portal's reader.
  const framing = (message: string) => (route: import("@playwright/test").Route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<iframe title="Panel" src="/de/widget" style="width:400px;height:700px"></iframe>
        <script>addEventListener("message", (event) => event.data?.type === "tuti:ready" && event.source.postMessage(${message}, "*"));</script>`,
    });
  await reader.route(`${portalUrl(slug)}/our-app`, framing(`{ type: "tuti:identify", token: null }`));
  await reader.goto("/our-app");
  const panel = reader.frameLocator('iframe[title="Panel"]');
  await expect(panel.getByText("Hallo Rita 👋")).toBeVisible();
  const ideaNews = panel.getByRole("region", { name: "Deine Ideen" }).getByRole("link", { name: /Dark mode ist jetzt Geplant/ });
  await expect(ideaNews).toHaveAttribute("href", `/de/feedback/feature-requests/dark-mode-${post.number}`);
  // The idea's title is its people's words, in the default language.
  await expect(ideaNews.locator("[lang=en]")).toHaveText("Dark mode");

  // A page that sends a sign-in token whose exchange fails (offline, the server): the panel says so in German.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.route(`${portalUrl(slug)}/our-app`, framing(`{ type: "tuti:identify", token: "e2e-token" }`));
  await visitor.route(
    (url) => url.pathname === "/de/widget",
    (route) => (route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.continue()),
  );
  await visitor.goto("/our-app");
  const visitorPanel = visitor.frameLocator('iframe[title="Panel"]');
  await visitorPanel.getByRole("navigation", { name: "Widget" }).getByRole("link", { name: "Feedback" }).click();
  await expect(visitorPanel.getByText("Anmeldung fehlgeschlagen")).toBeVisible();
  await expect(visitorPanel.getByText("sign-in-failed")).toHaveCount(0);
});

test("the widget's Help center and Messages in German at /de/widget: browsing, an article, a search, and a first message with where the reply comes", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }] }, "PATCH");
  await api("/collections", { name: "Basics" });
  const line = (type: string, text: string, attrs?: object) => ({ type, ...(attrs && { attrs }), content: [{ type: "text", text }] });
  const introContent = {
    type: "doc",
    content: [{ type: "tableOfContents" }, line("heading", "Invite", { level: 2 }), line("paragraph", "Invite your team from the Team page."), line("heading", "Roles", { level: 2 })],
  };
  const intro = await api("/articles", { title: "Getting started", content: introContent, collection: "basics" });
  await api(`/articles/${intro.slug}/publish`, {});
  const loose = await api("/articles", { title: "Release notes", body: "What changed." });
  await api(`/articles/${loose.slug}/publish`, {});
  // Its German version, written by the team.
  await query(
    `INSERT INTO article_translation (id, "articleId", "projectId", language, title, slug, body, automatic, "publishedAt", "updatedAt")
     SELECT gen_random_uuid()::text, a.id, a."projectId", 'de', 'Versionshinweise', 'versionshinweise', 'Was sich geändert hat.', false, now(), now()
     FROM article a JOIN project p ON p.id = a."projectId" WHERE p.slug = $1 AND a.slug = $2`,
    [slug, loose.slug],
  );
  await team.goto(`/app/${slug}/settings/support`);
  await team.getByRole("switch", { name: "Messages in the widget" }).click();
  await expect(team.getByText("Messages on")).toBeVisible();

  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.setViewportSize({ width: 390, height: 700 });
  // The Help center: its collections and the articles in none, the team's names in theirs.
  await visitor.goto("/de/widget?tab=docs");
  const collections = visitor.getByRole("list", { name: "Sammlungen" });
  await expect(collections.getByText("Basics")).toHaveAttribute("lang", "en");
  await expect(collections).toContainText("1 Artikel");
  await expect(visitor.getByRole("heading", { name: "Weitere Artikel" })).toBeVisible();
  await expect(visitor.getByRole("searchbox", { name: "Die Dokumentation durchsuchen" })).toHaveAttribute("placeholder", "Dokumentation durchsuchen");
  // A collection, then its article: the way back, Open in new tab, the title the team's words.
  await collections.getByRole("link", { name: /Basics/ }).click();
  await expect(visitor.getByRole("link", { name: "Alle Artikel" })).toBeVisible();
  // Its articles' titles: the team's words.
  await expect(visitor.getByRole("link", { name: "Getting started" }).locator("xpath=descendant-or-self::*[@lang][1]")).toHaveAttribute("lang", "en");
  await visitor.getByRole("link", { name: "Getting started" }).click();
  await expect(visitor.getByRole("heading", { level: 1, name: "Getting started" })).toHaveAttribute("lang", "en");
  await expect(visitor.getByText("Invite your team from the Team page.").locator("xpath=ancestor::*[@lang][1]")).toHaveAttribute("lang", "en");
  // A table of contents in it: its heading the panel's words, in German.
  await expect(visitor.getByRole("navigation", { name: "In diesem Artikel" })).toHaveAttribute("lang", "de");
  // Not in German yet: said in German.
  await expect(visitor.getByText("Diese Seite gibt es noch nicht auf Deutsch: Sie wird in ihrer Originalsprache angezeigt.")).toBeVisible();
  await expect(visitor.getByRole("link", { name: "In neuem Tab öffnen" })).toHaveAttribute("href", /^\/de\/docs\//);
  await checkpoint(visitor, "widget-help-center-in-german-phone", { fullPage: false });
  // A search with nothing found, and an article that isn't there.
  await visitor.goto(`/de/widget?tab=docs&q=zebra`);
  await expect(visitor.getByText("Keine Artikel zu „zebra“")).toBeVisible();
  await visitor.goto(`/de/widget?tab=docs&article=nowhere`);
  await expect(visitor.getByText("Artikel nicht gefunden")).toBeVisible();
  // A translated article: its German version, marked German.
  await visitor.goto(`/de/widget?tab=docs&article=${loose.slug}`);
  await expect(visitor.getByRole("heading", { level: 1, name: "Versionshinweise" })).toHaveAttribute("lang", "de");
  await expect(visitor.getByText("Was sich geändert hat.").locator("xpath=ancestor::*[@lang][1]")).toHaveAttribute("lang", "de");
  await expect(visitor.getByText("Diese Seite gibt es noch nicht auf Deutsch", { exact: false })).toBeHidden();

  // Messages with the docs to answer from: the AI first, said in German.
  await visitor.goto("/de/widget?tab=messages");
  await expect(visitor.getByText("Frag einfach: Du bekommst sofort eine Antwort und bei Bedarf eine Person.")).toBeVisible();

  // Messages where the team answers (no docs for the AI yet), signed out: the form in German, and once sent, where the reply comes.
  const quiet = `e2e-${randomUUID().slice(0, 8)}`;
  await createProject(team, "Beta", quiet);
  await (await apiFor(team, quiet))("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }] }, "PATCH");
  await team.goto(`/app/${quiet}/settings/support`);
  await team.getByRole("switch", { name: "Messages in the widget" }).click();
  await expect(team.getByText("Messages on")).toBeVisible();
  await visitor.goto(`${portalUrl(quiet)}/de/widget?tab=messages`);
  await expect(visitor.getByText("Hinterlass deine E-Mail-Adresse, damit das Team dir antworten kann.")).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Melde dich an" })).toBeVisible();
  await visitor.getByRole("textbox", { name: "Deine E-Mail-Adresse" }).fill(`e2e-${randomUUID()}@example.com`);
  await visitor.getByRole("textbox", { name: "Nachricht" }).fill("Gibt es eine Telefonnummer?");
  await visitor.getByRole("button", { name: "Senden" }).click();
  await expect(visitor.getByRole("list", { name: "Nachrichten" })).toContainText("Gibt es eine Telefonnummer?");
  await expect(visitor.getByText(/^Wir antworten hier/)).toBeVisible();
  await expect(visitor.getByRole("textbox", { name: "Antwort" })).toHaveAttribute("placeholder", "Antwort schreiben…");
  await checkpoint(visitor, "widget-messages-in-german-phone", { fullPage: false });
  // Back to the list: the conversation, waiting for a reply.
  await visitor.getByRole("button", { name: "Nachrichten" }).click();
  await expect(visitor.getByRole("heading", { name: "Deine Unterhaltungen" })).toBeVisible();
  await expect(visitor.getByRole("list", { name: "Unterhaltungen" })).toContainText("Wartet auf Antwort");
  // A new message, now that they're known here: attaching files, in German.
  await visitor.getByRole("button", { name: "Neue Nachricht" }).click();
  await expect(visitor.getByRole("button", { name: "Dateien anhängen" })).toBeVisible();
});

test("an article's own words in German at /de/docs: its actions, reading time, sections, code's Copy, Was this helpful and the way on, around the team's English", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/languages", { languages: [{ code: "de", live: true, newPages: "manual" }] }, "PATCH");
  await api("/collections", { name: "Basics" });
  const text = (value: string) => [{ type: "text", text: value }];
  const content = {
    type: "doc",
    content: [
      { type: "tableOfContents" },
      { type: "heading", attrs: { level: 2 }, content: text("Install") },
      { type: "codeBlock", content: text("npm install acme") },
      { type: "heading", attrs: { level: 2 }, content: text("Sign in") },
      { type: "paragraph", content: text("Open the app and sign in.") },
    ],
  };
  const first = await api("/articles", { title: "Setup", content, collection: "basics" });
  await api(`/articles/${first.slug}/publish`, {});
  // Changed since it was published: readers see when.
  await query(`UPDATE article SET "publishedAt" = '2026-01-05', "revisedAt" = '2026-03-10' WHERE slug = $1 AND "projectId" = (SELECT id FROM project WHERE slug = $2)`, [first.slug, slug]);
  const second = await api("/articles", { title: "Billing", body: "Pay by card.", collection: "basics" });
  await api(`/articles/${second.slug}/publish`, {});
  const third = await api("/articles", { title: "Teams", body: "Invite your team.", collection: "basics" });
  await api(`/articles/${third.slug}/publish`, {});

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.setViewportSize({ width: 1440, height: 900 });
  await reader.goto(`/de/docs/${first.slug}`);
  const main = reader.getByRole("main");
  // The team's English, said so; around it the page's own words in German.
  await expect(main.getByRole("heading", { level: 1, name: "Setup" })).toHaveAttribute("lang", "en");
  await expect(main.getByText("1 Min. Lesezeit")).toBeVisible();
  await expect(main.getByText("Aktualisiert am 10. März 2026")).toBeVisible();
  await expect(main.locator("time", { hasText: "10. März 2026" })).toHaveAttribute("datetime", "2026-03-10T00:00:00.000Z");
  await expect(main.getByRole("button", { name: "Seite kopieren" })).toBeVisible();
  await main.getByRole("button", { name: "Weitere Seitenaktionen" }).click();
  await expect(reader.getByRole("menuitem", { name: "In ChatGPT öffnen" })).toHaveAttribute("href", /Lies%20/);
  await expect(reader.getByRole("menuitem", { name: "Als Markdown ansehen" })).toBeVisible();
  await reader.keyboard.press("Escape");
  await expect(reader.getByRole("button", { name: "Lesemodus" })).toBeVisible();
  await expect(reader.getByRole("navigation", { name: "Auf dieser Seite" })).toBeVisible();
  // The table of contents' label inside the English text: marked German.
  const contents = main.getByRole("navigation", { name: "In diesem Artikel" });
  await expect(contents).toHaveAttribute("lang", "de");
  await expect(contents.getByRole("link", { name: "Install" }).locator("xpath=ancestor::*[@lang][1]")).toHaveAttribute("lang", "en");
  await expect(main.getByRole("button", { name: "Code kopieren" })).toHaveText("Kopieren");
  await expect(main.getByRole("button", { name: "Code kopieren" })).toHaveAttribute("lang", "de");
  await reader.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await main.getByRole("button", { name: "Code kopieren" }).click();
  await expect(reader.locator("[data-sonner-toast]", { hasText: "Kopiert" })).toBeVisible();
  await main.getByRole("button", { name: "Seite kopieren" }).click();
  await expect(reader.locator("[data-sonner-toast]", { hasText: "Als Markdown kopiert" })).toBeVisible();
  await reader.getByRole("button", { name: "Lesemodus" }).hover();
  await expect(reader.getByText("Lesemodus: Spalten neben dem Artikel ausblenden und nur den Artikel lesen")).toBeVisible();
  // The way on, and the answer to Was this helpful.
  await expect(main.getByRole("navigation", { name: "Zurück und weiter" }).getByRole("link", { name: /Weiter/ })).toContainText("Billing");
  await expect(main.getByRole("region", { name: "Ähnliche Artikel" }).getByRole("link", { name: "Teams" })).toBeVisible();
  await expect(main.getByRole("heading", { name: "War das hilfreich?" })).toBeVisible();
  await checkpoint(reader, "article-own-words-in-german");
  await main.getByRole("button", { name: "Nein" }).click();
  await main.getByLabel("Wonach hast du gesucht? (optional)").fill("Mehr zu Rechnungen.");
  await main.getByRole("button", { name: "Senden" }).click();
  await expect(main.getByText("Danke für dein Feedback.")).toBeVisible();
  // The next one's way back.
  await main.getByRole("navigation", { name: "Zurück und weiter" }).getByRole("link", { name: /Weiter/ }).click();
  await expect(main.getByRole("navigation", { name: "Zurück und weiter" }).getByRole("link", { name: /Zurück/ })).toContainText("Setup");
  // On a phone: the actions under the title, the sections a menu.
  await reader.setViewportSize({ width: 390, height: 800 });
  await reader.goto(`/de/docs/${first.slug}`);
  await expect(main.locator("summary").getByText("Auf dieser Seite")).toBeVisible();
  await checkpoint(reader, "article-own-words-in-german-phone", { fullPage: false });
});
