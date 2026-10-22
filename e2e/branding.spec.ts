import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, signUp } from "./helpers";

/** A wordmark to upload, drawn in the browser: `color` text on a transparent background. */
async function wordmark(page: Page, color: string) {
  await page.setContent(`<b id="mark" style="display:inline-block;padding:8px;font:bold 48px sans-serif;color:${color}">ACME</b>`);
  return page.locator("#mark").screenshot({ omitBackground: true });
}

test("an admin brands the portal: logos, favicon, colour and links; Powered by tuti stays without a licence", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // Before any branding, the footer says Powered by tuti, linking to Tuti's own site (whatever this installation's address).
  const before = await (await browser.newContext({ baseURL: portalUrl(slug) })).newPage();
  await before.goto("/feedback/feature-requests");
  await expect(before.getByRole("contentinfo").getByRole("link", { name: /Powered by/ })).toHaveAttribute("href", "https://tuti.so");
  await before.context().close();

  const scratch = await owner.context().newPage();
  const [light, dark] = [await wordmark(scratch, "#1d4ed8"), await wordmark(scratch, "#bfdbfe")];
  await scratch.close();

  // Customize → Branding: the settings beside a preview of the portal.
  await owner.goto(`/app/${slug}/customize`);
  await owner.getByRole("link", { name: /^Branding/ }).click();
  await expect(owner.getByRole("heading", { name: "Branding", level: 1 })).toBeVisible();
  const preview = owner.frameLocator('iframe[title="Portal preview"]');
  await expect(preview.getByRole("banner")).toBeVisible();
  const card = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Save branding" }) });
  // Uploads go through the image pipeline (the S3 fake, processed inline); each shows a preview when ready.
  await card.getByLabel("Logo", { exact: true }).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: light });
  await expect(card.getByRole("img", { name: "Logo preview" })).toBeVisible();
  await card.getByLabel("Logo for dark mode").setInputFiles({ name: "logo-dark.png", mimeType: "image/png", buffer: dark });
  await expect(card.getByRole("img", { name: "Logo for dark mode preview" })).toBeVisible();
  await card.getByLabel("Favicon").setInputFiles({ name: "favicon.png", mimeType: "image/png", buffer: light });
  await expect(card.getByRole("img", { name: "Favicon preview" })).toBeVisible();
  await card.getByLabel("Accent colour").fill("#2563eb");
  await card.getByRole("button", { name: "Save branding" }).click();
  await expect(owner.getByText("Branding saved")).toBeVisible();
  // Saved, the preview shows it.
  await expect(preview.getByRole("banner").getByRole("img", { name: "Acme" }).first()).toBeVisible();
  await checkpoint(owner, "branding-settings");

  // Customize → Navigation: the header's and footer's links.
  await owner.getByRole("link", { name: "Back to Customize" }).click();
  await owner.getByRole("link", { name: /^Navigation/ }).click();
  const links = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Save navigation" }) });
  await links.getByRole("button", { name: "Add header link" }).click();
  await links.getByLabel("Header link 1 label").fill("Docs");
  await links.getByLabel("Header link 1 URL").fill("https://docs.example.com");
  await links.getByRole("button", { name: "Add footer link" }).click();
  await links.getByLabel("Footer link 1 label").fill("Privacy");
  await links.getByLabel("Footer link 1 URL").fill("https://example.com/privacy");
  await links.getByRole("button", { name: "Save navigation" }).click();
  await expect(owner.getByText("Navigation saved")).toBeVisible();
  await expect(preview.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Privacy" })).toBeVisible();
  await owner.reload();
  await expect(owner.getByLabel("Header link 1 URL")).toHaveValue("https://docs.example.com");

  // Customize → Powered by: hiding the badge needs a licence for the project; unticking it asks about one instead.
  await owner.goto(`/app/${slug}/customize/powered-by`);
  const badge = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Save", exact: true }) });
  const poweredBy = badge.getByLabel('Show "Powered by tuti" in the footer');
  await expect(badge.getByText("Hiding it needs a licence for this project.")).toBeVisible();
  await poweredBy.click();
  const dialog = owner.getByRole("dialog", { name: 'Keep "Powered by tuti"?' });
  await expect(dialog).toBeVisible();
  // Bought on the licence server (tuti.so; this installation itself here) for this installation and project.
  const buy = new URL((await dialog.getByRole("link", { name: "Get a licence" }).getAttribute("href"))!);
  expect(`${buy.origin}${buy.pathname}`).toBe(`${APP_URL}/license`);
  expect(buy.searchParams.get("installation")).toBeTruthy();
  expect(buy.searchParams.get("project")).toBeTruthy();
  await checkpoint(owner, "powered-by-licence-dialog", { fullPage: false });
  // Going to buy one starts this installation's checks; the first says what it found.
  const [tutiSo] = await Promise.all([owner.waitForEvent("popup"), dialog.getByRole("link", { name: "Get a licence" }).click()]);
  await tutiSo.close();
  await expect(dialog.getByText("No licence for this project yet. Once you've bought one, check again.")).toBeVisible();
  await dialog.getByRole("button", { name: "Check now" }).click();
  await expect(dialog.getByText("Checked a moment ago. Try again in a minute.")).toBeVisible();
  await dialog.getByRole("button", { name: "Keep the badge" }).click();
  await expect(dialog).toBeHidden();
  await expect(poweredBy).toBeChecked();

  // Someone signed in on the portal (so the board shows its post form), in light and dark mode.
  const ada = await signUp(browser, portalUrl(slug), "Ada");
  const storageState = await ada.context().storageState();
  for (const colorScheme of ["light", "dark"] as const) {
    const visitor = await (await browser.newContext({ colorScheme, storageState, baseURL: portalUrl(slug) })).newPage();
    await visitor.goto("/feedback/feature-requests");
    // The logo for this mode, named for the project, links home; the other one is hidden.
    const logo = visitor.getByRole("banner").getByRole("link", { name: "Acme" }).getByRole("img", { name: "Acme" });
    await expect(logo).toBeVisible();
    await expect(logo).toHaveCount(1);
    await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    const logos = visitor.getByRole("banner").locator("img");
    const [lightSrc, darkSrc] = [await logos.nth(0).getAttribute("src"), await logos.nth(1).getAttribute("src")];
    expect(lightSrc).not.toBe(darkSrc);
    await expect(logo).toHaveAttribute("src", colorScheme === "light" ? lightSrc! : darkSrc!);

    await expect(visitor.locator('link[rel="icon"]')).toHaveAttribute("href", /\/m\/.+\.webp$/);
    // The accent: the blue reads on both backgrounds, with white text on it.
    await expect(visitor.getByRole("button", { name: "Submit feedback" })).toHaveCSS("background-color", "rgb(37, 99, 235)");
    await expect(visitor.getByRole("button", { name: "Submit feedback" })).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(visitor.getByRole("navigation", { name: "Links" }).getByRole("link", { name: "Docs" })).toHaveAttribute(
      "href",
      "https://docs.example.com",
    );
    await expect(visitor.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Privacy" })).toHaveAttribute(
      "href",
      "https://example.com/privacy",
    );
    await expect(visitor.getByRole("contentinfo").getByText("Powered by")).toBeVisible();
    // Focus rings are drawn in the accent too.
    await visitor.getByRole("button", { name: "Submit feedback" }).focus();
    await checkpoint(visitor, `branded-portal-${colorScheme}`);

    // The docs are the same portal, branded the same way.
    await visitor.goto("/docs");
    await expect(visitor.getByRole("navigation", { name: "Footer" })).toBeVisible();
    await expect(visitor.getByRole("contentinfo").getByText("Powered by")).toBeVisible();
    await visitor.context().close();
  }
});
