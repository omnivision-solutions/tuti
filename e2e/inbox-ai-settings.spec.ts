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

  // Instructions for drafts, with one Save.
  const instructions = owner.getByRole("textbox", { name: "Instructions for drafts" });
  await expect(instructions).toHaveValue("");
  await expect(instructions).toHaveAttribute("placeholder", "Keep replies short and friendly. End by asking whether that helped.");
  await instructions.fill(`End by asking whether that helped ${slug}.`);
  // Saved from the keyboard: focus stays on Save and the box keeps what was typed.
  await owner.keyboard.press("Tab");
  await owner.keyboard.press("Enter");
  await expect(owner.getByText("Instructions saved")).toBeVisible();
  await expect(owner.getByRole("button", { name: "Save", exact: true })).toBeFocused();
  await expect(instructions).toHaveValue(`End by asking whether that helped ${slug}.`);
  await checkpoint(owner, "team-settings-inbox-ai");
  await owner.reload();
  await expect(instructions).toHaveValue(`End by asking whether that helped ${slug}.`);
  // On a phone the page is no wider than the window.
  await owner.setViewportSize({ width: 360, height: 740 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await checkpoint(owner, "team-settings-inbox-ai-phone");
  await owner.setViewportSize({ width: 1440, height: 900 });

  // Their rows are gone from Settings → AI models.
  await owner.goto(`/app/${slug}/settings/ai-models`);
  await expect(owner.getByRole("radiogroup", { name: "Autopilot writes" })).toBeVisible();
  await expect(owner.getByRole("radiogroup", { name: /^Inbox/ })).toHaveCount(0);
  // Nor does that page say what level the Inbox is on (Best, here): its own page does.
  await expect(owner.locator("#ai-models-level")).toHaveCount(0);

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
