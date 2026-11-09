import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, backToPortal, createProject, fillSignUp, postFeedback, signInWithPassword, signUp } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";
import { similar } from "./openai";

test("a portal post: the team's reply stands out, its status history and voters; signed out, a bar to sign in; signed in, the comment box keeps what was written", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  // Ada posts, Bo votes for it.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, "Dark mode");
  await postFeedback(ada, "Offline mode");
  const bo = await signUp(browser, portalUrl(slug), "Bo");
  await bo.goto("/feedback/feature-requests/dark-mode-1");
  await bo.getByRole("button", { name: "Upvote" }).click();
  await expect(bo.getByRole("button", { name: "Upvoted" })).toHaveText("Upvoted2");

  // The team answers and plans it.
  await team.goto(`/app/${slug}/p/1`);
  await team.getByRole("textbox", { name: "Comment" }).fill("Thanks! We're on it.");
  await team.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(team.getByText("Thanks! We're on it.")).toBeVisible();
  await team.getByLabel("Status").click();
  await team.getByRole("option", { name: "Planned" }).click();
  await expect(team.getByText("Status: Planned")).toBeVisible();
  // And says when they expect it (the key's page is on the way: back to the post after).
  // A year from now: always still to come (a month that's passed isn't shown).
  const eta = new Date(Date.UTC(new Date().getUTCFullYear() + 1, new Date().getUTCMonth()));
  const expected = `Expected ${eta.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}`;
  await (await apiFor(team, slug))("/posts/1", { eta: eta.toISOString().slice(0, 7) }, "PATCH");
  await team.goto(`/app/${slug}/p/1`);

  // Someone signed out opens it, at desktop and phone widths, light and dark.
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
      const visitor = await (await browser.newContext({ baseURL: portalUrl(slug), viewport, colorScheme })).newPage();
      await visitor.goto("/feedback/feature-requests/dark-mode-1");
      const activity = visitor.getByRole("region", { name: "Comments" });
      // The team's reply: "Team" by the name, on a tint.
      const reply = activity.getByRole("listitem").filter({ hasText: "Thanks! We're on it." });
      await expect(reply.getByText("Team", { exact: true })).toBeVisible();
      await expect(reply.locator(":scope > div").first()).not.toHaveCSS("background-image", "none");
      // Its status history, after the reply: the change and when, not who made it.
      await expect(activity.getByRole("listitem").last()).toHaveText(/^Moved to Planned · /);
      // When the team expects it, beside its status.
      await expect(visitor.getByRole("article").getByText(expected, { exact: true })).toBeVisible();
      // Who wants it: their faces (Bo's, the latest, first) and how many.
      const voters = visitor.getByRole("group", { name: "Voters" });
      await expect(voters.locator('[data-slot="avatar"]')).toHaveText(["B", "A"]);
      // Legible: initials (the portal's one neutral style), overlapping by no more than their 2px ring, so no letter is cut.
      const faces = voters.locator('[data-slot="avatar"]');
      await expect(faces.locator('[data-slot="avatar-fallback"]').first()).toHaveClass(/bg-avatar-/);
      const [front, behind] = [(await faces.nth(0).boundingBox())!, (await faces.nth(1).boundingBox())!];
      expect(behind.x - front.x).toBeGreaterThanOrEqual(front.width - 2);
      // "want this" beside the faces; the whole sentence for screen readers.
      await expect(voters.getByText("want this", { exact: true })).toBeVisible();
      await expect(voters.getByText("2 people want this", { exact: true })).toHaveClass(/sr-only/);
      await expect(voters).toContainText("2 people want this");
      // No comment box: one bar to sign in, above the thread.
      await expect(visitor.getByRole("textbox", { name: "Comment" })).toHaveCount(0);
      await expect(visitor.getByRole("heading", { name: "Join the conversation" })).toBeVisible();
      // Nothing wider than the screen.
      expect(await visitor.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await checkpoint(visitor, `portal-post-signed-out-${name}-${colorScheme}`);
      await visitor.context().close();
    }
  }

  // The bar's Sign in comes back to the post: an account is made on the app, and back.
  const visitor = await (await browser.newContext({ baseURL: portalUrl(slug) })).newPage();
  await visitor.goto("/feedback/feature-requests/dark-mode-1");
  await visitor.getByRole("main").getByRole("link", { name: "Sign in", exact: true }).click();
  await visitor.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("next") === "/feedback/feature-requests/dark-mode-1");
  await visitor.getByRole("link", { name: "Create an account" }).click();
  await fillSignUp(visitor, "Cy", `e2e-${randomUUID()}@example.com`);
  await visitor.waitForURL((url) => url.pathname === "/continue");
  await backToPortal(visitor);
  await visitor.waitForURL("**/feedback/feature-requests/dark-mode-1");
  const box = visitor.getByRole("textbox", { name: "Comment" });
  await expect(box).toHaveText("");
  await expect(visitor.getByRole("heading", { name: "Join the conversation" })).toHaveCount(0);

  // What's written is kept in this tab, through a reload, only in that post's box.
  await expect(async () => {
    await box.fill("Me too, please!");
    await expect(box).toHaveText("Me too, please!", { timeout: 1000 });
  }).toPass();
  await expect
    .poll(() => visitor.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("tuti:comment-draft:")).length))
    .toBe(1);
  await visitor.reload();
  await expect(box).toHaveText("Me too, please!");
  await visitor.goto("/feedback/feature-requests/offline-mode-2");
  await expect(box).toBeVisible();
  await expect(box).toHaveText("");
  await visitor.goto("/feedback/feature-requests/dark-mode-1");
  await expect(box).toHaveText("Me too, please!");
  // Emptied (as a person does: all selected, then deleted), it's thrown away.
  await box.click();
  await visitor.keyboard.press("ControlOrMeta+A");
  await visitor.keyboard.press("Backspace");
  await expect(box).toHaveText("");
  await expect
    .poll(() => visitor.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("tuti:comment-draft:")).length))
    .toBe(0);
  await visitor.reload();
  await expect(box).toBeVisible();
  await expect(box).toHaveText("");

  // Never in the team's reply box, even in a tab where the app and the portal share storage.
  const postId = await team.locator('input[name="postId"]').first().inputValue();
  await team.evaluate(
    (key) => sessionStorage.setItem(key, JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Never mind" }] }] })),
    `tuti:comment-draft:${postId}`,
  );
  await team.reload();
  await expect(team.getByRole("textbox", { name: "Comment" })).toBeVisible();
  await expect(team.getByRole("textbox", { name: "Comment" })).toHaveText("");

  // Written again and sent: posted, and not kept any more.
  await expect(async () => {
    await box.fill("Me too, please!");
    await expect(box).toHaveText("Me too, please!", { timeout: 1000 });
  }).toPass();
  await visitor.getByRole("button", { name: "Comment", exact: true }).click();
  const mine = visitor.getByRole("region", { name: "Comments" }).getByRole("listitem").filter({ hasText: "Me too, please!" });
  await expect(mine).toBeVisible();
  // Not the team's: no tint, no badge.
  await expect(mine).toHaveCSS("background-image", "none");
  await expect(mine.getByText("Team", { exact: true })).toHaveCount(0);
  await expect(box).toHaveText("");
  await visitor.reload();
  await expect(box).toBeVisible();
  await expect(box).toHaveText("");
  await checkpoint(visitor, "portal-post-commented");
});

