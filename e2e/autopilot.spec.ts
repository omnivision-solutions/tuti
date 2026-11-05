import { randomInt, randomUUID } from "node:crypto";

import { expect, type Locator, type Request, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { connectGithub, mergePullRequest } from "./github";
import { articlesIn, markUnsure, placeDraft, runAutopilot, scheduledDraft } from "./autopilot";
import { latestEmailTo } from "./mail";
import { apiFor, createProject, signUp } from "./helpers";
import { nextDecision, nextDocsAgentAnswer, nextModelReply } from "./model";
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
  await api("/posts", { board: "feature-requests", title, body: "The dashboard is too bright at night." });
  const article = `Change the theme ${id}`;
  // Three paragraphs: the edit changes the first and the last, two changes to step between.
  const before = "Pick Light in Settings.\n\nThemes apply at once.\n\nAsk us if it doesn't.";
  const after = "Pick Light, Dark or System in Settings.\n\nThemes apply at once.\n\nAsk us if the theme doesn't change.";
  const { slug: articleSlug } = await api("/articles", { title: article, body: before });
  await api(`/articles/${articleSlug}/publish`, {});
  const installationId = await connectGithub(owner, slug);

  // The pull request: users see it (the gate), its summary finds the post, which it resolves.
  const pr = `Add a dark theme ${id}`;
  const summary = `You can now switch to a dark theme in Settings (${id}).`;
  await similar(summary, title, 0.95);
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
  // The docs agent: 92% sure the article is wrong: under the bar (95%), so the edit waits for the team (and above the
  // request's 90%, so it's p1, the post p2).
  await nextDocsAgentAnswer(number, { summary, edits: [{ slug: articleSlug, probability: 0.92 }] });
  await nextDecision({ effect: { resolves: 0.9, moves_forward: 0.05, related: 0.04, unrelated: 0.01 } }, title);
  await nextModelReply(JSON.stringify({ why: "It ships the dark theme people asked for.", changelog: "Dark theme", proposals: { p2: { reason: "It adds the dark theme the post asks for." } } }), title);
  await nextModelReply(
    JSON.stringify({ reason: "It says Light is the only theme.", overview: "It names Dark and System beside Light.", sections: { "1": "Pick Light, **Dark** or System in Settings.\n\nThemes apply at once.\n\nAsk us if the theme doesn't change." } }),
    article,
  );
  await mergePullRequest(installationId, { number, title: pr, files: [{ filename: "src/theme.css", patch: "+.dark { --background: #111; }" }] });

  // Home's "Needs your attention" has what it updates, as To review lists them, each with Review: the post and the
  // article wait for the team (not 95% sure, and completing a post asks first). The changelog line was written into
  // the running draft by itself: it never waits.
  await owner.goto(`/app/${slug}`);
  const catchUp = owner.getByRole("region", { name: "To review in Autopilot" });
  await expect(catchUp.getByRole("listitem")).toHaveText([new RegExp(title), new RegExp(article)]);
  await expect(catchUp).not.toContainText("goes out");
  await expect(catchUp.getByRole("listitem").filter({ hasText: title }).getByRole("link", { name: "Review" })).toHaveAttribute("href", new RegExp(`/autopilot/feedback/`));
  await expect(owner.getByRole("link", { name: /^2\s*Posts and articles to review$/ })).toBeVisible();
  await checkpoint(owner, "home-catch-up");
  const list = owner.getByRole("complementary", { name: "Changes" });
  // From laptop width up, To review opens its first beside the list (Feedback's post), never an empty page. A tab
  // picked while it opens (its page held back till then) stays picked.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let opens = () => {};
  const openingFirst = new Promise<void>((resolve) => (opens = resolve));
  await owner.route("**/autopilot/feedback/**", async (route) => {
    // (A prefetch goes; the opening's own request is held.)
    if (route.request().headers()["next-router-prefetch"]) {
      await route.continue();
      return;
    }
    opens();
    await held;
    await route.continue();
  });
  await owner.getByRole("link", { name: "Autopilot", exact: true }).click();
  await openingFirst;
  await list.getByRole("tab", { name: "Activity" }).click();
  release();
  await owner.waitForURL(`**/app/${slug}/autopilot/feedback/*`);
  await expect(owner.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(list.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  await owner.unroute("**/autopilot/feedback/**");
  // Once: back to the list from inside Autopilot, it stays there, saying what a row opens. Opening by itself again
  // would ask for the post's page as the list shows (not a prefetch): none is asked for.
  await list.getByRole("tab", { name: /^To review/ }).click();
  const reopened: string[] = [];
  const reopening = (request: Request) => {
    if (request.url().includes("/autopilot/feedback/") && request.headers()["rsc"] && !request.headers()["next-router-prefetch"]) {
      reopened.push(request.url());
    }
  };
  owner.on("request", reopening);
  await owner.getByRole("link", { name: "Autopilot", exact: true }).first().click();
  await expect(owner.getByText("Pick a post or an article to review")).toBeVisible();
  // (Two frames: the list's effects have run, and with them any opening.)
  await owner.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  owner.off("request", reopening);
  expect(reopened).toEqual([]);
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/autopilot$`));
  // Sent here with a notice (a review with nothing left on it), it stays to say so.
  await owner.goto(`/app/${slug}/autopilot?gone=post`);
  await expect(owner.getByRole("status").filter({ hasText: "Nothing from Autopilot is on that post any more." })).toBeFocused();
  await expect(owner.getByText("Pick a post or an article to review")).toBeVisible();
  // (Once the page has settled: an opening by itself would have fetched the post's review by now.)
  await owner.waitForLoadState("networkidle");
  await expect(owner).toHaveURL(new RegExp(`/app/${slug}/autopilot\\?gone=post$`));
  // An opening by itself that another page beat (the article picked before the post's page came) is over too: a tab
  // picked later, then the post reached from a pull request's page, shows the post's tab.
  let letGo = () => {};
  const heldAgain = new Promise<void>((resolve) => (letGo = resolve));
  let asked = () => {};
  const opening = new Promise<void>((resolve) => (asked = resolve));
  await owner.route("**/autopilot/feedback/**", async (route) => {
    // (A prefetch goes; the opening's own request is held.)
    if (route.request().headers()["next-router-prefetch"]) {
      await route.continue();
      return;
    }
    asked();
    await heldAgain;
    // (Its page was dropped for the article's: let go after the route is gone, it may be handled already.)
    await route.continue().catch(() => {});
  });
  await owner.goto(`/app/${slug}/autopilot`);
  // The opening under way (its page asked for, and held), the article is picked.
  await opening;
  await list.getByRole("link", { name: article }).click();
  await expect(owner.getByRole("heading", { name: article, level: 1 })).toBeVisible();
  letGo();
  await owner.unroute("**/autopilot/feedback/**");
  await list.getByRole("tab", { name: "Activity" }).click();
  await list.getByRole("link", { name: pr }).click();
  await expect(owner.getByRole("heading", { name: pr, level: 1 })).toBeVisible();
  await list.getByRole("tab", { name: "Reviewed" }).click();
  await owner.getByRole("region", { name: "Review changes" }).getByRole("link", { name: new RegExp(title) }).click();
  await expect(owner.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(list.getByRole("tab", { name: "To review 2" })).toHaveAttribute("aria-selected", "true");
  await expect(list.getByRole("tab", { name: "To review 2" })).toHaveAttribute("aria-selected", "true");
  // The tabs fit, whole, even where the list is taller than the window.
  await owner.setViewportSize({ width: 1280, height: 160 });
  const tabs = list.getByRole("tablist");
  expect(await tabs.evaluate((row) => row.scrollHeight - row.clientHeight)).toBe(0);
  await owner.setViewportSize({ width: 1280, height: 720 });
  // By what it updates, as a tree: Feedback → its board → the post it completes, then Help center → the article it
  // edits (in no collection: right under it). A row is the post's or article's title and its badge (no pull request
  // chips: those are on its page), and nothing to pick: each is reviewed on its page.
  const postRow = list.getByRole("region", { name: "Feedback" }).getByRole("list", { name: "Feature requests" }).getByRole("listitem").filter({ hasText: title });
  await expect(postRow).toContainText("Completing");
  await expect(postRow.getByRole("button", { name: /^PR #/ })).toHaveCount(0);
  const articleRow = list.getByRole("region", { name: "Help center" }).getByRole("listitem").filter({ hasText: article });
  await expect(articleRow).toContainText("Updated");
  const sections = list.getByRole("region");
  await expect(sections.nth(0)).toHaveAccessibleName("Feedback");
  await expect(sections.nth(1)).toHaveAccessibleName("Help center");
  await expect(list.getByRole("checkbox")).toHaveCount(0);
  await checkpoint(owner, "autopilot");

  // The post's review has what's needed to decide: what its users asked, and that the same pull request's article
  // edit still waits.
  await list.getByRole("link", { name: title }).click();
  await expect(owner.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(owner.getByRole("region", { name: "What they asked" })).toContainText("The dashboard is too bright at night.");
  const also = owner.locator("li", { hasText: `Also from PR #${number}:` });
  await expect(also).toContainText(`Also from PR #${number}: ${article} (waits).`);
  await expect(also.getByRole("link", { name: article })).toHaveAttribute("href", new RegExp(`/autopilot/articles/`));
  await checkpoint(owner, "autopilot-post-context");

  // The article's review, beside the list (which marks it): its pull requests' chips (each one's part in its popover),
  // what changed (folded away), then the whole article as readers see it with the changes in it.
  await list.getByRole("link", { name: article }).click();
  await expect(owner.getByRole("heading", { name: article, level: 1 })).toBeVisible();
  await expect(list.getByRole("link", { name: article })).toHaveAttribute("aria-current", "page");
  await owner.getByRole("list", { name: "Pull requests" }).getByRole("button", { name: `PR #${number}: ${pr}` }).click();
  await expect(owner.getByRole("dialog").filter({ hasText: pr })).toContainText("Waits for you");
  // Not how sure Autopilot is: the app doesn't say.
  await expect(owner.getByRole("dialog").filter({ hasText: pr })).not.toContainText("sure");
  // Its popover names the post the same pull request completes, still waiting.
  await expect(owner.getByRole("dialog").filter({ hasText: pr })).toContainText(`Also from PR #${number}: ${title} (waits)`);
  await owner.keyboard.press("Escape");
  // What changed is folded away until opened.
  const whatChanged = owner.getByRole("group", { name: "What changed" });
  // What the new text says (the model's overview), not the pull request's reason (that's in its chip).
  await expect(whatChanged.getByText("It names Dark and System beside Light.")).toBeHidden();
  await whatChanged.getByText("What changed", { exact: true }).click();
  await expect(whatChanged.getByText("It names Dark and System beside Light.")).toBeVisible();
  await expect(whatChanged).not.toContainText("It says Light is the only theme.");
  const view = owner.getByRole("region", { name: "The article" });
  await expect(view.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");
  // Formatted as readers see it: the new paragraph's bold is bold; the old one is struck out; what didn't change is there too.
  await expect(view.getByRole("insertion").first().locator("strong")).toHaveText("Dark");
  await expect(view.getByRole("deletion").first()).toContainText("Pick Light in Settings.");
  await expect(view.getByText("Themes apply at once.")).toBeVisible();
  // Stepping between the changes: the one stepped to is marked.
  await expect(view.getByText("Change 1 of 2")).toBeVisible();
  await view.getByRole("button", { name: "Next change" }).click();
  await expect(view.getByText("Change 2 of 2")).toBeVisible();
  await expect(view.locator('[data-change="1"]')).toHaveAttribute("data-current", "");
  await expect(view.getByRole("button", { name: "Next change" })).toBeDisabled();
  await checkpoint(owner, "autopilot-article");
  // The article alone: the new text, nothing struck out.
  await view.getByRole("tab", { name: "Article" }).click();
  await expect(view.getByRole("deletion")).toHaveCount(0);
  await expect(view.getByText("Ask us if the theme doesn't change.")).toBeVisible();
  await expect(view.getByText("Pick Light in Settings.")).toHaveCount(0);
  await checkpoint(owner, "autopilot-article-clean");
  await view.getByRole("tab", { name: "Changes" }).click();
  // In dark, and on a phone (the tabs and stepping on one row, Approve at the bottom of the screen).
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "autopilot-article-dark");
  await view.getByRole("tab", { name: "Article" }).click();
  await checkpoint(owner, "autopilot-article-clean-dark");
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "autopilot-article-clean-phone-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await view.getByRole("tab", { name: "Changes" }).click();
  await expect(owner.getByRole("button", { name: "Approve and publish" })).toBeInViewport();
  await checkpoint(owner, "autopilot-article-phone-changes", { fullPage: false });
  // On a phone it asks as every dialog does: left-aligned, with an × that cancels.
  await owner.getByRole("button", { name: "Approve and publish" }).click();
  const onPhone = owner.getByRole("alertdialog", { name: `Publish “${article}”?` });
  await expect(onPhone.getByText(`Publish “${article}”?`)).toHaveCSS("text-align", "start");
  await checkpoint(owner, "autopilot-article-phone-confirm", { fullPage: false });
  await onPhone.getByRole("button", { name: "Close" }).click();
  await expect(onPhone).toHaveCount(0);
  await owner.setViewportSize({ width: 1280, height: 720 });
  // Edit before publishing: its changes in the article's editor, which leads back to the review.
  await owner.getByRole("link", { name: "Edit before publishing" }).click();
  const editor = owner.getByRole("textbox", { name: "Article" });
  await expect(editor).toContainText("Pick Light, Dark or System in Settings.");
  await editor.click();
  await owner.keyboard.press("ControlOrMeta+End");
  await owner.keyboard.type(" On every device.");
  await owner.getByRole("button", { name: "Save", exact: true }).filter({ visible: true }).click();
  await expect(owner.getByText("Saved", { exact: true })).toBeVisible();
  // (Through its History panel and back, the way back stays.)
  await owner.getByRole("button", { name: "More actions" }).click();
  await owner.getByRole("link", { name: "History" }).click();
  await expect(owner.getByRole("dialog", { name: "History" })).toBeVisible();
  await owner.keyboard.press("Escape");
  await expect(owner.getByRole("dialog", { name: "History" })).toBeHidden();
  await owner.getByRole("link", { name: "Review", exact: true }).click();
  await expect(owner.getByRole("heading", { name: article, level: 1 })).toBeVisible();
  await expect(view.getByRole("insertion").filter({ hasText: "On every device." })).toBeVisible();
  // Said as the team's (it's the reviewer's own here), not a teammate's.
  await expect(owner.getByText("Includes your team's unpublished edit")).toBeVisible();
  // Approved on its page, asking first.
  await owner.getByRole("button", { name: "Approve and publish" }).click();
  await owner.getByRole("alertdialog", { name: `Publish “${article}”?` }).getByRole("button", { name: "Publish" }).click();
  await expect(owner.locator("[data-sonner-toast]").getByText("Published", { exact: true })).toBeVisible();

  // Nothing of it waits now: the post opens by itself. Its review is what happens to the post (its status change and
  // who completing it emails), one Approve; why Autopilot suggests it is in its pull request's chip.
  await expect(owner.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(list.getByRole("tab", { name: "To review 1" })).toHaveAttribute("aria-selected", "true");
  const happens = owner.getByRole("region", { name: "What happens to the post" });
  await expect(happens).toContainText("Open → Completed");
  // Why it waits, in plain words: its only follower is the team's, so completing it emails nobody, and it's the setting
  // that holds it (with people to email: "Completing emails everyone on the post").
  await expect(happens).toContainText("Waits for you: Autopilot's settings ask first for completing posts.");
  await expect(owner.getByText("It adds the dark theme the post asks for.")).toHaveCount(0);
  await expect(owner.getByRole("checkbox")).toHaveCount(0);
  const chip = owner.getByRole("list", { name: "Pull requests" }).getByRole("button", { name: `PR #${number}: ${pr}` });
  await chip.click();
  const popover = owner.getByRole("dialog").filter({ hasText: pr });
  await expect(popover).toContainText("Completes the post");
  await expect(popover).toContainText("It adds the dark theme the post asks for.");
  await owner.keyboard.press("Escape");
  await checkpoint(owner, "autopilot-post");
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "autopilot-post-dark");
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "autopilot-post-phone-dark");
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "autopilot-post-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  // The article is published now: nothing else from its pull request waits.
  await expect(owner.locator("li", { hasText: "Also from PR" })).toHaveCount(0);
  // Completing it can take a comment of the team's, which goes into the email and on the post.
  await happens.getByRole("textbox", { name: "Comment on #1 (optional)" }).fill("Dark is here: pick Dark in Settings.");
  await owner.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(owner.getByRole("alertdialog", { name: "Approve the update?" })).toContainText("1 comment posted with it");
  await owner.getByRole("alertdialog", { name: "Approve the update?" }).getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByText("Approved", { exact: true })).toBeVisible();
  // What became of it is in its pull request's chip.
  await chip.click();
  await expect(popover).toContainText("Approved by Olive Owner");
  await owner.keyboard.press("Escape");
  // Nothing waits for the team now: it moves to Reviewed by itself, and stays open (there's no other to review).
  await expect(list.getByRole("tab", { name: "Reviewed" })).toHaveAttribute("aria-selected", "true");
  await expect(list.getByRole("link", { name: title })).toHaveAttribute("aria-current", "page");
  await expect(list.getByRole("region", { name: "Help center" }).getByRole("link", { name: article })).toBeVisible();
  // Each row says what became of it, in the past tense, who decided and when; the page says so too, with what went
  // out and Undo.
  // (The innermost: its board's row holds it too.)
  const reviewedPost = list.getByRole("listitem").filter({ has: owner.getByRole("link", { name: title }) }).last();
  await expect(reviewedPost).toContainText("Completed");
  await expect(reviewedPost).toContainText(/Approved by Olive · \d+[smhd]/);
  // Its time read aloud in words, the short form hidden from screen readers (as the Inbox's rows).
  const when = reviewedPost.locator("time");
  await expect(when.locator(".sr-only")).toHaveText(/^\d+ (seconds?|minutes?) ago$/);
  await expect(when.locator("[aria-hidden]")).toHaveText(/^\d+[sm]$/);
  const happened = owner.getByRole("region", { name: "What happened" });
  await expect(happened).toContainText(/^Completed · approved by Olive Owner, (just now|\d+ (seconds?|minutes?) ago)/);
  await expect(happened.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(happened.getByRole("link", { name: "Open the post" })).toHaveAttribute("href", `/app/${slug}/p/1`);
  await expect(list.getByRole("listitem").filter({ has: owner.getByRole("link", { name: article }) }).last()).toContainText(/Published.*Approved by Olive/);
  // A published article keeps what changed: its edit's text struck out and added, not the published text alone.
  await list.getByRole("link", { name: article }).click();
  await expect(happened).toContainText("Published · approved by Olive Owner");
  await expect(view.getByRole("deletion").filter({ hasText: "Pick Light in Settings." })).toBeVisible();
  await expect(view.getByRole("insertion").filter({ hasText: "Pick Light, Dark or System in Settings." })).toBeVisible();
  await checkpoint(owner, "autopilot-reviewed-article");
  await list.getByRole("link", { name: title }).click();
  await expect(happened).toContainText("Completed");
  // Had it gone out by itself and Autopilot couldn't tell whether it did: the page and the row say to check the post.
  await markUnsure(slug, "RESOLVES");
  await owner.reload();
  await expect(happened).toContainText("Couldn't tell whether it went out: check the post before doing it again.");
  await expect(reviewedPost).toContainText("Couldn't tell whether it went out: check it");
  await list.getByRole("tab", { name: "To review 0" }).click();
  await expect(list.getByText("Nothing to review")).toBeVisible();
  await list.getByRole("tab", { name: "Reviewed" }).click();
  await checkpoint(owner, "autopilot-reviewed");
  // With none open, beside the list: what Reviewed's rows open.
  await owner.goto(`/app/${slug}/autopilot`);
  await list.getByRole("tab", { name: "Reviewed" }).click();
  await expect(owner.getByText("Pick a post or an article to see what became of it")).toBeVisible();
  const portalArticle = await owner.context().newPage();
  await portalArticle.goto(`${portalUrl(slug)}/docs/${articleSlug}`);
  await expect(portalArticle.getByText("Pick Light, Dark or System in Settings.")).toBeVisible();
  await portalArticle.close();

  // The post is completed, linked to the pull request, with the way back to its activity in Autopilot.
  await owner.goto(`/app/${slug}/p/1`);
  await expect(owner.getByRole("combobox", { name: "Status" })).toContainText("Completed");
  await expect(owner.getByText("Dark is here: pick Dark in Settings.")).toBeVisible();
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
  // (And the docs agent finds nothing either.)
  await nextDocsAgentAnswer(number + 1, {});
  await mergePullRequest(installationId, { number: number + 1, title: chore });
  // Its old address (Code changes) lands on Autopilot.
  await owner.goto(`/app/${slug}/code-changes`);
  await owner.waitForURL(`**/app/${slug}/autopilot`);
  await list.getByRole("tab", { name: "Activity" }).click();
  // Beside the list, what Activity's rows open.
  await expect(owner.getByText("Pick a pull request to see what it changed for users")).toBeVisible();
  await owner.getByText("Nothing to do (1)").click();
  const row = owner.getByRole("listitem").filter({ hasText: chore });
  await expect(row).toContainText("Only the team sees this: refactoring, tests, CI or tooling.");
  // Why it has nothing to do, in full beside its button (in three lines at most).
  const reasonText = row.getByText("Only the team sees this: refactoring, tests, CI or tooling.");
  await expect.poll(() => reasonText.evaluate((reason) => reason.scrollWidth <= reason.clientWidth && reason.scrollHeight <= reason.clientHeight)).toBe(true);
  await checkpoint(owner, "autopilot-nothing-to-do");
  // The post is completed now and the article is unaffected: only its changelog line is left, written by itself.
  await nextDocsAgentAnswer(number + 1, { summary: choreSummary });
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
  await owner.getByRole("list", { name: "Pull requests" }).getByRole("button", { name: `PR #${number}: ${pr}` }).click();
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
  // Billing, with two articles: where the first draft goes.
  const api = await apiFor(owner, slug);
  await api("/collections", { name: "Billing" });
  for (const title of ["Invoices", "Refunds"]) {
    await api("/articles", { title, body: `${title}.`, collection: "billing" });
  }
  const installationId = await connectGithub(owner, slug);

  const pr = `Add exports ${id}`;
  const summary = `You can now export your feedback as a CSV file (${id}).`;
  const draft = `Export your feedback ${id}`;
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
  await nextDocsAgentAnswer(number, { summary, newArticles: [{ title: draft, probability: 0.9 }] });
  await nextModelReply(
    JSON.stringify({ title: draft, reason: "Nothing explains exports yet.", notes: "## Export it\n\n1. Open **Settings**.\n2. Pick **Export**." }),
    draft,
  );
  await nextModelReply(JSON.stringify({ why: "", changelog: "Feedback exports", proposals: {} }), pr);
  await mergePullRequest(installationId, { number, title: pr });
  // Another one waiting: it opens by itself once this one is reviewed.
  const next = `Add imports ${id}`;
  const nextDraft = `Import feedback ${id}`;
  const nextSummary = `You can now import feedback from a CSV file (${id}).`;
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, next);
  await nextDocsAgentAnswer(number + 1, { summary: nextSummary, newArticles: [{ title: nextDraft, probability: 0.9 }] });
  await nextModelReply(
    JSON.stringify({ title: nextDraft, reason: "Nothing explains imports yet.", notes: "## Import it\n\nPick **Import**." }),
    nextDraft,
  );
  await nextModelReply(JSON.stringify({ why: "", changelog: "Feedback imports", proposals: {} }), next);
  await mergePullRequest(installationId, { number: number + 1, title: next });
  // And a third. Each is a new article in Help center, the oldest first.
  const last = `Add webhooks ${id}`;
  const lastDraft = `Feedback webhooks ${id}`;
  const lastSummary = `You can now get a webhook for new feedback (${id}).`;
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, last);
  await nextDocsAgentAnswer(number + 2, { summary: lastSummary, newArticles: [{ title: lastDraft, probability: 0.9 }] });
  await nextModelReply(
    JSON.stringify({ title: lastDraft, reason: "Nothing explains webhooks yet.", notes: "## Add one\n\nPick **Webhooks**." }),
    lastDraft,
  );
  await nextModelReply(JSON.stringify({ why: "", changelog: "Feedback webhooks", proposals: {} }), last);
  await mergePullRequest(installationId, { number: number + 2, title: last });

  await owner.goto(`/app/${slug}/autopilot`);
  const help = owner.getByRole("complementary", { name: "Changes" }).getByRole("region", { name: "Help center" });
  await expect(help.getByRole("listitem")).toHaveCount(3);
  // Where the analysis puts them: the first in Billing after Invoices, the next in a new collection; the last says nothing.
  await placeDraft(slug, draft, { collection: "Billing", after: "Invoices" });
  await placeDraft(slug, nextDraft, { newCollection: "Imports", icon: "upload" });
  await expect(help.getByRole("listitem").filter({ hasText: draft })).toContainText("New");
  await help.getByRole("link", { name: draft }).click();
  // Where it goes, with the collection picker on it.
  await expect(owner.getByText("A new article, in Billing, after “Invoices”")).toBeVisible();
  await expect(owner.getByRole("combobox", { name: "Collection" })).toHaveText(/^In Billing, after “Invoices”/);
  // The draft as readers will see it, all of it new: its heading, its list and its bold.
  const view = owner.getByRole("region", { name: "The article" });
  await expect(view.getByRole("deletion")).toHaveCount(0);
  await expect(view.getByRole("insertion").getByRole("heading", { name: "Export it" })).toBeVisible();
  // What changed isn't its pull request's reason (that's in its chip): a draft is all new.
  await expect(owner.getByRole("group", { name: "What changed" })).toHaveCount(0);
  await expect(view.getByRole("insertion").getByRole("listitem")).toHaveText(["Open Settings.", "Pick Export."]);
  // Its steps numbered, as written.
  await expect(view.getByRole("insertion").locator("ol > li")).toHaveCount(2);
  await expect(view.getByRole("insertion").locator("strong")).toHaveText(["Settings", "Export"]);
  // All of it one change: nothing to step between.
  await expect(view.getByText(/of 1$/)).toHaveCount(0);
  await expect(view.getByRole("button", { name: "Next change" })).toHaveCount(0);
  await expect(view.locator('[data-change="0"]')).not.toHaveAttribute("data-current");
  await checkpoint(owner, "autopilot-new-article");
  const page = owner.url();
  // A pick is this draft's only: picked here, the next one opened from the list shows its own place, and back here,
  // this one's (nothing was approved).
  await owner.getByRole("combobox", { name: "Collection" }).click();
  await owner.getByRole("option", { name: "No collection" }).click();
  await expect(owner.getByRole("combobox", { name: "Collection" })).toHaveText(/^No collection/);
  await help.getByRole("link", { name: nextDraft }).click();
  await expect(owner.getByRole("heading", { name: nextDraft, level: 1 })).toBeVisible();
  await expect(owner.getByRole("combobox", { name: "Collection" })).toHaveText(/^In a new collection, Imports/);
  await help.getByRole("link", { name: draft }).click();
  await expect(owner.getByRole("heading", { name: draft, level: 1 })).toBeVisible();
  await expect(owner.getByRole("combobox", { name: "Collection" })).toHaveText(/^In Billing, after “Invoices”/);

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
  // Approve stays at the bottom of the screen.
  await expect(owner.getByRole("button", { name: "Approve as a draft" })).toBeInViewport();
  await checkpoint(owner, "autopilot-phone", { fullPage: false });
  await owner.getByRole("link", { name: "Autopilot", exact: true }).click();
  await expect(phoneList.getByRole("link", { name: draft })).toBeInViewport();

  // Approved: nothing of it waits now, so the next one to review opens, and focus goes to its row in the list.
  await owner.setViewportSize({ width: 1280, height: 720 });
  await owner.goto(page);
  const changesList = owner.getByRole("complementary", { name: "Changes" });
  await owner.getByRole("button", { name: "Approve as a draft" }).click();
  await owner.getByRole("alertdialog", { name: "Approve the draft?" }).getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByText("Draft created")).toBeVisible();
  await expect(owner.getByRole("heading", { name: nextDraft })).toBeVisible();
  // Saved where it said.
  expect(await articlesIn(slug, "Billing")).toEqual(["Invoices", draft, "Refunds"]);
  await expect(changesList.getByRole("tab", { name: "To review 2" })).toHaveAttribute("aria-selected", "true");
  await expect(changesList.getByRole("link", { name: nextDraft })).toBeFocused();
  // The other one opened from the list, then on a phone (no list beside it): dismissing it opens the next again
  // (the same one as before, the list's first), and focus goes to its title.
  await changesList.getByRole("link", { name: lastDraft }).click();
  await expect(owner.getByRole("heading", { name: lastDraft })).toBeVisible();
  // Nowhere said: in no collection, as before.
  await expect(owner.getByText("A new article, in no collection")).toBeVisible();
  await owner.setViewportSize({ width: 390, height: 844 });
  // (Not the toast's own "Dismiss".)
  await owner.getByRole("button", { name: "Dismiss", exact: true }).filter({ hasText: "Dismiss" }).click();
  await owner.getByRole("alertdialog", { name: "Dismiss this draft?" }).getByRole("button", { name: "Dismiss" }).click();
  await expect(owner.locator("[data-sonner-toast]").getByText("Dismissed", { exact: true })).toBeVisible();
  await expect(owner.getByRole("heading", { name: nextDraft, level: 1 })).toBeFocused();
  await owner.setViewportSize({ width: 1280, height: 720 });
  // Then undone, from its pull request's chip: the draft is deleted, and its part says who undid it.
  await owner.goto(page);
  const chip = owner.getByRole("list", { name: "Pull requests" }).getByRole("button", { name: new RegExp(`^PR #${number}:`) });
  await chip.click();
  const part = owner.getByRole("dialog").filter({ hasText: "Its activity" });
  await expect(part).toContainText("Approved by Olive Owner");
  // Undo asks first; cancelled, focus is back on its chip.
  await part.getByRole("button", { name: "Undo" }).click();
  await owner.getByRole("alertdialog", { name: `Undo PR #${number}'s draft?` }).getByRole("button", { name: "Cancel" }).click();
  await expect(chip).toBeFocused();
  await chip.click();
  await part.getByRole("button", { name: "Undo" }).click();
  const undo = owner.getByRole("alertdialog", { name: `Undo PR #${number}'s draft?` });
  await expect(undo).toContainText("The draft is deleted.");
  await checkpoint(owner, "autopilot-undo", { fullPage: false });
  await undo.getByRole("button", { name: "Undo" }).click();
  await expect(owner.locator("[data-sonner-toast]").getByText("Undone", { exact: true })).toBeVisible();
  await expect(owner.getByRole("list", { name: "Pull requests" })).toBeFocused();
  await chip.click();
  await expect(part).toContainText("Undone by Olive Owner");
  await owner.goto(`/app/${slug}/docs`);
  await expect(owner.getByRole("link", { name: draft })).toHaveCount(0);

  // The last one, approved on its page into another collection than the new one it says: drafted, last in Billing, and
  // nothing's left to review.
  await owner.goto(`/app/${slug}/autopilot`);
  await changesList.getByRole("link", { name: nextDraft }).click();
  await expect(owner.getByText("A new article, in a new collection, Imports")).toBeVisible();
  await owner.getByRole("combobox", { name: "Collection" }).click();
  await expect(owner.getByRole("option")).toHaveText(["In a new collection, Imports", "No collection", "Billing"]);
  await checkpoint(owner, "autopilot-new-article-collection", { fullPage: false });
  await owner.getByRole("option", { name: "Billing" }).click();
  await expect(owner.getByRole("combobox", { name: "Collection" })).toHaveText(/^Billing/);
  await owner.getByRole("button", { name: "Approve as a draft" }).click();
  await owner.getByRole("alertdialog", { name: "Approve the draft?" }).getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByText("Draft created")).toBeVisible();
  // (It moves to Reviewed, which the list shows.)
  await expect(changesList.getByRole("tab", { name: "To review 0" })).toBeVisible();
  await changesList.getByRole("tab", { name: "Reviewed" }).click();
  await expect(changesList.getByRole("region", { name: "Help center" }).getByRole("link", { name: nextDraft })).toBeVisible();
  // (The first was undone.) No Imports collection was made.
  expect(await articlesIn(slug, "Billing")).toEqual(["Invoices", "Refunds", nextDraft]);
  expect(await articlesIn(slug, "Imports")).toEqual([]);
});

