import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { connectGithub, mergePullRequest } from "./github";
import { runAutopilot } from "./autopilot";
import { latestEmailTo } from "./mail";
import { apiFor, createProject, signUp } from "./helpers";
import { nextDecision, nextModelReply } from "./model";
import { similar } from "./openai";

// One at a time: runAutopilot runs Autopilot's minute for every project, so a journey beside
// another here would publish what that one is still looking at.
test.describe.configure({ mode: "default" });

test("a merged pull request becomes a code change; the team completes the post it resolves and publishes the article edit", async ({ browser }, testInfo) => {
  // Two pull requests, three approvals and the post and article checked: longer than most.
  test.setTimeout(60_000);
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
  // 92% sure it's wrong: under the bar (95%), so the edit waits for the team (and above the request's 90%, so it's p1, the post p2).
  await nextDecision({ effect: { wrong: 0.87, missing: 0.05, unaffected: 0.08 } }, `"article":{"title":"${article}"`);
  await nextDecision({ needed: 0.1 }, `${summary}","existing_articles`);
  await nextModelReply(JSON.stringify({ why: "It ships the dark theme people asked for.", changelog: "Dark theme", proposals: { p2: { reason: "It adds the dark theme the post asks for." } } }), title);
  await nextModelReply(JSON.stringify({ reason: "It says Light is the only theme.", sections: { "1": "Pick Light, **Dark** or System in Settings." } }), article);
  await mergePullRequest(installationId, { number, title: pr, files: [{ filename: "src/theme.css", patch: "+.dark { --background: #111; }" }] });

  // Home's "Needs your attention" has it, with Review: two updates wait for the team (not 95% sure, and
  // completing a post asks first). The changelog line was written into the running draft by itself: it never waits.
  await owner.goto(`/app/${slug}`);
  const catchUp = owner.getByRole("listitem").filter({ hasText: pr });
  await expect(catchUp).toContainText(`${pr} · 2 updates`);
  await expect(catchUp).not.toContainText("goes out");
  await expect(catchUp.getByRole("link", { name: "Review" })).toBeVisible();
  await expect(owner.getByRole("link", { name: /^2\s*Updates waiting$/ })).toBeVisible();
  await checkpoint(owner, "home-catch-up");
  await owner.getByRole("link", { name: "Autopilot", exact: true }).click();
  await owner.waitForURL(`**/app/${slug}/autopilot`);
  await expect(owner.getByRole("heading", { name: "Autopilot" })).toBeVisible();
  const list = owner.getByRole("complementary", { name: "Changes" });
  await expect(list.getByRole("tab", { name: "To review 2" })).toHaveAttribute("aria-selected", "true");
  // By what it updates: Feedback (the post it completes), then Help center (the article it edits). A row is the post's
  // or article's title, its badge, and its pull requests as chips; its ring picks it, to approve with others.
  const postRow = list.getByRole("region", { name: "Feedback" }).getByRole("listitem").filter({ hasText: title });
  await expect(postRow).toContainText("Completing");
  // A chip's name is what it shows, then the pull request's title.
  const chipName = `PR #${number}: ${pr}`;
  await expect(postRow.getByRole("button", { name: chipName })).toBeVisible();
  await expect(postRow.getByRole("checkbox", { name: `Select ${title}` })).toHaveAccessibleDescription("Likely: 90% sure on average");
  const articleRow = list.getByRole("region", { name: "Help center" }).getByRole("listitem").filter({ hasText: article });
  await expect(articleRow).toContainText("Updated");
  await checkpoint(owner, "autopilot");
  // A chip shows its pull request on hover: its title, who merged it and when, GitHub, its activity page.
  const chip = articleRow.getByRole("button", { name: chipName });
  await chip.hover();
  const card = owner.getByRole("dialog").filter({ hasText: pr });
  await expect(card).toContainText(`octo · merged`);
  await expect(card.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute("href", `https://github.com/acme/app/pull/${number}`);
  await expect(card.getByRole("link", { name: "Its activity" })).toBeVisible();
  await checkpoint(owner, "autopilot-chip", { fullPage: false });
  await owner.mouse.move(900, 600);
  await expect(card).toBeHidden();
  // And from the keyboard.
  await chip.focus();
  await owner.keyboard.press("Enter");
  await expect(card).toBeVisible();
  await owner.keyboard.press("Escape");
  await expect(card).toBeHidden();

  // The article's review, beside the list (which marks it): its pull requests' chips, what changed for users and why,
  // then its update, ticked.
  await list.getByRole("link", { name: article }).click();
  await expect(owner.getByRole("heading", { name: article, level: 1 })).toBeVisible();
  await expect(list.getByRole("link", { name: article })).toHaveAttribute("aria-current", "page");
  await expect(owner.getByRole("list", { name: "Pull requests" }).getByRole("button", { name: `PR #${number} octo merged just now: ${pr}` })).toBeVisible();
  const overview = owner.getByRole("region", { name: "Overview" });
  await expect(overview).toContainText(summary);
  await expect(overview).toContainText("It ships the dark theme people asked for.");
  const edit = owner.getByRole("article", { name: `Out of date: ${article}` });
  await expect(edit.getByRole("checkbox")).toBeChecked();
  await expect(edit).toContainText("It says Light is the only theme.");
  const changes = edit.getByLabel(`Changes to ${article}`);
  await expect(changes).toContainText("Pick Light, Dark or System in Settings.");
  // Formatted as readers see it: the new paragraph's bold is bold.
  await expect(changes.getByRole("insertion").locator("strong")).toHaveText("Dark");
  await expect(owner.getByText("1 of 1 selected · publishes 1 article")).toBeVisible();
  await checkpoint(owner, "autopilot-article");
  // Approved from the list (its ring picks it, with any others): what's ticked on its page.
  await articleRow.getByRole("checkbox", { name: `Select ${article}` }).click();
  await expect(list.getByText("1 selected")).toBeVisible();
  await list.getByRole("button", { name: "Approve", exact: true }).click();
  // It asks first, saying what will happen.
  const confirm = owner.getByRole("alertdialog", { name: "Approve 1 update on 1 page?" });
  await expect(confirm).toContainText("1 article edit published");
  await confirm.getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByText("Approved 1 update")).toBeVisible();

  // Nothing of it waits now: the post opens by itself, its update ticked.
  await expect(owner.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(list.getByRole("tab", { name: "To review 1" })).toHaveAttribute("aria-selected", "true");
  const closes = owner.getByRole("article", { name: `Closes the request: ${title}` });
  await expect(closes).toContainText("It adds the dark theme the post asks for.");
  await expect(closes.getByRole("img", { name: "Likely: 90% sure" })).toBeVisible();
  await expect(closes).toContainText("Open → Completed");
  await expect(closes.getByRole("checkbox")).toBeChecked();
  await checkpoint(owner, "autopilot-post");
  await owner.getByRole("button", { name: "Approve 1 update" }).click();
  await owner.getByRole("alertdialog", { name: "Approve 1 update?" }).getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByText("Approved 1 update")).toBeVisible();
  const done = owner.getByRole("region", { name: "Done" });
  await expect(done.getByRole("listitem", { name: `Closes the request: ${title}` })).toContainText("Approved by Olive Owner");
  // Nothing waits for the team now: it moves to Reviewed by itself, and stays open (there's no other to review).
  await expect(list.getByRole("tab", { name: "Reviewed" })).toHaveAttribute("aria-selected", "true");
  await expect(list.getByRole("link", { name: title })).toHaveAttribute("aria-current", "page");
  await expect(list.getByRole("region", { name: "Help center" }).getByRole("link", { name: article })).toBeVisible();
  await list.getByRole("tab", { name: "To review 0" }).click();
  await expect(list.getByText("Nothing to review")).toBeVisible();
  await list.getByRole("tab", { name: "Reviewed" }).click();
  await checkpoint(owner, "autopilot-reviewed");
  const portalArticle = await owner.context().newPage();
  await portalArticle.goto(`${portalUrl(slug)}/docs/${articleSlug}`);
  await expect(portalArticle.getByText("Pick Light, Dark or System in Settings.")).toBeVisible();
  await portalArticle.close();

  // The post is completed, linked to the pull request, with the way back to its activity in Autopilot.
  await owner.goto(`/app/${slug}/p/1`);
  await expect(owner.getByRole("combobox", { name: "Status" })).toContainText("Completed");
  await expect(owner.getByRole("link", { name: `acme/app#${number} · ${pr}` })).toBeVisible();
  await owner.getByRole("link", { name: "From Autopilot" }).click();
  // Its activity: the pull request, what changed and (folded away) why, then what it touched, each opening its review.
  await expect(owner.getByRole("heading", { name: pr, level: 1 })).toBeVisible();
  await expect(list.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  await expect(owner.getByText(summary)).toBeVisible();
  await expect(owner.getByText("It ships the dark theme people asked for.")).toBeHidden();
  await owner.getByText("Why Autopilot made this change").click();
  await expect(owner.getByText("It ships the dark theme people asked for.")).toBeVisible();
  const touched = owner.getByRole("region", { name: "Review changes" });
  await expect(touched.getByRole("region", { name: "Help center" }).getByRole("link", { name: new RegExp(article) })).toContainText("Approved");
  await expect(touched.getByRole("region", { name: "Help center" })).toContainText("No collection");
  const touchedPost = touched.getByRole("region", { name: "Feedback" }).getByRole("link", { name: new RegExp(title) });
  await expect(touchedPost).toContainText("Completing");
  await expect(touched).toContainText("Its line in the changelog is in Next release.");
  await checkpoint(owner, "autopilot-activity");
  // A change's old addresses (in emails and webhooks already sent, and bookmarks) land on its activity.
  const activityPage = new URL(owner.url()).pathname;
  for (const old of [activityPage.replace("/activity/", "/"), activityPage.replace("/autopilot/activity/", "/code-changes/")]) {
    await owner.goto(old);
    await owner.waitForURL(`**${activityPage}`);
  }
  await touchedPost.click();
  await expect(owner.getByRole("heading", { name: title, level: 1 })).toBeVisible();

  // A pull request users don't see: nothing to do, folded away in Activity, and "Analyse anyway" looks past the gate.
  const chore = `Refactor the theme store ${id}`;
  const choreSummary = `Nothing visible changed (${id}).`;
  await nextDecision({ audience: { users: 0.05, internal: 0.9, dependencies: 0.03, repository_docs: 0.02 } }, chore);
  await mergePullRequest(installationId, { number: number + 1, title: chore });
  // Its old address (Code changes) lands on Autopilot.
  await owner.goto(`/app/${slug}/code-changes`);
  await owner.waitForURL(`**/app/${slug}/autopilot`);
  await list.getByRole("tab", { name: "Activity" }).click();
  await owner.getByText("Nothing to do (1)").click();
  const row = owner.getByRole("listitem").filter({ hasText: chore });
  await expect(row).toContainText("Only the team sees this: refactoring, tests, CI or tooling.");
  await checkpoint(owner, "autopilot-nothing-to-do");
  // The post is completed now and the article is unaffected: only its changelog line is left, written by itself.
  await similar(choreSummary, `${article}\n\nPick Light, Dark or System in Settings.`, 0.5);
  await nextModelReply(choreSummary, chore);
  await nextDecision({ effect: { wrong: 0.01, missing: 0.01, unaffected: 0.98 } }, `"article":{"title":"${article}"`);
  await nextDecision({ needed: 0.05 }, `${choreSummary}","existing_articles`);
  await nextModelReply(JSON.stringify({ why: "", changelog: "A tidier theme store", proposals: {} }), chore);
  await row.getByRole("button", { name: "Analyse anyway" }).click();
  await expect(owner.getByText("Analysed", { exact: true })).toBeVisible();
  await expect(owner.getByText("Nothing to do (1)")).toHaveCount(0);
  await expect(list.getByRole("tab", { name: "To review 0" })).toBeVisible();

  // The changelog's draft has both lines Autopilot wrote, and not the pull requests' own titles.
  await owner.goto(`/app/${slug}/changelog/1`);
  // A fact under its title (no sentence): what the draft is doing.
  await expect(owner.getByText("Draft · collecting merged pull requests until a release or you publish it")).toBeVisible();
  await expect(owner.getByText("Dark theme", { exact: true })).toBeVisible();
  await expect(owner.getByText("A tidier theme store")).toBeVisible();
  await expect(owner.getByText(chore)).toHaveCount(0);

  // On a phone: the list first, right under the page's title; a page opens in its place, with the way back.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(`/app/${slug}/autopilot`);
  const phoneList = owner.getByRole("complementary", { name: "Changes" });
  await phoneList.getByRole("tab", { name: "Reviewed" }).click();
  const heading = (await owner.getByRole("heading", { name: "Autopilot", level: 1 }).boundingBox())!;
  expect((await phoneList.boundingBox())!.y - (heading.y + heading.height)).toBeLessThan(80);
  await expect(phoneList.getByRole("link", { name: title })).toBeInViewport();
  await checkpoint(owner, "autopilot-list-phone", { fullPage: false });
  await phoneList.getByRole("link", { name: article }).click();
  await expect(owner.getByRole("heading", { name: article, level: 1 })).toBeInViewport();
  await expect(phoneList).toBeHidden();
  await checkpoint(owner, "autopilot-article-phone");
  await owner.goto(activityPage);
  await expect(owner.getByRole("heading", { name: pr, level: 1 })).toBeVisible();
  await checkpoint(owner, "autopilot-activity-phone");
  await owner.goto(`/app/${slug}/autopilot`);
  await phoneList.getByRole("tab", { name: "Reviewed" }).click();
  await phoneList.getByRole("link", { name: title }).click();
  await expect(owner.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await owner.getByRole("list", { name: "Pull requests" }).getByRole("button", { name: new RegExp(`^PR #${number} octo merged .*: ${pr}$`) }).click();
  await expect(owner.getByRole("dialog").filter({ hasText: pr })).toBeVisible();
  await checkpoint(owner, "autopilot-post-phone", { fullPage: false });
  await owner.keyboard.press("Escape");
  await owner.getByRole("link", { name: "Autopilot", exact: true }).click();
  await expect(phoneList.getByRole("tab", { name: "To review 0" })).toBeInViewport();
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
  // Another one waiting: it opens by itself once this one is reviewed.
  const next = `Add imports ${id}`;
  const nextDraft = `Import feedback ${id}`;
  const nextSummary = `You can now import feedback from a CSV file (${id}).`;
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, next);
  await nextModelReply(nextSummary, next);
  await nextDecision({ needed: 0.9 }, `${nextSummary}","existing_articles`);
  await nextModelReply(
    JSON.stringify({ title: nextDraft, reason: "Nothing explains imports yet.", notes: "## Import it\n\nPick **Import**." }),
    `${nextSummary}",\n "existing_articles"`,
  );
  await nextModelReply(JSON.stringify({ why: "", changelog: "Feedback imports", proposals: {} }), next);
  await mergePullRequest(installationId, { number: number + 1, title: next });
  // And a third. Each is a new article in Help center, the oldest first.
  const last = `Add webhooks ${id}`;
  const lastDraft = `Feedback webhooks ${id}`;
  const lastSummary = `You can now get a webhook for new feedback (${id}).`;
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, last);
  await nextModelReply(lastSummary, last);
  await nextDecision({ needed: 0.9 }, `${lastSummary}","existing_articles`);
  await nextModelReply(
    JSON.stringify({ title: lastDraft, reason: "Nothing explains webhooks yet.", notes: "## Add one\n\nPick **Webhooks**." }),
    `${lastSummary}",\n "existing_articles"`,
  );
  await nextModelReply(JSON.stringify({ why: "", changelog: "Feedback webhooks", proposals: {} }), last);
  await mergePullRequest(installationId, { number: number + 2, title: last });

  await owner.goto(`/app/${slug}/autopilot`);
  const help = owner.getByRole("complementary", { name: "Changes" }).getByRole("region", { name: "Help center" });
  await expect(help.getByRole("listitem")).toHaveCount(3);
  await expect(help.getByRole("listitem").filter({ hasText: draft })).toContainText("New");
  await help.getByRole("link", { name: draft }).click();
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
  await expect(owner.getByText("From your email: the updates it named were decided already.", { exact: true })).toBeVisible();
  await expect(proposal.getByRole("checkbox")).not.toBeChecked();
  await expect(owner.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();

  // On a phone: the list first, right under the page's title; a page opens in its place, with the way back.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(`/app/${slug}/autopilot`);
  const phoneList = owner.getByRole("complementary", { name: "Changes" });
  const title = (await owner.getByRole("heading", { name: "Autopilot", level: 1 }).boundingBox())!;
  expect((await phoneList.boundingBox())!.y - (title.y + title.height)).toBeLessThan(80);
  await expect(phoneList.getByRole("link", { name: draft })).toBeInViewport();
  await checkpoint(owner, "autopilot-list-phone", { fullPage: false });
  await phoneList.getByRole("link", { name: draft }).click();
  await expect(owner.getByRole("heading", { name: draft, level: 1 })).toBeInViewport();
  await expect(phoneList).toBeHidden();
  await owner.getByRole("link", { name: "Autopilot", exact: true }).click();
  await expect(phoneList.getByRole("link", { name: draft })).toBeInViewport();

  // The updates as a list, each preview a tap away, and the button at the bottom.
  await owner.goto(page);
  await expect(preview).toBeHidden();
  await proposal.getByRole("button", { name: "Preview" }).click();
  await expect(preview.getByRole("heading", { name: "Export it" })).toBeVisible();
  const approve = owner.getByRole("button", { name: /^Approve \d/ });
  await expect(approve).toBeInViewport();
  await checkpoint(owner, "autopilot-phone", { fullPage: false });

  // Approved from the email's link: the line says they're decided now, not still selected.
  await owner.setViewportSize({ width: 1280, height: 720 });
  await owner.goto(`${page}?select=likely`);
  // (The list showing Reviewed meanwhile.)
  const changesList = owner.getByRole("complementary", { name: "Changes" });
  await changesList.getByRole("tab", { name: /^Reviewed/ }).click();
  await owner.getByRole("button", { name: /^Approve \d/ }).click();
  await owner.getByRole("alertdialog").getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByText(/^Approved \d updates?$/)).toBeVisible();
  // Nothing of it waits now: the next one to review opens, the list shows To review again, and focus goes to
  // its row in it (the button's gone).
  await expect(owner.getByRole("heading", { name: nextDraft })).toBeVisible();
  await expect(changesList.getByRole("tab", { name: "To review 2" })).toHaveAttribute("aria-selected", "true");
  await expect(changesList.getByRole("link", { name: nextDraft })).toBeFocused();
  // The other one opened from the list, then on a phone (no list beside it): dismissing its last update waiting
  // opens the next again (the same one as before, the list's first), and focus goes to its title.
  await changesList.getByRole("link", { name: lastDraft }).click();
  await expect(owner.getByRole("heading", { name: lastDraft })).toBeVisible();
  await owner.setViewportSize({ width: 390, height: 844 });
  const webhooks = owner.getByRole("article", { name: `New article: ${lastDraft}` });
  await webhooks.getByRole("button", { name: "Dismiss" }).click();
  await owner.getByRole("dialog").getByRole("button", { name: "Dismiss" }).click();
  await expect(owner.getByText("Dismissed", { exact: true })).toBeVisible();
  await expect(owner.getByRole("heading", { name: nextDraft, level: 1 })).toBeFocused();
  await owner.setViewportSize({ width: 1280, height: 720 });
  await owner.goto(`${page}?select=likely`);
  await expect(owner.getByText("From your email: the updates it named were decided already.", { exact: true })).toBeVisible();
  await expect(owner.getByRole("alertdialog")).toHaveCount(0);
  // Then undone: the draft is deleted, and the update says who undid it.
  const done = owner.getByRole("region", { name: "Done" }).getByRole("listitem", { name: `New article: ${draft}` });
  await done.getByRole("button", { name: "Undo" }).click();
  const undo = owner.getByRole("alertdialog", { name: "Undo this update?" });
  await expect(undo).toContainText("The draft is deleted.");
  await checkpoint(owner, "autopilot-undo", { fullPage: false });
  await undo.getByRole("button", { name: "Undo" }).click();
  await expect(owner.getByText("Undone", { exact: true })).toBeVisible();
  await expect(done).toContainText("Undone by Olive Owner");
  await owner.goto(`/app/${slug}/docs`);
  await expect(owner.getByRole("link", { name: draft })).toHaveCount(0);

  // From the list: a row's ring picks it, and its likely updates are approved with the others picked.
  await owner.goto(`/app/${slug}/autopilot`);
  await changesList.getByRole("checkbox", { name: `Select ${nextDraft}` }).click();
  await expect(changesList.getByText("1 selected")).toBeVisible();
  await checkpoint(owner, "autopilot-bulk", { fullPage: false });
  await changesList.getByRole("button", { name: "Approve", exact: true }).click();
  const bulk = owner.getByRole("alertdialog", { name: "Approve 1 update on 1 page?" });
  await expect(bulk).toContainText("1 new article drafted (only your team sees it)");
  await bulk.getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByText("Approved 1 update")).toBeVisible();
  await expect(changesList.getByText("Nothing to review")).toBeVisible();
});

