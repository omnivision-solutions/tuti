import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, cloudPortalUrl } from "./env";
import { afterIntersections, apiFor, createProject, signUp } from "./helpers";
import { verifyEmail } from "./mail";

test("pages use their own toolbar above tablet width and the sidebar rail works with a keyboard", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await verifyEmail(owner);
  const sidebar = owner.locator('[data-slot="sidebar"][data-state]');
  const rail = owner.locator('[data-slot="sidebar-rail"]');
  await sidebar.locator('[data-slot="sidebar-trigger"]').click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  for (const width of [768, 1024, 1440]) {
    await owner.setViewportSize({ width, height: 900 });
    await owner.goto(`/app/${slug}`);
    await expect(owner.locator("main > header")).toBeHidden();
    expect((await owner.getByRole("heading", { level: 1 }).boundingBox())!.y).toBeLessThan(48);
    if (width === 1440) {
      const toggle = sidebar.locator('[data-slot="sidebar-header"]').getByRole("button", { name: "Toggle Sidebar", exact: true });
      await expect(toggle).toBeInViewport();
      await toggle.click();
      await expect(sidebar).toHaveAttribute("data-state", "collapsed");
      await expect(toggle).toBeInViewport();
      await checkpoint(owner, "sidebar-visible-toggle-collapsed", { fullPage: false });
      await toggle.click();
      await expect(sidebar).toHaveAttribute("data-state", "expanded");
    }
    // Tab reaches the rail from the last control in the sidebar, with a visible focus indicator.
    await sidebar.locator('[data-slot="sidebar-footer"] button').last().focus();
    await owner.keyboard.press("Tab");
    await expect(rail).toBeFocused();
    await expect(rail).toHaveAccessibleName("Toggle Sidebar");
    await owner.keyboard.press("Enter");
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
    await owner.keyboard.press("Space");
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
    await owner.keyboard.press("ControlOrMeta+b");
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
    await owner.keyboard.press("ControlOrMeta+b");
    // Pane pages preserve the same choice below 1280px too.
    if (width < 1280) {
      await sidebar.getByRole("link", { name: "Settings", exact: true }).click();
      await expect(sidebar).toHaveAttribute("data-state", "expanded");
      await rail.focus();
      await owner.keyboard.press("Enter");
      await expect(sidebar).toHaveAttribute("data-state", "collapsed");
      await sidebar.getByRole("link", { name: "Home", exact: true }).click();
      await expect(sidebar).toHaveAttribute("data-state", "collapsed");
      await owner.keyboard.press("ControlOrMeta+b");
      await expect(sidebar).toHaveAttribute("data-state", "expanded");
    }
  }
  await checkpoint(owner, "home-without-header", { fullPage: false });
});

test("a long post keeps its title and actions in view, and phones keep the menu and its way back", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/posts", { board: "feature-requests", title: "Export reports to CSV", body: "Our team needs the full report.\n\n".repeat(60) });
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(`/app/${slug}/p/1`);
  // The post scrolls in its pane, under its header: the title and its actions stay in view.
  const reply = owner.getByRole("textbox", { name: "Comment", exact: true });
  await reply.scrollIntoViewIfNeeded();
  await expect(reply).toBeInViewport();
  const heading = owner.getByRole("heading", { name: "Export reports to CSV", level: 1 });
  await expect(heading).toBeInViewport();
  await expect(owner.getByRole("link", { name: "View on portal" })).toBeInViewport();
  expect(await owner.evaluate(() => window.scrollY)).toBe(0);
  await checkpoint(owner, "post-sticky-toolbar", { fullPage: false });

  await owner.setViewportSize({ width: 390, height: 844 });
  const bar = owner.locator("main > header");
  await expect(bar).toBeInViewport();
  await expect(bar.getByRole("button", { name: "Toggle Sidebar" })).toBeInViewport();
  // A page loaded on desktop measures the phone row when narrowed: the pane header's heading, scrolled up behind the
  // row, hands its title over to it.
  await owner.evaluate(() => window.scrollTo(0, 400));
  await afterIntersections(owner);
  await expect(bar.locator('[data-slot="bar-title"]')).toHaveText("Export reports to CSV");
  // At the top, the way back to the list and the post's actions.
  await owner.evaluate(() => window.scrollTo(0, 0));
  await expect(owner.locator('[data-slot="pane-header"]').getByRole("link", { name: "All posts" })).toBeInViewport();
  // The post's actions, in words, under the header's round More actions (no bare icon for the portal).
  await expect(owner.getByRole("link", { name: "View on portal" })).toBeHidden();
  await owner.locator('[data-slot="pane-header"]').getByRole("button", { name: "More actions" }).click();
  await expect(owner.getByRole("menuitem", { name: "View on portal" })).toHaveText("View on portal");
  await expect(owner.getByRole("menuitem", { name: "View on portal" })).toHaveAttribute("href", /\/feedback\/.+/);
  await owner.getByRole("menuitem", { name: "Merge into…" }).click();
  await expect(owner.getByRole("dialog", { name: "Merge #1 into…" })).toBeVisible();
  await owner.keyboard.press("Escape");
  await expect(owner.getByRole("dialog")).toHaveCount(0);
  // Closed, the keyboard's focus is back on More actions (Merge's own button is hidden here), not lost to the page.
  await expect(owner.locator('[data-slot="pane-header"]').getByRole("button", { name: "More actions" })).toBeFocused();
  await bar.getByRole("button", { name: "Toggle Sidebar" }).click();
  const phoneSidebar = owner.getByRole("dialog", { name: "Sidebar" });
  await expect(phoneSidebar).toBeVisible();
  await expect(phoneSidebar.locator('[data-slot="sidebar-trigger"]')).toBeHidden();
  await owner.keyboard.press("Escape");
  await checkpoint(owner, "phone-navigation-and-actions", { fullPage: false });
});

