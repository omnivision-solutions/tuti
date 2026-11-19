import { randomUUID } from "node:crypto";

import pg from "pg";

import { checkpoints } from "./checkpoint";
import { CLOUD_URL, cloudPortalUrl } from "./env";
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