test("an article edit Autopilot is sure of goes out by itself once the hold passes; Home and the page say when", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
  const number = randomInt(1_000, 1_000_000);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const article = `Change the theme ${id}`;
  const { slug: articleSlug } = await api("/articles", { title: article, body: "Pick Light in Settings." });
  await api(`/articles/${articleSlug}/publish`, {});
  const installationId = await connectGithub(owner, slug);
  // Article edits go out by themselves for a new project (Settings → Autopilot).
  await owner.goto(`/app/${slug}/settings/autopilot`);
  await expect(owner.getByRole("switch", { name: "Publish article edits" })).toBeChecked();

  const pr = `Add a dark theme ${id}`;
  const summary = `You can now switch to a dark theme in Settings (${id}).`;
  await similar(summary, `${article}\n\nPick Light in Settings.`, 0.9);
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
  await nextModelReply(summary, pr);
  // 97% sure: over the bar, so it goes out by itself after the hold.
  await nextDecision({ effect: { wrong: 0.97, missing: 0, unaffected: 0.03 } }, `"article":{"title":"${article}"`);
  await nextDecision({ needed: 0.1 }, `${summary}","existing_articles`);
  await nextModelReply(JSON.stringify({ reason: "It says Light is the only theme.", sections: { "1": "Pick Light, **Dark** or System in Settings." } }), article);
  await nextModelReply(JSON.stringify({ why: "", changelog: "Dark theme", proposals: {} }), pr);
  await mergePullRequest(installationId, { number, title: pr, files: [{ filename: "src/theme.css", patch: "+.dark { --background: #111; }" }] });

  // Its owner is emailed: what goes out by itself and when; Review opens the pull request's activity page.
  await runAutopilot(slug, { emailNow: true });
  const email = await latestEmailTo(owner.email, { subject: new RegExp(`· ${pr}$`) });
  expect(email.from).toContain("Tuti Autopilot");
  expect(email.subject).toBe(`1 goes out in 24 hours · ${pr}`);
  expect(email.text).toMatch(new RegExp(`${article}\\s+\\d+% sure\\s+Out of date`));
  // The edit as lines: what it takes out, what it puts in.
  expect(email.text).toContain("− Pick Light in Settings.");
  expect(email.text).toContain("+ Pick Light, Dark or System in Settings.");
  expect(email.text).toContain("goes out in 24 hours");
  // (The changelog line isn't in it: it's written into the running draft by itself, and reviewed there.)
  expect(email.text).not.toContain("Changelog line");
  // Publish now and Stop under what goes out; Review in Tuti opens the pull request's activity page.
  const review = email.text.split(/\s+/).find((word) => word.startsWith(`${APP_URL}/app/${slug}/autopilot/activity/`));
  const acts = email.text.split(/\s+/).filter((word) => word.includes("/act?token="));
  expect(acts).toHaveLength(2);
  await owner.goto(review!);
  await expect(owner.getByRole("heading", { name: pr, level: 1 })).toBeVisible();
  const touched = owner.getByRole("region", { name: "Review changes" }).getByRole("link", { name: new RegExp(article) });
  await expect(touched).toContainText(/Goes out tomorrow at \d/);
  await touched.click();
  await expect(owner.getByRole("heading", { name: article, level: 1 })).toBeVisible();
  // Its Publish now or Stop opened by someone else (or late) names the edit: it has no checkbox, so it's marked.
  const [payload] = new URL(acts[0]!).searchParams.get("token")!.split(".");
  const named = (JSON.parse(Buffer.from(payload!, "base64url").toString()) as { b: string }).b.split(":")[1]!;
  const articleReview = owner.url();
  await owner.goto(`${articleReview}?select=${named}`);
  await expect(owner.getByRole("article", { name: `Out of date: ${article}` }).getByText("In your email")).toBeVisible();
  await expect(owner.getByRole("region", { name: "Overview" })).toContainText("Emailed to Olive Owner");

  // Home says it goes out by itself, with Publish now and Stop; the list and the page say when.
  await owner.goto(`/app/${slug}`);
  const catchUp = owner.getByRole("listitem").filter({ hasText: pr });
  await expect(catchUp).toContainText(/1 update goes out tomorrow at \d/);
  await expect(catchUp.getByRole("button", { name: "Stop" })).toBeVisible();
  await owner.goto(articleReview);
  await expect(owner.getByRole("complementary", { name: "Changes" }).getByRole("listitem").filter({ hasText: article })).toContainText(/Goes out tomorrow at \d/);
  const edit = owner.getByRole("article", { name: `Out of date: ${article}` });
  await expect(edit).toContainText("Auto-updating");
  await expect(edit).toContainText(/Goes out tomorrow at \d/);
  await expect(edit.getByRole("button", { name: "Publish now" })).toBeVisible();
  await expect(owner.getByRole("region", { name: "Done" })).toHaveCount(0);
  await checkpoint(owner, "autopilot-scheduled");

  // The hold passes (the minute, run by hand): checked again, it goes out, as Autopilot's own.
  // (It runs for every project, journeys running beside this one too: what it did here is checked below.)
  await runAutopilot(slug, { dueNow: true });
  await owner.reload();
  const done = owner.getByRole("region", { name: "Done" });
  await expect(done.getByRole("listitem", { name: `Out of date: ${article}` })).toContainText("Applied by Autopilot");
  const portalArticle = await owner.context().newPage();
  await portalArticle.goto(`${portalUrl(slug)}/docs/${articleSlug}`);
  await expect(portalArticle.getByText("Pick Light, Dark or System in Settings.")).toBeVisible();
  await portalArticle.close();
});

