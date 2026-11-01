import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

test("the team sets what readers can do with an article and the docs' home, seeing each change before saving it", async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/articles", { title: "Inviting your team", body: "Owners and admins send invites from the Team page." });
  await api("/articles/inviting-your-team/publish", {});
  // Changed since it was published, so its page says when.
  await api("/articles/inviting-your-team", { body: "Owners and admins send invites from the Team page. Invites last a week." }, "PATCH");
  await api("/articles/inviting-your-team/publish-changes", {});

  // Customize opens on its first section (Branding); its rail goes between them, the preview staying beside them.
  await owner.goto(`/app/${slug}/customize`);
  await owner.waitForURL(`**/app/${slug}/customize/branding`);
  const rail = owner.getByRole("navigation", { name: "Customize" });
  await expect(rail.getByRole("link")).toHaveText(["Branding", "Navigation", "Docs home", "Content actions", "Widget", "SEO", "Custom code"]);
  await expect(owner.getByRole("link", { name: "Back to Customize" })).toHaveCount(0);
  // The preview as a phone in dark mode stays so in the next section.
  const size = owner.getByRole("group", { name: "Preview size" });
  const mode = owner.getByRole("group", { name: "Preview mode" });
  await size.getByRole("button", { name: "Phone" }).click();
  await mode.getByRole("button", { name: "Dark mode" }).click();
  // Customize → Content actions, beside one of the docs' articles.
  await rail.getByRole("link", { name: "Content actions" }).click();
  await expect(owner.getByRole("heading", { name: "Content actions", level: 1 })).toBeVisible();
  await expect(size.getByRole("button", { name: "Phone" })).toHaveAttribute("aria-pressed", "true");
  await expect(mode.getByRole("button", { name: "Dark mode" })).toHaveAttribute("aria-pressed", "true");
  // And so does the preview itself: laid out at a phone's width, dark.
  const preview = owner.frameLocator('iframe[title="Portal preview"]');
  await expect(owner.locator('iframe[title="Portal preview"]')).toHaveCSS("width", "390px");
  await expect(preview.locator("html")).toHaveClass(/\bdark\b/);
  await size.getByRole("button", { name: "Desktop" }).click();
  await mode.getByRole("button", { name: "Light mode" }).click();
  await expect(preview.getByRole("heading", { name: "Inviting your team" })).toBeVisible();
  await expect(preview.getByRole("button", { name: "Copy page" })).toBeVisible();
  await expect(preview.getByText(/^Updated /)).toBeVisible();
  // Each switch shows in the preview at once.
  await owner.getByRole("switch", { name: "Copy as Markdown" }).uncheck();
  await expect(preview.getByRole("button", { name: "Copy page" })).toHaveCount(0);
  await expect(preview.getByRole("button", { name: "Page actions" })).toBeVisible();
  await owner.getByRole("switch", { name: "Show the last updated date" }).uncheck();
  await expect(preview.getByText(/^Updated /)).toHaveCount(0);
  await checkpoint(owner, "customize-content-actions");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Content actions saved")).toBeVisible();

  // Readers get the same.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs/inviting-your-team");
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toBeVisible();
  await expect(visitor.getByRole("button", { name: "Page actions" })).toBeVisible();
  await expect(visitor.getByRole("button", { name: "Copy page" })).toHaveCount(0);
  await expect(visitor.getByText(/^Updated /)).toHaveCount(0);
  // With the menu off, there's none.
  await owner.getByRole("switch", { name: "Show the page actions menu" }).uncheck();
  await expect(preview.getByRole("button", { name: "Page actions" })).toHaveCount(0);
  await owner.getByRole("button", { name: "Save changes" }).click();
  // Saved once nothing's left to save (the last save's toast may still be up).
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await visitor.reload();
  await expect(visitor.getByRole("heading", { name: "Inviting your team" })).toBeVisible();
  await expect(visitor.getByRole("button", { name: "Page actions" })).toHaveCount(0);

  // Customize → Docs home: the heading above the search box.
  await rail.getByRole("link", { name: "Docs home" }).click();
  await expect(preview.getByRole("heading", { name: "Docs", level: 1 })).toBeVisible();
  await owner.getByLabel("Title", { exact: true }).fill("  How can we help?  ");
  await owner.getByLabel("Subtitle").fill("Answers to everything about Acme.");
  await expect(preview.getByRole("heading", { name: "How can we help?", level: 1 })).toBeVisible();
  await expect(preview.getByText("Answers to everything about Acme.")).toBeVisible();
  await checkpoint(owner, "customize-docs-home");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Docs home saved")).toBeVisible();
  // Saved as trimmed, and the form shows what's saved: nothing left to save.
  await expect(owner.getByLabel("Title", { exact: true })).toHaveValue("How can we help?");
  await expect(owner.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await visitor.goto("/docs");
  await expect(visitor.getByRole("heading", { name: "How can we help?", level: 1 })).toBeVisible();
});

