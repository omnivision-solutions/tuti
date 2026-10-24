import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { grantCredits, spendCredits } from "./credits";
import { APP_URL, portalUrl } from "./env";
import { connectGithub, mergePullRequest } from "./github";
import { apiFor, createProject, signUp } from "./helpers";
import { nextDecision } from "./model";
import { similar } from "./openai";

test("out of AI credits, each feature pauses its own way; with credits again, a paused code change resumes", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const question = `How do I add a colleague (${id})?`;
  const body = "Owners and admins send invites from the Team page.";
  await similar(question, `Inviting your team\n\n${body}`, 0.8);
  const article = await api("/articles", { title: "Inviting your team", body });
  await api(`/articles/${article.slug}/publish`, {});
  const entry = await api("/changelog", { title: "Next release", body: "Dark mode is here." });
  const installationId = await connectGithub(owner, slug);
  await spendCredits(slug);

  // A visitor's question: no AI answer, the closest article instead.
  const visitor = await signUp(browser, portalUrl(slug), "Vera Visitor");
  await visitor.goto("/docs");
  await visitor.getByRole("banner").getByRole("button", { name: "Search the docs" }).click();
  const box = visitor.getByRole("dialog").getByRole("combobox", { name: "Search the docs" });
  await box.fill(question);
  await expect(visitor.getByRole("dialog").getByRole("option").first()).toContainText("Ask AI:");
  await box.press("Enter");
  const conversation = visitor.getByRole("dialog", { name: "Assistant" }).getByRole("log", { name: "Conversation" });
  await expect(conversation.getByText("AI answers aren't available right now.")).toBeVisible();
  await expect(conversation.getByRole("link", { name: "Inviting your team" })).toBeVisible();
  await expect(conversation.getByRole("link", { name: "Post this as feedback" })).toBeVisible();
  await checkpoint(visitor, "portal-assistant-out-of-credits", { fullPage: false });

  // The changelog's AI: shown, disabled, and why.
  await owner.goto(`/app/${slug}/changelog/${entry.number}`);
  await expect(owner.getByRole("alert").filter({ hasText: "This project is out of AI credits" })).toContainText("Draft with AI and Edit with AI are paused");
  await expect(owner.getByRole("button", { name: "Draft with AI" })).toBeDisabled();
  await expect(owner.getByRole("button", { name: "Edit with AI" })).toBeDisabled();
  await checkpoint(owner, "team-changelog-out-of-credits");

  // A merge waits, paused, for the team to resume it.
  const number = randomInt(1_000, 1_000_000);
  const pr = `Add a dark theme ${id}`;
  await mergePullRequest(installationId, { number, title: pr, files: [{ filename: "src/theme.css", patch: "+.dark { --background: #111; }" }] });
  await owner.goto(`/app/${slug}/code-changes`);
  const row = owner.getByRole("listitem").filter({ hasText: pr });
  await expect(row).toContainText("Paused");
  await expect(row).toContainText("The project ran out of AI credits.");
  await checkpoint(owner, "code-changes-paused");
  await row.getByRole("button", { name: "Resume" }).click();
  await expect(owner.getByText("This project is out of AI credits. See Settings → Billing.")).toBeVisible();

  // Home says so, and lists what's paused.
  await owner.goto(`/app/${slug}`);
  await expect(owner.getByRole("alert").filter({ hasText: "This project is out of AI credits" })).toContainText(
    "AI answers, changelog drafts and code changes are paused",
  );
  await expect(owner.getByRole("listitem").filter({ hasText: pr })).toContainText("Paused");
  await checkpoint(owner, "home-paused");

  // The operator gives the project credits; Resume all on Home analyses it.
  expect(await grantCredits(slug, 50)).toBe(`grant: 50 credits for ${slug}, for good`);
  await owner.goto(`/app/${slug}/settings/billing`);
  await expect(owner.getByRole("table", { name: "AI credits left" }).getByRole("row", { name: /Given by Tuti/ })).toContainText("Never");
  await nextDecision({ audience: { users: 0.05, internal: 0.9, dependencies: 0.03, repository_docs: 0.02 } }, pr);
  await owner.goto(`/app/${slug}`);
  await expect(owner.getByRole("alert").filter({ hasText: "This project is out of AI credits" })).toHaveCount(0);
  await owner.getByRole("button", { name: "Resume all" }).click();
  await expect(owner.getByText("Resumed")).toBeVisible();
  // Home reads it again by itself: nothing is paused now.
  await expect(owner.getByText("Merged pull requests not analysed yet")).toHaveCount(0);
  await expect(owner.getByRole("button", { name: "Resume all" })).toHaveCount(0);
  await owner.goto(`/app/${slug}/code-changes`);
  await expect(owner.getByText(/^Nothing to do \(1\)$/)).toBeVisible();
});
