import { randomInt, randomUUID } from "node:crypto";

import { expect, type Locator, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { setAnalysis } from "./autopilot";
import { query } from "./db";
import { connectGithub, mergedOnGithub, mergePullRequest, publishRelease } from "./github";
import { afterIntersections, apiFor, createProject, newPerson, postFeedback, signUp } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";
import { publishedOn } from "./changelog-dates";
import { modelRequests, nextModelReply } from "./model";

test("the team writes what shipped, publishes it, and people see it on the portal", async ({ browser }, testInfo) => {
  // A long journey (drafting, AI edits, publishing, the portal): more than the default 30 s on a busy machine.
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, "Dark mode");

  // The team plans it, so the changelog can pick it.
  await team.goto(`/app/${slug}/p/1`);
  await team.getByLabel("Status", { exact: true }).click();
  await team.getByRole("option", { name: "Planned" }).click();
  // Asked first: it emails Ada.
  await team.getByRole("alertdialog").getByRole("button", { name: "Mark planned" }).click();
  await expect(team.getByText("Status: Planned")).toBeVisible();

  // A draft: title, tag, text with a heading, and the post it completes.
  await team.getByRole("link", { name: "Changelog" }).click();
  // Nothing written yet: both tabs, empty.
  // Its views are pills in its pane's header.
  await expect(team.locator('[data-slot="pane-header"]').getByRole("navigation", { name: "Entries" })).toContainText("Drafts 0Published 0");
  await expect(team.getByText("No entries yet")).toBeVisible();
  await team.getByRole("link", { name: "New entry" }).click();
  await team.getByLabel("Title").fill("Dark mode is here");
  await team.getByRole("checkbox", { name: "New", exact: true }).check();
  await team.getByRole("checkbox", { name: "Breaking" }).check();
  const editor = team.getByRole("textbox", { name: "What changed" });
  await editor.click();
  await team.keyboard.type("/");
  await team.getByRole("option", { name: "Heading", exact: true }).click();
  await team.keyboard.type("Easier on the eyes");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Switch themes from your profile menu.");
  // Beside the text, a sidebar: tags as chips, and the posts it completes, picked by search.
  const sidebar = team.getByRole("complementary", { name: "Entry settings" });
  const writing = (await editor.boundingBox())!;
  expect((await sidebar.boundingBox())!.x).toBeGreaterThan(writing.x + writing.width);
  const completes = sidebar.getByRole("region", { name: "Posts it completes" });
  await completes.getByRole("button", { name: "Link post…" }).click();
  const linkPost = team.getByRole("dialog", { name: "Link a post" });
  await linkPost.getByLabel("Search posts").fill("dark");
  await linkPost.getByRole("button", { name: /#1\s*Dark mode/ }).click();
  await expect(linkPost).toBeHidden();
  await expect(completes.getByRole("link", { name: "Dark mode" })).toBeVisible();
  // Linked, it's not offered again.
  await completes.getByRole("button", { name: "Link post…" }).click();
  await expect(linkPost.getByText("No matching posts.")).toBeVisible();
  await team.keyboard.press("Escape");
  await expect(linkPost).toBeHidden();
  // A refused save keeps what was typed and picked. Save draft is in the page's own toolbar.
  const saveDraft = team.getByRole("button", { name: "Save draft" });
  const draftToolbar = (await team.locator('[data-slot="pane-header"]').boundingBox())!;
  expect((await saveDraft.boundingBox())!.y).toBeGreaterThanOrEqual(draftToolbar.y);
  expect((await saveDraft.boundingBox())!.y).toBeLessThan(draftToolbar.y + draftToolbar.height);
  await team.getByLabel("Title").fill("Hi");
  await saveDraft.click();
  await expect(team.getByText("Title is too short")).toBeVisible();
  await expect(team.getByLabel("Title")).toHaveValue("Hi");
  await expect(team.getByRole("checkbox", { name: "New", exact: true })).toBeChecked();
  await expect(completes.getByRole("link", { name: "Dark mode" })).toBeVisible();
  await team.getByLabel("Title").fill("Dark mode is here");
  // Not published: nothing to read on the portal yet, and it says so.
  await expect(sidebar.getByRole("button", { name: "View as reader" })).toBeDisabled();
  await expect(sidebar.getByRole("button", { name: "View as reader" })).toHaveAccessibleDescription("Readers see it once it's published.");
  // Breaking, picked, is the destructive colour, as readers will see it (and the team's list); the others neutral.
  const chip = (name: string) => team.locator("label").filter({ has: team.getByRole("checkbox", { name, exact: true }) });
  const breaking = await chip("Breaking").evaluate((label) => getComputedStyle(label).color);
  expect(breaking).not.toBe(await chip("New").evaluate((label) => getComputedStyle(label).color));
  await checkpoint(team, "team-changelog-draft");
  // On a phone the sidebar goes under the text, and Save draft stays in reach at the bottom of the screen (no menu
  // for it), the page leaving room for it under the sidebar.
  await team.setViewportSize({ width: 390, height: 844 });
  expect((await sidebar.boundingBox())!.y).toBeGreaterThan((await editor.boundingBox())!.y + (await editor.boundingBox())!.height);
  // Done typing the title (the bar steps aside while text is typed).
  await team.getByLabel("Title").blur();
  await expect(saveDraft).toBeInViewport();
  await expect(saveDraft).toHaveCount(1);
  await expect(team.getByRole("button", { name: "More actions" })).toHaveCount(0);
  // The way back to the list, at the top.
  await expect(team.getByRole("link", { name: "All entries" })).toBeInViewport();
  await team.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const bottomBar = (await saveDraft.boundingBox())!;
  expect(bottomBar.y + bottomBar.height).toBeGreaterThan(844 - 32);
  const settings = (await sidebar.boundingBox())!;
  expect(settings.y + settings.height).toBeLessThan(bottomBar.y);
  await checkpoint(team, "team-changelog-draft-phone", { fullPage: false });
  // It saves it all: the title typed again above, the tag and the post, there after a reload.
  await saveDraft.click();
  await team.waitForURL(`**/app/${slug}/changelog/1`);
  await team.reload();
  await expect(team.getByLabel("Title")).toHaveValue("Dark mode is here");
  await expect(team.getByRole("checkbox", { name: "New", exact: true })).toBeChecked();
  await expect(completes.getByRole("link", { name: "Dark mode" })).toBeVisible();
  await expect(team.getByText("Draft", { exact: true })).toBeVisible();
  await team.setViewportSize({ width: 1280, height: 720 });
  // The entry is the Changelog's: the sidebar keeps Changelog marked on its page.
  await expect(team.locator('[data-slot="sidebar"][data-state]').getByRole("link", { name: "Changelog", exact: true })).toHaveAttribute("data-active");

  // Submitted before the page's JavaScript runs (here: none at all), the form doesn't fall
  // back to a GET that puts what was typed in the URL.
  const noScript = await browser.newContext({ baseURL: APP_URL, javaScriptEnabled: false, storageState: await team.context().storageState() });
  const early = await noScript.newPage();
  await early.goto(`/app/${slug}/changelog/new`);
  await early.getByLabel("Title").fill("Secret plans");
  await early.getByRole("button", { name: "Save draft" }).click();
  await early.waitForLoadState();
  expect(early.url()).not.toContain("Secret");
  await noScript.close();

  // AI rewrites the text into release notes, after asking; the title the team gave stays. One way into AI: Edit with
  // AI over the text, Draft with AI in its menu (not a second button in the top bar).
  await nextModelReply(
    JSON.stringify({
      title: "Dark mode",
      notes: "## A darker look\n\nSwitch to the dark theme from your profile menu.\n\n- Easier on the eyes at night",
    }),
  );
  await expect(team.getByRole("button", { name: "Draft with AI" })).toHaveCount(0);
  await team.getByRole("button", { name: "Edit with AI" }).click();
  await team.getByRole("menuitem", { name: "Draft with AI…" }).click();
  const confirm = team.getByRole("alertdialog");
  await expect(confirm).toContainText("Replace the text with an AI draft?");
  await expect(confirm).toContainText("AI writes release notes from the entry's saved text, its pull requests and the posts it completes.");
  await checkpoint(team, "team-changelog-ai-draft-confirm", { fullPage: false });
  await confirm.getByRole("button", { name: "Replace the text" }).click();
  await expect(team.getByText("Drafted with AI")).toBeVisible();
  // The keyboard's focus back on the menu's button.
  await expect(team.getByRole("button", { name: "Edit with AI" })).toBeFocused();
  await expect(editor.getByRole("heading", { name: "A darker look" })).toBeVisible();
  await expect(editor.getByRole("listitem")).toHaveText("Easier on the eyes at night");
  await expect(editor.getByRole("heading", { name: "Easier on the eyes" })).toHaveCount(0);
  await expect(editor).not.toContainText("Switch themes");
  await expect(team.getByLabel("Title")).toHaveValue("Dark mode is here");
  await checkpoint(team, "team-changelog-ai-draft");

  // Not on the portal until it's published.
  await ada.goto("/changelog");
  await expect(ada.getByText("Nothing here yet")).toBeVisible();

  // Publishing keeps an edit that isn't saved yet (and publishes what's saved): here a new title, and the post taken off.
  await team.getByLabel("Title").fill("Dark mode is here, at last");
  await completes.getByRole("button", { name: "Remove “Dark mode”" }).click();
  await expect(completes.getByRole("link", { name: "Dark mode" })).toHaveCount(0);
  await expect(completes.getByRole("button", { name: "Link post…" })).toBeFocused();
  await team.getByRole("button", { name: "Publish" }).click();
  const dialog = team.getByRole("alertdialog");
  // One line: where it goes and the post it completes; nobody has subscribed, so no subscriber is emailed.
  await expect(dialog).toContainText("It goes on your portal and in your widget, completes 1 post");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();
  await expect(team.getByLabel("Title")).toHaveValue("Dark mode is here, at last");
  // Published: the sidebar lists the posts it completed (the saved ones; no longer changed here), each opening in a
  // new tab, and opens the entry as readers see it.
  await expect(completes.getByRole("link", { name: "Dark mode" })).toBeVisible();
  await expect(completes.getByRole("link", { name: "Dark mode" })).toHaveAttribute("target", "_blank");
  await expect(completes.getByText("Completed")).toBeVisible();
  await expect(completes.getByRole("button", { name: "Link post…" })).toHaveCount(0);
  await expect(completes.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "View as reader" })).toHaveAttribute("href", `${portalUrl(slug)}/changelog/1`);
  // Save and Unpublish together in the page's own sticky toolbar.
  for (const name of ["Save", "Unpublish"]) {
    const toolbar = (await team.locator('[data-slot="pane-header"]').boundingBox())!;
    const button = (await team.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(button.y).toBeGreaterThanOrEqual(toolbar.y);
    expect(button.y + button.height).toBeLessThanOrEqual(toolbar.y + toolbar.height);
  }
  // The settings beside the text are no taller than the pane under its header (the email banner above it too).
  const paneBox = (await team.locator('[data-slot="pane"]').boundingBox())!;
  const asideBox = (await sidebar.boundingBox())!;
  expect(asideBox.y + asideBox.height).toBeLessThanOrEqual(paneBox.y + paneBox.height);
  // The title shows once at this width too, the one to edit: the pane's header keeps it for screen readers.
  await expect(team.getByRole("heading", { level: 1, name: "Dark mode is here", exact: true })).toBeAttached();
  expect((await team.getByRole("heading", { level: 1 }).boundingBox())!.height).toBeLessThanOrEqual(1);
  await checkpoint(team, "team-changelog-published");
  // On a phone the title shows once, the one to edit (the page's heading kept for screen readers), and Save and
  // Unpublish are in reach at the bottom, Delete in the menu.
  await team.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar.getByRole("link", { name: "View as reader" })).toBeVisible();
  await expect(team.getByRole("heading", { level: 1, name: "Dark mode is here", exact: true })).toBeAttached();
  expect((await team.getByRole("heading", { level: 1 }).boundingBox())!.height).toBeLessThanOrEqual(1);
  // Nor in the top bar: scrolled until the pane's header is under it, the field still in sight below, the bar doesn't
  // repeat the title above the field.
  await team.evaluate(() => window.scrollBy(0, document.querySelector('[data-slot="pane-header"]')!.getBoundingClientRect().bottom));
  await afterIntersections(team);
  await expect(team.getByLabel("Title")).toBeInViewport();
  await expect(team.locator('[data-slot="bar-title"]')).toHaveCount(0);
  // Loaded on a phone, the page keeps what's focused or jumped to clear of the bar (scroll-padding-top).
  await team.reload();
  await expect(team.getByLabel("Title")).toBeVisible();
  const bar = (await team.locator("header").first().boundingBox())!;
  await expect.poll(() => team.evaluate(() => document.documentElement.style.getPropertyValue("--app-toolbar-height"))).toBe(`${bar.height}px`);
  await team.evaluate(() => window.scrollTo(0, 0));
  for (const name of ["Save", "Unpublish"]) {
    await expect(team.getByRole("button", { name, exact: true })).toBeInViewport();
  }
  await checkpoint(team, "team-changelog-published-phone", { fullPage: false });
  // A field under the bar (in the window, behind it), focused, scrolls up above the bar.
  const readerLink = sidebar.getByRole("link", { name: "View as reader" });
  await readerLink.evaluate((link) => window.scrollBy(0, link.getBoundingClientRect().bottom - (window.innerHeight - 10)));
  await readerLink.focus();
  const barButton = (await team.getByRole("button", { name: "Unpublish" }).boundingBox())!;
  const focusedBox = (await readerLink.boundingBox())!;
  expect(focusedBox.y).toBeGreaterThan(0);
  // The bar's top: its button less the bar's padding and border.
  expect(focusedBox.y + focusedBox.height).toBeLessThanOrEqual(barButton.y - 13);
  // Typing in the text, the bar steps aside (the keyboard is up, and the caret could sit under it); back after.
  await editor.focus();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeHidden();
  await editor.blur();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeInViewport();
  await team.getByRole("button", { name: "More actions" }).click();
  await expect(team.getByRole("button", { name: "Delete" })).toBeInViewport();
  await team.keyboard.press("Escape");
  await team.setViewportSize({ width: 1280, height: 720 });
  // Delete is behind the top bar's "More actions"; Unpublish is in the bar.
  await expect(team.getByRole("button", { name: "Delete" })).toBeHidden();
  await team.getByRole("button", { name: "More actions" }).click();
  await expect(team.getByRole("button", { name: "Delete" })).toBeVisible();
  await team.keyboard.press("Escape");
  // The team's list (back from the entry's pane header) shows it with its tag.
  await team.getByRole("link", { name: "All entries" }).click();
  await team.waitForURL(`**/app/${slug}/changelog`);
  await expect(team.getByRole("listitem").filter({ hasText: "Dark mode is here" }).getByText("New", { exact: true })).toBeVisible();
  await expect(team.getByRole("listitem").filter({ hasText: "Dark mode is here" }).getByText("Breaking")).toHaveCSS("color", breaking);

  // On the portal: the entry, its tag and what it completes; the post says where it shipped.
  await ada.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Changelog" }).click();
  const entry = ada.getByRole("article", { name: "Dark mode is here" });
  // The list shows its text as an excerpt, plain (its own page has the headings).
  await expect(entry).toContainText("A darker look");
  await expect(entry.getByRole("heading", { name: "A darker look" })).toHaveCount(0);
  await expect(entry).toContainText("New");
  // (On wide screens the tags are in the date's margin; a phone's copy, above the title, is hidden there.)
  await expect(entry.getByText("Breaking").filter({ visible: true })).toHaveCSS("color", breaking);
  await expect(entry).toContainText("Switch to the dark theme from your profile menu.");
  await checkpoint(ada, "portal-changelog");
  // Readers react on the entry's own page, one of each, on and off; the team's list shows the counts.
  await entry.getByRole("link", { name: "Dark mode is here" }).click();
  await ada.waitForURL(/\/changelog\/1$/);
  await expect(entry.getByRole("heading", { name: "A darker look", level: 2 })).toBeVisible();
  // Its page: the way back, the 36px title, its tags and date under it.
  await expect(entry.getByRole("link", { name: "Changelog" })).toHaveAttribute("href", "/changelog");
  const pageTitle = entry.getByRole("heading", { level: 1, name: "Dark mode is here" });
  await expect(pageTitle).toHaveCSS("font-size", "36px");
  const pageTitleBox = (await pageTitle.boundingBox())!;
  expect((await entry.getByText("New", { exact: true }).boundingBox())!.y).toBeGreaterThan(pageTitleBox.y + pageTitleBox.height);
  // Get updates by email after it: a plain section on the paper, not a card.
  await expect(ada.getByRole("region", { name: "Get updates by email" })).toHaveCSS("box-shadow", "none");
  const tada = entry.getByRole("button", { name: /^React with 🎉/ });
  // Reactions are grey fills until one is yours (the accent's tint).
  const unpicked = await tada.evaluate((button) => getComputedStyle(button).backgroundColor);
  expect(unpicked).not.toBe("rgba(0, 0, 0, 0)");
  // Its emoji is grey too until it's yours.
  const emoji = (button: typeof tada) => button.locator("span").first().evaluate((span) => getComputedStyle(span).filter);
  expect(await emoji(tada)).toContain("grayscale");
  // No count until there is one.
  await expect(tada).toHaveAccessibleName("React with 🎉");
  await expect(tada).toHaveText("🎉");
  await tada.click();
  await expect(tada).toHaveAccessibleName("React with 🎉 (1)");
  await expect(tada).toHaveAttribute("aria-pressed", "true");
  await expect(tada).toBeEnabled();
  await expect.poll(() => tada.evaluate((button) => getComputedStyle(button).backgroundColor)).not.toBe(unpicked);
  await expect.poll(() => emoji(tada)).not.toContain("grayscale");
  await checkpoint(ada, "portal-changelog-reacted");
  await team.goto(`/app/${slug}/changelog`);
  await expect(team.getByRole("listitem").filter({ hasText: "Dark mode is here" }).filter({ hasText: "Published" })).toContainText("🎉 1");
  // Signed out: the counts, and a nudge to sign in.
  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto("/changelog/1");
  const readerTada = reader.getByRole("button", { name: /^React with 🎉/ });
  await expect(readerTada).toHaveAccessibleName("React with 🎉 (1)");
  await expect(readerTada).toBeDisabled();
  await expect(readerTada).toHaveAttribute("title", "Sign in to react");
  // On the list too, under the entry.
  await ada.goto("/changelog");
  await expect(ada.getByRole("article", { name: "Dark mode is here" }).getByRole("button", { name: /^React with 🎉/ })).toHaveAccessibleName("React with 🎉 (1)");
  // There as grey fills too, not bare emoji; and they react there, above the title's link stretched over the entry.
  const listThumbs = ada.getByRole("article", { name: "Dark mode is here" }).getByRole("button", { name: /^React with 👍/ });
  await expect(listThumbs).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await listThumbs.click();
  await expect(listThumbs).toHaveAttribute("aria-pressed", "true");
  await expect(listThumbs).toBeEnabled();
  await listThumbs.click();
  await expect(listThumbs).toHaveAttribute("aria-pressed", "false");
  await expect(listThumbs).toBeEnabled();
  await expect(ada).toHaveURL(/\/changelog$/);
  await ada.goBack();
  // Taken back.
  await tada.click();
  await expect(tada).toHaveAccessibleName("React with 🎉");
  await expect(tada).toHaveAttribute("aria-pressed", "false");
  await expect(tada).toBeEnabled();
  await reader.reload();
  await expect(readerTada).toHaveAccessibleName("React with 🎉");
  await reader.context().close();
  // Feed readers find it too, from the list.
  await ada.goto("/changelog");
  await expect(ada.locator('link[rel="alternate"][type="application/rss+xml"]')).toHaveAttribute("href", `${portalUrl(slug)}/changelog/rss.xml`);
  const feed = await (await ada.request.get(`${portalUrl(slug)}/changelog/rss.xml`)).text();
  expect(feed).toContain("<title>Dark mode is here</title>");
  // The idea it shipped, with how many asked for it: a grey pill, as a reaction that isn't yours.
  const built = entry.getByRole("link", { name: /^Built from an idea · \d+ votes?\s*: Dark mode$/ });
  await expect(built).toHaveCSS("background-color", await entry.getByRole("button", { name: /^React with 👍/ }).evaluate((button) => getComputedStyle(button).backgroundColor));
  await built.click();
  await ada.waitForURL(/\/feedback\/[a-z0-9-]+\/dark-mode-1$/);
  await expect(ada.getByText("Completed").first()).toBeVisible();
  await expect(ada.getByRole("link", { name: "Dark mode is here" })).toHaveAttribute("href", "/changelog/1");

  // The list opens on Published while there are no drafts; nothing but the new entry in its header.
  await team.goto(`/app/${slug}/changelog`);
  const tabs = team.getByRole("navigation", { name: "Entries" });
  await expect(tabs.getByRole("link", { name: "Published 1" })).toHaveAttribute("aria-current", "page");
  await tabs.getByRole("link", { name: "Drafts 0" }).click();
  await expect(team.getByText("No drafts")).toBeVisible();
  await expect(team.getByRole("button", { name: "Writing style" })).toHaveCount(0);

  // The changelog's AI settings (Settings → AI → Changelog): instructions, and the published entry as an example.
  const tone = `Friendly, short sentences, no jargon (${slug}).`;
  await team.goto(`/app/${slug}/settings`);
  await team.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Changelog" }).click();
  await team.waitForURL(`**/app/${slug}/settings/changelog`);
  await expect(team.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Changelog" })).toHaveAttribute("aria-current", "page");
  await team.getByLabel("Instructions").fill(tone);
  // An example is picked from the published entries and shows as a chip.
  await team.getByRole("button", { name: "Pick a style example" }).click();
  await team.getByRole("dialog", { name: "Pick a style example" }).getByRole("button", { name: "Dark mode is here" }).click();
  const examples = team.getByRole("list", { name: "Style examples" });
  await expect(examples.getByRole("listitem")).toHaveText(["Dark mode is here"]);
  // The one published entry is picked: there's no other to pick.
  await expect(team.getByRole("button", { name: "Pick a style example" })).toBeDisabled();
  // While it saves, the form is locked (an edit then wouldn't be saved).
  let releaseSave!: () => void;
  const saveHeld = new Promise<void>((resolve) => (releaseSave = resolve));
  const saving = `**/app/${slug}/settings/changelog`;
  await team.route(saving, async (route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }
    const response = await route.fetch();
    await saveHeld;
    await route.fulfill({ response });
  });
  // The page's one Save, in its header.
  await team.getByRole("button", { name: "Save changes" }).click();
  await expect(team.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await expect(team.locator("form:has(#style-tone)")).toHaveAttribute("inert");
  releaseSave();
  await expect(team.getByText("Changelog saved")).toBeVisible();
  await team.unroute(saving);
  // Saved, not just left in the form: it's there after a reload.
  await team.reload();
  await expect(team.getByLabel("Instructions")).toHaveValue(tone);
  await expect(examples.getByRole("listitem")).toHaveText(["Dark mode is here"]);
  await expect(team.getByRole("button", { name: "Save changes" })).toBeDisabled();

  // The AI model, on the same page: a level, saved as it's chosen, with the model drafts run on under its label.
  // (A server without plans has every level; changelog-settings.spec.ts has the plans.)
  const aiModel = team.getByRole("radiogroup", { name: "AI model" });
  await expect(aiModel.getByRole("radio")).toHaveText(["Affordable", "Balanced", "Best", "Custom"]);
  await expect(aiModel.getByRole("radio", { name: "Balanced" })).toBeChecked();
  await expect(team.getByText("Drafts Claude Haiku 5.5", { exact: true })).toBeVisible();
  await aiModel.getByRole("radio", { name: "Best" }).click();
  await expect(team.getByText("AI model saved")).toBeVisible();
  await expect(aiModel.getByRole("radio", { name: "Best" })).toBeChecked();
  await expect(team.getByText("Drafts Claude Opus 5.5", { exact: true })).toBeVisible();
  await checkpoint(team, "team-settings-changelog");
  // Where the page was: its old address still opens it.
  await team.goto(`/app/${slug}/settings/writing-style`);
  await team.waitForURL(`**/app/${slug}/settings/changelog`);
  await expect(team.getByRole("radiogroup", { name: "AI model" }).getByRole("radio", { name: "Best" })).toBeChecked();

  // The next AI draft follows the instructions and examples, written by the level's model.
  await team.goto(`/app/${slug}/changelog`);
  await team.getByRole("link", { name: "New entry" }).click();
  await team.getByLabel("Title").fill("Faster search");
  await team.getByRole("textbox", { name: "What changed" }).click();
  await team.keyboard.type("Search got quicker.");
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/changelog/2`);
  await nextModelReply(
    JSON.stringify({
      title: "Faster search",
      notes:
        "Search is quicker now.\n\n## Faster search\n\nResults show up in about half the time they used to, even on big boards with lots of posts.\n\n## Better matches\n\nSearch looks at comments too.",
    }),
    tone,
  );
  await team.getByRole("button", { name: "Edit with AI" }).click();
  await team.getByRole("menuitem", { name: "Draft with AI…" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Replace the text" }).click();
  await expect(team.getByText("Drafted with AI")).toBeVisible();
  const asked = (await modelRequests()).find((request) => request.user.includes(tone));
  expect(asked?.model).toBe("anthropic/claude-opus-5.5");
  expect(asked?.user).toContain('"title": "Dark mode is here"');
  expect(asked?.user).toContain("Switch to the dark theme from your profile menu.");

  // The editor's AI helpers edit the saved text, so unsaved changes come first.
  const text = team.getByRole("textbox", { name: "What changed" });
  await text.getByText("Search looks at comments too.").click();
  await team.keyboard.type(" And more");
  const aiMenu = team.getByRole("button", { name: "Edit with AI" });
  await aiMenu.click();
  await team.getByRole("menuitem", { name: "Shorten", exact: true }).click();
  await expect(team.getByText("Save your changes first: AI edits the saved text.")).toBeVisible();
  await team.reload();

  // Shorten: a preview of what changes, saved only on Accept.
  await nextModelReply(
    JSON.stringify({
      notes: "Search is quicker now.\n\n## Faster search\n\nResults in half the time.\n\n## Better matches\n\nSearch looks at comments too.",
    }),
    tone,
  );
  await aiMenu.click();
  await checkpoint(team, "team-changelog-ai-menu", { fullPage: false });
  await team.getByRole("menuitem", { name: "Shorten", exact: true }).click();
  const preview = team.getByRole("dialog", { name: "Shorter version" });
  await expect(preview.locator("del")).toHaveText("Results show up in about half the time they used to, even on big boards with lots of posts.");
  await expect(preview.locator("ins")).toHaveText("Results in half the time.");
  await checkpoint(team, "team-changelog-ai-shorten-preview", { fullPage: false });
  await preview.getByRole("button", { name: "Accept" }).click();
  await expect(preview).toBeHidden();
  await expect(text).toContainText("Results in half the time.");
  await team.reload();
  await expect(text).toContainText("Results in half the time.");
  await expect(text).not.toContainText("even on big boards");

  // Rewrite the section with the cursor, with an instruction; the rest stays.
  const instruction = `Mention titles too (${slug})`;
  await nextModelReply(JSON.stringify({ notes: "## Better matches\n\nSearch looks at post titles and comments." }), instruction);
  await text.getByText("Search looks at comments too.").click();
  await aiMenu.click();
  await team.getByRole("menuitem", { name: "Rewrite this section…" }).click();
  const ask = team.getByRole("dialog", { name: "Rewrite this section" });
  await expect(ask).toContainText("“Better matches”, where your cursor is.");
  await ask.getByLabel("Instruction (optional)").fill(instruction);
  await checkpoint(team, "team-changelog-ai-rewrite-section", { fullPage: false });
  await ask.getByRole("button", { name: "Rewrite" }).click();
  const rewritten = team.getByRole("dialog", { name: "Rewritten section" });
  await expect(rewritten.locator("ins")).toHaveText("Search looks at post titles and comments.");
  await checkpoint(team, "team-changelog-ai-rewrite-preview", { fullPage: false });
  await rewritten.getByRole("button", { name: "Accept" }).click();
  await expect(rewritten).toBeHidden();
  await expect(text).toContainText("Search looks at post titles and comments.");
  await expect(text).toContainText("Results in half the time.");
  const section = (await modelRequests()).find((request) => request.user.includes(instruction));
  expect(section?.user).toContain('"textToEdit": "## Better matches\\n\\nSearch looks at comments too."');

  // Typing while the model writes: Accept doesn't save over it (the reply is held until the typing is done).
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await team.route(
    `**/app/${slug}/changelog/2`,
    async (route) => {
      if (route.request().method() !== "POST") {
        return route.fallback();
      }
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await nextModelReply(JSON.stringify({ notes: "Search is quicker now. Written while you typed." }), tone);
  await aiMenu.click();
  await team.getByRole("menuitem", { name: "Explain for non-developers" }).click();
  await expect(team.getByRole("button", { name: "Writing…" })).toBeVisible();
  // Off while it writes, but keeping the keyboard's focus (as the menu gave it back).
  await expect(team.getByRole("button", { name: "Writing…" })).toBeFocused();
  // Into the text at its very end, through the editor itself (as the app does), then waited for in the editor's own state:
  // a click's or a key's caret, or the editor restoring an earlier one on focus, could land elsewhere.
  type Editor = { isFocused: boolean; commands: { focus: (at: "end") => boolean }; state: { selection: { empty: boolean; head: number }; doc: { textBetween: (from: number, to: number, separator?: string) => string } } };
  await text.evaluate((el) => (el as unknown as { editor: Editor }).editor.commands.focus("end"));
  await expect
    .poll(() =>
      text.evaluate((el) => {
        const { editor } = el as unknown as { editor: Editor };
        const { selection, doc } = editor.state;
        return editor.isFocused && selection.empty && doc.textBetween(0, selection.head, "\n").endsWith("comments.");
      }),
    )
    .toBe(true);
  await team.keyboard.type(" Typed meanwhile.");
  release();
  const meanwhile = team.getByRole("dialog", { name: "Explained for non-developers" });
  await meanwhile.getByRole("button", { name: "Accept" }).click();
  await expect(team.getByText("Save your changes first: AI edits the saved text.")).toBeVisible();
  // Kept open, to save first and try again.
  await expect(meanwhile).toBeVisible();
  await meanwhile.getByRole("button", { name: "Discard" }).click();
  await expect(meanwhile).toBeHidden();
  await expect(text).toContainText("Search looks at post titles and comments. Typed meanwhile.");
  await team.reload();
  await expect(text).not.toContainText("Written while you typed.");
  await expect(text).not.toContainText("Typed meanwhile.");

  // Discarded: nothing changes.
  await nextModelReply(JSON.stringify({ notes: "Search is quicker now. Plain words only." }), tone);
  await aiMenu.click();
  await team.getByRole("menuitem", { name: "Explain for non-developers" }).click();
  const plain = team.getByRole("dialog", { name: "Explained for non-developers" });
  await expect(plain.locator("ins")).toHaveText("Search is quicker now. Plain words only.");
  await plain.getByRole("button", { name: "Discard" }).click();
  await expect(plain).toBeHidden();
  await team.reload();
  await expect(text).toContainText("Search looks at post titles and comments.");
  await expect(text).not.toContainText("Plain words only.");

  // With a draft and a published entry, the list opens on Drafts; each tab lists its own.
  await team.goto(`/app/${slug}/changelog`);
  const entryTabs = team.getByRole("navigation", { name: "Entries" });
  await expect(entryTabs.getByRole("link", { name: "Drafts 1" })).toHaveAttribute("aria-current", "page");
  await expect(team.getByRole("link", { name: "Faster search" })).toBeVisible();
  await expect(team.getByRole("link", { name: "Dark mode is here" })).toHaveCount(0);
  await entryTabs.getByRole("link", { name: "Published 1" }).click();
  await expect(team.getByRole("link", { name: "Dark mode is here" })).toBeVisible();
  await expect(team.getByRole("link", { name: "Faster search" })).toHaveCount(0);

  // A reaction the server refuses (the entry was unpublished meanwhile) says why and isn't shown as kept.
  await ada.goto("/changelog/1");
  const heart = ada.getByRole("button", { name: /^React with ❤️/ });
  await expect(heart).toHaveAccessibleName("React with ❤️");
  await team.goto(`/app/${slug}/changelog/1`);
  await team.getByRole("button", { name: "Unpublish" }).click();
  await expect(team.getByText("Unpublished", { exact: true })).toBeVisible();
  await heart.click();
  await expect(ada.getByText("There's no changelog entry #1")).toBeVisible();
  await expect(heart).toHaveAccessibleName("React with ❤️");
  await expect(heart).toHaveAttribute("aria-pressed", "false");
});

test("an entry's posts in the editor: a merged one doesn't block saving, and unpublishing shows the saved ones", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  for (const title of ["Dark mode", "Exports", "CSV exports", "Calendar sync"]) {
    await api("/posts", { board: "feature-requests", title });
  }
  await api("/posts/4", { status: "planned" }, "PATCH");
  await api("/changelog", { title: "Dark mode is here", posts: [1, 2] });
  // Exports is merged away after the entry listed it: the editor leaves it out, and saving drops it.
  await api("/posts/2/merge", { into: 3 });
  await team.goto(`/app/${slug}/changelog/1`);
  const completes = team.getByRole("region", { name: "Posts it completes" });
  await expect(completes.getByRole("link")).toHaveText(["Dark mode"]);
  await team.getByLabel("Title").fill("Dark mode is here at last");
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  await team.reload();
  await expect(completes.getByRole("link")).toHaveText(["Dark mode"]);
  await checkpoint(team, "team-changelog-merged-post-dropped");

  // "Link post…" searches every planned, in-progress and completed post, not just the 100 changed last.
  for (let n = 5; n <= 105; n += 10) {
    await Promise.all(
      Array.from({ length: Math.min(10, 106 - n) }, async (_, i) => {
        await api("/posts", { board: "feature-requests", title: `Small fix ${n + i}` });
      }),
    );
  }
  for (let n = 5; n <= 105; n += 10) {
    await Promise.all(Array.from({ length: Math.min(10, 106 - n) }, (_, i) => api(`/posts/${n + i}`, { status: "planned" }, "PATCH")));
  }
  await team.reload();
  await completes.getByRole("button", { name: "Link post…" }).click();
  const linkPost = team.getByRole("dialog", { name: "Link a post" });
  await linkPost.getByLabel("Search posts").fill("calendar");
  // Open posts aren't offered: Dark mode is open, and only "Calendar sync" matches.
  await linkPost.getByRole("button", { name: /#4\s*Calendar sync/ }).click();
  await expect(linkPost).toBeHidden();
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  await team.reload();
  await expect(completes.getByRole("link")).toHaveText(["Dark mode", "Calendar sync"]);
  await completes.getByRole("button", { name: "Remove “Calendar sync”" }).click();
  // While it saves (its answer held here), Publish waits: publishing meanwhile would complete the post being taken off.
  let releaseSave!: () => void;
  const saveHeld = new Promise<void>((resolve) => (releaseSave = resolve));
  await team.route("**/*", async (route) => {
    if (!route.request().headers()["next-action"]) {
      return route.fallback();
    }
    const response = await route.fetch();
    await saveHeld;
    await route.fulfill({ response });
  });
  // Saved while the keyboard is on Publish (the click doesn't move focus): it stays there, and Enter does nothing yet.
  const publishButton = team.getByRole("button", { name: "Publish" });
  await publishButton.focus();
  await team.getByRole("button", { name: "Save", exact: true }).dispatchEvent("click");
  await expect(publishButton).toBeDisabled();
  await expect(publishButton).toBeFocused();
  await team.keyboard.press("Enter");
  await expect(team.getByRole("alertdialog")).toHaveCount(0);
  releaseSave();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  await team.unroute("**/*");
  await expect(publishButton).toBeEnabled();
  await expect(publishButton).toBeFocused();
  // Reloaded, so this save's toast is gone before the next save's is waited for.
  await team.reload();
  await expect(completes.getByRole("link")).toHaveText(["Dark mode"]);

  // A post taken off without saving, then published and unpublished: the sidebar shows (and saves) the saved posts.
  await completes.getByRole("button", { name: "Remove “Dark mode”" }).click();
  await expect(completes.getByRole("link")).toHaveCount(0);
  // Quietly: not marked new.
  const announced = team.getByRole("group", { name: "How it's announced" });
  await announced.getByRole("checkbox", { name: "Mark it new" }).uncheck();
  await team.getByRole("button", { name: "Publish" }).click();
  await expect(team.getByRole("alertdialog")).toContainText("It goes on your portal and in your widget.");
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  await expect(announced).toContainText("In your widget's What's new, not marked new.");
  await expect(completes.getByRole("link")).toHaveText(["Dark mode"]);
  // While it's taken down (its answer held here), Save waits: it would save over what that changes.
  let releaseUnpublish!: () => void;
  const unpublishHeld = new Promise<void>((resolve) => (releaseUnpublish = resolve));
  await team.route("**/*", async (route) => {
    if (!route.request().headers()["next-action"]) {
      return route.fallback();
    }
    const response = await route.fetch();
    await unpublishHeld;
    await route.fulfill({ response });
  });
  // Taken down from the keyboard: while it runs, Unpublish is off but keeps the keyboard's focus.
  const unpublishButton = team.getByRole("button", { name: "Unpublish" });
  await unpublishButton.focus();
  await team.keyboard.press("Enter");
  await expect(unpublishButton).toHaveAttribute("aria-disabled", "true");
  await expect(unpublishButton).toBeFocused();
  await expect(team.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  releaseUnpublish();
  await expect(team.getByText("Unpublished", { exact: true })).toBeVisible();
  await team.unroute("**/*");
  await expect(completes.getByRole("button", { name: "Remove “Dark mode”" })).toBeVisible();
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  await team.reload();
  await expect(completes.getByRole("link")).toHaveText(["Dark mode"]);
  await checkpoint(team, "team-changelog-saved-posts-after-unpublish");
});

test("the changelog's tags filter it, a page further are older entries, and months jump through them", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // One more than a page holds (20): the odd ones new, the even ones fixes.
  // The newest runs long: the list shows an excerpt, the rest on its page.
  // (Release 20 shorter: one paragraph of ~190 characters, three lines at most on a laptop, past them on a phone.)
  const idea = (title: string) => api("/posts", { board: "feature-requests", title, body: "Details of the idea." }) as unknown as Promise<{ number: number }>;
  const ideas = [(await idea("Export every board, its posts, votes and comments, to a spreadsheet in one go")).number, (await idea("Dark mode")).number];
  const long = (repeats: number) => `${"Faster boards and fewer clicks. ".repeat(repeats)}\n\nAnd last, exports in CSV.`;
  for (let n = 1; n <= 21; n++) {
    const body = n === 21 ? long(24) : n === 20 ? "Faster boards and fewer clicks. ".repeat(6).trim() : "Faster boards and fewer clicks.";
    // Release 19 shipped two ideas, one with a long title: a pill each, on the list too.
    const posts = n === 19 ? ideas : undefined;
    await api("/changelog", { title: `Release ${n}`, body, tags: [n % 2 ? "new" : "fixed"], posts });
    await api(`/changelog/${n}/publish`, {});
  }
  // Over three months: 12 to 21 in October, 2 to 11 in September, Release 1 in August (on page 2).
  await publishedOn(slug, `CASE WHEN number = 1 THEN '2026-08-15' WHEN number <= 11 THEN '2026-09-15' ELSE '2026-10-15' END`);

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto("/changelog");
  const main = reader.getByRole("main");
  await expect(main.getByRole("heading", { name: "Release 21" })).toBeVisible();
  await expect(main.getByRole("heading", { name: "Release 1", exact: true })).toHaveCount(0);
  // A pill for each tag the entries have, with its count.
  const tags = main.getByRole("navigation", { name: "Tags" });
  await expect(tags.getByRole("link")).toHaveText(["All 21", "New 11", "Fixed 10"]);
  await expect(tags.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page");
  // The accent is Subscribe's alone (the page's one filled button): the tags are one grey, the timeline's dot and the
  // month index's current month neutral.
  const style = (locator: Locator, property: string) => locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
  const accent = await style(main.getByRole("button", { name: "Subscribe" }), "background-color");
  const tagOf = (title: string, tag: string) => main.getByRole("article", { name: title }).getByText(tag, { exact: true }).filter({ visible: true });
  const grey = await style(tagOf("Release 21", "New"), "background-color");
  expect(await style(tagOf("Release 20", "Fixed"), "background-color")).toBe(grey);
  expect(grey).not.toBe(accent);
  // On wide screens the date sits in a margin left of the entry.
  const latest = main.getByRole("article", { name: "Release 21" });
  const date = (await latest.locator("time:visible").boundingBox())!;
  const title = (await latest.getByRole("heading").boundingBox())!;
  expect(date.x + date.width).toBeLessThan(title.x);
  // Excerpts, every entry's the same: three lines at most, fading out where cut; the long one's doesn't reach its last
  // paragraph, which its page has.
  const lines = async (excerpt: Locator) => (await excerpt.evaluate((p) => p.getBoundingClientRect().height)) / 28;
  const excerptOf = (title: string) => main.getByRole("article", { name: title }).locator("p", { hasText: "Faster boards" });
  expect(await lines(excerptOf("Release 21"))).toBe(3);
  expect(await style(excerptOf("Release 21"), "mask-image")).toContain("gradient");
  expect(await lines(excerptOf("Release 20"))).toBeGreaterThan(1);
  expect(await lines(excerptOf("Release 20"))).toBeLessThanOrEqual(3);
  await expect(main.getByText("exports in CSV")).toHaveCount(0);
  // One link per entry (its title), stretched over the entry: the excerpt opens the entry's page too.
  await expect(main.getByRole("article", { name: "Release 21" }).getByRole("link")).toHaveCount(1);
  await expect(main.getByRole("article", { name: "Release 20" }).getByRole("link")).toHaveCount(1);
  await expect(main.getByRole("article", { name: "Release 20" }).getByRole("link")).toHaveAccessibleName("Release 20");
  // What a pointer hits: on the excerpt, faded or not, the title's link; on a tag, the tag (above the link).
  const hit = (locator: Locator) =>
    locator.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { inside: el.contains(at), link: at?.closest("a")?.getAttribute("href") ?? null };
    });
  expect(await hit(excerptOf("Release 21"))).toEqual({ inside: false, link: "/changelog/21" });
  expect(await hit(tagOf("Release 21", "New"))).toEqual({ inside: true, link: null });
  // (forced: the title's link over the text is what takes the click, which Playwright otherwise reads as blocked)
  await excerptOf("Release 21").click({ force: true });
  await expect(reader).toHaveURL(/\/changelog\/21$/);
  await expect(main.getByText("And last, exports in CSV.")).toBeVisible();
  await reader.goBack();
  await excerptOf("Release 20").click({ force: true });
  await expect(reader).toHaveURL(/\/changelog\/20$/);
  await reader.goBack();
  // The month index, beside the list, stays in view as the page scrolls; a month opens the page its newest entry is on.
  const dot = latest.locator("p:has(> time) > span[aria-hidden]");
  expect(await style(dot, "background-color")).not.toBe(accent);
  expect(await style(dot, "box-shadow")).not.toContain(accent);
  const months = main.getByRole("navigation", { name: "Months" });
  await expect(months.getByRole("link")).toHaveCount(3);
  await expect(months.getByRole("link", { name: "October 2026, 10 entries" })).toBeVisible();
  // Plain rows: the current month in the neutral fill, no accent bar beside it.
  const october = months.getByRole("link", { name: "October 2026, 10 entries" });
  expect(await style(october, "border-left-width")).toBe("0px");
  expect(await style(october, "background-color")).not.toBe(accent);
  expect(await style(october, "background-color")).not.toBe(await style(months.getByRole("link", { name: "September 2026, 10 entries" }), "background-color"));
  expect((await months.boundingBox())!.x).toBeGreaterThan(title.x + title.width);
  // The keyboard reaches it right after the tags' row (its RSS and Subscribe), before the entries.
  await tags.getByRole("link", { name: "Fixed" }).focus();
  await reader.keyboard.press("Tab");
  await expect(main.getByRole("link", { name: "RSS feed" })).toBeFocused();
  await reader.keyboard.press("Tab");
  await expect(main.getByRole("button", { name: "Subscribe" })).toBeFocused();
  await reader.keyboard.press("Tab");
  await expect(months.getByRole("link", { name: "October 2026, 10 entries" })).toBeFocused();
  await checkpoint(reader, "portal-changelog");
  await reader.emulateMedia({ colorScheme: "dark" });
  await checkpoint(reader, "portal-changelog-dark");
  await reader.emulateMedia({ colorScheme: "light" });
  // Scrolled past where it started (all of it), it's still in view.
  const navBottom = await months.evaluate((nav) => nav.getBoundingClientRect().bottom + window.scrollY);
  await reader.evaluate(() => window.scrollTo(0, 3000));
  await expect.poll(() => reader.evaluate(() => window.scrollY)).toBeGreaterThan(navBottom);
  await expect(main.getByRole("heading", { name: "Release 21" })).not.toBeInViewport();
  await expect(months).toBeInViewport();
  // September starts at Release 11, far down this page: the address names it, and it's scrolled to.
  await months.getByRole("link", { name: "September 2026, 10 entries" }).click();
  await expect(reader).toHaveURL(/\/changelog#2026-09$/);
  await expect(main.locator('[id="2026-09"]').getByRole("article")).toHaveAccessibleName("Release 11");
  await expect(main.getByRole("heading", { name: "Release 11" })).toBeInViewport();
  await expect(main.getByRole("heading", { name: "Release 21" })).not.toBeInViewport();
  await months.getByRole("link", { name: "August 2026, 1 entry" }).click();
  await expect(reader).toHaveURL(/\/changelog\/page\/2#2026-08$/);
  await expect(main.locator('[id="2026-08"]').getByRole("article")).toHaveAccessibleName("Release 1");
  await expect(main.getByRole("heading", { name: "Release 1", exact: true })).toBeInViewport();

  // A chip filters the list; the address keeps it (to share, to reload), and the pages keep it too.
  await reader.goto("/changelog");
  await tags.getByRole("link", { name: "Fixed" }).click();
  await expect(reader).toHaveURL(/\/changelog\?tag=fixed$/);
  await expect(main.getByRole("heading", { name: "Release 21" })).toHaveCount(0);
  await expect(main.getByRole("heading", { name: "Release 20" })).toBeVisible();
  await reader.reload();
  await expect(tags.getByRole("link", { name: "Fixed" })).toHaveAttribute("aria-current", "page");
  await expect(main.getByRole("article")).toHaveCount(10);
  await expect(main.getByRole("link", { name: "Older entries" })).toHaveCount(0);
  // On a phone the date stays above the title, and there's no month index (the header's menu has the entries).
  await reader.setViewportSize({ width: 390, height: 844 });
  const fix = main.getByRole("article", { name: "Release 20" });
  expect((await fix.locator("time:visible").boundingBox())!.y).toBeLessThan((await fix.getByRole("heading").boundingBox())!.y);
  await expect(months).toBeHidden();
  expect(await reader.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // RSS and Subscribe as round buttons beside the title, on a narrow phone too; the row's own pair is hidden.
  for (const width of [360, 390]) {
    await reader.setViewportSize({ width, height: 844 });
    expect(await reader.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const heading = (await main.getByRole("heading", { level: 1, name: "Changelog" }).boundingBox())!;
    await expect(main.getByRole("link", { name: "RSS feed" })).toHaveCount(1);
    const rss = (await main.getByRole("link", { name: "RSS feed" }).boundingBox())!;
    const bell = (await main.getByRole("button", { name: "Subscribe" }).boundingBox())!;
    expect(rss.x).toBeGreaterThanOrEqual(heading.x + heading.width);
    expect(rss.y).toBeLessThan(heading.y + heading.height);
    expect(bell.x + bell.width).toBeLessThanOrEqual(width);
    // Both the size of Feedback's round buttons on a phone.
    expect([rss.width, rss.height, bell.width, bell.height]).toEqual([40, 40, 40, 40]);
  }
  await checkpoint(reader, "portal-changelog-fixed-phone");
  await reader.emulateMedia({ colorScheme: "dark" });
  await checkpoint(reader, "portal-changelog-fixed-phone-dark");
  await reader.emulateMedia({ colorScheme: "light" });
  await reader.setViewportSize({ width: 1280, height: 720 });
  // A tag no entry has says so, and goes back to them all.
  await reader.goto("/changelog?tag=improved");
  await expect(main.getByText("No Improved entries yet")).toBeVisible();
  await main.getByRole("link", { name: "Show all entries" }).click();
  await expect(reader).toHaveURL(/\/changelog$/);

  await main.getByRole("link", { name: "Older entries" }).click();
  await expect(reader).toHaveURL(/\/changelog\/page\/2$/);
  await expect(main.getByRole("heading", { name: "Release 1", exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: "Older entries" })).toHaveCount(0);
  await checkpoint(reader, "portal-changelog-page-2");
  await main.getByRole("link", { name: "Newer entries" }).click();
  await expect(reader).toHaveURL(/\/changelog$/);
  // Fixed's newest, Release 20, fits its three lines on a laptop (no fade); on a phone it wraps past them, and fades
  // where the clamp cuts it.
  await reader.goto("/changelog?tag=fixed");
  // (once it has measured itself: the server's page has no fade either way)
  await expect(excerptOf("Release 20")).toHaveAttribute("data-measured", "true");
  await expect(excerptOf("Release 20")).toHaveCSS("mask-image", "none");
  await reader.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => style(excerptOf("Release 20"), "mask-image")).toContain("gradient");
  await reader.goto("/changelog");
  // Not only the first entry's: on the whole list, Release 20 (the second) fades too.
  await expect.poll(() => style(excerptOf("Release 20"), "mask-image")).toContain("gradient");
  // A long idea's pill stays in its entry (its title shortened), and the page doesn't scroll sideways.
  const shipped = main.getByRole("article", { name: "Release 19" });
  const pill = (await shipped.getByRole("link", { name: /^Export every board/ }).boundingBox())!;
  expect(pill.x + pill.width).toBeLessThanOrEqual((await shipped.boundingBox())!.x + (await shipped.boundingBox())!.width + 1);
  expect(await reader.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  // On a phone, the header's menu lists the entries by date (with their titles), the one being read marked.
  await reader.setViewportSize({ width: 390, height: 844 });
  await checkpoint(reader, "portal-changelog-phone", { fullPage: false });
  await reader.emulateMedia({ colorScheme: "dark" });
  await checkpoint(reader, "portal-changelog-phone-dark", { fullPage: false });
  await reader.emulateMedia({ colorScheme: "light" });
  await reader.goto("/changelog/21");
  await reader.getByRole("banner").getByRole("button", { name: "Menu" }).click();
  const entries = reader.getByRole("dialog", { name: "Menu" }).getByRole("navigation", { name: "Changelog entries" });
  const newest = entries.getByRole("link", { name: /^15 October 2026\s*Release 21$/ });
  await expect(newest).toHaveAttribute("aria-current", "page");
  await expect(entries.getByRole("link", { name: /Release 20$/ })).not.toHaveAttribute("aria-current");
  await checkpoint(reader, "portal-changelog-phone-menu", { fullPage: false });
  await entries.getByRole("link", { name: /Release 20$/ }).click();
  await expect(reader).toHaveURL(/\/changelog\/20$/);
  await expect(reader.getByRole("dialog", { name: "Menu" })).toBeHidden();

  // Over more than six months, the index shows the latest six; the rest open under "Earlier months".
  await publishedOn(slug, `DATE '2025-01-15' + number * interval '1 month'`);
  await reader.setViewportSize({ width: 1280, height: 720 });
  await reader.goto("/changelog");
  await expect(months.getByRole("link")).toHaveCount(6);
  await expect(months.getByRole("link").first()).toHaveAccessibleName("October 2026, 1 entry");
  await months.getByText("Earlier months").click();
  await expect(months.getByRole("link")).toHaveCount(21);
  // An older page whose month is folded away opens "Earlier months", so its month shows.
  await reader.goto("/changelog/page/2");
  await expect(months.getByRole("link", { name: "February 2025, 1 entry" })).toBeVisible();
});

test("the next release waits to be written; its entry gets a featured image readers see, and says how many people it told", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  // Ada (her email verified) asks for dark mode, and the team plans it.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto(linkIn(await latestEmailTo(ada.email), "http"));
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, "Dark mode");
  const api = await apiFor(team, slug);
  await api("/posts/1", { status: "planned" }, "PATCH");

  // Merged pull requests gather in the running draft (Autopilot off: nothing to analyse here).
  const installationId = await connectGithub(team, slug);
  await team.goto(`/app/${slug}/settings/autopilot`);
  await team.getByRole("switch", { name: "Analyse merged pull requests" }).click();
  await expect(team.getByText("Autopilot off")).toBeVisible();
  await team.goto(`/app/${slug}/changelog`);
  await expect(team.getByRole("status").filter({ hasText: "release notes" })).toHaveCount(0);
  await mergePullRequest(installationId, { number: 41, title: "Add a dark theme" });
  // One: said in the singular.
  await team.reload();
  const one = team.getByRole("status").filter({ hasText: "release notes" });
  await expect(one).toContainText("A merged pull request is waiting for release notes");
  await expect(one).toContainText("1 merged pull request is in “Next release”, collecting until the next release.");
  await mergePullRequest(installationId, { number: 42, title: "Remember the theme" });

  // The list says they wait for release notes (the draft is still collecting: not ready yet), and opens it.
  await team.reload();
  const ready = team.getByRole("status").filter({ hasText: /Merged pull requests are waiting for release notes|Next release is ready to write/ });
  await expect(ready).toContainText("Merged pull requests are waiting for release notes");
  await expect(ready).toContainText("2 merged pull requests are in “Next release”, collecting until the next release.");
  // Its row says when it was last edited and what it holds: the pull requests, no "0 posts".
  await expect(team.getByRole("listitem").filter({ hasText: "Next release" })).toContainText(/Edited (just now|\d+ minutes? ago) · 2 merged pull requests$/);
  // The running draft is marked neutral, not in a status's colour.
  await expect(team.getByText("Collecting pull requests")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await checkpoint(team, "team-changelog-ready-to-write");
  await team.setViewportSize({ width: 390, height: 844 });
  await expect(ready.getByRole("link", { name: "Write it" })).toBeInViewport();
  await checkpoint(team, "team-changelog-ready-to-write-phone");
  await team.emulateMedia({ colorScheme: "dark" });
  await checkpoint(team, "team-changelog-ready-to-write-phone-dark");
  await team.emulateMedia({ colorScheme: "light" });
  await team.setViewportSize({ width: 1280, height: 720 });
  // A release closes the draft (named after it) before anyone writes it: the notice stays, naming it.
  await publishRelease(installationId, { tag: "v1.4", name: "v1.4" });
  await team.reload();
  // Now it's a release: ready to write.
  await expect(ready).toContainText("Next release is ready to write");
  await expect(ready).toContainText("2 merged pull requests are in “v1.4”.");
  await ready.getByRole("link", { name: "Write it" }).click();
  await team.waitForURL(`**/app/${slug}/changelog/1`);

  // A featured image, under the title (two pictures drawn here: one replaces the other), with the post it completes.
  const scratch = await team.context().newPage();
  const picture = async (color: string) => {
    await scratch.setContent(`<div id="cover" style="width:1200px;height:600px;background:${color}"></div>`);
    return scratch.locator("#cover").screenshot();
  };
  const [first, second] = [await picture("#1d4ed8"), await picture("#0f766e")];
  await scratch.close();
  const sidebar = team.getByRole("complementary", { name: "Entry settings" });
  const featured = team.getByRole("group", { name: "Featured image" });
  // The file input, named (out of sight and of the tab order: Add and Replace open it).
  const file = featured.getByLabel("Featured image", { exact: true });
  const preview = featured.getByRole("img");
  const addButton = featured.getByRole("button", { name: "Add featured image" });
  // Not in the sidebar any more: it leads the text, between the title and the text.
  await expect(sidebar.getByText(/featured image|cover image/i)).toHaveCount(0);
  await expect(addButton).toBeVisible();
  await expect(featured).toContainText("or drop one here · 1200×630 works best");
  const band = (await featured.boundingBox())!;
  expect(band.y).toBeGreaterThan((await team.getByLabel("Title").boundingBox())!.y);
  expect(band.y + band.height).toBeLessThanOrEqual((await team.getByRole("textbox", { name: "What changed" }).boundingBox())!.y);
  await checkpoint(team, "team-changelog-featured-empty");
  // An upload whose server calls fail (the network drops) ends with an error, and Save still works.
  await team.route("**/*", (route) => (route.request().headers()["next-action"] ? route.abort() : route.fallback()));
  await file.setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: first });
  await expect(featured.getByText("The upload failed. Try again.")).toBeVisible();
  await team.unroute("**/*");
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  // Reloaded, so this save's toast is gone before the next save's is waited for.
  await team.reload();
  await expect(addButton).toBeVisible();
  // Dropped on the band, it uploads.
  const droppedFile = (bytes: Buffer) =>
    team.evaluateHandle((bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "cover.png", { type: "image/png" }));
      return transfer;
    }, [...bytes]);
  // (Focus stays on the page, where a reload or a click on blank space leaves it: only an upload started from Add
  // moves it to Replace.)
  const replaceButton = featured.getByRole("button", { name: "Replace featured image" });
  await team.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await addButton.locator("..").dispatchEvent("drop", { dataTransfer: await droppedFile(first) });
  await expect(preview).toBeVisible();
  await expect(replaceButton).not.toBeFocused();
  expect(await team.evaluate(() => document.activeElement === document.body)).toBe(true);
  const firstSrc = await preview.getAttribute("src");
  // Replaced by another: while it uploads (its server calls held here), Save and Publish wait, the image saying why;
  // Remove waits too (the new image would come back after it), and no second upload starts meanwhile (each starts with
  // the same server call, counted here).
  let releaseUpload!: () => void;
  const uploadHeld = new Promise<void>((resolve) => (releaseUpload = resolve));
  const actions: string[] = [];
  await team.route("**/*", async (route) => {
    const action = route.request().headers()["next-action"];
    if (!action) {
      return route.fallback();
    }
    actions.push(action);
    await uploadHeld;
    await route.fallback();
  });
  // Picked from Replace with the keyboard: focus stays on it through the upload (it's off, but not taken out of reach).
  const removeButton = featured.getByRole("button", { name: "Remove featured image" });
  await replaceButton.focus();
  // Shown on keyboard focus.
  await expect(replaceButton).toHaveCSS("opacity", "1");
  await file.setInputFiles({ name: "cover-2.png", mimeType: "image/png", buffer: second });
  await expect(featured.getByRole("status").filter({ hasText: "Uploading…" })).toBeVisible();
  await expect(replaceButton).toBeFocused();
  await expect(team.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(team.getByRole("button", { name: "Publish" })).toBeDisabled();
  await expect(replaceButton).toBeDisabled();
  await expect(removeButton).toBeDisabled();
  await removeButton.focus();
  await team.keyboard.press("Enter");
  await expect(preview).toHaveAttribute("src", firstSrc!);
  await preview.locator("..").dispatchEvent("drop", { dataTransfer: await droppedFile(first) });
  await replaceButton.focus();
  releaseUpload();
  await expect(preview).not.toHaveAttribute("src", firstSrc!);
  await expect(team.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await expect(team.getByRole("button", { name: "Publish" })).toBeEnabled();
  await expect(replaceButton).toBeEnabled();
  await expect(replaceButton).toBeFocused();
  await team.unroute("**/*");
  // One upload: its first call (createUpload) made once.
  expect(actions.filter((action) => action === actions[0])).toHaveLength(1);
  await team.getByLabel("Title").fill("Dark mode is here");
  const completes = team.getByRole("region", { name: "Posts it completes" });
  await completes.getByRole("button", { name: "Link post…" }).click();
  const linkPost = team.getByRole("dialog", { name: "Link a post" });
  await linkPost.getByLabel("Search posts").fill("dark");
  await linkPost.getByRole("button", { name: /#1\s*Dark mode/ }).click();
  await expect(linkPost).toBeHidden();
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  await team.reload();
  // Under the title as readers see it (named for the entry, as on the portal), across the text's column: saved, it's
  // the stored size for that width (this one 1200px wide), not the 480px thumbnail's.
  const canvasCover = featured.getByRole("img", { name: "Dark mode is here", exact: true });
  await expect(canvasCover).toHaveAttribute("src", /\/1200\.webp\?/);
  const coverBox = (await canvasCover.boundingBox())!;
  expect(coverBox.y).toBeGreaterThan((await team.getByLabel("Title").boundingBox())!.y);
  expect(coverBox.y + coverBox.height).toBeLessThanOrEqual((await team.getByRole("textbox", { name: "What changed" }).boundingBox())!.y);
  expect(coverBox.width).toBeGreaterThan(400);
  // Removed (from the keyboard: focus moves to Add, as Remove goes), it's gone once saved; uploaded again, it's back.
  await removeButton.focus();
  await team.keyboard.press("Enter");
  await expect(canvasCover).toHaveCount(0);
  await expect(addButton).toBeFocused();
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  await team.reload();
  // Uploaded from Add, but moved on to the text while it uploads (its server calls held): focus stays in the text.
  let releaseMovedOn!: () => void;
  const movedOnHeld = new Promise<void>((resolve) => (releaseMovedOn = resolve));
  await team.route("**/*", async (route) => {
    if (route.request().headers()["next-action"]) {
      await movedOnHeld;
    }
    await route.fallback();
  });
  await addButton.focus();
  await file.setInputFiles({ name: "cover-2.png", mimeType: "image/png", buffer: second });
  await expect(featured.getByRole("status").filter({ hasText: "Uploading…" })).toBeVisible();
  const text = team.getByRole("textbox", { name: "What changed" });
  await text.focus();
  releaseMovedOn();
  await expect(canvasCover).toBeVisible();
  await expect(text).toBeFocused();
  await removeButton.click();
  await expect(addButton).toBeFocused();
  // Or moved on by a click beside Add (focus left on the page itself): it stays there too.
  let releaseClicked!: () => void;
  const clickedHeld = new Promise<void>((resolve) => (releaseClicked = resolve));
  await team.unroute("**/*");
  await team.route("**/*", async (route) => {
    if (route.request().headers()["next-action"]) {
      await clickedHeld;
    }
    await route.fallback();
  });
  await file.setInputFiles({ name: "cover-2.png", mimeType: "image/png", buffer: second });
  await expect(featured.getByRole("status").filter({ hasText: "Uploading…" })).toBeVisible();
  const around = (await featured.boundingBox())!;
  await team.mouse.click(around.x + 10, around.y + 10);
  await expect(addButton).not.toBeFocused();
  releaseClicked();
  await expect(canvasCover).toBeVisible();
  await expect(replaceButton).not.toBeFocused();
  await team.unroute("**/*");
  await removeButton.click();
  await expect(addButton).toBeVisible();
  // Uploaded from Add with the keyboard: Add goes with the upload, and focus moves to Replace, even after a press
  // meanwhile that left focus on Add (a touch starting a scroll; its server calls held for it).
  let releasePressed!: () => void;
  const pressedHeld = new Promise<void>((resolve) => (releasePressed = resolve));
  await team.route("**/*", async (route) => {
    if (route.request().headers()["next-action"]) {
      await pressedHeld;
    }
    await route.fallback();
  });
  await addButton.focus();
  await file.setInputFiles({ name: "cover-2.png", mimeType: "image/png", buffer: second });
  await expect(featured.getByRole("status").filter({ hasText: "Uploading…" })).toBeVisible();
  await team.evaluate(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  await expect(addButton).toBeFocused();
  // Focus moves without scrolling: whoever scrolled away while it uploaded stays where they are.
  await team.evaluate(() => {
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (options?: FocusOptions) {
      if (this.getAttribute("aria-label") === "Replace featured image") {
        (window as unknown as { replaceFocus: FocusOptions | undefined }).replaceFocus = options;
      }
      focus.call(this, options);
    };
  });
  releasePressed();
  // Shown as soon as it's uploaded, before it's saved.
  await expect(canvasCover).toBeAttached();
  await expect(replaceButton).toBeFocused();
  expect(await team.evaluate(() => (window as unknown as { replaceFocus?: FocusOptions }).replaceFocus)).toEqual({ preventScroll: true });
  await expect(canvasCover).toBeVisible();
  await team.unroute("**/*");
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  await canvasCover.hover();
  await expect(replaceButton).toHaveCSS("opacity", "1");
  await checkpoint(team, "team-changelog-cover");
  await team.setViewportSize({ width: 390, height: 844 });
  await expect(canvasCover).toBeInViewport();
  // On a phone (no hover), Replace and Remove always show.
  await team.mouse.move(0, 0);
  await expect(replaceButton).toHaveCSS("opacity", "1");
  await expect(removeButton).toHaveCSS("opacity", "1");
  await checkpoint(team, "team-changelog-cover-phone", { fullPage: false });
  await team.setViewportSize({ width: 1280, height: 720 });

  // Its text is still the pull requests' titles: Draft with AI is the main action (filled, as Save and Publish
  // aren't), and Publish asks first, offering it.
  // (By the primary variant's class, not the colour: buttons fade between fills.)
  const primary = /(^|\s)bg-primary(\s|$)/;
  await expect(team.getByRole("button", { name: "Draft with AI", exact: true })).toHaveClass(primary);
  await expect(team.getByRole("button", { name: "Publish", exact: true })).not.toHaveClass(primary);
  await expect(team.getByRole("button", { name: "Save", exact: true })).not.toHaveClass(primary);
  // The main action on the right: [Save] [Publish] [Draft with AI].
  const left = async (name: string) => (await team.getByRole("button", { name, exact: true }).boundingBox())!.x;
  expect(await left("Save")).toBeLessThan(await left("Publish"));
  expect(await left("Publish")).toBeLessThan(await left("Draft with AI"));
  await team.getByRole("button", { name: "Publish" }).click();
  const titles = team.getByRole("alertdialog", { name: "Publish “Dark mode is here”?" });
  await expect(titles).toContainText("Its text is still the pull requests' titles.");
  // Publish is still the dialog's main action; Draft with AI is offered beside what it's about.
  await expect(titles.getByRole("button", { name: "Publish", exact: true })).toHaveClass(primary);
  await checkpoint(team, "team-changelog-publish-titles");
  await titles.getByRole("button", { name: "Draft with AI first" }).click();
  const replace = team.getByRole("alertdialog", { name: "Replace the text with an AI draft?" });
  await expect(replace).toBeVisible();
  await expect(titles).toBeHidden();
  await replace.getByRole("button", { name: "Cancel" }).click();
  await expect(replace).toBeHidden();
  // Not written yet, there's nothing for Edit with AI to edit: Draft with AI is the one way into AI.
  await expect(team.getByRole("button", { name: "Edit with AI" })).toHaveCount(0);
  // On a phone the three are in reach at the bottom of the screen, not in the menu.
  await team.setViewportSize({ width: 390, height: 844 });
  for (const name of ["Save", "Publish", "Draft with AI"]) {
    await expect(team.getByRole("button", { name, exact: true })).toBeInViewport();
  }
  await checkpoint(team, "team-changelog-unwritten-phone", { fullPage: false });
  await team.getByRole("button", { name: "Publish" }).click();
  await expect(titles).toBeVisible();
  await checkpoint(team, "team-changelog-publish-titles-phone");
  await titles.getByRole("button", { name: "Cancel" }).click();
  await expect(titles).toBeHidden();
  await team.setViewportSize({ width: 1280, height: 720 });

  // Drafted with AI from the keyboard: written now, the top bar's Draft with AI goes, it's in Edit with AI's menu over
  // the text, and the keyboard's focus goes to that menu's button.
  await nextModelReply(JSON.stringify({ title: "Dark mode is here", notes: "Switch to the dark theme from your profile menu." }), "Remember the theme");
  const draftButton = team.getByRole("button", { name: "Draft with AI", exact: true });
  await draftButton.focus();
  await team.keyboard.press("Enter");
  await expect(replace).toBeVisible();
  await replace.getByRole("button", { name: "Replace the text" }).focus();
  await team.keyboard.press("Enter");
  await expect(team.getByText("Drafted with AI")).toBeVisible();
  await expect(replace).toBeHidden();
  await expect(draftButton).toHaveCount(0);
  await expect(team.getByRole("button", { name: "Edit with AI" })).toBeFocused();
  await expect(team.getByRole("button", { name: "Publish", exact: true })).toHaveClass(primary);

  // With no text at all (say, every analysis failed and took its title out), Publish says so.
  await api("/changelog/1", { body: "" }, "PATCH");
  await team.reload();
  await team.getByRole("button", { name: "Publish" }).click();
  const empty = team.getByRole("alertdialog", { name: "Publish “Dark mode is here”?" });
  await expect(empty).toContainText("It has no text yet, only its pull requests.");
  await checkpoint(team, "team-changelog-publish-empty");

  // Published anyway, Ada hears it shipped, and the sidebar says how many people were told.
  await empty.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  await latestEmailTo(ada.email, { subject: /^Done: Dark mode$/ });
  await team.reload();
  await expect(sidebar.getByRole("group", { name: "How it's announced" })).toContainText("Told 1 person who asked.");
  // Published as it was, Edit with AI is its way into AI (Draft with AI is for drafts).
  await expect(team.getByRole("button", { name: "Edit with AI" })).toBeVisible();
  await checkpoint(team, "team-changelog-told");
  await team.emulateMedia({ colorScheme: "dark" });
  await checkpoint(team, "team-changelog-told-dark");
  await team.emulateMedia({ colorScheme: "light" });
  // Published, the draft no longer collects: nothing waits to be written.
  await team.goto(`/app/${slug}/changelog`);
  await expect(team.getByRole("link", { name: "Dark mode is here" })).toBeVisible();
  await expect(ready).toHaveCount(0);

  // On the portal: the cover, named for the entry, on the list and on the entry's page.
  await ada.goto("/changelog");
  const cover = ada.getByRole("article", { name: "Dark mode is here" }).getByRole("img", { name: "Dark mode is here" });
  await expect(cover).toBeVisible();
  await expect.poll(() => cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  // The list's first cover, likely in view, loads at once.
  await expect(cover).toHaveAttribute("loading", "eager");
  await checkpoint(ada, "portal-changelog-cover");
  await ada.goto("/changelog/1");
  await expect(cover).toBeVisible();
  await ada.setViewportSize({ width: 390, height: 844 });
  await ada.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  await checkpoint(ada, "portal-changelog-entry-cover-phone-dark");
  // In the widget too: What's new, opened from Home's card, shows the entry with its cover, loaded.
  await ada.goto("/widget");
  await ada.getByRole("link", { name: /^What's new/ }).click();
  const widgetCover = ada.getByRole("article", { name: "Dark mode is here" }).getByRole("img", { name: "Dark mode is here" });
  await expect(widgetCover).toBeVisible();
  await expect.poll(() => widgetCover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  // Once a newer entry is out (without a cover: its title and text alone), the list still shows this one's cover,
  // under its title and over the idea it shipped, loading once scrolled near.
  const { number: newer } = (await api("/changelog", { title: "Faster exports", body: "Exports finish sooner." })) as unknown as { number: number };
  await api(`/changelog/${newer}/publish`, {});
  await ada.goto("/changelog");
  await expect(ada.getByRole("heading", { name: "Faster exports" })).toBeVisible();
  await expect(ada.getByRole("article", { name: "Faster exports" }).getByRole("img")).toHaveCount(0);
  await expect(cover).toHaveAttribute("loading", "lazy");
  await cover.scrollIntoViewIfNeeded();
  await expect.poll(() => cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  const older = ada.getByRole("article", { name: "Dark mode is here" });
  const listCover = (await cover.boundingBox())!;
  expect(listCover.y).toBeGreaterThan((await older.getByRole("heading").boundingBox())!.y);
  expect(listCover.y + listCover.height).toBeLessThanOrEqual((await older.getByRole("link", { name: /Built from an idea/ }).boundingBox())!.y);
  // The team's list shows each entry's featured image small, beside its title (decorative: the title names it), loaded;
  // an entry without one gets a placeholder tile the same size, so titles line up.
  await team.goto(`/app/${slug}/changelog?tab=published`);
  const thumbnail = team.getByRole("listitem").filter({ hasText: "Dark mode is here" }).locator("img");
  await expect(thumbnail).toHaveAttribute("alt", "");
  await expect(thumbnail).toHaveAttribute("src", /\/480\.webp/);
  await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  const noCover = team.getByRole("listitem").filter({ hasText: "Faster exports" });
  await expect(noCover.locator("img")).toHaveCount(0);
  const placeholder = noCover.locator("[aria-hidden]").filter({ has: team.locator("svg.lucide-image") });
  expect((await placeholder.boundingBox())!.width).toBe((await thumbnail.boundingBox())!.width);
  await checkpoint(team, "team-changelog-thumbnails");
  await team.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await thumbnail.boundingBox())!.width).toBeLessThan(70);
  await checkpoint(team, "team-changelog-thumbnails-phone");
  await team.setViewportSize({ width: 1280, height: 720 });

  // A featured image changed elsewhere (another tab, a teammate) shows here once the page refreshes, not the one it had.
  await team.goto(`/app/${slug}/changelog/1`);
  await expect(preview).toBeVisible();
  const elsewhere = await team.context().newPage();
  await elsewhere.goto(`/app/${slug}/changelog/1`);
  await elsewhere.getByRole("group", { name: "Featured image" }).getByRole("button", { name: "Remove featured image" }).click();
  await elsewhere.getByRole("button", { name: "Save", exact: true }).click();
  await expect(elsewhere.getByText("Saved", { exact: true })).toBeVisible();
  await elsewhere.close();
  await team.getByRole("button", { name: "Unpublish" }).click();
  await expect(team.getByText("Unpublished", { exact: true })).toBeVisible();
  await expect(addButton).toBeVisible();
  await expect(preview).toHaveCount(0);
});

test("a draft with a line left to fill in isn't published: Publish names the lines and waits for them", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // As an AI draft leaves it: a fact it didn't have, and where a screenshot belongs.
  await api("/changelog", { title: "Dark mode is here", markdown: "Dark mode is here.\n\n[Check: is it out on iOS yet?]\n\n## Themes\n\n[Screenshot: the theme menu, open]\n\nPick one in your profile." });
  // And one whose line is one long word (a link): on a phone the dialog wraps it rather than run off the screen.
  await api("/changelog", { title: "Docs", markdown: "[Check: is https://docs.example.com/integrations/github/self-hosted-runners/configuration/advanced-settings still the right link?]" });
  await team.setViewportSize({ width: 390, height: 844 });
  await team.goto(`/app/${slug}/changelog/2`);
  await team.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByRole("alertdialog").getByRole("heading")).toHaveText("Replace a line before publishing");
  expect(await team.getByRole("alertdialog").evaluate((dialog) => dialog.scrollWidth - dialog.clientWidth)).toBeLessThanOrEqual(0);
  expect(await team.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await checkpoint(team, "team-changelog-publish-markers-phone", { fullPage: false });
  await team.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await team.setViewportSize({ width: 1280, height: 720 });
  await team.goto(`/app/${slug}/changelog/1`);
  await team.getByRole("button", { name: "Publish", exact: true }).click();
  const dialog = team.getByRole("alertdialog");
  // Its heading and its description (read out as it opens) say what's in the way, each line named; nothing about what publishing does.
  await expect(dialog.getByRole("heading")).toHaveText("Replace 2 lines before publishing");
  await expect(dialog).toHaveAccessibleDescription("“Dark mode is here” still has lines left to fill in: [Check: is it out on iOS yet?] [Screenshot: the theme menu, open] Replace or remove them, save, then publish.");
  // Publish is off, and still in the keyboard's reach.
  const publish = dialog.getByRole("button", { name: "Publish", exact: true });
  await expect(publish).toBeDisabled();
  await publish.focus();
  await expect(publish).toBeFocused();
  await checkpoint(team, "team-changelog-publish-markers");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // One answered and saved: the other is still named.
  await api("/changelog/1", { markdown: "Dark mode is here, on iOS too.\n\n## Themes\n\n[Screenshot: the theme menu, open]\n\nPick one in your profile." }, "PATCH");
  await team.reload();
  await team.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Replace a line before publishing");
  await expect(dialog).toHaveAccessibleDescription("“Dark mode is here” still has a line left to fill in: [Screenshot: the theme menu, open] Replace or remove it, save, then publish.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // Both gone: it's published.
  await api("/changelog/1", { markdown: "Dark mode is here, on iOS too.\n\n## Themes\n\nPick one in your profile." }, "PATCH");
  await team.reload();
  await team.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Publish “Dark mode is here”?");
  // With the lines gone, its cover's designs are offered (another journey makes one): published as it is.
  await dialog.getByRole("group", { name: "Cover" }).getByText("No cover", { exact: true }).click();
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
});

test("an entry with no cover gets one composed: picked from its designs as it's published, or made in the editor with a headline, unsaved text kept", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  const heading = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
  const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  await api("/changelog", { title: "Dark mode is here", tags: ["new"], content: { type: "doc", content: [heading("Themes"), paragraph("Pick one in your profile."), heading("Search"), paragraph("It's faster.")] } });
  await api("/changelog", { title: "Small fixes", body: "A few of them." });
  const saved = async (number: number) => (await api(`/changelog/${number}`, undefined, "GET")) as unknown as { status: string; cover: { id: string; width: number; height: number } | null };
  // Every design's picture is the entry's own cover in it, drawn and loaded.
  const loaded = async (group: Locator) => {
    for (const picture of await group.locator("img").all()) {
      await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(800);
    }
  };

  // In the editor: "Make a cover" beside Add featured image. No image in the text, so no Screenshot; two headings, so Sections.
  await team.goto(`/app/${slug}/changelog/1`);
  const featured = team.getByRole("group", { name: "Featured image" });
  await team.getByLabel("Title").fill("Dark mode is here, at last");
  await featured.getByRole("button", { name: "Make a cover" }).click();
  const making = team.getByRole("dialog", { name: "Make a cover" });
  // It doesn't wait for Save, and says so.
  await expect(making).toHaveAccessibleDescription("Drawn from this entry as it's saved and your portal's branding. It becomes the featured image as soon as you use it, without Save.");
  const designs = making.getByRole("group", { name: "Cover" });
  await expect(designs.getByRole("radio")).toHaveCount(3);
  for (const name of ["Title", "Sections", "Pattern"]) {
    await expect(designs.getByRole("radio", { name, exact: true })).toBeVisible();
  }
  // The entry's own design is picked: its title's, without an image.
  await expect(designs.getByRole("radio", { name: "Title", exact: true })).toBeChecked();
  await loaded(designs);
  // A headline in the title's place: the pictures are drawn again with it, once typing pauses.
  await making.getByLabel("Headline").fill("Now in the dark");
  await expect(designs.locator("img").first()).toHaveAttribute("src", /headline=Now\+in\+the\+dark/);
  await loaded(designs);
  await designs.getByText("Sections", { exact: true }).click();
  await expect(designs.getByRole("radio", { name: "Sections", exact: true })).toBeChecked();
  await checkpoint(team, "team-changelog-make-cover");
  await making.getByRole("button", { name: "Use this cover" }).click();
  await expect(team.getByText("Cover added")).toBeVisible();
  await expect(making).toBeHidden();
  // Its button in the empty band went with the band: the keyboard's focus is on Replace, as after an upload.
  await expect(featured.getByRole("button", { name: "Replace featured image" })).toBeFocused();
  // It's the entry's featured image now, and what was typed and not saved is still there.
  const cover = featured.getByRole("img");
  await expect.poll(() => cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  await expect(team.getByLabel("Title")).toHaveValue("Dark mode is here, at last");
  expect((await saved(1)).cover).toMatchObject({ width: 1600, height: 840 });
  const made = (await saved(1)).cover!.id;
  // Saving the text keeps it: the form's cover is the composed one.
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved")).toBeVisible();
  expect((await saved(1)).cover!.id).toBe(made);
  // With a cover, Publish offers none.
  await team.getByRole("button", { name: "Publish", exact: true }).click();
  const publishing = team.getByRole("alertdialog");
  await expect(publishing.getByRole("heading")).toHaveText("Publish “Dark mode is here, at last”?");
  await expect(publishing.getByRole("group", { name: "Cover" })).toHaveCount(0);
  await publishing.getByRole("button", { name: "Cancel" }).click();

  // Publishing one without a cover: its designs, the entry's own picked, and "No cover".
  await team.goto(`/app/${slug}/changelog/2`);
  await team.getByRole("button", { name: "Publish", exact: true }).click();
  const offered = publishing.getByRole("group", { name: "Cover" });
  await expect(offered.getByRole("radio")).toHaveCount(3);
  await expect(offered.getByRole("radio", { name: "Title", exact: true })).toBeChecked();
  await expect(offered.getByRole("radio", { name: "No cover" })).not.toBeChecked();
  await loaded(offered);
  await offered.getByText("Pattern", { exact: true }).click();
  await expect(offered.getByRole("radio", { name: "Pattern", exact: true })).toBeChecked();
  await checkpoint(team, "team-changelog-publish-cover");
  // On a phone the dialog is no taller than the screen: it scrolls, and Publish is in reach.
  await team.setViewportSize({ width: 375, height: 520 });
  await publishing.getByRole("button", { name: "Publish", exact: true }).scrollIntoViewIfNeeded();
  await expect(publishing.getByRole("button", { name: "Publish", exact: true })).toBeInViewport({ ratio: 1 });
  expect((await publishing.boundingBox())!.height).toBeLessThanOrEqual(520);
  await team.setViewportSize({ width: 1280, height: 720 });
  // A featured image of their own, not saved yet: Publish offers no cover over it; taken off again, it does.
  await publishing.getByRole("button", { name: "Cancel" }).click();
  await featured.getByLabel("Featured image", { exact: true }).setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: await team.screenshot() });
  await expect(featured.getByRole("button", { name: "Replace featured image" })).toBeVisible();
  await team.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(publishing.getByRole("heading")).toHaveText("Publish “Small fixes”?");
  await expect(publishing.getByRole("group", { name: "Cover" })).toHaveCount(0);
  await publishing.getByRole("button", { name: "Cancel" }).click();
  await featured.getByRole("button", { name: "Remove featured image" }).click();
  await team.getByRole("button", { name: "Publish", exact: true }).click();
  await offered.getByText("Pattern", { exact: true }).click();
  await expect(offered.getByRole("radio", { name: "Pattern", exact: true })).toBeChecked();
  await publishing.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  // Published with it: the editor shows it, and readers see it on the entry's page.
  await expect.poll(() => featured.getByRole("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  expect(await saved(2)).toMatchObject({ status: "published", cover: { width: 1600, height: 840 } });
  const reader = await (await browser.newContext()).newPage();
  await reader.goto(`${portalUrl(slug)}/changelog/2`);
  const shown = reader.getByRole("img", { name: "Small fixes" });
  await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  await checkpoint(reader, "portal-changelog-composed-cover");

  // "No cover" publishes it as it is.
  await api("/changelog/1", { cover: null }, "PATCH");
  await team.goto(`/app/${slug}/changelog/1`);
  await team.getByRole("button", { name: "Publish", exact: true }).click();
  await publishing.getByRole("group", { name: "Cover" }).getByText("No cover", { exact: true }).click();
  await expect(publishing.getByRole("group", { name: "Cover" }).getByRole("radio", { name: "No cover" })).toBeChecked();
  await publishing.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  expect(await saved(1)).toMatchObject({ status: "published", cover: null });

  // An image uploaded and not saved, then "Use this cover": the composed one is the form's, and Save keeps it.
  await api("/changelog", { title: "Faster search", body: "It's quicker." });
  // On a published entry with a cover, it says what readers see.
  await team.goto(`/app/${slug}/changelog/2`);
  await featured.getByRole("button", { name: "Make a cover" }).click();
  await expect(making).toHaveAccessibleDescription("Drawn from this entry as it's saved and your portal's branding. It replaces the featured image as soon as you use it, without Save. Readers see it right away.");
  await making.getByRole("button", { name: "Cancel" }).click();
  await team.goto(`/app/${slug}/changelog/3`);
  await featured.getByLabel("Featured image", { exact: true }).setInputFiles({ name: "mine.png", mimeType: "image/png", buffer: await team.screenshot() });
  await expect(featured.getByRole("button", { name: "Replace featured image" })).toBeVisible();
  const mine = await featured.getByRole("img").getAttribute("src");
  // Tuti not reached: it says so, the dialog stays to try again, and the form keeps its own image.
  await team.route("**/*", (route) => (route.request().headers()["next-action"] ? route.abort() : route.fallback()));
  await featured.getByRole("button", { name: "Make a cover" }).click();
  await making.getByRole("button", { name: "Use this cover" }).click();
  await expect(team.getByText("Couldn't reach Tuti. Try again.")).toBeVisible();
  await expect(making).toBeVisible();
  await team.unroute("**/*");
  await making.getByRole("button", { name: "Cancel" }).click();
  await expect(making).toBeHidden();
  await expect(featured.getByRole("img")).toHaveAttribute("src", mine!);
  expect((await saved(3)).cover).toBeNull();
  await featured.getByRole("button", { name: "Make a cover" }).click();
  await making.getByRole("button", { name: "Use this cover" }).click();
  await expect(team.getByText("Cover added")).toBeVisible();
  const composed = (await saved(3)).cover!.id;
  await expect(featured.getByRole("img")).toHaveAttribute("src", new RegExp(composed));
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved")).toBeVisible();
  expect((await saved(3)).cover!.id).toBe(composed);
});

test("readers get the changelog by email: confirmed first, each entry published with Email subscribers, unsubscribed in one click", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // Signed out, on the portal's changelog: "Get updates by email".
  const reader = await newPerson(browser, portalUrl(slug));
  // A long address with nowhere to break (no hyphens past "e2e-"), to check it wraps on a phone.
  const address = `e2e-${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}@example.com`;
  await reader.goto("/changelog");
  // In a popover from the header's Subscribe.
  await reader.getByRole("main").getByRole("button", { name: "Subscribe" }).click();
  const subscribe = reader.getByRole("region", { name: "Get updates by email" });
  // Refused (no top-level domain: the browser lets it through, the server doesn't), the address stays to fix.
  await subscribe.getByRole("textbox", { name: "Email" }).fill("e2e-ada@example");
  await subscribe.getByRole("button", { name: "Subscribe" }).click();
  await expect(subscribe.getByText("Enter a valid email address")).toBeVisible();
  await expect(subscribe.getByRole("textbox", { name: "Email" })).toHaveValue("e2e-ada@example");
  await subscribe.getByRole("textbox", { name: "Email" }).fill(address);
  await checkpoint(reader, "portal-changelog-subscribe");
  await subscribe.getByRole("button", { name: "Subscribe" }).click();
  await expect(subscribe.getByRole("status")).toHaveText(`Check your inbox: we sent a link to ${address} to confirm.`);
  // Answered beside the form, which keeps their place.
  await expect(subscribe.getByRole("button", { name: "Subscribe" })).toBeFocused();
  await checkpoint(reader, "portal-changelog-subscribe-sent");
  // On a phone, the address wraps rather than running out of its paragraph (and off the screen).
  const fitsPhone = async () => {
    await reader.setViewportSize({ width: 390, height: 844 });
    const showing = reader.locator("p:visible", { hasText: address });
    await expect(showing.first()).toBeVisible();
    for (const [scroll, width] of await showing.evaluateAll((ps) => ps.map((p) => [p.scrollWidth, p.clientWidth]))) {
      expect(scroll).toBeLessThanOrEqual(width!);
    }
    await reader.setViewportSize({ width: 1280, height: 720 });
  };
  // On a phone the same popover from Subscribe: sent from there, its answer wraps too.
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.reload();
  await reader.getByRole("main").getByRole("button", { name: "Subscribe" }).click();
  await subscribe.getByRole("textbox", { name: "Email" }).fill(address);
  await subscribe.getByRole("button", { name: "Subscribe" }).click();
  await expect(subscribe.getByRole("status")).toHaveText(`Check your inbox: we sent a link to ${address} to confirm.`);
  await fitsPhone();

  // Nothing until they confirm, from the email.
  const confirmation = await latestEmailTo(address, { subject: /^Confirm Acme's updates by email$/ });
  await reader.goto(linkIn(confirmation, portalUrl(slug)));
  await expect(reader.getByRole("heading", { name: "Get Acme's updates by email?" })).toBeVisible();
  // Not confirmed yet: it says what happens once they are.
  await expect(reader.getByText(`Once you confirm, the changelog entries Acme emails to subscribers will go to ${address}.`)).toBeVisible();
  await checkpoint(reader, "portal-changelog-subscribe-confirm");
  await reader.getByRole("button", { name: "Confirm subscription" }).click();
  await expect(reader.getByRole("heading", { name: "You get Acme's updates by email" })).toBeVisible();
  await checkpoint(reader, "portal-changelog-subscribed");
  await fitsPhone();

  // The team's entry: the sidebar says how it's announced, with the one subscriber.
  await team.goto(`/app/${slug}/changelog/new`);
  await team.getByLabel("Title").fill("Dark mode is here");
  await team.getByRole("textbox", { name: "What changed" }).click();
  await team.keyboard.type("Switch themes from your profile menu.");
  await team.getByRole("button", { name: "Save draft" }).first().click();
  await expect(team).toHaveURL(new RegExp(`/app/${slug}/changelog/1$`));
  const announced = team.getByRole("group", { name: "How it's announced" });
  await expect(announced.getByRole("checkbox", { name: "Email subscribers" })).toBeChecked();
  await expect(announced.getByRole("checkbox", { name: "Email subscribers" })).toHaveAccessibleDescription("1 person subscribed on your portal's changelog.");
  await expect(announced.getByRole("checkbox", { name: "Mark it new" })).toBeChecked();
  // The sidebar scrolls on its own: to its end, where this is.
  await team.getByRole("complementary", { name: "Entry settings" }).evaluate((sidebar) => sidebar.scrollTo(0, sidebar.scrollHeight));
  await checkpoint(team, "team-changelog-how-announced");
  await team.getByRole("button", { name: "Publish" }).click();
  const dialog = team.getByRole("alertdialog");
  await expect(dialog).toContainText("It goes on your portal and in your widget, and emails 1 person.");
  // Who that is, behind the count.
  await dialog.getByRole("button", { name: "1 person" }).click();
  await expect(team.getByText("Your subscriber.", { exact: true })).toBeVisible();
  await team.keyboard.press("Escape");
  await expect(team.getByText("Your subscriber.", { exact: true })).toBeHidden();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();

  // The entry arrives: its title, text and link, and a way out.
  const entry = await latestEmailTo(address, { subject: /^Acme: Dark mode is here$/ });
  expect(entry.text).toContain("Switch themes from your profile menu.");
  expect(entry.text).toContain(`${portalUrl(slug)}/changelog/1`);
  await team.reload();
  await expect(announced).toContainText("Emailed to 1 subscriber.");
  await expect(announced).toContainText("Told 1 subscriber.");
  await checkpoint(team, "team-changelog-announced");

  // Unsubscribe: the email's link, signed out, one button.
  await reader.goto(entry.text.split(/\s+/).find((word) => word.includes("/changelog/subscription?"))!);
  await reader.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(reader.getByRole("heading", { name: "You're unsubscribed" })).toBeVisible();
  await expect(reader.getByText(`Acme's changelog won't be emailed to ${address} anymore.`)).toBeVisible();
  await checkpoint(reader, "portal-changelog-unsubscribed");
  await fitsPhone();

  // The next entry isn't emailed to them (nobody's left to email).
  const before = countEmailsTo(address);
  await team.goto(`/app/${slug}/changelog/new`);
  await team.getByLabel("Title").fill("Exports");
  await team.getByRole("button", { name: "Save draft" }).first().click();
  await expect(team).toHaveURL(new RegExp(`/app/${slug}/changelog/2$`));
  await expect(announced.getByRole("checkbox", { name: "Email subscribers" })).toBeDisabled();
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  await expect(announced).toContainText("Not emailed to subscribers.");
  expect(countEmailsTo(address)).toBe(before);
});

test("readers comment on an entry's page: they edit and delete their own, the team deletes any in the app, and signed out are asked to sign in", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/changelog", { title: "Dark mode is here", body: "Switch themes from your profile menu.", tags: ["new"], posts: [] });
  await api("/changelog/1/publish", {});

  // Signed out: no box, a way to sign in.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/changelog/1");
  const visitorComments = visitor.getByRole("region", { name: "Comments" });
  await expect(visitorComments.getByRole("heading", { name: "0 comments" })).toBeVisible();
  await expect(visitorComments.getByText("Sign in to comment.")).toBeVisible();
  await expect(visitorComments.getByRole("textbox", { name: "Comment" })).toHaveCount(0);
  await expect(visitorComments.getByRole("link", { name: "Sign in" })).toBeVisible();
  await checkpoint(visitor, "portal-entry-comments-signed-out");
  // In the app, a published entry without any says where they'll come from.
  await team.goto(`/app/${slug}/changelog/1`);
  await expect(team.getByRole("region", { name: "Comments" }).getByRole("heading", { name: "No comments yet. Users comment on it on your portal." })).toBeVisible();

  // Signed in: they comment, under the reactions.
  const ada = await signUp(browser, portalUrl(slug), "Ada Reader");
  await ada.goto("/changelog/1");
  const comments = ada.getByRole("region", { name: "Comments" });
  await comments.getByRole("textbox", { name: "Comment" }).fill("Finally! My eyes thank you.");
  await comments.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(ada.getByText("Comment posted")).toBeVisible();
  await expect(comments.getByRole("heading", { name: "1 comment" })).toBeVisible();
  await expect(comments.getByRole("listitem").filter({ hasText: "Ada Reader" })).toContainText("Finally! My eyes thank you.");
  await checkpoint(ada, "portal-entry-commented");
  // The team's answer (by the key's creator) is marked as the team's; Ada's isn't.
  await api("/changelog/1/comments", { body: "Glad it helps!" });
  await ada.reload();
  // The badge itself: "Tess Team"'s name has the word too.
  await expect(comments.getByRole("listitem").filter({ hasText: "Glad it helps!" }).getByText("Team", { exact: true })).toHaveCount(1);
  await expect(comments.getByRole("listitem").filter({ hasText: "Ada Reader" }).getByText("Team", { exact: true })).toHaveCount(0);
  // Others read them.
  await visitor.reload();
  await expect(visitorComments.getByRole("listitem").first()).toContainText("Finally! My eyes thank you.");
  // Nobody else's to edit or delete.
  await expect(visitorComments.getByRole("button", { name: /Edit|Delete/ })).toHaveCount(0);

  // They edit it: the text becomes its editor.
  await comments.getByRole("button", { name: "Edit your comment" }).click();
  const edit = comments.getByRole("textbox", { name: "Edit your comment" });
  await expect(edit).toContainText("Finally! My eyes thank you.");
  // Emptied, it's refused; Cancel drops that, and Edit opens on the saved text afresh. From the keyboard: fill("") selects
  // the text behind the editor's back, and its Delete can come before the editor has seen that (a Delete at the text's
  // end, which deletes nothing).
  await edit.press("ControlOrMeta+a");
  await edit.press("Delete");
  // (What Save sends, once the editor's caught up.)
  await expect(comments.locator("form").filter({ has: ada.getByRole("textbox", { name: "Edit your comment" }) }).locator('input[name="content"]')).toHaveValue("");
  await comments.getByRole("button", { name: "Save" }).click();
  await expect(comments.getByText("Write something first")).toBeVisible();
  await comments.getByRole("button", { name: "Cancel" }).click();
  await comments.getByRole("button", { name: "Edit your comment" }).click();
  await expect(edit).toContainText("Finally! My eyes thank you.");
  await expect(comments.getByText("Write something first")).toHaveCount(0);
  await edit.fill("Finally! Works on my phone too.");
  await comments.getByRole("button", { name: "Save" }).click();
  await expect(ada.getByText("Comment saved")).toBeVisible();
  await expect(comments.getByRole("textbox", { name: "Edit your comment" })).toHaveCount(0);
  // The keyboard's back on Edit.
  await expect(comments.getByRole("button", { name: "Edit your comment" })).toBeFocused();
  await expect(comments.getByRole("listitem").filter({ hasText: "Ada Reader" })).toContainText("Finally! Works on my phone too.");
  // On a phone.
  await ada.setViewportSize({ width: 390, height: 844 });
  await checkpoint(ada, "portal-entry-commented-phone");
  await ada.setViewportSize({ width: 1280, height: 720 });

  // The team sees them on the entry's page in the app, and deletes one (moderation).
  await comments.getByRole("textbox", { name: "Comment" }).fill("Buy cheap watches here");
  await comments.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(comments.getByRole("heading", { name: "3 comments" })).toBeVisible();
  await team.goto(`/app/${slug}/changelog/1`);
  const teamComments = team.getByRole("region", { name: "Comments" });
  await expect(teamComments.getByRole("heading", { name: "3 comments" })).toBeVisible();
  // The team's own comments carry the Team badge here too; readers' don't (the badge, not "Tess Team"'s name).
  await expect(teamComments.getByRole("listitem").filter({ hasText: "Glad it helps!" }).getByText("Team", { exact: true })).toHaveCount(1);
  await expect(teamComments.getByRole("listitem").filter({ hasText: "Ada Reader" }).getByText("Team", { exact: true })).toHaveCount(0);
  const spam = teamComments.getByRole("listitem").filter({ hasText: "Buy cheap watches here" });
  // A reader's to delete, not to edit (their own they edit too).
  await expect(spam.getByRole("button", { name: /^Edit/ })).toHaveCount(0);
  await checkpoint(team, "team-entry-comments");
  // Its own it edits.
  const teamOwn = teamComments.getByRole("listitem").filter({ hasText: "Tess Team" });
  await teamOwn.getByRole("button", { name: "Edit your comment" }).click();
  await teamComments.getByRole("textbox", { name: "Edit your comment" }).fill("Glad it helps! More soon.");
  await teamComments.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("Comment saved")).toBeVisible();
  await expect(teamOwn).toContainText("Glad it helps! More soon.");
  await spam.getByRole("button", { name: "Delete Ada Reader's comment" }).click();
  await team.getByRole("alertdialog", { name: "Delete this comment?" }).getByRole("button", { name: "Delete comment" }).click();
  await expect(team.getByText("Comment deleted")).toBeVisible();
  await expect(teamComments.getByRole("heading", { name: "2 comments" })).toBeVisible();
  await expect(teamComments.getByText("Buy cheap watches here")).toHaveCount(0);
  await team.setViewportSize({ width: 390, height: 844 });
  await checkpoint(team, "team-entry-comments-phone");
  await ada.reload();
  await expect(comments.getByRole("heading", { name: "2 comments" })).toBeVisible();
  await expect(comments.getByText("Buy cheap watches here")).toHaveCount(0);

  // One deleted meanwhile (elsewhere, here over the API): Delete says so, and it's gone from the list.
  await comments.getByRole("textbox", { name: "Comment" }).fill("One more thing");
  await comments.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(comments.getByRole("heading", { name: "3 comments" })).toBeVisible();
  const confirm = ada.getByRole("alertdialog", { name: "Delete this comment?" });
  await comments.getByRole("listitem").filter({ hasText: "One more thing" }).getByRole("button", { name: "Delete your comment" }).click();
  const listed = (await api("/changelog/1/comments", undefined, "GET")) as unknown as { comments: { id: string; body: string }[] };
  await api(`/changelog/1/comments/${listed.comments.find((c) => c.body === "One more thing")!.id}`, undefined, "DELETE");
  await confirm.getByRole("button", { name: "Delete comment" }).click();
  await expect(ada.getByText("There's no such comment on this entry")).toBeVisible();
  // The list drops it, its dialog with it, and the keyboard goes to the heading.
  await expect(confirm).toBeHidden();
  // (Role queries, once the dialog's closed: the page behind it is hidden from them while it's open.)
  await expect(comments.getByRole("listitem")).toHaveCount(2);
  await expect(comments.getByRole("heading", { name: "2 comments" })).toBeVisible();
  await expect(comments.getByRole("heading", { name: "2 comments" })).toBeFocused();

  // They delete theirs, once sure; the team's stays.
  await comments.getByRole("listitem").filter({ hasText: "Ada Reader" }).getByRole("button", { name: "Delete your comment" }).click();
  await checkpoint(ada, "portal-entry-comment-delete", { fullPage: false });
  await confirm.getByRole("button", { name: "Delete comment" }).click();
  await expect(ada.getByText("Comment deleted")).toBeVisible();
  await expect(comments.getByRole("heading", { name: "1 comment" })).toBeVisible();
  // The keyboard's on the comments' heading, its Delete gone with the comment.
  await expect(comments.getByRole("heading", { name: "1 comment" })).toBeFocused();
  await expect(comments.getByText("Finally! Works on my phone too.")).toHaveCount(0);

  // Unpublished, the team still sees its comments: to delete, no longer to edit.
  await team.setViewportSize({ width: 1280, height: 720 });
  await team.goto(`/app/${slug}/changelog/1`);
  await team.getByRole("button", { name: "Unpublish" }).click();
  await expect(team.getByText("Unpublished", { exact: true })).toBeVisible();
  await expect(teamComments.getByRole("heading", { name: "1 comment" })).toBeVisible();
  await expect(teamOwn.getByRole("button", { name: "Edit your comment" })).toHaveCount(0);
  await teamOwn.getByRole("button", { name: "Delete your comment" }).click();
  await team.getByRole("alertdialog", { name: "Delete this comment?" }).getByRole("button", { name: "Delete comment" }).click();
  await expect(team.getByText("Comment deleted")).toBeVisible();
  const none = teamComments.getByRole("heading", { name: "No comments. Users comment on it on your portal once it's published." });
  await expect(none).toBeVisible();
  await expect(none).toBeFocused();
});

test("pull requests by hand: ones merged before GitHub was connected are added from the draft's sidebar, and one taken out is missing again", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  // A repository of this journey's own: GitHub (the fake) is shared by every journey.
  const id = randomInt(1_000_000, 2_000_000_000);
  const repo = `acme/${slug}`;
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  // Merged before GitHub was connected: Tuti never heard of them.
  await mergedOnGithub(repo, { number: 11, title: "Add a dark theme", author: "ada", mergedAt: daysAgo(3) });
  await mergedOnGithub(repo, { number: 12, title: "Export to CSV", author: "ada", mergedAt: daysAgo(2) });
  await mergedOnGithub(repo, { number: 13, title: "Bump dependencies", author: "bot", mergedAt: daysAgo(1) });
  await connectGithub(team, slug, { id, repositories: [{ id, fullName: repo }] });
  // Autopilot off (nothing to analyse here); it had found nothing for users in #13, as its gate saves that.
  await setAnalysis(slug, false);
  await query(
    `INSERT INTO code_change (id, "projectId", "repoId", repo, number, url, title, author, "mergedAt", state, "forUsers", "updatedAt")
     SELECT $2, p.id, $3, $4, 13, $5, 'Bump dependencies', 'bot', now(), 'NOTHING_TO_DO', false, now() FROM project p WHERE p.slug = $1`,
    [slug, randomUUID(), id, repo, `https://github.com/${repo}/pull/13`],
  );
  // One merged since starts the running draft.
  await mergePullRequest(id, { repo, number: 14, title: "Remember the theme" });

  await team.goto(`/app/${slug}/changelog/1`);
  const sidebar = team.getByRole("complementary", { name: "Entry settings" });
  const section = sidebar.getByRole("region", { name: "Pull requests" });
  const text = team.getByRole("textbox", { name: "What changed" });
  await expect(section.getByRole("link", { name: "Remember the theme" })).toHaveAttribute("href", `https://github.com/${repo}/pull/14`);
  await expect(section).toContainText(`${repo}#14`);

  // Add changes… lists the ones no entry has: those Autopilot found nothing for users in start unticked.
  await section.getByRole("button", { name: "Add changes…" }).click();
  const dialog = team.getByRole("dialog", { name: "Add changes" });
  await expect(dialog).toContainText("They're added to this draft, a line each.");
  const missing = dialog.getByRole("list", { name: "Missing pull requests" });
  await expect(missing.getByRole("listitem")).toHaveCount(3);
  const row = (title: string) => missing.getByRole("checkbox", { name: new RegExp(title) });
  await expect(row("Add a dark theme")).toBeChecked();
  await expect(row("Export to CSV")).toBeChecked();
  await expect(row("Bump dependencies")).not.toBeChecked();
  await expect(missing.getByRole("listitem").filter({ hasText: "Bump dependencies" })).toContainText(`${repo}#13 · bot · `);
  await expect(missing.getByRole("listitem").filter({ hasText: "Bump dependencies" })).toContainText("Nothing for users");
  await expect(missing.getByRole("listitem").filter({ hasText: "Add a dark theme" })).not.toContainText("Nothing for users");
  await expect(dialog).toContainText(/Pull requests merged since \d+ \w+ \d{4} that no entry has\./);
  await checkpoint(team, "team-changelog-add-changes");
  // Nothing ticked, nothing to add.
  await row("Add a dark theme").uncheck();
  await row("Export to CSV").uncheck();
  await expect(dialog.getByRole("button", { name: "Add 0 pull requests" })).toBeDisabled();
  await row("Add a dark theme").check();
  await row("Export to CSV").check();
  // While it adds (its answer held here), the dialog stays: what's typed meanwhile would be lost when the page reloads.
  let releaseAdd!: () => void;
  const addHeld = new Promise<void>((resolve) => (releaseAdd = resolve));
  await team.route("**/*", async (route) => {
    if (!route.request().headers()["next-action"]) {
      return route.fallback();
    }
    const response = await route.fetch();
    await addHeld;
    await route.fulfill({ response });
  });
  await dialog.getByRole("button", { name: "Add 2 pull requests" }).click();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await team.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  releaseAdd();
  await expect(team.getByText("Added 2 pull requests")).toBeVisible();
  await team.unroute("**/*");
  await expect(dialog).toBeHidden();

  // In the sidebar's list and in the text, a line each.
  await expect(section.getByRole("link", { name: "Add a dark theme" })).toHaveAttribute("href", `https://github.com/${repo}/pull/11`);
  await expect(section.getByRole("link", { name: "Export to CSV" })).toBeVisible();
  await expect(text).toContainText("Add a dark theme");
  await expect(text).toContainText("Export to CSV");
  await checkpoint(team, "team-changelog-pull-requests");

  // Taking one out edits the saved text: unsaved changes are saved first.
  await team.getByLabel("Title").fill("Dark theme");
  await section.getByRole("button", { name: `Take out ${repo}#12` }).click();
  await expect(team.getByText("Save your changes first: pull requests change the saved text.")).toBeVisible();
  await team.reload();
  // Asked first: what the team wrote in its line goes with it. Cancel leaves it all as it was.
  const takingOut = team.getByRole("alertdialog", { name: `Take out ${repo}#12?` });
  await section.getByRole("button", { name: `Take out ${repo}#12` }).click();
  await expect(takingOut).toHaveAccessibleDescription("Its line leaves the text, with any changes you made to it. Add changes… puts it back with Autopilot's line or its title.");
  await takingOut.getByRole("button", { name: "Cancel" }).click();
  await expect(takingOut).toBeHidden();
  await expect(section.getByRole("link", { name: "Export to CSV" })).toBeVisible();
  await expect(text).toContainText("Export to CSV");
  // Taken out: it leaves the list and the text, focus on the section's heading.
  await section.getByRole("button", { name: `Take out ${repo}#12` }).click();
  // While it's taking it out (its answer held here), the dialog stays: Cancel would undo nothing.
  let releaseTakeOut!: () => void;
  const takeOutHeld = new Promise<void>((resolve) => (releaseTakeOut = resolve));
  await team.route("**/*", async (route) => {
    if (!route.request().headers()["next-action"]) {
      return route.fallback();
    }
    const response = await route.fetch();
    await takeOutHeld;
    await route.fulfill({ response });
  });
  await takingOut.getByRole("button", { name: "Take out" }).click();
  await expect(takingOut.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await team.keyboard.press("Escape");
  await expect(takingOut).toBeVisible();
  releaseTakeOut();
  await expect(team.getByText("Taken out")).toBeVisible();
  await team.unroute("**/*");
  await expect(section.getByRole("link", { name: "Export to CSV" })).toHaveCount(0);
  await expect(text).not.toContainText("Export to CSV");
  await expect(text).toContainText("Add a dark theme");
  await expect(section.getByRole("heading", { name: "Pull requests" })).toBeFocused();
  // And it's missing again.
  await section.getByRole("button", { name: "Add changes…" }).click();
  await expect(missing.getByRole("listitem")).toHaveCount(2);
  await expect(row("Export to CSV")).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // With unsaved changes in this draft, Add waits for them: adding rewrites its saved text.
  await team.getByLabel("Title").fill("Next release, soon");
  await section.getByRole("button", { name: "Add changes…" }).click();
  await dialog.getByRole("button", { name: /^Add \d+ pull requests?$/ }).click();
  await expect(team.getByText("Save your changes first: pull requests change the saved text.")).toBeVisible();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // On another draft, Add changes… says where they go.
  const api = await apiFor(team, slug);
  await api("/changelog", { title: "Written by hand" });
  await team.goto(`/app/${slug}/changelog/2`);
  await section.getByRole("button", { name: "Add changes…" }).click();
  await expect(dialog).toContainText("They go into “Next release”, which collects merged pull requests, not into this draft.");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // GitHub disconnected: still listed while it has them, and Take out doesn't offer Add changes… as the way back.
  await query(`DELETE FROM github_installation WHERE "projectId" = (SELECT id FROM project WHERE slug = $1)`, [slug]);
  await team.goto(`/app/${slug}/changelog/1`);
  await expect(section.getByRole("button", { name: "Add changes…" })).toHaveCount(0);
  await section.getByRole("button", { name: `Take out ${repo}#11` }).click();
  const takingOutDark = team.getByRole("alertdialog", { name: `Take out ${repo}#11?` });
  await expect(takingOutDark).toHaveAccessibleDescription("Its line leaves the text, with any changes you made to it.");
  // Published meanwhile (elsewhere): the take-out is refused, said, and the dialog stays to cancel or try again.
  await api("/changelog/1/publish", {});
  await takingOutDark.getByRole("button", { name: "Take out" }).click();
  await expect(team.getByText("Unpublish the entry to change its pull requests")).toBeVisible();
  await expect(takingOutDark).toBeVisible();
  await takingOutDark.getByRole("button", { name: "Cancel" }).click();

  // Published, its pull requests are listed as they shipped: none taken out or added.
  await api("/changelog/1/publish", {});
  await team.goto(`/app/${slug}/changelog/1`);
  await expect(section.getByRole("link", { name: "Add a dark theme" })).toBeVisible();
  await expect(section.getByRole("button")).toHaveCount(0);
});
