import { randomUUID } from "node:crypto";

import { type Browser, expect, type Page, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

/** Phone width (docs/design.md) and dark mode, on the screens people use most. */
const LOOKS = [
  { name: "phone", viewport: { width: 390, height: 844 }, colorScheme: "light" },
  { name: "dark", viewport: { width: 1280, height: 800 }, colorScheme: "dark" },
  { name: "phone-dark", viewport: { width: 390, height: 844 }, colorScheme: "dark" },
] as const;

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${page.url()} scrolls sideways`).toBeLessThanOrEqual(0);
}

test("every main screen fits a phone and works in dark mode", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;

  // A project with a post (long title, long words) and a comment.
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await ada.getByRole("button", { name: "Give feedback" }).click();
  await ada.getByLabel("Title").fill("Export everything to CSV, including archived boards and supercalifragilistic fields");
  await ada.getByRole("button", { name: "Submit feedback" }).click();
  await ada.getByRole("link", { name: /Export everything/ }).click();
  await ada.getByRole("textbox", { name: "Comment" }).fill("Thanks! https://example.com/a/really/long/link/that/should/wrap/nicely");
  await ada.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(ada.getByText("1 comment")).toBeVisible();

  const team = await owner.context().storageState();
  const portal = await ada.context().storageState();

  for (const look of LOOKS) {
    const open = async (state: typeof team, baseURL: string) => {
      const context = await (browser as Browser).newContext({ ...look, storageState: state, baseURL });
      return context.newPage();
    };

    const teamPage = await open(team, APP_URL);
    for (const [path, name] of [
      [`/app/${slug}`, "team-home"],
      [`/app/${slug}/feedback`, "team-feedback"],
      [`/app/${slug}/p/1`, "team-post"],
      [`/app/${slug}/settings`, "team-settings"],
      [`/app/${slug}/customize`, "team-customize"],
      [`/app/${slug}/customize/branding`, "team-customize-branding"],
      [`/app/${slug}/team`, "team-members"],
    ] as const) {
      await teamPage.goto(path);
      await expect(teamPage.getByRole("main")).toBeVisible();
      await expectNoSidewaysScroll(teamPage);
      await checkpoint(teamPage, `${look.name}-${name}`);
    }

    const portalPage = await open(portal, portalUrl(slug));
    for (const [path, name] of [
      ["/feedback/feature-requests", "portal-board"],
      ["/feedback/feature-requests/export-everything-to-csv-including-archived-boards-and-supercalifragilistic-fields-1", "portal-post"],
    ] as const) {
      await portalPage.goto(path);
      await expect(portalPage.getByRole("main")).toBeVisible();
      await expectNoSidewaysScroll(portalPage);
      await checkpoint(portalPage, `${look.name}-${name}`);
    }
    await teamPage.context().close();
    await portalPage.context().close();
  }
});

test("on a phone, the header stays at the top and its buttons on its first line beside a long name; the menu takes the whole screen up to tablet width", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme Customer Success and Support Help Center", slug);
  // An article, so the menu has the docs' tree.
  const api = await apiFor(owner, slug);
  // A long one, with a heading halfway down to link to.
  const paragraph = (value: string) => ({ type: "paragraph", content: [{ type: "text", text: value }] });
  const content = {
    type: "doc",
    content: [
      ...Array.from({ length: 40 }, (_, i) => paragraph(`Step ${i + 1}: keep reading.`)),
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Last step" }] },
      ...Array.from({ length: 40 }, (_, i) => paragraph(`Step ${i + 41}: nearly there.`)),
    ],
  };
  const article = await api("/articles", { title: "Getting started", content });
  await api(`/articles/${article.slug}/publish`, {});
  // And header links and a contact button, so they're there on every page (the logo's too): long
  // ones, which take several lines where they're in a row of their own (without JavaScript).
  const long = (word: string) => `${word}: everything you need to know`;
  await api(
    "/branding",
    {
      headerLinks: [{ label: "Pricing", url: "https://example.com/pricing" }, ...["Status", "Security", "Careers", "Community"].map((word) => ({ label: long(word), url: "https://example.com/more" }))],
      contact: { label: "Talk to our support team", url: "mailto:e2e-support@example.com" },
    },
    "PATCH",
  );
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.setViewportSize({ width: 390, height: 844 });
  await visitor.goto(`/docs/${article.slug}`);
  const banner = visitor.getByRole("banner");
  const name = banner.getByRole("link", { name: /^Acme Customer Success/ }).first();
  const menuButton = banner.getByRole("button", { name: "Menu" });
  const [nameBox, menuBox] = [(await name.boundingBox())!, (await menuButton.boundingBox())!];
  // The same line, the name cut short before the buttons.
  expect(Math.abs(nameBox.y + nameBox.height / 2 - (menuBox.y + menuBox.height / 2))).toBeLessThan(8);
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(menuBox.x);
  await expectNoSidewaysScroll(visitor);
  // Scrolled down a long page, the header stays at the top, its buttons too.
  await visitor.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => visitor.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  expect((await banner.boundingBox())!.y).toBe(0);
  await expect(menuButton).toBeInViewport();
  await visitor.evaluate(() => window.scrollTo(0, 0));
  // Up to tablet width the menu is the whole screen; the logo in it, followed, closes it.
  await visitor.setViewportSize({ width: 700, height: 900 });
  await menuButton.click();
  const menu = visitor.getByRole("dialog", { name: "Menu" });
  expect((await menu.boundingBox())!.width).toBeGreaterThanOrEqual(699);
  await expect(menu.getByRole("link", { name: "Pricing" })).toBeVisible();
  await menu.getByRole("link", { name: /^Acme Customer Success/ }).click();
  await visitor.waitForURL(/\/feedback\//);
  await expect(menu).toBeHidden();
  await expect(menuButton).toBeVisible();

  // Without JavaScript the menu can't open: the team's links are in a row under the header instead.
  const noScript = await (browser as Browser).newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 }, baseURL: portalUrl(slug) });
  const plain = await noScript.newPage();
  await plain.goto(`/docs/${article.slug}`);
  await expect(plain.getByRole("navigation", { name: "Links" }).getByRole("link", { name: "Pricing" })).toBeVisible();
  // And a link to a heading still lands below the header, which can't measure itself without it,
  // however many lines those links take: they're under it and scroll away, not part of it.
  await plain.goto(`/docs/${article.slug}#last-step`);
  const heading = plain.getByRole("heading", { name: "Last step" });
  await expect.poll(() => plain.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  const [headerBox, headingBox] = [(await plain.locator("[data-portal-top]").boundingBox())!, (await heading.boundingBox())!];
  expect(headingBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
  await noScript.close();

  // On a private portal's sign-in page, the menu has them too (and no parts).
  await api("/portal", { access: "private" }, "PATCH");
  const outsider = await newPerson(browser, portalUrl(slug));
  await outsider.setViewportSize({ width: 390, height: 844 });
  await outsider.goto(`/docs/${article.slug}`);
  await expect(outsider).toHaveURL(/\/sign-in/);
  await outsider.getByRole("banner").getByRole("button", { name: "Menu" }).click();
  const outsiderMenu = outsider.getByRole("dialog", { name: "Menu" });
  await expect(outsiderMenu.getByRole("link", { name: "Pricing" })).toBeVisible();
  await expect(outsiderMenu.getByRole("navigation", { name: "Docs", exact: true })).toHaveCount(0);
});

test("a link to a heading lands below the header, even when the team's CSS makes it taller than usual", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  const paragraph = (value: string) => ({ type: "paragraph", content: [{ type: "text", text: value }] });
  const content = {
    type: "doc",
    content: [
      ...Array.from({ length: 40 }, (_, i) => paragraph(`Step ${i + 1}: keep reading.`)),
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Last step" }] },
      ...Array.from({ length: 40 }, (_, i) => paragraph(`Step ${i + 41}: nearly there.`)),
    ],
  };
  const article = await api("/articles", { title: "Getting started", content });
  await api(`/articles/${article.slug}/publish`, {});
  // Taller than the room left for it before the page measures it (12rem).
  await api("/branding", { customCss: ".portal-header { padding-bottom: 12rem; }" }, "PATCH");
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.setViewportSize({ width: 390, height: 844 });
  await visitor.goto(`/docs/${article.slug}#last-step`);
  const top = visitor.locator("[data-portal-top]");
  const heading = visitor.getByRole("heading", { name: "Last step" });
  await expect.poll(async () => (await top.boundingBox())!.height).toBeGreaterThan(200);
  // Scrolled to it: on screen, just below the header.
  await expect(heading).toBeInViewport();
  await expect.poll(async () => (await heading.boundingBox())!.y - (await top.boundingBox())!.height).toBeGreaterThanOrEqual(0);

  // A link with a broken fragment doesn't stop the header measuring itself (a page of its own, not
  // just a new fragment on this one).
  await visitor.goto("/roadmap");
  const errors: string[] = [];
  visitor.on("pageerror", (error) => errors.push(error.message));
  await visitor.goto(`/docs/${article.slug}#%`);
  await expect(heading).toBeAttached();
  await expect.poll(() => visitor.evaluate(() => document.documentElement.style.getPropertyValue("--portal-header-height"))).toMatch(/^\d+(\.\d+)?px$/);
  // And it keeps measuring it: a wider screen, a shorter header.
  const before = await visitor.evaluate(() => document.documentElement.style.getPropertyValue("--portal-header-height"));
  await visitor.setViewportSize({ width: 1280, height: 844 });
  await expect.poll(() => visitor.evaluate(() => document.documentElement.style.getPropertyValue("--portal-header-height"))).not.toBe(before);
  expect(errors).toEqual([]);
});
