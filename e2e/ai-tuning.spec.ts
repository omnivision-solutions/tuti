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
test("an owner sees Autopilot's three steps, finds Advanced tuning locked until Business, then changes values on its page and resets them", async ({ browser }, testInfo) => {
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

  // Advanced tuning is a page of its own; on Free it's locked, with the way to Business.
  const tuningLink = owner.getByRole("link", { name: /^Advanced tuning/ });
  await expect(tuningLink).toContainText("Available on Business");
  await checkpoint(owner, "team-settings-ai-models");
  await tuningLink.click();
  await owner.waitForURL(`**/app/${slug}/settings/ai-models/tuning`);
  await expect(owner.getByRole("heading", { name: "Advanced tuning", level: 1 })).toBeVisible();
  await expect(owner.getByText("Advanced tuning needs the Business plan.")).toBeVisible();
  await expect(owner.getByRole("link", { name: "See Billing" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await expect(owner.getByRole("spinbutton", { name: "Fix an article from" })).toBeDisabled();
  await expect(owner.getByRole("button", { name: "Save" })).toHaveCount(0);
  await checkpoint(owner, "team-settings-ai-tuning-locked");

  await owner.goto(`/app/${slug}/settings/billing`);
  await owner.getByRole("button", { name: "Upgrade to Business" }).click();
  await owner.getByRole("button", { name: "Subscribe" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing?subscribed=1`);

  // On Business: the owner lowers "Fix an article from", within the server's range, and sees it changed from the server's.
  await owner.goto(`/app/${slug}/settings/ai-models`);
  await expect(tuningLink).not.toContainText("Available on Business");
  await tuningLink.click();
  await owner.waitForURL(`**/app/${slug}/settings/ai-models/tuning`);
  const fix = owner.getByRole("spinbutton", { name: "Fix an article from" });
  const deciding = owner.getByRole("spinbutton", { name: "Lookups before deciding" });
  const writing = owner.getByRole("spinbutton", { name: "Lookups before writing" });
  const heading = owner.getByRole("heading", { name: "Advanced tuning", level: 1 });
  const save = owner.getByRole("button", { name: "Save", exact: true });
  await expect(fix).toHaveValue("40");
  await expect(fix).toHaveAttribute("max", "75");
  await expect(owner.getByText("Lower: fewer articles left out of date, more fixes to dismiss.", { exact: false })).toBeVisible();
  await fix.fill("30");
  await save.click();
  await expect(owner.getByText("Advanced tuning saved")).toBeVisible();
  await expect(owner.getByText("Changed from 40%")).toBeVisible();
  await expect(owner.getByText(/^Last changed by Olive Owner/)).toBeVisible();
  await expect(fix).toHaveValue("30");
  await expect(fix).toHaveAccessibleDescription(/Changed from 40%/);
  // After a save, focus is on the page's heading (the form starts again from what's stored).
  await expect(heading).toBeFocused();
  await checkpoint(owner, "team-settings-ai-tuning-changed");
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "team-settings-ai-tuning-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });

  // Reset only puts the server's value back in its field; another value typed but not saved stays as typed, and Save
  // saves both together.
  await deciding.fill("6");
  await owner.getByRole("button", { name: "Reset Fix an article from" }).click();
  await expect(fix).toHaveValue("40");
  await expect(fix).toBeFocused();
  await expect(owner.getByText("Changed from 40%")).toHaveCount(0);
  await expect(deciding).toHaveValue("6");
  expect((await stored(slug))["propose.edit.maybe"]).toBe(0.3);
  await save.click();
  await expect.poll(() => stored(slug)).toEqual({ "decide.rounds": 6 });
  // Reset all, then Save: back to the server's.
  await owner.getByRole("button", { name: "Reset all" }).click();
  await expect(deciding).toHaveValue("12");
  await save.click();
  await expect.poll(() => stored(slug)).toEqual({});
  await expect(owner.getByRole("button", { name: "Reset all" })).toHaveCount(0);

  // A value saved through the API that only rounds to the server's (0.395 shows as 40%): a Save of another field leaves
  // it alone; its Reset, then Save, clears it.
  await stored(slug, { "propose.edit.maybe": 0.395 });
  await owner.reload();
  await expect(fix).toHaveValue("40");
  await expect(owner.getByText("Changed from 40%")).toBeVisible();
  await deciding.fill("7");
  await save.click();
  await expect.poll(async () => (await stored(slug))["decide.rounds"]).toBe(7);
  expect((await stored(slug))["propose.edit.maybe"]).toBe(0.395);
  await expect(owner.getByRole("button", { name: "Reset Fix an article from" })).toBeEnabled();
  await owner.getByRole("button", { name: "Reset Fix an article from" }).click();
  await save.click();
  await expect.poll(async () => (await stored(slug))["propose.edit.maybe"]).toBeUndefined();
  await expect(heading).toBeFocused();

  // Changed elsewhere while the page is open (another owner, the API): a Save of another field leaves it as stored, and
  // the form then shows it.
  await expect(writing).toHaveValue("10");
  await stored(slug, { "write.rounds": 4 });
  await deciding.fill("9");
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(async () => (await stored(slug))["decide.rounds"]).toBe(9);
  expect((await stored(slug))["write.rounds"]).toBe(4);
  await expect(writing).toHaveValue("4");

  // A number typed with a leading zero is saved as the number: saving again records nothing.
  // Each save waits for its own answer from the server (its action's POST), registered before its click once the
  // last action is done (Save is enabled again), so no earlier answer can stand in for it.
  const saved = async () => {
    await expect(save).toBeEnabled();
    return { answer: owner.waitForResponse((response) => response.request().method() === "POST" && "next-action" in response.request().headers()) };
  };
  await deciding.fill("08");
  const first = await saved();
  await save.click();
  await first.answer;
  expect((await stored(slug))["decide.rounds"]).toBe(8);
  const before = await changedAt(slug);
  const second = await saved();
  await save.click();
  await second.answer;
  expect(await changedAt(slug)).toBe(before);
});
