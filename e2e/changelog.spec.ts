import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { connectGithub, mergePullRequest, publishRelease } from "./github";
import { apiFor, createProject, newPerson, postFeedback, signUp } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";
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
  await team.getByLabel("Status").click();
  await team.getByRole("option", { name: "Planned" }).click();
  await expect(team.getByText("Status: Planned")).toBeVisible();

  // A draft: title, tag, text with a heading, and the post it completes.
  await team.getByRole("link", { name: "Changelog" }).click();
  // Nothing written yet: both tabs, empty.
  await expect(team.getByRole("navigation", { name: "Entries" })).toContainText("Drafts 0Published 0");
  await expect(team.getByText("No entries yet")).toBeVisible();
  await team.getByRole("link", { name: "New entry" }).click();
  await team.getByLabel("Title").fill("Dark mode is here");
  await team.getByRole("checkbox", { name: "New", exact: true }).check();
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
  // A refused save keeps what was typed and picked. Save draft is in the top bar.
  const saveDraft = team.getByRole("button", { name: "Save draft" });
  expect((await saveDraft.boundingBox())!.y).toBeLessThan(48);
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
  await checkpoint(team, "team-changelog-draft");
  // On a phone the sidebar goes under the text, and Save draft after it.
  await team.setViewportSize({ width: 390, height: 844 });
  expect((await sidebar.boundingBox())!.y).toBeGreaterThan((await editor.boundingBox())!.y + (await editor.boundingBox())!.height);
  await expect(saveDraft).toBeVisible();
  expect((await saveDraft.boundingBox())!.y).toBeGreaterThan((await sidebar.boundingBox())!.y);
  await checkpoint(team, "team-changelog-draft-phone");
  // The top bar's menu has it too (not an empty menu): the form's and the menu's.
  await team.getByRole("button", { name: "More actions" }).click();
  await expect(saveDraft).toHaveCount(2);
  await team.keyboard.press("Escape");
  // The form's own Save draft saves it all: the title typed again above, the tag and the post, there after a reload.
  await saveDraft.click();
  await team.waitForURL(`**/app/${slug}/changelog/1`);
  await team.reload();
  await expect(team.getByLabel("Title")).toHaveValue("Dark mode is here");
  await expect(team.getByRole("checkbox", { name: "New", exact: true })).toBeChecked();
  await expect(completes.getByRole("link", { name: "Dark mode" })).toBeVisible();
  await expect(team.getByText("Draft", { exact: true })).toBeVisible();
  await team.setViewportSize({ width: 1280, height: 720 });

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

  // AI rewrites the text into release notes, after asking; the title the team gave stays.
  await nextModelReply(
    JSON.stringify({
      title: "Dark mode",
      notes: "## A darker look\n\nSwitch to the dark theme from your profile menu.\n\n- Easier on the eyes at night",
    }),
  );
  await team.getByRole("button", { name: "Draft with AI" }).click();
  const confirm = team.getByRole("alertdialog");
  await expect(confirm).toContainText("Replace the text with an AI draft?");
  await checkpoint(team, "team-changelog-ai-draft-confirm", { fullPage: false });
  await confirm.getByRole("button", { name: "Replace the text" }).click();
  await expect(team.getByText("Drafted with AI")).toBeVisible();
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
  await expect(dialog).toContainText("The post it completes becomes Completed");
  // As the sidebar has it: marked new in the widget; nobody has subscribed, so nobody's emailed.
  await expect(dialog).toContainText("It appears on your portal's changelog, marked new in your widget.");
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
  // Save and Unpublish together in the top bar.
  for (const name of ["Save", "Unpublish"]) {
    expect((await team.getByRole("button", { name, exact: true }).boundingBox())!.y).toBeLessThan(48);
  }
  await checkpoint(team, "team-changelog-published");
  await team.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar.getByRole("link", { name: "View as reader" })).toBeVisible();
  await checkpoint(team, "team-changelog-published-phone");
  await team.setViewportSize({ width: 1280, height: 720 });
  // Delete is behind the top bar's "More actions"; Unpublish is in the bar.
  await expect(team.getByRole("button", { name: "Delete" })).toBeHidden();
  await team.getByRole("button", { name: "More actions" }).click();
  await expect(team.getByRole("button", { name: "Delete" })).toBeVisible();
  await team.keyboard.press("Escape");
  // The team's list shows it with its tag.
  await team.getByRole("link", { name: "Changelog" }).click();
  await expect(team.getByRole("listitem").filter({ hasText: "Dark mode is here" }).getByText("New", { exact: true })).toBeVisible();

  // On the portal: the entry, its tag and what it completes; the post says where it shipped.
  await ada.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Changelog" }).click();
  const entry = ada.getByRole("article", { name: "Dark mode is here" });
  await expect(entry.getByRole("heading", { name: "A darker look", level: 2 })).toBeVisible();
  await expect(entry).toContainText("New");
  await expect(entry).toContainText("Switch to the dark theme from your profile menu.");
  await checkpoint(ada, "portal-changelog");
  // Readers react, one of each, on and off; the team's list shows the counts.
  const tada = entry.getByRole("button", { name: /^React with 🎉/ });
  // No count until there is one.
  await expect(tada).toHaveAccessibleName("React with 🎉");
  await expect(tada).toHaveText("🎉");
  await tada.click();
  await expect(tada).toHaveAccessibleName("React with 🎉 (1)");
  await expect(tada).toHaveAttribute("aria-pressed", "true");
  await expect(tada).toBeEnabled();
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
  // Taken back.
  await tada.click();
  await expect(tada).toHaveAccessibleName("React with 🎉");
  await expect(tada).toHaveAttribute("aria-pressed", "false");
  await expect(tada).toBeEnabled();
  await reader.reload();
  await expect(readerTada).toHaveAccessibleName("React with 🎉");
  await reader.context().close();
  // Feed readers find it too.
  await expect(ada.locator('link[rel="alternate"][type="application/rss+xml"]')).toHaveAttribute("href", `${portalUrl(slug)}/changelog/rss.xml`);
  const feed = await (await ada.request.get(`${portalUrl(slug)}/changelog/rss.xml`)).text();
  expect(feed).toContain("<title>Dark mode is here</title>");
  await entry.getByRole("link", { name: "Dark mode", exact: true }).click();
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

  // The team's writing style (Settings → AI → Writing style): tone notes, and the published entry as an example.
  const tone = `Friendly, short sentences, no jargon (${slug}).`;
  await team.goto(`/app/${slug}/settings`);
  await team.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Writing style" }).click();
  await team.waitForURL(`**/app/${slug}/settings/writing-style`);
  await team.getByLabel("Tone").fill(tone);
  await team.getByRole("checkbox", { name: "Dark mode is here" }).check();
  await checkpoint(team, "team-settings-writing-style");
  // While it saves, the fields are locked (an edit then wouldn't be saved).
  let releaseSave!: () => void;
  const saveHeld = new Promise<void>((resolve) => (releaseSave = resolve));
  const saving = `**/app/${slug}/settings/writing-style`;
  await team.route(saving, async (route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }
    const response = await route.fetch();
    await saveHeld;
    await route.fulfill({ response });
  });
  await team.getByRole("button", { name: "Save style" }).click();
  await expect(team.getByLabel("Tone")).toBeDisabled();
  releaseSave();
  await expect(team.getByText("Style saved")).toBeVisible();
  await team.unroute(saving);
  // Saved, not just left in the form: it's there after a reload.
  await team.reload();
  await expect(team.getByLabel("Tone")).toHaveValue(tone);
  await expect(team.getByRole("checkbox", { name: "Dark mode is here" })).toBeChecked();

  // The team picks a bigger model for changelog drafts (Settings → AI models): Fast (the default) or Balanced,
  // each with its model and what a draft costs with it (Best is only offered where the endpoint lists its model),
  // or a custom model id.
  await team.goto(`/app/${slug}/settings/ai-models`);
  const changelogModels = team.getByRole("radiogroup", { name: "Changelog drafts and edits" });
  await expect(changelogModels.getByRole("radio", { name: /^Fast/ })).toBeChecked();
  await expect(changelogModels.getByRole("radio")).toHaveCount(3); // Fast, Balanced, Custom model
  await expect(changelogModels.getByText("Anthropic: Claude Sonnet 5.5")).toBeVisible();
  await expect(changelogModels.getByText(/^About [\d.$]+ (credits? )?per draft$/).first()).toBeVisible();
  await changelogModels.getByRole("radio", { name: /^Custom model/ }).check();
  const changelogModel = team.getByLabel("Changelog drafts and edits: model id");
  // An empty custom id, or one of spaces only, isn't sent (it would save as the default).
  await expect(changelogModel).toHaveAttribute("required", "");
  await changelogModel.fill("   ");
  expect(await changelogModel.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await changelogModel.fill("acme/imaginary");
  await team.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("has no model “acme/imaginary”")).toBeVisible();
  // The server caps what a model may cost, so one without a price can't be picked.
  await expect(team.getByText("This server allows models up to $15 per million output tokens.")).toBeVisible();
  await changelogModel.fill("acme/no-price");
  await team.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("“acme/no-price” has no price; this server allows models up to $15")).toBeVisible();
  // Another tab, open since before the pick: saving its own change leaves the pick alone.
  const other = await team.context().newPage();
  await other.goto(`/app/${slug}/settings/ai-models`);
  await changelogModels.getByRole("radio", { name: /^Balanced/ }).check();
  await checkpoint(team, "team-settings-ai-models");
  await team.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("AI models saved")).toBeVisible();
  await other.getByRole("radiogroup", { name: "AI answers" }).getByRole("radio", { name: /^Custom model/ }).check();
  await other.getByLabel("AI answers: model id").fill("acme/tiny");
  await other.getByRole("button", { name: "Save" }).click();
  await expect(other.getByText("AI models saved")).toBeVisible();
  await other.reload();
  await expect(other.getByRole("radiogroup", { name: "Changelog drafts and edits" }).getByRole("radio", { name: /^Balanced/ })).toBeChecked();
  await expect(other.getByLabel("AI answers: model id")).toHaveValue("acme/tiny");
  await other.close();

  // The next AI draft follows the style, written by that model.
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
  await team.getByRole("button", { name: "Draft with AI" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Replace the text" }).click();
  await expect(team.getByText("Drafted with AI")).toBeVisible();
  const asked = (await modelRequests()).find((request) => request.user.includes(tone));
  expect(asked?.model).toBe("anthropic/claude-sonnet-5.5");
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
  // Into the text at its very end (its last line), without a click: a click's caret can land after End and split a word.
  await text.focus();
  await team.keyboard.press("ControlOrMeta+End");
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
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByRole("button", { name: "Publish" })).toBeDisabled();
  releaseSave();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  await team.unroute("**/*");
  await expect(team.getByRole("button", { name: "Publish" })).toBeEnabled();
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
  await expect(team.getByRole("alertdialog")).toContainText("It appears on your portal's changelog.");
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
  await team.getByRole("button", { name: "Unpublish" }).click();
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

test("older changelog entries are a page further: /changelog/page/2", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // One more than a page holds (20).
  for (let n = 1; n <= 21; n++) {
    await api("/changelog", { title: `Release ${n}` });
    await api(`/changelog/${n}/publish`, {});
  }

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto("/changelog");
  const main = reader.getByRole("main");
  await expect(main.getByRole("heading", { name: "Release 21" })).toBeVisible();
  await expect(main.getByRole("heading", { name: "Release 1", exact: true })).toHaveCount(0);
  await main.getByRole("link", { name: "Older entries" }).click();
  await expect(reader).toHaveURL(/\/changelog\/page\/2$/);
  await expect(main.getByRole("heading", { name: "Release 1", exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: "Older entries" })).toHaveCount(0);
  await checkpoint(reader, "portal-changelog-page-2");
  await main.getByRole("link", { name: "Newer entries" }).click();
  await expect(reader).toHaveURL(/\/changelog$/);

  // On a phone, the header's menu lists the entries by date (with their titles), the one being read marked.
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.goto("/changelog/21");
  await reader.getByRole("banner").getByRole("button", { name: "Menu" }).click();
  const entries = reader.getByRole("dialog", { name: "Menu" }).getByRole("navigation", { name: "Changelog entries" });
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const newest = entries.getByRole("link", { name: new RegExp(`^${today}\\s*Release 21$`) });
  await expect(newest).toHaveAttribute("aria-current", "page");
  await expect(entries.getByRole("link", { name: /Release 20$/ })).not.toHaveAttribute("aria-current");
  await checkpoint(reader, "portal-changelog-phone-menu", { fullPage: false });
  await entries.getByRole("link", { name: /Release 20$/ }).click();
  await expect(reader).toHaveURL(/\/changelog\/20$/);
  await expect(reader.getByRole("dialog", { name: "Menu" })).toBeHidden();
});

