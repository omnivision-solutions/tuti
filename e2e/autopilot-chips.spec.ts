import { randomInt, randomUUID } from "node:crypto";

import { type Browser, expect, type Request, test } from "@playwright/test";

import { asPreviousRelease, markOutOfDate, setAnalysis, setPullRequestState } from "./autopilot";
import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { connectGithub, mergePullRequest } from "./github";
import { apiFor, createProject, signUp } from "./helpers";
import { nextDecision, nextDocsAgentAnswer, nextModelReply } from "./model";

test("eight pull requests' edits on an article in a collection: the list's tree; three chips, then the rest under +5 more; an out-of-date one is marked; one dismissed from its chip", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const id = randomUUID().slice(0, 8);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const article = `Find your way around ${id}`;
  const before = "The sidebar lists Feedback and Docs.";
  await api("/collections", { name: "Billing", icon: "credit-card" });
  const { slug: articleSlug } = await api("/articles", { title: article, body: before, collection: "billing" });
  await api(`/articles/${articleSlug}/publish`, {});
  const installationId = await connectGithub(owner, slug);

  // Each pull request edits the article; from the second on, Autopilot asks whether to Verify it (no).
  const numbers = Array.from({ length: 8 }, (_, i) => randomInt(i * 100_000 + 1_000, (i + 1) * 100_000));
  for (const [i, number] of numbers.entries()) {
    const pr = `Sidebar ${i + 1} ${id}`;
    const summary = `The sidebar changed (${i + 1}, ${id}).`;
    await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
    await nextDocsAgentAnswer(number, { summary, edits: [{ slug: articleSlug, probability: 0.92 }] });
    await nextModelReply(JSON.stringify({ reason: `The sidebar list misses item ${i + 1}.`, sections: { "1": `The sidebar lists Feedback, Docs and ${i + 1} more.` } }), article);
    await nextModelReply(JSON.stringify({ why: "", changelog: "Sidebar", proposals: {} }), summary);
    if (i > 0) {
      await nextDecision({ verify: 0.1 }, `"article":"${article}","pull_requests_edits_waiting":${i + 1},`);
    }
    await mergePullRequest(installationId, { number, title: pr });
  }
  // The first one's edit was written on an earlier version of the article.
  await markOutOfDate(slug, numbers[0]!);

  // Autopilot's list, a tree: Help center → its collection (its icon) → the article, its badge at the end.
  await owner.goto(`/app/${slug}/autopilot`);
  const list = owner.getByRole("complementary", { name: "Changes" });
  await expect(list.getByRole("region", { name: "Help center" }).getByRole("list", { name: "Billing" }).getByRole("listitem")).toContainText(article);
  await expect(list.getByRole("list", { name: "Billing" }).getByRole("listitem")).toContainText("Updated");
  await checkpoint(owner, "tree-list", { fullPage: false });
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "tree-phone", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "tree-phone-dark", { fullPage: false });
  await owner.setViewportSize({ width: 1280, height: 720 });

  // Its review: the latest merged first, three chips, then "+5 more", whose dot says one it hides is out of date.
  await list.getByRole("link", { name: article }).click();
  await expect(list.getByRole("link", { name: article })).toHaveAttribute("aria-current", "page");
  await checkpoint(owner, "tree-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "tree", { fullPage: false });
  await expect(owner.getByRole("heading", { name: article, level: 1 })).toBeVisible();
  const chips = owner.getByRole("list", { name: "Pull requests" });
  await expect(chips.getByRole("button", { name: /^PR #/ })).toHaveText(numbers.slice(5).reverse().map((number) => `PR #${number}`));
  const more = chips.getByRole("button", { name: "+5 more, 1 out of date" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  // The one out of date isn't in the changes, and the page says so above them, with Write it again.
  await expect(owner.getByText("One of its edits was written on an earlier version of the article, so it isn't in the changes below.", { exact: false })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Write it again" })).toHaveCount(1);
  // Scrolled under the app's header (a short window, so the page scrolls), a chip goes behind it, not over it.
  await owner.setViewportSize({ width: 1280, height: 300 });
  const underHeader = await chips
    .getByRole("button", { name: /^PR #/ })
    .first()
    .evaluate((chip) => {
      const header = document.querySelector("header")!;
      window.scrollBy(0, chip.getBoundingClientRect().top - header.getBoundingClientRect().top - 4);
      const { left, top, width, height } = chip.getBoundingClientRect();
      // Top to bottom, as painted.
      const stack = document.elementsFromPoint(left + width / 2, top + height / 2);
      return { under: top + height / 2 < header.getBoundingClientRect().bottom, behind: stack.includes(header) && stack.indexOf(header) < stack.findIndex((element) => chip.contains(element)) };
    });
  expect(underHeader).toEqual({ under: true, behind: true });
  await checkpoint(owner, "chips-under-header", { fullPage: false });
  await owner.evaluate(() => window.scrollTo(0, 0));
  await owner.setViewportSize({ width: 1280, height: 720 });
  await checkpoint(owner, "chips-collapsed", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "chips-collapsed-dark", { fullPage: false });
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "chips-collapsed-phone-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "chips-collapsed-phone", { fullPage: false });

  // From the keyboard: "+5 more" shows the rest.
  await more.focus();
  await owner.keyboard.press("Enter");
  await expect(chips.getByRole("button", { name: /^PR #/ })).toHaveCount(8);
  // Focus on the first of those shown (they're before the toggle).
  await expect(chips.getByRole("button", { name: /^PR #/ }).nth(3)).toBeFocused();
  await expect(chips.getByRole("button", { name: "Fewer" })).toHaveAttribute("aria-expanded", "true");
  await checkpoint(owner, "chips-expanded-phone", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "chips-expanded-phone-dark", { fullPage: false });
  await owner.setViewportSize({ width: 1280, height: 720 });
  await checkpoint(owner, "chips-expanded-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "chips-expanded", { fullPage: false });

  // The out-of-date one says so; its popover has why, what became of it, Write it again and Dismiss.
  const stale = chips.getByRole("button", { name: `PR #${numbers[0]}, out of date: Sidebar 1 ${id}` });
  await stale.click();
  const part = owner.getByRole("dialog").filter({ hasText: `Sidebar 1 ${id}` });
  await expect(part).toContainText("The sidebar list misses item 1.");
  await expect(part).toContainText("Out of date: the article changed since it was written");
  await expect(part.getByRole("button", { name: "Write it again" })).toBeVisible();
  await checkpoint(owner, "chip-out-of-date", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "chip-out-of-date-dark", { fullPage: false });
  await owner.setViewportSize({ width: 390, height: 844 });
  await checkpoint(owner, "chip-out-of-date-phone-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });
  await checkpoint(owner, "chip-out-of-date-phone", { fullPage: false });
  await owner.setViewportSize({ width: 1280, height: 720 });
  await owner.keyboard.press("Escape");

  // The newest one dismissed from its popover (an earlier one can't be: a later edit changed the same section): focus
  // is on the chip row. Its chip stays, last now (nothing of it waits), to see what became of it.
  const newest = chips.getByRole("button", { name: `PR #${numbers[7]}: Sidebar 8 ${id}` });
  await newest.click();
  await owner.getByRole("dialog").filter({ hasText: `Sidebar 8 ${id}` }).getByRole("button", { name: "Dismiss" }).click();
  await expect(owner.locator("[data-sonner-toast]").getByText("Dismissed", { exact: true })).toBeVisible();
  await expect(chips).toBeFocused();
  await expect(chips.getByRole("button", { name: /^PR #/ }).last()).toHaveAccessibleName(`PR #${numbers[7]}: Sidebar 8 ${id}`);
  await newest.click();
  await expect(owner.getByRole("dialog").filter({ hasText: `Sidebar 8 ${id}` })).toContainText("Dismissed by Olive Owner");
  await owner.keyboard.press("Escape");
  // "Fewer" hides them again.
  await chips.getByRole("button", { name: "Fewer" }).click();
  await expect(chips.getByRole("button", { name: "+5 more, 1 out of date" })).toHaveAttribute("aria-expanded", "false");
});

/**
 * A project whose article's only edit is one the previous release wrote (its pull request's, merged): what the
 * analysis asked the model is scripted with `script` (once for the merge, and again for each analysis after it).
 */
async function previousReleaseEdit(browser: Browser) {
  const id = randomUUID().slice(0, 8);
  const number = randomInt(1_000, 1_000_000);
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const article = `Change the theme ${id}`;
  const before = "Pick Light in Settings.";
  const { slug: articleSlug } = await api("/articles", { title: article, body: before });
  await api(`/articles/${articleSlug}/publish`, {});
  const installationId = await connectGithub(owner, slug);
  const pr = `Add a dark theme ${id}`;
  const summary = `You can now switch to a dark theme (${id}).`;
  // What the analysis asks: whether users see it, the docs agent (its summary, and whether the article is out of date:
  // then its edit, `text`; none when it isn't), and the rest.
  const script = async (text: string | null) => {
    await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
    await nextDocsAgentAnswer(number, { summary, edits: text ? [{ slug: articleSlug, probability: 0.92 }] : [] });
    if (text) {
      await nextModelReply(JSON.stringify({ reason: "It says Light is the only theme.", sections: { "1": text } }), article);
    }
    await nextModelReply(JSON.stringify({ why: "", changelog: "Dark theme", proposals: {} }), summary);
  };
  await script("Pick Light or Dark in Settings.");
  await mergePullRequest(installationId, { number, title: pr });
  await asPreviousRelease(slug, number);

  return { owner, slug, number, article, script };
}

test("an article whose only edit the previous release wrote: its review says there's nothing to show yet and why, and dismisses it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const { owner, slug, article } = await previousReleaseEdit(browser);

  // Still to review, but nothing of it shows: the page says why, with what to do.
  await owner.goto(`/app/${slug}/autopilot`);
  const list = owner.getByRole("complementary", { name: "Changes" });
  await list.getByRole("link", { name: article }).click();
  const notice = owner.getByText(/^Nothing to show yet: its edit was written on an earlier version of the article/);
  await expect(notice).toBeVisible();
  await expect(owner.getByRole("button", { name: "Write it again" })).toBeVisible();
  await expect(owner.getByRole("button", { name: "Approve and publish" })).toHaveCount(0);
  await checkpoint(owner, "nothing-to-show-yet", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await checkpoint(owner, "nothing-to-show-yet-dark", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "light" });

  // Dismissed: nothing's left to review.
  await owner.getByRole("button", { name: "Dismiss it" }).click();
  await expect(owner.locator("[data-sonner-toast]").getByText("Dismissed", { exact: true })).toBeVisible();
  await expect(list.getByRole("tab", { name: "To review 0" })).toBeVisible();
  // Decided, it has nothing to say about it.
  await expect(owner.getByText(/^Nothing to show/)).toHaveCount(0);
});

test("an edit the previous release wrote, written again from its review: the new edit shows, the article stays open and to review, focus on its chips", async ({ browser }) => {
  const { owner, slug, number, article, script } = await previousReleaseEdit(browser);
  await owner.goto(`/app/${slug}/autopilot`);
  const list = owner.getByRole("complementary", { name: "Changes" });
  await list.getByRole("link", { name: article }).click();
  await script("Pick Light, Dark or System in Settings.");
  await owner.getByRole("button", { name: "Write it again" }).click();
  // Its notice (and the button) gone, the new edit shows; still open, and still to review (not decided).
  await expect(owner.getByRole("insertion").filter({ hasText: "Pick Light, Dark or System in Settings." })).toBeVisible();
  await expect(owner.getByText(/^Nothing to show/)).toHaveCount(0);
  await expect(owner.getByRole("heading", { name: article, level: 1 })).toBeVisible();
  await expect(list.getByRole("tab", { name: "To review 1" })).toBeVisible();
  await expect(owner.getByRole("list", { name: "Pull requests" })).toBeFocused();
  await expect(owner.getByRole("list", { name: "Pull requests" }).getByRole("button", { name: new RegExp(`^PR #${number}:`) })).toBeVisible();
});

test("an edit the previous release wrote, written again, when the pull request has nothing for the article now: Autopilot's list says so", async ({ browser }) => {
  const { owner, slug, article, script } = await previousReleaseEdit(browser);
  await owner.goto(`/app/${slug}/autopilot`);
  const list = owner.getByRole("complementary", { name: "Changes" });
  await list.getByRole("link", { name: article }).click();
  await script(null);
  await owner.getByRole("button", { name: "Write it again" }).click();
  // Nothing of Autopilot's is on it now: never a page that isn't there.
  await owner.waitForURL(`**/app/${slug}/autopilot?gone=article`);
  // Said, and focused (the button pressed went with its page).
  await expect(owner.getByRole("status").filter({ hasText: "Nothing from Autopilot is on that article any more." })).toBeFocused();
  await expect(list.getByRole("tab", { name: "To review 0" })).toBeVisible();
});

test("two edits the previous release wrote on one article: the review says so, and Dismiss them takes both out", async ({ browser }) => {
  const id = randomUUID().slice(0, 8);
  const numbers = [randomInt(1_000, 500_000), randomInt(500_000, 1_000_000)];
  const slug = `e2e-${id}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const article = `Change the theme ${id}`;
  const before = "Pick Light in Settings.";
  const { slug: articleSlug } = await api("/articles", { title: article, body: before });
  await api(`/articles/${articleSlug}/publish`, {});
  const installationId = await connectGithub(owner, slug);
  // The second rewrites what the first wrote: it's on top of it.
  for (const [i, text] of ["Pick Light or Dark in Settings.", "Pick Light, Dark or System in Settings."].entries()) {
    const pr = `Themes ${i + 1} ${id}`;
    const summary = `You can now pick more themes (${i + 1}, ${id}).`;
    await nextDecision({ audience: { users: 0.95, internal: 0.03, dependencies: 0.01, repository_docs: 0.01 } }, pr);
    await nextDocsAgentAnswer(numbers[i]!, { summary, edits: [{ slug: articleSlug, probability: 0.92 }] });
    await nextModelReply(JSON.stringify({ reason: "It names the themes.", sections: { "1": text } }), article);
    await nextModelReply(JSON.stringify({ why: "", changelog: "More themes", proposals: {} }), summary);
    if (i === 1) {
      await nextDecision({ verify: 0.1 }, `"article":"${article}","pull_requests_edits_waiting":2,`);
    }
    await mergePullRequest(installationId, { number: numbers[i]!, title: pr });
  }
  // Both as the previous release wrote them: out of date, nothing of them in the article's changes.
  for (const number of numbers) {
    await asPreviousRelease(slug, number);
  }

  await owner.goto(`/app/${slug}/autopilot`);
  const list = owner.getByRole("complementary", { name: "Changes" });
  await list.getByRole("link", { name: article }).click();
  await expect(owner.getByText(/^Nothing to show yet: 2 of its edits were written on an earlier version of the article/)).toBeVisible();
  await owner.getByRole("button", { name: "Dismiss them" }).click();
  await expect(owner.locator("[data-sonner-toast]").getByText("Dismissed", { exact: true })).toBeVisible();
  await expect(list.getByRole("tab", { name: "To review 0" })).toBeVisible();
});

test("an edit the previous release wrote, while its pull request is analysed again (queued): the review says it's being written, then shows the result by itself; with Autopilot off, says why it can't be", async ({ browser }) => {
  const { owner, slug, number, article } = await previousReleaseEdit(browser);
  // Queued, as on Hatchet: the job hasn't run. The page's clock is ours to move on.
  await setPullRequestState(slug, number, "ANALYSING");
  await owner.clock.install();
  // The page's refreshes (its RSC requests): started, and those not answered yet.
  let refreshes = 0;
  let inFlight = 0;
  const refresh = (request: Request) => request.headers()["rsc"] === "1" && request.url().includes("/autopilot/articles/");
  owner.on("request", (request) => {
    if (refresh(request)) {
      refreshes += 1;
      inFlight += 1;
    }
  });
  for (const done of ["requestfinished", "requestfailed"] as const) {
    owner.on(done, (request) => {
      if (refresh(request)) {
        inFlight -= 1;
      }
    });
  }
  await owner.goto(`/app/${slug}/autopilot`);
  const list = owner.getByRole("complementary", { name: "Changes" });
  await list.getByRole("link", { name: article }).click();
  await expect(owner.getByText("Writing it again… It shows here once it's written.", { exact: false })).toBeVisible();
  const writing = owner.getByRole("button", { name: "Writing…" });
  await expect(writing).toBeDisabled();
  // Pressed again: nothing (no second analysis), and focus stays on it.
  await writing.focus();
  await owner.keyboard.press("Enter");
  await expect(writing).toBeFocused();
  // Its chip's popover too: off meanwhile.
  await owner.getByRole("list", { name: "Pull requests" }).getByRole("button", { name: new RegExp(`^PR #${number}`) }).click();
  await expect(owner.getByRole("dialog").getByRole("button", { name: "Writing…" })).toBeDisabled();
  await owner.keyboard.press("Escape");

  // Two minutes on: still being written, and looked at every 15 seconds now (not every 3).
  await owner.clock.runFor(2 * 60_000);
  await expect(owner.getByText("Still writing it again… It shows here once it's written.", { exact: false })).toBeVisible();
  // The refreshes those 2 minutes started all answered (none in flight, none started since the last look), and the
  // page's time stopped: from here only the clock's steps make it look again.
  const settled = async () => {
    let seen = -1;
    await expect
      .poll(
        () => {
          const now = refreshes;
          const still = now === seen && inFlight === 0;
          seen = now;
          return still;
        },
        { intervals: [500] },
      )
      .toBe(true);
  };
  await settled();
  // (A moment ahead of the page's time, which runs on meanwhile; what that moment fires settles too.)
  await owner.clock.pauseAt((await owner.evaluate(() => Date.now())) + 2_000);
  await settled();
  const before = refreshes;
  await owner.clock.runFor(15_000);
  await expect.poll(() => refreshes - before).toBeGreaterThanOrEqual(1);
  // 30 seconds in all: twice at most (every 3 seconds would be 10).
  await owner.clock.runFor(15_000);
  await expect.poll(() => refreshes - before).toBeGreaterThanOrEqual(2);
  await settled();
  expect(refreshes - before).toBeLessThanOrEqual(2);

  // Its job failed: the page looks again by itself, says why, and offers it again to try once more.
  await setPullRequestState(slug, number, "FAILED", "The AI provider didn't answer.");
  await owner.clock.runFor(15_000);
  await expect(owner.getByText("It couldn't be written again. The AI provider didn't answer. Write it again to try once more, or dismiss it.", { exact: false })).toBeVisible({
    timeout: 10_000,
  });
  await expect(owner.getByRole("button", { name: "Write it again" })).toBeEnabled();

  // Autopilot turned off in Settings: no Write it again, and why.
  await setAnalysis(slug, false);
  await owner.reload();
  await expect(owner.getByText("It can't be written again while Autopilot is off in Settings → Autopilot: dismiss it.", { exact: false })).toBeVisible();
  await expect(owner.getByRole("button", { name: /^Write/ })).toHaveCount(0);
  await expect(owner.getByRole("button", { name: "Dismiss it" })).toBeVisible();
});