test("the team sets the portal's search listing, seeing it as a search result and a shared link", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/customize/seo`);
  const result = owner.getByRole("figure", { name: "Search result preview" });
  await expect(result).toContainText("Acme");
  await owner.getByLabel("Page title").fill("Acme Help Center");
  await owner.getByLabel("Meta description").fill("Answers about Acme, from the team that makes it.");
  await expect(result).toContainText("Acme Help Center");
  await expect(owner.getByRole("figure", { name: "Shared link preview" })).toContainText("Answers about Acme, from the team that makes it.");
  await expect(owner.getByText("48/160")).toBeVisible();
  await checkpoint(owner, "customize-seo");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("SEO saved")).toBeVisible();

  // Pages without a title of their own have the portal's; every page has its description.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/roadmap");
  await expect(visitor).toHaveTitle("Acme Help Center");
  // A team's portal brings its default colour scheme (here, its readers' devices').
  expect(await visitor.content()).toContain("tuti-theme-default");
  await expect(visitor.locator('meta[name="description"]')).toHaveAttribute("content", "Answers about Acme, from the team that makes it.");
  await expect(visitor.locator('meta[property="og:site_name"]')).toHaveAttribute("content", "Acme Help Center");
});

test("the team sends its old help center's addresses to the new docs", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // Redirects are in Settings → Domain now; Customize's old address lands there.
  await owner.goto(`/app/${slug}/customize/redirects`);
  await owner.waitForURL(`**/app/${slug}/settings/domain`);
  await expect(owner.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Domain" })).toHaveAttribute("aria-current", "page");
  await expect(owner.getByText("No redirects yet")).toBeVisible();
  // Pasted from the old site: its path is what's matched.
  await owner.getByLabel("Old address").fill("https://help.acme.example/hc/en-us/articles/123-Billing");
  await owner.getByLabel("New address").fill("/roadmap");
  await owner.getByRole("button", { name: "Add redirect" }).click();
  await expect(owner.getByText("Redirect added")).toBeVisible();
  const list = owner.getByRole("list", { name: "Redirects" });
  await expect(list).toContainText("/hc/en-us/articles/123-billing");
  await expect(owner.getByLabel("Old address")).toHaveValue("");
  // The portal's own addresses stay its own.
  await owner.getByLabel("Old address").fill("/sign-in");
  await owner.getByLabel("New address").fill("/docs");
  await owner.getByRole("button", { name: "Add redirect" }).click();
  await expect(owner.getByText("/sign-in is one of the portal's own addresses")).toBeVisible();
  await checkpoint(owner, "customize-redirects");

  // Someone following an old link lands on the new page.
  const visitor = await newPerson(browser, portalUrl(slug));
  // Within a few seconds: the proxy keeps a portal's redirects briefly (server/portal-redirects.ts).
  await expect(async () => {
    await visitor.goto("/hc/en-us/articles/123-billing");
    await expect(visitor).toHaveURL(`${portalUrl(slug)}/roadmap`, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(visitor.getByRole("heading", { name: "Roadmap" })).toBeVisible();

  // Deleted, the old address is nothing again.
  await owner.getByRole("button", { name: "Delete the redirect from /hc/en-us/articles/123-billing" }).click();
  await expect(owner.getByText("Redirect deleted")).toBeVisible();
  await expect(async () => {
    expect((await visitor.request.get("/hc/en-us/articles/123-billing", { maxRedirects: 0 })).status()).toBe(404);
  }).toPass({ timeout: 20_000 });

  // The sidebar is folded where a page has three panes (Customize, Settings, a docs article: a column of its
  // own), and open where it hasn't (the docs' home shows them all itself).
  await owner.goto(`/app/${slug}/customize/branding`);
  const sidebar = owner.locator('[data-slot="sidebar"][data-state]');
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await owner.locator("header").getByRole("button", { name: "Toggle Sidebar" }).click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await sidebar.getByRole("link", { name: "Docs", exact: true }).click();
  await owner.waitForURL(`**/app/${slug}/docs`);
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await sidebar.getByRole("link", { name: "Settings", exact: true }).click();
  await owner.waitForURL(`**/app/${slug}/settings/**`);
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  // Settings' menu is a column of its own beside the page, the page's height.
  const menu = owner.getByRole("navigation", { name: "Settings" });
  await expect(menu).toBeVisible();
  await checkpoint(owner, "settings-panes", { fullPage: false });
  // The top bar stays where it is as the page scrolls (fixed to the window, as the title in it is).
  await expect(owner.locator("header").first()).toHaveCSS("position", "fixed");
  // On a phone the page's heading comes first, above the menu.
  await owner.setViewportSize({ width: 390, height: 844 });
  const heading = owner.getByRole("heading", { name: "Settings", level: 1 });
  const menuButton = owner.locator("details summary").first();
  await expect(heading).toBeVisible();
  expect((await heading.boundingBox())!.y).toBeLessThan((await menuButton.boundingBox())!.y);
});

test("the team's own CSS shows in the preview as it's typed, and on the portal once saved", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/customize/custom-code`);
  const preview = owner.frameLocator('iframe[title="Portal preview"]');
  await expect(preview.locator(".portal-header")).toBeVisible();
  await owner.getByLabel("Custom CSS").fill(".portal-header { background: rgb(1, 2, 3); }");
  await expect(preview.locator(".portal-header")).toHaveCSS("background-color", "rgb(1, 2, 3)");
  // Its HTML runs only on an address of the team's own, which this portal doesn't have yet.
  await expect(owner.getByText("Your portal isn't on one yet", { exact: false })).toBeVisible();
  await checkpoint(owner, "customize-custom-code");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Custom code saved")).toBeVisible();

  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/roadmap");
  await expect(visitor.locator(".portal-header")).toHaveCSS("background-color", "rgb(1, 2, 3)");
});

test("on a laptop Customize fits the window under the top bar, and each pane scrolls on its own", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.setViewportSize({ width: 1280, height: 720 });
  const documentScroll = () => owner.evaluate(() => ({ y: window.scrollY, overflow: document.documentElement.scrollHeight - window.innerHeight }));

  // No section's page is taller than the window: its panes scroll instead.
  for (const section of ["branding", "navigation", "docs-home", "content-actions", "widget", "seo", "custom-code"]) {
    await owner.goto(`/app/${slug}/customize/${section}`);
    await expect(owner.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await documentScroll(), section).toEqual({ y: 0, overflow: 0 });
  }

  // Branding's settings are taller than the window: scrolling them moves them alone.
  await owner.goto(`/app/${slug}/customize/branding`);
  const header = owner.locator("header").first();
  const settings = owner.locator('[data-slot="customize-settings"]');
  const rail = owner.getByRole("navigation", { name: "Customize" });
  const preview = owner.locator('iframe[title="Portal preview"]');
  await expect(preview).toBeVisible();
  expect(await settings.evaluate((pane) => pane.scrollHeight > pane.clientHeight)).toBe(true);
  const before = { header: await header.boundingBox(), settings: await settings.boundingBox(), rail: await rail.boundingBox(), preview: await preview.boundingBox() };
  expect(before.settings!.y).toBeGreaterThanOrEqual(before.header!.y + before.header!.height);
  await checkpoint(owner, "customize-branding-top", { fullPage: false });

  await owner.getByRole("heading", { name: "Logo", exact: true }).hover();
  await owner.mouse.wheel(0, 600);
  await expect.poll(() => settings.evaluate((pane) => pane.scrollTop)).toBeGreaterThan(0);
  expect(await owner.evaluate(() => window.scrollY)).toBe(0);
  // The top bar, the rail and the preview stay put, and the settings stay under the top bar, their title and "Save changes" at their top.
  expect(await header.boundingBox()).toEqual(before.header);
  expect(await settings.boundingBox()).toEqual(before.settings);
  expect(await rail.boundingBox()).toEqual(before.rail);
  expect(await preview.boundingBox()).toEqual(before.preview);
  const save = (await owner.getByRole("button", { name: "Save changes" }).boundingBox())!;
  expect(save.y).toBeGreaterThanOrEqual(before.settings!.y);
  await expect(owner.getByRole("heading", { name: "Branding", level: 1 })).toBeInViewport();
  await checkpoint(owner, "customize-branding-scrolled", { fullPage: false });

  // On a phone it's one column, the page scrolling, and nothing runs past the screen's edge.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(owner.getByRole("heading", { name: "Branding", level: 1 })).toBeVisible();
  expect(await owner.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkpoint(owner, "customize-branding-phone");
});