test("short windows: a long post's comments get the pane's height under its one-row header", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const title = "Export the filtered report for the entire team as a CSV download";
  await api("/posts", { board: "feature-requests", title, body: "Our team needs the full report.\n\n".repeat(30) });
  await api("/posts/1/comments", { body: "Please include the complete report for everyone on the team.\n\n".repeat(30) });
  await owner.setViewportSize({ width: 1024, height: 450 });
  await owner.goto(`/app/${slug}/p/1`);
  const header = owner.locator('[data-slot="pane-header"]');
  // The header is one row, however long the title (cut short in it; whole over the post).
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(61);
  const comments = owner.getByRole("region", { name: "Comments", exact: true });
  await comments.evaluate((element) => element.scrollIntoView({ block: "start" }));
  const box = (await header.boundingBox())!;
  await expect.poll(async () => (await comments.boundingBox())!.y - (box.y + box.height)).toBeLessThanOrEqual(32);
  await checkpoint(owner, "short-window-comments-without-sticky-header", { fullPage: false });
});

test("an open feedback pane stays in view while the list scrolls", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await Promise.all(Array.from({ length: 20 }, (_, i) => api("/posts", { board: "feature-requests", title: `Report idea ${i + 1}` })));
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(`/app/${slug}/feedback?status=all&post=1`);
  const close = owner.getByRole("region", { name: /^Post #/ }).getByRole("link", { name: "Close" });
  await expect(close).toBeInViewport();
  // The list scrolls in its own pane, to its last row: the post's pane doesn't move.
  const before = (await close.boundingBox())!.y;
  await owner.getByRole("main").getByRole("list", { name: "Posts" }).getByRole("listitem").last().scrollIntoViewIfNeeded();
  await expect(close).toBeInViewport();
  expect((await close.boundingBox())!.y).toBe(before);
  await checkpoint(owner, "feedback-pane-below-toolbar", { fullPage: false });
});

// Give a section at the end of a short fixture page room to align as it does above a longer list.
async function expectAnchorGap(page: Page, selector: string, gap: number, stickyToolbar = true) {
  await page.evaluate(() => {
    const room = document.createElement("div");
    room.style.height = "200vh";
    document.body.append(room);
  });
  const target = page.locator(selector);
  await target.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await expect.soft.poll(async () => {
    const header = stickyToolbar ? await page.locator('[data-slot="page-header"]:visible').last().boundingBox() : null;
    return Math.round((await target.boundingBox())!.y - (header ? header.y + header.height : 0));
  }).toBe(gap);
}

// A page of panes scrolls inside its pane: a section there lands its gap below the pane's header.
async function expectPaneAnchorGap(page: Page, selector: string, gap: number) {
  const target = page.locator(selector);
  await target.evaluate((element) => {
    let body = element.parentElement!;
    while (getComputedStyle(body).overflowY !== "auto") body = body.parentElement!;
    const room = document.createElement("div");
    room.style.height = "200vh";
    body.append(room);
    element.scrollIntoView({ block: "start" });
  });
  await expect.soft.poll(async () => {
    const header = (await page.locator('[data-slot="pane-header"]').boundingBox())!;
    return Math.round((await target.boundingBox())!.y - (header.y + header.height));
  }).toBe(gap);
}

test("app anchors clear each visible toolbar once, and Reporting adds no invisible toolbar", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await verifyEmail(owner);
  const api = await apiFor(owner, slug);
  await api("/articles", { title: "Old instructions", body: "An earlier guide." });
  await api("/articles/old-instructions", undefined, "DELETE");
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(`/app/${slug}/docs#recently-deleted`);
  await expect(owner.locator("#recently-deleted")).toBeVisible();
  await expect(owner.locator("#recently-deleted")).toBeInViewport();
  await owner.goto(`/app/${slug}/settings/billing`);
  await expectPaneAnchorGap(owner, "#usage", 32);
  await owner.goto(`/app/${slug}/reporting/ai-conversations`);
  await expect.soft(owner.locator("html")).toHaveCSS("scroll-padding-top", "0px");
  await expectPaneAnchorGap(owner, "#ai-history", 32);
  // Turning to a phone still reserves the compact menu row; returning to desktop clears that reservation.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(owner.locator("html")).toHaveCSS("scroll-padding-top", "48px");
  await owner.setViewportSize({ width: 1440, height: 900 });
  await expect(owner.locator("html")).toHaveCSS("scroll-padding-top", "0px");
  // The Inbox list title scrolls within its pane rather than sticking over the document.
  await owner.goto(`/app/${slug}/inbox`);
  await expect(owner.locator("html")).toHaveCSS("scroll-padding-top", "0px");
});

