import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import pg from "pg";

import { checkpoints } from "./checkpoint";
import { CLOUD_URL, cloudPortalUrl } from "./env";
import { createProject, signUp } from "./helpers";

/** When the project's tuning was last changed, as stored. */
async function changedAt(slug: string): Promise<number> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(`SELECT "tuningUpdatedAt" AS at FROM project WHERE slug = $1`, [slug])).rows[0].at.getTime();
  } finally {
    await client.end();
  }
}

/** The project's saved tuning as stored, or, given values, stored as the API would (any probability, not only whole percents). */
async function stored(slug: string, values?: Record<string, number>): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    if (values) {
      await client.query(`UPDATE project SET "codeChangesTuning" = "codeChangesTuning" || $1::jsonb WHERE slug = $2`, [JSON.stringify(values), slug]);
    }
    return (await client.query(`SELECT "codeChangesTuning" AS t FROM project WHERE slug = $1`, [slug])).rows[0].t;
  } finally {
    await client.end();
  }
}

// On Tuti's cloud, which sells plans: Advanced tuning is on Business.
test("an owner sees Autopilot's three steps, finds Advanced tuning locked until Business, then changes a threshold and resets it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);

  // Autopilot's steps, each with its own choice: Decides, Double-checks (which can be off), Writes.
  await owner.goto(`/app/${slug}/settings/ai-models`);
  const decides = owner.getByRole("radiogroup", { name: "Autopilot decides" });
  await expect(decides.getByRole("radio", { name: /^Fast/ })).toBeChecked();
  await expect(decides.getByText(/^About [\d.$]+ (credits? )?per merged pull request$/).first()).toBeVisible();
  await expect(owner.getByRole("radiogroup", { name: "Autopilot double-checks" }).getByRole("radio", { name: /^Off/ })).toBeVisible();
  await expect(owner.getByRole("radiogroup", { name: "Autopilot writes" })).toBeVisible();

  // Advanced tuning, folded away; on Free it's locked, with the way to Business.
  await expect(owner.getByRole("spinbutton", { name: "Fix an article from" })).toBeHidden();
  await owner.getByText("Advanced tuning", { exact: true }).click();
  await expect(owner.getByText("Available on Business")).toBeVisible();
  await expect(owner.getByText("Advanced tuning needs the Business plan.")).toBeVisible();
  await expect(owner.getByRole("link", { name: "See Billing" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await expect(owner.getByRole("spinbutton", { name: "Fix an article from" })).toBeDisabled();
  await expect(owner.getByRole("button", { name: "Save tuning" })).toHaveCount(0);
  await checkpoint(owner, "team-settings-ai-models-tuning-locked");

  await owner.goto(`/app/${slug}/settings/billing`);
  await owner.getByRole("button", { name: "Upgrade to Business" }).click();
  await owner.getByRole("button", { name: "Subscribe" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing?subscribed=1`);

  // On Business: the owner lowers "Fix an article from", within the server's range, and sees it changed from the server's.
  await owner.goto(`/app/${slug}/settings/ai-models`);
  await owner.getByText("Advanced tuning", { exact: true }).click();
  await expect(owner.getByText("Available on Business")).toHaveCount(0);
  const fix = owner.getByRole("spinbutton", { name: "Fix an article from" });
  await expect(fix).toHaveValue("40");
  await expect(fix).toHaveAttribute("max", "75");
  await expect(owner.getByText("Lower: fewer articles left out of date, more fixes to dismiss.", { exact: false })).toBeVisible();
  await fix.fill("30");
  await owner.getByRole("button", { name: "Save tuning" }).click();
  await expect(owner.getByText("Advanced tuning saved")).toBeVisible();
  await expect(owner.getByText("Changed from 40%")).toBeVisible();
  await expect(owner.getByText(/^Last changed by Olive Owner/)).toBeVisible();
  await expect(owner.getByRole("spinbutton", { name: "Fix an article from" })).toHaveValue("30");
  await expect(owner.getByRole("spinbutton", { name: "Fix an article from" })).toHaveAccessibleDescription(/Changed from 40%/);
  await checkpoint(owner, "team-settings-ai-models-tuning-changed");
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "team-settings-ai-models-tuning-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });

  // Reset saves that value back to the server's at once; another value typed but not saved stays as typed.
  await owner.getByRole("spinbutton", { name: "Lookups before deciding" }).fill("6");
  await owner.getByRole("button", { name: "Reset Fix an article from" }).click();
  await expect(owner.getByText("Changed from 40%")).toHaveCount(0);
  await expect(owner.getByRole("spinbutton", { name: "Fix an article from" })).toHaveValue("40");
  await expect(owner.getByRole("spinbutton", { name: "Lookups before deciding" })).toHaveValue("6");
  await expect(owner.getByRole("button", { name: "Reset all" })).toHaveCount(0);
  // Saved, the 6 is the project's own; Reset all puts it back.
  await owner.getByRole("button", { name: "Save tuning" }).click();
  await expect(owner.getByRole("button", { name: "Reset all" })).toBeVisible();
  await owner.getByRole("button", { name: "Reset all" }).click();
  await expect(owner.getByRole("button", { name: "Reset all" })).toHaveCount(0);
  await expect(owner.getByRole("spinbutton", { name: "Lookups before deciding" })).not.toHaveValue("6");
  // A value saved through the API that only rounds to the server's (0.395 shows as 40%): a Save of another field leaves
  // it alone; its Reset clears it.
  await stored(slug, { "propose.edit.maybe": 0.395 });
  await owner.reload();
  await owner.getByText("Advanced tuning", { exact: true }).click();
  await expect(owner.getByRole("spinbutton", { name: "Fix an article from" })).toHaveValue("40");
  await expect(owner.getByText("Changed from 40%")).toBeVisible();
  await owner.getByRole("spinbutton", { name: "Lookups before deciding" }).fill("7");
  await owner.getByRole("button", { name: "Save tuning" }).click();
  await expect.poll(async () => (await stored(slug))["decide.rounds"]).toBe(7);
  expect((await stored(slug))["propose.edit.maybe"]).toBe(0.395);
  // From the keyboard: once the Reset is saved (and its button gone), focus is on the section's heading, not the page.
  await expect(owner.getByRole("button", { name: "Reset Fix an article from" })).toBeEnabled();
  await owner.getByRole("button", { name: "Reset Fix an article from" }).focus();
  await owner.keyboard.press("Enter");
  await expect(owner.getByText("Changed from 40%")).toHaveCount(0);
  await expect(owner.locator("summary", { hasText: "Advanced tuning" })).toBeFocused();
  await expect.poll(async () => (await stored(slug))["propose.edit.maybe"]).toBeUndefined();
  // A number typed with a leading zero is saved as the number: saving again records nothing.
  await owner.getByRole("spinbutton", { name: "Lookups before deciding" }).fill("08");
  await owner.getByRole("button", { name: "Save tuning" }).click();
  await expect.poll(async () => (await stored(slug))["decide.rounds"]).toBe(8);
  const before = await changedAt(slug);
  await owner.getByRole("button", { name: "Save tuning" }).click();
  await expect(owner.getByText("Advanced tuning saved").first()).toBeVisible();
  expect(await changedAt(slug)).toBe(before);
});