test("on their account, someone picks when they hear from Autopilot; a choice that isn't saved goes back", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await owner.goto("/app/account");
  const off = owner.getByRole("radio", { name: /^Off/ });
  const asTheyHappen = owner.getByRole("radio", { name: /^As they happen/ });
  await expect(asTheyHappen).toBeChecked();
  await off.check();
  await expect(owner.getByText("Saved", { exact: true })).toBeVisible();
  await checkpoint(owner, "account-autopilot-email");
  // Changed back in another tab: this one shows it once the page refreshes (saving the name, here).
  const other = await owner.context().newPage();
  await other.goto("/app/account");
  await other.getByRole("radio", { name: /^As they happen/ }).check();
  await expect(other.getByText("Saved", { exact: true })).toBeVisible();
  await other.close();
  await owner.getByLabel("Name").fill("Olive O. Owner");
  await owner.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(asTheyHappen).toBeChecked();
  await off.check();
  await expect(owner.getByText("Saved", { exact: true }).first()).toBeVisible();
  // Signed out meanwhile (another tab, say): not saved, so it shows what is. Clicked, not check(): it goes back
  // as soon as the save fails, and check() would call that a click that didn't take.
  await owner.context().clearCookies();
  await asTheyHappen.click();
  await expect(owner.getByText("Sign in first")).toBeVisible();
  await expect(off).toBeChecked();
});

