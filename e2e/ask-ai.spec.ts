import { randomUUID } from "node:crypto";

import { linkPullRequest, setEntryContent } from "./changelog-dates";
import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, signUp } from "./helpers";
import { modelRequests, nextModelReply } from "./model";

test("the team asks AI to rewrite part of a changelog entry, sees its version in place, accepts it and saves; undo takes it back", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Asha Ask");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  const marker = randomUUID().slice(0, 8);
  await api("/changelog", { title: "Faster exports", body: `Exports are quick now (${marker}).\n\nThey run in the background and email you when they're done.` });

  await team.goto(`/app/${slug}/changelog/1`);
  // Settled (nothing still loading that could refresh the editor under the selection) before selecting.
  await team.waitForLoadState("networkidle");
  const text = team.getByRole("textbox", { name: "What changed" });
  const askAi = team.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Ask AI" });
  // The second line, selected from the keyboard: again until it holds (the whole line, its toolbar shown), as the editor
  // may still be setting itself up when the first click lands.
  await expect(async () => {
    await text.getByText("They run in the background").click();
    await team.keyboard.press("Home");
    await team.keyboard.press("Shift+End");
    expect(await team.evaluate(() => window.getSelection()?.toString())).toBe("They run in the background and email you when they're done.");
    await expect(askAi).toBeVisible({ timeout: 1000 });
  }).toPass();
  await askAi.click();
  const dialog = team.getByRole("dialog", { name: "Ask AI" });
  await expect(dialog.getByRole("group", { name: "Presets" }).getByRole("button")).toHaveText(["Shorter", "Clearer", "Friendlier", "Fix grammar", "For non-developers", "Make a list"]);
  await checkpoint(team, "ask-ai-dialog", { fullPage: false });

  await nextModelReply(JSON.stringify({ notes: "Exports run quietly and email you when done." }), marker);
  await dialog.getByRole("button", { name: "Shorter" }).click();
  await expect(dialog).toBeHidden();
  // The AI's version under the old text, which is struck through: nothing changed yet.
  const version = team.getByRole("group", { name: "The AI's version" });
  await expect(version).toContainText("Exports run quietly and email you when done.");
  await expect(text.locator('[data-ask-ai="old"]')).toHaveText("They run in the background and email you when they're done.");
  await checkpoint(team, "ask-ai-version-in-place", { fullPage: false });
  // It got the selected line to edit, and the whole entry for context, as the instruction asks.
  const request = (await modelRequests()).findLast((each) => each.user.includes(marker))!;
  expect(request.user).toMatch(/^Edit this text as the team's instruction says/);
  expect(request.user).toContain('"textToEdit": "They run in the background and email you when they\'re done."');
  expect(request.user).toContain('"teamInstruction": "Make it shorter, keeping everything it says."');

  await version.getByRole("button", { name: "Accept" }).click();
  await expect(version).toBeHidden();
  await expect(text).toContainText(`Exports are quick now (${marker}).`);
  await expect(text).toContainText("Exports run quietly and email you when done.");
  await expect(text).not.toContainText("in the background");
  // An edit like any other: undo takes it back, redo puts it in again.
  await team.keyboard.press("ControlOrMeta+z");
  await expect(text).toContainText("They run in the background");
  await team.keyboard.press("ControlOrMeta+Shift+z");
  await expect(text).toContainText("Exports run quietly");

  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved")).toBeVisible();
  await team.reload();
  await expect(text).toContainText("Exports run quietly and email you when done.");
  await expect(text).not.toContainText("in the background");
});

test("a new entry, not saved yet, gets Ask AI too; an entry still only its pull requests' titles doesn't (Draft with AI is its one AI action)", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Noor New");
  await createProject(team, "Acme", slug);
  const marker = randomUUID().slice(0, 8);

  await team.goto(`/app/${slug}/changelog/new`);
  await team.getByLabel("Title").fill("Faster search");
  const text = team.getByRole("textbox", { name: "What changed" });
  await text.click();
  await team.keyboard.type(`Search is a lot faster now (${marker}).`);
  await team.keyboard.press("Shift+Home");
  await nextModelReply(JSON.stringify({ notes: `Search is faster (${marker}).` }), marker);
  await team.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Ask AI" }).click();
  await team.getByRole("dialog", { name: "Ask AI" }).getByRole("button", { name: "Shorter" }).click();
  const version = team.getByRole("group", { name: "The AI's version" });
  await expect(version).toContainText(`Search is faster (${marker}).`);
  await version.getByRole("button", { name: "Accept" }).click();
  await expect(text).toHaveText(`Search is faster (${marker}).`);
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/changelog/1`);

  // Made the pull requests' titles: not written yet.
  await linkPullRequest(slug, 1, { repo: "acme/app", number: 7, title: "Faster search" });
  const bullet = { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Faster search (acme/app#7)" }] }] };
  await setEntryContent(slug, 1, { type: "doc", content: [{ type: "bulletList", content: [bullet] }] });
  await team.reload();
  await expect(team.getByRole("button", { name: "Draft with AI" })).toBeVisible();
  await text.getByText("Faster search (acme/app#7)").selectText();
  const bar = team.getByRole("toolbar", { name: "Formatting" });
  await expect(bar.getByRole("button", { name: "Bold" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Ask AI" })).toHaveCount(0);
});

test("in a help center article too: Ask AI on a selected line, written like the article, accepted and saved", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Ari Article");
  await createProject(team, "Acme", slug);
  const marker = randomUUID().slice(0, 8);

  await team.goto(`/app/${slug}/docs/new`);
  await team.getByLabel("Title").fill("Exporting reports");
  const text = team.getByRole("textbox", { name: "Article" });
  await text.click();
  await team.keyboard.type(`Open Reports (${marker}).`);
  await team.keyboard.press("Enter");
  await team.keyboard.type("Then you must press the Export button which is at the top.");
  // Before its first save too.
  await text.getByText("Then you must press").selectText();
  await expect(team.getByRole("toolbar", { name: "Text selection" }).getByRole("button", { name: "Ask AI" })).toBeVisible();
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/docs/exporting-reports`);

  await text.getByText("Then you must press").selectText();
  await nextModelReply(JSON.stringify({ notes: "Then press **Export** at the top." }), marker);
  await team.getByRole("toolbar", { name: "Text selection" }).getByRole("button", { name: "Ask AI" }).click();
  await team.getByRole("dialog", { name: "Ask AI" }).getByRole("button", { name: "Clearer" }).click();
  const version = team.getByRole("group", { name: "The AI's version" });
  await expect(version).toContainText("Then press Export at the top.");
  await checkpoint(team, "ask-ai-article-version", { fullPage: false });
  const request = (await modelRequests()).findLast((each) => each.user.includes(marker))!;
  expect(request.system).toMatch(/^You edit part of an article in a product's help center/);
  expect(request.user).toContain('"wholeArticle"');

  await version.getByRole("button", { name: "Accept" }).click();
  await expect(text).toContainText("Then press Export at the top.");
  await expect(text.locator("strong")).toHaveText("Export");
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByRole("button", { name: "Saved" })).toBeVisible();
  await team.reload();
  await expect(text).toContainText("Then press Export at the top.");
  await expect(text).not.toContainText("you must press");
});
