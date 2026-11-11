import { randomUUID } from "node:crypto";

import { expect, type Locator, type Page, type Response, test } from "@playwright/test";

import { seedAiConversations, seedViewsLastMonth } from "./articles";
import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl, SUPPORT_EMAIL_DOMAIN } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";
import { modelRequests, nextModelReply } from "./model";
import { similar } from "./openai";

/** A Docs page's search box (the one shown: the header's, or on the docs home its big one; or `where`'s): opens its dialog and types `query` in it. */
async function typeSearch(page: Page, query: string, where: Page | Locator = page) {
  await where.getByRole("button", { name: "Search or ask AI" }).click();
  const box = page.getByRole("dialog").getByRole("combobox", { name: "Search or ask AI" });
  await box.fill(query);
  return box;
}

/** Opens the docs' assistant as it was, from the search box shown (the header's, or the docs home's): the widget's, before anything's typed. */
async function openAssistant(page: Page) {
  await page.getByRole("button", { name: /^Search or ask AI/ }).click();
  await page.getByRole("dialog", { name: "Search or ask AI" }).getByRole("button", { name: "Open the assistant" }).click();
}

/** The articles a Docs page's search box (the one shown, or `where`'s) finds as `query` is typed, then closes it. */
async function foundAsTyped(page: Page, query: string, where: Page | Locator = page) {
  await typeSearch(page, query, where);
  // The first row asks the AI; the rest are the articles, once they've come.
  return page.getByRole("dialog").getByRole("listbox", { name: "Search results" });
}