test("the email's Approve, clicked signed out: sign in, and it's done; the post is in progress and the article's new version on the portal", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
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

  // Under the bar (95%): the progress update and the article's edit both wait for the team.
  const pr = `Add a dark theme ${id}`;
  const summary = `You can now switch to a dark theme in Settings (${id}).`;
  await similar(summary, title, 0.95);
  await similar(summary, `${article}\n\nPick Light in Settings.`, 0.9);
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
  await nextModelReply(summary, pr);
  await nextDecision({ effect: { resolves: 0.05, moves_forward: 0.9, related: 0.04, unrelated: 0.01 } }, title);
  await nextDecision({ effect: { wrong: 0.87, missing: 0.05, unaffected: 0.08 } }, `"article":{"title":"${article}"`);
  await nextDecision({ needed: 0.1 }, `${summary}","existing_articles`);
  await nextModelReply(
    JSON.stringify({ why: "", changelog: "Dark theme", proposals: { p2: { reason: "Dark mode is part of it.", comment: "Dark mode is on its way: the theme is in Settings now." } } }),
    title,
  );
  await nextModelReply(JSON.stringify({ reason: "It says Light is the only theme.", sections: { "1": "Pick Light, **Dark** or System in Settings." } }), article);
  await mergePullRequest(installationId, { number, title: pr, files: [{ filename: "src/theme.css", patch: "+.dark { --background: #111; }" }] });

  // The email: what needs her, each with Approve.
  await runAutopilot(slug, { emailNow: true });
  const email = await latestEmailTo(owner.email, { subject: new RegExp(`· ${pr}$`) });
  expect(email.subject).toBe(`2 need you · ${pr}`);
  const approves = email.text.split(/\s+/).filter((word) => word.startsWith(`${APP_URL}/app/${slug}/autopilot/`) && word.includes("/act?token="));
  expect(approves).toHaveLength(2);
  const inbox = await (await browser.newContext()).newPage();
  await inbox.setContent(email.html);
  await expect(inbox.getByRole("link", { name: "Approve" })).toHaveCount(2);
  await checkpoint(inbox, "autopilot-email");

  // Clicked on another device, signed out: sign in first, then it's done.
  const elsewhere = await (await browser.newContext()).newPage();
  await elsewhere.goto(approves[0]!);
  await elsewhere.waitForURL("**/sign-in?next=*");
  await elsewhere.getByLabel("Email").fill(owner.email);
  await elsewhere.getByLabel("Password").fill("correct horse battery staple");
  await elsewhere.getByRole("button", { name: "Sign in", exact: true }).click();
  // The progress update first: requests come before articles.
  await expect(elsewhere.getByText(`Approved: Progress update: ${title}. Undo is under Done.`)).toBeVisible();
  await checkpoint(elsewhere, "autopilot-email-approved");
  // Signed in now, the next one acts at once; clicked again, it says it's done and does nothing.
  await elsewhere.goto(approves[1]!);
  await expect(elsewhere.getByText(`Approved: Out of date: ${article}. Undo is under Done.`)).toBeVisible();
  await elsewhere.goto(approves[1]!);
  await expect(elsewhere.getByText(`Done already: Out of date: ${article} was approved by Olive Owner`, { exact: false })).toBeVisible();

  // The post is in progress with the update, and the portal has the article's new version.
  await elsewhere.goto(`/app/${slug}/p/1`);
  await expect(elsewhere.getByRole("combobox", { name: "Status" })).toContainText("In progress");
  await expect(elsewhere.getByText("Dark mode is on its way: the theme is in Settings now.")).toBeVisible();
  await elsewhere.goto(`${portalUrl(slug)}/docs/${articleSlug}`);
  await expect(elsewhere.getByText("Pick Light, Dark or System in Settings.")).toBeVisible();
});
