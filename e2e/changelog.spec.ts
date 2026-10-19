import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";
import { modelRequests, nextModelReply } from "./model";

test("the team writes what shipped, publishes it, and people see it on the portal", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/b/feature-requests");
  await ada.getByLabel("Title").fill("Dark mode");
  await ada.getByRole("button", { name: "Submit feedback" }).click();
  await expect(ada.getByRole("link", { name: "Dark mode" })).toBeVisible();

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
  await team.getByRole("button", { name: "Heading", exact: true }).click();
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
  await expect(tada).toHaveAccessibleName("React with 🎉 (0)");
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
  await expect(tada).toHaveAccessibleName("React with 🎉 (0)");
  await expect(tada).toHaveAttribute("aria-pressed", "false");
  await expect(tada).toBeEnabled();
  await reader.reload();
  await expect(readerTada).toHaveAccessibleName("React with 🎉 (0)");
  await reader.context().close();
  // Feed readers find it too.
  await expect(ada.locator('link[rel="alternate"][type="application/rss+xml"]')).toHaveAttribute("href", `${portalUrl(slug)}/changelog/rss.xml`);
  const feed = await (await ada.request.get(`${portalUrl(slug)}/changelog/rss.xml`)).text();
  expect(feed).toContain("<title>Dark mode is here</title>");
  await entry.getByRole("link", { name: "Dark mode", exact: true }).click();
  await ada.waitForURL(/\/p\/dark-mode-1$/);
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

  // The next AI draft follows it.
  await team.getByRole("link", { name: "New entry" }).click();
  await team.getByLabel("Title").fill("Faster search");
  await team.getByRole("textbox", { name: "What changed" }).click();
  await team.keyboard.type("Search got quicker.");
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/changelog/2`);
  await nextModelReply(JSON.stringify({ title: "Faster search", notes: "Search is quicker now." }));
  await team.getByRole("button", { name: "Draft with AI" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Replace the text" }).click();
  await expect(team.getByText("Drafted with AI")).toBeVisible();
  const asked = (await modelRequests()).find((request) => request.user.includes(tone));
  expect(asked?.user).toContain('"title": "Dark mode is here"');
  expect(asked?.user).toContain("Switch to the dark theme from your profile menu.");
});
