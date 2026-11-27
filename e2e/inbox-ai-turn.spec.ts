import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { query } from "./db";
import { APP_URL, SUPPORT_EMAIL_DOMAIN } from "./env";
import { apiFor, createProject, expectMoreView, signUp } from "./helpers";
import { rawEmail, receive } from "./inbound";
import { nextDecision, nextModelReply } from "./model";
import { similar } from "./openai";

// Wide enough for the Inbox's four panes: its views, the list, the conversation and its details.
test.use({ viewport: { width: 1440, height: 900 } });

test("an email the AI answers first: answered from the docs and kept from the team, then handed to it when the user asks for a person, with a summary, and the team replies", async ({ browser }, testInfo) => {
  // The AI's turn waits a few seconds for more messages, twice.
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const question = `How do I export my data from Acme ${slug}?`;
  const body = "Settings → Export downloads everything as CSV.";
  await similar(question, `Exporting\n\n${body}`, 0.8);
  const article = await api("/articles", { title: "Exporting", body });
  await api(`/articles/${article.slug}/publish`, {});
  await owner.goto(`/app/${slug}/settings/support`);
  await owner.getByRole("button", { name: "Get a support address" }).click();
  await expect(owner.getByRole("button", { name: "Copy support address" })).toBeVisible();
  // "AI answers first" for email: its switch is the AI's settings screen, still to come.
  await query(`UPDATE project SET "emailAiFirst" = true WHERE slug = $1`, [slug]);
  const sender = "Sam Sender <e2e-sam-ai-turn@example.com>";

  // Their question: not a request for a person, and the docs answer it.
  await nextDecision({ person: 0.05 }, question);
  await nextModelReply(JSON.stringify({ answer: "Go to Settings → Export: it downloads everything as CSV.", sources: ["s1"] }), question);
  await receive(`support@${slug}.${SUPPORT_EMAIL_DOMAIN}`, rawEmail(sender, "Exporting", question));

  const messages = owner.getByRole("list", { name: "Messages" }).getByRole("listitem");
  const meta = owner.locator(".inbox-conversation-meta");
  // The AI answers once the request has answered and its few seconds' wait is over.
  await expect(async () => {
    await owner.goto(`/app/${slug}/inbox/1?view=ai`);
    await expect(messages).toHaveCount(2, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(messages.nth(0)).toContainText(question);
  await expect(messages.nth(1)).toContainText("Go to Settings → Export: it downloads everything as CSV.");
  await expect(messages.nth(1)).toContainText("Sources: Exporting");
  await expect(meta.getByText("With AI", { exact: true })).toBeVisible();
  // Not the team's: out of Needs reply.
  await expectMoreView(owner, "With AI 1");
  await checkpoint(owner, "answered-by-the-ai");

  // "A person please": handed to the team, with the AI's summary for them.
  const [{ replyToken }] = await query(`SELECT c."replyToken" FROM conversation c JOIN project p ON p.id = c."projectId" WHERE p.slug = $1 AND c.number = 1`, [slug]);
  const asked = `A person please, about ${slug}`;
  await nextDecision({ person: 0.95 }, asked);
  await nextModelReply("They want a person to help them export their data.", asked);
  await receive(`support+${replyToken}@${slug}.${SUPPORT_EMAIL_DOMAIN}`, rawEmail(sender, "Re: Exporting", asked));
  await expect(async () => {
    await owner.goto(`/app/${slug}/inbox/1`);
    await expect(messages).toHaveCount(4, { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(messages.nth(2)).toContainText(asked);
  await expect(messages.nth(3)).toContainText("Internal note · AI");
  await expect(messages.nth(3)).toContainText("Summary: They want a person to help them export their data.");
  await expect(meta.locator(".inbox-conversation-state")).toHaveText("Needs reply");
  await expectMoreView(owner, "Needs reply 1");
  await checkpoint(owner, "handed-to-the-team");

  // The team's reply: theirs, with the reply box as on any conversation.
  await owner.getByRole("textbox", { name: "Reply" }).fill("Hi Sam, I'll walk you through it.");
  await owner.getByRole("button", { name: "Send", exact: true }).click();
  await expect(owner.getByText("Sent", { exact: true })).toBeVisible();
  await expect(messages.nth(4)).toContainText("Hi Sam, I'll walk you through it.");
  await expect(meta.locator(".inbox-conversation-state")).toHaveText("Waiting on user");
  await expect(meta.getByText("With AI", { exact: true })).toHaveCount(0);
});
