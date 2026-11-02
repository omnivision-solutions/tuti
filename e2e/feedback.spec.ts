import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import pg from "pg";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, expectOneRowOfTabs, newPerson, postFeedback, signUp, skipSetup } from "./helpers";
import { countEmailsTo, latestEmailTo, linkIn } from "./mail";

test("a team collects feedback, merges a duplicate and plans it", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  // The team creates a project.
  const team = await signUp(browser, APP_URL, "Tess Team");
  await team.goto("/app/new");
  await team.getByLabel("Name").fill("Acme");
  await team.getByLabel("URL").fill(slug);
  // The portal's address shows as it's typed.
  await expect(team.getByText(`Your portal will be ${new URL(portalUrl(slug)).host}`, { exact: true })).toBeVisible();
  await checkpoint(team, "team-new-project-form");
  await team.getByRole("button", { name: "Create project" }).click();
  await skipSetup(team, slug);
  await checkpoint(team, "team-new-project");

  // Until they verify their email, the dashboard asks them to; the emailed link does it.
  const banner = team.getByRole("status").filter({ hasText: "Verify your email" });
  await expect(banner).toContainText(team.email);
  const emailsBefore = countEmailsTo(team.email);
  await team.getByRole("button", { name: "Resend email" }).click();
  await expect(team.getByRole("button", { name: "Sent" })).toBeDisabled();
  await checkpoint(team, "team-verify-email-banner");
  const email = await latestEmailTo(team.email, { after: emailsBefore });
  expect(email.subject).toBe("Verify your email for Tuti");
  // Verified in another tab: this one notices when it's back in focus, without reloading.
  const otherTab = await team.context().newPage();
  await otherTab.goto(linkIn(email, `${APP_URL}/api/auth/verify-email`));
  await otherTab.waitForURL(`**/app/${slug}`); // /app opens the last project
  await otherTab.close();
  await team.bringToFront();
  // Better Auth refetches the session when the tab becomes visible, at most every 5 seconds.
  await expect(async () => {
    await team.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(banner).toHaveCount(0, { timeout: 500 });
  }).toPass({ timeout: 15_000 });

  // Two people post on the portal; the second also upvotes the first post.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, "Dark mode");
  await checkpoint(ada, "portal-first-post");

  const bo = await signUp(browser, portalUrl(slug), "Bo");
  await bo.goto("/feedback/feature-requests");
  await postFeedback(bo, "Night theme for the editor");
  await checkpoint(bo, "portal-two-posts");
  await bo.getByRole("link", { name: "Dark mode" }).click();
  // The board list has vote buttons too: vote only once the post page is open.
  await bo.waitForURL(/\/feedback\/[a-z0-9-]+\/dark-mode-1$/);
  await bo.getByRole("button", { name: "Upvote" }).click();
  await expect(bo.getByRole("button", { name: "Remove vote" })).toHaveText("2");

  // The sidebar counts the posts waiting for triage (Open), where the team works.
  await team.goto(`/app/${slug}/p/2`);
  const feedbackItem = team.locator('[data-slot="sidebar-menu-item"]').filter({ has: team.getByRole("link", { name: "Feedback", exact: true }) });
  await expect(feedbackItem).toContainText("2 to triage");
  await expect(team.getByRole("link", { name: "Feedback", exact: true }).first()).toHaveAccessibleDescription("2 to triage");
  // J and K step to the older post and back (by number). Not while a list of choices is open: a letter there picks one.
  await team.getByLabel("Status").click();
  await expect(team.getByRole("listbox")).toBeVisible();
  await team.keyboard.press("j");
  // A step would have gone by now (it's not instant: wait for one, and expect none).
  await expect(team.waitForURL(`**/app/${slug}/p/1`, { timeout: 1500 })).rejects.toThrow();
  await team.keyboard.press("Escape");
  await expect(team.getByRole("listbox")).toBeHidden();
  // Closed but still focused, its letters still pick an option: not a step either.
  await team.keyboard.press("j");
  await expect(team.waitForURL(`**/app/${slug}/p/1`, { timeout: 1500 })).rejects.toThrow();
  // Away from it, as clicking elsewhere would.
  await team.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await team.keyboard.press("j");
  await team.waitForURL(`**/app/${slug}/p/1`);
  await team.keyboard.press("k");
  await team.waitForURL(`**/app/${slug}/p/2`);
  // The team merges the duplicate into the original, from the page's other actions…
  await team.getByRole("button", { name: "More actions" }).click();
  await team.getByRole("button", { name: "Merge into…" }).click();
  await team.getByRole("button", { name: /Dark mode/ }).click();
  await checkpoint(team, "team-merge-confirm", { fullPage: false });
  await team.getByRole("dialog").getByRole("button", { name: "Merge", exact: true }).click();
  await team.waitForURL(`**/app/${slug}/p/1`);
  // The merged duplicate no longer waits for triage.
  await expect(feedbackItem).toContainText("1 to triage");

  // …then answers and plans it, emailing the answer to its voters: Ada, once she's verified her address (Bo hasn't).
  await ada.goto(linkIn(await latestEmailTo(ada.email), "http"));
  await team.reload();
  await team.getByRole("textbox", { name: "Comment" }).fill("Thanks! We're on it.");
  // Switched on once the page is ready for it (before then, a click isn't heard).
  await expect(async () => {
    await team.getByRole("switch", { name: "Email voters (1 person)" }).check();
    await expect(team.getByRole("button", { name: "Comment and email" })).toBeVisible({ timeout: 1000 });
  }).toPass();
  await checkpoint(team, "team-reply-email-voters");
  await team.getByRole("button", { name: "Comment and email" }).click();
  const reply = await latestEmailTo(ada.email, { subject: /^Re: Dark mode$/ });
  expect(reply.text).toContain("Thanks! We're on it.");
  // And a note only the team sees.
  await expect(team.getByText("Thanks! We're on it.")).toBeVisible();
  // Switched on once the page is ready for it (before then, a click isn't heard).
  await expect(async () => {
    await team.getByRole("switch", { name: /Internal note/ }).check();
    await expect(team.getByRole("button", { name: "Add note" })).toBeVisible({ timeout: 1000 });
  }).toPass();
  await team.getByRole("textbox", { name: "Comment" }).fill("Acme asked for this on their call too.");
  await team.getByRole("button", { name: "Add note" }).click();
  await expect(team.getByRole("listitem").filter({ hasText: "Acme asked for this on their call too." })).toContainText("Internal note");
  await expect(team.getByRole("switch", { name: /Internal note/ })).not.toBeChecked();
  await team.getByLabel("Status").click();
  await team.getByRole("option", { name: "Planned" }).click();
  // Saved once the toast shows; the portal is opened only after that.
  await expect(team.getByText("Status: Planned")).toBeVisible();
  // Its properties, beside it: who looks after it, and when it's expected.
  const properties = team.getByRole("complementary", { name: "Properties" });
  await properties.getByRole("combobox", { name: "Owner" }).click();
  await team.getByRole("option", { name: "Tess Team" }).click();
  await expect(team.getByText("Owner: Tess Team")).toBeVisible();
  // The month after this one: always among the next two years'.
  const next = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  await properties.getByRole("combobox", { name: "ETA" }).click();
  await team.getByRole("option", { name: next }).click();
  await expect(team.getByText(`ETA: ${next}`)).toBeVisible();
  // Who asked for it: its voters, Bo (the duplicate's vote, moved over) and Ada, the latest first.
  await expect(properties.getByRole("list", { name: "Voters" }).getByRole("listitem")).toHaveText(["Bo", "Ada"]);
  // The change is in the post's activity, after the team's answer: who made it, from what to what.
  await expect(team.getByRole("region", { name: "Comments" }).getByRole("listitem").last()).toContainText("Open → Planned, by Tess Team");
  // Its title is the page's heading, under the top bar (which keeps a copy in view); the post merged into it is listed.
  const heading = team.getByRole("heading", { name: "Dark mode", level: 1 });
  await expect(heading).toHaveCSS("font-size", "24px");
  expect((await heading.boundingBox())!.y).toBeGreaterThanOrEqual(48);
  await expect(properties.getByRole("list", { name: "Merged posts" }).getByRole("link")).toHaveText(["#2 Night theme for the editor"]);
  await checkpoint(team, "team-planned");
  // On a phone the post and its activity come first, then its properties: the voters as faces and how many, opening to their names.
  await team.setViewportSize({ width: 390, height: 844 });
  const comments = (await team.getByRole("region", { name: "Comments" }).boundingBox())!;
  expect((await properties.boundingBox())!.y).toBeGreaterThanOrEqual(comments.y + comments.height);
  await expect(properties.getByRole("list", { name: "Voters" })).toBeHidden();
  // Screen readers hear the count, not the faces' "Voters".
  const folded = properties.locator("summary");
  await expect(folded).toHaveAccessibleName("2 voters");
  await folded.click();
  // The toasts gone, for the screenshot.
  await expect(team.getByText(`ETA: ${next}`)).toBeHidden({ timeout: 10_000 });
  await expect(properties.getByRole("list", { name: "Voters" }).getByRole("listitem")).toHaveText(["Bo", "Ada"]);
  // From the top: scrolled, the full-page shot draws the top bar where the window was.
  await team.evaluate(() => window.scrollTo(0, 0));
  await checkpoint(team, "team-post-phone");
  await team.setViewportSize({ width: 1280, height: 720 });
  // The merged one says where it went, without the votes and comments that moved there.
  await team.goto(`/app/${slug}/p/2`);
  await expect(team.getByRole("heading", { name: "Night theme for the editor", level: 1 })).toBeVisible();
  await expect(team.getByText("Its votes and comments moved there")).toBeVisible();
  await expect(team.getByRole("paragraph").filter({ hasText: "#2 · Bo · " })).toHaveText(/#2 · Bo · [^·]+$/);
  await expect(team.getByRole("region", { name: "Comments" })).toHaveCount(0);
  await checkpoint(team, "team-post-merged");

  // People on the portal see one post with both votes, the team's answer and the status.
  await bo.goto("/feedback/feature-requests/night-theme-for-the-editor-2");
  await expect(bo).toHaveURL(/\/feedback\/[a-z0-9-]+\/dark-mode-1$/);
  // Bo voted for both, so counts once: Ada + Bo.
  await expect(bo.getByRole("button", { name: "Remove vote" })).toHaveText("2");
  await expect(bo.getByText("Thanks! We're on it.")).toBeVisible();
  await expect(bo.getByText("Acme asked for this on their call too.")).toHaveCount(0);
  await expect(bo.getByText("Team", { exact: true })).toBeVisible();
  await expect(bo.getByText("Planned").first()).toBeVisible();
  await checkpoint(bo, "portal-merged-post");

  // The board's status filter finds it under Planned only.
  await bo.goto("/feedback/feature-requests?status=planned");
  await expect(bo.getByRole("link", { name: "Dark mode" })).toBeVisible();
  // Its badge has Planned's dark green dot beside it.
  const dot = bo.getByRole("main").locator("[data-status-dot]");
  const plannedColor = await bo.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.backgroundColor = "var(--status-planned)";
    return getComputedStyle(probe).backgroundColor;
  });
  expect(plannedColor).not.toBe("rgba(0, 0, 0, 0)");
  await expect(dot).toHaveCSS("background-color", plannedColor);
  await bo.goto("/feedback/feature-requests?status=open");
  await expect(bo.getByRole("link", { name: "Dark mode" })).toHaveCount(0);
  await checkpoint(bo, "portal-filtered");

  // The portal's roadmap shows it as planned, with both votes.
  await bo.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Roadmap" }).click();
  const planned = bo.getByRole("region", { name: "Planned" });
  await expect(planned.getByRole("link", { name: "Dark mode" })).toHaveAttribute("href", "/feedback/feature-requests/dark-mode-1");
  const card = planned.getByRole("listitem").filter({ hasText: "Dark mode" });
  await expect(card).toContainText("Feature requests");
  await expect(card.getByRole("button", { name: "Remove vote" })).toHaveText("2");
  await expect(bo.getByRole("region", { name: "In progress" })).toContainText("Nothing here yet.");
  await checkpoint(bo, "portal-roadmap");

  // So does the team's feedback list; the merged duplicate isn't listed.
  await team.goto(`/app/${slug}/feedback?status=planned`);
  await expect(team.getByRole("link", { name: /Dark mode/ })).toBeVisible();
  // A link from when the list was the project's first page still finds it, filters and all.
  await team.goto(`/app/${slug}?status=open`);
  await team.waitForURL(`**/app/${slug}/feedback?status=open`);
  await expect(team.getByRole("link", { name: /Dark mode/ })).toHaveCount(0);
  // Feedback opens on what needs triage: nothing now. Each status is a tab with its count.
  await team.goto(`/app/${slug}/feedback`);
  const tabs = team.getByRole("navigation", { name: "Statuses" });
  await expect(tabs.getByRole("link", { name: "Needs triage 0" })).toHaveAttribute("aria-current", "page");
  await expect(team.getByText("Nothing to triage")).toBeVisible();
  await tabs.getByRole("link", { name: "Possible duplicates 0" }).click();
  await expect(team.getByText("No possible duplicates")).toBeVisible();
  await tabs.getByRole("link", { name: "Planned 1" }).click();
  await team.waitForURL(`**/app/${slug}/feedback?status=planned`);
  // A search looks in titles and descriptions, on the tab it's typed on.
  const search = team.getByRole("searchbox", { name: "Search feedback" });
  await search.fill("dark");
  await search.press("Enter");
  await team.waitForURL(`**/app/${slug}/feedback?status=planned&q=dark`);
  await expect(team.getByRole("link", { name: /Dark mode/ })).toBeVisible();
  await search.fill("light");
  await search.press("Enter");
  await expect(team.getByText("No posts match")).toBeVisible();
  // Trending: the most votes this week first; the tab and the search stay.
  await team.goto(`/app/${slug}/feedback?status=all`);
  await team.getByRole("combobox", { name: "Sort" }).click();
  await team.getByRole("option", { name: "Trending" }).click();
  await team.waitForURL(`**/app/${slug}/feedback?status=all&sort=trending`);
  await expect(tabs.getByRole("link", { name: "All 1" })).toHaveAttribute("href", `/app/${slug}/feedback?sort=trending&status=all`);
  await expect(team.getByRole("link", { name: /Night theme/ })).toHaveCount(0);
  // A status without a tab (an old link to Closed, say) lists All.
  await team.goto(`/app/${slug}/feedback?status=closed`);
  await expect(tabs.getByRole("link", { name: "All 1" })).toHaveAttribute("aria-current", "page");
  await expect(team.getByRole("link", { name: /Dark mode/ })).toBeVisible();
  // The portal's address isn't in the header (the project switcher has it).
  await expect(team.locator('[data-slot="page-header"]').getByRole("link", { name: new URL(portalUrl(slug)).host })).toHaveCount(0);
  // No sentence under the page's title (what it's for is in its empty state).
  await expect(team.locator('[data-slot="page-header"] p')).toHaveCount(0);
  // A row shows values, no form controls: its board as text, its status as a badge that opens a menu.
  const row = team.getByRole("main").getByRole("listitem").filter({ hasText: "Dark mode" });
  await expect(row).toContainText("#1 · Feature requests · Ada");
  await expect(row.getByRole("combobox")).toHaveCount(0);
  await row.getByRole("button", { name: "Status: Planned" }).click();
  await checkpoint(team, "team-feedback-status-menu");
  await team.getByRole("menuitemradio", { name: "In progress" }).click();
  // Picked, the menu closes.
  await expect(team.getByRole("menu")).toHaveCount(0);
  await expect(team.getByText("Status: In progress")).toBeVisible();
  await expect(row.getByRole("button", { name: "Status: In progress" })).toBeVisible();
  await checkpoint(team, "team-feedback-list");
});