test("a long docs collection and its settings scroll inside their page surface", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/collections", { name: "Getting started" });
  await Promise.all(Array.from({ length: 25 }, (_, i) => api("/articles", { title: `Guide ${i + 1}`, body: "Instructions for your team.", collection: "getting-started" })));
  await owner.setViewportSize({ width: 1440, height: 900 });
  for (const suffix of ["", "/settings"]) {
    await owner.goto(`/app/${slug}/docs/collections/getting-started${suffix}`);
    const pane = owner.locator(".docs-page-content");
    await expect(owner.getByRole("heading", { name: "Getting started", level: 1, exact: true })).toBeVisible();
    // A stylesheet survives hydration; the settings form needs extra room to exercise scrolling.
    if (suffix) await owner.addStyleTag({ content: ".docs-page-content::after { content: ''; display: block; min-height: 100vh; flex-shrink: 0; }" });
    // The page surface owns scrolling. Wait for its content to settle before scrolling that one element.
    await expect.poll(() => pane.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(600);
    await pane.evaluate((element) => element.scrollTo(0, 600));
    await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(300);
    expect(await owner.evaluate(() => window.scrollY)).toBe(0);
    await pane.evaluate((element) => element.scrollTo(0, 0));
    await expect(owner.getByRole("heading", { name: "Getting started", level: 1, exact: true })).toBeInViewport();
    if (!suffix) await expect(owner.locator('[data-slot="docs-page-header"]').getByRole("button", { name: "More actions", exact: true })).toBeInViewport();
    await checkpoint(owner, suffix ? "collection-settings-sticky-toolbar" : "collection-sticky-toolbar", { fullPage: false });
  }
});

test("scroll padding clears a sticky toolbar pushed out of view by a short containing block", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.setViewportSize({ width: 1440, height: 900 });
  // A page still with a PageHeader (Home and Changelog are pages of panes).
  await owner.goto(`/app/${slug}/feedback/roadmap`);
  const toolbar = owner.locator('[data-slot="page-header"]');
  await expect.poll(() => owner.locator("html").evaluate((element) => parseFloat(getComputedStyle(element).scrollPaddingTop))).toBeGreaterThan(0);
  // Reproduce a shortened containing block independently of any page's current markup.
  await toolbar.evaluate((element) => {
    const boundary = document.createElement("div");
    element.replaceWith(boundary);
    boundary.append(element);
    const room = document.createElement("div");
    room.style.height = "200vh";
    document.body.append(room);
  });
  await owner.evaluate(() => window.scrollTo(0, 600));
  await expect(toolbar).toHaveCSS("position", "sticky");
  await expect(owner.getByRole("heading", { level: 1 })).not.toBeInViewport();
  await expect(owner.locator("html")).toHaveCSS("scroll-padding-top", "0px");
  await owner.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => owner.locator("html").evaluate((element) => parseFloat(getComputedStyle(element).scrollPaddingTop))).toBeGreaterThan(0);
});

test("billing's plan and usage anchors keep only their gap below the pane's header", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await verifyEmail(owner);
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(`/app/${slug}/settings/billing`);
  await expectPaneAnchorGap(owner, "#plans", 32);
  await expectPaneAnchorGap(owner, "#usage", 32);
  // On a phone the window scrolls, under the top bar: the plans land clear of it.
  await owner.setViewportSize({ width: 390, height: 844 });
  await owner.goto(`/app/${slug}/settings/billing`);
  await expect(owner.locator("html")).toHaveCSS("scroll-padding-top", "48px");
  await owner.getByRole("link", { name: "Choose a plan" }).click();
  await expect.poll(async () => (await owner.locator("#plans").boundingBox())!.y).toBeGreaterThanOrEqual(48);
});
