import { randomUUID } from "node:crypto";

import pg from "pg";

import { checkpoints } from "./checkpoint";
import { APP_URL, CHECKS_SLUG, CLOUD_URL, cloudPortalUrl } from "./env";
import { expect, test } from "./fixtures";
import { createProject, signUp } from "./helpers";

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

const saved = async (slug: string) => (await query(`SELECT "aiLevels" AS levels, "aiModels" AS models FROM project WHERE slug = $1`, [slug]))[0];

test("an owner sets Autopilot's AI model and switches Checks off and on, the two always agreeing; every switch is a label; Settings → AI models sends them here", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // Settings → AI models is gone from the menu, and its address opens Autopilot's settings.
  await owner.goto(`/app/${slug}/settings/ai-models`);
  await owner.waitForURL(`**/app/${slug}/settings/autopilot`);
  const menu = owner.getByRole("navigation", { name: "Settings" });
  await expect(menu.getByRole("link", { name: "Autopilot", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(menu.getByRole("link", { name: "AI models", exact: true })).toHaveCount(0);

  // The AI model, first on the page: a level, saved as it's chosen, with the model each of its three roles runs on under the label.
  const aiModel = owner.getByRole("radiogroup", { name: "AI model" });
  const level = (name: string) => aiModel.getByRole("radio", { name, exact: true });
  const summary = (text: string) => owner.getByText(text, { exact: true });
  await expect(owner.locator('[data-slot="setting-row"]').first()).toContainText("AI model");
  await expect(aiModel.getByRole("radio")).toHaveText(["Affordable", "Balanced", "Best", "Custom"]);
  await expect(level("Balanced")).toBeChecked();
  await expect(summary("Decides Claude Haiku 5.5 · Checks Claude Sonnet 5.5 · Writes Claude Sonnet 5.5")).toBeVisible();
  // Chosen from the keyboard, the level saves and keeps focus.
  await level("Affordable").focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByText("AI model saved")).toBeVisible();
  await expect(level("Affordable")).toBeChecked();
  await expect(level("Affordable")).toBeFocused();
  await expect(summary("Decides Claude Haiku 5.5 · Checks Claude Haiku 5.5 · Writes Claude Haiku 5.5")).toBeVisible();
  expect(await saved(slug)).toEqual({ levels: { code_changes: "affordable" }, models: {} });

  // Checks: a switch, on by default. Off from the keyboard: it keeps focus, the line above says Off, and the level stays.
  const checks = owner.getByRole("switch", { name: "Checks", exact: true });
  await expect(checks).toBeChecked();
  await checks.focus();
  await owner.keyboard.press("Space");
  await expect(owner.getByText("Checks: off")).toBeVisible();
  await expect(checks).not.toBeChecked();
  await expect(checks).toBeFocused();
  await expect(summary("Decides Claude Haiku 5.5 · Checks Off · Writes Claude Haiku 5.5")).toBeVisible();
  await expect(level("Affordable")).toBeChecked();
  expect(await saved(slug)).toEqual({ levels: { code_changes: "affordable" }, models: { code_changes_check: "off" } });
  // The server doesn't check this project's article edits: no notice that they wait, and the switch says nothing more (below).
  await expect(owner.getByText(/go out by themselves/)).toHaveCount(0);

  // Custom lists a model for Decides, Checks and Writes. With Checks off, its row says Off instead of a model.
  await level("Custom").click();
  await expect(level("Custom")).toBeChecked();
  const box = (name: string) => owner.getByRole("combobox", { name, exact: true });
  await expect(box("Decides")).toBeVisible();
  await expect(box("Writes")).toBeVisible();
  await expect(box("Checks")).toHaveCount(0);
  await expect(owner.getByText("ChecksOff", { exact: true })).toBeVisible();
  await checkpoint(owner, "team-settings-autopilot-checks-off");
  // On again: the role's pick is cleared, so its box is back, empty (the server's own model until one is picked).
  await checks.click();
  await expect(owner.getByText("Checks: on")).toBeVisible();
  await expect(checks).toBeChecked();
  await expect(box("Checks")).toHaveValue("");
  await expect(summary("Decides Claude Haiku 5.5 · Checks Claude Sonnet 5.5 · Writes Claude Sonnet 5.5")).toBeVisible();
  expect(await saved(slug)).toEqual({ levels: { code_changes: "custom" }, models: {} });
  // A model picked for Checks saves from its box, and "off" typed there is the switch off: the switch follows.
  await box("Checks").fill("anthropic/claude-haiku-5.5");
  await owner.keyboard.press("Enter");
  await expect(summary("Decides Claude Haiku 5.5 · Checks Claude Haiku 5.5 · Writes Claude Sonnet 5.5")).toBeVisible();
  await expect(box("Checks")).toBeFocused();
  await box("Checks").fill("off");
  await owner.keyboard.press("Enter");
  await expect(checks).not.toBeChecked();
  await expect(box("Checks")).toHaveCount(0);
  // The box went with keyboard focus in it: focus is on the switch, which turns Checks on again.
  await expect(checks).toBeFocused();
  await owner.keyboard.press("Space");
  await expect(checks).toBeChecked();
  await expect(box("Checks")).toBeVisible();

  // Three boxes read at a phone's width too: each under its label, none wider than the card, the page no wider than the window.
  await owner.setViewportSize({ width: 360, height: 740 });
  const card = (await aiModel.boundingBox())!;
  for (const name of ["Decides", "Checks", "Writes"]) {
    const bounds = (await box(name).boundingBox())!;
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(card.x + card.width);
    expect(bounds.width).toBeGreaterThan(200);
  }
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await checkpoint(owner, "team-settings-autopilot-phone");
  await owner.setViewportSize({ width: 1440, height: 900 });

  // Every switch is a label, with nothing more read out; one keeps a hint: completing a post emails people.
  for (const name of ["Checks", "Analyse merged pull requests", "Link posts by itself", "Write drafts at once", "Publish article edits", "Post progress updates"]) {
    await expect(owner.getByRole("switch", { name, exact: true })).toHaveAccessibleDescription("");
  }
  await expect(owner.getByRole("switch", { name: "Complete posts" })).toHaveAccessibleDescription("Completing a post emails the people who asked for it.");
  await expect(owner.getByText(/After the hold|Only your team sees it|Off, Autopilot makes no links/)).toHaveCount(0);
  // What's sent where stays on the page, by the switch that sends it.
  await expect(owner.getByText(/^Sent to .+: each merged pull request's title, description, commits and diff/)).toBeVisible();
  await checkpoint(owner, "team-settings-autopilot");

  // The way to Advanced tuning, a page of its own, with the way back.
  await owner.getByRole("link", { name: "Advanced tuning" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/autopilot/tuning`);
  await owner.getByRole("region", { name: "Advanced tuning" }).getByRole("link", { name: /Autopilot/ }).click();
  await owner.waitForURL(`**/app/${slug}/settings/autopilot`);
});

test("where the server checks a project's article edits, the Checks switch says what it does and prices a review; with Checks off a notice says edits wait, until Checks is switched on from it or it's dismissed for good", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", CHECKS_SLUG);
  await owner.goto(`/app/${CHECKS_SLUG}/settings/autopilot`);

  // On: what it does, what off means and a review's price (Balanced checks on Sonnet), read out with the switch. No notice.
  const checks = owner.getByRole("switch", { name: "Checks", exact: true });
  const notice = owner.getByRole("status").filter({ hasText: "Article edits no longer go out by themselves while Checks is off: each one waits for your team." });
  await expect(checks).toBeChecked();
  await expect(checks).toHaveAccessibleDescription("Reviews every article edit and double-checks new articles. Off, every edit waits for your team. About 26 credits per edit reviewed");
  await expect(notice).toHaveCount(0);

  // Off from the keyboard: the notice is at the top of the page, and the switch keeps focus and its price.
  await checks.focus();
  await owner.keyboard.press("Space");
  await expect(owner.getByText("Checks: off")).toBeVisible();
  await expect(notice).toBeVisible();
  await expect(checks).toBeFocused();
  await expect(checks).toHaveAccessibleDescription(/About 26 credits per edit reviewed$/);
  await checkpoint(owner, "team-settings-autopilot-checks-notice");
  // Only while edits would otherwise go out by themselves: Publish article edits off, no notice; on again, it's back.
  const publish = owner.getByRole("switch", { name: "Publish article edits", exact: true });
  await publish.click();
  await expect(publish).not.toBeChecked();
  await expect(notice).toHaveCount(0);
  await publish.click();
  await expect(publish).toBeChecked();
  await expect(notice).toBeVisible();

  // Switch Checks on, from the keyboard: on, the notice gone, focus on the switch.
  await notice.getByRole("button", { name: "Switch Checks on" }).focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByText("Checks: on")).toBeVisible();
  await expect(checks).toBeChecked();
  await expect(notice).toHaveCount(0);
  await expect(checks).toBeFocused();

  // Off again, the notice is back; Dismiss, from the keyboard, hides it for good, Checks still off.
  await owner.keyboard.press("Space");
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss" }).focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByText("Dismissed")).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(checks).toBeFocused();
  await expect(checks).not.toBeChecked();
  await owner.reload();
  await expect(checks).not.toBeChecked();
  await expect(checks).toHaveAccessibleDescription(/^Reviews every article edit/);
  await expect(notice).toHaveCount(0);
});

// On Tuti's cloud, which sells plans: levels are on Pro, Custom and Advanced tuning on Business.
test("on a plan without AI levels, choosing Autopilot's level opens the upgrade prompt and nothing changes; Checks still switches off; on Pro the level saves", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);

  await owner.goto(`/app/${slug}/settings/autopilot`);
  const aiModel = owner.getByRole("radiogroup", { name: "AI model" });
  const level = (name: string) => aiModel.getByRole("radio", { name, exact: true });
  await expect(aiModel.getByRole("radio")).toHaveText(["Affordable", "Balanced", "Best", "Custom"]);
  await expect(level("Balanced")).toBeChecked();
  await expect(level("Best")).toHaveAccessibleDescription("Choosing an AI level needs the Pro plan.");
  await expect(level("Custom")).toHaveAccessibleDescription("Picking your own AI models needs the Business plan.");
  await level("Best").click();
  const prompt = owner.getByRole("dialog", { name: "Choosing an AI level needs the Pro plan." });
  await expect(prompt.getByRole("link", { name: "See plans" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await checkpoint(owner, "team-settings-autopilot-upgrade", { fullPage: false });
  await prompt.getByRole("button", { name: "Not now" }).click();
  await expect(prompt).toBeHidden();
  await expect(level("Balanced")).toBeChecked();
  expect(await saved(slug)).toEqual({ levels: {}, models: {} });

  // Switching Checks off needs no plan.
  const checks = owner.getByRole("switch", { name: "Checks", exact: true });
  await checks.click();
  await expect(owner.getByText("Checks: off")).toBeVisible();
  await expect(owner.getByText(/^Decides .+ · Checks Off · Writes .+$/)).toBeVisible();
  expect(await saved(slug)).toEqual({ levels: {}, models: { code_changes_check: "off" } });

  // A level saved on a plan that had it, kept and not used on Free: Balanced is the one shown, and a line says why.
  await query(`UPDATE project SET "aiLevels" = '{"code_changes":"best"}' WHERE slug = $1`, [slug]);
  await owner.reload();
  await expect(level("Balanced")).toBeChecked();
  await expect(owner.getByText("Best isn't available on this plan.")).toBeVisible();

  // Pro has levels: Best is in use, Checks still off, and another level saves.
  await query(`UPDATE project SET "planKey" = 'pro' WHERE slug = $1`, [slug]);
  await owner.reload();
  await expect(level("Best")).toBeChecked();
  await expect(checks).not.toBeChecked();
  await level("Affordable").click();
  await expect(owner.getByText("AI model saved")).toBeVisible();
  await expect(level("Affordable")).toBeChecked();
  expect(await saved(slug)).toEqual({ levels: { code_changes: "affordable" }, models: { code_changes_check: "off" } });
});