test("Feedback's statuses are one row of tabs at laptop width and on a phone: too narrow, it scrolls sideways to the current one", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(team, "Acme", slug);
  // Counts of two digits, as a team's are.
  const api = await apiFor(team, slug);
  for (let i = 1; i <= 10; i++) {
    await api("/posts", { board: "feature-requests", title: `Idea number ${i}` });
  }
  const tabs = team.getByRole("navigation", { name: "Statuses" });
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    await team.setViewportSize({ width, height });
    await team.goto(`/app/${slug}/feedback`);
    await expectOneRowOfTabs(team, tabs);
    // At laptop width, beside the post's pane, all seven fit: no fade.
    if (width === 1440) {
      expect(await tabs.evaluate((row) => row.scrollWidth <= row.clientWidth)).toBe(true);
      await expect(tabs).not.toHaveAttribute("data-more");
      expect(await tabs.evaluate((row) => getComputedStyle(row).maskImage)).toBe("none");
    }
    await checkpoint(team, `feedback-${width}`, { fullPage: false });
  }
  // On a phone the row fades out at the end that has more, and a mouse's wheel scrolls it, not the page.
  await expect(tabs).toHaveAttribute("data-more", "end");
  expect(await tabs.evaluate((row) => getComputedStyle(row).maskImage)).toContain("linear-gradient");
  await tabs.hover();
  await team.mouse.wheel(0, 200);
  await expect.poll(() => tabs.evaluate((row) => row.scrollLeft)).toBeGreaterThan(0);
  expect(await team.evaluate(() => window.scrollY)).toBe(0);
  await expect(tabs).toHaveAttribute("data-more", "both");
  // A tab partly past the row's end, under the fade, is clicked where it is: it opens.
  const all = tabs.getByRole("link", { name: "All 10" });
  await all.evaluate((tab) => {
    const row = tab.parentElement!;
    row.scrollLeft = tab.offsetLeft + tab.offsetWidth - row.clientWidth - 20;
  });
  const partly = (await all.boundingBox())!;
  await team.mouse.click(partly.x + partly.width / 2, partly.y + partly.height / 2);
  await team.waitForURL(`**/app/${slug}/feedback?status=all`);
  // A tab reached with the keyboard is scrolled clear of the fade (2rem) at the row's end, even one already in the
  // row's width (10px from its end, under the fade): Tab from the tab before it, which is keyboard focus
  // (`:focus-visible`) whatever the last click was. From a page that's settled: the row scrolled to the current tab
  // first (centred, or as near as the row's end allows), so that can't move it again after the scroll set here.
  await team.goto(`/app/${slug}/feedback?status=all`);
  await expect
    .poll(() =>
      all.evaluate((tab) => {
        const row = tab.parentElement!;
        const centred = Math.min(Math.max(0, tab.offsetLeft - (row.clientWidth - tab.offsetWidth) / 2), row.scrollWidth - row.clientWidth);
        return Math.abs(row.scrollLeft - centred);
      }),
    )
    .toBeLessThanOrEqual(1);
  await tabs.getByRole("link", { name: "Done 0" }).focus();
  await all.evaluate((tab) => {
    const row = tab.parentElement!;
    row.scrollLeft = tab.offsetLeft + tab.offsetWidth - row.clientWidth + 10;
  });
  await team.keyboard.press("Tab");
  await expect(all).toBeFocused();
  expect(await all.evaluate((tab) => tab.matches(":focus-visible"))).toBe(true);
  const [focused, row] = [(await all.boundingBox())!, (await tabs.boundingBox())!];
  expect(focused.x + focused.width).toBeLessThanOrEqual(row.x + row.width - 32 + 1);
  // On a phone the last tab is past the window's edge: opened, the row is scrolled to it.
  await team.goto(`/app/${slug}/feedback?show=duplicates`);
  await expect(tabs.getByRole("link", { name: "Possible duplicates 0" })).toHaveAttribute("aria-current", "page");
  await expectOneRowOfTabs(team, tabs);
  await expect(tabs).toHaveAttribute("data-more", "start");
  await checkpoint(team, "feedback-390-last-tab", { fullPage: false });
  // So it is when the list comes back from a post opened in its place.
  await team.goto(`/app/${slug}/feedback?show=duplicates&post=1`);
  await expect(tabs).toBeHidden();
  await team.getByRole("link", { name: "Close" }).click();
  await expect(tabs).toBeVisible();
  await expectOneRowOfTabs(team, tabs);

  // Pinch-zoom (a wheel with Ctrl) is the browser's, not the row's.
  await team.goto(`/app/${slug}/feedback`);
  // The fade is set by the effect that listens to the wheel: once it's there, so is the listener (the page is hydrated).
  await expect(tabs).toHaveAttribute("data-more", "end");
  const pinch = await tabs.evaluate((row) => {
    const event = new WheelEvent("wheel", { deltaY: 200, ctrlKey: true, cancelable: true });
    row.dispatchEvent(event);
    return { prevented: event.defaultPrevented, left: row.scrollLeft };
  });
  expect(pinch).toEqual({ prevented: false, left: 0 });
  // A wheel that counts in pages (Firefox can) scrolls the row by its width, not a pixel.
  const paged = await tabs.evaluate((row) => {
    row.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE, cancelable: true }));
    const left = row.scrollLeft;
    row.scrollLeft = 0;
    return left;
  });
  expect(paged).toBeGreaterThan(100);
  // The fade follows the counts: in a window where the row is 3px too wide, a post out of Needs triage (10 to 9)
  // makes it fit, though the row itself is the same size.
  const over = await tabs.evaluate((row) => row.scrollWidth - row.clientWidth);
  await team.setViewportSize({ width: 390 + over - 3, height: 844 });
  await expect.poll(() => tabs.evaluate((row) => row.scrollWidth - row.clientWidth)).toBe(3);
  await expect(tabs).toHaveAttribute("data-more", "end");
  const idea = team.getByRole("main").getByRole("listitem").filter({ hasText: "Idea number 10" });
  await idea.getByRole("button", { name: "Status: Open" }).click();
  await team.getByRole("menuitemradio", { name: "Planned" }).click();
  await expect(tabs.getByRole("link", { name: "Needs triage 9" })).toBeVisible();
  await expect(tabs).not.toHaveAttribute("data-more");
});

