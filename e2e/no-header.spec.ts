import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
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
    // Pane pages still fold below 1280px; their rail can open them and Home restores its expanded sidebar.
    if (width < 1280) {
      await sidebar.getByRole("link", { name: "Settings", exact: true }).click();
      await expect(sidebar).toHaveAttribute("data-state", "collapsed");
      await rail.focus();
      await owner.keyboard.press("Enter");
      await expect(sidebar).toHaveAttribute("data-state", "expanded");
      await sidebar.getByRole("link", { name: "Home", exact: true }).click();
      await expect(sidebar).toHaveAttribute("data-state", "expanded");
    }
  }
  await checkpoint(owner, "home-without-header", { fullPage: false });
});

test("a long post keeps its title and actions in view, and phones keep the menu and page actions", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/posts", { board: "feature-requests", title: "Export reports to CSV", body: "Our team needs the full report.\n\n".repeat(60) });
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(`/app/${slug}/p/1`);
  await owner.evaluate(() => window.scrollTo(0, 700));
  const heading = owner.getByRole("heading", { name: "Export reports to CSV", level: 1 });
  await expect(heading).toBeInViewport();
  await expect(owner.getByRole("link", { name: "View on portal" })).toBeInViewport();
  expect((await heading.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  // A keyboard-focused reply clears the whole sticky row, including a wrapped heading.
  const reply = owner.getByRole("textbox", { name: "Comment", exact: true });
  await reply.evaluate((element) => window.scrollBy(0, element.getBoundingClientRect().bottom - 20));
  await reply.focus();
  await expect.poll(async () => (await reply.boundingBox())!.y).toBeGreaterThanOrEqual((await owner.locator('[data-slot="post-header"]').boundingBox())!.height);
  await owner.evaluate(() => window.scrollTo(0, 700));
  await checkpoint(owner, "post-sticky-toolbar", { fullPage: false });

  await owner.setViewportSize({ width: 390, height: 844 });
  const bar = owner.locator("main > header");
  await expect(bar).toBeInViewport();
  await expect(bar.getByRole("button", { name: "Toggle Sidebar" })).toBeInViewport();
  // A page loaded on desktop measures the phone row when narrowed: even a heading still inside the window
  // but entirely behind the row must hand its title over to it.
  await heading.evaluate((element) => window.scrollBy(0, element.getBoundingClientRect().bottom - 40));
  await afterIntersections(owner);
  await expect(bar.locator('[data-slot="bar-title"]')).toHaveText("Export reports to CSV");
  await expect(owner.getByRole("button", { name: "More actions" })).toBeInViewport();
  await owner.getByRole("button", { name: "More actions" }).click();
  await expect(owner.getByRole("link", { name: "View on portal" })).toBeInViewport();
  await owner.keyboard.press("Escape");
  await bar.getByRole("button", { name: "Toggle Sidebar" }).click();
  const phoneSidebar = owner.getByRole("dialog", { name: "Sidebar" });
  await expect(phoneSidebar).toBeVisible();
  await expect(phoneSidebar.locator('[data-slot="sidebar-trigger"]')).toBeHidden();
  await owner.keyboard.press("Escape");
  await checkpoint(owner, "phone-navigation-and-actions", { fullPage: false });
});

test("an open feedback pane stays below the page toolbar while the list scrolls", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await Promise.all(Array.from({ length: 20 }, (_, i) => api("/posts", { board: "feature-requests", title: `Report idea ${i + 1}` })));
  await owner.setViewportSize({ width: 1440, height: 900 });
  await owner.goto(`/app/${slug}/feedback?post=1`);
  await owner.evaluate(() => window.scrollTo(0, 600));
  const toolbar = owner.locator('[data-slot="page-header"]');
  const close = owner.getByRole("region", { name: /^Post #/ }).getByRole("link", { name: "Close" });
  await expect(close).toBeInViewport();
  const box = (await toolbar.boundingBox())!;
  expect((await close.boundingBox())!.y).toBeGreaterThanOrEqual(box.y + box.height);
  await checkpoint(owner, "feedback-pane-below-toolbar", { fullPage: false });
});
