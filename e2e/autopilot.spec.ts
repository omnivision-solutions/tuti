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

  // Home's Catch up has it, and so does Autopilot, waiting for the team.
  await owner.goto(`/app/${slug}`);
  const catchUp = owner.getByRole("listitem").filter({ hasText: pr });
  await expect(catchUp).toContainText("3 to review");
  await checkpoint(owner, "home-catch-up");
  await owner.getByRole("link", { name: "Autopilot", exact: true }).click();
  await owner.waitForURL(`**/app/${slug}/autopilot`);
  await expect(owner.getByRole("heading", { name: "Autopilot" })).toBeVisible();
  await expect(owner.getByText("3 to review")).toBeVisible();
  // Its updates, in a line.
  await expect(owner.getByRole("listitem").filter({ hasText: pr })).toContainText(`Closes ${title} · updates 1 article · changelog line`);
  await checkpoint(owner, "autopilot");
  await owner.getByRole("link", { name: pr }).click();

  // Its page: what changed for users, why, and a card per update, the likely ones ticked.
  await expect(owner.getByRole("heading", { name: pr })).toBeVisible();
  await expect(owner.getByText(summary)).toBeVisible();
  await expect(owner.getByText("It ships the dark theme people asked for.")).toBeVisible();
  const closes = owner.getByRole("article", { name: `Closes the request: ${title}` });
  await expect(closes).toContainText("It adds the dark theme the post asks for.");
  await expect(closes).toContainText("Likely");
  await expect(closes).toContainText("Open → Completed");
  await expect(closes.getByRole("checkbox")).toBeChecked();
  const edit = owner.getByRole("article", { name: `Out of date: ${article}` });
  await expect(edit.getByRole("checkbox")).toBeChecked();
  await expect(edit).toContainText("It says Light is the only theme.");
  const changes = edit.getByLabel(`Changes to ${article}`);
  await expect(changes).toContainText("Pick Light, Dark or System in Settings.");
  // Formatted as readers see it: the new paragraph's bold is bold.
  await expect(changes.getByRole("insertion").locator("strong")).toHaveText("Dark");
  const line = owner.getByRole("article", { name: "Changelog line: Dark theme" });
  await expect(line.getByRole("checkbox")).toBeChecked();
  // One button says what approving does; beside it, the same in words.
  await expect(owner.getByRole("button", { name: "Approve 3 updates" })).toBeEnabled();
  await expect(owner.getByText("3 of 3 selected · publishes 1 article")).toBeVisible();
  await expect(owner.getByRole("region", { name: "When you approve" })).toContainText("1 article edit published");
  await checkpoint(owner, "autopilot-change");
  // The changelog line as the team words it (Edit), and the request left out for now.
  await line.getByRole("button", { name: "Edit" }).click();
  await line.getByRole("textbox", { name: "Changelog line" }).fill("A dark theme, in Settings");
  await closes.getByRole("checkbox").uncheck();
  await expect(owner.getByText("2 of 3 selected · publishes 1 article")).toBeVisible();
  await owner.getByRole("button", { name: "Approve 2 updates" }).click();
  // It asks first, saying what will happen.
  const confirm = owner.getByRole("alertdialog", { name: "Approve 2 updates?" });
  await expect(confirm).toContainText("1 article edit published. The changelog line updated (still a draft).");
  await confirm.getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByText("Approved 2 updates")).toBeVisible();
  await expect(owner.getByRole("alertdialog")).toHaveCount(0);
  const done = owner.getByRole("region", { name: "Done" });
  await expect(done.getByRole("listitem", { name: `Out of date: ${article}` })).toContainText("Approved by Olive Owner");
  await expect(done.getByRole("listitem", { name: "Changelog line: A dark theme, in Settings" })).toContainText("Approved by Olive Owner");
  // Then the request on its own: nothing's ticked until it is.
  await expect(owner.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await closes.getByRole("checkbox").check();
  await owner.getByRole("button", { name: "Approve 1 update" }).click();
  await owner.getByRole("alertdialog", { name: "Approve 1 update?" }).getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByText("Approved 1 update")).toBeVisible();
  await expect(done.getByRole("listitem", { name: `Closes the request: ${title}` })).toContainText("Approved by Olive Owner");
  const portalArticle = await owner.context().newPage();
  await portalArticle.goto(`${portalUrl(slug)}/docs/${articleSlug}`);
  await expect(portalArticle.getByText("Pick Light, Dark or System in Settings.")).toBeVisible();
  await portalArticle.close();

  // The post is completed, linked to the pull request, with the way back to Autopilot.
  await owner.goto(`/app/${slug}/p/1`);
  await expect(owner.getByRole("combobox", { name: "Status" })).toContainText("Completed");
  await expect(owner.getByRole("link", { name: `acme/app#${number} · ${pr}` })).toBeVisible();
  await owner.getByRole("link", { name: "From Autopilot" }).click();
  await expect(owner.getByRole("heading", { name: pr })).toBeVisible();
  // A change's old address (in webhooks already sent, and bookmarks) lands on it in Autopilot.
  const changePage = new URL(owner.url()).pathname;
  await owner.goto(changePage.replace("/autopilot/", "/code-changes/"));
  await owner.waitForURL(`**${changePage}`);
  await expect(owner.getByRole("heading", { name: pr })).toBeVisible();

  // A pull request users don't see: nothing to do, folded away, and "Analyse anyway" looks past the gate.
  const chore = `Refactor the theme store ${id}`;
  const choreSummary = `Nothing visible changed (${id}).`;
  await nextDecision({ audience: { users: 0.05, internal: 0.9, dependencies: 0.03, repository_docs: 0.02 } }, chore);
  await mergePullRequest(installationId, { number: number + 1, title: chore });
  // Its old address (Code changes) lands on Autopilot.
  await owner.goto(`/app/${slug}/code-changes`);
  await owner.waitForURL(`**/app/${slug}/autopilot`);
  await owner.getByText("Nothing to do (1)").click();
  const row = owner.getByRole("listitem").filter({ hasText: chore });
  await expect(row).toContainText("Only the team sees this: refactoring, tests, CI or tooling.");
  await checkpoint(owner, "autopilot-nothing-to-do");
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
  await expect(owner.getByText("Draft · collecting merged pull requests until a release or you publish it")).toBeVisible();
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

  await owner.goto(`/app/${slug}/autopilot`);
  await owner.getByRole("link", { name: pr }).click();
  const proposal = owner.getByRole("article", { name: `New article: ${draft}` });
  await expect(proposal).toContainText("Nothing explains exports yet.");
  await expect(proposal).toContainText("A draft only your team sees");
  // The draft as readers will see it: its heading, its list and its bold.
  const preview = proposal.getByLabel(`Draft of ${draft}`);
  await expect(preview.getByRole("heading", { name: "Export it" })).toBeVisible();
  await expect(preview.getByRole("listitem")).toHaveText(["Open Settings.", "Pick Export."]);
  await expect(preview.locator("strong")).toHaveText(["Settings", "Export"]);
  await checkpoint(owner, "autopilot-new-article");

  // From an email: `?select=likely` ticks the likely ones and says so; `?select=<ids>` only those (here, none).
  const page = owner.url();
  await owner.goto(`${page}?select=likely`);
  await expect(owner.getByText("From your email:")).toBeVisible();
  await expect(proposal.getByRole("checkbox")).toBeChecked();
  await owner.goto(`${page}?select=someone-else`);
  await expect(proposal.getByRole("checkbox")).not.toBeChecked();
  await expect(owner.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();

  // On a phone: the updates as a list, each preview a tap away, and the button at the bottom.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(page);
  await expect(preview).toBeHidden();
  await proposal.getByRole("button", { name: "Preview" }).click();
  await expect(preview.getByRole("heading", { name: "Export it" })).toBeVisible();
  const approve = owner.getByRole("button", { name: /^Approve \d/ });
  await expect(approve).toBeInViewport();
  await checkpoint(owner, "autopilot-phone", { fullPage: false });
});
