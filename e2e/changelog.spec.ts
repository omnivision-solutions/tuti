import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, postFeedback, signUp } from "./helpers";
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
  await team.getByRole("link", { name: "New entry" }).click();
  await team.getByLabel("Title").fill("Dark mode is here");
  await team.getByRole("checkbox", { name: "New" }).check();
  const editor = team.getByRole("textbox", { name: "What changed" });
  await editor.click();
  await team.keyboard.type("/");
  await team.getByRole("option", { name: "Heading", exact: true }).click();
  await team.keyboard.type("Easier on the eyes");
  await team.keyboard.press("Enter");
  await team.keyboard.type("Switch themes from your profile menu.");
  await team.getByRole("checkbox", { name: /#1 Dark mode/ }).check();
  // A refused save keeps what was typed and picked.
  await team.getByLabel("Title").fill("Hi");
  await team.getByRole("button", { name: "Save draft" }).click();
  await expect(team.getByText("Title is too short")).toBeVisible();
  await expect(team.getByLabel("Title")).toHaveValue("Hi");
  await expect(team.getByRole("checkbox", { name: "New" })).toBeChecked();
  await expect(team.getByRole("checkbox", { name: /#1 Dark mode/ })).toBeChecked();
  await team.getByLabel("Title").fill("Dark mode is here");
  await checkpoint(team, "team-changelog-draft");

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
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/changelog/1`);
  await expect(team.getByText("Draft", { exact: true })).toBeVisible();

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

  // Publishing keeps an edit that isn't saved yet (and publishes what's saved).
  await team.getByLabel("Title").fill("Dark mode is here, at last");
  await team.getByRole("button", { name: "Publish" }).click();
  const dialog = team.getByRole("alertdialog");
  await expect(dialog).toContainText("The post it completes becomes Completed");
  await expect(dialog).toContainText("Announced, it also shows as new in your widget.");
  await dialog.getByRole("button", { name: "Publish and announce" }).click();
  await expect(team.getByText("Published and announced")).toBeVisible();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();
  await expect(team.getByLabel("Title")).toHaveValue("Dark mode is here, at last");
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

  // The team's writing style: tone notes, and the published entry as an example.
  const tone = `Friendly, short sentences, no jargon (${slug}).`;
  await team.goto(`/app/${slug}/changelog`);
  await team.getByLabel("Tone").fill(tone);
  await team.getByRole("checkbox", { name: "Dark mode is here" }).check();
  await checkpoint(team, "team-changelog-style");
  await team.getByRole("button", { name: "Save style" }).click();
  await expect(team.getByText("Style saved")).toBeVisible();
  await team.reload();
  await expect(team.getByLabel("Tone")).toHaveValue(tone);
  await expect(team.getByRole("checkbox", { name: "Dark mode is here" })).toBeChecked();

  // The team picks a bigger model for changelog drafts (Settings → AI models).
  await team.goto(`/app/${slug}/settings/ai-models`);
  const changelogModel = team.getByLabel("Changelog drafts and edits");
  await expect(changelogModel).toHaveAttribute("placeholder", /^Default: /);
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
  await changelogModel.fill("anthropic/claude-sonnet-5.5");
  await checkpoint(team, "team-settings-ai-models");
  await team.getByRole("button", { name: "Save" }).click();
  await expect(team.getByText("AI models saved")).toBeVisible();
  await other.getByLabel("AI answers").fill("acme/tiny");
  await other.getByRole("button", { name: "Save" }).click();
  await expect(other.getByText("AI models saved")).toBeVisible();
  await other.reload();
  await expect(other.getByLabel("Changelog drafts and edits")).toHaveValue("anthropic/claude-sonnet-5.5");
  await expect(other.getByLabel("AI answers")).toHaveValue("acme/tiny");
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
  await text.getByText("Search looks at post titles and comments.").click();
  await team.keyboard.press("End");
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
