import { randomUUID } from "node:crypto";

import pg from "pg";

import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, cloudPortalUrl } from "./env";
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

  // The switch that turns Autopilot on comes first; then the AI model: a level, saved as it's chosen, with the model each of its three roles runs on under the label.
  const aiModel = owner.getByRole("radiogroup", { name: "AI model" });
  const level = (name: string) => aiModel.getByRole("radio", { name, exact: true });
  const summary = (text: string) => owner.getByText(text, { exact: true });
  await expect(owner.locator('[data-slot="setting-row"]').nth(0)).toContainText("Analyse merged pull requests");
  await expect(owner.locator('[data-slot="setting-row"]').nth(1)).toContainText("AI model");
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
  const checks = owner.getByRole("switch", { name: "Check its own edits", exact: true });
  await expect(checks).toBeChecked();
  await checks.focus();
  await owner.keyboard.press("Space");
  await expect(owner.getByText("Checks: off")).toBeVisible();
  await expect(checks).not.toBeChecked();
  await expect(checks).toBeFocused();
  await expect(summary("Decides Claude Haiku 5.5 · Checks Off · Writes Claude Haiku 5.5")).toBeVisible();
  await expect(level("Affordable")).toBeChecked();
  expect(await saved(slug)).toEqual({ levels: { code_changes: "affordable" }, models: { code_changes_check: "off" } });
  // No notice that edits wait: the switch's own line says what off does (below).
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

  // Every switch is a label, with nothing more read out; two keep a line: Checks says what it does (below), and completing a
  // post emails people.
  await expect(checks).toHaveAccessibleDescription(/^Reviews every article edit/);
  for (const name of ["Analyse merged pull requests", "Link posts by itself", "Write drafts", "Publish article edits", "Post progress updates"]) {
    await expect(owner.getByRole("switch", { name, exact: true })).toHaveAccessibleDescription("");
  }
  await expect(owner.getByRole("switch", { name: "Complete posts" })).toHaveAccessibleDescription("Emails the people who asked.");
  await expect(owner.getByText(/After the hold|Only your team sees it|Off, Autopilot makes no links/)).toHaveCount(0);
  // What Checks does is behind its ⓘ, and its price stays in sight.
  const checksRow = owner.locator('[data-slot="setting-row"]', { has: checks });
  await expect(checksRow.getByText("About 26 credits per edit reviewed")).toBeVisible();
  await checksRow.getByRole("button", { name: "More about this setting" }).click();
  await expect(owner.getByRole("dialog").getByText(/^Reviews every article edit and double-checks new articles\./)).toBeVisible();
  await owner.keyboard.press("Escape");
  // What's sent where stays one press away, by the switch that sends it; no intro paragraph, and one line in the header.
  const sent = owner.getByText(/^Sent to .+: each merged pull request's title, description, commits and diff/);
  await expect(sent).toHaveCount(0);
  await expect(owner.getByText("What's sent to the AI provider")).toBeVisible();
  await owner.getByRole("button", { name: "See details" }).click();
  await expect(sent).toBeVisible();
  await expect(sent).toContainText("secret-looking strings are masked.");
  await checkpoint(owner, "team-settings-autopilot-sent", { fullPage: false });
  await owner.keyboard.press("Escape");
  await expect(sent).toBeHidden();
  await expect(owner.getByRole("region", { name: "Autopilot" }).getByText("Turns merged pull requests into post, docs and changelog updates").first()).toBeVisible();
  await expect(owner.getByText(/^When a pull request merges/)).toHaveCount(0);
  await checkpoint(owner, "team-settings-autopilot");

  // The way to Advanced tuning, a page of its own, with the way back.
  await owner.getByRole("link", { name: "Advanced tuning" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/autopilot/tuning`);
  await owner.getByRole("region", { name: "Advanced tuning" }).getByRole("link", { name: /Autopilot/ }).click();
  await owner.waitForURL(`**/app/${slug}/settings/autopilot`);
});

test("the Checks switch says what it does and prices a review; switched off, it keeps focus and its line, nothing else appears, and it stays off", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto(`/app/${slug}/settings/autopilot`);

  // On for a new project: what it does, what off means and a review's price (Balanced checks on Sonnet), read out with the switch.
  const checks = owner.getByRole("switch", { name: "Check its own edits", exact: true });
  await expect(checks).toBeChecked();
  await expect(checks).toHaveAccessibleDescription("Reviews every article edit and double-checks new articles. Off, edits written from then on wait for your team. About 26 credits per edit reviewed");

  // Off from the keyboard: the switch keeps focus and its line, and no notice comes up.
  await checks.focus();
  await owner.keyboard.press("Space");
  await expect(owner.getByText("Checks: off")).toBeVisible();
  await expect(checks).not.toBeChecked();
  await expect(checks).toBeFocused();
  await expect(checks).toHaveAccessibleDescription(/About 26 credits per edit reviewed$/);
  await expect(owner.getByRole("status").filter({ hasText: /go out by themselves/ })).toHaveCount(0);
  await checkpoint(owner, "team-settings-autopilot-checks-off");
  await owner.reload();
  await expect(checks).not.toBeChecked();
  await expect(checks).toHaveAccessibleDescription(/^Reviews every article edit/);
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
  const checks = owner.getByRole("switch", { name: "Check its own edits", exact: true });
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

test("Autopilot's limits read as sentences with their unit in the field and save with the header's Save changes; its emails are a switch and chips; nothing overflows on a phone", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const join = async (page: { email: string }, role: string) =>
    query(`INSERT INTO team_member (id, "projectId", "userId", role) SELECT gen_random_uuid()::text, p.id, u.id, $3 FROM project p, "user" u WHERE p.slug = $1 AND u.email = $2`, [slug, page.email, role]);
  const admin = await signUp(browser, APP_URL, "Sam Rivera");
  await join(admin, "ADMIN");
  const member = await signUp(browser, APP_URL, "Priya Shah");
  await join(member, "MEMBER");
  await owner.goto(`/app/${slug}/settings/autopilot`);
  const pane = owner.getByRole("region", { name: "Autopilot" });

  // The cards: what it does by itself, when it waits, who gets its emails.
  await expect(pane.getByRole("heading", { level: 2 })).toHaveText(["Does by itself", "Waits for your team when", "Emails", "How it's doing"]);
  // Each limit is a sentence: its label, then the number with its unit in the field (read out with it).
  const limits = [
    ["It's less sure than", "%", "95"],
    ["A post has at least", "people", "25"],
    ["An article has at least", "reads / 30 days", "500"],
    ["Hold before anything goes out", "hours", "24"],
  ] as const;
  for (const [name, unit, value] of limits) {
    const field = owner.getByRole("spinbutton", { name, exact: true });
    await expect(field).toHaveValue(value);
    await expect(field).toHaveAccessibleDescription(unit);
  }
  // What takes longer to say is behind an ⓘ.
  await expect(owner.getByText(/so your team can stop it/)).toHaveCount(0);
  const row = (name: string) => owner.locator('[data-slot="setting-row"]', { has: owner.getByText(name, { exact: true }) });
  await row("Hold before anything goes out").getByRole("button", { name: "More about this setting" }).click();
  await expect(owner.getByText("What goes out by itself waits this long first, so your team can stop it. Drafts don't wait.")).toBeVisible();
  await owner.keyboard.press("Escape");
  await row("A post has at least").getByRole("button", { name: "More about this setting" }).click();
  await expect(owner.getByText("Its author, voters, commenters and subscribers.")).toBeVisible();
  await owner.keyboard.press("Escape");

  // One Save, in the header: off until something differs, and it saves the limits.
  const save = owner.getByRole("button", { name: "Save changes" });
  await expect(owner.getByRole("button", { name: /^Save/ })).toHaveCount(1);
  await expect(save).toBeDisabled();
  const hold = owner.getByRole("spinbutton", { name: "Hold before anything goes out" });
  await hold.fill("12");
  await expect(save).toBeEnabled();
  await hold.fill("24");
  await expect(save).toBeDisabled();
  // Out of range: the browser refuses it, and nothing is saved.
  await hold.fill("400");
  await save.click();
  expect(await hold.evaluate((field: HTMLInputElement) => field.validity.rangeOverflow)).toBe(true);
  await expect(owner.getByText("Autopilot's settings saved")).toHaveCount(0);
  // What only the server refuses is said under the rows, what was typed staying in them.
  await hold.fill("12");
  await owner.getByRole("spinbutton", { name: "A post has at least" }).fill("200000");
  await save.click();
  await expect(owner.getByText("How sure is 50 to 100%, people and views at least 1, and the hold 0 to 336 hours (two weeks)")).toBeVisible();
  await expect(hold).toHaveValue("12");
  await expect(save).toBeEnabled();
  await owner.getByRole("spinbutton", { name: "A post has at least" }).fill("40");
  await save.click();
  await expect(owner.getByText("Autopilot's settings saved")).toBeVisible();
  await expect(save).toBeDisabled();
  expect((await query(`SELECT "autopilotHoldHours" AS hold, "autopilotMaxReach" AS reach, "autopilotMinSure" AS sure, "autopilotMaxViews" AS views FROM project WHERE slug = $1`, [slug]))[0]).toEqual({
    hold: 12,
    reach: 40,
    sure: 95,
    views: 500,
  });

  // Emails: owners always; admins by a switch; anyone else on the team picked from Add, shown as a chip. Each saves at once.
  await expect(row("Owners")).toContainText("Always");
  await row("Owners").getByRole("button", { name: "More about this setting" }).click();
  await expect(owner.getByText(/^Owners always hear when something customers see goes out by itself\./)).toBeVisible();
  await owner.keyboard.press("Escape");
  const admins = owner.getByRole("switch", { name: "Admins", exact: true });
  await expect(admins).not.toBeChecked();
  await admins.focus();
  await owner.keyboard.press("Space");
  await expect(owner.getByText("Emails saved")).toBeVisible();
  await expect(admins).toBeChecked();
  await expect(admins).toBeFocused();
  const told = owner.getByRole("list", { name: "Others who get Autopilot's emails" });
  await expect(told.getByRole("listitem")).toHaveCount(0);
  const add = owner.getByRole("button", { name: "Add someone to Autopilot's emails" });
  await add.click();
  await expect(owner.getByRole("menuitem")).toHaveText(["Sam Rivera Admin", "Priya Shah Member"]);
  await owner.getByRole("menuitem", { name: /Priya Shah/ }).click();
  await expect(told.getByRole("listitem")).toHaveText(["Priya Shah"]);
  const recipients = async () =>
    (await query(`SELECT u.name FROM team_member m JOIN "user" u ON u.id = m."userId" JOIN project p ON p.id = m."projectId" WHERE p.slug = $1 AND m."autopilotTold" ORDER BY u.name`, [slug])).map(
      (found) => found.name,
    );
  await expect.poll(recipients).toEqual(["Priya Shah"]);
  await add.click();
  await owner.getByRole("menuitem", { name: /Sam Rivera/ }).click();
  await expect(told.getByRole("listitem")).toHaveText(["Sam Rivera", "Priya Shah"]);
  await expect.poll(recipients).toEqual(["Priya Shah", "Sam Rivera"]);
  // No one left to add: Add is off. Removing a chip saves too, and focus goes to Add, not to the top of the page.
  await expect(add).toBeDisabled();
  await told.getByRole("button", { name: "Remove Sam Rivera" }).click();
  await expect(told.getByRole("listitem")).toHaveText(["Priya Shah"]);
  await expect(add).toBeFocused();
  await expect(add).toBeEnabled();
  await expect.poll(recipients).toEqual(["Priya Shah"]);
  // The whole page in one picture: a window tall enough that the pane doesn't scroll.
  await owner.setViewportSize({ width: 1440, height: 1700 });
  await checkpoint(owner, "team-settings-autopilot-desktop");
  await owner.reload();
  await expect(admins).toBeChecked();
  await expect(told.getByRole("listitem")).toHaveText(["Priya Shah"]);
  await expect(hold).toHaveValue("12");
  // A save the server refuses (the owner stops being one) is said, and the chip comes back.
  await query(`UPDATE team_member SET role = 'ADMIN' WHERE "projectId" = (SELECT id FROM project WHERE slug = $1) AND role = 'OWNER'`, [slug]);
  await told.getByRole("button", { name: "Remove Priya Shah" }).click();
  await expect(owner.getByText("Only project owners can change Autopilot's settings")).toBeVisible();
  await expect(told.getByRole("listitem")).toHaveText(["Priya Shah"]);
  // An admin sees it all and changes none of it: no Save in the header, no Add, chips without their buttons.
  await owner.reload();
  await expect(owner.getByText("Only owners change Autopilot's settings. Admins can change its AI model and Checks.")).toBeVisible();
  await expect(hold).toBeDisabled();
  await expect(hold).toHaveValue("12");
  await expect(owner.getByRole("button", { name: /^Save/ })).toHaveCount(0);
  await expect(admins).toBeDisabled();
  await expect(told.getByRole("listitem")).toHaveText(["Priya Shah"]);
  await expect(add).toHaveCount(0);
  await expect(told.getByRole("button")).toHaveCount(0);
  await query(`UPDATE team_member SET role = 'OWNER' WHERE "projectId" = (SELECT id FROM project WHERE slug = $1) AND "userId" = (SELECT id FROM "user" WHERE email = $2)`, [slug, owner.email]);
  await owner.reload();
  await expect(hold).toBeEnabled();

  // On a phone nothing runs off the side (the pane's body or the page), each limit's field stays beside its label, so
  // the row still reads as a sentence, and the chips go under theirs.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => owner.locator('[data-slot="pane-body"]').last().evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(0);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  for (const [name] of limits) {
    const label = (await row(name).getByText(name, { exact: true }).boundingBox())!;
    const field = (await owner.getByRole("spinbutton", { name, exact: true }).boundingBox())!;
    expect(field.x).toBeGreaterThanOrEqual(label.x + label.width);
    expect(field.width).toBeGreaterThanOrEqual(100);
  }
  await checkpoint(owner, "team-settings-autopilot-phone");
  // The largest number each takes shows whole beside its unit, at a phone's larger type too.
  for (const [name, largest] of [
    ["It's less sure than", "100"],
    ["A post has at least", "100000"],
    ["An article has at least", "10000000"],
    ["Hold before anything goes out", "336"],
  ] as const) {
    const field = owner.getByRole("spinbutton", { name, exact: true });
    await field.fill(largest);
    expect(await field.evaluate((input: HTMLInputElement) => input.scrollWidth - input.clientWidth)).toBeLessThanOrEqual(0);
    expect(await field.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(true);
  }
  const others = (await row("Others").getByText("Others", { exact: true }).boundingBox())!;
  expect((await told.getByRole("listitem").first().boundingBox())!.y).toBeGreaterThanOrEqual(others.y + others.height);
  // The details of what's sent fit the phone's width.
  await owner.getByRole("button", { name: "See details" }).click();
  const details = (await owner.getByRole("dialog").boundingBox())!;
  expect(details.x).toBeGreaterThanOrEqual(0);
  expect(details.x + details.width).toBeLessThanOrEqual(390);
  await owner.keyboard.press("Escape");
});
