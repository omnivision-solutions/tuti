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

test("on a phone, the header's buttons stay on its first line beside a long name; the menu takes the whole screen up to tablet width", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme Customer Success and Support Help Center", slug);
  // An article, so the menu has the docs' tree.
  const api = await apiFor(owner, slug);
  const article = await api("/articles", { title: "Getting started", body: "Welcome." });
  await api(`/articles/${article.slug}/publish`, {});
  // And a header link, so it's there on every page (the logo's too).
  await api("/branding", { headerLinks: [{ label: "Pricing", url: "https://example.com/pricing" }] }, "PATCH");
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
});
