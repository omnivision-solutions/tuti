import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";
import { modelRequests, nextModelReply } from "./model";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";
import { similar } from "./openai";

/** A Docs page's search box (the header's, or `where`'s): opens its dialog and types `query` in it. */
async function typeSearch(page: Page, query: string, where = page.getByRole("banner")) {
  await where.getByRole("button", { name: "Search the docs" }).click();
  const box = page.getByRole("dialog").getByRole("combobox", { name: "Search the docs" });
  await box.fill(query);
  return box;
}

/** The articles a Docs page's search box (the header's, or `where`'s) finds as `query` is typed, then closes it. */
async function foundAsTyped(page: Page, query: string, where = page.getByRole("banner")) {
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
  // The portal's docs are an icon beside the title.
  await expect(team.getByRole("link", { name: "Open your portal's docs" })).toHaveAttribute("href", `${portalUrl(slug)}/docs`);
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
  // Escape closes the picker, not the dialog; "Remove icon" takes it off.
  await dialog.getByRole("button", { name: "Change icon (rocket)" }).click();
  await expect(picker.getByRole("searchbox", { name: "Search icons" })).toBeFocused();
  await team.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await dialog.getByRole("button", { name: "Remove icon" }).click();
  await expect(dialog.getByRole("button", { name: "Add icon" })).toBeVisible();
  await dialog.getByRole("button", { name: "Add icon" }).click();
  await picker.getByRole("searchbox", { name: "Search icons" }).fill("rocket");
  await picker.getByRole("button", { name: "rocket", exact: true }).click();
  await dialog.getByRole("button", { name: "Add collection" }).click();
  await expect(team.getByText("Collection added")).toBeVisible();
  // The docs' home shows it as a card, with its icon; the tree is beside its page, not the home.
  await expect(team.getByRole("region", { name: "Getting started" }).locator("svg.lucide-rocket")).toBeVisible();
  await expect(teamTree).toHaveCount(0);
  await checkpoint(team, "team-docs");
  await team.getByRole("region", { name: "Getting started" }).getByRole("link", { name: "Getting started" }).click();
  await team.waitForURL(`**/app/${slug}/docs/collections/getting-started`);
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
  await team.getByRole("combobox", { name: "Collection" }).click();
  await team.getByRole("option", { name: "Getting started" }).click();
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
  await expect(blocks.getByRole("option")).toHaveText(["Table"]);
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
  await expect(team.getByRole("paragraph").filter({ hasText: /^Draft$/ })).toBeVisible();
  // Its title is in the top bar, after "← Docs" (the form's title field is under it).
  const barTitle = team.getByRole("heading", { level: 1, name: "Inviting your team" });
  expect((await barTitle.boundingBox())!.width).toBeGreaterThan(50);

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
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();
  await checkpoint(team, "team-docs-article-published");

  // The visitor finds its collection's card on the Docs tab, and reads it there.
  const scripts: Promise<string>[] = [];
  visitor.on("response", (response) => {
    if (response.request().resourceType() === "script") {
      scripts.push(response.text());
    }
  });
  await visitor.goto("/");
  await visitor.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Docs" }).click();
  const card = visitor.getByRole("list", { name: "Collections" }).getByRole("link", { name: /^Getting started/ });
  await expect(card).toContainText("The basics, in five minutes.");
  // With its icon, drawn on the server: no script the portal sends has Lucide's names (the app's picker loads them).
  await expect(card.locator("svg.lucide-rocket")).toBeVisible();
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
  const searchButton = visitor.getByRole("banner").getByRole("button", { name: "Search the docs" });
  await expect(searchButton).toHaveText(/Search docs/);
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
  // ⌘K opens it too; Escape closes it.
  await visitor.keyboard.press("ControlOrMeta+k");
  await expect(visitor.getByRole("dialog").getByRole("combobox", { name: "Search the docs" })).toBeFocused();
  await visitor.keyboard.press("Escape");
  await expect(visitor.getByRole("dialog")).toBeHidden();
  // A link to all the results (/docs?q=): the box starts from it.
  await visitor.goto("/docs?q=send+invites");
  await expect(searchButton).toHaveText(/send invites/);
  const results = visitor.getByRole("list", { name: "Search results" });
  await expect(results.getByRole("link", { name: "Inviting your team" })).toBeVisible();
  await expect(results).toContainText("Owners and admins send invites from the Team page.");
  await checkpoint(visitor, "portal-docs-search");
  await typeSearch(visitor, "refunds");
  await expect(visitor.getByRole("dialog").getByText("No articles match “refunds”.")).toBeVisible();
  // The Enter that ends composing a word with an input method (Japanese, Chinese…) is the reader's: nothing opens.
  await visitor.getByRole("dialog").getByRole("combobox", { name: "Search the docs" }).dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  await expect(visitor.getByRole("dialog").getByRole("combobox", { name: "Search the docs" })).toBeVisible();
  await expect(visitor).toHaveURL(/\/docs\?q=send\+invites$/);
  // Closed, it counts as a search (one that found nothing); so does the results page for it.
  await visitor.keyboard.press("Escape");
  await visitor.goto("/docs?q=refunds");
  await expect(visitor.getByText("No articles match “refunds”")).toBeVisible();
  await checkpoint(visitor, "portal-docs-search-empty");
  await visitor.getByRole("link", { name: "All articles" }).click();
  await expect(visitor.getByRole("list", { name: "Collections" }).getByRole("link", { name: /^Getting started/ })).toBeVisible();

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
  await team.getByRole("link", { name: "Insights" }).click();
  await team.waitForURL(`**/app/${slug}/docs/insights`);
  await expect(team.getByText("The last 30 days: 2 article views, 4 searches, 2 failed searches.")).toBeVisible();
  await expect(team.getByText("2 views · 0% found it helpful (0 of 1)")).toBeVisible();
  await expect(team.getByText("How do I invite by email?")).toBeVisible();
  await expect(team.getByText("refunds", { exact: true })).toBeVisible();
  await expect(team.getByText("2 searches", { exact: true })).toBeVisible();
  await checkpoint(team, "team-docs-insights");

  // Deleting the collection, from its page, keeps its article. While it runs (slowed down here), Delete can't be clicked again.
  await team.goto(`/app/${slug}/docs`);
  await team.getByRole("region", { name: "Getting started" }).getByRole("link", { name: "Getting started" }).click();
  await team.waitForURL(`**/app/${slug}/docs/collections/getting-started`);
  await expect(team.getByRole("tabpanel", { name: "Content" }).getByRole("listitem")).toHaveText([/^Inviting your team/]);
  await team.route("**/*", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });
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
  await expect(team.getByRole("region", { name: "Not in a collection" }).getByRole("link", { name: "Inviting your team" })).toBeVisible();
  await visitor.goto("/docs");
  await expect(visitor.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Inviting your team" })).toBeVisible();

  // The team edits it twice. It's published, so the edits wait as unpublished changes until the team publishes them.
  await team.getByRole("region", { name: "Not in a collection" }).getByRole("link", { name: "Inviting your team" }).click();
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
    await team.getByRole("button", { name: "Save", exact: true }).click();
    await saved;
    // The saved article comes back as a new form (it's keyed on the content), maybe a moment after
    // the save's response: edit that one, not the old editor on its way out.
    await expect.poll(() => before!.evaluate((element) => element.isConnected)).toBe(false);
    await expect(team.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  }
  await expect(team.getByText("Saved", { exact: true }).first()).toBeVisible();
  const original = "Owners and admins send invites from the Team page.";
  const edited = `${original} Members can ask them. Invites last a week.`;
  const unpublished = team.getByRole("region", { name: "Unpublished changes" });
  await expect(unpublished).toContainText("Readers see the published version until you publish them.");
  await checkpoint(team, "team-docs-article-unpublished-changes");
  await visitor.goto("/docs/inviting-your-team");
  await expect(visitor.getByText(original, { exact: true })).toBeVisible();
  await expect(visitor.getByText(/Members can ask them/)).toHaveCount(0);

  // Reviewed against the published version, then published.
  await unpublished.getByRole("button", { name: "Review changes" }).click();
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

  // Its history shows what changed since the first version.
  await team.getByRole("link", { name: "History" }).click();
  await team.waitForURL(`**/app/${slug}/docs/inviting-your-team/history`);
  const versions = team.getByRole("link", { name: /^Saved / });
  await expect(versions).toHaveCount(3);
  await versions.nth(2).click();
  await team.waitForURL(/\/history\?revision=/);
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
  await unpublished.getByRole("button", { name: "Discard changes" }).click();
  const discarding = team.getByRole("alertdialog");
  await expect(discarding).toContainText("The changes stay in its history");
  await discarding.getByRole("button", { name: "Discard changes" }).click();
  await expect(team.getByText("Changes discarded")).toBeVisible();
  await expect(unpublished).toHaveCount(0);
  await expect(editor).toContainText(edited);
  await team.getByRole("link", { name: "History" }).click();
  await expect(team.getByRole("link", { name: /^Saved / })).toHaveCount(5);

  // Listing: unlisted, it's gone from /docs but its link still works; hidden, its page is a 404.
  await teamTree.getByRole("link", { name: "Inviting your team" }).click();
  await team.waitForURL(`**/app/${slug}/docs/inviting-your-team`);
  // The page header's line under the title.
  const header = team.locator("p", { hasText: /^Published / });
  // In the article's settings, with what each listing means under it.
  const articleSettings = team.getByRole("dialog", { name: "Article settings" });
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
  await expect(header).toContainText("Unlisted ·");
  await checkpoint(team, "team-docs-article-unlisted");
  await visitor.goto("/docs");
  await expect(visitor.getByText("Nothing here yet")).toBeVisible();
  await visitor.goto("/docs/inviting-your-team");
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toBeVisible();

  await setListing("Hidden", "Stays published, but isn't shown anywhere, not even at its link.");
  await expect(header).toContainText("· Hidden");
  await checkpoint(team, "team-docs-article-hidden");
  expect((await visitor.goto("/docs/inviting-your-team"))!.status()).toBe(404);
  expect((await visitor.request.get(`${portalUrl(slug)}/docs/inviting-your-team.md`)).status()).toBe(404);

  await setListing("Everywhere", "In your docs, search, the widget and AI answers.");
  await visitor.goto("/docs");
  await expect(visitor.getByRole("navigation", { name: "Docs", exact: true }).getByRole("link", { name: "Inviting your team" })).toBeVisible();

  // Deleted, it leaves the portal; the team brings it back from Recently deleted, as a draft.
  await team.getByRole("button", { name: "Delete" }).click();
  const deletingArticle = team.getByRole("alertdialog");
  await expect(deletingArticle).toContainText("You can restore it from Recently deleted for 30 days.");
  await deletingArticle.getByRole("button", { name: "Delete" }).click();
  await team.waitForURL(`**/app/${slug}/docs`);
  const recentlyDeleted = team.getByRole("region", { name: "Recently deleted" });
  await expect(recentlyDeleted).toContainText("Inviting your team");
  await checkpoint(team, "team-docs-recently-deleted");
  // The filter goes through Recently deleted too.
  const filter = team.getByRole("searchbox", { name: "Filter docs" });
  await filter.fill("nothing like this");
  await expect(recentlyDeleted).toHaveCount(0);
  await expect(team.getByText("Nothing matches “nothing like this”.")).toBeVisible();
  await filter.fill("inviting");
  await expect(recentlyDeleted).toContainText("Inviting your team");
  await expect(team.getByText(/^Nothing matches/)).toHaveCount(0);
  await filter.fill("");
  await visitor.goto("/docs/inviting-your-team");
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toHaveCount(0);

  // From the keyboard: at the bottom of the page, the button can be under a toast, which waits while the pointer is over it.
  await recentlyDeleted.getByRole("button", { name: "Restore “Inviting your team”" }).press("Enter");
  await expect(team.getByText("Restored “Inviting your team” as a draft")).toBeVisible();
  await expect(team.getByRole("region", { name: "Recently deleted" })).toHaveCount(0);
  // A draft again, in no collection now.
  await expect(team.getByRole("region", { name: "Not in a collection" }).getByRole("listitem").filter({ hasText: "Inviting your team" })).toContainText("Draft");
  await checkpoint(team, "team-docs-article-restored");
});

