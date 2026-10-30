import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { connectGithub, mergePullRequest } from "./github";
import { apiFor, createProject, signUp } from "./helpers";
import { nextDecision, nextModelReply } from "./model";
import { similar } from "./openai";

test("a merged pull request becomes a code change; the team completes the post it resolves and publishes the article edit", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
  // Its own pull request numbers: GitHub (the fake) is shared by every journey.
  const number = randomInt(1_000, 1_000_000);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const title = `Dark mode ${id}`;
  await api("/posts", { board: "feature-requests", title });
  const article = `Change the theme ${id}`;
  const { slug: articleSlug } = await api("/articles", { title: article, body: "Pick Light in Settings." });
  await api(`/articles/${articleSlug}/publish`, {});
  const installationId = await connectGithub(owner, slug);

  // The pull request: users see it (the gate), its summary finds the post, which it resolves.
  const pr = `Add a dark theme ${id}`;
  const summary = `You can now switch to a dark theme in Settings (${id}).`;
  await similar(summary, title, 0.95);
  // The article's one section, as it's embedded: its title, then its text.
  await similar(summary, `${article}\n\nPick Light in Settings.`, 0.9);
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
  await nextModelReply(summary, pr);
  await nextDecision({ effect: { resolves: 0.9, moves_forward: 0.05, related: 0.04, unrelated: 0.01 } }, title);
  // (The new-article question lists the article's title too, so this one matches the article itself.)
  await nextDecision({ effect: { wrong: 0.9, missing: 0.05, unaffected: 0.05 } }, `"article":{"title":"${article}"`);
  await nextDecision({ needed: 0.1 }, `${summary}","existing_articles`);
  await nextModelReply(JSON.stringify({ why: "It ships the dark theme people asked for.", changelog: "Dark theme", proposals: { p2: { reason: "It adds the dark theme the post asks for." } } }), title);
  await nextModelReply(JSON.stringify({ reason: "It says Light is the only theme.", sections: { "1": "Pick Light, **Dark** or System in Settings." } }), article);
  await mergePullRequest(installationId, { number, title: pr, files: [{ filename: "src/theme.css", patch: "+.dark { --background: #111; }" }] });

  // Home's Catch up has it, and so does Code changes, waiting for the team.
  await owner.goto(`/app/${slug}`);
  const catchUp = owner.getByRole("listitem").filter({ hasText: pr });
  await expect(catchUp).toContainText("3 to review");
  await checkpoint(owner, "home-catch-up");
  await owner.getByRole("link", { name: "Code changes" }).click();
  await owner.waitForURL(`**/app/${slug}/code-changes`);
  await expect(owner.getByText("3 to review")).toBeVisible();
  await checkpoint(owner, "code-changes");
  await owner.getByRole("link", { name: pr }).click();

  // Its page: what changed for users, why, and the post it resolves.
  await expect(owner.getByRole("heading", { name: pr })).toBeVisible();
  await expect(owner.getByText(summary)).toBeVisible();
  await expect(owner.getByText("It ships the dark theme people asked for.")).toBeVisible();
  const proposal = owner.getByRole("listitem", { name: `Resolves: ${title}` });
  await expect(proposal).toContainText("It adds the dark theme the post asks for.");
  await expect(proposal).toContainText("Likely");
  await checkpoint(owner, "code-change");
  await proposal.getByRole("button", { name: "Mark completed" }).click();
  await expect(owner.getByText("#1 completed")).toBeVisible();
  await expect(proposal).toContainText("Applied by Olive Owner");

  // The changelog line replaces the pull request's bullet in the Next release draft, as the team words it.
  const line = owner.getByRole("textbox", { name: "Changelog line" });
  await expect(line).toHaveValue("Dark theme");
  await line.fill("A dark theme, in Settings");
  await owner.getByRole("button", { name: "Update changelog" }).click();
  await expect(owner.getByText("Changelog updated")).toBeVisible();
  await expect(owner.getByLabel("Changelog proposal")).toContainText("Applied by Olive Owner");
  await expect(owner.getByLabel("Changelog proposal")).toContainText("A dark theme, in Settings");

  // The article's edit, as a diff against what's published, goes live as a new version.
  const edit = owner.getByRole("listitem", { name: `Updated: ${article}` });
  await expect(edit).toContainText("It says Light is the only theme.");
  const changes = edit.getByRole("region", { name: `Changes to ${article}` }).or(edit.getByLabel(`Changes to ${article}`));
  await expect(changes).toContainText("Pick Light, Dark or System in Settings.");
  // Formatted as readers see it: the new paragraph's bold is bold.
  await expect(changes.getByRole("insertion").locator("strong")).toHaveText("Dark");
  await checkpoint(owner, "code-change-docs");
  await edit.getByRole("button", { name: "Publish edit" }).click();
  await expect(owner.getByText(`${article} updated`)).toBeVisible();
  await expect(edit).toContainText("Applied by Olive Owner");
  const portalArticle = await owner.context().newPage();
  await portalArticle.goto(`${portalUrl(slug)}/docs/${articleSlug}`);
  await expect(portalArticle.getByText("Pick Light, Dark or System in Settings.")).toBeVisible();
  await portalArticle.close();

  // The post is completed, linked to the pull request, with the way back to the code change.
  await proposal.getByRole("link", { name: title }).click();
  await owner.waitForURL(`**/app/${slug}/p/1`);
  await expect(owner.getByRole("combobox", { name: "Status" })).toContainText("Completed");
  await expect(owner.getByRole("link", { name: `acme/app#${number} · ${pr}` })).toBeVisible();
  await owner.getByRole("link", { name: "Code change", exact: true }).click();
  await expect(owner.getByRole("heading", { name: pr })).toBeVisible();

  // A pull request users don't see: nothing to do, folded away, and "Analyse anyway" looks past the gate.
  const chore = `Refactor the theme store ${id}`;
  const choreSummary = `Nothing visible changed (${id}).`;
  await nextDecision({ audience: { users: 0.05, internal: 0.9, dependencies: 0.03, repository_docs: 0.02 } }, chore);
  await mergePullRequest(installationId, { number: number + 1, title: chore });
  await owner.goto(`/app/${slug}/code-changes`);
  await owner.getByText("Nothing to do (1)").click();
  const row = owner.getByRole("listitem").filter({ hasText: chore });
  await expect(row).toContainText("Only the team sees this: refactoring, tests, CI or tooling.");
  await checkpoint(owner, "code-changes-nothing-to-do");
  // The post is completed now and the article is unaffected: only its changelog line is left to review.
  await similar(choreSummary, `${article}\n\nPick Light, Dark or System in Settings.`, 0.5);
  await nextModelReply(choreSummary, chore);
  await nextDecision({ effect: { wrong: 0.01, missing: 0.01, unaffected: 0.98 } }, `"article":{"title":"${article}"`);
  await nextDecision({ needed: 0.05 }, `${choreSummary}","existing_articles`);
  await nextModelReply(JSON.stringify({ why: "", changelog: "A tidier theme store", proposals: {} }), chore);
  await row.getByRole("button", { name: "Analyse anyway" }).click();
  await expect(owner.getByText("Analysed", { exact: true })).toBeVisible();
  await expect(owner.getByText("Nothing to do (1)")).toHaveCount(0);
  await expect(owner.getByRole("listitem").filter({ hasText: chore })).toContainText("1 to review");

  // The changelog's draft has the line the team wrote, and not the pull request users don't see.
  await owner.goto(`/app/${slug}/changelog/1`);
  // A fact under its title (no sentence): what the draft is doing.
  await expect(owner.getByText("Draft · collecting merged pull requests until the next release")).toBeVisible();
  await expect(owner.getByText("A dark theme, in Settings")).toBeVisible();
  await expect(owner.getByText(chore)).toHaveCount(0);
});

