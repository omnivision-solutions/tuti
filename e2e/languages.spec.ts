import { randomUUID } from "node:crypto";

import type { Locator } from "@playwright/test";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { query } from "./db";
import { apiFor, createProject, newPerson, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";

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
  await expect(reader.getByText("Keine Artikel zu „zebra“", { exact: true })).toBeVisible();
  await expect(reader.getByRole("link", { name: "Alle Artikel" })).toBeVisible();

  // A collection: its articles' list.
  await reader.goto("/de/docs/basics");
  await expect(reader.getByRole("main").getByRole("list", { name: "Artikel" }).getByRole("link")).toHaveCount(2);
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
  await expect(reader.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Rechnungen" })).toHaveAttribute("lang", "de");
  await expect(reader.getByRole("navigation", { name: "Dokumentation" }).locator("[lang=de]", { hasText: "Rechnungen" })).toBeVisible();
  // That unlisted one: its collection not listed, its breadcrumb's link up is to its tab, Handbücher.
  await reader.goto(`/de/docs/${unlisted.slug}`);
  await expect(reader.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Handbücher" })).toHaveAttribute("lang", "de");
  // The tab not translated, locked for this reader: its page's heading in the team's English.
  await reader.goto("/de/docs/plans");
  await expect(reader.getByRole("heading", { level: 1 }).locator("[lang=en]")).toHaveText("Plans");
  // At the default language's address, the team's names.
  await reader.goto("/docs");
  await expect(reader.getByRole("list", { name: "Collections" }).getByRole("heading", { name: "Invoicing" })).toBeVisible();
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