test("the team writes a docs article in a collection, publishes it, and a visitor reads it", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  // The docs as a tree, beside every Docs page in the app.
  const teamTree = team.getByRole("navigation", { name: "Docs", exact: true });

  // A collection to put it in.
  await team.getByRole("link", { name: "Docs", exact: true }).click();
  await expect(team.getByText("No articles yet")).toBeVisible();
  // The portal's docs, in words beside the create button.
  await expect(team.getByRole("link", { name: "View on help center", exact: true }).first()).toHaveAttribute("href", `${portalUrl(slug)}/docs`);
  // The docs' home adds an article or a collection.
  await team.getByRole("button", { name: "Add content" }).click();
  await team.getByRole("menuitem", { name: "New collection" }).click();
  const dialog = team.getByRole("dialog", { name: "New collection" });
  await dialog.getByLabel("Name").fill("Getting started");
  await dialog.getByLabel("Description").fill("The basics, in five minutes.");
  // An icon, found by searching Lucide's names: the search box has focus, an arrow key reaches the icons, Enter picks one.
  await dialog.getByRole("button", { name: "Add icon" }).click();
  const picker = team.getByRole("dialog", { name: "Pick an icon" });
  await expect(picker.getByRole("searchbox", { name: "Search icons" })).toBeFocused();
  await expect(picker.getByRole("button").nth(47).locator("svg")).toBeVisible();
  await checkpoint(team, "team-docs-collection-icon-picker");
  // More come as the grid scrolls.
  const grid = picker.getByRole("group", { name: "Icons" });
  await expect(grid.getByRole("button")).toHaveCount(64);
  await grid.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(grid.getByRole("button")).toHaveCount(128);
  await team.keyboard.type("rocket");
  await expect(picker.getByRole("button", { name: "rocket", exact: true }).locator("svg")).toBeVisible();
  await team.keyboard.press("ArrowDown");
  await team.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(dialog.getByRole("button", { name: "Change icon (rocket)" })).toBeVisible();
  // Escape closes the picker, not the dialog.
  await dialog.getByRole("button", { name: "Change icon (rocket)" }).click();
  await expect(picker.getByRole("searchbox", { name: "Search icons" })).toBeFocused();
  await team.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  // "Remove icon", in the picker, takes it off.
  await dialog.getByRole("button", { name: "Change icon (rocket)" }).click();
  await picker.getByRole("button", { name: "Remove icon" }).click();
  await expect(dialog.getByRole("button", { name: "Add icon" })).toBeVisible();
  await dialog.getByRole("button", { name: "Add icon" }).click();
  await picker.getByRole("searchbox", { name: "Search icons" }).fill("rocket");
  await picker.getByRole("button", { name: "rocket", exact: true }).click();
  await dialog.getByRole("button", { name: "Add collection" }).click();
  await expect(team.getByText("Collection added")).toBeVisible();
  // The tree keeps the collection and its icon reachable beside the overview and collection page.
  await expect(teamTree.getByRole("link", { name: "Getting started", exact: true }).locator("svg.lucide-rocket")).toBeVisible();
  const treeAtHome = await teamTree.boundingBox();
  await checkpoint(team, "team-docs");
  await teamTree.getByRole("link", { name: "Getting started", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/collections/getting-started`);
  const treeHere = await teamTree.boundingBox();
  expect([treeHere!.x, treeHere!.y, treeHere!.width]).toEqual([treeAtHome!.x, treeAtHome!.y, treeAtHome!.width]);
  await expect(teamTree.getByRole("link", { name: "Getting started" }).locator("svg.lucide-rocket")).toBeVisible();

  // A draft: title, collection, a heading, text and a table.
  await team.goto(`/app/${slug}/docs`);
  await team.getByRole("button", { name: "Add content" }).click();
  await team.getByRole("menuitem", { name: "New article" }).click();
  // A refused save keeps what was typed.
  await team.getByLabel("Title").fill("Hi");
  await team.getByRole("button", { name: "Save draft" }).click();
  await expect(team.getByText("Title is too short")).toBeVisible();
  await expect(team.getByLabel("Title")).toHaveValue("Hi");
  await team.getByLabel("Title").fill("Inviting your team");
  // The article is its title and text; its collection is picked beside its Draft pill, and in Settings, a panel from
  // the top bar (with the rest of its place), saved with them.
  const placeLine = team.getByRole("combobox", { name: "In collection" });
  await expect(placeLine).toContainText("No collection");
  await expect(team.getByRole("checkbox", { name: /^Show the updated date/ })).toHaveCount(0);
  await team.getByRole("button", { name: "Settings" }).click();
  const newSettings = team.getByRole("dialog", { name: "Article settings" });
  await expect(newSettings).toHaveAttribute("data-side", "right");
  await expect(newSettings.getByRole("checkbox", { name: /^Show the updated date/ })).toBeChecked();
  await newSettings.getByRole("combobox", { name: "Collection" }).click();
  await team.getByRole("option", { name: "Getting started" }).click();
  await expect(newSettings.getByRole("combobox", { name: "Collection" })).toContainText("Getting started");
  await checkpoint(team, "team-docs-new-article-settings", { fullPage: false });
  await team.keyboard.press("Escape");
  await expect(newSettings).toBeHidden();
  // One place: the line beside the Draft pill says the same.
  await expect(placeLine).toContainText("Getting started");
  const editor = team.getByRole("textbox", { name: "Article" });
  // Set as it's published, with no box around it.
  await expect(editor).toHaveClass(/article-text/);
  await editor.click();
  // Blocks come from the / menu: picked with the mouse, or narrowed by typing and picked with Enter.
  const blocks = team.getByRole("listbox", { name: "Blocks" });
  await team.keyboard.type("/");
  await blocks.getByRole("option", { name: "Heading", exact: true }).click();
  await team.keyboard.type("Who can invite");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Owners and admins send invites from the Team page.");
  await team.keyboard.press("Enter");
  // The empty line says how.
  await expect(editor.locator("p.is-empty")).toHaveAttribute("data-placeholder", "Type / for headings, lists, tables and more");
  await team.keyboard.type("/head");
  await expect(blocks.getByRole("option")).toHaveText(["Heading", "Subheading"]);
  await checkpoint(team, "team-docs-article-blocks-menu");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Roles");
  await team.keyboard.press("Enter");
  // Escape closes the menu and leaves what was typed.
  await team.keyboard.type("/tab");
  await expect(blocks.getByRole("option")).toHaveText(["Table", "Code tabs", "Table of contents"]);
  await team.keyboard.press("Escape");
  await expect(blocks).toHaveCount(0);
  await team.keyboard.type("l");
  await expect(editor.getByText("/tabl", { exact: true })).toBeVisible();
  await expect(blocks).toHaveCount(0);
  for (let i = 0; i < "/tabl".length; i++) {
    await team.keyboard.press("Backspace");
  }
  await team.keyboard.type("/tab");
  await team.keyboard.press("Enter");
  for (const cell of ["Role", "Can invite", "", "Admin", "Yes"]) {
    await team.keyboard.type(cell);
    await team.keyboard.press("Tab");
  }
  await checkpoint(team, "team-docs-article-draft");
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/docs/inviting-your-team`);
  await expect(team.locator('[data-slot="docs-page-header"]').getByText("Draft", { exact: true })).toBeVisible();
  // The page's heading is its title, for screen readers: the form's title field shows it, once.
  await expect(team.getByRole("heading", { level: 1, name: "Inviting your team" })).toHaveCount(1);
  await expect(team.getByRole("textbox", { name: "Title" })).toHaveValue("Inviting your team");
  // The article is the Docs': the sidebar keeps Docs marked on its page.
  await expect(team.locator('[data-slot="sidebar"][data-state]').getByRole("link", { name: "Docs", exact: true })).toHaveAttribute("data-active");

  // Visitors don't see it yet.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs/inviting-your-team");
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toHaveCount(0);
  expect((await visitor.request.get(`${portalUrl(slug)}/docs/inviting-your-team.md`)).status()).toBe(404);
  await visitor.goto("/docs");
  await expect(visitor.getByText("Nothing here yet")).toBeVisible();

  await team.getByRole("button", { name: "Publish" }).click();
  const confirm = team.getByRole("alertdialog");
  await expect(confirm).toContainText("search engines can find it");
  await confirm.getByRole("button", { name: "Publish" }).click();
  await expect(team.getByText("Published", { exact: true }).first()).toBeVisible();
  // Unpublish is behind "More actions", with Delete.
  await team.getByRole("button", { name: "More actions" }).click();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();
  await team.keyboard.press("Escape");
  await expect(team.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
  await checkpoint(team, "team-docs-article-published");

  // The visitor finds its collection's card on the Docs tab, and reads it there.
  const scripts: Promise<string>[] = [];
  const recordScript = (response: Response) => {
    if (response.request().resourceType() === "script") {
      scripts.push(response.text());
    }
  };
  visitor.on("response", recordScript);
  await visitor.goto("/");
  await visitor.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Docs" }).click();
  const card = visitor.getByRole("list", { name: "Collections" }).getByRole("link", { name: /^Getting started/ });
  await expect(card).toContainText("The basics, in five minutes.");
  // With its icon, drawn on the server: no script the portal sends has Lucide's names (the app's picker loads them).
  await expect(card.locator("svg.lucide-rocket")).toBeVisible();
  visitor.off("response", recordScript);
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of await Promise.all(scripts)) {
    expect(script).not.toContain("a-arrow-down");
  }
  await checkpoint(visitor, "portal-docs");
  await card.click();
  await visitor.waitForURL(/\/docs\/getting-started$/);
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Getting started");
  await visitor.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Inviting your team" }).click();
  await visitor.waitForURL(/\/docs\/inviting-your-team$/);
  const article = visitor.getByRole("article", { name: "Inviting your team" });
  await expect(article.getByRole("heading", { name: "Who can invite", level: 2 })).toBeVisible();
  await expect(article.getByRole("columnheader", { name: "Can invite" })).toBeVisible();
  await expect(article.getByRole("cell", { name: "Admin" })).toBeVisible();
  // Search engines get its own title and description.
  await expect(visitor).toHaveTitle("Inviting your team · Acme");
  await expect(visitor.locator('meta[name="description"]')).toHaveAttribute("content", /^Who can invite Owners and admins send invites/);
  // Beside it, the docs as a tree with the article marked, and its sections ("On this page").
  const tree = visitor.getByRole("navigation", { name: "Docs", exact: true });
  await expect(tree.getByRole("link", { name: "Getting started" }).locator("svg.lucide-rocket")).toBeVisible();
  await expect(tree.getByRole("link", { name: "Inviting your team" })).toHaveAttribute("aria-current", "page");
  const onThisPage = visitor.getByRole("navigation", { name: "On this page" });
  await expect(onThisPage.getByRole("link")).toHaveText(["Who can invite", "Roles"]);
  // How long it takes to read, under the title.
  await expect(article).toContainText("1 min read");
  // "Was this helpful?" at the article's end (not beside it); above the title, the level above: the collection it's in.
  await expect(visitor.locator("aside", { has: onThisPage }).getByRole("region", { name: "Was this helpful?" })).toHaveCount(0);
  await expect(article.getByRole("region", { name: "Was this helpful?" })).toBeVisible();
  await expect(article.getByRole("link", { name: "Getting started" })).toHaveAttribute("href", "/docs/getting-started");
  await checkpoint(visitor, "portal-docs-article");
  await onThisPage.getByRole("link", { name: "Roles" }).click();
  await visitor.waitForURL(/\/docs\/inviting-your-team#roles$/);
  await expect(article.getByRole("heading", { name: "Roles", level: 2 })).toBeInViewport();
  // The section being read is marked.
  await expect(onThisPage.getByRole("link", { name: "Roles" })).toHaveAttribute("aria-current", "location");
  // The header stays at the top, and the heading picked shows below it, not under it.
  const banner = visitor.getByRole("banner");
  await expect(banner).toBeInViewport();
  const { y, height } = (await banner.boundingBox())!;
  const headerBottom = y + height;
  expect((await article.getByRole("heading", { name: "Roles", level: 2 }).boundingBox())!.y).toBeGreaterThanOrEqual(headerBottom);
  // The tree's names are on one line, cut short when they're long: in full on hover.
  await expect(tree.getByRole("link", { name: "Inviting your team" })).toHaveAttribute("title", "Inviting your team");
  // Picking another section marks that one, wherever the page could scroll it.
  await onThisPage.getByRole("link", { name: "Who can invite" }).click();
  await expect(onThisPage.getByRole("link", { name: "Who can invite" })).toHaveAttribute("aria-current", "location");
  // The footer is under the page, beside the tree's column: under that column, it would push the tree up as it came into view.
  const treeColumn = (await visitor.locator("aside", { has: tree }).boundingBox())!;
  expect((await visitor.getByRole("contentinfo").boundingBox())!.y).toBeLessThan(treeColumn.y + treeColumn.height);

  // On a phone the tree is in the header's menu, the search is an icon, and "On this page" is left out.
  await visitor.setViewportSize({ width: 390, height: 844 });
  await expect(onThisPage).toBeHidden();
  await expect(tree).toBeHidden();
  // "Was this helpful?" is under the article there.
  await expect(article.getByRole("region", { name: "Was this helpful?" })).toBeVisible();
  // The page's actions under the title, only as wide as their buttons.
  const copyPage = visitor.getByRole("button", { name: "Copy page" });
  const actionsWidth = await copyPage.locator("..").evaluate((group) => group.getBoundingClientRect().width);
  expect(actionsWidth).toBeLessThan(200);
  await checkpoint(visitor, "portal-docs-article-phone", { fullPage: false });
  await visitor.getByRole("banner").getByRole("button", { name: "Menu" }).click();
  const menu = visitor.getByRole("dialog", { name: "Menu" });
  await expect(menu.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Inviting your team" })).toHaveAttribute("aria-current", "page");
  await checkpoint(visitor, "portal-docs-article-phone-menu", { fullPage: false });
  // Opening a page from it closes it.
  await menu.getByRole("link", { name: "Inviting your team" }).click();
  await expect(menu).toBeHidden();
  await visitor.setViewportSize({ width: 1280, height: 720 });
  await expect(visitor.getByRole("banner").getByRole("button", { name: "Menu" })).toBeHidden();

  // AI tools get it as Markdown: at its .md URL, copied, or opened in ChatGPT or Claude with that URL.
  const markdownUrl = `${portalUrl(slug)}/docs/inviting-your-team.md`;
  const markdown = await visitor.request.get(markdownUrl);
  expect(markdown.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  expect(await markdown.text()).toBe(
    "# Inviting your team\n\n## Who can invite\n\nOwners and admins send invites from the Team page.\n\n## Roles\n\n" +
      "| Role | Can invite |  |\n| --- | --- | --- |\n| Admin | Yes |  |\n|  |  |  |\n",
  );
  // The page's actions: its menu takes it to an AI tool, or to its Markdown.
  const prompt = encodeURIComponent(`Read ${markdownUrl} and answer questions about it.`);
  await visitor.getByRole("button", { name: "More page actions" }).click();
  // Each a name alone, no line explaining it.
  await expect(visitor.getByRole("menuitem", { name: "Open in ChatGPT", exact: true })).toHaveAttribute("href", `https://chatgpt.com/?q=${prompt}`);
  await expect(visitor.getByRole("menuitem", { name: "Open in Claude", exact: true })).toHaveAttribute("href", `https://claude.ai/new?q=${prompt}`);
  await expect(visitor.getByRole("menuitem", { name: "View as Markdown", exact: true })).toHaveAttribute("href", markdownUrl);
  await checkpoint(visitor, "portal-docs-article-actions", { fullPage: false });
  await visitor.keyboard.press("Escape");
  await visitor.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await visitor.getByRole("button", { name: "Copy page" }).click();
  await expect(visitor.getByText("Copied as Markdown")).toBeVisible();
  expect(await visitor.evaluate(() => navigator.clipboard.readText())).toBe(await markdown.text());
  await checkpoint(visitor, "portal-docs-article-copied");

  // Search (in the header, on every Docs page): results as they type, the words still being typed included,
  // with the passage that matched (one line) and those words marked.
  const searchButton = visitor.getByRole("banner").getByRole("button", { name: "Search or ask AI" });
  await expect(searchButton).toHaveText(/Search or ask AI/);
  const box = await typeSearch(visitor, "send inv");
  const asTyped = visitor.getByRole("dialog").getByRole("listbox", { name: "Search results" });
  await expect(asTyped.getByRole("option")).toHaveText([/Ask AI:\s*send inv/, /Inviting your team.*Owners and admins send invites from the Team page/]);
  // Whole words marked ("invites" for "inv"), not just the letters typed.
  const marked = asTyped.getByRole("option").nth(1).locator("mark");
  await expect(marked.filter({ hasText: /^send$/ })).toHaveCount(1);
  await expect(marked.filter({ hasText: /^invites$/i }).first()).toBeVisible();
  await expect(marked.filter({ hasText: /^(?!send$|invites?$).*/i })).toHaveCount(0);
  await checkpoint(visitor, "portal-docs-search-as-typed", { fullPage: false });
  await visitor.setViewportSize({ width: 390, height: 844 });
  // Each result's passage on one line, on a phone too.
  const passage = asTyped.getByRole("option").nth(1).locator("mark").first().locator("..");
  await expect(passage).toHaveCSS("-webkit-line-clamp", "1");
  await checkpoint(visitor, "portal-docs-search-as-typed-phone", { fullPage: false });
  await visitor.setViewportSize({ width: 1280, height: 720 });
  // Arrow down and Enter opens it.
  await box.press("ArrowDown");
  await expect(asTyped.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await box.press("Enter");
  await visitor.waitForURL(/\/docs\/inviting-your-team$/);
  // A search that fails (offline, the server down) says so, rather than finding nothing or loading forever.
  await visitor.route("**/*", (route) => (route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.fallback()));
  await typeSearch(visitor, "invites");
  await expect(visitor.getByRole("dialog").getByRole("alert")).toHaveText("Couldn't search just now. Keep typing to try again.");
  await visitor.unroute("**/*");
  await visitor.keyboard.press("Escape");
  // ⌘K (Ctrl K off a Mac, as the box says: the Desktop Chrome preset's browser says it's on Windows) opens it too;
  // Escape closes it.
  await expect(searchButton.locator("kbd")).toHaveText("Ctrl K");
  await visitor.keyboard.press("ControlOrMeta+k");
  // Named for what it does, like the box: with AI answers on, it asks too.
  await expect(visitor.getByRole("dialog", { name: "Search or ask AI" }).getByRole("combobox", { name: "Search or ask AI" })).toBeFocused();
  await visitor.keyboard.press("Escape");
  await expect(visitor.getByRole("dialog")).toBeHidden();
  // A link to all the results (/docs?q=): the box starts from it.
  await visitor.goto("/docs?q=send+invites");
  await expect(searchButton).toHaveText(/send invites/);
  await expect(searchButton).toHaveAccessibleName("Search or ask AI: send invites");
  const results = visitor.getByRole("list", { name: "Search results" });
  await expect(results.getByRole("link", { name: "Inviting your team" })).toBeVisible();
  await expect(results).toContainText("Owners and admins send invites from the Team page.");
  await checkpoint(visitor, "portal-docs-search");
  await typeSearch(visitor, "refunds");
  await expect(visitor.getByRole("dialog").getByText("No articles match “refunds”.")).toBeVisible();
  // The Enter that ends composing a word with an input method (Japanese, Chinese…) is the reader's: nothing opens.
  await visitor.getByRole("dialog").getByRole("combobox", { name: "Search or ask AI" }).dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  await expect(visitor.getByRole("dialog").getByRole("combobox", { name: "Search or ask AI" })).toBeVisible();
  await expect(visitor).toHaveURL(/\/docs\?q=send\+invites$/);
  // Closed, it counts as a search (one that found nothing); so does the results page for it.
  await visitor.keyboard.press("Escape");
  await visitor.goto("/docs?q=refunds");
  await expect(visitor.getByText("No articles match “refunds”")).toBeVisible();
  await checkpoint(visitor, "portal-docs-search-empty");
  await visitor.getByRole("link", { name: "All articles" }).click();
  await visitor.getByRole("list", { name: "Collections" }).getByRole("link", { name: /^Getting started/ }).click();

  // The visitor (signed out) says the article didn't help, and what was missing.
  await visitor.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Inviting your team" }).click();
  const helpful = visitor.getByRole("region", { name: "Was this helpful?" });
  await helpful.getByRole("button", { name: "No" }).click();
  await helpful.getByLabel("What were you looking for? (optional)").fill("How do I invite by email?");
  await checkpoint(visitor, "portal-docs-article-feedback");
  await helpful.getByRole("button", { name: "Send" }).click();
  await expect(helpful.getByText("Thanks for letting us know.")).toBeVisible();

  // The team sees it in the docs' insights, with the article's views and the search that found nothing
  // (and the one picked from the search box: what they typed counts once they've picked).
  await team.getByRole("link", { name: "Docs", exact: true }).first().click();
  await team.waitForURL(`**/app/${slug}/docs`);
  // The list says how often each article was read lately; what readers did is in Reporting.
  await expect(team.getByRole("region", { name: "At a glance" })).toContainText("2Views");
  await checkpoint(team, "team-docs-list-views");
  await expect(team.getByRole("navigation", { name: "Docs sections" })).toHaveCount(0);
  // A view in the 30 days before Reporting's: each number says how it changed on them (the article's 2 views now, 1 then).
  await seedViewsLastMonth(slug, "inviting-your-team", 1);
  await team.getByRole("link", { name: "Reporting", exact: true }).first().click();
  await team.waitForURL(`**/app/${slug}/reporting`);
  const reporting = team.getByRole("navigation", { name: "Reporting" });
  await expect(reporting.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  const stat = (label: string) => team.getByRole("group", { name: label, exact: true });
  await expect(stat("Article views")).toContainText("2");
  await expect(stat("Article views").getByText("Up 100% on the 30 days before")).toBeAttached();
  await expect(stat("Article views")).toContainText("100%");
  await expect(team.getByText("Changes are on the 30 days before.")).toBeVisible();
  await expect(stat("Searches")).toContainText("4");
  await expect(stat("Searches that found nothing")).toContainText("2");
  await expect(team.getByRole("list", { name: "Most read articles" })).toContainText("Inviting your team");
  // A bar shows its numbers on hover, or with focus (or a tap on a phone), and is read as them. The chart is one Tab stop, the
  // latest bar; ← → move between the bars.
  const bars = team.getByRole("list", { name: "Article views by day" }).getByRole("listitem");
  await stat("Found it helpful").getByRole("link").focus();
  await team.keyboard.press("Tab");
  await expect(bars.last()).toBeFocused();
  // Which day holds the views is the clock's (a run can cross midnight): the database tests check the days' numbers.
  // Today's bar is a day under way: said so.
  await expect(bars.last()).toHaveAccessibleName(/ \(so far\): Article views \d+$/);
  await expect(bars.last().getByText(/^Article views: \d+$/)).toBeVisible();
  await team.keyboard.press("ArrowLeft");
  await expect(bars.nth(-2)).toBeFocused();
  await expect(bars.nth(-2)).toHaveAccessibleName(/: Article views \d+$/);
  await team.keyboard.press("Tab");
  await expect(team.getByRole("link", { name: "All articles" })).toBeFocused();
  await checkpoint(team, "team-reporting-overview");
  // Moved to the first bar, then another range: its chart's one Tab stop is its latest bar again, not where the last one was left.
  await bars.last().focus();
  await team.keyboard.press("Home");
  await expect(bars.first()).toBeFocused();
  const rangeButton = team.getByRole("button", { name: /^Date range: / });
  const width = (await rangeButton.boundingBox())!.width;
  await team.getByRole("button", { name: "Date range: Past 30 days" }).click();
  // Each range says its days, in groups: a day, a month, the past days.
  await expect(team.getByRole("menuitem", { name: "Last month" })).toHaveText(/^Last month[A-Z][a-z]{2} 1\s–\s(28|29|30|31)$/);
  await expect(team.getByRole("menu").getByRole("separator")).toHaveCount(2);
  await team.getByRole("menuitem", { name: "Past 7 days" }).click();
  await team.waitForURL(`**/app/${slug}/reporting?range=7d`);
  await expect(bars).toHaveCount(7);
  // The button keeps its width whatever the range's name.
  expect((await rangeButton.boundingBox())!.width).toBe(width);
  // On a tablet, a long title keeps its room beside the picker, whatever the range's dates.
  await team.setViewportSize({ width: 768, height: 1024 });
  await team.goto(`/app/${slug}/reporting/ai-conversations?range=year`);
  // The title's text ends before the picker starts: the dates beside the button wait for a laptop's width.
  // The sidebar animates to its rail at this width; measure once that layout has settled.
  await expect.poll(async () => {
    const titleRight = await team.getByRole("heading", { name: "AI conversations", level: 2 }).evaluate((heading) => {
      const text = document.createRange();
      text.selectNodeContents(heading);
      return text.getBoundingClientRect().right;
    });
    return titleRight - (await rangeButton.boundingBox())!.x;
  }).toBeLessThanOrEqual(0);
  await expect(team.getByText(/\d{4}\s–\s/)).toBeHidden();
  // On a phone, a title with a long word has the picker under it rather than over it.
  await team.setViewportSize({ width: 375, height: 812 });
  await team.goto(`/app/${slug}/reporting/inbox`);
  const inboxTitle = team.getByRole("heading", { name: "Conversations", level: 2 });
  const [titleBox, pickerBox] = [(await inboxTitle.boundingBox())!, (await rangeButton.boundingBox())!];
  const apart = pickerBox.y >= titleBox.y + titleBox.height || pickerBox.x >= titleBox.x + (await inboxTitle.evaluate((heading) => {
    const text = document.createRange();
    text.selectNodeContents(heading);
    return text.getBoundingClientRect().width;
  }));
  expect(apart).toBe(true);
  await team.setViewportSize({ width: 1280, height: 720 });
  await team.goto(`/app/${slug}/reporting?range=7d`);
  await stat("Found it helpful").getByRole("link").focus();
  await team.keyboard.press("Tab");
  await expect(bars.last()).toBeFocused();
  await team.keyboard.press("Tab");
  await expect(team.getByRole("link", { name: "All articles" })).toBeFocused();
  // Keyboard focus stays on its bar whatever the mouse does.
  await bars.last().focus();
  await team.keyboard.press("ArrowLeft");
  await bars.nth(-2).hover();
  await bars.last().hover();
  await expect(bars.nth(-2)).toBeFocused();
  // A bar clicked, then another hovered: one bar's numbers show, the hovered one's.
  await bars.first().click();
  await bars.last().hover();
  await expect(bars.last().getByText(/^Article views: \d+$/)).toBeVisible();
  await expect(bars.first().getByText(/^Article views: /)).toBeHidden();
  // A range from the picker beside the title, which the menu's pages keep.
  await team.getByRole("button", { name: "Date range: Past 7 days" }).click();
  await team.getByRole("menuitem", { name: "Yesterday" }).click();
  await team.waitForURL(`**/app/${slug}/reporting?range=yesterday`);
  await expect(reporting.getByRole("link", { name: "Articles" })).toHaveAttribute("href", `/app/${slug}/reporting/articles?range=yesterday`);
  // A single day has its numbers and no chart.
  await expect(stat("Article views")).toBeVisible();
  await expect(team.getByRole("list", { name: /^Article views by/ })).toHaveCount(0);
  await team.getByRole("button", { name: "Date range: Yesterday" }).click();
  await team.getByRole("menuitem", { name: "Past 30 days" }).click();
  await team.waitForURL(`**/app/${slug}/reporting`);
  await reporting.getByRole("link", { name: "Articles" }).click();
  await team.waitForURL(`**/app/${slug}/reporting/articles`);
  const row = team.getByRole("table", { name: "All articles" }).getByRole("row").filter({ hasText: "Inviting your team" });
  await expect(row.getByRole("cell")).toHaveText([/Inviting your team/, "2", "0%", "0", "1"]);
  await reporting.getByRole("link", { name: "Feedback" }).click();
  await team.waitForURL(`**/app/${slug}/reporting/feedback`);
  await expect(team.getByRole("list", { name: "What readers missed" })).toContainText("How do I invite by email?");
  await reporting.getByRole("link", { name: "Searches" }).click();
  await team.waitForURL(`**/app/${slug}/reporting/searches`);
  const failed = team.getByRole("list", { name: "Searches that found nothing" }).getByRole("listitem").filter({ hasText: "refunds" });
  await expect(failed).toContainText("2 searches");
  await checkpoint(team, "team-reporting-searches");
  // On a phone (in dark mode) the menu folds above the page.
  await team.setViewportSize({ width: 390, height: 844 });
  await team.emulateMedia({ colorScheme: "dark" });
  await expect(team.locator("summary").filter({ hasText: "Searches" })).toBeVisible();
  await checkpoint(team, "team-reporting-searches-phone-dark");
  await team.setViewportSize({ width: 1280, height: 720 });
  await team.emulateMedia({ colorScheme: "light" });
});

test("the team reviews article history, changes visibility and restores a deleted article", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  // Start with an independently published article: writing and reader reporting have their own journey.
  const api = await apiFor(team, slug);
  await api("/collections", { name: "Getting started", description: "The basics, in five minutes." });
  await api("/articles", {
    title: "Inviting your team", collection: "getting-started",
    content: { type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Who can invite" }] },
      { type: "paragraph", content: [{ type: "text", text: "Owners and admins send invites from the Team page." }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Roles" }] },
      { type: "paragraph", content: [{ type: "text", text: "Admins can invite teammates." }] },
    ] },
  });
  await api("/articles/inviting-your-team/publish", {});
  const teamTree = team.getByRole("navigation", { name: "Docs", exact: true });
  const editor = team.getByRole("textbox", { name: "Article" });
  const visitor = await newPerson(browser, portalUrl(slug));
  const article = visitor.getByRole("article", { name: "Inviting your team" });

  // Deleting the collection, from its page, keeps its article. While it runs (slowed down here), Delete can't be clicked again.
  await team.goto(`/app/${slug}/docs`);
  await team.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Getting started", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/collections/getting-started`);
  await expect(team.getByRole("region", { name: "Getting started" }).getByRole("listitem")).toHaveText([/^Inviting your team/, "New articleNew collection"]);
  await team.route("**/*", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });
  // Delete is behind the top bar's "More actions".
  await team.getByRole("button", { name: "More actions" }).click();
  await team.getByRole("button", { name: "Delete" }).click();
  const deleting = team.getByRole("alertdialog");
  await expect(deleting).toContainText("Its articles stay, without a collection.");
  await deleting.getByRole("button", { name: "Delete" }).click();
  await expect(deleting.getByRole("button", { name: "Delete" })).toBeDisabled();
  await expect(deleting.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(team.getByText("Getting started deleted")).toBeVisible();
  // Its page is gone: the Docs home instead.
  await team.waitForURL(`**/app/${slug}/docs`);
  await team.unroute("**/*");
  await expect(team.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Inviting your team" })).toBeVisible();
  await visitor.goto("/docs");
  // In the home's articles in no collection (one article read is too few for Popular articles); no card for the collection.
  await expect(visitor.getByRole("main").getByRole("link", { name: "Inviting your team" })).toHaveCount(1);
  await expect(visitor.getByRole("main").getByRole("link", { name: /^Getting started/ })).toHaveCount(0);
  // In no collection now, the level above it is all of them.
  await visitor.goto("/docs/inviting-your-team");
  await expect(article.getByRole("link", { name: "All collections" })).toHaveAttribute("href", "/docs");
  // So is it for an article whose collection has no page for readers: an unlisted article is all that's in it.
  await api("/collections", { name: "Hidden away" });
  const unlisted = await api("/articles", { title: "Only by link", body: "Here.", collection: "hidden-away", listing: "unlisted" });
  await api(`/articles/${unlisted.slug}/publish`, {});
  await visitor.goto(`/docs/${unlisted.slug}`);
  await expect(visitor.getByRole("article", { name: "Only by link" }).getByRole("link", { name: "All collections" })).toHaveAttribute("href", "/docs");
  await team.goto(`/app/${slug}/docs`);

  // The team edits it twice. It's published, so the edits wait as unpublished changes until the team publishes them.
  await team.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Inviting your team" }).click();
  await team.waitForURL(`**/app/${slug}/docs/inviting-your-team`);
  const paragraph = editor.locator("p", { hasText: "Owners and admins send invites" });
  for (const sentence of [" Members can ask them.", " Invites last a week."]) {
    // The caret goes to the paragraph's end: a click on its last character's right half (End only
    // reaches the end of a visual line, and a selection set from a script may reach the editor late).
    const end = await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const last = [...range.getClientRects()].at(-1)!;
      return { x: last.right - 1, y: last.top + last.height / 2 };
    });
    await team.mouse.click(end.x, end.y);
    await team.keyboard.type(sentence);
    // Done once the save's response is in (a toast from the first save may still be showing at the second).
    const saved = team.waitForResponse((response) => response.request().headers()["next-action"] !== undefined);
    const before = await editor.elementHandle();
    await team.getByRole("button", { name: /^(Save|Saved|Saving…)$/ }).click();
    await saved;
    // The saved article comes back as a new form (it's keyed on the content), maybe a moment after
    // the save's response: edit that one, not the old editor on its way out.
    await expect.poll(() => before!.evaluate((element) => element.isConnected)).toBe(false);
    await expect(team.getByRole("button", { name: /^(Save|Saved|Saving…)$/ })).toBeEnabled();
  }
  await expect(team.getByText("Saved", { exact: true }).first()).toBeVisible();
  const original = "Owners and admins send invites from the Team page.";
  const edited = `${original} Members can ask them. Invites last a week.`;
  const unpublished = team.getByRole("region", { name: "Unpublished changes" });
  await expect(team.getByRole("button", { name: "Manage unpublished changes" })).toBeVisible();
  await checkpoint(team, "team-docs-article-unpublished-changes");
  await visitor.goto("/docs/inviting-your-team");
  await expect(visitor.getByText(original, { exact: true })).toBeVisible();
  await expect(visitor.getByText(/Members can ask them/)).toHaveCount(0);

  // Reviewed against the published version, then published.
  await team.getByRole("button", { name: "Manage unpublished changes" }).click();
  await team.getByRole("button", { name: "Review changes", exact: true }).click();
  const review = team.getByRole("dialog", { name: "Review changes" });
  await expect(review.getByRole("deletion")).toHaveText(original);
  await expect(review.getByRole("insertion")).toHaveText(edited);
  // Formatted as readers see it: the unchanged heading is still a heading.
  await expect(review.getByRole("heading", { name: "Who can invite", level: 2 })).toBeVisible();
  await checkpoint(team, "team-docs-article-review-changes", { fullPage: false });
  await review.getByRole("button", { name: "Publish changes" }).click();
  await expect(team.getByText("Changes published")).toBeVisible();
  await expect(unpublished).toHaveCount(0);
  await visitor.goto("/docs/inviting-your-team");
  await expect(visitor.getByText(edited, { exact: true })).toBeVisible();
  // Changed since it was published, so readers see when.
  await expect(visitor.getByText(/^Updated \d+ \w+ \d{4}$/)).toBeVisible();
  await checkpoint(visitor, "portal-docs-article-updated");

  // Its history (an icon in the top bar), in a panel from the right over the article, shows what changed since the first version.
  await team.getByRole("button", { name: "History", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/inviting-your-team?history`);
  const historyPanel = team.getByRole("complementary", { name: "Article tools" });
  await expect(historyPanel).toHaveCSS("width", "330px");
  const versions = historyPanel.getByRole("link", { name: /^Saved / });
  await expect(versions).toHaveCount(3);
  await versions.nth(2).click();
  await team.waitForURL(/\/inviting-your-team\?history&revision=/);
  const changes = team.getByRole("region", { name: "Changes since this version" });
  await expect(changes.getByRole("deletion")).toHaveText(original);
  await expect(changes.getByRole("insertion")).toHaveText(edited);
  await checkpoint(team, "team-docs-article-history");

  // Restoring it is a save like any other (a new version): unpublished changes, which the team discards.
  await changes.getByRole("button", { name: "Restore this version" }).click();
  const restoring = team.getByRole("alertdialog");
  await expect(restoring).toContainText("readers see it once you publish them");
  await checkpoint(team, "team-docs-article-restore-confirm", { fullPage: false });
  await restoring.getByRole("button", { name: "Restore" }).click();
  await expect(team.getByText("Version restored")).toBeVisible();
  await team.waitForURL(`**/app/${slug}/docs/inviting-your-team`);
  await team.getByRole("button", { name: "Manage unpublished changes" }).click();
  await team.getByRole("button", { name: "Discard changes", exact: true }).click();
  const discarding = team.getByRole("alertdialog");
  await expect(discarding).toContainText("The changes stay in its history");
  await discarding.getByRole("button", { name: "Discard changes" }).click();
  await expect(team.getByText("Changes discarded")).toBeVisible();
  await expect(unpublished).toHaveCount(0);
  await expect(editor).toContainText(edited);
  await team.getByRole("button", { name: "History", exact: true }).click();
  await expect(historyPanel.getByRole("link", { name: /^Saved / })).toHaveCount(5);
  // Closing it leaves the article where it was; its old address opens it too.
  await team.keyboard.press("Escape");
  await team.waitForURL(`**/app/${slug}/docs/inviting-your-team`);
  await expect(historyPanel).toHaveCount(0);
  await expect(editor).toContainText(edited);
  await team.goto(`/app/${slug}/docs/inviting-your-team/history`);
  await team.waitForURL(`**/app/${slug}/docs/inviting-your-team?history`);
  await expect(historyPanel.getByRole("link", { name: /^Saved / })).toHaveCount(5);
  await historyPanel.getByRole("button", { name: "Collapse article tools" }).click();
  await team.waitForURL(`**/app/${slug}/docs/inviting-your-team`);

  // Listing: unlisted, it's gone from /docs but its link still works; hidden, its page is a 404.
  await teamTree.getByRole("link", { name: "Inviting your team" }).click();
  await team.waitForURL(`**/app/${slug}/docs/inviting-your-team`);
  // The page header's line under the title.
  const header = team.locator('[data-slot="docs-page-header"]');
  // In the article's settings, with what each listing means under it.
  const articleSettings = team.getByRole("region", { name: "Article settings" });
  const setListing = async (name: string, description: string, shot?: string) => {
    await team.getByRole("button", { name: "Settings" }).click();
    await articleSettings.getByLabel("Listed in").click();
    if (shot) {
      await checkpoint(team, shot, { fullPage: false });
    }
    await team.getByRole("option", { name }).click();
    await expect(articleSettings.getByText(description)).toBeVisible();
    await articleSettings.getByRole("button", { name: "Save changes" }).click();
    await expect(articleSettings).toBeHidden();
  };
  await setListing("Unlisted", "Anyone with the link can read it, but it's in no list or search. AI answers can cite it.", "team-docs-article-listing");
  // A listing goes live at once: it's no unpublished change.
  await expect(unpublished).toHaveCount(0);
  await expect(header).toContainText("Unlisted");
  await checkpoint(team, "team-docs-article-unlisted");
  await visitor.goto("/docs");
  await expect(visitor.getByText("Nothing here yet")).toBeVisible();
  await visitor.goto("/docs/inviting-your-team");
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toBeVisible();

  await setListing("Hidden", "Stays published, but isn't shown anywhere, not even at its link.");
  await expect(header).toContainText("Hidden");
  await checkpoint(team, "team-docs-article-hidden");
  expect((await visitor.goto("/docs/inviting-your-team"))!.status()).toBe(404);
  expect((await visitor.request.get(`${portalUrl(slug)}/docs/inviting-your-team.md`)).status()).toBe(404);

  await setListing("Everywhere", "In your docs, search, the widget and AI answers.");
  await visitor.goto("/docs");
  // Listed again: in the articles in no collection.
  await expect(visitor.getByRole("main").getByRole("link", { name: "Inviting your team" })).toHaveCount(1);

  // "Show the updated date", unticked in Settings and saved there: readers no longer see when it changed.
  await visitor.goto("/docs/inviting-your-team");
  await expect(visitor.getByText(/^Updated \d+ \w+ \d{4}$/)).toBeVisible();
  await team.getByRole("button", { name: "Settings" }).click();
  await articleSettings.getByRole("checkbox", { name: /^Show the updated date/ }).uncheck();
  await articleSettings.getByRole("button", { name: "Save changes" }).click();
  // (An earlier save's toast may still be up.)
  await expect(team.getByText("Settings saved").first()).toBeVisible();
  await expect(articleSettings).toBeHidden();
  await expect(unpublished).toHaveCount(0);
  await visitor.reload();
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toBeVisible();
  await expect(visitor.getByText(/^Updated /)).toHaveCount(0);
  await team.getByRole("button", { name: "Settings" }).click();
  await expect(articleSettings.getByRole("checkbox", { name: /^Show the updated date/ })).not.toBeChecked();
  await team.keyboard.press("Escape");

  // Deleted, it leaves the portal; the team brings it back from Recently deleted, as a draft.
  await team.getByRole("button", { name: "More actions" }).click();
  await team.getByRole("button", { name: "Delete" }).click();
  const deletingArticle = team.getByRole("alertdialog");
  await expect(deletingArticle).toContainText("You can restore it from Recently deleted for 30 days.");
  await deletingArticle.getByRole("button", { name: "Delete" }).click();
  await team.waitForURL(`**/app/${slug}/docs`);
  const recentlyDeleted = team.getByRole("region", { name: "Recently deleted" });
  await expect(recentlyDeleted).toBeHidden();
  await team.getByRole("link", { name: /^Recently deleted/ }).click();
  await expect(recentlyDeleted).toContainText("Inviting your team");
  await checkpoint(team, "team-docs-recently-deleted");
  // Docs has no filter of its own: ⌘K finds articles by name, anywhere in the app.
  await expect(team.getByRole("searchbox", { name: "Filter docs" })).toHaveCount(0);
  await visitor.goto("/docs/inviting-your-team");
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toHaveCount(0);

  // From the keyboard: at the bottom of the page, the button can be under a toast, which waits while the pointer is over it.
  await recentlyDeleted.getByRole("button", { name: "Restore “Inviting your team”" }).press("Enter");
  await expect(team.getByText("Restored “Inviting your team” as a draft")).toBeVisible();
  await expect(team.getByRole("region", { name: "Recently deleted" })).toHaveCount(0);
  // A draft again, in no collection now.
  await team.getByRole("region", { name: /Waiting to publish/ }).getByRole("link", { name: "Inviting your team", exact: true }).click();
  await expect(team.locator(".docs-editor-state")).toContainText("Draft");
  await checkpoint(team, "team-docs-article-restored");
});

test("the team arranges the docs: collections three levels deep, moves with the keyboard and by dragging, and the portal and widget follow", async ({
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  for (const name of ["Getting started", "Billing"]) {
    await api("/collections", { name });
  }
  // Card payments was "Payments" while it was a draft: its first URL will redirect.
  await api("/articles", { title: "Payments", body: "Card payments.", collection: "billing" });
  await api("/articles/payments", { title: "Card payments" }, "PATCH");
  await api("/articles/card-payments/publish", {});
  await api("/collections", { name: "Taxes" });
  for (const [title, collection] of [
    ["Inviting your team", "getting-started"],
    ["Your first board", "getting-started"],
    ["Downloading invoices", "billing"],
    ["VAT rates", "taxes"],
  ]) {
    const article = await api("/articles", { title, body: `${title}.`, collection });
    await api(`/articles/${article.slug}/publish`, {});
  }

  // A collection in Billing, from Billing's "+" in the tree (beside a collection's page).
  await team.goto(`/app/${slug}/docs/collections/getting-started`);
  const structure = team.getByRole("navigation", { name: "Docs", exact: true });
  await structure.getByRole("button", { name: "Add to Billing" }).click();
  await team.getByRole("menuitem", { name: "New collection" }).click();
  const dialog = team.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Invoices");
  await expect(dialog.getByRole("combobox", { name: "Parent collection" })).toContainText("Billing");
  await dialog.getByRole("button", { name: "Add collection" }).click();
  await expect(team.getByText("Collection added")).toBeVisible();
  await expect(structure.getByRole("list", { name: "Collections in Billing" })).toContainText("Invoices");

  // An article goes in it from its handle's "Move to…" menu. Invoices opens to show it.
  await structure.getByRole("button", { name: "Move Downloading invoices", exact: true }).click();
  await team.getByRole("menuitem", { name: "Move to…" }).click();
  await team.getByRole("menuitem", { name: "Billing › Invoices" }).click();
  await expect(team.getByText("Downloading invoices moved")).toBeVisible();
  await structure.getByRole("button", { name: "Invoices", exact: true }).click();
  await expect(structure.getByRole("list", { name: "Articles in Invoices" })).toContainText("Downloading invoices");

  // A third level: Taxes dropped on the middle of Invoices' row goes inside it.
  const row = (name: string) => structure.locator("[draggable=true]").filter({ has: team.getByRole("link", { name, exact: true }) });
  await row("Taxes").dragTo(row("Invoices"));
  await expect(team.getByText("Taxes moved")).toBeVisible();
  await expect(structure.getByRole("list", { name: "Collections in Invoices" })).toContainText("Taxes");
  // Billing's "Move to…" lists every collection, indented; it can't go in itself or the ones inside it.
  await structure.getByRole("button", { name: "Move Billing", exact: true }).click();
  await team.getByRole("menuitem", { name: "Move to…" }).click();
  for (const inside of ["Billing", "Billing › Invoices", "Billing › Invoices › Taxes"]) {
    await expect(team.getByRole("menuitem", { name: inside, exact: true })).toBeDisabled();
  }
  await expect(team.getByRole("menuitem", { name: "Getting started" })).toBeEnabled();
  await checkpoint(team, "team-docs-move-to-nested");
  await team.keyboard.press("Escape");
  await team.keyboard.press("Escape");

  // With the keyboard: Billing up to the top, then "Your first board" before "Inviting your team".
  const billing = structure.getByRole("button", { name: "Move Billing", exact: true });
  await billing.focus();
  await team.keyboard.press("Enter");
  await team.getByRole("menuitem", { name: "Move up" }).press("Enter");
  await expect(team.getByText("Billing moved")).toBeVisible();
  // It's first now: focus is back on its handle, and "Move up" is off.
  await expect(billing).toBeFocused();
  await team.keyboard.press("Enter");
  await expect(team.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
  await team.keyboard.press("Escape");
  await expect(team.getByRole("menu")).toHaveCount(0);
  // By its handle: pressed and moved, it drags its row (its menu opens on a click, so it doesn't take the drop).
  // Getting started is open: it's this page's collection.
  await expect(structure.getByRole("button", { name: "Getting started", exact: true })).toHaveAttribute("aria-expanded", "true");
  const handle = (await structure.getByRole("button", { name: "Move Your first board", exact: true }).boundingBox())!;
  const above = (await structure.getByRole("link", { name: "Inviting your team" }).boundingBox())!;
  await team.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await team.mouse.down();
  await team.mouse.move(above.x + 10, above.y + 2, { steps: 10 });
  await team.mouse.up();
  await expect(team.getByText("Your first board moved")).toBeVisible();
  await expect(team.getByRole("menu")).toHaveCount(0);
  await expect(structure.getByRole("list", { name: "Articles in Getting started" }).getByRole("listitem")).toHaveText([
    /^Your first board/,
    /^Inviting your team/,
  ]);
  await checkpoint(team, "team-docs-structure");
  await team.setViewportSize({ width: 390, height: 844 });
  await team.getByRole("button", { name: "Browse docs" }).click();
  await checkpoint(team, "team-docs-structure-phone");
  await team.setViewportSize({ width: 1280, height: 720 });
  await expect(team.getByRole("dialog", { name: "Docs navigation" })).toBeHidden();

  // The portal follows: Billing first with Invoices in it, then Getting started in its new order.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs");
  const main = visitor.getByRole("main");
  await expect(main.getByRole("list", { name: "Collections" }).getByRole("heading", { level: 2 })).toHaveText(["Billing", "Getting started"]);
  await main.getByRole("list", { name: "Collections" }).getByRole("link", { name: /^Billing/ }).click();
  await expect(visitor).toHaveURL(/\/docs\/billing$/);
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(["Invoices"]);
  // Its articles as a card of rows, then a card for Invoices: its article, then Taxes (in it) as a folder that opens its own page.
  await expect(main.getByRole("list", { name: "Articles" }).getByRole("listitem")).toHaveText(["Card payments"]);
  const invoices = main.getByRole("region", { name: "Invoices" });
  await expect(invoices.getByRole("heading")).toHaveCount(1);
  await expect(invoices.getByRole("listitem")).toHaveText(["Downloading invoices", "Taxes"]);
  await expect(invoices.getByRole("link", { name: "Taxes" })).toHaveAttribute("href", /\/docs\/taxes$/);
  await checkpoint(visitor, "portal-docs-nested");
  // A collection's page: the ones in it a level up; in the tree, its branch open and the rest closed.
  await invoices.getByRole("link", { name: "Invoices", exact: true }).click();
  await expect(visitor).toHaveURL(/\/docs\/invoices$/);
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(["Taxes"]);
  const tree = visitor.getByRole("navigation", { name: "Docs", exact: true });
  await expect(tree.getByRole("link", { name: "Invoices", exact: true })).toHaveAttribute("aria-current", "page");
  // Taxes (in Invoices) is closed: its articles aren't shown; nor are another collection's (only the page's is open).
  await expect(tree.getByRole("link")).toHaveText(["Billing", "Card payments", "Invoices", "Downloading invoices", "Taxes", "Getting started"]);
  await checkpoint(visitor, "portal-docs-collection-nested");
  await tree.getByRole("link", { name: "Taxes" }).click();
  await expect(visitor).toHaveURL(/\/docs\/taxes$/);
  await expect(tree.getByRole("link", { name: "VAT rates" })).toBeVisible();
  // Above its title, the level above: the one it's in (here on a phone, where the tree isn't beside it).
  await visitor.setViewportSize({ width: 390, height: 844 });
  await expect(main.getByRole("link", { name: "Invoices" })).toHaveAttribute("href", "/docs/invoices");
  await visitor.setViewportSize({ width: 1280, height: 720 });

  // The widget's Docs tab goes a level at a time: a collection opens its own list, with a way back.
  await visitor.goto("/widget?tab=docs");
  // Cards with their counts: matched by the name they start with.
  await expect(visitor.getByRole("list", { name: "Collections" }).getByRole("link")).toHaveText([/^Billing.*3 articles$/, /^Getting started/]);
  await visitor.getByRole("link", { name: "Billing" }).click();
  await visitor.getByRole("list", { name: "Collections in Billing" }).getByRole("link", { name: "Invoices" }).click();
  await expect(visitor.getByRole("heading", { level: 2 })).toHaveText("Invoices");
  await expect(visitor.getByRole("link", { name: "Downloading invoices" })).toBeVisible();
  await visitor.getByRole("list", { name: "Collections in Invoices" }).getByRole("link", { name: "Taxes" }).click();
  await checkpoint(visitor, "widget-docs-nested");
  await visitor.getByRole("link", { name: "VAT rates" }).click();
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("VAT rates");
  await visitor.getByRole("link", { name: "Taxes" }).click();
  await visitor.getByRole("link", { name: "Invoices", exact: true }).click();
  await visitor.getByRole("link", { name: "Billing" }).click();
  await visitor.getByRole("link", { name: "All articles" }).click();
  await expect(visitor.getByRole("list", { name: "Collections" })).toBeVisible();
  // An old URL of an article (and of its Markdown) sends readers to its current one.
  await visitor.goto("/docs/payments");
  await expect(visitor).toHaveURL(/\/docs\/card-payments$/);
  await expect(visitor.getByRole("heading", { name: "Card payments", level: 1 })).toBeVisible();
  const markdown = await visitor.request.get(`${portalUrl(slug)}/docs/payments.md`);
  expect([markdown.status(), new URL(markdown.url()).pathname]).toEqual([200, "/docs/card-payments.md"]);
  await visitor.goto("/docs");

  // Dragged by its row: Getting started back above Billing.
  await row("Getting started").dragTo(row("Billing"), { targetPosition: { x: 40, y: 2 } });
  await expect(team.getByText("Getting started moved")).toBeVisible();
  await visitor.reload();
  await expect(main.getByRole("list", { name: "Collections" }).getByRole("heading", { level: 2 })).toHaveText(["Getting started", "Billing"]);

  // A refused move (someone deleted the collection meanwhile) says why, and focus goes back to the handle that started it.
  // The drag's move is done once its refreshed rows are in (they stream in after its toast; the handles are off until
  // then). Only then is the collection deleted, so the page still shows it.
  const moveTo = structure.getByRole("button", { name: "Move Inviting your team", exact: true });
  await expect(moveTo).toBeEnabled();
  await api("/collections/billing", {}, "DELETE");
  await moveTo.focus();
  await team.keyboard.press("Enter");
  await team.getByRole("menuitem", { name: "Move to…" }).press("ArrowRight");
  await team.getByRole("menuitem", { name: "Billing", exact: true }).press("Enter");
  await expect(team.getByText("There's no collection “billing”")).toBeVisible();
  await expect(moveTo).toBeFocused();
});

test("the team builds its docs in the tree: a tab, a collection and an article from its +, moves, and a tab's and a collection's page", async ({
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/collections", { name: "Getting started", icon: "rocket" });
  await api("/collections", { name: "Billing", icon: "credit-card" });
  const article = await api("/articles", { title: "Inviting your team", body: "Owners and admins send invites.", collection: "getting-started" });
  await api(`/articles/${article.slug}/publish`, {});

  // Beside a collection's page: the tree. "New tab" in its switcher; the first tab takes the collections.
  await team.goto(`/app/${slug}/docs/collections/getting-started`);
  const tree = team.getByRole("navigation", { name: "Docs", exact: true });
  /** A list's own rows (not the ones nested in them). */
  const rows = (name: string) => tree.getByRole("list", { name, exact: true }).locator(":scope > li");
  await team.locator(".docs-tab-switcher").click();
  await team.getByRole("button", { name: "New tab" }).click();
  const tabDialog = team.getByRole("dialog", { name: "New tab" });
  await expect(tabDialog).toContainText("Your collections go in this first one");
  await tabDialog.getByLabel("Name").fill("Guides");
  await tabDialog.getByRole("button", { name: "Add tab" }).click();
  await expect(team.getByText("Tab added")).toBeVisible();
  await expect(rows("Collections in Guides")).toHaveText([/^Getting started/, /^Billing/]);

  // A collection in Billing from Billing's +: the dialog starts there, and Billing opens to show it.
  await tree.getByRole("button", { name: "Add to Billing" }).click();
  await team.getByRole("menuitem", { name: "New collection" }).click();
  const dialog = team.getByRole("dialog", { name: "New collection" });
  await expect(dialog.getByRole("combobox", { name: "Parent collection" })).toContainText("Billing");
  await dialog.getByLabel("Name").fill("Invoices");
  await dialog.getByRole("button", { name: "Add collection" }).click();
  await expect(team.getByText("Collection added")).toBeVisible();
  await expect(tree.getByRole("button", { name: "Billing", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(rows("Collections in Billing")).toHaveText([/^Invoices/]);

  // An article from Invoices' +: the editor starts it in Invoices.
  await tree.getByRole("button", { name: "Add to Invoices" }).click();
  await team.getByRole("menuitem", { name: "New article" }).click();
  await team.waitForURL(`**/app/${slug}/docs/new?collection=invoices`);
  await team.getByRole("button", { name: "Settings" }).click();
  await expect(team.getByRole("dialog", { name: "Article settings" }).getByRole("combobox", { name: "Collection" })).toContainText("Billing › Invoices");
  await team.keyboard.press("Escape");
  await team.getByLabel("Title").fill("Downloading invoices");
  await team.getByRole("textbox", { name: "Article" }).click();
  await team.keyboard.type("Every invoice is a PDF on the Billing page.");
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/docs/downloading-invoices`);
  // In the tree: its branch open, its row marked, a draft.
  const draft = tree.getByRole("link", { name: /^Downloading invoices/ });
  await expect(draft).toHaveAttribute("aria-current", "page");
  await expect(draft).toContainText("Draft");
  await expect(tree.getByRole("button", { name: "Invoices", exact: true })).toHaveAttribute("aria-expanded", "true");
  await checkpoint(team, "team-docs-tree");

  // Dragged onto the middle of Billing's row, Getting started goes inside it, last.
  const row = (name: string) => tree.locator("[draggable=true]").filter({ has: team.getByRole("link", { name, exact: true }) });
  await row("Getting started").dragTo(row("Billing"));
  await expect(rows("Collections in Billing")).toHaveText([/^Invoices/, /^Getting started/]);
  // With the keyboard, from its handle's menu: up, then to the top level again. Focus comes back to the handle.
  const handle = tree.getByRole("button", { name: "Move Getting started", exact: true });
  await handle.focus();
  await team.keyboard.press("Enter");
  await team.getByRole("menuitem", { name: "Move up" }).press("Enter");
  await expect(rows("Collections in Billing")).toHaveText([/^Getting started/, /^Invoices/]);
  await expect(handle).toBeFocused();
  await team.keyboard.press("Enter");
  await team.getByRole("menuitem", { name: "Move to…" }).press("ArrowRight");
  // It can't go in itself; Billing is where it is.
  await expect(team.getByRole("menuitem", { name: "Billing › Getting started", exact: true })).toBeDisabled();
  await team.getByRole("menuitem", { name: "Top level" }).press("Enter");
  await expect(rows("Collections in Guides")).toHaveText([/^Billing/, /^Getting started/]);
  await expect(handle).toBeFocused();

  // A tab's page: what's in it, then its Settings: the landing page.
  await team.locator(".docs-tab-switcher").click();
  await team.getByRole("link", { name: "Guides", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/tabs/guides`);
  await expect(team.getByRole("heading", { level: 1 })).toHaveText("Guides");
  // Its collections, each a band with what's in it (the first open).
  await expect(team.getByRole("tabpanel", { name: "Content" }).getByRole("heading", { level: 3 })).toHaveText(["Billing", "Getting started"]);
  await expect(team.getByRole("tabpanel", { name: "Content" }).getByRole("region", { name: "Getting started" })).toContainText("1 article");
  await checkpoint(team, "team-docs-tab-page");
  await team.getByRole("tab", { name: "Settings" }).click();
  const settings = team.getByRole("tabpanel", { name: "Settings" });
  await expect(settings.getByLabel("Address")).toHaveValue("/docs");
  await settings.getByText("A page you choose").click();
  await settings.getByRole("combobox", { name: "Page" }).click();
  await team.getByRole("option", { name: "Inviting your team" }).click();
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("Tab saved")).toBeVisible();
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs");
  await expect(visitor.getByRole("main").getByRole("heading", { level: 1 })).toHaveText("Inviting your team");
  // Renamed, its page follows.
  await settings.getByLabel("Name").fill("Handbook");
  await settings.getByRole("button", { name: "Save" }).click();
  await team.waitForURL(`**/app/${slug}/docs/tabs/handbook`);
  await expect(team.getByRole("heading", { level: 1 })).toHaveText("Handbook");

  // A collection's page, then its settings' Access: for signed-in readers only.
  await tree.getByRole("link", { name: "Billing", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/collections/billing`);
  await expect(team.getByRole("region", { name: "Billing" }).getByRole("listitem")).toHaveText([/^Invoices.*1 article/, "New articleNew collection"]);
  await checkpoint(team, "team-docs-collection-page");
  await team.getByRole("navigation", { name: "Collection" }).getByRole("link", { name: "Settings" }).click();
  await team.waitForURL(`**/app/${slug}/docs/collections/billing/settings`);
  const access = team.getByRole("region", { name: "Access" });
  await expect(access.getByRole("radio", { name: "Inherit" })).toBeChecked();
  await access.getByRole("radio", { name: "Signed-in readers" }).check();
  // What the rest see of it, as in the dialogs: hidden by default, or shown with a lock.
  await access.locator("summary").filter({ hasText: "People without access" }).click();
  const withoutAccess = access.getByRole("group", { name: "People without access" });
  await expect(withoutAccess.getByRole("radio", { name: "Inherit" })).toBeChecked();
  await withoutAccess.getByRole("radio", { name: "Show with a lock" }).check();
  await expect(access.getByRole("link", { name: "View as a reader" })).toHaveAttribute("href", `${portalUrl(slug)}/docs/billing?preview=signed-out`);
  await team.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("Collection saved")).toBeVisible();
  await team.locator(".docs-tab-switcher").click();
  await team.getByRole("link", { name: "Handbook", exact: true }).click();
  await expect(team.getByRole("tabpanel", { name: "Content" }).getByRole("region").first().getByText("Signed-in", { exact: true })).toBeVisible();
  await api("/articles/downloading-invoices/publish", {});
  await visitor.goto("/docs/downloading-invoices");
  await expect(visitor.getByText("Sign in to read this.")).toBeVisible();
  await expect(visitor.getByText("Every invoice is a PDF")).toHaveCount(0);

  // On a phone the tree is a "Browse docs" menu above the page.
  await team.setViewportSize({ width: 390, height: 844 });
  await expect(tree).toBeHidden();
  await team.getByRole("button", { name: "Browse docs" }).click();
  await expect(team.locator(".docs-tab-switcher").last()).toHaveText("Handbook");
  await checkpoint(team, "team-docs-tree-phone");
  await tree.getByRole("link", { name: "Getting started", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/collections/getting-started`);
  await expect(tree).toBeHidden();
});

test("the team splits the docs into tabs: the first takes the collections, others get theirs through the switcher and move menus", async ({
  browser,
}, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  for (const name of ["Getting started", "Billing", "Endpoints", "Webhooks"]) {
    await api("/collections", { name });
  }
  for (const [title, collection] of [
    ["Inviting your team", "getting-started"],
    ["Card payments", "billing"],
    ["Listing posts", "endpoints"],
    ["Signing payloads", "webhooks"],
  ]) {
    const article = await api("/articles", { title, body: `${title}.`, collection });
    await api(`/articles/${article.slug}/publish`, {});
  }

  // Tabs are managed from the switcher above Overview.
  await team.goto(`/app/${slug}/docs/collections/getting-started`);
  const structure = team.getByRole("navigation", { name: "Docs", exact: true });
  const rows = (name: string) => (name === "Tabs" ? team : structure).getByRole("list", { name, exact: true }).locator(":scope > li");
  const openTabs = () => team.locator(".docs-tab-switcher").click();
  await openTabs();
  await team.getByRole("button", { name: "New tab" }).click();
  const dialog = team.getByRole("dialog");
  await expect(dialog).toContainText("Your collections go in this first one");
  await dialog.getByLabel("Name").fill("Guides");
  await dialog.getByRole("button", { name: "Add tab" }).click();
  await expect(team.getByText("Tab added")).toBeVisible();
  await team.keyboard.press("Escape");
  await expect(rows("Collections in Guides")).toHaveText([/^Getting started/, /^Billing/, /^Endpoints/, /^Webhooks/]);
  await openTabs();
  await team.getByRole("button", { name: "New tab" }).click();
  await expect(dialog).not.toContainText("Your collections go in this first one");
  await dialog.getByLabel("Name").fill("API");
  await dialog.getByRole("button", { name: "Add tab" }).click();
  await expect(dialog).toBeHidden();
  await openTabs();
  await expect(team.getByRole("list", { name: "Tabs", exact: true }).getByRole("listitem")).toContainText(["Guides", "API"]);
  await team.keyboard.press("Escape");

  // Move across tabs from each collection's keyboard menu.
  for (const name of ["Endpoints", "Webhooks"]) {
    await structure.getByRole("button", { name: `Move ${name}`, exact: true }).click();
    await team.getByRole("menuitem", { name: "Move to…" }).press("ArrowRight");
    await team.getByRole("menuitem", { name: "Tab: API" }).press("Enter");
    await expect(team.getByText(`${name} moved`)).toBeVisible();
  }
  await expect(rows("Collections in Guides")).toHaveText([/^Getting started/, /^Billing/]);
  await openTabs();
  await expect(rows("Tabs")).toHaveText([/^Guides/, /^API/]);
  await team.getByRole("link", { name: "API", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/tabs/api`);
  await expect(rows("Collections in API")).toHaveText([/^Endpoints/, /^Webhooks/]);
  await structure.getByRole("button", { name: "Add to your docs" }).click();
  await team.getByRole("menuitem", { name: "New collection" }).click();
  await dialog.getByLabel("Name").fill("Errors");
  await expect(dialog.getByRole("combobox", { name: "Tab" })).toContainText("API");
  await dialog.getByRole("button", { name: "Add collection" }).click();
  await expect(team.getByText("Collection added")).toBeVisible();
  await expect(rows("Collections in API")).toHaveText([/^Endpoints/, /^Webhooks/, /^Errors/]);

  // A nested collection keeps the owning tab selected, even while it is second.
  await api("/collections", { name: "Authentication", parent: "endpoints" });
  await team.goto(`/app/${slug}/docs/collections/authentication`);
  await expect(team.locator(".docs-tab-switcher")).toHaveText("API");
  await expect(structure.getByRole("link", { name: "Endpoints", exact: true })).toBeVisible();
  await team.goto(`/app/${slug}/docs/tabs/api`);

  // API first, then renamed in its page's Settings: the page follows.
  await openTabs();
  await team.getByRole("button", { name: "Move API", exact: true }).click();
  await team.getByRole("menuitem", { name: "Move up" }).click();
  await expect(team.getByText("API moved")).toBeVisible();
  await expect(rows("Tabs")).toHaveText([/^API/, /^Guides/]);
  await team.getByRole("link", { name: "API", exact: true }).click();
  // Its page first: the collection's page it comes from has a Settings tab too.
  await team.waitForURL(`**/app/${slug}/docs/tabs/api`);
  await team.getByRole("tab", { name: "Settings" }).click();
  const settings = team.getByRole("tabpanel", { name: "Settings" });
  await settings.getByLabel("Name").fill("API reference");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("Tab saved")).toBeVisible();
  await team.waitForURL(`**/app/${slug}/docs/tabs/api-reference`);
  await checkpoint(team, "team-docs-tabs");

  // Tabs and their settings stay reachable in the tree beside the overview.
  await team.goto(`/app/${slug}/docs`);
  await openTabs();
  await expect(rows("Tabs")).toHaveText([/^API reference/, /^Guides/]);
  await checkpoint(team, "team-docs-home");
  await team.getByRole("link", { name: "API reference", exact: true }).click();
  await team.getByRole("tab", { name: "Settings" }).click();
  await expect(team.getByRole("tabpanel", { name: "Settings" }).getByLabel("Name")).toHaveValue("API reference");
  await team.setViewportSize({ width: 390, height: 844 });
  await expect(team.getByRole("button", { name: "Browse docs" })).toBeVisible();
  await checkpoint(team, "team-docs-home-phone", { fullPage: false });
  await team.setViewportSize({ width: 1280, height: 720 });
  await team.goto(`/app/${slug}/docs/tabs/api-reference`);

  // Readers get a tab for each one with something to read: the first at /docs, the others at their own path.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs");
  const main = visitor.getByRole("main");
  // They're the row under the header's Docs.
  await expect(visitor.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Docs" })).toHaveAttribute("aria-current", "page");
  const docsTabs = visitor.getByRole("navigation", { name: "Docs tabs" });
  await expect(docsTabs.getByRole("link")).toHaveText(["API reference", "Guides"]);
  await expect(docsTabs.getByRole("link", { name: "API reference" })).toHaveAttribute("aria-current", "page");
  await expect(docsTabs.getByRole("link", { name: "API reference" })).toHaveAttribute("href", "/docs");
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(["Endpoints", "Webhooks"]);
  await checkpoint(visitor, "portal-docs-tabs");
  await docsTabs.getByRole("link", { name: "Guides" }).click();
  await expect(visitor).toHaveURL(/\/docs\/guides$/);
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(["Getting started", "Billing"]);
  // A tab has its name, without the docs home's subtitle.
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Guides");
  await expect(main).not.toContainText("Guides and answers to common questions.");
  await checkpoint(visitor, "portal-docs-tab");
  // A collection has a page, in its tab, marked in the tree; so does an article.
  await main.getByRole("list", { name: "Collections" }).getByRole("link", { name: /^Billing/ }).click();
  await expect(visitor).toHaveURL(/\/docs\/billing$/);
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Billing");
  await expect(docsTabs.getByRole("link", { name: "Guides" })).toHaveAttribute("aria-current", "page");
  // Beside a collection's page, its tab's tree: the other tab's collections aren't in it.
  const tree = visitor.getByRole("navigation", { name: "Docs", exact: true });
  // Only the page's collection is open.
  await expect(tree.getByRole("link")).toHaveText(["Getting started", "Billing", "Card payments"]);
  await expect(tree.getByRole("link", { name: "Billing" })).toHaveAttribute("aria-current", "page");
  await checkpoint(visitor, "portal-docs-collection");
  await tree.getByRole("link", { name: "Card payments" }).click();
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Card payments");
  await expect(tree.getByRole("link", { name: "Card payments" })).toHaveAttribute("aria-current", "page");
  await expect(tree.getByRole("link", { name: "Billing" })).not.toHaveAttribute("aria-current");
  await expect(docsTabs.getByRole("link", { name: "Guides" })).toHaveAttribute("aria-current", "page");
  await expect(docsTabs.getByRole("link", { name: "API reference" })).not.toHaveAttribute("aria-current");
  // Above its title, the level above: its collection (here on a phone, where the tree isn't beside it).
  await visitor.setViewportSize({ width: 390, height: 844 });
  await main.getByRole("link", { name: "Billing", exact: true }).click();
  await expect(visitor).toHaveURL(/\/docs\/billing$/);
  // And a top-level collection's is its tab.
  await expect(main.getByRole("link", { name: "Guides", exact: true })).toHaveAttribute("href", "/docs/guides");
  await visitor.setViewportSize({ width: 1280, height: 720 });
  // Off Docs, its row goes (the boards' row isn't there either, with one board).
  await visitor.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Feedback" }).click();
  await expect(visitor).toHaveURL(/\/feedback\/feature-requests$/);
  await expect(docsTabs).toHaveCount(0);
  await expect(visitor.getByRole("navigation", { name: "Boards" })).toHaveCount(0);
  // The first tab has one address: /docs.
  await visitor.goto("/docs/api-reference");
  await expect(visitor).toHaveURL(/\/docs$/);
  // A search, from the header on any Docs page, covers every tab.
  await visitor.goto("/docs/guides");
  await expect((await foundAsTyped(visitor, "payloads")).getByRole("option").nth(1)).toContainText("Signing payloads");
  await visitor.keyboard.press("Escape");

  // The widget's Docs tab has the same tabs, at panel size.
  await visitor.goto("/widget?tab=docs");
  const panelTabs = visitor.getByRole("navigation", { name: "Docs tabs" });
  await expect(panelTabs.getByRole("link")).toHaveText(["API reference", "Guides"]);
  await panelTabs.getByRole("link", { name: "Guides" }).click();
  await expect(visitor.getByRole("list", { name: "Collections" }).getByRole("link")).toHaveText([/^Getting started/, /^Billing/]);
  await checkpoint(visitor, "widget-docs-tabs");

  // Deleting a tab moves its collections to the one before it. The first is the docs' home: it stays while there are others.
  await expect(team.getByRole("heading", { level: 1 })).toHaveText("API reference");
  await expect(team.getByRole("button", { name: "Delete API reference" })).toHaveCount(0);
  // Nothing behind "More actions" there, so there's none.
  await expect(team.getByRole("button", { name: "More actions" })).toHaveCount(0);
  await team.locator(".docs-tab-switcher").click();
  await team.getByRole("link", { name: "Guides", exact: true }).click();
  await team.getByRole("button", { name: "More actions" }).click();
  await team.getByRole("button", { name: "Delete Guides" }).click();
  const confirm = team.getByRole("alertdialog");
  await expect(confirm).toContainText("Its collections move to API reference");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(team.getByText("Guides deleted")).toBeVisible();
  await team.waitForURL(`**/app/${slug}/docs`);
  await team.locator(".docs-tab-switcher").click();
  await team.getByRole("link", { name: "API reference", exact: true }).click();
  await expect(team.getByRole("tabpanel", { name: "Content" }).getByRole("region")).toHaveText([/^Endpoints/, /^Webhooks/, /^Errors/, /^Getting started/, /^Billing/]);
});

test("a tab's landing page: the overview's cards, or a page the team picks in the tab's settings", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/tabs", { name: "Guides" });
  await api("/tabs", { name: "API" });
  for (const [name, description, icon, tab] of [
    ["Getting started", "The basics, in five minutes.", "rocket", "guides"],
    ["Billing", "Plans, invoices and payments.", "credit-card", "guides"],
    ["Teams", "Invite people and set what they can do.", "users", "guides"],
    ["Endpoints", "Every endpoint, with examples.", "plug", "api"],
  ]) {
    await api("/collections", { name, description, icon, tab });
  }
  for (const [title, collection, listing] of [
    ["Your first board", "getting-started"],
    ["Card payments", "billing"],
    ["Invoices", "billing"],
    ["Inviting your team", "teams"],
    ["Listing posts", "endpoints"],
    ["Creating posts", "endpoints"],
    ["Voting on posts", "endpoints"],
    ["Contact us", null],
    // Read by its link only: in no list, count or Popular articles.
    ["Partner pricing", "billing", "unlisted"],
  ]) {
    const article = await api("/articles", { title, body: `${title}.`, collection, ...(listing && { listing }) });
    await api(`/articles/${article.slug}/publish`, {});
  }
  await api("/branding", { sidebarLinks: [{ label: "Status page", url: "https://status.example.com" }] }, "PATCH");

  // Articles readers opened lately are a tab's Popular articles (most read first; an unlisted one isn't listed, nor one in another tab).
  const visitor = await newPerson(browser, portalUrl(slug));
  const main = visitor.getByRole("main");
  for (const article of ["invoices", "listing-posts", "invoices", "card-payments", "your-first-board", "invoices", "card-payments", "partner-pricing"]) {
    const counted = visitor.waitForResponse((response) => response.request().headers()["next-action"] !== undefined);
    await visitor.goto(`/docs/${article}`);
    await counted;
  }

  // By default a tab shows its overview: its Popular articles, a card per collection with how many articles
  // it has, then (on the first) the articles in none. The collections once: no tree beside them; the docs home's heading
  // has the big box for searching and asking (the header's too).
  await visitor.goto("/docs");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("How can we help?");
  await expect(main.getByRole("region", { name: "Popular articles" }).getByRole("link")).toHaveText(["Invoices", "Card payments", "Your first board"]);
  const cards = main.getByRole("list", { name: "Collections" }).getByRole("link");
  await expect(cards).toHaveText([/^Getting started.*1 article$/, /^Billing.*2 articles$/, /^Teams.*1 article$/]);
  await expect(cards.first()).toContainText("The basics, in five minutes.");
  await expect(cards.first().locator("svg.lucide-rocket")).toBeVisible();
  await expect(main.getByRole("region", { name: "More articles" }).getByRole("link")).toHaveText(["Contact us"]);
  await expect(visitor.getByRole("navigation", { name: "Docs", exact: true })).toHaveCount(0);
  await expect(main.getByRole("search")).toHaveCount(1);
  // The big box searches as the header's does.
  const heroResults = await foundAsTyped(visitor, "invoi", main);
  await expect(heroResults.getByRole("option").nth(1)).toContainText("Invoices");
  await visitor.keyboard.press("Escape");
  // The team's sidebar links are still beside them.
  await expect(main.getByRole("list", { name: "Links" }).getByRole("link", { name: "Status page" })).toBeVisible();
  // On the docs home the header's box gives way to the big one (the same box).
  const headerSearch = visitor.getByRole("banner").getByRole("button", { name: "Search or ask AI" });
  await expect(headerSearch).toBeHidden();
  await checkpoint(visitor, "portal-docs-overview");
  await visitor.emulateMedia({ colorScheme: "dark" });
  await checkpoint(visitor, "portal-docs-overview-dark");
  await visitor.setViewportSize({ width: 390, height: 844 });
  await checkpoint(visitor, "portal-docs-overview-phone-dark");
  await visitor.emulateMedia({ colorScheme: "light" });
  // On a phone the big box is the whole width (the header's is left out here too), and searches (and asks) the same way.
  const heroSearch = main.getByRole("button", { name: "Search or ask AI" });
  const box = (await heroSearch.boundingBox())!;
  expect(box.width).toBeGreaterThan(280);
  await expect(heroSearch).toContainText("Search or ask AI");
  await checkpoint(visitor, "portal-docs-overview-phone");
  const onPhone = await foundAsTyped(visitor, "invoi");
  await expect(onPhone.getByRole("option").first()).toContainText("Ask AI:");
  await expect(onPhone.getByRole("option").nth(1)).toContainText("Invoices");
  await checkpoint(visitor, "portal-docs-overview-phone-search", { fullPage: false });
  await visitor.keyboard.press("Escape");
  // The menu has no tree, but the team's sidebar links.
  await visitor.getByRole("banner").getByRole("button", { name: "Menu" }).click();
  const menu = visitor.getByRole("dialog", { name: "Menu" });
  await expect(menu.getByRole("list", { name: "Links" }).getByRole("link", { name: "Status page" })).toBeVisible();
  // A size up in the menu, like the tree's links: taps on a phone.
  expect(await menu.getByRole("list", { name: "Links" }).getByRole("link", { name: "Status page" }).evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
  await expect(menu.getByRole("navigation", { name: "Docs", exact: true })).toHaveCount(0);
  await checkpoint(visitor, "portal-docs-overview-phone-menu", { fullPage: false });
  await visitor.keyboard.press("Escape");
  await visitor.setViewportSize({ width: 1280, height: 720 });
  // The header's box searches every tab.
  const listing = await foundAsTyped(visitor, "listing");
  await expect(listing.getByRole("option").nth(1)).toContainText("Listing posts");
  await visitor.keyboard.press("Escape");
  // Its results page says what it's for, and marks the first tab, whose tree is beside it.
  await visitor.goto("/docs?q=listing");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Results for “listing”");
  await expect(visitor).toHaveTitle(/^Results for “listing” · Docs/);
  await expect(main.getByRole("list", { name: "Search results" }).getByRole("link")).toHaveText(["Listing posts"]);
  const docsTabs = visitor.getByRole("navigation", { name: "Docs tabs" });
  await expect(docsTabs.getByRole("link", { name: "Guides" })).toHaveAttribute("aria-current", "page");
  await expect(docsTabs.getByRole("link", { name: "API" })).not.toHaveAttribute("aria-current");
  await expect(visitor.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Getting started" })).toBeVisible();
  // The tree's line runs to the bottom of the window, though the page is short.
  const tree = visitor.locator("aside").filter({ has: visitor.getByRole("navigation", { name: "Docs", exact: true }) });
  const line = (await tree.boundingBox())!;
  expect(line.y + line.height).toBeGreaterThanOrEqual(720 - 1);
  await checkpoint(visitor, "portal-docs-search-results");

  // The team makes API's path show an article: the tab's page has its address and what it shows in Settings.
  // From the docs' home, by its heading.
  await team.goto(`/app/${slug}/docs`);
  const settings = team.getByRole("tabpanel", { name: "Settings" });
  await team.locator(".docs-tab-switcher").click();
  await team.getByRole("link", { name: "Guides", exact: true }).click();
  await team.getByRole("tab", { name: "Settings" }).click();
  await expect(settings.getByLabel("Address")).toHaveValue("/docs");
  await expect(settings).toContainText("Your docs' home");
  await team.locator(".docs-tab-switcher").click();
  await team.getByRole("link", { name: "API", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/tabs/api`);
  await team.getByRole("tab", { name: "Settings" }).click();
  await expect(settings.getByLabel("Address")).toHaveValue("/docs/api");
  await expect(settings.getByRole("radio", { name: /^Overview/ })).toBeChecked();
  await settings.getByText("A page you choose").click();
  await settings.getByRole("combobox", { name: "Page" }).click();
  await team.getByRole("option", { name: "Listing posts" }).click();
  await checkpoint(team, "team-docs-tab-settings", { fullPage: false });
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("Tab saved")).toBeVisible();

  // Readers get that article at the tab's path, which is its canonical address there; the article's own path keeps its own.
  const portal = portalUrl(slug);
  await visitor.goto("/docs/api");
  await expect(visitor).toHaveURL(/\/docs\/api$/);
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Listing posts");
  await expect(visitor.getByRole("navigation", { name: "Docs tabs" }).getByRole("link", { name: "API" })).toHaveAttribute("aria-current", "page");
  await expect(visitor.locator('link[rel="canonical"]')).toHaveAttribute("href", `${portal}/docs/api`);
  await checkpoint(visitor, "portal-docs-tab-landing-page");
  await visitor.goto("/docs/listing-posts");
  await expect(visitor.locator('link[rel="canonical"]')).toHaveAttribute("href", `${portal}/docs/listing-posts`);

  // Back to the overview: the tab's cards.
  await team.reload();
  await team.getByRole("tab", { name: "Settings" }).click();
  await expect(settings.getByRole("radio", { name: /^A page you choose/ })).toBeChecked();
  await settings.getByText("Overview", { exact: true }).click();
  await expect(settings.getByRole("combobox", { name: "Page" })).toHaveCount(0);
  const saved = team.waitForResponse((response) => response.request().headers()["next-action"] !== undefined);
  await settings.getByRole("button", { name: "Save" }).click();
  await saved;
  await visitor.goto("/docs/api");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("API");
  await expect(cards).toHaveText([/^Endpoints/]);
  // One article read in it isn't much of a list: no Popular articles under three.
  await expect(main.getByRole("region", { name: "Popular articles" })).toHaveCount(0);
  // Three read: the tab's own, none of Guides'.
  for (const article of ["creating-posts", "creating-posts", "creating-posts", "creating-posts", "creating-posts", "voting-on-posts", "voting-on-posts", "voting-on-posts", "voting-on-posts"]) {
    const counted = visitor.waitForResponse((response) => response.request().headers()["next-action"] !== undefined);
    await visitor.goto(`/docs/${article}`);
    await counted;
  }
  await visitor.goto("/docs/api");
  await expect(main.getByRole("region", { name: "Popular articles" }).getByRole("link")).toHaveText(["Creating posts", "Voting on posts", "Listing posts"]);
});


test("an article's settings: its own address (the old one redirects), keywords readers search for, and a meta description", async ({
  browser,
}, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/articles", { title: "Inviting your team", body: "Owners send invites from the Team page." });
  await api("/articles/inviting-your-team/publish", {});
  await api("/collections", { name: "Team basics" });

  await team.goto(`/app/${slug}/docs/inviting-your-team`);
  // Saved state lives in the title row; Settings is an icon on the pinned formatting row.
  const bar = (name: string) => team.getByRole("button", { name, exact: true });
  await expect(team.locator("#article-toolbar").getByRole("button", { name: "Settings" })).toBeVisible();
  await expect(bar("Saved")).toBeVisible();
  await expect(team.getByRole("button", { name: "Delete" })).toBeHidden();
  await expect(team.getByRole("combobox", { name: "Collection" })).toHaveCount(0);
  await expect(team.getByRole("checkbox", { name: /^Show the updated date/ })).toHaveCount(0);
  await checkpoint(team, "team-docs-article-editor", { fullPage: false });
  await bar("Settings").click();
  const dialog = team.getByRole("region", { name: "Article settings" });
  await expect(dialog.getByRole("combobox", { name: "Collection" })).toContainText("No collection");
  await expect(dialog.getByRole("checkbox", { name: /^Show the updated date/ })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Inherit" })).toBeChecked();
  // The shared card takes 330px here (300px below 1280px), and leaves the text beside it.
  await expect(team.getByRole("complementary", { name: "Article tools" })).toBeVisible();
  await expect.poll(async () => Math.round((await team.getByRole("complementary", { name: "Article tools" }).boundingBox())!.width)).toBe(330);
  await expect(dialog.getByRole("textbox", { name: "Slug" })).toHaveCount(0);
  // Published, with the box off: its address stays as it is, and the checkbox says so.
  await expect(dialog.getByRole("checkbox", { name: /^Custom slug/ })).toHaveAccessibleName(/Its address stays as it is; links to it keep working\.$/);
  await dialog.getByRole("checkbox", { name: /^Custom slug/ }).check();
  const slugBox = dialog.getByRole("textbox", { name: "Slug" });
  await expect(slugBox).toHaveValue("inviting-your-team");
  // An address Tuti keeps for itself is refused, and what was typed stays.
  await slugBox.fill("insights");
  await dialog.getByRole("textbox", { name: "Keywords" }).fill("add a colleague, seats");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByText("“insights” is reserved; pick another")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Keywords" })).toHaveValue("add a colleague, seats");
  await slugBox.fill("invites");
  await dialog.getByRole("textbox", { name: "Search description" }).fill("Add teammates to your project, and what they can do.");
  await checkpoint(team, "team-docs-article-settings", { fullPage: false });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await team.waitForURL(`**/app/${slug}/docs/invites`);
  // (Under "More actions" in an editor.)
  await expect(team.locator(".docs-editor-state").getByRole("link", { name: "Open on help center", exact: true })).toHaveAttribute("href", `${portalUrl(slug)}/docs/invites`);

  await bar("More actions").click();
  await expect(team.locator(".docs-more-menu").getByRole("link", { name: "View on help center", exact: true })).toHaveAttribute("href", `${portalUrl(slug)}/docs/invites`);
  await team.keyboard.press("Escape");

  // On a phone, the toolbar opens the same settings in a scrolling sheet.
  await team.setViewportSize({ width: 390, height: 844 });
  await checkpoint(team, "team-docs-article-editor-phone", { fullPage: false });
  await team.getByRole("button", { name: "Settings" }).click();
  await expect(dialog.getByRole("textbox", { name: "Slug" })).toHaveValue("invites");
  await expect(dialog.getByRole("textbox", { name: "Keywords" })).toHaveValue("add a colleague, seats");
  await checkpoint(team, "team-docs-article-settings-phone", { fullPage: false });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await team.keyboard.press("Escape");
  await team.setViewportSize({ width: 1280, height: 720 });

  // Readers find it at its new address, with its description; the old one redirects there.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs/inviting-your-team");
  await expect(visitor).toHaveURL(/\/docs\/invites$/);
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Inviting your team");
  await expect(visitor.locator('meta[name="description"]')).toHaveAttribute("content", "Add teammates to your project, and what they can do.");
  // A word only its keywords have finds it.
  await visitor.goto("/docs?q=colleague");
  await expect(visitor.getByRole("main").getByRole("list", { name: "Search results" }).getByRole("link")).toHaveText(["Inviting your team"]);
  await checkpoint(visitor, "portal-docs-search-by-keyword");

  // A collection picked in Settings is saved there, as the article's Save would: on a published article it waits, with
  // the other unpublished changes, to be published. The title being written meanwhile stays as it was typed.
  const title = team.getByRole("textbox", { name: "Title" });
  await title.fill("Inviting your whole team");
  await team.getByRole("button", { name: "Settings" }).click();
  await expect(dialog.getByRole("combobox", { name: "Collection" })).toHaveAccessibleDescription("A new collection goes live when you publish the changes.");
  await dialog.getByRole("combobox", { name: "Collection" }).click();
  await team.getByRole("option", { name: "Team basics" }).click();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(team.getByText("Settings saved")).toBeVisible();
  await expect(dialog).toBeHidden();
  const unpublished = team.getByRole("region", { name: "Unpublished changes" });
  await expect(unpublished).toBeVisible();
  await expect(title).toHaveValue("Inviting your whole team");
  await visitor.goto("/docs/invites");
  await expect(visitor.getByRole("article", { name: "Inviting your team" }).getByRole("link", { name: "All collections" })).toBeVisible();
  await unpublished.getByRole("button", { name: "Publish changes" }).click();
  await expect(team.getByText("Changes published")).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByRole("article", { name: "Inviting your team" }).getByRole("link", { name: "Team basics" })).toHaveAttribute("href", "/docs/team-basics");

  // A new address and a new collection in one save: both are kept as the editor opens at the new address.
  await team.getByRole("button", { name: "Settings" }).click();
  await dialog.getByRole("combobox", { name: "Collection" }).click();
  await team.getByRole("option", { name: "No collection" }).click();
  await slugBox.fill("team-invites");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await team.waitForURL(`**/app/${slug}/docs/team-invites`);
  await expect(unpublished).toBeVisible();
  await team.getByRole("button", { name: "Settings" }).click();
  await expect(dialog.getByRole("combobox", { name: "Collection" })).toContainText("No collection");
  await expect(slugBox).toHaveValue("team-invites");

  // Someone else moves it while the panel's open; saving only the listing from it leaves their move alone.
  await api("/articles/team-invites", { collection: "team-basics" }, "PATCH");
  await dialog.getByLabel("Listed in").click();
  await team.getByRole("option", { name: "Unlisted" }).click();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(team.getByText("Settings saved").first()).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(team.locator('[data-slot="docs-page-header"]')).toContainText("Unlisted");
  await team.getByRole("button", { name: "Settings" }).click();
  await expect(dialog.getByRole("combobox", { name: "Collection" })).toContainText("Team basics");
  await team.keyboard.press("Escape");
});

test("a visitor asks the docs' AI: an answer with its source, or “I don't know” and posting the question as feedback", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);

  // How the AI answers (Settings → AI answers; Customize's old address lands there): a tone, short answers, and a topic it doesn't touch.
  await team.goto(`/app/${slug}/customize/ai-answers`);
  await team.waitForURL(`**/app/${slug}/settings/ai-answers`);
  await team.getByLabel("Tone", { exact: true }).fill("Friendly and plain");
  await team.getByRole("radio", { name: "Short" }).check();
  await team.getByLabel("Standing instructions").fill("Call the product Acme.");
  await team.getByLabel("Off-limits topics").fill("refund\n  legal advice  ");
  // Locked while it saves (held here until checked).
  let releaseSave!: () => void;
  const saveHeld = new Promise<void>((resolve) => (releaseSave = resolve));
  const saving = `**/app/${slug}/settings/ai-answers`;
  await team.route(saving, async (route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }
    const response = await route.fetch();
    await saveHeld;
    await route.fulfill({ response });
  });
  await team.getByRole("button", { name: /^(Save|Saved|Saving…)$/ }).click();
  await expect(team.getByLabel("Tone", { exact: true })).toBeDisabled();
  releaseSave();
  await expect(team.getByText("AI answers saved")).toBeVisible();
  await team.unroute(saving);
  // The form shows what was saved: each topic trimmed.
  await expect(team.getByLabel("Off-limits topics")).toHaveValue("refund\nlegal advice");
  await team.reload();
  await expect(team.getByLabel("Off-limits topics")).toHaveValue("refund\nlegal advice");
  await checkpoint(team, "team-ai-answers-settings");

  // A published article whose only section is close to the visitor's question.
  const question = "How do I add a colleague to my project?";
  const body = "Owners and admins send invites from the Team page. Each invite is good for 7 days.";
  await similar(question, `Inviting your team\n\n${body}`, 0.8);
  const article = await api("/articles", { title: "Inviting your team", body });
  await api(`/articles/${article.slug}/publish`, {});

  // The visitor searches, then asks the AI: in the box, asking comes first, and it asks in the widget's assistant (the
  // portal's own widget, at Messages), which the portal has for it.
  const visitor = await signUp(browser, portalUrl(slug), "Vera Visitor");
  await visitor.goto("/docs");
  // The docs home's big box has Ask AI at its end too, straight to the assistant.
  await expect(visitor.getByRole("main").getByRole("button", { name: "Ask AI", exact: true })).toBeVisible();
  await typeSearch(visitor, question);
  const first = visitor.getByRole("dialog").getByRole("option").first();
  await expect(first).toContainText("Ask AI:");
  await expect(first).toContainText(question);
  await checkpoint(visitor, "portal-docs-search-ask-ai", { fullPage: false });
  await nextModelReply(
    JSON.stringify({ answer: "Owners and admins send invites from the Team page.\n\n- Each invite is good for 7 days", sources: ["s1"] }),
    question,
  );
  await visitor.getByRole("dialog").getByRole("combobox", { name: "Search or ask AI" }).press("Enter");
  const panel = visitor.frameLocator('iframe[title="Feedback"]');
  const assistant = panel.getByRole("dialog", { name: "Assistant" });
  const conversation = assistant.getByRole("log", { name: "Conversation" });
  await expect(conversation).toContainText(question);
  await expect(visitor.locator('iframe[title="Feedback"]')).toHaveAttribute("src", `${portalUrl(slug)}/widget`);
  await expect(conversation.getByText("Owners and admins send invites from the Team page.")).toBeVisible();
  await expect(conversation.getByRole("listitem").filter({ hasText: "Each invite is good for 7 days" })).toBeVisible();
  const source = conversation.getByRole("list", { name: "Sources" }).getByRole("link", { name: "Inviting your team" });
  await expect(source).toHaveAttribute("href", "/widget?tab=docs&article=inviting-your-team");
  // The question went by message, never in the panel's address: going back or reloading it doesn't ask again.
  const panelUrl = async () => (await (await visitor.locator('iframe[title="Feedback"]').elementHandle())!.contentFrame())!.url();
  await expect.poll(panelUrl).toBe(`${portalUrl(slug)}/widget`);
  await checkpoint(visitor, "portal-docs-assistant-answer", { fullPage: false });
  const asked = (await modelRequests()).filter((request) => request.user.includes(question));
  expect(asked).toHaveLength(1);
  expect(asked[0]!.user).toContain(body);
  // The team's settings go with it, apart from the sections.
  expect(asked[0]!.user).toContain('"tone": "Friendly and plain"');
  expect(asked[0]!.user).toContain('"standingInstructions": "Call the product Acme."');
  expect(asked[0]!.system).toContain("Keep it very short");
  // A rating that fails (offline) leaves the buttons, to try again.
  const offline = () =>
    visitor.route("**/*", (route) => (route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort() : route.fallback()));
  await offline();
  await conversation.getByRole("button", { name: "Helpful", exact: true }).click();
  await expect(conversation.getByRole("button", { name: "Helpful", exact: true })).toBeEnabled();
  await visitor.unroute("**/*");
  await conversation.getByRole("button", { name: "Helpful", exact: true }).click();
  await expect(conversation.getByText("Thanks for letting us know.")).toBeVisible();

  // A follow-up: the docs are searched with the question before it, and the AI gets the conversation so far.
  const followUp = "Can members do it too?";
  await similar(`${question}\n${followUp}`, `Inviting your team\n\n${body}`, 0.8);
  await nextModelReply(JSON.stringify({ answer: "Only owners and admins can send invites.", sources: ["s1"] }), followUp);
  await assistant.getByRole("textbox", { name: "Ask a follow-up" }).fill(followUp);
  await assistant.getByRole("button", { name: "Send" }).click();
  await expect(conversation.getByText("Only owners and admins can send invites.")).toBeVisible();
  // Not what they hoped: the team will see it among the unanswered questions, with the article it cited.
  await conversation.getByRole("button", { name: "Not helpful" }).click();
  await expect(conversation.getByText("Thanks for letting us know.")).toHaveCount(2);
  const followed = (await modelRequests()).find((request) => request.user.includes(followUp))!;
  expect(followed.user).toContain('"earlierInConversation"');
  expect(followed.user).toContain(question);
  await checkpoint(visitor, "portal-docs-assistant-follow-up", { fullPage: false });
  await visitor.setViewportSize({ width: 390, height: 844 });
  await checkpoint(visitor, "portal-docs-assistant-follow-up-phone", { fullPage: false });
  await visitor.setViewportSize({ width: 1280, height: 720 });

  // Asked again from the header with the panel open: the same panel asks it, not reloaded, so the conversation stays.
  const again = "Do invites expire?";
  await similar(`${question}\n${followUp}\n${again}`, `Inviting your team\n\n${body}`, 0.8);
  await nextModelReply(JSON.stringify({ answer: "Yes, after 7 days.", sources: ["s1"] }), again);
  await typeSearch(visitor, again);
  await visitor.getByRole("dialog", { name: "Search or ask AI" }).getByRole("combobox", { name: "Search or ask AI" }).press("Enter");
  await expect(conversation.getByText("Yes, after 7 days.")).toBeVisible();
  await expect(conversation.getByText("Only owners and admins can send invites.")).toBeVisible();
  expect(await panelUrl()).toBe(`${portalUrl(slug)}/widget`);

  // A source opens the article in the panel; the header's box opens the assistant again, as it was.
  await source.first().click();
  await expect(panel.getByRole("heading", { name: "Inviting your team" })).toBeVisible();
  await expect(assistant).toBeHidden();
  await openAssistant(visitor);
  await expect(conversation.getByText("Only owners and admins can send invites.")).toBeVisible();
  // So does a reload (for the tab's session).
  await visitor.reload();
  await openAssistant(visitor);
  await expect(conversation).toContainText(followUp);

  // A question that fails to reach the server (offline) says so, with Try again, rather than thinking forever.
  await offline();
  await assistant.getByRole("textbox", { name: "Ask a follow-up" }).fill("Is there an API?");
  await assistant.getByRole("button", { name: "Send" }).click();
  await expect(conversation.getByText("Couldn't reach the assistant. Try again.")).toBeVisible();
  await visitor.unroute("**/*");
  await conversation.getByRole("button", { name: "Try again" }).click();
  await expect(conversation.getByText("I don't know")).toBeVisible();

  // Something the docs don't cover: "I don't know", without asking the model, and a way to post it as feedback.
  const unrelated = "Can I pay with crypto?";
  await assistant.getByRole("textbox", { name: "Ask a follow-up" }).fill(unrelated);
  await assistant.getByRole("textbox", { name: "Ask a follow-up" }).press("Enter");
  await expect(conversation.getByText("I don't know")).toHaveCount(2);
  await checkpoint(visitor, "portal-docs-ai-no-answer", { fullPage: false });
  expect((await modelRequests()).filter((request) => request.user.includes(unrelated))).toEqual([]);
  await conversation.getByRole("link", { name: "Post this as feedback" }).last().click();
  await expect(panel.getByLabel("Title")).toHaveValue(unrelated);
  await checkpoint(visitor, "portal-docs-ai-post-as-feedback");
  await panel.getByRole("button", { name: "Submit post" }).click();
  await expect(panel.getByText("Feedback posted")).toBeVisible();
  await visitor.goto("/feedback/feature-requests");
  await expect(visitor.getByRole("link", { name: unrelated })).toBeVisible();

  // What the AI cost the project this month, in AI credits (Usage, on Settings → Billing; its old address lands there)…
  await team.goto(`/app/${slug}/settings/usage`);
  await team.waitForURL(`**/app/${slug}/settings/billing#usage`);
  const spent = team.getByRole("table", { name: /^AI use in / });
  await expect(spent.getByRole("columnheader", { name: "Credits" })).toBeVisible();
  await expect(spent.getByRole("row", { name: /AI answers/ })).toBeVisible();
  await checkpoint(team, "team-settings-usage");
  // …taken from the free credits every project starts with, on the same page.
  await expect(team.getByText(/^[\d,.]+ AI credits$/)).toBeVisible();
  await expect(team.getByRole("table", { name: "AI credits left" }).getByRole("row", { name: /Free credits/ })).toBeVisible();
  await checkpoint(team, "team-settings-billing");

  // The conversation is the reader's: signed out, the assistant starts afresh (a follow-up only continues their own).
  await visitor.goto("/docs");
  await visitor.getByRole("button", { name: "Account" }).click();
  await visitor.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(visitor.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
  await visitor.goto("/docs");
  await openAssistant(visitor);
  await expect(conversation).toContainText("Ask anything about Acme.");
  await expect(conversation).not.toContainText(question);

  await assistant.getByRole("textbox", { name: "Ask a question" }).fill("Is there an API?");
  await assistant.getByRole("button", { name: "Send" }).click();
  await expect(conversation.getByText("I don't know")).toBeVisible();
  // A conversation that isn't theirs any more (their reader cookie is gone): the next question starts a new one.
  await visitor.context().clearCookies({ name: "tuti_reader" });
  await assistant.getByRole("textbox", { name: "Ask a follow-up" }).fill("Do you have an app?");
  await assistant.getByRole("button", { name: "Send" }).click();
  await expect(conversation).toContainText("Do you have an app?");
  await expect(conversation.getByText("I don't know")).toHaveCount(1);
  await expect(conversation).not.toContainText("Is there an API?");

  // The trash starts over.
  await assistant.getByRole("button", { name: "Clear the conversation" }).click();
  await expect(conversation).toContainText("Ask anything about Acme.");
  await expect(conversation).not.toContainText("Do you have an app?");
  await assistant.getByRole("button", { name: "Close the assistant" }).click();
  await expect(assistant).toBeHidden();

  // Where the browser won't store anything (storage blocked or full), the assistant still works, and so does the page.
  const unstored = await newPerson(browser, portalUrl(slug));
  await unstored.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Blocked", "SecurityError");
    };
  });
  await unstored.goto("/docs");
  await openAssistant(unstored);
  const unstoredAssistant = unstored.frameLocator('iframe[title="Feedback"]').getByRole("dialog", { name: "Assistant" });
  await unstoredAssistant.getByRole("textbox", { name: "Ask a question" }).fill("Is there an API?");
  await unstoredAssistant.getByRole("button", { name: "Send" }).click();
  await expect(unstoredAssistant.getByText("I don't know")).toBeVisible();
  // A search's "Ask a follow-up" there too: its answer goes to the assistant with it, not through storage.
  await unstored.goto(`/docs?${new URLSearchParams({ q: "Is there a light mode?" })}`);
  const unstoredAnswer = unstored.getByRole("region", { name: "AI answer" });
  await unstoredAnswer.getByRole("button", { name: "Ask AI" }).click();
  await expect(unstoredAnswer.getByText("I don't know")).toBeVisible();
  await unstoredAnswer.getByRole("button", { name: "Ask a follow-up" }).click();
  await expect(unstoredAssistant.getByRole("log", { name: "Conversation" })).toContainText("Is there a light mode?");

  // Asked on the search page (a link to /docs?q=), the answer can go on in the assistant: the same answer, not asked again.
  const ai = visitor.getByRole("region", { name: "AI answer" });
  // Another question it can't answer.
  const another = "Is there a dark mode?";
  await visitor.goto(`/docs?${new URLSearchParams({ q: another })}`);
  await ai.getByRole("button", { name: "Ask AI" }).click();
  await expect(ai.getByText("I don't know")).toBeVisible();
  const answers = (await modelRequests()).length;
  await ai.getByRole("button", { name: "Ask a follow-up" }).click();
  await expect(conversation).toContainText(another);
  await expect(conversation.getByText("I don't know")).toBeVisible();
  expect((await modelRequests()).length).toBe(answers);
  await assistant.getByRole("button", { name: "Close the assistant" }).click();

  // An off-limits topic: the fixed reply, without asking the model.
  const offLimits = "Can I get a Refund for last month?";
  await visitor.goto(`/docs?${new URLSearchParams({ q: offLimits })}`);
  await ai.getByRole("button", { name: "Ask AI" }).click();
  await expect(ai.getByText("I can't help with that here.")).toBeVisible();
  await expect(ai.getByRole("link", { name: "Post this as feedback" })).toBeVisible();
  await checkpoint(visitor, "portal-docs-ai-off-limits");
  expect((await modelRequests()).filter((request) => request.user.includes(offLimits))).toEqual([]);

  // The team sees them in Reporting's unanswered questions (the answered question isn't one), each with why.
  await team.goto(`/app/${slug}/reporting/unanswered`);
  const gap = (text: string) => team.getByRole("list", { name: "Unanswered questions" }).getByRole("listitem").filter({ hasText: text });
  await expect(gap(unrelated)).toContainText("1 unanswered");
  await expect(gap(unrelated)).toContainText("No matching article");
  // A follow-up says what it followed.
  await expect(gap(unrelated)).toContainText("Asked after “Is there an API?”");
  await expect(gap(another)).toBeVisible();
  await expect(gap(offLimits)).toContainText("Off-limits");
  // (Its follow-up's row says it came after it: a row of its own would have it as its title, the whole text.)
  await expect(gap(question).filter({ has: team.getByText(question, { exact: true }) })).toHaveCount(0);
  // The follow-up's answer, marked unhelpful, cited an article: it's offered to improve.
  await expect(gap(followUp)).toContainText("Answer, from “Inviting your team”: Only owners and admins can send invites.");
  await expect(gap(followUp)).toContainText(`Asked after “${question}”`);
  await checkpoint(team, "team-docs-gaps");
  // Dismissing one hides it, as a search too (and from Home).
  await gap(another).getByRole("button", { name: "Dismiss" }).click();
  await expect(team.getByText("Dismissed")).toBeVisible();
  await expect(gap(another)).toHaveCount(0);
  // "Write an article" starts one with the question as its title.
  await gap(unrelated).getByRole("link", { name: "Write an article" }).click();
  await team.waitForURL(`**/app/${slug}/docs/new?title=*`);
  await expect(team.getByLabel("Title")).toHaveValue(unrelated);
  await checkpoint(team, "team-docs-gap-new-article");
  // Improve the article opens it in the editor.
  await team.goto(`/app/${slug}/reporting/unanswered`);
  await gap(followUp).getByRole("link", { name: "Improve the article “Inviting your team”" }).click();
  await team.waitForURL(`**/app/${slug}/docs/inviting-your-team`);

  // Reporting's AI conversations: each conversation with the AI, its follow-ups in it, whether it was answered, opened to read it.
  await team.goto(`/app/${slug}/reporting/ai-conversations`);
  const aiConversation = (text: string) =>
    team.getByRole("list", { name: "AI conversations" }).getByRole("listitem").filter({ has: team.locator("summary", { hasText: text }) });
  await expect(aiConversation(question)).toContainText("Partly answered");
  // Asked through the portal's own widget, it's the portal's question.
  await expect(aiConversation(question)).toContainText("Portal");
  await expect(aiConversation(another)).toContainText("Not answered");
  await aiConversation(question).locator("summary").click();
  await expect(aiConversation(question).getByText(unrelated, { exact: true })).toBeVisible();
  await checkpoint(team, "team-reporting-ai-conversations");
  // Many conversations come in pages of 20, the latest first; Older goes on to the next, back at the list's heading.
  await seedAiConversations(slug, 25);
  await team.reload();
  const pages = team.getByRole("navigation", { name: "Pages" });
  await expect(pages).toContainText(/1–20 of \d+/);
  await expect(pages.getByRole("link", { name: "Newer" })).toHaveCount(0);
  await pages.getByRole("link", { name: "Older" }).click();
  await team.waitForURL(`**/app/${slug}/reporting/ai-conversations?page=2#ai-history`);
  await expect(pages).toContainText(/21–\d+ of \d+/);
  await expect(team.getByRole("heading", { name: "Latest conversations" })).toBeFocused();
  await checkpoint(team, "team-reporting-ai-conversations-page-2");
  // Another range starts at its first page.
  await team.getByRole("button", { name: /^Date range: / }).click();
  await team.getByRole("menuitem", { name: "Past 7 days" }).click();
  await team.waitForURL(`**/app/${slug}/reporting/ai-conversations?range=7d`);
  await expect(pages).toContainText(/1–20 of \d+/);
});

test("with Messages on, a visitor the AI couldn't help asks a person on the portal, and the team gets it in the inbox", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // "Ask a person" starts a conversation in the inbox, so it's on with Messages in the widget (Settings → Inbox and email).
  await team.goto(`/app/${slug}/settings/ask-a-person`);
  await team.waitForURL(`**/app/${slug}/settings/support`);
  await expect(team.getByText("“Ask a person” after an AI answer starts a conversation here too")).toBeVisible();
  await team.getByRole("switch", { name: "Messages in the widget" }).click();
  await expect(team.getByText("Messages on")).toBeVisible();
  await checkpoint(team, "team-support-messages-on");

  // A visitor asks something the docs don't cover.
  const visitor = await signUp(browser, portalUrl(slug), "Vera Visitor");
  const question = `Can I pay with crypto for ${slug}?`;
  await visitor.goto(`/docs?${new URLSearchParams({ q: question })}`);
  const ai = visitor.getByRole("region", { name: "AI answer" });
  await ai.getByRole("button", { name: "Ask AI" }).click();
  await expect(ai.getByText("I don't know")).toBeVisible();
  await ai.getByRole("button", { name: "Ask a person" }).click();
  const form = ai.getByRole("form", { name: "Ask a person" });
  await expect(form).toContainText("They'll reply in Messages.");
  // Signed in: the conversation is theirs, so their email is shown, read-only.
  await expect(form.getByLabel("Your email")).toHaveValue(visitor.email);
  await expect(form.getByLabel("Your email")).toHaveAttribute("readonly");
  await form.getByLabel("Anything to add? (optional)").fill("We'd like to pay yearly.");
  await checkpoint(visitor, "portal-docs-ask-a-person");
  await nextModelReply("They want to pay for Acme in crypto, yearly.", question);
  await form.getByRole("button", { name: "Send to the team" }).click();
  await expect(ai.getByText("We've passed this to the team. Their reply will show in Messages.")).toBeVisible();
  await checkpoint(visitor, "portal-docs-asked-a-person");
  // Messages are the widget's, on a page of their own: theirs is there.
  const [messages] = await Promise.all([visitor.context().waitForEvent("page"), ai.getByRole("link", { name: "Open Messages" }).click()]);
  await expect(messages.getByRole("list", { name: "Conversations" })).toContainText(question);

  // The team gets it in the inbox, with the AI's summary as a note.
  await team.goto(`/app/${slug}/inbox`);
  await team.getByRole("main").getByRole("listitem").filter({ hasText: question }).getByRole("link").click();
  const thread = team.getByRole("list", { name: "Messages" }).getByRole("listitem");
  await expect(thread.first()).toContainText("We'd like to pay yearly.");
  await expect(thread.last()).toContainText("Summary: They want to pay for Acme in crypto, yearly.");

  // Reporting's unanswered questions say it went to a person.
  await team.goto(`/app/${slug}/reporting/unanswered`);
  const gap = team.getByRole("list", { name: "Unanswered questions" }).getByRole("listitem").filter({ hasText: question });
  await expect(gap).toContainText("Passed to your team");
  await checkpoint(team, "team-docs-gap-escalated");
  // Reporting's AI conversations link to the conversation it started in the Inbox.
  await team.goto(`/app/${slug}/reporting/ai-conversations?show=escalated`);
  await team.getByRole("list", { name: "AI conversations" }).locator("summary").filter({ hasText: question }).click();
  await expect(team.getByRole("link", { name: /^Passed to your team: conversation #\d+$/ })).toBeVisible();
  await checkpoint(team, "team-reporting-ai-passed-to-team");
  await team.setViewportSize({ width: 390, height: 844 });
  await checkpoint(team, "team-reporting-ai-passed-to-team-phone");
  await team.setViewportSize({ width: 1280, height: 720 });
  await team.getByRole("link", { name: /^Passed to your team: conversation #\d+$/ }).click();
  await team.waitForURL(`**/app/${slug}/inbox/*`);
  await expect(team.getByRole("list", { name: "Messages" }).getByRole("listitem").first()).toContainText("We'd like to pay yearly.");
});

test("a docs-first team makes the docs the portal's home page", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(team, "Acme", slug);
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/");
  await expect(visitor).toHaveURL(`${portalUrl(slug)}/feedback/feature-requests`);

  await team.goto(`/app/${slug}/customize/home-page`);
  await team.getByRole("combobox", { name: "Home page" }).click();
  await team.getByRole("option", { name: "Docs" }).click();
  await expect(team.getByText("Your portal opens with docs now")).toBeVisible();
  await checkpoint(team, "settings-home-page");
  await visitor.goto("/");
  await expect(visitor).toHaveURL(`${portalUrl(slug)}/docs`);
});

test("the docs' home shows a tab with nothing in it yet, linking to its page", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/tabs", { name: "Guides" });

  await team.goto(`/app/${slug}/docs`);
  await team.locator(".docs-tab-switcher").click();
  await team.getByRole("link", { name: "Guides", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/tabs/guides`);
});

test("the team's docs lists (Content, a collection's page, a tab's page): in reading order, a status only where work waits, and each article's views and helpful answers", async ({
  browser,
}, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/collections", { name: "Getting started" });
  // In reading order: published, a draft, then published with an edit not published yet.
  const invite = await api("/articles", { title: "Inviting your team", body: "Words.", collection: "getting-started" });
  await api(`/articles/${invite.slug}/publish`, {});
  await api("/articles", { title: "Billing basics", body: "Words.", collection: "getting-started" });
  const board = await api("/articles", { title: "Your first board", body: "Words.", collection: "getting-started" });
  await api(`/articles/${board.slug}/publish`, {});
  await api("/articles/your-first-board", { body: "New words." }, "PATCH");
  await api("/collections", { name: "Workspaces", parent: "getting-started" });
  // A second collection, after it: folded on the docs' home.
  await api("/collections", { name: "Account" });
  // In no collection, in reading order: published, then a draft.
  const pricing = await api("/articles", { title: "Pricing", body: "Words." });
  await api(`/articles/${pricing.slug}/publish`, {});
  await api("/articles", { title: "Refunds", body: "Words." });
  await api("/tabs", { name: "Guides" });

  // A reader reads the published one and says it helped.
  const visitor = await newPerson(browser, portalUrl(slug));
  // Its view is counted as the page opens (the answer's action runs after it anyway): waited for, so the count is there.
  const viewed = visitor.waitForResponse((response) => response.request().method() === "POST" && !!response.request().headers()["next-action"]);
  await visitor.goto("/docs/inviting-your-team");
  await viewed;
  await visitor.getByRole("region", { name: "Was this helpful?" }).getByRole("button", { name: "Yes" }).click();
  await expect(visitor.getByText("Thanks for letting us know.")).toBeVisible();

  await team.goto(`/app/${slug}/docs`);
  // The overview separates live readership from the saved versions waiting to publish.
  await expect(team.getByRole("region", { name: "At a glance" })).toContainText("3Live articles");
  const waiting = team.getByRole("region", { name: /Waiting to publish/ }).getByRole("listitem");
  await expect(waiting).toHaveText([/^Refunds.*Publish$/, /^Your first board.*Publish$/, /^Billing basics.*Publish$/]);
  const mostRead = team.getByRole("region", { name: /Most read/ }).getByRole("listitem");
  await expect(mostRead.filter({ hasText: "Inviting your team" })).toContainText("1");
  await checkpoint(team, "team-docs-list-statuses");
  await team.setViewportSize({ width: 390, height: 844 });
  await checkpoint(team, "team-docs-list-statuses-phone");
  await team.emulateMedia({ colorScheme: "dark" });
  await checkpoint(team, "team-docs-list-statuses-phone-dark");
  await team.setViewportSize({ width: 1280, height: 720 });
  await team.emulateMedia({ colorScheme: "light" });

  // The collection's own page lists them the same way, then the collections in it.
  await team.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Getting started", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/collections/getting-started`);
  const own = team.getByRole("region", { name: "Getting started" }).getByRole("listitem");
  // Then a row to write another in it.
  await expect(own).toHaveText([/^Inviting your team/, /^Billing basics/, /^Your first board/, /^Workspaces.*0 articles/, "New articleNew collection"]);
  await expect(own.nth(1)).toContainText("Draft");
  await expect(own.nth(2)).toContainText("Unpublished changes");
  await expect(own.nth(0)).toContainText("1 view in 30 days");
  await expect(own.nth(0)).toContainText("1 found it helpful");
  await expect(own.getByRole("link", { name: "New article" })).toHaveAttribute("href", `/app/${slug}/docs/new?collection=getting-started`);
  await checkpoint(team, "team-docs-collection-statuses");
  await own.nth(0).dragTo(own.nth(2));
  await expect(team.getByText("Article order saved")).toBeVisible();
  await expect(own).toHaveText([/^Billing basics/, /^Your first board/, /^Inviting your team/, /^Workspaces/, "New articleNew collection"]);
  await own.nth(2).dragTo(own.nth(0));
  await expect(own.nth(0)).toContainText("Inviting your team");
  await team.setViewportSize({ width: 390, height: 844 });
  await checkpoint(team, "team-docs-collection-statuses-phone");
  await team.setViewportSize({ width: 1280, height: 720 });

  // So does a tab's page, for its articles in no collection.
  await team.goto(`/app/${slug}/docs/tabs/guides`);
  const loose = team.getByRole("region", { name: "Not in a collection" }).getByRole("listitem");
  await expect(loose).toHaveText([/^Pricing/, /^Refunds/]);
  await expect(loose.nth(1)).toContainText("Draft");
  // Not read lately: 0 in its column.
  await expect(loose.nth(0)).toContainText("0 views in 30 days");
  await expect(loose.nth(0)).not.toContainText(/Draft|Unpublished changes/);
  await checkpoint(team, "team-docs-tab-statuses");
  await team.setViewportSize({ width: 390, height: 844 });
  await checkpoint(team, "team-docs-tab-statuses-phone");
  await team.setViewportSize({ width: 1280, height: 720 });
});

test("a collection's settings are one page: its name, description, icon and place, then who can read it, with one Save", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/collections", { name: "Getting started", access: "signed_in" });
  await api("/collections", { name: "Billing" });

  await team.goto(`/app/${slug}/docs/collections/billing`);
  await team.getByRole("navigation", { name: "Collection" }).getByRole("link", { name: "Settings" }).click();
  await team.waitForURL(`**/app/${slug}/docs/collections/billing/settings`);
  await expect(team.getByRole("heading", { level: 1 })).toHaveText("Billing");
  const details = team.getByRole("region", { name: "Details" });
  const access = team.getByRole("region", { name: "Access" });
  await expect(details.getByLabel("Name")).toHaveValue("Billing");
  await expect(access.getByRole("radio", { name: "Inherit" }).first()).toBeChecked();
  // One Save for both, in the page's heading.
  const save = team.getByRole("button", { name: "Save" });
  await expect(save).toHaveCount(1);
  await expect(save).toBeInViewport();
  await checkpoint(team, "team-docs-collection-settings");
  await team.setViewportSize({ width: 390, height: 844 });
  await checkpoint(team, "team-docs-collection-settings-phone");
  await team.setViewportSize({ width: 1280, height: 720 });

  // Its details: renamed, the page follows.
  await details.getByLabel("Name").fill("Invoices");
  await details.getByLabel("Description").fill("Paying and downloading invoices.");
  await expect(details.getByText(`${"Paying and downloading invoices.".length} / 300`, { exact: true })).toBeVisible();
  await details.getByRole("button", { name: "Add icon" }).click();
  const picker = team.getByRole("dialog", { name: "Pick an icon" });
  await picker.getByRole("searchbox", { name: "Search icons" }).fill("receipt");
  await picker.getByRole("button", { name: "receipt", exact: true }).click();
  await expect(picker).toBeHidden();
  // Anyone can read what it inherits now; in Getting started, only signed-in readers: Access says so before saving.
  const withoutAccess = access.getByRole("group", { name: "People without access" });
  await expect(withoutAccess).toHaveCount(0);
  await details.getByRole("combobox", { name: "Parent collection" }).click();
  await team.getByRole("option", { name: "Getting started" }).click();
  await access.locator("summary").filter({ hasText: "People without access" }).click();
  await expect(withoutAccess).toBeVisible();
  // Meanwhile someone else makes it for signed-in readers: the rename, its access untouched here, keeps that.
  await api("/collections/billing", { access: "signed_in" }, "PATCH");
  await save.click();
  await expect(team.getByText("Collection saved")).toBeVisible();
  await team.waitForURL(`**/app/${slug}/docs/collections/invoices/settings`);
  await team.reload();
  await expect(access.getByRole("radio", { name: "Signed-in readers" })).toBeChecked();
  await expect(details.getByLabel("Name")).toHaveValue("Invoices");
  await expect(details.getByLabel("Description")).toHaveValue("Paying and downloading invoices.");
  await expect(details.getByRole("button", { name: "receipt Change icon" })).toBeVisible();
  await expect(details.getByRole("combobox", { name: "Parent collection" })).toContainText("Getting started");

  // Changed elsewhere again, then a save of the description alone: it doesn't undo it.
  await api("/collections/invoices", { access: "inherit" }, "PATCH");
  await details.getByLabel("Description").fill("Downloading invoices.");
  // The save (a server action: a POST to the page) done, then the page as stored.
  const saved = team.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/invoices/settings"));
  await save.click();
  await saved;
  await team.reload();
  await expect(details.getByLabel("Description")).toHaveValue("Downloading invoices.");
  await expect(access.getByRole("radio", { name: "Inherit" }).first()).toBeChecked();

  // Moved elsewhere after a save, a description-only save keeps it where it was moved.
  await details.getByLabel("Description").fill("Invoices, paid and to pay.");
  const savedOnce = team.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/invoices/settings"));
  await save.click();
  await savedOnce;
  await api("/collections/invoices", { parent: null }, "PATCH");
  await details.getByLabel("Description").fill("Paying and downloading invoices.");
  const savedAgain = team.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/invoices/settings"));
  await save.click();
  await savedAgain;
  await team.reload();
  await expect(details.getByLabel("Description")).toHaveValue("Paying and downloading invoices.");
  await expect(details.getByRole("combobox", { name: "Parent collection" })).toContainText("None (top level)");

  // What's typed and not saved stays through a refresh (a move in the tree beside it), with another field
  // changed elsewhere meanwhile: the save sends the description alone, so that change stays too.
  await details.getByLabel("Description").fill("Typed, not saved yet.");
  await api("/collections/invoices", { icon: "wallet" }, "PATCH");
  const tree = team.getByRole("navigation", { name: "Docs", exact: true });
  await tree.getByRole("button", { name: "Move Invoices" }).click();
  await team.getByRole("menuitem", { name: "Move up" }).click();
  await expect(team.getByText("Invoices moved")).toBeVisible();
  await expect(tree.getByRole("link", { name: "Invoices" }).locator("svg.lucide-wallet")).toBeVisible();
  await expect(details.getByLabel("Description")).toHaveValue("Typed, not saved yet.");
  const savedTyped = team.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/invoices/settings"));
  await save.click();
  await savedTyped;
  await team.reload();
  await expect(details.getByLabel("Description")).toHaveValue("Typed, not saved yet.");
  await expect(details.getByRole("button", { name: "wallet Change icon" })).toBeVisible();

  // Moved in the tree, then Parent picked as it shows (away and back): the choice made is what's saved.
  await tree.getByRole("button", { name: "Move Invoices" }).click();
  await team.getByRole("menuitem", { name: "Move to…" }).press("ArrowRight");
  await team.getByRole("menuitem", { name: "Getting started", exact: true }).press("Enter");
  // (The reload above cleared the earlier toasts.)
  await expect(team.getByText("Invoices moved")).toBeVisible();
  await expect(details.getByRole("combobox", { name: "Parent collection" })).toContainText("None (top level)");
  await details.getByRole("combobox", { name: "Parent collection" }).click();
  await team.getByRole("option", { name: "Getting started" }).click();
  await details.getByRole("combobox", { name: "Parent collection" }).click();
  await team.getByRole("option", { name: "None (top level)" }).click();
  const savedPlace = team.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/invoices/settings"));
  await save.click();
  await savedPlace;
  await team.reload();
  await expect(details.getByRole("combobox", { name: "Parent collection" })).toContainText("None (top level)");

  // Typed while a save is on its way: the next save sends it.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await team.route("**/invoices/settings", async (route) => {
    if (route.request().method() === "POST") {
      await held;
    }
    await route.continue();
  });
  await details.getByLabel("Description").fill("Saving this.");
  const savedHeld = team.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/invoices/settings"));
  await save.click();
  await details.getByLabel("Description").fill("Typed while saving.");
  release();
  await savedHeld;
  await team.unroute("**/invoices/settings");
  await expect(team.getByText("Collection saved").first()).toBeVisible();
  const savedLater = team.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/invoices/settings"));
  await save.click();
  await savedLater;
  await team.reload();
  await expect(details.getByLabel("Description")).toHaveValue("Typed while saving.");

  // Who can read it, changed here, saves; the name stays.
  await access.getByRole("radio", { name: "Signed-in readers" }).check();
  await save.click();
  await expect(team.getByText("Collection saved").first()).toBeVisible();
  await team.reload();
  await expect(access.getByRole("radio", { name: "Signed-in readers" })).toBeChecked();
  await expect(details.getByLabel("Name")).toHaveValue("Invoices");

  // Back to its page, at the top level now.
  await team.getByRole("link", { name: "Invoices" }).first().click();
  await team.waitForURL(`**/app/${slug}/docs/collections/invoices`);
  await expect(team.getByRole("heading", { level: 1 })).toHaveText("Invoices");
});

test("on a phone, a page's actions are a menu from the top bar", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  const article = await api("/articles", { title: "Invite your team", body: "Open Team in the sidebar." });

  await team.setViewportSize({ width: 390, height: 844 });
  await team.goto(`/app/${slug}/docs/${article.slug}`);
  // An editor's own actions stay in a bar at the bottom (History, Verify, Save, Publish); the rest (Delete) are the top bar's menu.
  await expect(team.getByRole("button", { name: "History", exact: true })).toBeVisible();
  await expect(team.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  const remove = team.getByRole("button", { name: "Delete" });
  await expect(remove).toBeHidden();
  const more = team.getByRole("button", { name: "More actions" });
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(remove).toBeVisible();
  await checkpoint(team, "team-docs-article-actions-phone", { fullPage: false });
  // Escape closes the menu; from one of its actions, focus goes back to its button.
  await remove.focus();
  await team.keyboard.press("Escape");
  await expect(remove).toBeHidden();
  await expect(more).toBeFocused();
  // Settings, in the bar (its gear), opens its dialog.
  await team.getByRole("button", { name: "Settings" }).click();
  const settings = team.getByRole("region", { name: "Article settings" });
  await expect(settings).toBeVisible();
  await team.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // The overview keeps Add content directly in reach on a phone.
  await team.goto(`/app/${slug}/docs`);
  await team.locator('[data-slot="docs-page-header"]').getByRole("button", { name: "Add content" }).click();
  await team.getByRole("menuitem", { name: "New collection" }).click();
  await expect(team.getByRole("dialog", { name: "New collection" })).toBeVisible();
  // The dialog hides the page from role queries, so both menus are checked by their markup.
  await expect(team.locator('[role="menu"]')).toHaveCount(0);
});

test("a long article's History scrolls in its panel, its changes whole", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  const paragraphs = (word: string) => Array.from({ length: 30 }, (_, i) => `${word} paragraph ${i + 1}, long enough to take a line or two.`).join("\n\n");
  const article = await api("/articles", { title: "A long one", body: paragraphs("First") });
  await api(`/articles/${article.slug}`, { body: paragraphs("Second") }, "PATCH");

  await team.goto(`/app/${slug}/docs/${article.slug}?history`);
  const panel = team.getByRole("complementary", { name: "Article tools" });
  await panel.getByRole("link", { name: /^Saved / }).last().click();
  const changes = panel.getByRole("region", { name: "Changes since this version" });
  await expect(changes).toContainText("First paragraph 30");
  await checkpoint(team, "team-docs-article-history-long", { fullPage: false });
  // The changes aren't cut short to fit the window: the panel scrolls to their end, and to the versions under them.
  expect(await changes.evaluate((card) => card.scrollHeight - card.clientHeight)).toBeLessThanOrEqual(1);
  await panel.getByRole("link", { name: /^Saved / }).first().scrollIntoViewIfNeeded();
  await expect(panel.getByRole("link", { name: /^Saved / }).first()).toBeInViewport();
  await checkpoint(team, "team-docs-article-history-long-end", { fullPage: false });
});

test("an article ends with the previous and next in reading order, related ones, and “Still stuck?” with only what the team set up", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  for (const name of ["Getting started", "Billing"]) {
    await api("/collections", { name });
  }
  // Installing and paying invoices read alike (their sections' embeddings); the rest are unrelated.
  await similar("Installing\n\nAdd the script to your site.", "Paying invoices\n\nPay invoices by card from Billing.", 0.9);
  for (const [title, body, collection] of [
    ["Welcome", "What Acme does.", "getting-started"],
    ["Installing", "Add the script to your site.", "getting-started"],
    ["Plans", "Free and Business.", "billing"],
    ["Paying invoices", "Pay invoices by card from Billing.", "billing"],
  ]) {
    const article = await api("/articles", { title, body, collection });
    await api(`/articles/${article.slug}/publish`, {});
  }

  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs/installing");
  const main = visitor.getByRole("main");
  // Previous and next in reading order: into Billing at Getting started's end.
  const steps = main.getByRole("navigation", { name: "Previous and next" });
  await expect(steps.getByRole("link")).toHaveText([/Previous\s*Welcome/, /Next\s*Plans/]);
  // Related: the one alike in meaning, from another collection.
  await expect(main.getByRole("region", { name: "Related articles" }).getByRole("link")).toHaveText(["Paying invoices"]);
  // Still stuck: Ask AI (the portal has AI answers), and no way to reach the team: it answers no messages yet.
  const stuck = main.getByRole("region", { name: "Still stuck?" });
  await expect(stuck.getByRole("button", { name: "Ask AI" })).toBeVisible();
  await expect(stuck.getByRole("link")).toHaveCount(0);
  // "Was this helpful?" stays.
  await expect(main.getByRole("region", { name: "Was this helpful?" })).toBeVisible();
  // Ask AI opens the widget's assistant.
  await stuck.getByRole("button", { name: "Ask AI" }).click();
  const stuckAssistant = visitor.frameLocator('iframe[title="Feedback"]').getByRole("dialog", { name: "Assistant" });
  await expect(stuckAssistant).toBeVisible();
  await stuckAssistant.getByRole("button", { name: "Close the assistant" }).click();
  await expect(stuckAssistant).toBeHidden();
  await visitor.reload();

  // Once it answers messages (Messages in the widget, which gives it its support address), "Contact us": an email to
  // that address… (A server that receives no email has no address: the widget's Messages on a page of their own.)
  await api("/support", { inbox: true }, "PATCH");
  await visitor.reload();
  const contactUs = stuck.getByRole("link", { name: "Contact us" });
  await expect(contactUs).toHaveAttribute("href", `mailto:support@${slug}.${SUPPORT_EMAIL_DOMAIN}`);
  await checkpoint(visitor, "portal-article-end-contact-us");
  // …and in the widget, where the team's own code puts it on the page.
  await visitor.evaluate(() => {
    (window as { Tuti?: unknown }).Tuti = { open: (options: unknown) => document.body.setAttribute("data-opened", JSON.stringify(options)) };
  });
  await contactUs.click();
  await expect(visitor.locator("body")).toHaveAttribute("data-opened", '{"tab":"messages"}');
  await expect(visitor).toHaveURL(/\/docs\/installing$/);

  await checkpoint(visitor, "portal-article-end");
  await visitor.emulateMedia({ colorScheme: "dark" });
  await checkpoint(visitor, "portal-article-end-dark");
  await visitor.setViewportSize({ width: 390, height: 844 });
  await expect(contactUs).toBeVisible();
  await checkpoint(visitor, "portal-article-end-phone-dark");
  await visitor.emulateMedia({ colorScheme: "light" });
  await checkpoint(visitor, "portal-article-end-phone");

  // Next goes on; the first article has no previous, the last no next.
  await steps.getByRole("link", { name: /Next/ }).click();
  await visitor.waitForURL("**/docs/plans");
  await expect(steps.getByRole("link")).toHaveText([/Previous\s*Installing/, /Next\s*Paying invoices/]);
  await visitor.goto("/docs/welcome");
  await expect(steps.getByRole("link")).toHaveText([/Next\s*Installing/]);
  await visitor.goto("/docs/paying-invoices");
  await expect(steps.getByRole("link")).toHaveText([/Previous\s*Plans/]);
});

test("a link in an article to another of the portal's articles stays on the portal and previews it; in the widget it opens in the panel", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/collections", { name: "Billing" });
  // Long enough that a panel left scrolled down would stay scrolled down in it.
  const steps = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: download them from Billing.`).join("\n\n");
  const invoices = await api("/articles", { title: "Invoices", body: steps, description: "Where to find and download them.", collection: "billing" });
  await api(`/articles/${invoices.slug}/publish`, {});
  // One for signed-in readers only (shown to others with a lock), and one whose address changed since it was linked to.
  const pro = await api("/articles", { title: "Pro features", body: "What Pro adds.", access: "signed_in", noAccess: "lock" });
  await api(`/articles/${pro.slug}/publish`, {});
  const refunds = await api("/articles", { title: "Refunds", body: "How refunds work.", collection: "billing" });
  await api(`/articles/${refunds.slug}/publish`, {});
  await api(`/articles/${refunds.slug}`, { newSlug: "returns" }, "PATCH");
  // The team links to them by their Tuti addresses (as they'd copy them), one to a heading; and to another site. And far
  // down a long article, once more.
  const text = (words: string, href?: string) => ({ type: "text", text: words, ...(href && { marks: [{ type: "link", attrs: { href } }] }) });
  const at = (page: string) => `${portalUrl(slug)}/docs/${page}`;
  const content = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          text("See "),
          text("your invoices", `${at(invoices.slug)}#download`),
          text(", "),
          text("what Pro adds", at(pro.slug)),
          text(", "),
          text("refunds", at(refunds.slug)),
          text(", or "),
          text("our status page", "https://status.example.com"),
        ],
      },
      ...Array.from({ length: 40 }, (_, i) => ({ type: "paragraph", content: [text(`Step ${i + 1} of setting up billing.`)] })),
      { type: "paragraph", content: [text("Done? Find "), text("the invoices article", at(invoices.slug))] },
    ],
  };
  const guide = await api("/articles", { title: "Billing basics", content });
  await api(`/articles/${guide.slug}/publish`, {});

  // On the portal: the article's link stays here, in this tab; the other site's opens in a new one.
  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto(`/docs/${guide.slug}`);
  const body = reader.getByRole("article");
  const link = body.getByRole("link", { name: "your invoices" });
  await expect(link).toHaveAttribute("href", `/docs/${invoices.slug}#download`);
  await expect(link).not.toHaveAttribute("target", /.*/);
  await expect(body.getByRole("link", { name: "our status page" })).toHaveAttribute("target", "_blank");
  // An address that changed: the link goes where the article is now.
  await expect(body.getByRole("link", { name: "refunds", exact: true })).toHaveAttribute("href", "/docs/returns");
  // One this reader may not open is a link here too, but without a card: nothing of it is shown.
  await expect(body.getByRole("link", { name: "what Pro adds" })).toHaveAttribute("href", `/docs/${pro.slug}`);
  await expect(body.getByRole("link", { name: "what Pro adds" })).not.toHaveAttribute("data-preview");
  await expect(link).toHaveAttribute("data-preview", "");
  // Pointed at, it previews the article: its collection, title and description.
  await link.hover();
  const card = reader.locator('[data-slot="article-preview"]');
  await expect(card).toContainText("Billing");
  await expect(card).toContainText("Invoices");
  await expect(card).toContainText("Where to find and download them.");
  await checkpoint(reader, "docs-article-link-preview");
  // Clicked, it opens there.
  await link.click();
  await expect(reader).toHaveURL(`${portalUrl(slug)}/docs/${invoices.slug}#download`);
  await expect(reader.getByRole("heading", { level: 1, name: "Invoices" })).toBeVisible();

  // In the widget's Help center, it opens the article in the panel (one this reader may not open, on the portal as before),
  // at its top even from far down the article.
  await reader.goto(`/widget?tab=docs&article=${guide.slug}`);
  const panel = reader.getByRole("article");
  await expect(panel.getByRole("link", { name: "your invoices" })).toHaveAttribute("href", `/widget?tab=docs&article=${invoices.slug}#download`);
  await expect(panel.getByRole("link", { name: "what Pro adds" })).toHaveAttribute("target", "_blank");
  await panel.getByRole("link", { name: "the invoices article" }).click();
  await expect(reader).toHaveURL(`${portalUrl(slug)}/widget?tab=docs&article=${invoices.slug}`);
  await expect(reader.getByRole("heading", { name: "Invoices" })).toBeInViewport();
});