test("a pull request that needs a new article: its draft shows formatted, as readers will see it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
  const number = randomInt(1_000, 1_000_000);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const installationId = await connectGithub(owner, slug);

  const pr = `Add exports ${id}`;
  const summary = `You can now export your feedback as a CSV file (${id}).`;
  const draft = `Export your feedback ${id}`;
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
  await nextModelReply(summary, pr);
  await nextDecision({ needed: 0.9 }, `${summary}","existing_articles`);
  await nextModelReply(
    JSON.stringify({ title: draft, reason: "Nothing explains exports yet.", notes: "## Export it\n\n- Open **Settings**.\n- Pick **Export**." }),
    `${summary}",\n "existing_articles"`,
  );
  await nextModelReply(JSON.stringify({ why: "", changelog: "Feedback exports", proposals: {} }), pr);
  await mergePullRequest(installationId, { number, title: pr });

  await owner.goto(`/app/${slug}/code-changes`);
  await owner.getByRole("link", { name: pr }).click();
  const proposal = owner.getByRole("listitem", { name: `New: ${draft}` });
  await expect(proposal).toContainText("Nothing explains exports yet.");
  // The draft as readers will see it: its heading, its list and its bold.
  const preview = proposal.getByLabel(`Draft of ${draft}`);
  await expect(preview.getByRole("heading", { name: "Export it" })).toBeVisible();
  await expect(preview.getByRole("listitem")).toHaveText(["Open Settings.", "Pick Export."]);
  await expect(preview.locator("strong")).toHaveText(["Settings", "Export"]);
  await checkpoint(owner, "code-change-new-article");
});
