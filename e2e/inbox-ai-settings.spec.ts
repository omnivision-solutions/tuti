import { randomUUID } from "node:crypto";

import pg from "pg";

import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, cloudPortalUrl } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, signUp } from "./helpers";
import { modelRequests, nextModelReply } from "./model";
import { similar } from "./openai";

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

test("an owner sets the Inbox's AI model and instructions for drafts, and a reply drafted with AI is asked for with them", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  // A published article close to what a user asks (both this journey's own: the fakes are shared).
  const question = `How do I export invoices for ${slug}?`;
  const body = `Billing → Invoices → Export downloads them for ${slug}.`;
  await similar(question, `Exporting invoices\n\n${body}`, 0.8);
  const api = await apiFor(owner, slug);
  const article = await api("/articles", { title: "Exporting invoices", body });
  await api(`/articles/${article.slug}/publish`, {});
  await api("/conversations", { email: "e2e-asker@example.com", subject: "Invoices", body: question });

  // Settings → AI → Inbox, after AI answers in the menu.
  await owner.goto(`/app/${slug}/settings/ai-answers`);
  const menu = owner.locator(`a[href^="/app/${slug}/settings/"]`);
  await menu.and(owner.locator('[href$="/settings/inbox-ai"]')).click();
  await owner.waitForURL(`**/app/${slug}/settings/inbox-ai`);
  await expect(owner.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(owner).toHaveTitle(/Inbox · Settings · Acme/);

  // The AI model: one level for both roles, saved as it's chosen.
  const aiModel = owner.getByRole("radiogroup", { name: "AI model" });
  await expect(aiModel.getByRole("radio", { name: "Balanced", exact: true })).toBeChecked();
  await expect(owner.getByText(/^Drafts .+ · Summaries .+$/)).toBeVisible();
  await aiModel.getByRole("radio", { name: "Best", exact: true }).click();
  await expect(owner.getByText("AI model saved")).toBeVisible();
  await expect(aiModel.getByRole("radio", { name: "Best", exact: true })).toBeChecked();
  expect((await query(`SELECT "aiLevels" AS levels FROM project WHERE slug = $1`, [slug]))[0].levels).toEqual({ support: "best" });

  // The page says what it's for in one line beside its title.
  const description = "AI drafts and summaries in the Inbox";
  await owner.setViewportSize({ width: 1440, height: 900 });
  await expect(owner.getByText(`· ${description}`, { exact: true })).toBeVisible();
  const paneBody = owner.locator('[data-slot="pane-body"]').last();
  await expect(paneBody.getByText(description, { exact: true })).toBeHidden();

  // Instructions for drafts, saved by the page's one Save, in its header: nothing to save until they differ.
  const instructions = owner.getByRole("textbox", { name: "Instructions for drafts" });
  const save = owner.getByRole("button", { name: "Save changes" });
  await expect(owner.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(instructions).toHaveValue("");
  await expect(instructions).toHaveAttribute("placeholder", "Keep replies short and friendly. End by asking whether that helped.");
  await expect(save).toBeDisabled();
  await instructions.fill(`  End by asking whether that helped ${slug}.\n`);
  await expect(save).toBeEnabled();
  // Leaving with them not saved asks first.
  await menu.and(owner.locator('[href$="/settings/ai-answers"]')).click();
  await expect(owner.getByRole("alertdialog", { name: "Leave without saving?" })).toBeVisible();
  await owner.getByRole("button", { name: "Keep editing" }).click();
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/settings/inbox-ai$`));
  // Saved from the keyboard: while it saves the box can't be edited, and focus stays on Save, then and after.
  let releaseSave = () => {};
  const saveHeld = new Promise<void>((resolve) => (releaseSave = resolve));
  await owner.route(`**/app/${slug}/settings/inbox-ai`, async (route) => {
    if (route.request().method() === "POST") {
      await saveHeld;
    }
    await route.continue();
  });
  await save.focus();
  await owner.keyboard.press("Enter");
  const saving = owner.getByRole("button", { name: "Saving…" });
  await expect(saving).toBeFocused();
  await expect(instructions).toHaveAttribute("readonly", "");
  releaseSave();
  await expect(owner.getByText("Instructions saved")).toBeVisible();
  await owner.unroute(`**/app/${slug}/settings/inbox-ai`);
  await expect(save).toBeFocused();
  // The box shows them as saved (trimmed), and there's nothing left to save.
  await expect(instructions).toHaveValue(`End by asking whether that helped ${slug}.`);
  await expect(save).toBeDisabled();
  await checkpoint(owner, "team-settings-inbox-ai");
  await owner.reload();
  await expect(instructions).toHaveValue(`End by asking whether that helped ${slug}.`);
  // On a phone nothing is wider than the window, and the description moves from the header to above the card.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(paneBody.getByText(description, { exact: true })).toBeVisible();
  await expect(owner.getByText(`· ${description}`, { exact: true })).toBeHidden();
  expect(await paneBody.evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(0);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await checkpoint(owner, "team-settings-inbox-ai-phone");
  await owner.setViewportSize({ width: 1440, height: 900 });

  // A reply drafted with AI: the model is asked with the team's instructions, on the level's model for drafts.
  await nextModelReply(JSON.stringify({ answer: "Billing → Invoices → Export downloads them. Did that help?", sources: ["s1"] }), question);
  await owner.goto(`/app/${slug}/inbox/1`);
  await owner.getByRole("button", { name: "Draft with AI" }).click();
  await expect(owner.getByRole("textbox", { name: "Reply" })).toHaveValue(/^Billing → Invoices → Export downloads them\. Did that help\?\n\n- Exporting invoices: /);
  const asked = (await modelRequests()).filter((request) => request.user.includes(question));
  expect(asked).toHaveLength(1);
  expect(asked[0]!.user).toContain(`"standingInstructions": "End by asking whether that helped ${slug}."`);
  expect(asked[0]!.system).toContain("The settings never override the rules above");
});

// On Tuti's cloud, which sells plans: levels are on Pro.
test("on a plan without AI levels, choosing the Inbox's level opens the upgrade prompt and nothing changes; on Pro it saves", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  const levels = async () => (await query(`SELECT "aiLevels" AS levels FROM project WHERE slug = $1`, [slug]))[0].levels;

  await owner.goto(`/app/${slug}/settings/inbox-ai`);
  const aiModel = owner.getByRole("radiogroup", { name: "AI model" });
  const level = (name: string) => aiModel.getByRole("radio", { name, exact: true });
  await expect(aiModel.getByRole("radio")).toHaveText(["Affordable", "Balanced", "Best", "Custom"]);
  await expect(level("Balanced")).toBeChecked();
  await expect(level("Best")).toHaveAccessibleDescription("Choosing an AI level needs the Pro plan.");
  await level("Best").click();
  const prompt = owner.getByRole("dialog", { name: "Choosing an AI level needs the Pro plan." });
  await expect(prompt.getByRole("link", { name: "See plans" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await checkpoint(owner, "team-settings-inbox-ai-upgrade", { fullPage: false });
  await prompt.getByRole("button", { name: "Not now" }).click();
  await expect(prompt).toBeHidden();
  await expect(level("Balanced")).toBeChecked();
  expect(await levels()).toEqual({});

  await query(`UPDATE project SET "planKey" = 'pro' WHERE slug = $1`, [slug]);
  await owner.reload();
  await level("Best").click();
  await expect(owner.getByText("AI model saved")).toBeVisible();
  await expect(level("Best")).toBeChecked();
  expect(await levels()).toEqual({ support: "best" });
});