test("long lists load 50 posts at a time, keeping the place in the address", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // 51 posts, "Idea 1" the oldest: with one vote each, the newest come first and it's the one on page two.
  await api("/posts", { board: "feature-requests", title: "Idea 1" });
  for (let start = 2; start <= 51; start += 10) {
    const numbers = Array.from({ length: 10 }, (_, i) => start + i);
    await Promise.all(numbers.map((n) => api("/posts", { board: "feature-requests", title: `Idea ${n}` })));
  }

  const portal = await signUp(browser, portalUrl(slug), "Ada");
  for (const [page, list] of [
    [portal, "/feedback/feature-requests"],
    [team, `/app/${slug}/feedback`],
  ] as const) {
    await page.goto(list);
    await expect(page.getByRole("link", { name: "Idea 51", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Idea 1", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Load more" }).click();
    await page.waitForURL(/\?page=2$/);
    await expect(page.getByRole("link", { name: "Idea 1", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Load more" })).toHaveCount(0);
    await checkpoint(page, page === portal ? "portal-board-page-two" : "team-feedback-page-two");
    // Back from a post on page two comes back to the whole list (the team's opens in the pane, page two kept).
    await page.getByRole("link", { name: "Idea 1", exact: true }).click();
    await page.waitForURL((url) => (page === team ? url.search.includes("post=1") : !url.search.includes("page")));
    await page.goBack();
    await expect(page.getByRole("link", { name: "Idea 1", exact: true })).toBeVisible();
  }
  // On page two too, a board's tab reorders the list where it is: scrolled to the tabs, the page doesn't jump to its top.
  await expect(portal).toHaveURL(/\?page=2$/);
  const sort = portal.getByRole("navigation", { name: "Sort" });
  await sort.evaluate((nav) => window.scrollTo(0, nav.getBoundingClientRect().top + window.scrollY - 100));
  const scrolled = await portal.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);
  await sort.getByRole("link", { name: "Top" }).click();
  await portal.waitForURL(/\?sort=top$/);
  await expect(portal.getByRole("link", { name: "Load more" })).toBeVisible();
  await expect.poll(() => portal.evaluate(() => window.scrollY)).toBe(scrolled);
});

test("a board opens on the ideas not done yet, with completed ones in Recently shipped, and its box finds similar ideas", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await api("/posts", { board: "feature-requests", title: "Export to CSV" });
  await api("/posts/2", { status: "completed" }, "PATCH");
  await api("/posts", { board: "feature-requests", title: "Email notifications arrive twice" });
  await api("/posts/3", { status: "completed" }, "PATCH");

  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/feedback/feature-requests");
  const main = visitor.getByRole("main");
  // The list has what's not done yet; what shipped is in its own card.
  await expect(main.getByRole("link", { name: "Dark mode" })).toBeVisible();
  const shipped = main.getByRole("region", { name: "Recently shipped" });
  await expect(shipped.getByRole("link", { name: "Export to CSV" })).toBeVisible();
  await expect(main.getByRole("link", { name: "Export to CSV" })).toHaveCount(1);
  // The card says they shipped: no Completed badge on each, so a title has the room to wrap by word, not mid-word.
  await expect(shipped).not.toContainText("Completed");
  expect((await shipped.getByRole("link", { name: "Email notifications arrive twice" }).boundingBox())!.width).toBeGreaterThan(120);
  await checkpoint(visitor, "portal-board-recently-shipped");
  await visitor.setViewportSize({ width: 390, height: 844 });
  await checkpoint(visitor, "portal-board-recently-shipped-phone");
  await visitor.setViewportSize({ width: 1280, height: 720 });
  // Signed out, the box takes an idea and shows the similar ones as it's typed.
  await main.getByLabel("Title").fill("Dark theme");
  await expect(main.getByRole("status").filter({ hasText: "Already posted? Vote on it instead:" })).toContainText("Dark mode");
  await checkpoint(visitor, "portal-board-share-idea");
  // Signing in to post (Enter does it too) comes back to the board as it was: its sort, and the idea in the box.
  await visitor.goto("/feedback/feature-requests?sort=new");
  await main.getByLabel("Title").fill("Dark theme");
  await main.getByLabel("Title").press("Enter");
  await visitor.waitForURL(/\/sign-in\?next=/);
  expect(new URL(visitor.url()).searchParams.get("next")).toBe("/feedback/feature-requests?sort=new&title=Dark+theme");
  // A title typed before the page's script ran (no input event reached it) goes along too.
  await visitor.goto("/feedback/feature-requests");
  await main.getByLabel("Title").evaluate((input: HTMLInputElement) => (input.value = "Typed early"));
  await main.getByRole("button", { name: "Sign in to post" }).click();
  await visitor.waitForURL(/\/sign-in\?next=/);
  expect(new URL(visitor.url()).searchParams.get("next")).toBe("/feedback/feature-requests?title=Typed+early");
  // Before the page's script runs (here, without JavaScript), "Sign in to post" still goes to sign-in, back to the board as it was.
  const noScript = await browser.newContext({ baseURL: portalUrl(slug), javaScriptEnabled: false });
  const early = await noScript.newPage();
  await early.goto("/feedback/feature-requests?sort=new");
  await early.getByRole("main").getByLabel("Title").fill("Dark theme");
  await early.getByRole("main").getByRole("button", { name: "Sign in to post" }).click();
  await early.waitForURL(/\/sign-in\?/);
  expect(new URL(early.url()).searchParams.get("next")).toBe("/feedback/feature-requests?sort=new");
  // Signing in there comes back with the title too (the "Continue" link carries where it goes).
  await expect(early.getByRole("link", { name: "Continue with your Tuti account" })).toHaveAttribute(
    "href",
    `/continue?${new URLSearchParams({ redirect: "/feedback/feature-requests?sort=new&title=Dark+theme" })}`,
  );
  await noScript.close();
  // Every status, asked for by address, lists the completed one too.
  await visitor.goto("/feedback/feature-requests?status=all");
  await expect(main.getByRole("link", { name: "Export to CSV" })).toHaveCount(1);
  await expect(shipped).toHaveCount(0);
  // The default list asked for by name (or with a status it doesn't know) has the card too.
  await visitor.goto("/feedback/feature-requests?status=active");
  await expect(shipped.getByRole("link", { name: "Export to CSV" })).toBeVisible();
});

test("a board's posts are rows, in Trending, Top or New order, and its search narrows them", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // Each with its author's vote, Dark mode the oldest; Sync contacts has shipped.
  for (const title of ["Dark mode", "Calendar sync", "Slack alerts", "Sync contacts"]) {
    await api("/posts", { board: "feature-requests", title });
  }
  await api("/posts/4", { status: "completed" }, "PATCH");
  // Dark mode has the most votes (3), all from a month ago; Calendar sync two this week.
  await api("/posts/1/vote", { voted: true, author: { id: "e2e-user-1" } });
  await api("/posts/1/vote", { voted: true, author: { id: "e2e-user-2" } });
  await api("/posts/2/vote", { voted: true, author: { id: "e2e-user-1" } });
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  await db.query(
    `UPDATE vote SET "createdAt" = now() - interval '30 days' WHERE "postId" = (SELECT p.id FROM post p JOIN project ON project.id = p."projectId" WHERE project.slug = $1 AND p.number = 1)`,
    [slug],
  );
  await db.end();

  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/feedback/feature-requests");
  const main = visitor.getByRole("main");
  const titles = main.getByRole("listitem").getByRole("heading", { level: 2 });
  const tabs = main.getByRole("navigation", { name: "Sort" });
  // Trending first: this week's votes, then the most.
  await expect(tabs.getByRole("link", { name: "Trending" })).toHaveAttribute("aria-current", "page");
  await expect(titles).toHaveText(["Calendar sync", "Slack alerts", "Dark mode"]);

  // A row: its status above the title, the vote button on the right.
  const row = main.getByRole("listitem").filter({ has: visitor.getByRole("link", { name: "Dark mode" }) });
  const rowLayout = async () => {
    const status = (await row.getByText("Open", { exact: true }).boundingBox())!;
    const title = (await row.getByRole("link", { name: "Dark mode" }).boundingBox())!;
    const vote = (await row.getByRole("button", { name: "Upvote" }).boundingBox())!;
    expect(status.y + status.height).toBeLessThanOrEqual(title.y);
    expect(vote.x).toBeGreaterThanOrEqual(title.x + title.width);
  };
  await rowLayout();
  await checkpoint(visitor, "portal-board-rows");

  // A tab reorders the list where it is: on a short window scrolled down to the tabs, the page doesn't jump to its top.
  await visitor.setViewportSize({ width: 1280, height: 500 });
  await tabs.evaluate((nav) => window.scrollTo(0, nav.getBoundingClientRect().top + window.scrollY - 100));
  const scrolled = await visitor.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);
  await tabs.getByRole("link", { name: "Top" }).click();
  await visitor.waitForURL(/\?sort=top$/);
  await expect(titles).toHaveText(["Dark mode", "Calendar sync", "Slack alerts"]);
  await expect.poll(() => visitor.evaluate(() => window.scrollY)).toBe(scrolled);
  await visitor.setViewportSize({ width: 1280, height: 720 });
  await tabs.getByRole("link", { name: "New" }).click();
  await visitor.waitForURL(/\?sort=new$/);
  await expect(titles).toHaveText(["Slack alerts", "Calendar sync", "Dark mode"]);

  // The search keeps the order and looks through every status, the shipped one too (it's no longer only in Recently shipped).
  await expect(main.getByRole("region", { name: "Recently shipped" })).toBeVisible();
  // An idea half written in the box stays there through a search.
  await main.getByLabel("Title").fill("Calendar in week view");
  await main.getByRole("searchbox", { name: "Search ideas" }).fill("sync");
  await main.getByRole("searchbox", { name: "Search ideas" }).press("Enter");
  await visitor.waitForURL(/\?sort=new&q=sync$/);
  await expect(titles).toHaveText(["Sync contacts", "Calendar sync"]);
  // The box keeps focus, to refine the search.
  await expect(main.getByRole("searchbox", { name: "Search ideas" })).toBeFocused();
  // What it found is read out (the page doesn't reload).
  await expect(main.getByRole("status").filter({ hasText: "ideas match" })).toHaveText('2 ideas match "sync"');
  await expect(main.getByRole("listitem").filter({ hasText: "Sync contacts" })).toContainText("Completed");
  await expect(main.getByRole("region", { name: "Recently shipped" })).toHaveCount(0);
  await expect(main.getByLabel("Title")).toHaveValue("Calendar in week view");
  // The tabs keep the search.
  await tabs.getByRole("link", { name: "Trending" }).click();
  await visitor.waitForURL(/\?q=sync$/);
  await expect(titles).toHaveText(["Calendar sync", "Sync contacts"]);
  await main.getByRole("searchbox", { name: "Search ideas" }).fill("nothing like it");
  await main.getByRole("searchbox", { name: "Search ideas" }).press("Enter");
  await expect(main.getByText("No ideas match", { exact: true })).toBeVisible();
  await expect(main.getByRole("status").filter({ hasText: "No ideas match" })).toHaveText('No ideas match "nothing like it"');
  // Back shows the search in the address, not the last one typed.
  await visitor.goBack();
  await visitor.waitForURL(/\?q=sync$/);
  await expect(main.getByRole("searchbox", { name: "Search ideas" })).toHaveValue("sync");
  // Words typed while a search loads stay in the box when its results land: its request held until they're typed.
  const box = main.getByRole("searchbox", { name: "Search ideas" });
  const found = main.getByRole("status").filter({ hasText: /match/ });
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const held = (url: URL) => url.searchParams.get("q") === "calendar";
  await visitor.route(held, async (route) => {
    await released;
    // Not one the page has dropped meanwhile (its router may ask again).
    await route.continue().catch(() => {});
  });
  await box.fill("calendar");
  await box.press("Enter");
  await box.pressSequentially(" sync");
  await expect(box).toHaveValue("calendar sync");
  // Still loading: the results are the last search's.
  await expect(found).toHaveText('2 ideas match "sync"');
  release();
  await expect(found).toHaveText('1 idea matches "calendar"');
  await expect(titles).toHaveText(["Calendar sync"]);
  await expect(box).toHaveValue("calendar sync");
  await expect(box).toBeFocused();
  await visitor.unroute(held);
  // A search within the ideas not done yet (an old address asking for them) has no Recently shipped beside it either.
  await visitor.goto("/feedback/feature-requests?status=active&q=calendar");
  await expect(titles).toHaveText(["Calendar sync"]);
  await expect(main.getByRole("region", { name: "Recently shipped" })).toHaveCount(0);
  // A sort it doesn't know opens on Trending, the default.
  await visitor.goto("/feedback/feature-requests?sort=votes");
  await expect(tabs.getByRole("link", { name: "Trending" })).toHaveAttribute("aria-current", "page");
  await expect(titles).toHaveText(["Calendar sync", "Slack alerts", "Dark mode"]);
  // A status asked for by address stays through a search and the tabs.
  await visitor.goto("/feedback/feature-requests?status=completed");
  await expect(titles).toHaveText(["Sync contacts"]);
  await main.getByRole("searchbox", { name: "Search ideas" }).fill("sync");
  await main.getByRole("searchbox", { name: "Search ideas" }).press("Enter");
  await visitor.waitForURL(/\?status=completed&q=sync$/);
  await expect(titles).toHaveText(["Sync contacts"]);
  await tabs.getByRole("link", { name: "Top" }).click();
  await visitor.waitForURL(/\?sort=top&q=sync&status=completed$/);
  await expect(titles).toHaveText(["Sync contacts"]);

  // On a phone too the vote button stays on the right, and nothing runs off the side; light and dark.
  for (const colorScheme of ["light", "dark"] as const) {
    const page = await (await browser.newContext({ colorScheme, baseURL: portalUrl(slug) })).newPage();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/feedback/feature-requests");
      await expect(page.getByRole("main").getByRole("link", { name: "Dark mode" })).toBeVisible();
      const sized = page.getByRole("main").getByRole("listitem").filter({ has: page.getByRole("link", { name: "Dark mode" }) });
      const title = (await sized.getByRole("link", { name: "Dark mode" }).boundingBox())!;
      const vote = (await sized.getByRole("button", { name: "Upvote" }).boundingBox())!;
      expect(vote.x).toBeGreaterThanOrEqual(title.x + title.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await checkpoint(page, `portal-board-${width === 390 ? "phone" : "desktop"}-${colorScheme}`);
    }
  }
});