test("a portal post: Subscribe, for people who don't vote, and they hear when it ships; similar ideas under it", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const run = randomUUID().slice(0, 6); // the fake's vectors are shared by parallel journeys
  const dark = `Dark mode ${run}`;
  const night = `Night theme for the editor ${run}`;
  // Other words, the same idea: only embeddings tell.
  await similar(dark, night, 0.8);
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto(linkIn(await latestEmailTo(ada.email), "http"));
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, dark);
  await postFeedback(ada, night);
  await postFeedback(ada, "Export invoices");

  // Signed out, Subscribe asks to sign in first.
  const visitor = await (await browser.newContext({ baseURL: portalUrl(slug) })).newPage();
  await visitor.goto("/feedback/feature-requests");
  await visitor.getByRole("link", { name: dark }).click();
  await expect(visitor.getByRole("heading", { level: 1 })).toHaveText(dark);
  const darkPath = new URL(visitor.url()).pathname;
  await visitor.getByRole("link", { name: "Subscribe" }).click();
  await expect(visitor).toHaveURL((url) => url.pathname === "/sign-in" && url.searchParams.get("next") === darkPath);
  // So does the vote button, and signing in comes back to the post.
  await visitor.goBack();
  await visitor.getByRole("link", { name: "Upvote (1 vote), sign in to vote" }).click();
  await expect(visitor).toHaveURL((url) => url.pathname === "/sign-in" && url.searchParams.get("next") === darkPath);
  await signInWithPassword(visitor, ada.email);
  await visitor.waitForURL((url) => url.pathname === darkPath);
  await expect(visitor.getByRole("button", { name: "Upvoted (1 vote)" })).toBeVisible();
  await visitor.context().close();

  // Ada (email verified) posted it: she hears anyway, so she gets no button.
  await ada.goto(darkPath);
  await expect(ada.getByText("You'll hear when it ships.", { exact: true })).toBeVisible();
  await expect(ada.getByRole("button", { name: "Subscribe" })).toHaveCount(0);
  // Copy link copies the post's address on the portal.
  await ada.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await ada.getByRole("button", { name: "Copy link" }).click();
  await expect(ada.getByText("Copied")).toBeVisible();
  expect(await ada.evaluate(() => navigator.clipboard.readText())).toBe(`${portalUrl(slug)}${darkPath}`);
  // Another idea: its board, New idea's dialog open. Closed, the address no longer asks for it: a reload or Back leaves it shut.
  await ada.getByRole("link", { name: "Post it" }).click();
  await expect(ada.getByRole("dialog", { name: "Share an idea" })).toBeVisible();
  await expect(ada).toHaveURL(/\/feedback\/feature-requests$/);
  await ada.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await ada.reload();
  await expect(ada.getByRole("button", { name: "New idea" })).toBeVisible();
  await expect(ada.getByRole("dialog")).toHaveCount(0);
  // Into an idea and Back: the board, its dialog still shut.
  await ada.getByRole("main").getByRole("link", { name: dark }).click();
  await expect(ada.getByRole("heading", { level: 1 })).toHaveText(dark);
  await ada.goBack();
  await expect(ada).toHaveURL(/\/feedback\/feature-requests$/);
  await expect(ada.getByRole("button", { name: "New idea" })).toBeVisible();
  await expect(ada.getByRole("dialog")).toHaveCount(0);

  // Cy (email verified) follows it without voting.
  const cy = await signUp(browser, portalUrl(slug), "Cy");
  await cy.goto(linkIn(await latestEmailTo(cy.email), "http"));
  await cy.goto(darkPath);
  // What Subscribe does, under it, only while it offers Subscribe.
  const hint = cy.getByText("Get an email when it ships.");
  await expect(hint).toBeVisible();
  await cy.getByRole("button", { name: "Subscribe" }).click();
  // Saved once it's enabled again (it shows Unsubscribe right away).
  await expect(cy.getByRole("button", { name: "Unsubscribe" })).toBeEnabled();
  await expect(hint).toHaveCount(0);
  await cy.reload();
  await expect(cy.getByRole("button", { name: "Unsubscribe" })).toBeVisible();
  await expect(hint).toHaveCount(0);
  // Under it, the similar idea, linked; not itself, nor the unrelated one.
  const ideas = cy.getByRole("region", { name: "Similar ideas" });
  await expect(ideas.getByRole("link")).toHaveText([night]);
  await expect(ideas).toContainText("1 vote");

  // At desktop and phone widths, light and dark.
  const signedIn = await cy.context().storageState();
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await (await browser.newContext({ baseURL: portalUrl(slug), viewport, colorScheme, storageState: signedIn })).newPage();
      await page.goto(darkPath);
      await expect(page.getByRole("button", { name: "Unsubscribe" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Similar ideas" }).getByRole("link", { name: night })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await checkpoint(page, `portal-post-subscribed-${name}-${colorScheme}`);
      await page.context().close();
    }
  }

  // The similar idea links back; the unrelated post has none.
  await ideas.getByRole("link", { name: night }).click();
  await expect(cy.getByRole("heading", { level: 1 })).toHaveText(night);
  await cy.goto("/feedback/feature-requests");
  await cy.getByRole("link", { name: "Export invoices" }).click();
  await expect(cy.getByRole("heading", { level: 1 })).toHaveText("Export invoices");
  await expect(cy.getByRole("region", { name: "Similar ideas" })).toHaveCount(0);

  // Di votes: she hears anyway, so the line. Taking the vote back brings Subscribe.
  const di = await signUp(browser, portalUrl(slug), "Di");
  await di.goto(linkIn(await latestEmailTo(di.email), "http"));
  await di.goto(darkPath);
  const hears = di.getByText("You'll hear when it ships.", { exact: true });
  await di.getByRole("button", { name: "Upvote" }).click();
  // Saved once it's enabled again (the count changes at once).
  await expect(di.getByRole("button", { name: "Upvoted" })).toBeEnabled();
  await di.reload();
  await expect(hears).toBeVisible();
  // The line from the start (a fresh page), and still the vote taken back brings Subscribe.
  await di.getByRole("button", { name: "Upvoted" }).click();
  await expect(di.getByRole("button", { name: "Upvote" })).toHaveText("Upvote1");
  await expect(di.getByRole("button", { name: "Subscribe" })).toBeVisible();
  await expect(hears).toHaveCount(0);
  // Subscribing from the keyboard keeps its focus.
  await di.getByRole("button", { name: "Subscribe" }).focus();
  await di.keyboard.press("Enter");
  await expect(di.getByRole("button", { name: "Unsubscribe" })).toBeEnabled();
  await expect(di.getByRole("button", { name: "Unsubscribe" })).toBeFocused();
  // Voting too, she hears anyway: the line, not an Unsubscribe that would change nothing, after a reload and right away.
  await di.getByRole("button", { name: "Upvote" }).click();
  // Saved once it's enabled again (the count changes at once).
  await expect(di.getByRole("button", { name: "Upvoted" })).toBeEnabled();
  await di.reload();
  await expect(hears).toBeVisible();
  await expect(di.getByRole("button", { name: /subscribe/i })).toHaveCount(0);
  await di.getByRole("button", { name: "Upvoted" }).click();
  await expect(di.getByRole("button", { name: "Unsubscribe" })).toBeVisible();
  await di.getByRole("button", { name: "Upvote" }).click();
  await expect(hears).toBeVisible();
  await expect(di.getByRole("button", { name: /subscribe/i })).toHaveCount(0);

  // The team ships it, told first that it emails Cy too (and Ada, who posted it, and Di); Cy hears.
  await team.goto(`/app/${slug}/p/1`);
  await team.getByLabel("Status").click();
  await team.getByRole("option", { name: "Completed" }).click();
  const ask = team.getByRole("alertdialog", { name: `Mark “${dark}” completed?` });
  await expect(ask).toContainText("This emails up to 3 people who asked for it that it shipped.");
  await ask.getByRole("button", { name: "Mark completed" }).click();
  await expect(team.getByText("Status: Completed")).toBeVisible();
  const email = await latestEmailTo(cy.email, { subject: /^Done: / });
  expect(email.subject).toBe(`Done: ${dark}`);
  expect(email.text).toContain(`${portalUrl(slug)}${darkPath}`);
  expect(email.text).toContain("subscribed to it");
  // Shipped, it won't email again: no Subscribe any more.
  await cy.goto(darkPath);
  await expect(cy.getByRole("heading", { level: 1 })).toHaveText(dark);
  await expect(cy.getByRole("button", { name: /subscribe/i })).toHaveCount(0);
});