test("the next release waits to be written; its entry gets a cover readers see, and says how many people it told", async ({ browser }, testInfo) => {
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
  await expect(team.getByText("Next release is ready to write")).toHaveCount(0);
  await mergePullRequest(installationId, { number: 41, title: "Add a dark theme" });
  await mergePullRequest(installationId, { number: 42, title: "Remember the theme" });

  // The list says the next release is ready to write, and opens it.
  await team.reload();
  const ready = team.getByRole("status").filter({ hasText: "Next release is ready to write" });
  await expect(ready).toContainText("2 merged pull requests are in “Next release”.");
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
  await expect(ready).toContainText("2 merged pull requests are in “v1.4”.");
  await ready.getByRole("link", { name: "Write it" }).click();
  await team.waitForURL(`**/app/${slug}/changelog/1`);

  // A cover, uploaded in the sidebar (two pictures drawn here: one replaces the other), with the post it completes.
  const scratch = await team.context().newPage();
  const picture = async (color: string) => {
    await scratch.setContent(`<div id="cover" style="width:1200px;height:600px;background:${color}"></div>`);
    return scratch.locator("#cover").screenshot();
  };
  const [first, second] = [await picture("#1d4ed8"), await picture("#0f766e")];
  await scratch.close();
  const sidebar = team.getByRole("complementary", { name: "Entry settings" });
  const preview = sidebar.getByRole("img", { name: "Cover image preview" });
  await expect(sidebar.getByText("None", { exact: true })).toBeVisible();
  // An upload whose server calls fail (the network drops) ends with an error, and Save still works.
  await team.route("**/*", (route) => (route.request().headers()["next-action"] ? route.abort() : route.fallback()));
  await sidebar.getByLabel("Cover image", { exact: true }).setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: first });
  await expect(sidebar.getByText("The upload failed. Try again.")).toBeVisible();
  await team.unroute("**/*");
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  // Reloaded, so this save's toast is gone before the next save's is waited for.
  await team.reload();
  await expect(sidebar.getByText("None", { exact: true })).toBeVisible();
  await sidebar.getByLabel("Cover image", { exact: true }).setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: first });
  await expect(preview).toBeVisible();
  const firstSrc = await preview.getAttribute("src");
  // Replaced by another: while it uploads (its server calls held here), Save and Publish wait, the field saying why;
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
  // Picked from Upload with the keyboard: focus stays on it through the upload (it's off, but not taken out of reach).
  const uploadButton = sidebar.getByRole("button", { name: "Upload cover image" });
  const removeButton = sidebar.getByRole("button", { name: "Remove", exact: true });
  await uploadButton.focus();
  await sidebar.getByLabel("Cover image", { exact: true }).setInputFiles({ name: "cover-2.png", mimeType: "image/png", buffer: second });
  await expect(sidebar.getByRole("status").filter({ hasText: "Uploading…" })).toBeVisible();
  await expect(uploadButton).toBeFocused();
  await expect(team.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect(team.getByRole("button", { name: "Publish" })).toBeDisabled();
  await expect(uploadButton).toBeDisabled();
  await expect(removeButton).toBeDisabled();
  await removeButton.focus();
  await team.keyboard.press("Enter");
  await expect(preview).toHaveAttribute("src", firstSrc!);
  const dropped = await team.evaluateHandle((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "cover.png", { type: "image/png" }));
    return transfer;
  }, [...first]);
  await sidebar.getByLabel("Cover image", { exact: true }).locator("..").dispatchEvent("drop", { dataTransfer: dropped });
  await uploadButton.focus();
  releaseUpload();
  await expect(preview).not.toHaveAttribute("src", firstSrc!);
  await expect(team.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await expect(team.getByRole("button", { name: "Publish" })).toBeEnabled();
  await expect(uploadButton).toBeEnabled();
  await expect(uploadButton).toBeFocused();
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
  await expect(preview).toBeVisible();
  // Removed (from the keyboard: focus moves to Upload, as Remove goes), it's gone once saved; uploaded again, it's back.
  await sidebar.getByRole("button", { name: "Remove", exact: true }).focus();
  await team.keyboard.press("Enter");
  await expect(sidebar.getByText("None", { exact: true })).toBeVisible();
  await expect(uploadButton).toBeFocused();
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  await team.reload();
  await expect(sidebar.getByText("None", { exact: true })).toBeVisible();
  await sidebar.getByLabel("Cover image", { exact: true }).setInputFiles({ name: "cover-2.png", mimeType: "image/png", buffer: second });
  await expect(preview).toBeVisible();
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved", { exact: true })).toBeVisible();
  await checkpoint(team, "team-changelog-cover");
  await team.setViewportSize({ width: 390, height: 844 });
  await expect(preview).toBeVisible();
  await checkpoint(team, "team-changelog-cover-phone");
  await team.setViewportSize({ width: 1280, height: 720 });

  // Published, Ada hears it shipped, and the sidebar says how many people were told.
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  await latestEmailTo(ada.email, { subject: /^Done: Dark mode$/ });
  await team.reload();
  await expect(sidebar.getByRole("group", { name: "How it's announced" })).toContainText("Told 1 person who asked.");
  await checkpoint(team, "team-changelog-told");
  await team.emulateMedia({ colorScheme: "dark" });
  await checkpoint(team, "team-changelog-told-dark");
  await team.emulateMedia({ colorScheme: "light" });
  // Published, the draft no longer collects: nothing waits to be written.
  await team.goto(`/app/${slug}/changelog`);
  await expect(team.getByRole("link", { name: "Dark mode is here" })).toBeVisible();
  await expect(team.getByText("Next release is ready to write")).toHaveCount(0);

  // On the portal: the cover, named for the entry, on the list and on the entry's page.
  await ada.goto("/changelog");
  const cover = ada.getByRole("article", { name: "Dark mode is here" }).getByRole("img", { name: "Dark mode is here" });
  await expect(cover).toBeVisible();
  await expect.poll(() => cover.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
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

  // A cover changed elsewhere (another tab, a teammate) shows here once the page refreshes, not the one it had.
  await team.goto(`/app/${slug}/changelog/1`);
  await expect(preview).toBeVisible();
  const elsewhere = await team.context().newPage();
  await elsewhere.goto(`/app/${slug}/changelog/1`);
  await elsewhere.getByRole("complementary", { name: "Entry settings" }).getByRole("button", { name: "Remove", exact: true }).click();
  await elsewhere.getByRole("button", { name: "Save", exact: true }).click();
  await expect(elsewhere.getByText("Saved", { exact: true })).toBeVisible();
  await elsewhere.close();
  await team.getByRole("button", { name: "Unpublish" }).click();
  await expect(team.getByText("Unpublished", { exact: true })).toBeVisible();
  await expect(sidebar.getByText("None", { exact: true })).toBeVisible();
});