test("on wide screens a board has a sidebar: the boards with their counts, Recently shipped and Get updates; your votes are filled in, and Mine lists yours", async ({
  browser,
}, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  await db.query(
    `INSERT INTO board (id, "projectId", slug, name, "createdAt", "updatedAt") SELECT 'e2e-bugs-' || id, id, 'bugs', 'Bug reports', now(), now() FROM project WHERE slug = $1`,
    [slug],
  );
  await db.end();
  const api = await apiFor(team, slug);
  for (const title of ["Dark mode", "Calendar sync", "Sync contacts"]) {
    await api("/posts", { board: "feature-requests", title });
  }
  await api("/posts/3", { status: "completed" }, "PATCH");
  await api("/posts", { board: "bugs", title: "Crash on save" });

  // Ada posts an idea and votes for another, from its row: her vote is filled in, and stays so.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.setViewportSize({ width: 1280, height: 900 });
  await ada.goto("/feedback/feature-requests");
  await postFeedback(ada, "Slack alerts");
  const main = ada.getByRole("main");
  const rowOf = (title: string) => main.getByRole("listitem").filter({ has: ada.getByRole("link", { name: title, exact: true }) });
  await rowOf("Calendar sync").getByRole("button", { name: "Upvote" }).click();
  // Saved once it's back (it's off while the vote is sent).
  await expect(rowOf("Calendar sync").getByRole("button", { name: "Remove vote" })).toBeEnabled();
  await ada.reload();
  const voted = rowOf("Calendar sync").getByRole("button", { name: "Remove vote" });
  const notVoted = rowOf("Dark mode").getByRole("button", { name: "Upvote" });
  await expect(voted).toHaveAttribute("aria-pressed", "true");
  await expect(voted).toHaveText("2");
  await expect(notVoted).toHaveAttribute("aria-pressed", "false");
  const background = (button: typeof voted) => button.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await background(voted)).not.toBe(await background(notVoted));

  // The sidebar, beside the list: the boards with their ideas not done yet (this one marked), Recently shipped, Get updates.
  const sidebar = ada.getByRole("complementary", { name: "About this board" });
  const boards = sidebar.getByRole("navigation", { name: "Boards" });
  await expect(boards.getByRole("link")).toHaveCount(2);
  await expect(boards.getByRole("link").first()).toHaveAccessibleName("Feature requests, 3 open ideas");
  await expect(boards.getByRole("link").last()).toHaveAccessibleName("Bug reports, 1 open idea");
  await expect(boards.getByRole("link").first()).toHaveText("Feature requests3");
  await expect(boards.getByRole("link", { name: "Feature requests" })).toHaveAttribute("aria-current", "page");
  await expect(boards.getByRole("link", { name: "Bug reports" })).not.toHaveAttribute("aria-current");
  // The header's row of boards is the sidebar's on wide screens: only one is shown.
  await expect(ada.getByRole("navigation", { name: "Boards" })).toHaveCount(1);
  const shipped = sidebar.getByRole("region", { name: "Recently shipped" });
  await expect(shipped.getByRole("link", { name: "Sync contacts" })).toBeVisible();
  await expect(main.getByRole("region", { name: "Recently shipped" })).toHaveCount(1);
  // It's in the page twice (under the list for phones), yet each id is once.
  const ids = await ada.evaluate(() => [...document.querySelectorAll("[id]")].map((element) => element.id));
  expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  // Get updates says what reaches her: not confirmed yet, the shipped email wouldn't, so it asks her to confirm (the link comes back here).
  const updates = sidebar.getByRole("region", { name: "Get updates" });
  await expect(updates).toContainText("Confirm your email to hear when ideas you vote on ship.");
  await expect(updates).not.toContainText("get an email when it ships");
  const emailsBefore = countEmailsTo(ada.email);
  await updates.getByRole("button", { name: "Resend email" }).click();
  await expect(updates.getByRole("button", { name: "Sent" })).toBeDisabled();
  const confirm = await latestEmailTo(ada.email, { after: emailsBefore });
  await ada.goto(confirm.text.split(/\s+/).find((word) => word.includes("/api/auth/verify-email"))!);
  await ada.waitForURL(/\/feedback\/feature-requests$/);
  await expect(updates).toContainText("Vote for an idea to get an email when it ships.");
  await expect(updates.getByRole("button", { name: "Resend email" })).toHaveCount(0);
  await expect(updates.getByRole("link", { name: "Changelog" })).toHaveAttribute("href", "/changelog");
  await expect(updates.getByRole("link", { name: "RSS" })).toHaveAttribute("href", "/changelog/rss.xml");
  const list = (await rowOf("Dark mode").boundingBox())!;
  const side = (await sidebar.boundingBox())!;
  expect(side.x).toBeGreaterThanOrEqual(list.x + list.width);
  expect(side.y).toBeLessThan(list.y);

  // Mine: what she posted or voted for, newest first, whatever its status; in the address, kept by a search.
  const tabs = main.getByRole("navigation", { name: "Sort" });
  const titles = main.getByRole("listitem").getByRole("heading", { level: 2 });
  await tabs.getByRole("link", { name: "Mine" }).click();
  await ada.waitForURL(/\?sort=mine$/);
  await expect(tabs.getByRole("link", { name: "Mine" })).toHaveAttribute("aria-current", "page");
  await expect(titles).toHaveText(["Slack alerts", "Calendar sync"]);
  await main.getByRole("searchbox", { name: "Search ideas" }).fill("calendar");
  await main.getByRole("searchbox", { name: "Search ideas" }).press("Enter");
  await ada.waitForURL(/\?sort=mine&q=calendar$/);
  await expect(titles).toHaveText(["Calendar sync"]);
  // Another board: nothing of hers there.
  await boards.getByRole("link", { name: "Bug reports" }).click();
  await ada.waitForURL(/\/feedback\/bugs$/);
  await tabs.getByRole("link", { name: "Mine" }).click();
  await expect(main.getByText("Nothing of yours yet", { exact: true })).toBeVisible();

  // Signed out there's no Mine, and its address is the board's default list.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/feedback/feature-requests?sort=mine");
  const visitorTabs = visitor.getByRole("main").getByRole("navigation", { name: "Sort" });
  await expect(visitorTabs.getByRole("link")).toHaveText(["Trending", "Top", "New"]);
  await expect(visitor.getByRole("region", { name: "Get updates" })).toContainText("Vote for an idea to hear when it ships.");
  await expect(visitorTabs.getByRole("link", { name: "Trending" })).toHaveAttribute("aria-current", "page");
  await expect(visitor.getByRole("main").getByRole("listitem").getByRole("heading", { level: 2 })).toHaveCount(3);

  // On a phone no sidebar: the boards' row is above, Recently shipped under the list, and nothing runs off the side. Light and dark.
  const signedIn = await ada.context().storageState();
  for (const colorScheme of ["light", "dark"] as const) {
    const page = await (await browser.newContext({ colorScheme, baseURL: portalUrl(slug), storageState: signedIn })).newPage();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/feedback/feature-requests");
      await expect(page.getByRole("main").getByRole("button", { name: "Remove vote" })).toHaveCount(2);
      await expect(page.getByRole("complementary", { name: "About this board" })).toHaveCount(width === 390 ? 0 : 1);
      await expect(page.getByRole("navigation", { name: "Boards" }).getByRole("link", { name: "Feature requests" })).toHaveAttribute("aria-current", "page");
      if (width === 390) {
        const phoneList = (await page.getByRole("main").getByRole("listitem").filter({ hasText: "Dark mode" }).boundingBox())!;
        const phoneShipped = (await page.getByRole("region", { name: "Recently shipped" }).boundingBox())!;
        expect(phoneShipped.y).toBeGreaterThan(phoneList.y);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await checkpoint(page, `portal-board-sidebar-${width === 390 ? "phone" : "desktop"}-${colorScheme}`);
    }
  }
});