test("a post's thread: replies under their comment, likes with counts, Oldest or Newest first; the same on the team's post page", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const comment = async (page: Page, text: string) => {
    const box = page.getByRole("textbox", { name: "Comment" });
    await expect(async () => {
      await box.fill(text);
      await expect(box).toHaveText(text, { timeout: 1000 });
    }).toPass();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByRole("region", { name: "Comments" }).getByText(text)).toBeVisible();
  };

  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, "Dark mode");
  await ada.goto("/feedback/feature-requests/dark-mode-1");
  await comment(ada, "Please, for late nights.");
  const bo = await signUp(browser, portalUrl(slug), "Bo");
  await bo.goto("/feedback/feature-requests/dark-mode-1");
  await comment(bo, "And a schedule for it.");

  // Signed out: the counts, and Reply and Like ask them to sign in.
  const visitor = await (await browser.newContext({ baseURL: portalUrl(slug) })).newPage();
  await visitor.goto("/feedback/feature-requests/dark-mode-1");
  await expect(visitor.getByRole("link", { name: "Reply to Ada, sign in to reply" })).toBeVisible();
  await visitor.getByRole("link", { name: "Like Ada's comment (0 likes), sign in to like" }).click();
  await visitor.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("next") === "/feedback/feature-requests/dark-mode-1");
  await visitor.context().close();

  // Bo answers Ada: the reply sits under her comment, indented.
  await bo.getByRole("button", { name: "Reply to Ada" }).click();
  const replyBox = bo.getByRole("textbox", { name: "Reply" });
  await expect(replyBox).toBeFocused();
  await replyBox.fill("Same here, my eyes thank you.");
  await bo.getByRole("button", { name: "Reply", exact: true }).click();
  const replies = bo.getByRole("list", { name: "Replies to Ada" });
  await expect(replies.getByRole("listitem")).toHaveText([/Same here, my eyes thank you\./]);
  await expect(replyBox).toHaveCount(0);
  const adas = bo.getByRole("region", { name: "Comments" }).getByRole("listitem").filter({ hasText: "Please, for late nights." }).first();
  expect((await replies.boundingBox())!.x).toBeGreaterThanOrEqual((await adas.boundingBox())!.x + 40);
  await expect(bo.getByRole("heading", { name: "3 comments" })).toBeVisible();

  // Ada likes Bo's reply, and takes it back, then likes it again: one each.
  const like = ada.getByRole("button", { name: /^Like Bo's comment/ }).first();
  await ada.reload();
  await like.click();
  await expect(like).toHaveAttribute("aria-pressed", "true");
  await expect(like).toHaveText("1");
  await like.click();
  await expect(like).toHaveText("Like");
  await like.click();
  await expect(like).toHaveText("1");
  // Saved (the button is back once it is).
  await expect(like).toBeEnabled();
  await ada.reload();
  await expect(ada.getByRole("button", { name: "Like Bo's comment (1 like)" }).first()).toHaveAttribute("aria-pressed", "true");

  // Newest first: Bo's comment leads, the reply stays under Ada's; kept in the address.
  await ada.getByRole("button", { name: "Sort comments: Oldest first" }).click();
  await ada.getByRole("menuitemradio", { name: "Newest first" }).click();
  await ada.waitForURL((url) => url.searchParams.get("sort") === "newest");
  const thread = ada.getByRole("region", { name: "Comments" }).locator(":scope ol > li");
  await expect(thread.first()).toContainText("And a schedule for it.");
  await expect(ada.getByRole("list", { name: "Replies to Ada" })).toContainText("Same here");
  await checkpoint(ada, "portal-post-thread-newest");
  await ada.reload();
  await expect(ada.getByRole("button", { name: "Sort comments: Newest first" })).toBeVisible();

  // The team's post page: the same thread; the team likes and replies too, and its notes have neither.
  await team.goto(`/app/${slug}/p/1`);
  await expect(team.getByRole("list", { name: "Replies to Ada" })).toContainText("Same here");
  await team.getByRole("button", { name: /^Like Ada's comment/ }).click();
  await expect(team.getByRole("button", { name: /^Like Ada's comment/ })).toHaveText("1");
  // Bo's own comment (the last; Bo's reply to Ada is under hers).
  await team.getByRole("button", { name: "Reply to Bo" }).last().click();
  await team.getByRole("textbox", { name: "Reply" }).fill("It's next on our list.");
  await team.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(team.getByRole("list", { name: "Replies to Bo" })).toContainText("It's next on our list.");
  await team.getByRole("tab", { name: "Internal note" }).click();
  await team.getByRole("textbox", { name: "Comment" }).fill("Big customers want this.");
  await team.getByRole("button", { name: "Add note" }).click();
  const note = team.getByRole("region", { name: "Comments" }).getByRole("listitem").filter({ hasText: "Big customers want this." });
  await expect(note).toBeVisible();
  await expect(note.getByRole("button")).toHaveCount(0);
  await checkpoint(team, "team-post-thread");

  // On the portal the team's reply is the team's, under Bo's comment, and Ada's like counts.
  await ada.goto("/feedback/feature-requests/dark-mode-1");
  await expect(ada.getByRole("list", { name: "Replies to Bo" }).getByText("Team", { exact: true })).toBeVisible();
  await expect(ada.getByRole("button", { name: /^Like Ada's comment/ })).toHaveText("1");
  await checkpoint(ada, "portal-post-thread");
});
