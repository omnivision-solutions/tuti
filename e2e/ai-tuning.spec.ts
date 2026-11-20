import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";
import pg from "pg";

import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, cloudPortalUrl } from "./env";
import { connectGithub, mergePullRequest } from "./github";
import { createProject, signUp } from "./helpers";
import { nextDecision, nextDocsAgentAnswer } from "./model";

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

// On Tuti's cloud, which sells plans: Advanced tuning is on Business.
test("an owner finds Advanced tuning on Settings → Autopilot, where it opens the upgrade prompt until Business, then changes values on its page and resets them", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);

  // Advanced tuning is a page of its own, reached from Autopilot's settings. On Free the row looks like any other, says
  // which plan it needs to a screen reader, and opens the upgrade prompt instead of the page.
  await owner.goto(`/app/${slug}/settings/autopilot`);
  const locked = owner.getByRole("button", { name: "Advanced tuning" });
  await expect(locked).toHaveAccessibleDescription("Advanced tuning needs the Business plan.");
  await expect(owner.getByText("Available on Business")).toHaveCount(0);
  // The card's last row: its bottom corners are the card's, so its hover and focus fill stays inside.
  expect(await locked.evaluate((row) => getComputedStyle(row).borderBottomLeftRadius)).not.toBe("0px");
  await locked.click();
  const prompt = owner.getByRole("dialog", { name: "Advanced tuning needs the Business plan." });
  await expect(prompt.getByRole("link", { name: "See plans" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await prompt.getByRole("button", { name: "Not now" }).click();
  await expect(prompt).toBeHidden();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/settings/autopilot$`));
  // With no values saved, nothing more is offered there.
  await expect(owner.getByRole("link", { name: "See saved tuning values" })).toHaveCount(0);
  // The page is still at its address (an analysis that ran with tuning links to it): on Free it's shown, not changed.
  // Its address under Settings → AI models, from before it moved, opens it too.
  await owner.goto(`/app/${slug}/settings/ai-models/tuning`);
  await owner.waitForURL(`**/app/${slug}/settings/autopilot/tuning`);
  // The page's title is its only "Advanced tuning": the values are two titled cards of rows.
  await expect(owner.getByRole("heading", { name: "Advanced tuning" })).toHaveCount(1);
  await expect(owner.getByRole("heading", { name: "How sure it must be", level: 2 })).toBeVisible();
  await expect(owner.getByRole("heading", { name: "How much it reads", level: 2 })).toBeVisible();
  // One way back, in the pane's header.
  await expect(owner.getByRole("region", { name: "Advanced tuning" }).getByRole("link", { name: /Autopilot/ })).toHaveAttribute("href", `/app/${slug}/settings/autopilot`);
  await expect(owner.getByText("Advanced tuning needs the Business plan.")).toBeVisible();
  await expect(owner.getByRole("link", { name: "See Billing" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await expect(owner.getByRole("spinbutton", { name: "To fix an article" })).toBeDisabled();
  await expect(owner.getByRole("radiogroup", { name: "Thinking" }).getByRole("radio", { name: "Off" })).toBeDisabled();
  await expect(owner.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await expect(owner.getByRole("button", { name: "Reset to defaults" })).toHaveCount(0);
  // What's behind a label's ⓘ still opens there.
  await owner.getByRole("button", { name: "More about this setting" }).click();
  await expect(owner.getByText("From 1,000 to 500,000.", { exact: false })).toBeVisible();
  await owner.keyboard.press("Escape");
  await checkpoint(owner, "team-settings-ai-tuning-locked");

  await owner.goto(`/app/${slug}/settings/billing`);
  await owner.getByRole("button", { name: "Upgrade to Business" }).click();
  await owner.getByRole("button", { name: "Subscribe" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/billing?subscribed=1`);

  // On Business the row is a link to the page: the owner lowers "To fix an article", within the server's range, and sees it changed from the server's.
  await owner.goto(`/app/${slug}/settings/autopilot`);
  await expect(locked).toHaveCount(0);
  await owner.getByRole("link", { name: "Advanced tuning" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/autopilot/tuning`);
  const fix = owner.getByRole("spinbutton", { name: "To fix an article" });
  const deciding = owner.getByRole("spinbutton", { name: "Lookups before deciding" });
  const writing = owner.getByRole("spinbutton", { name: "Lookups before writing" });
  const thinking = owner.getByRole("radiogroup", { name: "Thinking" });
  // The page's one Save, in its header, with "Reset to defaults" beside it: nothing to save or reset yet.
  const save = owner.getByRole("button", { name: "Save changes" });
  const resetAll = owner.getByRole("button", { name: "Reset to defaults" });
  await expect(save).toBeDisabled();
  await expect(resetAll).toBeDisabled();
  await expect(fix).toHaveValue("50");
  await expect(fix).toHaveAttribute("max", "75");
  // Each value says its tradeoff in one line; its unit is in the field, read out with its range.
  await expect(fix).toHaveAccessibleDescription("How sure it must be Lower catches more; higher means fewer to review. % , from 0 to 75");
  await expect(deciding).toHaveAccessibleDescription("More finds more, costs more. 1–50");
  await expect(owner.getByRole("spinbutton", { name: "Change shown up front" })).toHaveAccessibleDescription("Characters of the diff read at once. chars , from 1,000 to 500,000");
  await expect(thinking).toHaveAccessibleDescription("Better on hard changes, slower.");
  // A value typed and not saved is one "Reset to defaults" puts back too, leaving nothing to save.
  await deciding.fill("7");
  await expect(save).toBeEnabled();
  await expect(resetAll).toBeEnabled();
  await resetAll.click();
  await expect(deciding).toHaveValue("12");
  await expect(save).toBeDisabled();
  await fix.fill("30");
  await save.click();
  await expect(owner.getByText("Advanced tuning saved")).toBeVisible();
  await expect(owner.getByText("Changed from 50%")).toBeVisible();
  await expect(owner.getByText(/^Last changed by Olive Owner/)).toBeVisible();
  await expect(fix).toHaveValue("30");
  await expect(fix).toHaveAccessibleDescription(/Changed from 50%/);
  // After a save, focus is still on Save changes, with nothing left to save (the form starts again from what's stored).
  await expect(save).toBeDisabled();
  await expect(save).toBeFocused();
  await expect(resetAll).toBeEnabled();
  await checkpoint(owner, "team-settings-ai-tuning-changed");
  // On a wide screen each control is beside its label.
  const top = (locator: typeof thinking) => locator.evaluate((element) => element.getBoundingClientRect().top);
  const bottom = (locator: typeof thinking) => locator.evaluate((element) => element.getBoundingClientRect().bottom);
  await owner.setViewportSize({ width: 1440, height: 900 });
  expect(await top(thinking)).toBeLessThan(await bottom(owner.getByText("Thinking", { exact: true })));
  await checkpoint(owner, "team-settings-ai-tuning-wide");
  // On a phone nothing runs off the side; Thinking's options go under its label, a number stays beside its own.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await top(thinking)) - (await bottom(owner.getByText("Thinking", { exact: true })))).toBeGreaterThanOrEqual(0);
  expect(await top(fix)).toBeLessThan(await bottom(owner.getByText("Lower catches more; higher means fewer to review.")));
  // The header keeps the way back whole there: "Reset to defaults" shows as "Reset".
  await expect(resetAll.getByText("Reset to defaults")).toBeHidden();
  await expect(resetAll.getByText("Reset", { exact: true })).toBeVisible();
  expect(await owner.getByRole("region", { name: "Advanced tuning" }).getByRole("link", { name: /Autopilot/ }).locator("span").evaluate((label) => label.scrollWidth - label.clientWidth)).toBeLessThanOrEqual(0);
  expect(await owner.locator('[data-slot="pane-body"]').last().evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(0);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await checkpoint(owner, "team-settings-ai-tuning-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });

  // Reset, then the saved value typed back in: it's the owner's again ("Changed from" back), with nothing to save.
  await owner.getByRole("button", { name: "Reset To fix an article" }).click();
  await expect(owner.getByText("Changed from 50%")).toHaveCount(0);
  await expect(save).toBeEnabled();
  await fix.fill("30");
  await expect(owner.getByText("Changed from 50%")).toBeVisible();
  await expect(save).toBeDisabled();
  expect((await stored(slug))["propose.edit.maybe"]).toBe(0.3);
  await expect(fix).toHaveValue("30");

  // Reset only puts the server's value back in its field; another value typed but not saved stays as typed, and Save
  // saves both together.
  await deciding.fill("6");
  await owner.getByRole("button", { name: "Reset To fix an article" }).click();
  await expect(fix).toHaveValue("50");
  await expect(fix).toBeFocused();
  await expect(owner.getByText("Changed from 50%")).toHaveCount(0);
  await expect(deciding).toHaveValue("6");
  expect((await stored(slug))["propose.edit.maybe"]).toBe(0.3);
  await save.click();
  await expect.poll(() => stored(slug)).toEqual({ "decide.rounds": 6 });
  // The form has started again from what's stored (each save here is followed by something it then shows).
  await expect(deciding).toHaveAccessibleDescription(/Changed from 12/);
  // Thinking is a choice of options: one picked and saved, then its Reset puts the server's back, focus on it.
  await thinking.getByText("High", { exact: true }).click();
  await save.click();
  await expect.poll(async () => (await stored(slug))["decide.reasoning"]).toBe("high");
  await expect(thinking).toHaveAccessibleDescription(/Changed from Off/);
  // On a phone its Reset sits beside the options, all within the card.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => owner.locator('[data-slot="pane-body"]').last().evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(0);
  expect(await thinking.evaluate((group) => group.getBoundingClientRect().right - group.closest('[data-slot="setting-row"]')!.getBoundingClientRect().right)).toBeLessThan(0);
  await checkpoint(owner, "team-settings-ai-tuning-phone-thinking");
  await owner.setViewportSize({ width: 1280, height: 720 });
  await owner.getByRole("button", { name: "Reset Thinking" }).click();
  await expect(thinking.getByRole("radio", { name: "Off" })).toBeChecked();
  await expect(thinking.getByRole("radio", { name: "Off" })).toBeFocused();
  // Reset to defaults, then Save: back to the server's. With nothing left to reset it stays, and keeps focus.
  await resetAll.click();
  await expect(deciding).toHaveValue("12");
  await expect(resetAll).toBeDisabled();
  await expect(resetAll).toBeFocused();
  await save.click();
  await expect.poll(() => stored(slug)).toEqual({});
  await expect(save).toBeDisabled();
  await expect(resetAll).toBeDisabled();

  // A value saved through the API that only rounds to the server's (0.495 shows as 50%): a Save of another field leaves
  // it alone; its Reset, then Save, clears it.
  await stored(slug, { "propose.edit.maybe": 0.495 });
  await owner.reload();
  await expect(fix).toHaveValue("50");
  await expect(owner.getByText("Changed from 50%")).toBeVisible();
  await deciding.fill("7");
  await save.click();
  await expect.poll(async () => (await stored(slug))["decide.rounds"]).toBe(7);
  expect((await stored(slug))["propose.edit.maybe"]).toBe(0.495);
  await expect(deciding).toHaveAccessibleDescription(/Changed from 12/);
  await owner.getByRole("button", { name: "Reset To fix an article" }).click();
  await save.click();
  await expect.poll(async () => (await stored(slug))["propose.edit.maybe"]).toBeUndefined();
  await expect(save).toBeFocused();

  // Changed elsewhere while the page is open (another owner, the API): a Save of another field leaves it as stored, and
  // the form then shows it.
  await owner.reload();
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
  // While a save runs "Reset to defaults" waits: the form starts again once saved, and a reset made then would be lost.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await owner.route(`**/app/${slug}/settings/autopilot/tuning`, async (route) => {
    if (route.request().method() === "POST") {
      await held;
    }
    await route.continue();
  });
  await expect(resetAll).toBeEnabled();
  await save.click();
  await expect(resetAll).toBeDisabled();
  release();
  await first.answer;
  await owner.unroute(`**/app/${slug}/settings/autopilot/tuning`);
  await expect(resetAll).toBeEnabled();
  expect((await stored(slug))["decide.rounds"]).toBe(8);
  // The form starts again showing it as saved, with nothing to save; typed that way again, it's a save of nothing.
  await expect(deciding).toHaveValue("8");
  await expect(save).toBeDisabled();
  await deciding.fill("08");
  const before = await changedAt(slug);
  const second = await saved();
  await save.click();
  await second.answer;
  expect(await changedAt(slug)).toBe(before);

  // Back on a plan without tuning, the values are kept and not used. The row opens the upgrade prompt again, so a link
  // under it leads to the values: shown, not changed.
  await query(`UPDATE project SET "planKey" = NULL WHERE slug = $1`, [slug]);
  await owner.goto(`/app/${slug}/settings/autopilot`);
  await expect(locked).toHaveAccessibleDescription("Advanced tuning needs the Business plan.");
  await checkpoint(owner, "team-settings-autopilot-tuning-kept");
  await owner.getByRole("link", { name: "See saved tuning values" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/autopilot/tuning`);
  await expect(owner.getByText("This project's values are kept but not used; on a plan with Advanced tuning, they're used again.")).toBeVisible();
  await expect(deciding).toHaveValue("8");
  await expect(deciding).toBeDisabled();
});

// A server without plans: every project's tuning applies.
test("an analysis that ran with the project's tuning says so on its activity page: a link to it for the owner, the words for a member", async ({ browser }) => {
  const id = randomUUID().slice(0, 8);
  const number = randomInt(1_000, 1_000_000);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await stored(slug, { "propose.edit.maybe": 0.3 });
  const installationId = await connectGithub(owner, slug);

  // Users don't see it and the docs agent finds nothing: nothing to do, analysed with the project's values all the same.
  const pr = `Refactor the theme code ${id}`;
  await nextDecision({ audience: { users: 0.05, internal: 0.9, dependencies: 0.03, repository_docs: 0.02 } }, pr);
  await nextDocsAgentAnswer(number, {});
  await mergePullRequest(installationId, { number, title: pr, files: [{ filename: "src/theme.ts", patch: "+export const themes = [];" }] });
  const changeOf = async () =>
    (await query(`SELECT c.id, c.state FROM code_change c JOIN project p ON p.id = c."projectId" WHERE p.slug = $1 AND c.number = $2`, [slug, number]))[0] as
      | { id: string; state: string }
      | undefined;
  await expect.poll(async () => (await changeOf())?.state).toBe("NOTHING_TO_DO");
  const activity = `/app/${slug}/autopilot/activity/${(await changeOf())!.id}`;

  await owner.goto(activity);
  await expect(owner.getByText("Ran with this project's tuning: To fix an article")).toBeVisible();
  await expect(owner.getByRole("link", { name: "Ran with this project's tuning" })).toHaveAttribute("href", `/app/${slug}/settings/autopilot/tuning`);

  // A member reads which values, with no link (Settings is for owners and admins).
  const member = await signUp(browser, APP_URL, "Mo Member");
  await query(
    `INSERT INTO team_member (id, "projectId", "userId", role) SELECT gen_random_uuid()::text, p.id, u.id, 'MEMBER' FROM project p, "user" u WHERE p.slug = $1 AND u.email = $2`,
    [slug, member.email],
  );
  await member.goto(activity);
  await expect(member.getByText("Ran with this project's tuning: To fix an article")).toBeVisible();
  await expect(member.getByRole("link", { name: "Ran with this project's tuning" })).toHaveCount(0);

  // An admin sees the values and that they aren't theirs to change: no Save, no resets.
  const admin = await signUp(browser, APP_URL, "Ada Admin");
  await query(
    `INSERT INTO team_member (id, "projectId", "userId", role) SELECT gen_random_uuid()::text, p.id, u.id, 'ADMIN' FROM project p, "user" u WHERE p.slug = $1 AND u.email = $2`,
    [slug, admin.email],
  );
  await admin.goto(`/app/${slug}/settings/autopilot/tuning`);
  await expect(admin.getByText("Only owners change these.").filter({ visible: true })).toHaveCount(1);
  await expect(admin.getByRole("spinbutton", { name: "To fix an article" })).toHaveValue("30");
  await expect(admin.getByRole("spinbutton", { name: "To fix an article" })).toBeDisabled();
  await expect(admin.getByText("Changed from 50%")).toBeVisible();
  await expect(admin.getByRole("button", { name: /Reset|Save changes/ })).toHaveCount(0);
});