test("the team's roadmap: a card dragged to another column changes its status; Completed asks first, saying who's emailed", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  // Two planned ideas; Ada, from the app, voted for one.
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await api("/posts", { board: "feature-requests", title: "Calendar sync" });
  await api("/posts/1/vote", { voted: true, author: { id: "user-ada", name: "Ada", email: "e2e-ada@example.com" } });
  for (const number of [1, 2]) {
    await api(`/posts/${number}`, { status: "planned" }, "PATCH");
  }

  // From Feedback's header.
  await team.goto(`/app/${slug}/feedback`);
  await team.getByRole("link", { name: "Roadmap" }).click();
  await team.waitForURL(`**/app/${slug}/feedback/roadmap`);
  const column = (name: string) => team.getByRole("region", { name });
  const card = (title: string) => team.getByRole("listitem").filter({ hasText: title });
  await expect(column("Planned").getByRole("listitem")).toHaveCount(2);
  // The column says the status: its cards don't repeat it (a dot only by the column's name).
  await expect(column("Planned").locator("[data-status-dot]")).toHaveCount(1);
  await checkpoint(team, "team-roadmap");
  await team.setViewportSize({ width: 390, height: 844 });
  await checkpoint(team, "team-roadmap-phone");
  await team.setViewportSize({ width: 1280, height: 720 });

  // Dragged to In progress: its status changes.
  await card("Calendar sync").dragTo(column("In progress"));
  await expect(team.getByText("Calendar sync: In progress")).toBeVisible();
  await expect(column("In progress").getByRole("listitem")).toHaveCount(1);

  // Dragged to Completed: asked first, saying who is emailed (Ada; the team never is).
  await card("Dark mode").dragTo(column("Completed"));
  const ask = team.getByRole("alertdialog", { name: "Mark “Dark mode” completed?" });
  await expect(ask).toContainText("This emails up to 1 person who asked for it that it shipped.");
  await checkpoint(team, "team-roadmap-complete", { fullPage: false });
  // Cancelled: nothing changes.
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(team.getByRole("alertdialog")).toHaveCount(0);
  await expect(column("Planned").getByRole("listitem")).toHaveCount(1);
  await card("Dark mode").dragTo(column("Completed"));
  await team.getByRole("alertdialog").getByRole("button", { name: "Mark completed" }).click();
  await expect(team.getByText("Dark mode: Completed")).toBeVisible();
  await expect(column("Completed").getByRole("listitem")).toHaveCount(1);

  // From a card's status menu (the keyboard's way, and a phone's), Completed asks first too.
  await card("Calendar sync").getByRole("button", { name: "Status: In progress" }).click();
  await team.getByRole("menuitemradio", { name: "Completed" }).click();
  await expect(team.getByRole("alertdialog", { name: "Mark “Calendar sync” completed?" })).toContainText("Nobody is emailed.");
  await team.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(column("In progress").getByRole("listitem")).toHaveCount(1);
  // Any other status from the menu moves the card at once. Picked from the keyboard, the button keeps the focus while
  // it saves (its answer held here), disabled.
  let releaseMove!: () => void;
  const moveHeld = new Promise<void>((resolve) => (releaseMove = resolve));
  await team.route("**/*", async (route) => {
    if (!route.request().headers()["next-action"]) {
      return route.fallback();
    }
    const response = await route.fetch();
    await moveHeld;
    await route.fulfill({ response });
  });
  const statusButton = card("Calendar sync").getByRole("button", { name: "Status: In progress" });
  await statusButton.focus();
  await team.keyboard.press("Enter");
  await team.getByRole("menuitemradio", { name: "Planned" }).focus();
  await team.keyboard.press("Enter");
  await expect(statusButton).toHaveAttribute("aria-disabled", "true");
  await expect(statusButton).toBeFocused();
  releaseMove();
  await expect(column("Planned").getByRole("listitem").filter({ hasText: "Calendar sync" })).toBeVisible();
  await team.unroute("**/*");
  await expect(column("In progress").getByRole("listitem")).toHaveCount(0);

  // A board at a time: a bug planned on another board leaves when Feature requests is picked.
  await team.goto(`/app/${slug}/feedback/boards`);
  await team.getByRole("button", { name: "New board" }).click();
  const newBoard = team.getByRole("dialog", { name: "New board" });
  await newBoard.getByLabel("Name").fill("Bugs");
  await newBoard.getByRole("button", { name: "Create board" }).click();
  await expect(team.getByRole("dialog")).toHaveCount(0);
  await api("/posts", { board: "bugs", title: "Crash on save" });
  await api("/posts/3", { status: "planned" }, "PATCH");
  await team.goto(`/app/${slug}/feedback/roadmap`);
  await expect(card("Crash on save")).toBeVisible();
  await team.getByRole("combobox", { name: "Board" }).click();
  await team.getByRole("option", { name: "Feature requests" }).click();
  await expect(team).toHaveURL(/\?board=feature-requests$/);
  await expect(card("Crash on save")).toHaveCount(0);
  await expect(card("Calendar sync")).toBeVisible();
});

