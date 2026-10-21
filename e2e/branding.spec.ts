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

test("an admin brands the portal: logos, favicon, colour and links, without Powered by tuti", async ({ browser }, testInfo) => {
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

  await owner.goto(`/app/${slug}/settings`);
  const card = owner.locator("form").filter({ has: owner.getByRole("button", { name: "Save branding" }) });
  // Uploads go through the image pipeline (the S3 fake, processed inline); each shows a preview when ready.
  await card.getByLabel("Logo", { exact: true }).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: light });
  await expect(card.getByRole("img", { name: "Logo preview" })).toBeVisible();
  await card.getByLabel("Logo for dark mode").setInputFiles({ name: "logo-dark.png", mimeType: "image/png", buffer: dark });
  await expect(card.getByRole("img", { name: "Logo for dark mode preview" })).toBeVisible();
  await card.getByLabel("Favicon").setInputFiles({ name: "favicon.png", mimeType: "image/png", buffer: light });
  await expect(card.getByRole("img", { name: "Favicon preview" })).toBeVisible();
  await card.getByLabel("Accent colour").fill("#2563eb");
  await card.getByRole("button", { name: "Add header link" }).click();
  await card.getByLabel("Header link 1 label").fill("Docs");
  await card.getByLabel("Header link 1 URL").fill("https://docs.example.com");
  await card.getByRole("button", { name: "Add footer link" }).click();
  await card.getByLabel("Footer link 1 label").fill("Privacy");
  await card.getByLabel("Footer link 1 URL").fill("https://example.com/privacy");
  await card.getByLabel('Show "Powered by tuti" in the footer').uncheck();
  await card.getByRole("button", { name: "Save branding" }).click();
  await expect(owner.getByText("Branding saved")).toBeVisible();
  await checkpoint(owner, "branding-settings");
  await owner.reload();
  await expect(owner.getByLabel("Header link 1 URL")).toHaveValue("https://docs.example.com");
  await expect(owner.getByLabel('Show "Powered by tuti" in the footer')).not.toBeChecked();

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
    await expect(visitor.getByText("Powered by")).toHaveCount(0);
    // Focus rings are drawn in the accent too.
    await visitor.getByRole("button", { name: "Submit feedback" }).focus();
    await checkpoint(visitor, `branded-portal-${colorScheme}`);

    // The help center is the same portal, branded the same way.
    await visitor.goto("/docs");
    await expect(visitor.getByRole("navigation", { name: "Footer" })).toBeVisible();
    await expect(visitor.getByText("Powered by")).toHaveCount(0);
    await visitor.context().close();
  }
});