test("the team arranges the docs: collections three levels deep, moves with the keyboard and by dragging, and the portal and widget follow", async ({
  browser,
}, testInfo) => {
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

  // The portal follows: Billing first with Invoices in it, then Getting started in its new order.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs");
  const main = visitor.getByRole("main");
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(["Billing", "Getting started"]);
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
  // Taxes (in Invoices) is closed: its articles aren't shown.
  await expect(tree.getByRole("link")).toHaveText([
    "Billing",
    "Card payments",
    "Invoices",
    "Downloading invoices",
    "Taxes",
    "Getting started",
    "Your first board",
    "Inviting your team",
  ]);
  await checkpoint(visitor, "portal-docs-collection-nested");
  await tree.getByRole("link", { name: "Taxes" }).click();
  await expect(visitor).toHaveURL(/\/docs\/taxes$/);
  await expect(tree.getByRole("link", { name: "VAT rates" })).toBeVisible();
  // On a phone, the way back to the one it's in is above it.
  await visitor.setViewportSize({ width: 390, height: 844 });
  await expect(main.getByRole("link", { name: "Invoices" })).toHaveAttribute("href", "/docs/invoices");
  await visitor.setViewportSize({ width: 1280, height: 720 });

  // The widget's Docs tab goes a level at a time: a collection opens its own list, with a way back.
  await visitor.goto("/widget?tab=docs");
  await expect(visitor.getByRole("list", { name: "Collections" }).getByRole("link")).toHaveText(["Billing", "Getting started"]);
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
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(["Getting started", "Billing"]);

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

  // Beside a collection's page: the tree. "New tab" at its bottom; the first tab takes the collections.
  await team.goto(`/app/${slug}/docs/collections/getting-started`);
  const tree = team.getByRole("navigation", { name: "Docs", exact: true });
  /** A list's own rows (not the ones nested in them). */
  const rows = (name: string) => tree.getByRole("list", { name, exact: true }).locator(":scope > li");
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
  await expect(team.getByRole("combobox", { name: "Collection" })).toContainText("Billing › Invoices");
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

  // The filter keeps what matches, with the collections it's in.
  await team.getByRole("searchbox", { name: "Filter docs" }).fill("invoic");
  await expect(tree.getByRole("link")).toHaveText(["Guides", "Billing", "Invoices", /^Downloading invoices/]);
  await team.getByRole("searchbox", { name: "Filter docs" }).fill("");

  // A tab's page: what's in it, then its Settings: the landing page.
  await tree.getByRole("link", { name: "Guides", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/tabs/guides`);
  await expect(team.getByRole("heading", { level: 1 })).toHaveText("Guides");
  await expect(team.getByRole("tabpanel", { name: "Content" }).getByRole("listitem")).toHaveText([/^Billing.*1 collection$/, /^Getting started.*1 article$/]);
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

  // A collection's page: its Access, for signed-in readers only.
  await tree.getByRole("link", { name: "Billing", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/collections/billing`);
  await expect(team.getByRole("tabpanel", { name: "Content" }).getByRole("listitem")).toHaveText([/^Invoices.*1 article/]);
  await checkpoint(team, "team-docs-collection-page");
  await team.getByRole("tab", { name: "Access" }).click();
  const access = team.getByRole("tabpanel", { name: "Access" });
  await expect(access.getByRole("radio", { name: "Inherit" })).toBeChecked();
  await access.getByRole("radio", { name: "Signed-in readers" }).check();
  // What the rest see of it, as in the dialogs: hidden by default, or shown with a lock.
  const withoutAccess = access.getByRole("group", { name: "People without access" });
  await expect(withoutAccess.getByRole("radio", { name: "Inherit" })).toBeChecked();
  await withoutAccess.getByRole("radio", { name: "Show with a lock" }).check();
  await expect(withoutAccess.getByRole("link", { name: "Preview as a reader" })).toHaveAttribute("href", `${portalUrl(slug)}/docs/billing?preview=signed-out`);
  await access.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("Collection saved")).toBeVisible();
  await tree.getByRole("link", { name: "Handbook", exact: true }).click();
  await expect(team.getByRole("tabpanel", { name: "Content" }).getByRole("listitem").first().getByText("Signed-in", { exact: true })).toBeVisible();
  await api("/articles/downloading-invoices/publish", {});
  await visitor.goto("/docs/downloading-invoices");
  await expect(visitor.getByText("Sign in to read this.")).toBeVisible();
  await expect(visitor.getByText("Every invoice is a PDF")).toHaveCount(0);

  // On a phone the tree is a "Browse docs" menu above the page.
  await team.setViewportSize({ width: 390, height: 844 });
  await expect(tree).toBeHidden();
  await team.getByRole("button", { name: "Browse docs" }).click();
  await expect(tree.getByRole("link", { name: "Handbook", exact: true })).toHaveAttribute("aria-current", "page");
  await checkpoint(team, "team-docs-tree-phone");
  await tree.getByRole("link", { name: "Getting started", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/docs/collections/getting-started`);
  await expect(tree).toBeHidden();
});

test("the team splits the docs into tabs: the first takes the collections, others get theirs by menu and by dragging", async ({
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

  // The first tab, from "New tab" under the tree: the dialog says the collections go in it.
  await team.goto(`/app/${slug}/docs/collections/getting-started`);
  const structure = team.getByRole("navigation", { name: "Docs", exact: true });
  // A list's own rows (not the ones nested in them).
  const rows = (name: string) => structure.getByRole("list", { name, exact: true }).locator(":scope > li");
  await team.getByRole("button", { name: "New tab" }).click();
  const dialog = team.getByRole("dialog");
  await expect(dialog).toContainText("Your collections go in this first one");
  await dialog.getByLabel("Name").fill("Guides");
  await dialog.getByRole("button", { name: "Add tab" }).click();
  await expect(team.getByText("Tab added")).toBeVisible();
  await expect(rows("Collections in Guides")).toHaveText([/^Getting started/, /^Billing/, /^Endpoints/, /^Webhooks/]);

  await team.getByRole("button", { name: "New tab" }).click();
  await expect(dialog).not.toContainText("Your collections go in this first one");
  await dialog.getByLabel("Name").fill("API");
  await dialog.getByRole("button", { name: "Add tab" }).click();
  // The first one's toast may still be up: the new row says it's done.
  await expect(rows("Tabs")).toHaveText([/^Guides/, /^API/]);

  // Endpoints to API from its handle's menu, with the keyboard; Webhooks dragged onto API's row.
  const moveTo = structure.getByRole("button", { name: "Move Endpoints", exact: true });
  await moveTo.focus();
  await team.keyboard.press("Enter");
  await team.getByRole("menuitem", { name: "Move to…" }).press("ArrowRight");
  await team.getByRole("menuitem", { name: "Tab: API" }).press("Enter");
  await expect(team.getByText("Endpoints moved")).toBeVisible();
  await expect(moveTo).toBeFocused();
  const row = (name: string) => structure.locator("[draggable=true]").filter({ has: team.getByRole("link", { name, exact: true }) });
  await expect(structure.getByRole("button", { name: "Move Webhooks", exact: true })).toBeEnabled();
  await row("Webhooks").dragTo(row("API"));
  await expect(team.getByText("Webhooks moved")).toBeVisible();
  await expect(rows("Collections in API")).toHaveText([/^Endpoints/, /^Webhooks/]);
  await expect(rows("Collections in Guides")).toHaveText([/^Getting started/, /^Billing/]);

  // A new collection from a tab's "+" goes in that tab.
  await structure.getByRole("button", { name: "Add to API" }).click();
  await team.getByRole("menuitem", { name: "New collection" }).click();
  await dialog.getByLabel("Name").fill("Errors");
  await expect(dialog.getByRole("combobox", { name: "Tab" })).toContainText("API");
  await dialog.getByRole("button", { name: "Add collection" }).click();
  await expect(team.getByText("Collection added")).toBeVisible();
  await expect(rows("Collections in API")).toHaveText([/^Endpoints/, /^Webhooks/, /^Errors/]);

  // API first, then renamed in its page's Settings: the page follows.
  await structure.getByRole("button", { name: "Move API", exact: true }).click();
  await team.getByRole("menuitem", { name: "Move up" }).click();
  await expect(team.getByText("API moved")).toBeVisible();
  await expect(rows("Tabs")).toHaveText([/^API/, /^Guides/]);
  await structure.getByRole("link", { name: "API", exact: true }).click();
  await team.getByRole("tab", { name: "Settings" }).click();
  const settings = team.getByRole("tabpanel", { name: "Settings" });
  await settings.getByLabel("Name").fill("API reference");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("Tab saved")).toBeVisible();
  await team.waitForURL(`**/app/${slug}/docs/tabs/api-reference`);
  await checkpoint(team, "team-docs-tabs");

  // The docs' home shows them all: each tab, in order, with its collections as cards.
  await team.goto(`/app/${slug}/docs`);
  await expect(team.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(["API reference", "Guides"]);
  const apiSection = team.getByRole("region", { name: "API reference" });
  await expect(apiSection.getByRole("region")).toHaveText([/^Endpoints/, /^Webhooks/, /^Errors/]);
  await checkpoint(team, "team-docs-home");
  // "Filter by title" in the top bar keeps what matches, with the tab and collection it's in.
  const filter = team.getByRole("searchbox", { name: "Filter docs" });
  await filter.fill("signing");
  await expect(team.getByRole("main").getByRole("heading", { level: 2 })).toHaveText(["API reference"]);
  await expect(apiSection.getByRole("region")).toHaveText([/^Webhooks/]);
  await expect(apiSection.getByRole("listitem")).toHaveText([/^Signing payloads/]);
  await checkpoint(team, "team-docs-home-filtered");
  await filter.fill("nothing like this");
  await expect(team.getByText("Nothing matches “nothing like this”.")).toBeVisible();
  await filter.fill("");
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
  // Beside each page, its tab's tree: the other tab's collections aren't in it.
  const tree = visitor.getByRole("navigation", { name: "Docs", exact: true });
  await expect(tree.getByRole("link")).toHaveText(["Getting started", "Inviting your team", "Billing", "Card payments"]);
  await checkpoint(visitor, "portal-docs-tab");
  // A collection has a page, in its tab, marked in the tree; so does an article.
  await main.getByRole("list", { name: "Collections" }).getByRole("link", { name: /^Billing/ }).click();
  await expect(visitor).toHaveURL(/\/docs\/billing$/);
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Billing");
  await expect(docsTabs.getByRole("link", { name: "Guides" })).toHaveAttribute("aria-current", "page");
  await expect(tree.getByRole("link", { name: "Billing" })).toHaveAttribute("aria-current", "page");
  await checkpoint(visitor, "portal-docs-collection");
  await tree.getByRole("link", { name: "Card payments" }).click();
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Card payments");
  await expect(tree.getByRole("link", { name: "Card payments" })).toHaveAttribute("aria-current", "page");
  await expect(tree.getByRole("link", { name: "Billing" })).not.toHaveAttribute("aria-current");
  await expect(docsTabs.getByRole("link", { name: "Guides" })).toHaveAttribute("aria-current", "page");
  await expect(docsTabs.getByRole("link", { name: "API reference" })).not.toHaveAttribute("aria-current");
  // On a phone, the way back to its tab is above it (wider screens have the tree).
  await visitor.setViewportSize({ width: 390, height: 844 });
  await main.getByRole("link", { name: "Docs", exact: true }).click();
  await expect(visitor).toHaveURL(/\/docs\/guides$/);
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
  await expect(visitor.getByRole("list", { name: "Collections" }).getByRole("link")).toHaveText(["Getting started", "Billing"]);
  await checkpoint(visitor, "widget-docs-tabs");

  // Deleting a tab moves its collections to the one before it. The first is the docs' home: it stays while there are others.
  await expect(team.getByRole("heading", { level: 1 })).toHaveText("API reference");
  await expect(team.getByRole("button", { name: "Delete API reference" })).toHaveCount(0);
  await structure.getByRole("link", { name: "Guides", exact: true }).click();
  await team.getByRole("button", { name: "Delete Guides" }).click();
  const confirm = team.getByRole("alertdialog");
  await expect(confirm).toContainText("Its collections move to API reference");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(team.getByText("Guides deleted")).toBeVisible();
  await team.waitForURL(`**/app/${slug}/docs`);
  await expect(team.getByRole("region", { name: "API reference" }).getByRole("region")).toHaveText([/^Endpoints/, /^Webhooks/, /^Errors/, /^Getting started/, /^Billing/]);
});

test("a tab's landing page: the overview's cards, or a page the team picks in the tab's settings", async ({ browser }, testInfo) => {
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
  for (const [title, collection] of [
    ["Your first board", "getting-started"],
    ["Card payments", "billing"],
    ["Inviting your team", "teams"],
    ["Listing posts", "endpoints"],
    ["Contact us", null],
  ]) {
    const article = await api("/articles", { title, body: `${title}.`, collection });
    await api(`/articles/${article.slug}/publish`, {});
  }

  // By default a tab shows its overview: search, a card per collection, then (on the first) the articles in none.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs");
  const main = visitor.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Docs");
  await expect(main.getByRole("search").getByRole("button", { name: "Search the docs" })).toBeVisible();
  const cards = main.getByRole("list", { name: "Collections" }).getByRole("link");
  await expect(cards).toHaveText([/^Getting started/, /^Billing/, /^Teams/]);
  await expect(cards.first()).toContainText("The basics, in five minutes.");
  await expect(cards.first().locator("svg.lucide-rocket")).toBeVisible();
  await expect(main.getByRole("region", { name: "More articles" }).getByRole("link")).toHaveText(["Contact us"]);
  await checkpoint(visitor, "portal-docs-overview");
  await visitor.setViewportSize({ width: 390, height: 844 });
  await checkpoint(visitor, "portal-docs-overview-phone");
  await visitor.setViewportSize({ width: 1280, height: 720 });
  // The big search box searches every tab.
  const listing = await foundAsTyped(visitor, "listing", main);
  await expect(listing.getByRole("option").nth(1)).toContainText("Listing posts");
  await visitor.keyboard.press("Escape");

  // The team makes API's path show an article: the tab's page has its address and what it shows in Settings.
  // From the docs' home, by its heading.
  await team.goto(`/app/${slug}/docs`);
  const structure = team.getByRole("navigation", { name: "Docs", exact: true });
  const settings = team.getByRole("tabpanel", { name: "Settings" });
  await team.getByRole("heading", { name: "Guides" }).getByRole("link").click();
  await team.getByRole("tab", { name: "Settings" }).click();
  await expect(settings.getByLabel("Address")).toHaveValue("/docs");
  await expect(settings).toContainText("Your docs' home");
  await structure.getByRole("link", { name: "API", exact: true }).click();
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

  await team.goto(`/app/${slug}/docs/inviting-your-team`);
  await team.getByRole("button", { name: "Settings" }).click();
  const dialog = team.getByRole("dialog", { name: "Article settings" });
  await expect(dialog.getByRole("radio", { name: "Inherit" })).toBeChecked();
  await expect(dialog.getByRole("textbox", { name: "Slug" })).toHaveCount(0);
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
  await dialog.getByRole("textbox", { name: "Meta description" }).fill("Add teammates to your project, and what they can do.");
  await checkpoint(team, "team-docs-article-settings", { fullPage: false });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await team.waitForURL(`**/app/${slug}/docs/invites`);
  await expect(team.getByRole("link", { name: `${portalUrl(slug)}/docs/invites` })).toBeVisible();

  // On a phone, the dialog scrolls in the window.
  await team.setViewportSize({ width: 390, height: 844 });
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
});

test("a visitor asks the docs' AI: an answer with its source, or “I don't know” and posting the question as feedback", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);

  // How the AI answers (Customize → AI answers): a tone, short answers, and a topic it doesn't touch.
  await team.goto(`/app/${slug}/customize/ai-answers`);
  await team.getByLabel("Tone", { exact: true }).fill("Friendly and plain");
  await team.getByRole("radio", { name: "Short" }).check();
  await team.getByLabel("Standing instructions").fill("Call the product Acme.");
  await team.getByLabel("Off-limits topics").fill("refund\nlegal advice");
  await team.getByRole("button", { name: "Save changes" }).click();
  await expect(team.getByText("AI answers saved")).toBeVisible();
  await team.reload();
  await expect(team.getByLabel("Off-limits topics")).toHaveValue("refund\nlegal advice");
  await checkpoint(team, "team-ai-answers-settings");

  // A published article whose only section is close to the visitor's question.
  const question = "How do I add a colleague to my project?";
  const body = "Owners and admins send invites from the Team page. Each invite is good for 7 days.";
  await similar(question, `Inviting your team\n\n${body}`, 0.8);
  const article = await api("/articles", { title: "Inviting your team", body });
  await api(`/articles/${article.slug}/publish`, {});

  // The visitor searches, then asks the AI: in the box, asking comes first, and it asks in the assistant.
  const visitor = await signUp(browser, portalUrl(slug), "Vera Visitor");
  await visitor.goto("/docs");
  await typeSearch(visitor, question);
  const first = visitor.getByRole("dialog").getByRole("option").first();
  await expect(first).toContainText("Ask AI:");
  await expect(first).toContainText(question);
  await checkpoint(visitor, "portal-docs-search-ask-ai", { fullPage: false });
  await nextModelReply(
    JSON.stringify({ answer: "Owners and admins send invites from the Team page.\n\n- Each invite is good for 7 days", sources: ["s1"] }),
    question,
  );
  await visitor.getByRole("dialog").getByRole("combobox", { name: "Search the docs" }).press("Enter");
  const assistant = visitor.getByRole("dialog", { name: "Assistant" });
  const conversation = assistant.getByRole("log", { name: "Conversation" });
  await expect(conversation).toContainText(question);
  await expect(conversation.getByText("Owners and admins send invites from the Team page.")).toBeVisible();
  await expect(conversation.getByRole("listitem").filter({ hasText: "Each invite is good for 7 days" })).toBeVisible();
  const source = conversation.getByRole("list", { name: "Sources" }).getByRole("link", { name: "Inviting your team" });
  await expect(source).toHaveAttribute("href", "/docs/inviting-your-team");
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
  const followed = (await modelRequests()).find((request) => request.user.includes(followUp))!;
  expect(followed.user).toContain('"earlierInConversation"');
  expect(followed.user).toContain(question);
  await checkpoint(visitor, "portal-docs-assistant-follow-up", { fullPage: false });
  await visitor.setViewportSize({ width: 390, height: 844 });
  await checkpoint(visitor, "portal-docs-assistant-follow-up-phone", { fullPage: false });
  await visitor.setViewportSize({ width: 1280, height: 720 });

  // A source opens the article; the header's button opens the assistant again, as it was.
  await source.first().click();
  await visitor.waitForURL(/\/docs\/inviting-your-team$/);
  await expect(assistant).toBeHidden();
  await visitor.getByRole("banner").getByRole("button", { name: "Ask AI" }).click();
  await expect(conversation.getByText("Only owners and admins can send invites.")).toBeVisible();
  // So does a reload (for the tab's session).
  await visitor.reload();
  await visitor.getByRole("banner").getByRole("button", { name: "Ask AI" }).click();
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
  await visitor.waitForURL(/\/feedback\/feature-requests\?title=/);
  await expect(visitor.getByLabel("Title")).toHaveValue(unrelated);
  await checkpoint(visitor, "portal-docs-ai-post-as-feedback");
  await visitor.getByRole("button", { name: "Submit post" }).click();
  await expect(visitor.getByText("Feedback posted")).toBeVisible();
  await expect(visitor.getByRole("link", { name: unrelated })).toBeVisible();

  // What the AI cost the project this month, in AI credits (Settings → Usage)…
  await team.goto(`/app/${slug}/settings/usage`);
  const spent = team.getByRole("table", { name: /^AI use in / });
  await expect(spent.getByRole("columnheader", { name: "Credits" })).toBeVisible();
  await expect(spent.getByRole("row", { name: /AI answers/ })).toBeVisible();
  await checkpoint(team, "team-settings-usage");
  // …taken from the free credits every project starts with (Settings → Billing).
  await team.getByRole("link", { name: "Billing" }).click();
  await expect(team.getByText(/^[\d,.]+ AI credits$/)).toBeVisible();
  await expect(team.getByRole("table", { name: "AI credits left" }).getByRole("row", { name: /Free credits/ })).toBeVisible();
  await checkpoint(team, "team-settings-billing");

  // The conversation is the reader's: signed out, the assistant starts afresh (a follow-up only continues their own).
  await visitor.goto("/docs");
  await visitor.getByRole("button", { name: "Account" }).click();
  await visitor.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(visitor.getByRole("banner").getByRole("link", { name: "Sign in" })).toBeVisible();
  await visitor.goto("/docs");
  await visitor.getByRole("banner").getByRole("button", { name: "Ask AI" }).click();
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
  await unstored.getByRole("banner").getByRole("button", { name: "Ask AI" }).click();
  await unstored.getByRole("dialog", { name: "Assistant" }).getByRole("textbox", { name: "Ask a question" }).fill("Is there an API?");
  await unstored.getByRole("dialog", { name: "Assistant" }).getByRole("button", { name: "Send" }).click();
  await expect(unstored.getByRole("dialog", { name: "Assistant" }).getByText("I don't know")).toBeVisible();

  // Asked on the search page (a link to /docs?q=), the answer can go on in the assistant.
  const ai = visitor.getByRole("region", { name: "AI answer" });
  // Another question it can't answer.
  const another = "Is there a dark mode?";
  await visitor.goto(`/docs?${new URLSearchParams({ q: another })}`);
  await ai.getByRole("button", { name: "Ask AI" }).click();
  await expect(ai.getByText("I don't know")).toBeVisible();
  await ai.getByRole("button", { name: "Ask a follow-up" }).click();
  await expect(conversation).toContainText(another);
  await expect(conversation.getByText("I don't know")).toBeVisible();
  await assistant.getByRole("button", { name: "Close the assistant" }).click();

  // An off-limits topic: the fixed reply, without asking the model.
  const offLimits = "Can I get a Refund for last month?";
  await visitor.goto(`/docs?${new URLSearchParams({ q: offLimits })}`);
  await ai.getByRole("button", { name: "Ask AI" }).click();
  await expect(ai.getByText("I can't help with that here.")).toBeVisible();
  await expect(ai.getByRole("link", { name: "Post this as feedback" })).toBeVisible();
  await checkpoint(visitor, "portal-docs-ai-off-limits");
  expect((await modelRequests()).filter((request) => request.user.includes(offLimits))).toEqual([]);

  // The team sees them as gaps in the insights (the answered question isn't one), each with why.
  await team.goto(`/app/${slug}/docs/insights`);
  // A gap's row (the failed searches list the question too).
  const gap = (text: string) => team.getByRole("listitem").filter({ hasText: text, has: team.getByRole("button", { name: "Dismiss" }) });
  await expect(gap(unrelated)).toContainText("1 unanswered");
  await expect(gap(unrelated)).toContainText("No matching article");
  await expect(gap(another)).toBeVisible();
  await expect(gap(offLimits)).toContainText("Off-limits");
  await expect(gap(question)).toHaveCount(0);
  await checkpoint(team, "team-docs-gaps");
  // Dismissing one hides it.
  await gap(another).getByRole("button", { name: "Dismiss" }).click();
  await expect(team.getByText("Dismissed")).toBeVisible();
  await expect(gap(another)).toHaveCount(0);
  // "Write an article" starts one with the question as its title.
  await gap(unrelated).getByRole("link", { name: "Write an article" }).click();
  await team.waitForURL(`**/app/${slug}/docs/new?title=*`);
  await expect(team.getByLabel("Title")).toHaveValue(unrelated);
  await checkpoint(team, "team-docs-gap-new-article");
});

test("the team confirms a support email; a visitor the AI couldn't help asks a person, and the team gets it by email", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const support = `e2e-support-${slug}@example.com`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // The support email takes questions only once it opens the link we email it.
  await team.goto(`/app/${slug}/customize/ai-answers`);
  await team.getByLabel("Support email").fill(support);
  await team.getByRole("button", { name: "Save support email" }).click();
  await expect(team.getByText("Support email saved")).toBeVisible();
  await expect(team.getByText(`Waiting for ${support} to confirm`)).toBeVisible();
  await checkpoint(team, "team-support-email-waiting");
  const link = linkIn(await latestEmailTo(support), `${APP_URL}/support-email?`);
  const inbox = await newPerson(browser, APP_URL);
  await inbox.goto(link);
  await expect(inbox.getByText(`Send questions from Acme's docs that the AI can't answer to ${support}?`)).toBeVisible();
  await checkpoint(inbox, "support-email-confirm");
  await inbox.getByRole("button", { name: "Confirm" }).click();
  await expect(inbox.getByText(`now come to ${support}`)).toBeVisible();
  await team.reload();
  await expect(team.getByText(`Questions go to ${support}.`)).toBeVisible();

  // A visitor asks something the docs don't cover.
  const visitor = await signUp(browser, portalUrl(slug), "Vera Visitor");
  const question = `Can I pay with crypto for ${slug}?`;
  await visitor.goto(`/docs?${new URLSearchParams({ q: question })}`);
  const ai = visitor.getByRole("region", { name: "AI answer" });
  await ai.getByRole("button", { name: "Ask AI" }).click();
  await expect(ai.getByText("I don't know")).toBeVisible();
  await ai.getByRole("button", { name: "Ask a person" }).click();
  const form = ai.getByRole("form", { name: "Ask a person" });
  // Signed in: their email is filled in.
  await expect(form.getByLabel("Your email")).toHaveValue(visitor.email);
  await form.getByLabel("Anything to add? (optional)").fill("We'd like to pay yearly.");
  await checkpoint(visitor, "portal-docs-ask-a-person");
  await nextModelReply("They want to pay for Acme in crypto, yearly.", question);
  const before = { support: countEmailsTo(support), visitor: countEmailsTo(visitor.email) };
  await form.getByRole("button", { name: "Send to the team" }).click();
  await expect(ai.getByText("We've passed this to the team; they'll reply by email.")).toBeVisible();
  await checkpoint(visitor, "portal-docs-asked-a-person");

  // The team gets it, to reply to the visitor directly; the visitor gets a copy.
  const sent = await latestEmailTo(support, { after: before.support });
  expect(sent.subject).toBe(`Question from the docs: ${question}`);
  expect(sent.replyTo).toBe(visitor.email);
  expect(sent.text).toContain("They want to pay for Acme in crypto, yearly.");
  expect(sent.text).toContain("We'd like to pay yearly.");
  const copy = await latestEmailTo(visitor.email, { after: before.visitor });
  expect(copy.subject).toBe("Your question to Acme");

  // The Gaps list says it went to a person.
  await team.goto(`/app/${slug}/docs/insights`);
  const gap = team.getByRole("listitem").filter({ hasText: question, has: team.getByRole("button", { name: "Dismiss" }) });
  await expect(gap).toContainText("Escalated");
  await checkpoint(team, "team-docs-gap-escalated");
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
  const guides = team.getByRole("region", { name: "Guides" });
  await expect(guides).toContainText("Nothing in this tab yet.");
  await guides.getByRole("link", { name: "Guides" }).click();
  await team.waitForURL(`**/app/${slug}/docs/tabs/guides`);
});