test("Feedback's split view: a row opens the post beside the list, to triage and reply; J and K step through, Esc closes", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  for (const title of ["Dark mode", "Calendar sync", "Export to PDF"]) {
    await api("/posts", { board: "feature-requests", title, body: `Please add ${title.toLowerCase()}.` });
  }
  await team.setViewportSize({ width: 1440, height: 900 });
  // All of them (a post triaged in the pane stays in the list).
  await team.goto(`/app/${slug}/feedback?status=all`);
  await expect(team.getByText("Open a post to triage it here")).toBeVisible();
  const pane = team.getByRole("region", { name: /^Post #/ });

  // The open row is highlighted out to the list card's edges, the first and last rows into its corners: no box in a box.
  const card = team.locator('[data-slot="card"]').filter({ has: team.getByRole("link", { name: "Calendar sync", exact: true }) });
  const rows = card.getByRole("listitem");
  const line = (index: number) => rows.nth(index).evaluate((li) => getComputedStyle(li).borderBottomColor);
  for (const [index, edge] of [[0, "top"], [2, "bottom"]] as const) {
    const row = rows.nth(index);
    const before = (await row.getByRole("link").boundingBox())!;
    await row.getByRole("link").click();
    await expect(row.getByRole("link")).toHaveAttribute("aria-current", "true");
    const r = (await row.boundingBox())!;
    const c = (await card.boundingBox())!;
    expect(r.x).toBeCloseTo(c.x, 0);
    expect(r.x + r.width).toBeCloseTo(c.x + c.width, 0);
    if (edge === "top") expect(r.y).toBeCloseTo(c.y, 0);
    else expect(r.y + r.height).toBeCloseTo(c.y + c.height, 0);
    // Its content stays where it was, and no divider crosses the highlight: neither its own line nor the one above it.
    const after = (await row.getByRole("link").boundingBox())!;
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
    expect(await line(index)).toBe("rgba(0, 0, 0, 0)");
    if (index > 0) expect(await line(index - 1)).toBe("rgba(0, 0, 0, 0)");
  }

  // A row's title opens it beside the list, which stays.
  await team.getByRole("link", { name: "Calendar sync", exact: true }).click();
  await expect(pane.getByRole("heading", { name: "Calendar sync" })).toBeVisible();
  await expect(pane).toContainText("Please add calendar sync.");
  await expect(team.getByRole("link", { name: "Dark mode", exact: true })).toBeVisible();
  await expect(team.getByRole("link", { name: "Calendar sync", exact: true })).toHaveAttribute("aria-current", "true");
  await checkpoint(team, "team-feedback-split");
  await team.emulateMedia({ colorScheme: "dark" });
  await expect(team.locator("html")).toHaveClass(/dark/);
  await checkpoint(team, "team-feedback-split-dark");
  await team.emulateMedia({ colorScheme: "light" });
  await expect(team.locator("html")).not.toHaveClass(/dark/);

  // Triaged there: its status, and a reply as the team.
  await pane.getByRole("combobox", { name: "Status" }).click();
  await team.getByRole("option", { name: "Planned" }).click();
  await expect(team.getByText("Status: Planned")).toBeVisible();
  await pane.getByRole("textbox", { name: "Comment" }).fill("On our list for next month.");
  await pane.getByRole("button", { name: "Comment" }).click();
  await expect(pane.getByRole("textbox", { name: "Comment" })).toHaveText("");

  // Scrolled down the pane (to its reply box) on a short laptop screen, J's post starts at its top.
  await team.setViewportSize({ width: 1440, height: 420 });
  await team.getByRole("complementary", { name: "Post" }).evaluate((aside) => aside.scrollTo(0, aside.scrollHeight));
  await expect(pane.getByRole("heading", { name: "Calendar sync" })).not.toBeInViewport();
  await team.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await team.keyboard.press("j");
  const titles = await team.getByRole("main").getByRole("listitem").getByRole("link").allTextContents();
  const after = titles[titles.indexOf("Calendar sync") + 1]!;
  await expect(pane.getByRole("heading", { name: after })).toBeInViewport();
  await team.keyboard.press("k");
  await expect(pane.getByRole("heading", { name: "Calendar sync" })).toBeInViewport();
  await team.setViewportSize({ width: 1440, height: 900 });

  // Writing a reply, its Internal note switch focused: Esc doesn't close the pane (the draft would be lost).
  await pane.getByRole("textbox", { name: "Comment" }).fill("Half a thought");
  await pane.getByRole("switch", { name: /Internal note/ }).focus();
  await team.keyboard.press("Escape");
  // (Once anything Esc would have done has happened.)
  await team.waitForLoadState("networkidle");
  await expect(pane).toBeVisible();
  await expect(pane.getByRole("textbox", { name: "Comment" })).toHaveText("Half a thought");
  await pane.getByRole("textbox", { name: "Comment" }).fill("");
  await team.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // J and K step through the list in the pane; Esc closes it.
  const order = await team.getByRole("main").getByRole("listitem").getByRole("link").allTextContents();
  const at = order.indexOf("Calendar sync");
  await team.locator("body").press("j");
  await expect(pane.getByRole("heading", { name: order[at + 1]! })).toBeVisible();
  await team.locator("body").press("k");
  await expect(pane.getByRole("heading", { name: "Calendar sync" })).toBeVisible();
  await team.locator("body").press("Escape");
  await expect(pane).toHaveCount(0);
  await expect(team.getByText("Open a post to triage it here")).toBeVisible();

  // Open full page: the post's own page, with the reply.
  await team.getByRole("link", { name: "Dark mode", exact: true }).click();
  await pane.getByRole("link", { name: "Open full page" }).click();
  await team.waitForURL(/\/p\/\d+$/);
  await team.goto(`/app/${slug}/p/2`);
  await expect(team.getByText("On our list for next month.")).toBeVisible();

  // On Needs triage, the way it's used: set a post's status (it leaves the tab) and press J straight away, the
  // select still focused: the post after it, not the top of the list; Esc closes, from the select too.
  await team.goto(`/app/${slug}/feedback`);
  const triage = await team.getByRole("main").getByRole("listitem").getByRole("link").allTextContents();
  expect(triage).toHaveLength(2);
  await team.getByRole("link", { name: triage[0]!, exact: true }).click();
  await pane.getByRole("combobox", { name: "Status" }).click();
  await team.getByRole("option", { name: "Under review" }).click();
  await expect(team.getByRole("link", { name: triage[0]!, exact: true })).toHaveCount(0);
  // (Its select keeps focus after a pick in some browsers: J works from there too.)
  await pane.getByRole("combobox", { name: "Status" }).focus();
  await team.keyboard.press("j");
  await expect(pane.getByRole("heading", { name: triage[1]! })).toBeVisible();
  await pane.getByRole("combobox", { name: "Status" }).focus();
  await team.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);

  // On the last post, J has nowhere to go: a pane select that has focus doesn't take the J as an option (June, July).
  await team.goto(`/app/${slug}/feedback?status=all`);
  const listed = await team.getByRole("main").getByRole("listitem").getByRole("link").allTextContents();
  await team.getByRole("link", { name: listed.at(-1)!, exact: true }).click();
  const eta = pane.getByRole("combobox", { name: "ETA" });
  const before = await eta.textContent();
  await eta.focus();
  await team.keyboard.press("j");
  // Saved as it's picked: what's saved, once anything sent has gone, is still what it was.
  await team.waitForLoadState("networkidle");
  await team.reload();
  await expect(pane.getByRole("heading", { name: listed.at(-1)! })).toBeVisible();
  await expect(eta).toHaveText(before!);

  // Filtered so the open post isn't listed any more (another board), J opens the new list's first.
  await team.goto(`/app/${slug}/feedback/boards`);
  await team.getByRole("button", { name: "New board" }).click();
  await team.getByRole("dialog", { name: "New board" }).getByLabel("Name").fill("Bug reports");
  await team.getByRole("dialog", { name: "New board" }).getByRole("button", { name: "Create board" }).click();
  await expect(team.getByText("Board created")).toBeVisible();
  await api("/posts", { board: "bug-reports", title: "Crash on export" });
  // The others voted for, so it's last on the list: none listed after it once it's filtered out.
  for (const number of [1, 2, 3]) {
    await api(`/posts/${number}/vote`, { voted: true, author: { id: `user-${number}` } });
  }
  await team.goto(`/app/${slug}/feedback?status=all`);
  await team.getByRole("link", { name: "Crash on export", exact: true }).click();
  await expect(pane.getByRole("heading", { name: "Crash on export" })).toBeVisible();
  await team.getByRole("combobox", { name: "Board" }).first().click();
  await team.getByRole("option", { name: "Feature requests" }).click();
  await expect(team.getByRole("link", { name: "Crash on export", exact: true })).toHaveCount(0);
  const filtered = await team.getByRole("main").getByRole("listitem").getByRole("link").allTextContents();
  // (Back on the page: a filter's own select, focused, keeps its letters.)
  await team.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await team.keyboard.press("j");
  await expect(pane.getByRole("heading", { name: filtered[0]! })).toBeVisible();

  // An address with a post number past any (a mistyped link) says there's no such post.
  await team.goto(`/app/${slug}/feedback?post=3000000000`);
  await expect(team.getByText("There's no post #3000000000 here.")).toBeVisible();

  // On a phone: the pane takes the list's place, and its arrow goes back to the list.
  await team.setViewportSize({ width: 390, height: 800 });
  await team.goto(`/app/${slug}/feedback?status=all`);
  await team.getByRole("link", { name: "Export to PDF", exact: true }).click();
  await expect(pane.getByRole("heading", { name: "Export to PDF" })).toBeVisible();
  await expect(team.getByRole("link", { name: "Dark mode", exact: true })).toBeHidden();
  await checkpoint(team, "team-feedback-split-phone");
  await pane.getByRole("link", { name: "Close" }).click();
  await expect(team.getByRole("link", { name: "Dark mode", exact: true })).toBeVisible();
  // Opened from far down a long list, the pane starts at its top, not where the list was scrolled.
  await Promise.all(Array.from({ length: 20 }, (_, i) => api("/posts", { board: "feature-requests", title: `Idea ${i + 1}` })));
  await team.setViewportSize({ width: 390, height: 360 });
  await team.goto(`/app/${slug}/feedback?status=all`);
  await team.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const last = (await team.getByRole("main").getByRole("listitem").getByRole("link").allTextContents()).at(-1)!;
  await team.getByRole("link", { name: last, exact: true }).click();
  await expect(pane.getByRole("heading", { name: last })).toBeInViewport();
  // Its first row (Close, Open full page) clear of the app's bar (3rem), not under it.
  const header = (await team.locator("header").first().boundingBox())!;
  expect((await pane.getByRole("link", { name: "Close" }).boundingBox())!.y).toBeGreaterThanOrEqual(header.y + header.height);
  // Closed, the list is back where it was: at the row just triaged.
  await pane.getByRole("link", { name: "Close" }).click();
  await expect(team.getByRole("link", { name: last, exact: true })).toBeInViewport();

  // The list's place, exactly, whichever way the pane opened. (Each from a fresh page: nothing kept before.)
  const scrollY = () => team.evaluate(() => Math.round(window.scrollY));
  const scrolledTo = async (y: number) => {
    await team.evaluate((to) => window.scrollTo(0, to), y);
    await expect.poll(scrollY).toBe(y);
  };
  // J from part way down the list (it opens the first post), then Esc. (Each page ready for keys first.)
  await team.goto(`/app/${slug}/feedback?status=all`);
  await team.waitForLoadState("networkidle");
  await scrolledTo(400);
  await team.keyboard.press("j");
  await expect(pane).toBeVisible();
  await team.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
  await expect.poll(scrollY).toBe(400);
  // J from the very top: back at the top.
  await team.goto(`/app/${slug}/feedback?status=all`);
  await team.waitForLoadState("networkidle");
  await scrolledTo(0);
  await team.keyboard.press("j");
  await expect(pane).toBeVisible();
  await team.keyboard.press("Escape");
  await expect.poll(scrollY).toBe(0);
  // Opened, Back, the list scrolled elsewhere, Forward (the pane again), closed: at that new place.
  await team.goto(`/app/${slug}/feedback?status=all`);
  await team.waitForLoadState("networkidle");
  await team.getByRole("link", { name: last, exact: true }).click();
  await expect(pane).toBeVisible();
  await team.goBack();
  await expect(pane).toHaveCount(0);
  await scrolledTo(300);
  await team.goForward();
  await expect(pane).toBeVisible();
  await pane.getByRole("link", { name: "Close" }).click();
  await expect.poll(scrollY).toBe(300);
});

