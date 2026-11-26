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

  const reader = await signUp(browser, portalUrl(slug), "Rita Reader");
  await reader.setViewportSize({ width: 1280, height: 800 });
  await reader.goto("/de/feedback");
  await expect(reader.locator("html")).toHaveAttribute("lang", "de");

  // The overview: the boards' pills and cards, how many ideas are still to come, and a board with none.
  await expect(reader.getByRole("navigation", { name: "Boards" }).getByRole("link", { name: "Alle Boards 1" })).toBeVisible();
  await expect(reader.getByText("1 Idee steht noch aus")).toBeVisible();
  await expect(reader.getByText("Noch keine Ideen. Teile die erste.")).toBeVisible();
  await expect(reader.getByRole("link", { name: "Board öffnen" })).toHaveCount(2);
  await checkpoint(reader, "overview-in-german", { fullPage: false });
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

  // The board: its description, sorts, status filter, search and the idea's vote, in German.
  await expect(reader.getByText("Stimme für die Ideen ab, die dir am wichtigsten sind, oder teile deine eigenen.")).toBeVisible();
  await expect(reader.getByRole("navigation", { name: "Sortieren" }).getByRole("link")).toHaveText(["Im Trend", "Top", "Neu", "Meine"]);
  await expect(reader.getByRole("button", { name: "Status: Noch nicht erledigt, 1 Idee" })).toBeVisible();
  await expect(reader.getByRole("searchbox", { name: "Ideen durchsuchen" })).toBeVisible();
  await expect(reader.getByRole("button", { name: "Abstimmen (1 Stimme)" })).toBeVisible();
  // The idea's title is the team's words, in the project's language.
  await expect(reader.getByRole("link", { name: "Dark mode" })).toHaveAttribute("lang", "en");
  await checkpoint(reader, "board-in-german", { fullPage: false });
  await reader.getByRole("button", { name: "Neuer Beitrag" }).click();
  await expect(reader.getByRole("dialog", { name: "Idee teilen" })).toBeVisible();
  await expect(reader.getByRole("textbox", { name: "Titel" })).toHaveAttribute("placeholder", "Kurzer, aussagekräftiger Titel");
  await reader.keyboard.press("Escape");

  // The post: its rail, a vote, and a comment posted with its time in German.
  await reader.getByRole("link", { name: "Dark mode" }).click();
  await expect(reader).toHaveURL(/\/de\/feedback\/feature-requests\/dark-mode-1$/);
  const rail = reader.getByRole("complementary", { name: "Über diese Idee" });
  await rail.getByRole("button", { name: "Abstimmen (1 Stimme)" }).click();
  await expect(rail.getByRole("button", { name: "Abgestimmt (2 Stimmen)" })).toBeVisible();
  const comments = reader.getByRole("region", { name: "Kommentare" });
  await expect(comments.getByRole("heading", { name: "0 Kommentare" })).toBeVisible();
  // Its history: the status change, without who made it.
  await expect(comments.getByText(/^Auf Geplant gesetzt · (jetzt|vor \d+ Minuten?)$/)).toBeVisible();
  await comments.getByRole("textbox", { name: "Kommentieren" }).fill("Bitte auch für die App");
  await comments.getByRole("button", { name: "Kommentieren" }).click();
  await expect(reader.locator("[data-sonner-toast]", { hasText: "Kommentar gepostet" })).toBeVisible();
  await expect(comments.getByRole("heading", { name: "1 Kommentar" })).toBeVisible();
  // The new comment's own time (the status change's comes first in the thread).
  const posted = comments.getByRole("listitem").filter({ hasText: "Bitte auch für die App" });
  await expect(posted.locator("time")).toHaveText(/^(jetzt|vor \d+ (Sekunden?|Minuten?))$/);
  await expect(comments.getByRole("button", { name: "Kommentar von Rita Reader gefällt mir (0 Likes)" })).toBeVisible();
  await checkpoint(reader, "post-in-german", { fullPage: false });

  // On a phone.
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.goto("/de/feedback/feature-requests");
  await expect(reader.getByRole("button", { name: "Neuer Beitrag" })).toBeVisible();
  // A board with no description of its own: the German one, under the board's own name.
  await expect(reader.locator('meta[name="description"]')).toHaveAttribute("content", "Stimme für die Ideen ab, die dir am wichtigsten sind, oder teile deine eigenen.");
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