test("readers get the changelog by email: confirmed first, each entry published with Email subscribers, unsubscribed in one click", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // Signed out, on the portal's changelog: "Get updates by email".
  const reader = await newPerson(browser, portalUrl(slug));
  const address = `e2e-${randomUUID()}@example.com`;
  await reader.goto("/changelog");
  const subscribe = reader.getByRole("region", { name: "Get updates by email" });
  await subscribe.getByRole("textbox", { name: "Email" }).fill(address);
  await checkpoint(reader, "portal-changelog-subscribe");
  await subscribe.getByRole("button", { name: "Subscribe" }).click();
  await expect(subscribe.getByRole("status")).toHaveText(`Check your inbox: we sent a link to ${address} to confirm.`);
  // Answered beside the form, which keeps their place.
  await expect(subscribe.getByRole("button", { name: "Subscribe" })).toBeFocused();
  await checkpoint(reader, "portal-changelog-subscribe-sent");

  // Nothing until they confirm, from the email.
  const confirmation = await latestEmailTo(address, { subject: /^Confirm Acme's updates by email$/ });
  await reader.goto(linkIn(confirmation, portalUrl(slug)));
  await expect(reader.getByRole("heading", { name: "Get Acme's updates by email?" })).toBeVisible();
  await reader.getByRole("button", { name: "Confirm" }).click();
  await expect(reader.getByRole("heading", { name: "You get Acme's updates by email" })).toBeVisible();
  await checkpoint(reader, "portal-changelog-subscribed");

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
  await expect(dialog).toContainText("It appears on your portal's changelog, marked new in your widget, and it's emailed to your subscriber.");
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();

  // The entry arrives: its title, text and link, and a way out.
  const entry = await latestEmailTo(address, { subject: /^Acme: Dark mode is here$/ });
  expect(entry.text).toContain("Switch themes from your profile menu.");
  expect(entry.text).toContain(`${portalUrl(slug)}/changelog/1`);
  await team.reload();
  await expect(announced).toContainText("Emailed to subscribers.");
  await expect(announced).toContainText("Told 1 person who asked.");
  await checkpoint(team, "team-changelog-announced");

  // Unsubscribe: the email's link, signed out, one button.
  await reader.goto(entry.text.split(/\s+/).find((word) => word.includes("/changelog/subscription?"))!);
  await reader.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(reader.getByRole("heading", { name: "You're unsubscribed" })).toBeVisible();
  await expect(reader.getByText(`Acme's changelog won't be emailed to ${address} anymore.`)).toBeVisible();
  await checkpoint(reader, "portal-changelog-unsubscribed");

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