test("an article's editor bar: saved state, Publish and the pinned tools fit from tablet width up", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/articles", { title: "A draft", body: "Words." });
  await api("/articles", { title: "Inviting your team to a project with a long title", body: "Owners send invites." });
  await api("/articles/inviting-your-team-to-a-project-with-a-long-title/publish", {});
  const fill = (name: string) => team.getByRole("button", { name, exact: true }).evaluate((button) => getComputedStyle(button).backgroundColor);

  // A draft: Publish is the filled one, Save an outline beside it.
  await team.goto(`/app/${slug}/docs/a-draft`);
  const primary = await fill("Publish");
  expect(await fill("Saved")).not.toBe(primary);

  // Published, as saved: the quiet Saved control becomes Save when typing changes the article.
  await team.goto(`/app/${slug}/docs/inviting-your-team-to-a-project-with-a-long-title`);
  expect(await fill("Saved")).not.toBe(primary);
  await team.getByRole("textbox", { name: "Article" }).click();
  await team.keyboard.press("ControlOrMeta+End");
  await team.keyboard.type(" Now.");
  await expect(team.getByRole("button", { name: /^(Save|Saved|Saving…)$/ })).toHaveText("Save");
  expect(await fill("Save")).not.toBe(primary);
  await team.getByRole("button", { name: /^(Save|Saved|Saving…)$/ }).click();
  await expect(team.getByText("Saved", { exact: true }).first()).toBeVisible();

  // From a tablet up, the page owns its toolbar: no bar above it and no horizontal overflow.
  for (const width of [768, 1024, 1280]) {
    await team.setViewportSize({ width, height: 900 });
    await expect(team.locator("main > header")).toBeHidden();
    const settings = team.getByRole("button", { name: "Settings" });
    await expect(settings).toBeInViewport();
    await expect(team.getByRole("button", { name: /^(Save|Saved|Saving…)$/ })).toBeInViewport();
    expect(await team.evaluate(() => document.documentElement.scrollWidth), `at ${width}px`).toBeLessThanOrEqual(width);
  }
});
