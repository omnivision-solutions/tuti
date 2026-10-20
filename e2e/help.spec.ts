import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";
import { modelRequests, nextModelReply } from "./model";
import { similar } from "./openai";

test("the team writes a help article in a collection, publishes it, and a visitor reads it", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // A collection to put it in.
  await team.getByRole("link", { name: "Help center" }).click();
  await expect(team.getByText("No articles yet")).toBeVisible();
  await team.getByRole("button", { name: "New collection" }).click();
  const dialog = team.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Getting started");
  await dialog.getByLabel("Description").fill("The basics, in five minutes.");
  await dialog.getByRole("button", { name: "Add collection" }).click();
  await expect(team.getByText("Collection added")).toBeVisible();
  await expect(team.getByText("0 articles")).toBeVisible();
  await checkpoint(team, "team-help-center");

  // A draft: title, collection, a heading, text and a table.
  await team.getByRole("link", { name: "New article" }).click();
  // A refused save keeps what was typed.
  await team.getByLabel("Title").fill("Hi");
  await team.getByRole("button", { name: "Save draft" }).click();
  await expect(team.getByText("Title is too short")).toBeVisible();
  await expect(team.getByLabel("Title")).toHaveValue("Hi");
  await team.getByLabel("Title").fill("Inviting your team");
  await team.getByLabel("Collection").click();
  await team.getByRole("option", { name: "Getting started" }).click();
  const editor = team.getByRole("textbox", { name: "Article" });
  await editor.click();
  await team.getByRole("button", { name: "Heading", exact: true }).click();
  await team.keyboard.type("Who can invite");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Owners and admins send invites from the Team page.");
  await team.keyboard.press("Enter");
  await team.getByRole("button", { name: "Table", exact: true }).click();
  for (const cell of ["Role", "Can invite", "", "Admin", "Yes"]) {
    await team.keyboard.type(cell);
    await team.keyboard.press("Tab");
  }
  await checkpoint(team, "team-help-article-draft");
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/help/inviting-your-team`);
  await expect(team.getByText("Draft", { exact: true })).toBeVisible();

  // Visitors don't see it yet.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/help/inviting-your-team");
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toHaveCount(0);
  expect((await visitor.request.get(`${portalUrl(slug)}/help/inviting-your-team.md`)).status()).toBe(404);
  await visitor.goto("/help");
  await expect(visitor.getByText("Nothing here yet")).toBeVisible();

  await team.getByRole("button", { name: "Publish" }).click();
  const confirm = team.getByRole("alertdialog");
  await expect(confirm).toContainText("search engines can find it");
  await confirm.getByRole("button", { name: "Publish" }).click();
  await expect(team.getByText("Published", { exact: true }).first()).toBeVisible();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();
  await checkpoint(team, "team-help-article-published");

  // The visitor finds it under its collection on the Help tab, and reads it.
  await visitor.goto("/");
  await visitor.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Help" }).click();
  const collection = visitor.getByRole("region", { name: "Getting started" });
  await expect(collection).toContainText("The basics, in five minutes.");
  await checkpoint(visitor, "portal-help-center");
  await collection.getByRole("link", { name: "Inviting your team" }).click();
  await visitor.waitForURL(/\/help\/inviting-your-team$/);
  const article = visitor.getByRole("article", { name: "Inviting your team" });
  await expect(article.getByRole("heading", { name: "Who can invite", level: 2 })).toBeVisible();
  await expect(article.getByRole("columnheader", { name: "Can invite" })).toBeVisible();
  await expect(article.getByRole("cell", { name: "Admin" })).toBeVisible();
  // Search engines get its own title and description.
  await expect(visitor).toHaveTitle("Inviting your team · Acme");
  await expect(visitor.locator('meta[name="description"]')).toHaveAttribute("content", /^Who can invite Owners and admins send invites/);
  await checkpoint(visitor, "portal-help-article");

  // AI tools get it as Markdown: at its .md URL, copied, or opened in ChatGPT or Claude with that URL.
  const markdownUrl = `${portalUrl(slug)}/help/inviting-your-team.md`;
  const markdown = await visitor.request.get(markdownUrl);
  expect(markdown.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  expect(await markdown.text()).toBe(
    "# Inviting your team\n\n## Who can invite\n\nOwners and admins send invites from the Team page.\n\n" +
      "| Role | Can invite |  |\n| --- | --- | --- |\n| Admin | Yes |  |\n|  |  |  |\n",
  );
  const prompt = encodeURIComponent(`Read ${markdownUrl} and answer questions about it.`);
  await expect(visitor.getByRole("link", { name: "Open in ChatGPT" })).toHaveAttribute("href", `https://chatgpt.com/?q=${prompt}`);
  await expect(visitor.getByRole("link", { name: "Open in Claude" })).toHaveAttribute("href", `https://claude.ai/new?q=${prompt}`);
  await visitor.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await visitor.getByRole("button", { name: "Copy as Markdown" }).click();
  await expect(visitor.getByText("Copied as Markdown")).toBeVisible();
  expect(await visitor.evaluate(() => navigator.clipboard.readText())).toBe(await markdown.text());
  await checkpoint(visitor, "portal-help-article-copied");

  // Search finds it with the passage that matched; a search with no match says so.
  await visitor.goto("/help");
  const searchBox = visitor.getByRole("searchbox", { name: "Search the help center" });
  await searchBox.fill("send invites");
  await visitor.getByRole("button", { name: "Search" }).click();
  await visitor.waitForURL(/\/help\?q=send\+invites$/);
  const results = visitor.getByRole("list", { name: "Search results" });
  await expect(results.getByRole("link", { name: "Inviting your team" })).toBeVisible();
  await expect(results).toContainText("Owners and admins send invites from the Team page.");
  await checkpoint(visitor, "portal-help-search");
  await searchBox.fill("refunds");
  await searchBox.press("Enter");
  await expect(visitor.getByText("No articles match “refunds”")).toBeVisible();
  await checkpoint(visitor, "portal-help-search-empty");
  await visitor.getByRole("link", { name: "All articles" }).click();
  await expect(visitor.getByRole("region", { name: "Getting started" })).toBeVisible();

  // The visitor (signed out) says the article didn't help, and what was missing.
  await visitor.getByRole("link", { name: "Inviting your team" }).click();
  const helpful = visitor.getByRole("region", { name: "Was this helpful?" });
  await helpful.getByRole("button", { name: "No" }).click();
  await helpful.getByLabel("What were you looking for? (optional)").fill("How do I invite by email?");
  await checkpoint(visitor, "portal-help-article-feedback");
  await helpful.getByRole("button", { name: "Send" }).click();
  await expect(helpful.getByText("Thanks for letting us know.")).toBeVisible();

  // The team sees it in the help center's insights, with the article's views and the search that found nothing.
  await team.getByRole("link", { name: "Help center" }).first().click();
  await team.waitForURL(`**/app/${slug}/help`);
  await team.getByRole("link", { name: "Insights" }).click();
  await team.waitForURL(`**/app/${slug}/help/insights`);
  await expect(team.getByText("The last 30 days: 2 article views, 2 searches, 1 failed search.")).toBeVisible();
  await expect(team.getByText("2 views · 0% found it helpful (0 of 1)")).toBeVisible();
  await expect(team.getByText("How do I invite by email?")).toBeVisible();
  await expect(team.getByText("refunds", { exact: true })).toBeVisible();
  await expect(team.getByText("1 search", { exact: true })).toBeVisible();
  await checkpoint(team, "team-help-insights");

  // Deleting the collection keeps its article. While it runs (slowed down here), Delete can't be clicked again.
  await team.getByRole("link", { name: "Help center" }).first().click();
  await team.waitForURL(`**/app/${slug}/help`);
  await expect(team.getByText("1 article", { exact: true })).toBeVisible();
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
  await team.unroute("**/*");
  await expect(team.getByRole("link", { name: "Inviting your team" })).toBeVisible();
  await visitor.goto("/help");
  await expect(visitor.getByRole("link", { name: "Inviting your team" })).toBeVisible();

  // The team edits it twice. It's published, so the edits wait as unpublished changes until the team publishes them.
  await team.getByRole("link", { name: "Inviting your team" }).click();
  await team.waitForURL(`**/app/${slug}/help/inviting-your-team`);
  const paragraph = editor.locator("p", { hasText: "Owners and admins send invites" });
  for (const sentence of [" Members can ask them.", " Invites last a week."]) {
    // The caret goes to the paragraph's end (End only reaches the end of a visual line).
    await paragraph.click();
    await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
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
  await checkpoint(team, "team-help-article-unpublished-changes");
  await visitor.goto("/help/inviting-your-team");
  await expect(visitor.getByText(original, { exact: true })).toBeVisible();
  await expect(visitor.getByText(/Members can ask them/)).toHaveCount(0);

  // Reviewed against the published version, then published.
  await unpublished.getByRole("button", { name: "Review changes" }).click();
  const review = team.getByRole("dialog", { name: "Review changes" });
  await expect(review.getByRole("deletion")).toHaveText(original);
  await expect(review.getByRole("insertion")).toHaveText(edited);
  await checkpoint(team, "team-help-article-review-changes", { fullPage: false });
  await review.getByRole("button", { name: "Publish changes" }).click();
  await expect(team.getByText("Changes published")).toBeVisible();
  await expect(unpublished).toHaveCount(0);
  await visitor.goto("/help/inviting-your-team");
  await expect(visitor.getByText(edited, { exact: true })).toBeVisible();
  // Changed since it was published, so readers see when.
  await expect(visitor.getByText(/^Updated \d+ \w+ \d{4}$/)).toBeVisible();
  await checkpoint(visitor, "portal-help-article-updated");

  // Its history shows what changed since the first version.
  await team.getByRole("link", { name: "History" }).click();
  await team.waitForURL(`**/app/${slug}/help/inviting-your-team/history`);
  const versions = team.getByRole("link", { name: /^Saved / });
  await expect(versions).toHaveCount(3);
  await versions.nth(2).click();
  await team.waitForURL(/\/history\?revision=/);
  const changes = team.getByRole("region", { name: "Changes since this version" });
  await expect(changes.getByRole("deletion")).toHaveText(original);
  await expect(changes.getByRole("insertion")).toHaveText(edited);
  await checkpoint(team, "team-help-article-history");

  // Restoring it is a save like any other (a new version): unpublished changes, which the team discards.
  await changes.getByRole("button", { name: "Restore this version" }).click();
  const restoring = team.getByRole("alertdialog");
  await expect(restoring).toContainText("readers see it once you publish them");
  await checkpoint(team, "team-help-article-restore-confirm", { fullPage: false });
  await restoring.getByRole("button", { name: "Restore" }).click();
  await expect(team.getByText("Version restored")).toBeVisible();
  await team.waitForURL(`**/app/${slug}/help/inviting-your-team`);
  await unpublished.getByRole("button", { name: "Discard changes" }).click();
  const discarding = team.getByRole("alertdialog");
  await expect(discarding).toContainText("The changes stay in its history");
  await discarding.getByRole("button", { name: "Discard changes" }).click();
  await expect(team.getByText("Changes discarded")).toBeVisible();
  await expect(unpublished).toHaveCount(0);
  await expect(editor).toContainText(edited);
  await team.getByRole("link", { name: "History" }).click();
  await expect(team.getByRole("link", { name: /^Saved / })).toHaveCount(5);

  // Listing: unlisted, it's gone from /help but its link still works; hidden, its page is a 404.
  await team.getByRole("link", { name: "Inviting your team" }).click();
  await team.waitForURL(`**/app/${slug}/help/inviting-your-team`);
  // The page header's line under the title.
  const header = team.locator("p", { hasText: /^Published / });
  const setListing = async (name: string, shot?: string) => {
    await team.getByLabel("Listing").click();
    if (shot) {
      await checkpoint(team, shot, { fullPage: false });
    }
    await team.getByRole("option", { name }).click();
    const saved = team.waitForResponse((response) => response.request().headers()["next-action"] !== undefined);
    await team.getByRole("button", { name: "Save", exact: true }).click();
    await saved;
    await expect(team.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  };
  await setListing("Unlisted", "team-help-article-listing");
  // A listing goes live at once: it's no unpublished change.
  await expect(unpublished).toHaveCount(0);
  await expect(team.getByText("Anyone with the link can read it, but it's in no list or search. AI answers can cite it.")).toBeVisible();
  await expect(header).toContainText("Unlisted ·");
  await checkpoint(team, "team-help-article-unlisted");
  await visitor.goto("/help");
  await expect(visitor.getByText("Nothing here yet")).toBeVisible();
  await visitor.goto("/help/inviting-your-team");
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toBeVisible();

  await setListing("Hidden");
  await expect(team.getByText("Stays published, but isn't shown anywhere, not even at its link.")).toBeVisible();
  await expect(header).toContainText("· Hidden");
  await checkpoint(team, "team-help-article-hidden");
  expect((await visitor.goto("/help/inviting-your-team"))!.status()).toBe(404);
  expect((await visitor.request.get(`${portalUrl(slug)}/help/inviting-your-team.md`)).status()).toBe(404);

  await setListing("Everywhere");
  await visitor.goto("/help");
  await expect(visitor.getByRole("link", { name: "Inviting your team" })).toBeVisible();

  // Deleted, it leaves the portal; the team brings it back from Recently deleted, as a draft.
  await team.getByRole("button", { name: "Delete" }).click();
  const deletingArticle = team.getByRole("alertdialog");
  await expect(deletingArticle).toContainText("You can restore it from Recently deleted for 30 days.");
  await deletingArticle.getByRole("button", { name: "Delete" }).click();
  await team.waitForURL(`**/app/${slug}/help`);
  const recentlyDeleted = team.getByRole("region", { name: "Recently deleted" });
  await expect(recentlyDeleted).toContainText("Inviting your team");
  await checkpoint(team, "team-help-recently-deleted");
  await visitor.goto("/help/inviting-your-team");
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toHaveCount(0);

  await recentlyDeleted.getByRole("button", { name: "Restore “Inviting your team”" }).click();
  await expect(team.getByText("Restored “Inviting your team” as a draft")).toBeVisible();
  await expect(team.getByRole("region", { name: "Recently deleted" })).toHaveCount(0);
  await expect(team.getByRole("link", { name: "Inviting your team" })).toBeVisible();
  // In the list of articles, and in the collections' structure.
  await expect(team.getByText("Draft", { exact: true })).toHaveCount(2);
  await checkpoint(team, "team-help-article-restored");
});

test("the team arranges the help center: a collection in another, moves with the keyboard and by dragging, and the portal follows", async ({
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
  for (const [title, collection] of [
    ["Inviting your team", "getting-started"],
    ["Your first board", "getting-started"],
    ["Card payments", "billing"],
    ["Downloading invoices", "billing"],
  ]) {
    const article = await api("/articles", { title, body: `${title}.`, collection });
    await api(`/articles/${article.slug}/publish`, {});
  }

  // A collection in Billing.
  await team.goto(`/app/${slug}/help`);
  await team.getByRole("button", { name: "New collection" }).click();
  const dialog = team.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Invoices");
  await dialog.getByLabel("Parent collection").click();
  await team.getByRole("option", { name: "Billing" }).click();
  await dialog.getByRole("button", { name: "Add collection" }).click();
  await expect(team.getByText("Collection added")).toBeVisible();
  const structure = team.getByRole("region", { name: "Collections" });
  await expect(structure.getByRole("list", { name: "Collections in Billing" })).toContainText("Invoices");

  // An article goes in it from its "Move to…" menu.
  await structure.getByRole("button", { name: "Move Downloading invoices to…" }).click();
  await team.getByRole("menuitem", { name: "Billing › Invoices" }).click();
  await expect(team.getByText("Downloading invoices moved")).toBeVisible();
  await expect(structure.getByRole("list", { name: "Articles in Invoices" })).toContainText("Downloading invoices");

  // With the keyboard: Billing up to the top, then "Your first board" before "Inviting your team".
  const billingUp = structure.getByRole("button", { name: "Move Billing up" });
  await billingUp.focus();
  await team.keyboard.press("Enter");
  await expect(team.getByText("Billing moved")).toBeVisible();
  // It's first now: its up arrow is off, and focus is on its down arrow.
  await expect(billingUp).toBeDisabled();
  await expect(structure.getByRole("button", { name: "Move Billing down" })).toBeFocused();
  await structure.getByRole("button", { name: "Move Your first board up" }).focus();
  await team.keyboard.press("Enter");
  await expect(team.getByText("Your first board moved")).toBeVisible();
  await expect(structure.getByRole("list", { name: "Articles in Getting started" }).getByRole("listitem")).toHaveText([
    /^Your first board/,
    /^Inviting your team/,
  ]);
  await checkpoint(team, "team-help-structure");
  await team.setViewportSize({ width: 390, height: 844 });
  await checkpoint(team, "team-help-structure-phone");
  await team.setViewportSize({ width: 1280, height: 720 });

  // The portal follows: Billing first with Invoices in it, then Getting started in its new order.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/help");
  const main = visitor.getByRole("main");
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(["Billing", "Getting started"]);
  const billing = main.getByRole("region", { name: "Billing" });
  await expect(billing.getByRole("heading", { level: 3 })).toHaveText(["Invoices"]);
  await expect(billing.getByRole("region", { name: "Invoices" }).getByRole("link")).toHaveText(["Downloading invoices"]);
  await expect(main.getByRole("region", { name: "Getting started" }).getByRole("link")).toHaveText(["Your first board", "Inviting your team"]);
  await checkpoint(visitor, "portal-help-nested");

  // Dragged by its row: Getting started back above Billing.
  const row = (name: string) => structure.locator("[draggable=true]").filter({ has: team.getByText(name, { exact: true }) });
  await row("Getting started").dragTo(row("Billing"), { targetPosition: { x: 40, y: 2 } });
  await expect(team.getByText("Getting started moved")).toBeVisible();
  await visitor.reload();
  await expect(main.getByRole("heading", { level: 2 })).toHaveText(["Getting started", "Billing"]);
});

/** A read and write API key for project `slug`, made in its settings, and a POST to the API with it. */
async function apiFor(team: Page, slug: string) {
  await team.goto(`/app/${slug}/settings`);
  await team.getByRole("textbox", { name: "Key name" }).fill("Help test");
  await team.getByRole("combobox", { name: "What the key can do" }).click();
  await team.getByRole("option", { name: "Read and write" }).click();
  await team.getByRole("button", { name: "Create key" }).click();
  const shown = team.getByRole("alert").filter({ hasText: "Copy the key for Help test now" });
  const key = (await shown.locator("code").first().innerText()).trim();
  return async (path: string, body: object) => {
    const response = await fetch(`${APP_URL}/api/v1${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.ok).toBe(true);
    return (await response.json()) as { slug: string };
  };
}

test("a visitor asks the help center's AI: an answer with its source, or “I don't know” and posting the question as feedback", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);

  // How the AI answers: a tone, short answers, and a topic it doesn't touch.
  await team.getByLabel("Tone", { exact: true }).fill("Friendly and plain");
  await team.getByRole("radio", { name: "Short" }).check();
  await team.getByLabel("Standing instructions").fill("Call the product Acme.");
  await team.getByLabel("Off-limits topics").fill("refund\nlegal advice");
  await team.getByRole("button", { name: "Save AI answers" }).click();
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

  // The visitor searches, then asks the AI.
  const visitor = await signUp(browser, portalUrl(slug), "Vera Visitor");
  await visitor.goto("/help");
  const searchBox = visitor.getByRole("searchbox", { name: "Search the help center" });
  await searchBox.fill(question);
  await searchBox.press("Enter");
  const ai = visitor.getByRole("region", { name: "AI answer" });
  await expect(ai.getByRole("button", { name: "Ask AI" })).toBeVisible();
  await checkpoint(visitor, "portal-help-ask-ai");
  await nextModelReply(
    JSON.stringify({ answer: "Owners and admins send invites from the Team page.\n\n- Each invite is good for 7 days", sources: ["s1"] }),
    question,
  );
  await ai.getByRole("button", { name: "Ask AI" }).click();
  await expect(ai.getByText("Owners and admins send invites from the Team page.")).toBeVisible();
  await expect(ai.getByRole("listitem").filter({ hasText: "Each invite is good for 7 days" })).toBeVisible();
  const source = ai.getByRole("list", { name: "Sources" }).getByRole("link", { name: "Inviting your team" });
  await expect(source).toHaveAttribute("href", "/help/inviting-your-team");
  await checkpoint(visitor, "portal-help-ai-answer");
  const asked = (await modelRequests()).filter((request) => request.user.includes(question));
  expect(asked).toHaveLength(1);
  expect(asked[0]!.user).toContain(body);
  // The team's settings go with it, apart from the sections.
  expect(asked[0]!.user).toContain('"tone": "Friendly and plain"');
  expect(asked[0]!.user).toContain('"standingInstructions": "Call the product Acme."');
  expect(asked[0]!.system).toContain("Keep it very short");
  await ai.getByRole("button", { name: "Helpful", exact: true }).click();
  await expect(ai.getByText("Thanks for letting us know.")).toBeVisible();
  await source.click();
  await visitor.waitForURL(/\/help\/inviting-your-team$/);

  // Something the help center doesn't cover: "I don't know", without asking the model.
  await visitor.goto("/help");
  const unrelated = "Can I pay with crypto?";
  await visitor.getByRole("searchbox", { name: "Search the help center" }).fill(unrelated);
  await visitor.getByRole("searchbox", { name: "Search the help center" }).press("Enter");
  await ai.getByRole("button", { name: "Ask AI" }).click();
  await expect(ai.getByText("I don't know")).toBeVisible();
  await checkpoint(visitor, "portal-help-ai-no-answer");
  expect((await modelRequests()).filter((request) => request.user.includes(unrelated))).toEqual([]);

  // Posting it as feedback starts a post with the question as its title.
  await ai.getByRole("link", { name: "Post this as feedback" }).click();
  await visitor.waitForURL(/\/b\/feature-requests\?title=/);
  await expect(visitor.getByLabel("Title")).toHaveValue(unrelated);
  await checkpoint(visitor, "portal-help-ai-post-as-feedback");
  await visitor.getByRole("button", { name: "Submit feedback" }).click();
  await expect(visitor.getByText("Feedback posted")).toBeVisible();
  await expect(visitor.getByRole("link", { name: unrelated })).toBeVisible();

  // Another question it can't answer.
  const another = "Is there a dark mode?";
  await visitor.goto(`/help?${new URLSearchParams({ q: another })}`);
  await ai.getByRole("button", { name: "Ask AI" }).click();
  await expect(ai.getByText("I don't know")).toBeVisible();

  // An off-limits topic: the fixed reply, without asking the model.
  const offLimits = "Can I get a Refund for last month?";
  await visitor.goto(`/help?${new URLSearchParams({ q: offLimits })}`);
  await ai.getByRole("button", { name: "Ask AI" }).click();
  await expect(ai.getByText("I can't help with that here.")).toBeVisible();
  await expect(ai.getByRole("link", { name: "Post this as feedback" })).toBeVisible();
  await checkpoint(visitor, "portal-help-ai-off-limits");
  expect((await modelRequests()).filter((request) => request.user.includes(offLimits))).toEqual([]);

  // The team sees them as gaps in the insights (the answered question isn't one), each with why.
  await team.goto(`/app/${slug}/help/insights`);
  // A gap's row (the failed searches list the question too).
  const gap = (text: string) => team.getByRole("listitem").filter({ hasText: text, has: team.getByRole("button", { name: "Dismiss" }) });
  await expect(gap(unrelated)).toContainText("1 unanswered");
  await expect(gap(unrelated)).toContainText("No matching article");
  await expect(gap(another)).toBeVisible();
  await expect(gap(offLimits)).toContainText("Off-limits");
  await expect(gap(question)).toHaveCount(0);
  await checkpoint(team, "team-help-gaps");
  // Dismissing one hides it.
  await gap(another).getByRole("button", { name: "Dismiss" }).click();
  await expect(team.getByText("Dismissed")).toBeVisible();
  await expect(gap(another)).toHaveCount(0);
  // "Write an article" starts one with the question as its title.
  await gap(unrelated).getByRole("link", { name: "Write an article" }).click();
  await team.waitForURL(`**/app/${slug}/help/new?title=*`);
  await expect(team.getByLabel("Title")).toHaveValue(unrelated);
  await checkpoint(team, "team-help-gap-new-article");
});
