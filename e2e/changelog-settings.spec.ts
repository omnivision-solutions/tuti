import { randomUUID } from "node:crypto";

import pg from "pg";

import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, cloudPortalUrl } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, signUp } from "./helpers";

/** A query on the journeys' database. */
async function query(sql: string, values: unknown[]) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql, values)).rows;
  } finally {
    await client.end();
  }
}

// On Tuti's cloud, which sells plans: levels are on Pro, Custom on Business.
test("an owner sets the changelog's AI model: on Free, Best opens the upgrade prompt and nothing changes; on Pro it saves; on Business, Custom lists Drafts and a model picked saves", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  const saved = async () => (await query(`SELECT "aiLevels" AS levels, "aiModels" AS models FROM project WHERE slug = $1`, [slug]))[0];

  // Free: every level is there, looking alike; Balanced is the one in use.
  await owner.goto(`/app/${slug}/settings/changelog`);
  const aiModel = owner.getByRole("radiogroup", { name: "AI model" });
  const level = (name: string) => aiModel.getByRole("radio", { name, exact: true });
  await expect(aiModel.getByRole("radio")).toHaveText(["Affordable", "Balanced", "Best", "Custom"]);
  await expect(level("Balanced")).toBeChecked();
  await expect(owner.getByText("Drafts Claude Haiku 5.5", { exact: true })).toBeVisible();
  // On a phone the four levels fit the card, two a row.
  await owner.setViewportSize({ width: 360, height: 740 });
  const [card, last] = await Promise.all([aiModel.boundingBox(), level("Custom").boundingBox()]);
  expect(last!.x + last!.width).toBeLessThanOrEqual(card!.x + card!.width);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await checkpoint(owner, "team-settings-changelog-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  // To a screen reader a level the plan lacks says which plan it needs.
  await expect(level("Best")).toHaveAccessibleDescription("Choosing an AI level needs the Pro plan.");
  await expect(level("Custom")).toHaveAccessibleDescription("Picking your own AI models needs the Business plan.");
  await expect(level("Balanced")).toHaveAccessibleDescription("");
  // Choosing one opens the upgrade prompt, and the level stays as it was.
  await level("Best").click();
  const prompt = owner.getByRole("dialog", { name: "Choosing an AI level needs the Pro plan." });
  await expect(prompt.getByRole("link", { name: "See plans" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await checkpoint(owner, "team-settings-changelog-upgrade", { fullPage: false });
  await prompt.getByRole("button", { name: "Not now" }).click();
  await expect(prompt).toBeHidden();
  await expect(level("Balanced")).toBeChecked();
  await level("Custom").click();
  const customPrompt = owner.getByRole("dialog", { name: "Picking your own AI models needs the Business plan." });
  await customPrompt.getByRole("button", { name: "Not now" }).click();
  await expect(customPrompt).toBeHidden();
  await expect(owner.getByRole("textbox", { name: "Drafts" })).toHaveCount(0);
  expect((await saved()).levels).toEqual({});

  // Pro has levels: Best saves at once, and the line under the label names its model.
  await query(`UPDATE project SET "planKey" = 'pro' WHERE slug = $1`, [slug]);
  await owner.reload();
  await expect(level("Best")).toHaveAccessibleDescription("");
  await level("Best").click();
  await expect(owner.getByText("AI model saved")).toBeVisible();
  await expect(level("Best")).toBeChecked();
  await expect(owner.getByText("Drafts Claude Opus 5.5", { exact: true })).toBeVisible();
  await checkpoint(owner, "team-settings-changelog-best");
  expect((await saved()).levels).toEqual({ changelog: "best" });
  // Custom still needs Business.
  await level("Custom").click();
  await customPrompt.getByRole("button", { name: "Not now" }).click();
  await expect(level("Best")).toBeChecked();

  // Business: Custom lists the page's one role, Drafts, and a model picked there saves without a Save button.
  // (Bought from Free, as ai-tuning.spec.ts does: Pro was set in the database, with no subscription to change.)
  await query(`UPDATE project SET "planKey" = NULL WHERE slug = $1`, [slug]);
  await owner.goto(`/app/${slug}/settings/billing`);
  await owner.getByRole("button", { name: "Upgrade to Business" }).click();
  await owner.getByRole("button", { name: "Subscribe" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing?subscribed=1`);
  await owner.goto(`/app/${slug}/settings/changelog`);
  await level("Custom").click();
  await expect(owner.getByText("AI model saved")).toBeVisible();
  await expect(level("Custom")).toBeChecked();
  const drafts = owner.getByRole("combobox", { name: "Drafts" });
  await expect(drafts).toHaveValue("");
  // Until a model is picked, drafts run on the server's own.
  await expect(owner.getByText("Drafts Claude Haiku 5.5", { exact: true })).toBeVisible();
  await expect(owner.getByText("AI model saved")).toBeHidden({ timeout: 15_000 });
  // Typed, it's saved on Enter (or on leaving the box); chosen from the list, at once.
  await drafts.fill("acme/tiny");
  await drafts.press("Enter");
  await expect(owner.getByText("AI model saved")).toBeVisible();
  await expect(owner.getByText("Drafts Tiny", { exact: true })).toBeVisible();
  await checkpoint(owner, "team-settings-changelog-custom");
  expect(await saved()).toMatchObject({ levels: { changelog: "custom" }, models: { changelog: "acme/tiny" } });
  // A model the endpoint doesn't list is refused, and the pick stays.
  await drafts.fill("acme/imaginary");
  await drafts.press("Enter");
  await expect(owner.getByText("There's no model “acme/imaginary”")).toBeVisible();
  expect((await saved()).models).toEqual({ changelog: "acme/tiny" });
  await owner.reload();
  await expect(level("Custom")).toBeChecked();
  await expect(drafts).toHaveValue("acme/tiny");

  // Back on Free, Custom is kept and not used: Balanced is shown as in use, with a line saying why.
  await query(`UPDATE project SET "planKey" = 'free' WHERE slug = $1`, [slug]);
  await owner.reload();
  await expect(level("Balanced")).toBeChecked();
  await expect(owner.getByText("Custom isn't available on this plan.")).toBeVisible();
  await expect(drafts).toHaveCount(0);
  await expect(owner.getByText("Drafts Claude Haiku 5.5", { exact: true })).toBeVisible();
});

test("an admin picks the changelog's style examples: published entries from a searchable dialog, shown as chips, up to 3, saved by the page's Save changes", async ({ browser }, testInfo) => {
  test.setTimeout(150_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // Nothing published yet: the row says what it needs, with nothing to pick.
  await team.goto(`/app/${slug}/settings/changelog`);
  // One line on what the page is for, beside its title (above the card where the header has no room).
  await expect(team.getByText("How AI drafts your changelog entries").locator("visible=true")).toHaveCount(1);
  await expect(team.getByText("Publish an entry to use it as an example.")).toBeVisible();
  const pick = team.getByRole("button", { name: "Pick a style example" });
  await expect(pick).toHaveCount(0);

  // Four published entries (the fourth made is the newest, so the first listed), one a draft.
  const api = await apiFor(team, slug);
  const titles = ["Faster month view", "Agenda view", "Calendar sharing links for teams and guests", "Search by attendee"];
  for (const [index, title] of titles.entries()) {
    await api("/changelog", { title, body: "What changed." });
    await api(`/changelog/${index + 1}/publish`, { announce: false });
  }
  await api("/changelog", { title: "Still a draft", body: "Not out yet." });
  await team.goto(`/app/${slug}/settings/changelog`);
  const save = team.getByRole("button", { name: "Save changes" });
  const row = team.locator('[data-slot="setting-row"]').filter({ hasText: "Style examples" });
  const chips = team.getByRole("list", { name: "Style examples" }).getByRole("listitem");
  await expect(save).toBeDisabled();
  await expect(row.getByText("0/3")).toBeVisible();
  await expect(row.getByText("Entries that read the way you like.")).toBeVisible();

  // The dialog lists the published entries, newest first; its search narrows them by title.
  await pick.click();
  const dialog = team.getByRole("dialog", { name: "Pick a style example" });
  const search = dialog.getByRole("textbox", { name: "Search published entries" });
  await expect(dialog.getByRole("listitem")).toHaveText([...titles].reverse());
  await search.fill("zzz");
  await expect(dialog.getByRole("listitem")).toHaveText(["No matching entries."]);
  await search.fill("VIEW");
  await expect(dialog.getByRole("listitem")).toHaveText(["Agenda view", "Faster month view"]);
  // Searching is not a change to save, and opened again the search starts empty.
  await team.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(save).toBeDisabled();
  await pick.click();
  await expect(search).toHaveValue("");
  await expect(dialog.getByRole("listitem")).toHaveCount(4);
  // Picking one closes the dialog and adds its chip; focus is back on Pick. A second press as it closes picks nothing.
  await dialog.getByRole("list").evaluate((list) => {
    const press = (title: string) => [...list.querySelectorAll("button")].find((button) => button.textContent === title)!.click();
    press("Faster month view");
    press("Agenda view");
  });
  await expect(dialog).toBeHidden();
  await expect(chips).toHaveText(["Faster month view"]);
  await expect(row.getByText("1/3")).toBeVisible();
  await expect(save).toBeEnabled();
  await expect(pick).toBeFocused();
  // The one picked is no longer offered.
  await pick.click();
  await expect(dialog.getByRole("listitem")).toHaveText(["Search by attendee", "Calendar sharing links for teams and guests", "Agenda view"]);
  await dialog.getByRole("button", { name: "Search by attendee" }).click();
  // Chips are in the changelog's order, not the order picked.
  await expect(chips).toHaveText(["Search by attendee", "Faster month view"]);
  await team.setViewportSize({ width: 1440, height: 900 });
  await checkpoint(team, "team-settings-changelog-examples-desktop");
  await team.setViewportSize({ width: 1280, height: 720 });
  await pick.click();
  await dialog.getByRole("button", { name: "Calendar sharing links for teams and guests" }).click();
  // Three is the most: Pick is off.
  await expect(row.getByText("3/3")).toBeVisible();
  await expect(pick).toBeDisabled();

  // On a phone the chips go under the label at the card's width, and nothing runs off the side.
  await team.setViewportSize({ width: 390, height: 844 });
  const [label, list] = await Promise.all([row.getByText("Entries that read the way you like.").boundingBox(), chips.first().boundingBox()]);
  expect(list!.y).toBeGreaterThanOrEqual(label!.y + label!.height);
  expect(await team.locator('[data-slot="pane-body"]').evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(0);
  expect(await team.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  // A long title wraps in its chip, in full.
  await team.setViewportSize({ width: 320, height: 740 });
  const long = chips.filter({ hasText: "Calendar sharing links" });
  await expect(long).toHaveText("Calendar sharing links for teams and guests");
  expect(await long.locator("span").evaluate((title) => title.scrollWidth - title.clientWidth)).toBeLessThanOrEqual(0);
  expect((await long.boundingBox())!.height).toBeGreaterThan((await chips.first().boundingBox())!.height);
  expect(await team.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await team.setViewportSize({ width: 390, height: 844 });
  await checkpoint(team, "team-settings-changelog-examples-phone");
  // The dialog fits the phone too.
  await team.getByRole("button", { name: "Remove Search by attendee" }).click();
  await expect(pick).toBeFocused();
  await pick.click();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await checkpoint(team, "team-settings-changelog-examples-pick-phone", { fullPage: false });
  await team.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await team.setViewportSize({ width: 1280, height: 720 });

  // Saved from the header, and there after a reload.
  await save.click();
  await expect(team.getByText("Changelog saved")).toBeVisible();
  await team.reload();
  await expect(chips).toHaveText(["Calendar sharing links for teams and guests", "Faster month view"]);
  await expect(save).toBeDisabled();
  // A chip removed is a change to save; the same one picked again is none.
  await team.getByRole("button", { name: "Remove Faster month view" }).click();
  await expect(chips).toHaveText(["Calendar sharing links for teams and guests"]);
  await expect(save).toBeEnabled();
  await pick.click();
  await dialog.getByRole("button", { name: "Faster month view" }).click();
  await expect(save).toBeDisabled();

  // Leaving with a change not saved asks first.
  await team.getByLabel("Instructions").fill("Short and plain.");
  await team.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "General" }).click();
  const leave = team.getByRole("alertdialog", { name: "Leave without saving?" });
  await leave.getByRole("button", { name: "Keep editing" }).click();
  await expect(team.getByLabel("Instructions")).toHaveValue("Short and plain.");

  // A pick not saved yet whose entry is unpublished meanwhile stops counting once the page hears of it (here, as the
  // AI model saves): its chip goes, and there's room to pick another.
  await pick.click();
  await dialog.getByRole("button", { name: "Agenda view" }).click();
  await expect(row.getByText("3/3")).toBeVisible();
  await expect(pick).toBeDisabled();
  await api("/changelog/2/unpublish", {});
  await team.getByRole("radiogroup", { name: "AI model" }).getByRole("radio", { name: "Best" }).click();
  await expect(team.getByText("AI model saved")).toBeVisible();
  await expect(chips).toHaveText(["Calendar sharing links for teams and guests", "Faster month view"]);
  await expect(row.getByText("2/3")).toBeVisible();
  await expect(pick).toBeEnabled();
  // Another picked in its place, the one that dropped out is gone for good: published again, it doesn't come back as
  // a fourth.
  await pick.click();
  await dialog.getByRole("button", { name: "Search by attendee" }).click();
  await expect(row.getByText("3/3")).toBeVisible();
  await api("/changelog/2/publish", { announce: false });
  // The AI model's save brings the page what's published now: once it has landed (its own toast, the last one gone),
  // the three picked are still the three chips.
  const modelSaved = team.getByText("AI model saved");
  await expect(modelSaved).toHaveCount(0, { timeout: 15_000 });
  await team.getByRole("radiogroup", { name: "AI model" }).getByRole("radio", { name: "Balanced" }).click();
  await expect(modelSaved).toBeVisible();
  await expect(chips).toHaveCount(3);
  await expect(row.getByText("3/3")).toBeVisible();
  await team.getByRole("button", { name: "Remove Search by attendee" }).click();
  // Once the page hears it's published again, it's one to pick, not a chip.
  await pick.click();
  await expect(dialog.getByRole("button", { name: "Agenda view" })).toBeVisible();
  await team.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(chips).toHaveText(["Calendar sharing links for teams and guests", "Faster month view"]);
  await expect(row.getByText("2/3")).toBeVisible();
  // A chip removed while a pick has dropped out forgets that pick too: published again, it doesn't come back.
  await pick.click();
  await dialog.getByRole("button", { name: "Agenda view" }).click();
  await expect(row.getByText("3/3")).toBeVisible();
  await api("/changelog/2/unpublish", {});
  await expect(modelSaved).toHaveCount(0, { timeout: 15_000 });
  await team.getByRole("radiogroup", { name: "AI model" }).getByRole("radio", { name: "Best" }).click();
  await expect(modelSaved).toBeVisible();
  await expect(chips).toHaveText(["Calendar sharing links for teams and guests", "Faster month view"]);
  await team.getByRole("button", { name: "Remove Faster month view" }).click();
  await expect(chips).toHaveText(["Calendar sharing links for teams and guests"]);
  await api("/changelog/2/publish", { announce: false });
  await expect(modelSaved).toHaveCount(0, { timeout: 15_000 });
  await team.getByRole("radiogroup", { name: "AI model" }).getByRole("radio", { name: "Balanced" }).click();
  await expect(modelSaved).toBeVisible();
  await expect(chips).toHaveText(["Calendar sharing links for teams and guests"]);
  await pick.click();
  await dialog.getByRole("button", { name: "Faster month view" }).click();
  await expect(chips).toHaveText(["Calendar sharing links for teams and guests", "Faster month view"]);
  // What was typed is still there.
  await expect(team.getByLabel("Instructions")).toHaveValue("Short and plain.");
  // A saved example unpublished goes the same way, and what's typed and not saved stays.
  await api("/changelog/1/unpublish", {});
  await team.getByRole("radiogroup", { name: "AI model" }).getByRole("radio", { name: "Affordable" }).click();
  await expect(chips).toHaveText(["Calendar sharing links for teams and guests"]);
  await expect(row.getByText("1/3")).toBeVisible();
  await expect(team.getByLabel("Instructions")).toHaveValue("Short and plain.");
  await expect(save).toBeEnabled();
  // Saved, the page has nothing more to save.
  await save.click();
  await expect(team.getByText("Changelog saved")).toBeVisible();
  await expect(save).toBeDisabled();
  await team.reload();
  await expect(team.getByLabel("Instructions")).toHaveValue("Short and plain.");
  await expect(chips).toHaveText(["Calendar sharing links for teams and guests"]);
});
