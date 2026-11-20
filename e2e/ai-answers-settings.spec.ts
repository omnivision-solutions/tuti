import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
import { query } from "./db";
import { CLOUD_URL, cloudPortalUrl } from "./env";
import { expect, test } from "./fixtures";
import { createProject, signUp } from "./helpers";

// On Tuti's cloud, which sells plans: levels are on Pro. (changelog-settings.spec.ts has Custom and the rest of the setting.)
test("an owner sets AI answers' AI model: on Free, Best opens the upgrade prompt and nothing changes; on Pro it saves for Answers and Summaries", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  const levels = async () => (await query(`SELECT "aiLevels" AS levels FROM project WHERE slug = $1`, [slug]))[0].levels;

  // Free: the page starts with the AI model, on Balanced, naming the model of each of its two roles.
  await owner.goto(`/app/${slug}/settings/ai-answers`);
  const aiModel = owner.getByRole("radiogroup", { name: "AI model" });
  const level = (name: string) => aiModel.getByRole("radio", { name, exact: true });
  await expect(aiModel.getByRole("radio")).toHaveText(["Affordable", "Balanced", "Best", "Custom"]);
  await expect(level("Balanced")).toBeChecked();
  await expect(owner.getByText("Answers Claude Haiku 5.5 · Summaries Claude Haiku 5.5", { exact: true })).toBeVisible();
  // Then the page's own settings, a label each.
  const length = owner.getByRole("radiogroup", { name: "Answer length" });
  await expect(length.locator("label")).toHaveText(["Short", "Medium", "Detailed"]);
  await expect(length.getByRole("radio", { name: "Medium" })).toBeChecked();
  await expect(owner.getByLabel("Instructions")).toBeVisible();
  await expect(owner.getByLabel("Off-limits topics")).toBeVisible();
  // One Save, in the page's header: enabled once something differs from what's saved.
  const save = owner.getByRole("button", { name: "Save changes" });
  await expect(save).toBeDisabled();
  // On a phone the page fits its width, chips included.
  for (const topic of ["refunds", "legal advice", "a competitor's pricing and roadmap"]) {
    await owner.getByLabel("Off-limits topics").fill(topic);
    await owner.getByLabel("Off-limits topics").press("Enter");
  }
  await expect(save).toBeEnabled();
  await owner.setViewportSize({ width: 1440, height: 900 });
  await checkpoint(owner, "team-settings-ai-answers-desktop");
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await checkpoint(owner, "team-settings-ai-answers-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  // Removing them again leaves nothing to save.
  for (const topic of ["refunds", "legal advice", "a competitor's pricing and roadmap"]) {
    await owner.getByRole("button", { name: `Remove ${topic}` }).click();
  }
  await expect(save).toBeDisabled();

  // A level the plan lacks opens the upgrade prompt, and the level stays as it was.
  await expect(level("Best")).toHaveAccessibleDescription("Choosing an AI level needs the Pro plan.");
  await level("Best").click();
  const prompt = owner.getByRole("dialog", { name: "Choosing an AI level needs the Pro plan." });
  await expect(prompt.getByRole("link", { name: "See plans" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await checkpoint(owner, "team-settings-ai-answers-upgrade", { fullPage: false });
  await prompt.getByRole("button", { name: "Not now" }).click();
  await expect(prompt).toBeHidden();
  await expect(level("Balanced")).toBeChecked();
  expect(await levels()).toEqual({});

  // Pro has levels: Best saves at once, for both roles.
  await query(`UPDATE project SET "planKey" = 'pro' WHERE slug = $1`, [slug]);
  await owner.reload();
  await level("Best").click();
  await expect(owner.getByText("AI model saved")).toBeVisible();
  await expect(level("Best")).toBeChecked();
  await expect(owner.getByText("Answers Claude Opus 5.5 · Summaries Claude Sonnet 5.5", { exact: true })).toBeVisible();
  await checkpoint(owner, "team-settings-ai-answers-best");
  expect(await levels()).toEqual({ answers: "best" });
});