test("Feedback's rows picked for Set status, Move to board and Merge; Completed asks first", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  for (const title of ["Dark mode", "Night theme", "Calendar sync", "Export to PDF"]) {
    await api("/posts", { board: "feature-requests", title });
  }
  // Night theme has a vote: it's the one kept by default when merged with Dark mode. Dark mode is planned: merged, its page keeps that.
  await api("/posts/2/vote", { voted: true, author: { id: "user-1" } });
  await api("/posts/1", { status: "planned" }, "PATCH");
  await team.goto(`/app/${slug}/feedback/boards`);
  await team.getByRole("button", { name: "New board" }).click();
  await team.getByRole("dialog", { name: "New board" }).getByLabel("Name").fill("Bug reports");
  await team.getByRole("dialog", { name: "New board" }).getByRole("button", { name: "Create board" }).click();
  await expect(team.getByText("Board created")).toBeVisible();

  await team.goto(`/app/${slug}/feedback?status=all`);
  const bar = team.getByRole("toolbar", { name: "Selected posts" });
  const row = (title: string) => team.getByRole("main").getByRole("listitem").filter({ hasText: title });
  await expect(bar).toHaveCount(0);
  // The team writes a post on their portal, from the header.
  const newPost = team.getByRole("link", { name: "New post (on your portal)" });
  await expect(newPost).toHaveAttribute("href", `${portalUrl(slug)}/feedback`);
  await expect(newPost).toHaveAttribute("target", "_blank");
  // A vote count says it's votes, and a tab of every status shows each row's.
  await expect(row("Night theme")).toContainText(/^\s*2 votes\s*Night theme/);
  await expect(row("Night theme").getByText("Open", { exact: true })).toBeVisible();
  const background = (title: string) => row(title).evaluate((li) => getComputedStyle(li).backgroundColor);
  const fill = () => newPost.evaluate((link) => getComputedStyle(link).backgroundColor);
  const primary = await fill();
  const unpicked = await background("Calendar sync");
  // Where the list starts, on a phone and on a laptop.
  await team.setViewportSize({ width: 390, height: 844 });
  const phoneTop = (await row("Night theme").boundingBox())!.y;
  await team.setViewportSize({ width: 1280, height: 720 });
  const top = (await row("Night theme").boundingBox())!.y;

  // Two picked: tinted, the bar in the filters' place (the list stays where it was); their status set at once.
  await team.getByRole("checkbox", { name: "Select Calendar sync" }).check();
  await team.getByRole("checkbox", { name: "Select Export to PDF" }).check();
  await expect(bar).toContainText("2 selected");
  await expect(team.getByRole("combobox", { name: "Board" })).toHaveCount(0);
  expect((await row("Night theme").boundingBox())!.y).toBe(top);
  expect(await background("Calendar sync")).not.toBe(unpicked);
  expect(await background("Dark mode")).toBe(unpicked);
  await checkpoint(team, "team-feedback-bulk");
  // On a phone too, the bar is one row the filters' height: the list stays where it was.
  await team.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await row("Night theme").boundingBox())!.y).toBe(phoneTop);
  await checkpoint(team, "team-feedback-bulk-phone");
  await team.setViewportSize({ width: 1280, height: 720 });
  // Open beside the list as well as picked: a stronger tint than the other picked row, still picked.
  await row("Calendar sync").getByRole("link", { name: "Calendar sync" }).click();
  await team.waitForURL(/post=3/);
  await expect.poll(() => background("Calendar sync")).not.toBe(await background("Export to PDF"));
  await expect(bar).toContainText("2 selected");
  // Its tint is for being picked as well: unticked (still open), it changes; ticked again, it's back.
  const openAndPicked = await background("Calendar sync");
  await team.getByRole("checkbox", { name: "Select Calendar sync" }).uncheck();
  await expect(bar).toContainText("1 selected");
  await expect.poll(() => background("Calendar sync")).not.toBe(openAndPicked);
  await team.getByRole("checkbox", { name: "Select Calendar sync" }).check();
  await expect(bar).toContainText("2 selected");
  await expect.poll(() => background("Calendar sync")).toBe(openAndPicked);
  // The open post has its own primary button: New post isn't one beside it.
  await expect.poll(fill).not.toBe(primary);
  // Beside the open post the list's column is narrower than the window suggests: the bar's words follow the
  // column, and it's still one row the filters' height.
  await team.setViewportSize({ width: 1180, height: 720 });
  const besideTop = (await row("Night theme").boundingBox())!.y;
  for (const title of ["Calendar sync", "Export to PDF"]) {
    await team.getByRole("checkbox", { name: `Select ${title}` }).uncheck();
  }
  await expect(bar).toHaveCount(0);
  expect((await row("Night theme").boundingBox())!.y).toBe(besideTop);
  for (const title of ["Calendar sync", "Export to PDF"]) {
    await team.getByRole("checkbox", { name: `Select ${title}` }).check();
  }
  await expect(bar).toContainText("2 selected");
  await checkpoint(team, "team-feedback-bulk-beside-post");
  await team.setViewportSize({ width: 1280, height: 720 });
  await team.getByRole("region", { name: /^Post #/ }).getByRole("link", { name: "Close" }).click();
  await team.waitForURL((url) => !url.searchParams.has("post"));
  await expect.poll(fill).toBe(primary);
  await bar.getByRole("button", { name: "Set status" }).click();
  await team.getByRole("menuitem", { name: "Planned" }).click();
  await expect(team.getByText("2 posts: Planned")).toBeVisible();
  await expect(bar).toHaveCount(0);
  for (const title of ["Calendar sync", "Export to PDF"]) {
    await expect(row(title).getByRole("button", { name: "Status: Planned" })).toBeVisible();
  }

  // Completed emails their voters: asked first; cancelled, nothing changes.
  await team.getByRole("checkbox", { name: "Select Calendar sync" }).check();
  await bar.getByRole("button", { name: "Set status" }).click();
  await team.getByRole("menuitem", { name: "Completed" }).click();
  const ask = team.getByRole("alertdialog", { name: "Mark 1 post as Completed?" });
  // Who it emails (here, nobody: only the team has voted).
  await expect(ask).toContainText("Nobody is emailed.");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  await expect(row("Calendar sync").getByRole("button", { name: "Status: Planned" })).toBeVisible();

  // From a row's own status menu, Completed asks first too.
  await row("Export to PDF").getByRole("button", { name: "Status: Planned" }).click();
  await team.getByRole("menuitemradio", { name: "Completed" }).click();
  const one = team.getByRole("alertdialog", { name: "Mark “Export to PDF” completed?" });
  await expect(one).toContainText("Nobody is emailed.");
  await one.getByRole("button", { name: "Cancel" }).click();
  await expect(row("Export to PDF").getByRole("button", { name: "Status: Planned" })).toBeVisible();

  // Moved to another board.
  await bar.getByRole("button", { name: "Move to board" }).click();
  await team.getByRole("menuitem", { name: "Bug reports" }).click();
  await expect(team.getByText("1 post moved to Bug reports")).toBeVisible();
  await expect(row("Calendar sync")).toContainText("Bug reports");

  // Two merged: the most voted for is kept, the other gone from the list.
  await team.getByRole("checkbox", { name: "Select Dark mode" }).check();
  await team.getByRole("checkbox", { name: "Select Night theme" }).check();
  await bar.getByRole("button", { name: "Merge…" }).click();
  const merge = team.getByRole("alertdialog", { name: "Merge 2 posts into one?" });
  await expect(merge.getByRole("radio", { name: /Night theme/ })).toBeChecked();
  await merge.getByRole("button", { name: "Merge into #2" }).click();
  await expect(team.getByText("Merged into #2")).toBeVisible();
  await expect(team.getByRole("link", { name: "Dark mode", exact: true })).toHaveCount(0);
  await expect(team.getByRole("link", { name: "Night theme", exact: true })).toBeVisible();
  await expect(merge).toHaveCount(0);

  // Picked again after a confirmed one: no dialog opens by itself. Completed confirmed closes too.
  await team.getByRole("checkbox", { name: "Select Export to PDF" }).check();
  await expect(team.getByRole("alertdialog")).toHaveCount(0);
  await bar.getByRole("button", { name: "Set status" }).click();
  await team.getByRole("menuitem", { name: "Completed" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Mark Completed" }).click();
  await expect(team.getByText("1 post: Completed")).toBeVisible();
  await expect(team.getByRole("alertdialog")).toHaveCount(0);
  await team.getByRole("checkbox", { name: "Select Night theme" }).check();
  await expect(team.getByRole("alertdialog")).toHaveCount(0);

  // Merge's choice of which to keep starts at the most voted for each time, not the last one picked.
  await team.getByRole("checkbox", { name: "Select Calendar sync" }).check();
  await bar.getByRole("button", { name: "Merge…" }).click();
  const again = team.getByRole("alertdialog", { name: "Merge 2 posts into one?" });
  await again.getByRole("radio", { name: /Calendar sync/ }).check();
  await again.getByRole("button", { name: "Cancel" }).click();
  await bar.getByRole("button", { name: "Merge…" }).click();
  await expect(again.getByRole("radio", { name: /Night theme/ })).toBeChecked();
  await again.getByRole("button", { name: "Cancel" }).click();
  await team.getByRole("checkbox", { name: "Select Calendar sync" }).uncheck();

  // A box just ticked (focused) doesn't keep J: it opens the first post.
  const box = team.getByRole("checkbox", { name: "Select Night theme" });
  await box.uncheck();
  await box.check();
  await expect(box).toBeFocused();
  await team.keyboard.press("j");
  await expect(team.getByRole("region", { name: /^Post #/ })).toBeVisible();
  await team.keyboard.press("Escape");

  // Another tab or filter: what was picked isn't any more (none of it may be listed).
  await expect(bar).toContainText("1 selected");
  await team.getByRole("navigation", { name: "Statuses" }).getByRole("link", { name: /^Planned/ }).click();
  await team.waitForURL(/status=planned/);
  await expect(bar).toHaveCount(0);
  // A tab of one status doesn't say it on every row: a small button opens the menu.
  await expect(row("Calendar sync").getByRole("button", { name: "Status: Planned" })).toBeVisible();
  await expect(row("Calendar sync").getByText("Planned", { exact: true })).toHaveCount(0);
  await checkpoint(team, "team-feedback-one-status");
  // A picked post that leaves the list another way (its own status menu) isn't picked any more either.
  await team.getByRole("checkbox", { name: "Select Calendar sync" }).check();
  await expect(bar).toContainText("1 selected");
  await row("Calendar sync").getByRole("button", { name: "Status: Planned" }).click();
  await team.getByRole("menuitemradio", { name: "Under review" }).click();
  await expect(row("Calendar sync")).toHaveCount(0);
  await expect(bar).toHaveCount(0);

  // The merged post's page keeps its status history (its comments moved, so no "0 comments" over it).
  await team.goto(`/app/${slug}/p/1`);
  // Named for what it shows: no comments, only its status history.
  await expect(team.getByRole("region", { name: "Status history" })).toContainText("Open → Planned, by Olive Owner");
  await expect(team.getByRole("region", { name: "Comments" })).toHaveCount(0);
  await expect(team.getByText(/\d+ comments?$/)).toHaveCount(0);
});

test("Feedback's picked rows: one that can't be done (merged meanwhile) is said, and the rest still go", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  for (const title of ["Dark mode", "Night theme", "Dark theme"]) {
    await api("/posts", { board: "feature-requests", title });
  }
  // Dark theme (#3) has a vote: it's the one kept.
  await api("/posts/3/vote", { voted: true, author: { id: "user-1" } });
  await team.goto(`/app/${slug}/feedback?status=all`);
  for (const title of ["Dark mode", "Night theme", "Dark theme"]) {
    await team.getByRole("checkbox", { name: `Select ${title}` }).check();
  }
  // Meanwhile, elsewhere, Dark mode is merged into Dark theme (this page doesn't know yet).
  await api("/posts/1/merge", { into: 3 });
  await team.getByRole("toolbar", { name: "Selected posts" }).getByRole("button", { name: "Merge…" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Merge into #3" }).click();
  await expect(team.getByText("1 of 2 done. #1: This post was already merged")).toBeVisible();
  // The other went, and the list is fresh, none picked.
  await expect(team.getByRole("link", { name: "Night theme", exact: true })).toHaveCount(0);
  await expect(team.getByRole("toolbar", { name: "Selected posts" })).toHaveCount(0);
});

test("Feedback's picked rows go by the list as it is now: Merge keeps the one with the most votes after they changed", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  for (const title of ["Dark mode", "Night theme", "Export to PDF"]) {
    await api("/posts", { board: "feature-requests", title });
  }
  await team.goto(`/app/${slug}/feedback?status=all`);
  await team.getByRole("checkbox", { name: "Select Dark mode" }).check();
  await team.getByRole("checkbox", { name: "Select Night theme" }).check();
  // Meanwhile Night theme gets votes; the list refreshes (another post's status set from its row).
  await api("/posts/2/vote", { voted: true, author: { id: "user-1" } });
  await api("/posts/2/vote", { voted: true, author: { id: "user-2" } });
  const other = team.getByRole("main").getByRole("listitem").filter({ hasText: "Export to PDF" });
  await other.getByRole("button", { name: /^Status: / }).click();
  await team.getByRole("menuitemradio", { name: "Planned" }).click();
  await expect(team.getByText("Status: Planned")).toBeVisible();
  // Its vote count, first in the row (not its number, #2): its author's and the two new ones.
  await expect(team.getByRole("main").getByRole("listitem").filter({ hasText: "Night theme" })).toContainText(/^\s*3 votes\s*Night theme/);
  await team.getByRole("toolbar", { name: "Selected posts" }).getByRole("button", { name: "Merge…" }).click();
  await expect(team.getByRole("alertdialog").getByRole("radio", { name: /Night theme/ })).toBeChecked();
});

test("Feedback's picked row that leaves the list and comes back (its status set from the pane) isn't picked any more", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  for (const title of ["Dark mode", "Export to PDF"]) {
    await api("/posts", { board: "feature-requests", title });
  }
  await team.goto(`/app/${slug}/feedback`);
  await team.getByRole("link", { name: "Dark mode", exact: true }).click();
  const pane = team.getByRole("region", { name: /^Post #/ });
  await team.getByRole("checkbox", { name: "Select Dark mode" }).check();
  const bar = team.getByRole("toolbar", { name: "Selected posts" });
  await expect(bar).toContainText("1 selected");
  // Planned: it leaves Needs triage.
  await pane.getByRole("combobox", { name: "Status" }).click();
  await team.getByRole("option", { name: "Planned" }).click();
  await expect(team.getByRole("checkbox", { name: "Select Dark mode" })).toHaveCount(0);
  await expect(bar).toHaveCount(0);
  // Open again: back in the list, not picked.
  await pane.getByRole("combobox", { name: "Status" }).click();
  await team.getByRole("option", { name: "Open" }).click();
  await expect(team.getByRole("checkbox", { name: "Select Dark mode" })).not.toBeChecked();
  await expect(bar).toHaveCount(0);
});

test("Feedback's row boxes are off while a picked rows' action runs, and back once it's done", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  for (const title of ["Dark mode", "Night theme", "Export to PDF"]) {
    await api("/posts", { board: "feature-requests", title });
  }
  await team.goto(`/app/${slug}/feedback?status=all`);
  await team.getByRole("checkbox", { name: "Select Dark mode" }).check();
  await team.getByRole("checkbox", { name: "Select Night theme" }).check();
  // The action's requests held until the boxes are checked.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await team.route(`**/app/${slug}/feedback**`, async (route) => {
    if (route.request().method() === "POST") {
      await held;
    }
    await route.continue();
  });
  const setStatus = team.getByRole("toolbar", { name: "Selected posts" }).getByRole("button", { name: "Set status" });
  await setStatus.click();
  await team.getByRole("menuitem", { name: "Planned" }).click();
  for (const title of ["Dark mode", "Night theme", "Export to PDF"]) {
    await expect(team.getByRole("checkbox", { name: `Select ${title}` })).toBeDisabled();
  }
  // The menu's button keeps the keyboard's focus while it's off, not dropping it to the page.
  await expect(setStatus).toBeFocused();
  release();
  await expect(team.getByText("2 posts: Planned")).toBeVisible();
  for (const title of ["Dark mode", "Night theme", "Export to PDF"]) {
    await expect(team.getByRole("checkbox", { name: `Select ${title}` })).toBeEnabled();
  }
  await team.unroute(`**/app/${slug}/feedback**`);
});

test("Completed's question fits a phone, whatever the post's title (a long link)", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  const title = "https://example.com/integrations/salesforce/oauth-callback-fails-for-sandbox-orgs";
  await api("/posts", { board: "feature-requests", title });
  await team.setViewportSize({ width: 390, height: 800 });
  await team.goto(`/app/${slug}/feedback`);
  await team.getByRole("main").getByRole("listitem").getByRole("button", { name: /^Status: / }).click();
  await team.getByRole("menuitemradio", { name: "Completed" }).click();
  const heading = team.getByRole("alertdialog").getByRole("heading");
  await expect(heading).toContainText("oauth-callback");
  const box = (await heading.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await team.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  // The roadmap's own question, from a card's status menu, too.
  await api("/posts/1", { status: "planned" }, "PATCH");
  await team.goto(`/app/${slug}/feedback/roadmap`);
  await team.getByRole("region", { name: "Planned" }).getByRole("button", { name: "Status: Planned" }).click();
  await team.getByRole("menuitemradio", { name: "Completed" }).click();
  await expect(heading).toContainText("oauth-callback");
  const roadmapBox = (await heading.boundingBox())!;
  expect(roadmapBox.x + roadmapBox.width).toBeLessThanOrEqual(390);
});

test("Completed for picked rows counts only who it emails: one completed already emails nobody again", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  for (const [number, title] of [[1, "Dark mode"], [2, "Export to PDF"]] as const) {
    await api("/posts", { board: "feature-requests", title });
    await api(`/posts/${number}/vote`, { voted: true, author: { id: `user-${number}`, email: `e2e-${randomUUID()}@example.com` } });
  }
  await api("/posts/1", { status: "completed" }, "PATCH");
  // Someone votes for it after it shipped: counted for it, though completing it again emails nobody.
  await api("/posts/1/vote", { voted: true, author: { id: "user-late", email: `e2e-${randomUUID()}@example.com` } });
  await team.goto(`/app/${slug}/feedback?status=all`);
  await team.getByRole("checkbox", { name: "Select Dark mode" }).check();
  await team.getByRole("checkbox", { name: "Select Export to PDF" }).check();
  await team.getByRole("toolbar", { name: "Selected posts" }).getByRole("button", { name: "Set status" }).click();
  await team.getByRole("menuitem", { name: "Completed" }).click();
  await expect(team.getByRole("alertdialog").getByText("This emails up to 1 person who asked for them that it shipped, as when one post is completed.", { exact: true })).toBeVisible();
});

test("Feedback's pane asks before Completed too, saying how many it emails", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/posts", { board: "feature-requests", title: "Dark mode" });
  await api("/posts/1/vote", { voted: true, author: { id: "user-1", email: `e2e-${randomUUID()}@example.com` } });
  await team.goto(`/app/${slug}/feedback?post=1`);
  const pane = team.getByRole("region", { name: /^Post #/ });
  await pane.getByRole("combobox", { name: "Status" }).click();
  await team.getByRole("option", { name: "Completed" }).click();
  const ask = team.getByRole("alertdialog", { name: "Mark “Dark mode” completed?" });
  await expect(ask.getByText("This emails up to 1 person who asked for it that it shipped.", { exact: true })).toBeVisible();
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(ask).toHaveCount(0);
  // What's saved, not only what's shown: still Open after a reload, once anything sent has gone.
  await team.waitForLoadState("networkidle");
  await team.reload();
  await expect(pane.getByRole("combobox", { name: "Status" })).toHaveText(/Open/);
});