test("a new article's draft going out by itself says where it goes, with no picker (only Approve takes one)", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/collections", { name: "Billing" });
  await api("/articles", { title: "Invoices", body: "Invoices.", collection: "billing" });
  const id = await scheduledDraft(slug, "Export your data");
  await placeDraft(slug, "Export your data", { collection: "Billing", after: "Invoices" });
  await owner.goto(`/app/${slug}/autopilot/articles/${id}`);
  await expect(owner.getByRole("heading", { name: "Export your data", level: 1 })).toBeVisible();
  await expect(owner.getByText("A new article, in Billing, after “Invoices”")).toBeVisible();
  await expect(owner.getByRole("combobox", { name: "Collection" })).toHaveCount(0);
  await checkpoint(owner, "autopilot-scheduled-draft-place", { fullPage: false });
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
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
  await nextDocsAgentAnswer(number, { summary, edits: [{ slug: articleSlug, probability: 0.97 }] });
  // 97% sure: over the bar, so it goes out by itself after the hold.
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
  // When it goes out is under the title, which keeps its width (no word cut short): on a phone, and beside the sidebar
  // and Autopilot's list at 1024px.
  for (const [width, height] of [[390, 844], [1024, 768]] as const) {
    await owner.setViewportSize({ width, height });
    const articleTitle = (await touched.getByText(article, { exact: true }).boundingBox())!;
    expect((await touched.getByText(/^Goes out tomorrow at \d/).boundingBox())!.y).toBeGreaterThanOrEqual(articleTitle.y + articleTitle.height - 1);
  }
  await checkpoint(owner, "autopilot-activity-scheduled-1024");
  await owner.setViewportSize({ width: 1280, height: 720 });
  await touched.click();
  await expect(owner.getByRole("heading", { name: article, level: 1 })).toBeVisible();
  const articleReview = owner.url();

  // Home says it goes out by itself, with Publish now and Stop; the list and the page say when.
  await owner.goto(`/app/${slug}`);
  const catchUp = owner.getByRole("region", { name: "To review in Autopilot" }).getByRole("listitem").filter({ hasText: article });
  await expect(catchUp).toContainText(/1 update goes out tomorrow at \d/);
  await expect(catchUp.getByRole("button", { name: "Stop" })).toBeVisible();
  // On a phone, Stop, Publish now and Review share the line under it.
  await owner.setViewportSize({ width: 390, height: 844 });
  const widths = await Promise.all(
    [catchUp.getByRole("button", { name: "Stop" }), catchUp.getByRole("button", { name: "Publish now" }), catchUp.getByRole("link", { name: "Review" })].map(
      async (control) => (await control.boundingBox())!.width,
    ),
  );
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(2);
  await checkpoint(owner, "home-scheduled-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  await owner.goto(articleReview);
  await expect(owner.getByRole("complementary", { name: "Changes" }).getByRole("listitem").filter({ hasText: article })).toContainText(/Goes out tomorrow at \d/);
  // The list and the page both say when; its chip's popover says it goes out by itself.
  await expect(owner.getByText(/^Goes out tomorrow at \d/)).toHaveCount(2);
  const chip = owner.getByRole("list", { name: "Pull requests" }).getByRole("button", { name: `PR #${number}: ${pr}` });
  await chip.click();
  const part = owner.getByRole("dialog").filter({ hasText: pr });
  await expect(part).toContainText("Goes out by itself");
  await owner.keyboard.press("Escape");
  // Publish now, Stop, and Dismiss beside them (it needn't wait to be taken out).
  await expect(owner.getByRole("button", { name: "Publish now" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Stop" })).toBeVisible();
  // (Not the email banner's own "Dismiss".)
  await expect(owner.getByRole("button", { name: "Dismiss", exact: true }).filter({ hasText: "Dismiss" })).toBeVisible();
  await checkpoint(owner, "autopilot-scheduled");

  // The hold passes (the minute, run by hand): checked again, it goes out, as Autopilot's own.
  // (It runs for every project, journeys running beside this one too: what it did here is checked below.)
  await runAutopilot(slug, { dueNow: true });
  await owner.reload();
  await chip.click();
  await expect(part).toContainText("Published by Autopilot");
  const portalArticle = await owner.context().newPage();
  await portalArticle.goto(`${portalUrl(slug)}/docs/${articleSlug}`);
  await expect(portalArticle.getByText("Pick Light, Dark or System in Settings.")).toBeVisible();
  await portalArticle.close();
});

test("updates going out by themselves: Dismiss beside Stop on an article's and a post's; stopped, each says who and when it would have gone out", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
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
  const users = { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 };
  // (Every post there is gets asked about: each pull request leaves the others as they are.)
  const leaves = { post: { effect: { resolves: 0.01, moves_forward: 0.01, related: 0.01, unrelated: 0.97 } } };

  // An article's edit, sure of it (97%): it goes out by itself after the hold.
  const pr = `Add a dark theme ${id}`;
  const summary = `You can now switch to a dark theme in Settings (${id}).`;
  await nextDecision({ audience: users }, pr);
  await nextDocsAgentAnswer(number, { summary, edits: [{ slug: articleSlug, probability: 0.97 }] });
  await nextModelReply(JSON.stringify({ reason: "It says Light is the only theme.", sections: { "1": "Pick Light, **Dark** or System in Settings." } }), article);
  await nextModelReply(JSON.stringify({ why: "", changelog: "Dark theme", proposals: {} }), pr);
  await mergePullRequest(installationId, { number, title: pr });
  // Two posts' progress updates, sure of them too: they go out by themselves as well.
  const posts = [`Recurring events ${id}`, `Week numbers ${id}`];
  for (const [i, title] of posts.entries()) {
    await api("/posts", { board: "feature-requests", title });
    // (Neither names the post: each decision is scripted by what its own request holds.)
    const next = `Calendar update ${i + 1} ${id}`;
    const nextSummary = `Calendar update ${i + 1} is out (${id}).`;
    await similar(nextSummary, title, 0.95);
    await nextDecision({ audience: users }, next);
    await nextDocsAgentAnswer(number + 1 + i, { summary: nextSummary });
    await nextDecision({ effect: { resolves: 0.01, moves_forward: 0.97, related: 0.01, unrelated: 0.01 } }, title);
    for (const other of posts.slice(0, i)) {
      await nextDecision(leaves.post, other);
    }
    await nextModelReply(JSON.stringify({ why: "", changelog: next, proposals: { p1: { reason: `${title} is out.`, comment: `${title} are out.` } } }), next);
    await mergePullRequest(installationId, { number: number + 1 + i, title: next });
  }
  await runAutopilot(slug);
  const list = owner.getByRole("complementary", { name: "Changes" });
  // (Its own row, not its board's, which holds it.)
  const rowOf = (title: string) => list.getByRole("listitem").filter({ hasText: title }).last();
  // (The bars' own Dismiss, not the email banner's.)
  const dismiss = () => owner.getByRole("button", { name: "Dismiss", exact: true }).filter({ hasText: "Dismiss" });

  // The article's: when it goes out, with Dismiss beside Stop and Publish now. Stopped, its bar says who stopped it and
  // when it would have gone out, beside Approve; its row says who.
  await owner.goto(`/app/${slug}/autopilot`);
  await list.getByRole("link", { name: article }).click();
  await expect(owner.getByRole("heading", { name: article, level: 1 })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Publish now" })).toBeVisible();
  await expect(dismiss()).toBeVisible();
  await checkpoint(owner, "autopilot-scheduled-dismiss");
  await owner.getByRole("button", { name: "Stop" }).click();
  await expect(owner.getByRole("button", { name: "Approve and publish" })).toBeVisible();
  await expect(owner.getByText(/^Stopped by Olive Owner · would have gone out tomorrow at \d/)).toBeVisible();
  await expect(rowOf(article)).toContainText("Stopped by Olive Owner");
  await expect(rowOf(article)).not.toContainText("Goes out");

  // A post's, stopped: its card says so.
  await list.getByRole("link", { name: posts[0]! }).click();
  await expect(owner.getByRole("heading", { name: posts[0]!, level: 1 })).toBeVisible();
  await owner.getByRole("button", { name: "Stop" }).click();
  await expect(owner.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  const happens = owner.getByRole("region", { name: "What happens to the post" });
  await expect(happens.getByText(/^Stopped by Olive Owner · would have gone out tomorrow at \d/)).toBeVisible();
  await expect(rowOf(posts[0]!)).toContainText("Stopped by Olive Owner");
  await checkpoint(owner, "autopilot-stopped");

  // The other post's, dismissed from its bar (asking why, as Dismiss does): it's gone from To review.
  await list.getByRole("link", { name: posts[1]! }).click();
  await expect(owner.getByRole("heading", { name: posts[1]!, level: 1 })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Stop" })).toBeVisible();
  const why = owner.getByRole("dialog").filter({ has: owner.getByRole("textbox", { name: "Why not? (optional)" }) });
  // On a phone, its popover keeps its own width beside the bar's small Dismiss (once it has zoomed in).
  await owner.setViewportSize({ width: 390, height: 844 });
  await dismiss().click();
  await expect.poll(async () => (await why.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(280);
  await checkpoint(owner, "autopilot-scheduled-dismiss-phone", { fullPage: false });
  await owner.keyboard.press("Escape");
  await expect(why).toBeHidden();
  await owner.setViewportSize({ width: 1280, height: 720 });
  await dismiss().click();
  await why.getByRole("button", { name: "Dismiss" }).click();
  await expect(owner.locator("[data-sonner-toast]").getByText("Dismissed", { exact: true })).toBeVisible();
  await expect(list.getByRole("tab", { name: "To review 2" })).toBeVisible();
});

test("an article approved on its page, with the keyboard, when nothing else waits: focus stays on the page, on its pull requests", async ({ browser }) => {
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
  const pr = `Add a dark theme ${id}`;
  const summary = `You can now switch to a dark theme in Settings (${id}).`;
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
  await nextDocsAgentAnswer(number, { summary, edits: [{ slug: articleSlug, probability: 0.92 }] });
  // Under the bar: it waits for the team.
  await nextModelReply(JSON.stringify({ reason: "It says Light is the only theme.", sections: { "1": "Pick Light, **Dark** or System in Settings." } }), article);
  await nextModelReply(JSON.stringify({ why: "", changelog: "Dark theme", proposals: {} }), pr);
  await mergePullRequest(installationId, { number, title: pr });

  await owner.goto(`/app/${slug}/autopilot`);
  await owner.getByRole("complementary", { name: "Changes" }).getByRole("link", { name: article }).click();
  await expect(owner.getByRole("heading", { name: article, level: 1 })).toBeVisible();
  await owner.getByRole("button", { name: "Approve and publish" }).focus();
  await owner.keyboard.press("Enter");
  const confirm = owner.getByRole("alertdialog", { name: `Publish “${article}”?` });
  await confirm.getByRole("button", { name: "Publish" }).focus();
  // The page comes back slowly (as under load, a minute later here): focus still goes where it's asked.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await owner.route("**/*", async (route) => {
    const headers = route.request().headers();
    if (headers.rsc && !headers["next-action"] && !headers["next-router-prefetch"]) {
      await held;
    }
    await route.fallback();
  });
  await owner.keyboard.press("Enter");
  await expect(owner.locator("[data-sonner-toast]").getByText("Published", { exact: true })).toBeVisible();
  await owner.clock.setFixedTime(Date.now() + 60_000);
  release();
  // The bar and its button are gone: focus is on the pull requests' chip row, whose popovers say it went.
  await expect(owner.getByRole("button", { name: "Approve and publish" })).toHaveCount(0);
  await owner.unrouteAll({ behavior: "ignoreErrors" });
  const chips = owner.getByRole("list", { name: "Pull requests" });
  await expect(chips).toBeFocused();
  await owner.keyboard.press("Tab");
  await expect(chips.getByRole("button", { name: `PR #${number}: ${pr}` })).toBeFocused();
  await owner.keyboard.press("Enter");
  await expect(owner.getByRole("dialog").filter({ hasText: pr })).toContainText("Approved by Olive Owner");
  await owner.keyboard.press("Escape");

  // A teammate's edit published since: the Article view is the article as it is now, while Changes still show what
  // Autopilot's edit changed.
  await api(`/articles/${articleSlug}`, { body: "Pick Light, Dark or System in Settings.\n\nAsk us anything.", publish: true }, "PATCH");
  await owner.reload();
  const view = owner.getByRole("region", { name: "The article" });
  await expect(view.getByRole("deletion").filter({ hasText: "Pick Light in Settings." })).toBeVisible();
  await expect(view.getByText("Ask us anything.")).toHaveCount(0);
  await view.getByRole("tab", { name: "Article" }).click();
  await expect(view.getByText("Ask us anything.")).toBeVisible();

  // Had Autopilot published it by itself and couldn't tell whether it went: the page says to check, crediting nobody.
  await markUnsure(slug, "ARTICLE_EDIT");
  await owner.reload();
  const happened = owner.getByRole("region", { name: "What happened" });
  await expect(happened).toContainText("Couldn't tell whether it went out: check the article before doing it again.");
  await expect(happened).not.toContainText("approved by");
});

test("a pull request's edit to a draft: the review shows what it changes in the draft, and Approve keeps it there, still a draft", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
  const number = randomInt(1_000, 1_000_000);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  // A draft the team is writing, never published.
  const draft = `Themes ${id}`;
  const { slug: draftSlug } = await api("/articles", { title: draft, body: "Pick Light in Settings.\n\nThemes apply at once." });
  const installationId = await connectGithub(owner, slug);
  const pr = `Add a dark theme ${id}`;
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
  await nextDocsAgentAnswer(number, { summary: `You can now switch to a dark theme in Settings (${id}).`, edits: [{ slug: draftSlug, probability: 0.92 }] });
  await nextModelReply(JSON.stringify({ reason: "It says Light is the only theme.", sections: { "1": "Pick Light or **Dark** in Settings.\n\nThemes apply at once." } }), draft);
  await nextModelReply(JSON.stringify({ why: "", changelog: "Dark theme", proposals: {} }), pr);
  await mergePullRequest(installationId, { number, title: pr });

  await owner.goto(`/app/${slug}/autopilot`);
  await owner.getByRole("complementary", { name: "Changes" }).getByRole("link", { name: draft }).click();
  await expect(owner.getByRole("heading", { name: draft, level: 1 })).toBeVisible();
  // What the edit changes in the draft, not all of the draft as new.
  const view = owner.getByRole("region", { name: "The article" });
  await expect(view.getByRole("deletion").filter({ hasText: "Pick Light in Settings." })).toBeVisible();
  await expect(view.getByRole("insertion").first().locator("strong")).toHaveText("Dark");
  await expect(owner.getByRole("button", { name: "Approve and publish" })).toHaveCount(0);
  await checkpoint(owner, "autopilot-draft-edit");
  await owner.getByRole("button", { name: "Approve", exact: true }).click();
  const confirm = owner.getByRole("alertdialog", { name: "Approve this edit?" });
  await expect(confirm).toContainText("It stays in the draft, which only your team sees until it's published from Docs.");
  await checkpoint(owner, "autopilot-draft-edit-confirm");
  await confirm.getByRole("button", { name: "Approve" }).click();
  await expect(owner.locator("[data-sonner-toast]").getByText("Approved", { exact: true })).toBeVisible();
  // Still a draft, with the edit in it.
  const saved = (await api(`/articles/${draftSlug}`, undefined, "GET")) as { status: string; body: string };
  expect(saved).toMatchObject({ status: "draft" });
  expect(saved.body).toContain("Pick Light or Dark in Settings.");
});

test("an editor open as Autopilot's edit lands: saving the same paragraph is refused, the teammate's text kept with the newest beside it; saved again, theirs goes on top", async ({ browser }, testInfo) => {
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

  // The teammate opens the editor and rewrites the paragraph…
  await owner.goto(`/app/${slug}/docs/${articleSlug}`);
  const editor = owner.getByRole("textbox", { name: "Article" });
  await expect(editor).toContainText("Pick Light in Settings.");
  await editor.click();
  await owner.keyboard.press("ControlOrMeta+a");
  await owner.keyboard.type("Pick a theme from the menu in the corner.");

  // …while a pull request's edit to the same paragraph lands in the article's unpublished changes.
  const pr = `Add a dark theme ${id}`;
  const summary = `You can now switch to a dark theme in Settings (${id}).`;
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
  await nextDocsAgentAnswer(number, { summary, edits: [{ slug: articleSlug, probability: 0.92 }] });
  await nextModelReply(JSON.stringify({ reason: "It says Light is the only theme.", sections: { "1": "Pick Light, **Dark** or System in Settings." } }), article);
  await nextModelReply(JSON.stringify({ why: "", changelog: "Dark theme", proposals: {} }), pr);
  await mergePullRequest(installationId, { number, title: pr });

  // The page shows the article as now saved (opening its History re-renders it): their unsaved text stays, and the
  // editor says it was saved since.
  await owner.getByRole("button", { name: "More actions" }).click();
  await owner.getByRole("link", { name: "History" }).click();
  await expect(owner.getByRole("dialog", { name: "History" })).toBeVisible();
  await owner.keyboard.press("Escape");
  await expect(owner.getByRole("dialog", { name: "History" })).toBeHidden();
  await expect(editor).toContainText("Pick a theme from the menu in the corner.");
  await expect(owner.getByText("It was saved since you opened it. Your text is kept")).toBeVisible();
  // …then saves: refused, their text still there, the newest shown beside it.
  await owner.getByRole("button", { name: "Save", exact: true }).filter({ visible: true }).click();
  await expect(owner.getByText("Autopilot changed the same part of the article since you opened it. Your text is kept")).toBeVisible();
  await expect(editor).toContainText("Pick a theme from the menu in the corner.");
  const newest = owner.getByRole("region", { name: "The newest version, with Autopilot's edit" });
  await expect(newest).toContainText("Pick Light, Dark or System in Settings.");
  // Its text scrolls in a box the keyboard reaches.
  const box = newest.getByRole("region", { name: "Its text" });
  await box.focus();
  await expect(box).toBeFocused();
  await checkpoint(owner, "autopilot-editor-refused");

  // Merged by hand, saved again: it goes on top of the newest.
  await editor.click();
  await owner.keyboard.press("ControlOrMeta+End");
  await owner.keyboard.type(" Dark is there too.");
  await owner.getByRole("button", { name: "Save", exact: true }).filter({ visible: true }).click();
  await expect(owner.getByText("Saved", { exact: true })).toBeVisible();
  await expect(editor).toContainText("Pick a theme from the menu in the corner. Dark is there too.");
  await expect(newest).toHaveCount(0);
});

test("restoring an earlier version while a pull request's edit waits: it says first which edit it takes out, then dismisses it", async ({ browser }, testInfo) => {
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
  const pr = `Add a dark theme ${id}`;
  const summary = `You can now switch to a dark theme in Settings (${id}).`;
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
  await nextDocsAgentAnswer(number, { summary, edits: [{ slug: articleSlug, probability: 0.92 }] });
  await nextModelReply(JSON.stringify({ reason: "It says Light is the only theme.", sections: { "1": "Pick Light, **Dark** or System in Settings." } }), article);
  await nextModelReply(JSON.stringify({ why: "", changelog: "Dark theme", proposals: {} }), pr);
  await mergePullRequest(installationId, { number, title: pr });

  // The version before the edit, from the article's history.
  await owner.goto(`/app/${slug}/docs/${articleSlug}?history`);
  const history = owner.getByRole("dialog", { name: "History" });
  const versions = history.getByRole("link", { name: /^Saved / });
  await expect(versions).toHaveCount(2);
  await versions.nth(1).click();
  await owner.getByRole("button", { name: "Restore this version" }).click();
  const restoring = owner.getByRole("alertdialog", { name: "Restore this version?" });
  await restoring.getByRole("button", { name: "Restore", exact: true }).click();
  // It takes out the pull request's edit: said first, by name.
  await expect(restoring).toContainText(`Restoring this version takes out PR #${number}'s edit, which waits in the unpublished changes: it's dismissed if you restore it`);
  await checkpoint(owner, "autopilot-restore-takes-out", { fullPage: false });
  await restoring.getByRole("button", { name: "Restore and dismiss" }).click();
  await expect(owner.getByText("Version restored")).toBeVisible();
  await expect(owner.getByRole("textbox", { name: "Article" })).toContainText("Pick Light in Settings.");

  // Autopilot's review says it was dismissed, and why.
  await owner.goto(`/app/${slug}/autopilot`);
  await owner.getByRole("complementary", { name: "Changes" }).getByRole("tab", { name: "Reviewed" }).click();
  await owner.getByRole("complementary", { name: "Changes" }).getByRole("link", { name: article }).click();
  await owner.getByRole("list", { name: "Pull requests" }).getByRole("button", { name: new RegExp(`^PR #${number}:`) }).click();
  await expect(owner.getByRole("dialog").filter({ hasText: "Its activity" })).toContainText("Dismissed by Olive Owner: Taken out by restoring an earlier version");
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
  await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
  await nextDocsAgentAnswer(number, { summary, edits: [{ slug: articleSlug, probability: 0.92 }] });
  await nextDecision({ effect: { resolves: 0.05, moves_forward: 0.9, related: 0.04, unrelated: 0.01 } }, title);
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
  await expect(elsewhere.getByText(`Approved: Progress update: ${title}. Undo it from its pull request's chip.`)).toBeVisible();
  await checkpoint(elsewhere, "autopilot-email-approved");
  // Signed in now, the next one acts at once; clicked again, it says it's done and does nothing.
  await elsewhere.goto(approves[1]!);
  await expect(elsewhere.getByText(`Approved: Out of date: ${article}. Undo it from its pull request's chip.`)).toBeVisible();
  await elsewhere.goto(approves[1]!);
  await expect(elsewhere.getByText(`Done already: Out of date: ${article} was approved by Olive Owner`, { exact: false })).toBeVisible();

  // The post is in progress with the update, and the portal has the article's new version.
  await elsewhere.goto(`/app/${slug}/p/1`);
  await expect(elsewhere.getByRole("combobox", { name: "Status" })).toContainText("In progress");
  await expect(elsewhere.getByText("Dark mode is on its way: the theme is in Settings now.")).toBeVisible();
  await elsewhere.goto(`${portalUrl(slug)}/docs/${articleSlug}`);
  await expect(elsewhere.getByText("Pick Light, Dark or System in Settings.")).toBeVisible();
});

test("pull requests' progress updates on one post are one update: its status change and one comment, each one's part in its chip, approved once, undone whole, dismissed whole", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
  const number = randomInt(1_000, 1_000_000);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const title = `Recurring events ${id}`;
  await api("/posts", { board: "feature-requests", title });
  const installationId = await connectGithub(owner, slug);

  // Each pull request moves the post forward, under the bar (95%): they wait for the team, as one update.
  const parts = [
    { number, pr: `Weekly repeats ${id}`, comment: "Weekly repeats are out: pick Repeat on any event." },
    { number: number + 1, pr: `Monthly repeats ${id}`, comment: "Monthly repeats are out too. Yearly ones are next." },
  ];
  const land = async (part: { number: number; pr: string; comment: string }) => {
    const summary = `You can now repeat events (${part.pr}).`;
    await similar(summary, title, 0.95);
    await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, part.pr);
    await nextDocsAgentAnswer(part.number, { summary });
    await nextDecision({ effect: { resolves: 0.05, moves_forward: 0.9, related: 0.04, unrelated: 0.01 } }, title);
    await nextModelReply(JSON.stringify({ why: "", changelog: part.pr, proposals: { p1: { reason: `${part.pr} is part of it.`, comment: part.comment } } }), part.pr);
    await mergePullRequest(installationId, { number: part.number, title: part.pr, files: [{ filename: "src/repeat.ts", patch: "+export const repeat = true;" }] });
  };
  for (const part of parts) {
    await land(part);
  }

  // The post's review: both pull requests' chips, and what happens to the post: its status change and one comment, both
  // pull requests' joined. No list of updates to pick from.
  await owner.goto(`/app/${slug}/autopilot`);
  const list = owner.getByRole("complementary", { name: "Changes" });
  await expect(list.getByRole("tab", { name: "To review 1" })).toBeVisible();
  await list.getByRole("link", { name: title }).click();
  await expect(owner.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  const chips = owner.getByRole("list", { name: "Pull requests" });
  await expect(chips.getByRole("button", { name: /^PR #/ })).toHaveCount(2);
  const happens = owner.getByRole("region", { name: "What happens to the post" });
  await expect(happens).toContainText("Open → In progress");
  const box = happens.getByRole("textbox", { name: "Progress update on #1" });
  await expect(box).toHaveValue(`${parts[0]!.comment}\n\n${parts[1]!.comment}`);
  await expect(owner.getByRole("checkbox")).toHaveCount(0);
  await expect(owner.getByRole("navigation", { name: "Updates" })).toHaveCount(0);
  // Each pull request's part is in its chip.
  await chips.getByRole("button", { name: `PR #${number + 1}: ${parts[1]!.pr}` }).click();
  await expect(owner.getByRole("dialog").filter({ hasText: parts[1]!.pr })).toContainText(`${parts[1]!.pr} is part of it.`);
  await owner.keyboard.press("Escape");

  // A third pull request's part lands; the comment edited, then that part dismissed from its chip: the comment is the
  // two left's again, not the words edited while the third was in it.
  const third = { number: number + 2, pr: `Yearly repeats ${id}`, comment: "Yearly repeats are out." };
  await land(third);
  await owner.reload();
  await expect(chips.getByRole("button", { name: /^PR #/ })).toHaveCount(3);
  await expect(box).toHaveValue(`${parts[0]!.comment}\n\n${parts[1]!.comment}\n\n${third.comment}`);
  await checkpoint(owner, "post-update-three-prs");
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "post-update-three-prs-dark");
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "post-update-three-prs-phone-dark");
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "post-update-three-prs-phone");
  // A chip's popover keeps clear of the screen's edges.
  await chips.getByRole("button", { name: `PR #${third.number}: ${third.pr}` }).click();
  // Measured once it has zoomed in (a transform: a box mid-animation is smaller).
  const settled = (dialog: Locator) => dialog.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  const chipPopover = owner.getByRole("dialog").filter({ hasText: third.pr });
  await settled(chipPopover);
  const popover = (await chipPopover.boundingBox())!;
  expect(popover.x).toBeGreaterThanOrEqual(16);
  expect(popover.x + popover.width).toBeLessThanOrEqual(390 - 16);
  await owner.keyboard.press("Escape");
  // Dismiss's opens in its place, as wide as it, over neither of the bar's buttons.
  const dismissButton = owner.getByRole("button", { name: "Dismiss", exact: true }).and(owner.locator("[aria-haspopup]"));
  await dismissButton.click();
  const reason = owner.getByRole("dialog").filter({ has: owner.getByRole("textbox", { name: "Why not? (optional)" }) });
  await settled(reason);
  const [button, opened] = [(await dismissButton.boundingBox())!, (await reason.boundingBox())!];
  expect(opened.width).toBeGreaterThanOrEqual(button.width - 1);
  expect(opened.y + opened.height).toBeLessThanOrEqual(button.y + 1);
  await checkpoint(owner, "post-dismiss-phone", { fullPage: false });
  await owner.keyboard.press("Escape");
  await owner.setViewportSize({ width: 1280, height: 720 });
  await box.fill("Edited while the yearly part was in it.");
  await chips.getByRole("button", { name: `PR #${third.number}: ${third.pr}` }).click();
  await owner.getByRole("dialog").filter({ hasText: third.pr }).getByRole("button", { name: "Dismiss" }).click();
  await expect(owner.locator("[data-sonner-toast]").getByText("Dismissed", { exact: true })).toBeVisible();
  await expect(box).toHaveValue(`${parts[0]!.comment}\n\n${parts[1]!.comment}`);

  // Approved once: one comment, both pull requests linked, both parts done (each chip says so; the third's, Dismissed).
  await owner.getByRole("button", { name: "Approve", exact: true }).click();
  await owner.getByRole("alertdialog", { name: "Approve the update?" }).getByRole("button", { name: "Approve" }).click();
  await expect(owner.getByText("Approved", { exact: true })).toBeVisible();
  const happened = owner.getByRole("region", { name: "What happened" });
  await expect(happened).toContainText("In progress · approved by Olive Owner");
  await expect(happened).toContainText(`The team's comment: “${parts[0]!.comment}\n\n${parts[1]!.comment}”`);
  const first = chips.getByRole("button", { name: `PR #${number}: ${parts[0]!.pr}` });
  await first.click();
  await expect(owner.getByRole("dialog").filter({ hasText: parts[0]!.pr })).toContainText("Approved by Olive Owner");
  await owner.keyboard.press("Escape");
  await owner.goto(`/app/${slug}/p/1`);
  await expect(owner.getByRole("combobox", { name: "Status" })).toContainText("In progress");
  await expect(owner.getByText(parts[0]!.comment)).toHaveCount(1);
  await expect(owner.getByText(parts[1]!.comment)).toHaveCount(1);
  for (const part of parts) {
    await expect(owner.getByRole("link", { name: new RegExp(`#${part.number} · ${part.pr}`) })).toBeVisible();
  }

  // Undo, on the page, says first it puts back all of it, for both pull requests. Cancelled, focus goes back to Undo.
  await owner.goBack();
  await happened.getByRole("button", { name: "Undo" }).click();
  await owner.getByRole("alertdialog", { name: /^Undo PR #\d+'s update\?$/ }).getByRole("button", { name: "Cancel" }).click();
  await expect(happened.getByRole("button", { name: "Undo" })).toBeFocused();
  await happened.getByRole("button", { name: "Undo" }).click();
  const undo = owner.getByRole("alertdialog", { name: /^Undo PR #\d+'s update\?$/ });
  await expect(undo).toContainText("It went out as one update with 1 other pull request's part: all of it is undone.");
  await checkpoint(owner, "post-update-undo", { fullPage: false });
  await undo.getByRole("button", { name: "Undo" }).click();
  // (Its toast says Undone, as the page does.)
  await expect(happened).toContainText("Undone · by Olive Owner");
  await expect(happened.getByRole("button", { name: "Undo" })).toHaveCount(0);
  // Its button gone with the refresh, focus is on the pull requests' chip row (as after a chip's Undo), not lost.
  await expect(chips).toBeFocused();
  await owner.goto(`/app/${slug}/p/1`);
  await expect(owner.getByRole("combobox", { name: "Status" })).toContainText("Open");
  await expect(owner.getByText(parts[0]!.comment)).toHaveCount(0);

  // Two more pull requests' parts, dismissed whole from the bar (with why): every part, each chip saying so.
  const more = [
    { number: number + 3, pr: `Daily repeats ${id}`, comment: "Daily repeats are out." },
    { number: number + 4, pr: `Custom repeats ${id}`, comment: "Custom repeats are out." },
  ];
  for (const part of more) {
    await land(part);
  }
  await owner.goto(`/app/${slug}/autopilot`);
  await list.getByRole("link", { name: title }).click();
  await expect(happens.getByRole("textbox", { name: "Progress update on #1" })).toHaveValue(`${more[0]!.comment}\n\n${more[1]!.comment}`);
  // The bar's (a toast's close button is named Dismiss too).
  await owner.getByRole("button", { name: "Dismiss", exact: true }).and(owner.locator("[aria-haspopup]")).click();
  const why = owner.getByRole("dialog").filter({ has: owner.getByRole("textbox", { name: "Why not? (optional)" }) });
  await why.getByRole("textbox", { name: "Why not? (optional)" }).fill("Not this time");
  // Its confirm is an outline button: beside Approve, the one green button stays going ahead.
  await checkpoint(owner, "autopilot-post-dismiss", { fullPage: false });
  await why.getByRole("button", { name: "Dismiss" }).click();
  await expect(happened).toContainText("Dismissed · by Olive Owner");
  await expect(happened).toContainText("Why: Not this time");
  await expect(happened).toContainText("The post is Open.");
  await expect(list.getByRole("listitem").filter({ has: owner.getByRole("link", { name: title }) }).last()).toContainText(/Dismissed.*Dismissed by Olive/);
  await checkpoint(owner, "post-update-dismissed");
  for (const part of more) {
    await chips.getByRole("button", { name: `PR #${part.number}: ${part.pr}` }).click();
    await expect(owner.getByRole("dialog").filter({ hasText: part.pr })).toContainText("Dismissed by Olive Owner: Not this time");
    await owner.keyboard.press("Escape");
  }
});
