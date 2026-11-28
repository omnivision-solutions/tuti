import { randomUUID } from "node:crypto";

import { expect, type Page, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, signUp } from "./helpers";

/** A logo to upload, drawn in the browser: a `color` letter on a transparent background (square enough for the sidebar too). */
async function drawLogo(page: Page, color: string) {
  await page.setContent(`<b id="mark" style="display:inline-block;padding:8px;font:bold 48px sans-serif;color:${color}">A</b>`);
  return page.locator("#mark").screenshot({ omitBackground: true });
}

test("an admin brands the portal: logos, favicon, colour and links; Powered by tuti stays without a licence", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // Before any branding, the footer says Powered by tuti, linking to Tuti's own site (whatever this installation's address), tagged with where it was.
  const before = await (await browser.newContext({ baseURL: portalUrl(slug) })).newPage();
  await before.goto("/feedback/feature-requests");
  await expect(before.getByRole("contentinfo").getByRole("link", { name: /Powered by/ })).toHaveAttribute(
    "href",
    "https://tuti.so/?utm_source=portal&utm_medium=powered_by&utm_campaign=badge",
  );
  await before.context().close();

  const scratch = await owner.context().newPage();
  const [light, dark] = [await drawLogo(scratch, "#1d4ed8"), await drawLogo(scratch, "#bfdbfe")];
  await scratch.close();

  // Settings → Branding: the settings beside a preview of the portal (on a clock the journey can move on).
  await owner.clock.install();
  await owner.goto(`/app/${slug}/settings/branding`);
  const rail = owner.getByRole("navigation", { name: "Settings" });
  await expect(owner.getByRole("heading", { name: "Branding", level: 1 })).toBeVisible();
  // The page has its own heading; wider screens need no app bar above it.
  await expect(owner.locator("main > header")).toBeHidden();
  const preview = owner.frameLocator('iframe[title="Portal preview"]');
  await expect(preview.getByRole("banner")).toBeVisible();
  // Changes go to the open page: the preview stays where it is until a save (uploads refresh the page around it).
  const frame = owner.locator('iframe[title="Portal preview"]');
  const opened = (await frame.getAttribute("src"))!;
  // "Save changes" waits for a change.
  const save = owner.getByRole("button", { name: "Save changes" });
  await expect(save).toBeDisabled();
  const card = owner.locator("form").first();
  // Uploads go through the image pipeline (the S3 fake, processed inline); each shows a preview when ready.
  await card.getByLabel("Logo", { exact: true }).setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: light });
  await expect(card.getByRole("img", { name: "Logo preview" })).toBeVisible();
  await card.getByLabel("Dark mode logo", { exact: true }).setInputFiles({ name: "logo-dark.png", mimeType: "image/png", buffer: dark });
  await expect(card.getByRole("img", { name: "Dark mode logo preview" })).toBeVisible();
  // An image can be dropped on its field too.
  const favicon = card.getByLabel("Favicon", { exact: true });
  // What files it takes isn't said until one is refused.
  await expect(card.getByText(/PNG|drop an image/)).toHaveCount(0);
  // "Upload" is the way in from the keyboard, named for its image.
  await expect(favicon).toHaveAttribute("tabindex", "-1");
  await expect(card.getByRole("button", { name: "Upload favicon" })).toBeVisible();
  const dropped = await owner.evaluateHandle((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "favicon.png", { type: "image/png" }));
    return transfer;
  }, [...light]);
  await favicon.locator("..").dispatchEvent("drop", { dataTransfer: dropped });
  await expect(card.getByRole("img", { name: "Favicon preview" })).toBeVisible();
  // An image can be taken away again, and put back.
  await card.getByRole("button", { name: "Remove favicon" }).click();
  await expect(card.getByRole("img", { name: "Favicon preview" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Upload favicon" })).toBeFocused();
  await favicon.setInputFiles({ name: "favicon.png", mimeType: "image/png", buffer: light });
  await expect(card.getByRole("img", { name: "Favicon preview" })).toBeVisible();
  await card.getByLabel("Accent colour", { exact: true }).fill("#2563eb");
  // The preview shows each change before it's saved: the logo, and the colour as the portal's accent.
  await expect(preview.getByRole("banner").getByRole("img", { name: "Acme" }).first()).toBeVisible();
  // Text beside the logo (the logo is then an image beside its name), where it links, and dark mode for readers who haven't picked one.
  await card.getByLabel("Text beside it").fill("Acme Help");
  await card.getByLabel("Links to").fill("https://acme.example");
  await expect(preview.getByRole("banner").getByRole("link", { name: /Acme Help/ })).toHaveAttribute("href", "https://acme.example");
  await card.getByRole("radio", { name: "Dark" }).locator("..").click();
  await expect(preview.locator("html")).toHaveClass(/\bdark\b/);
  // A font for headings, from the ones built into Tuti.
  await card.getByLabel("Headings").click();
  await owner.getByRole("option", { name: "Playfair Display" }).click();
  await expect
    .poll(() => preview.getByRole("heading", { level: 1 }).first().evaluate((h) => getComputedStyle(h).fontFamily))
    // Built in from a file of Tuti's own (src/fonts), so its family is named after it.
    .toMatch(/playfairDisplay/);
  // Back to each reader's device's.
  await card.getByRole("radio", { name: "System" }).locator("..").click();
  await expect(preview.locator("html")).not.toHaveClass(/\bdark\b/);
  const accent = () => preview.locator("html").evaluate((html) => getComputedStyle(html).getPropertyValue("--primary").trim());
  await expect.poll(accent).toBe("#2563eb");
  // In dark mode too.
  await owner.getByRole("button", { name: "Dark mode", exact: true }).click();
  await expect(preview.locator("html")).toHaveClass(/\bdark\b/);
  await owner.getByRole("button", { name: "Light mode", exact: true }).click();
  // Only on the page: nothing kept where the portal remembers a reader's own pick (the frame shares that storage).
  expect(await owner.frame({ name: "tuti-preview" })!.evaluate(() => localStorage.getItem("theme"))).toBeNull();
  await expect(frame).toHaveAttribute("src", opened);
  // Half an hour on (its token lasts an hour), it gets a new token, and the frame reopens with it, changes and all.
  await owner.clock.fastForward("30:00");
  await expect(frame).not.toHaveAttribute("src", opened);
  await expect(preview.getByRole("banner").getByRole("link", { name: /Acme Help/ })).toHaveAttribute("href", "https://acme.example");
  // Saved from the keyboard: focus stays on "Save changes" while it saves and once it's disabled again.
  await save.focus();
  await save.press("Enter");
  await expect(owner.getByText("Branding saved")).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(save).toBeFocused();
  // Saved, the preview shows it.
  await expect(preview.getByRole("banner").getByRole("link", { name: "Acme Help" }).locator("img").first()).toBeVisible();
  await checkpoint(owner, "branding-settings");
  // Saved, the sidebar's project switcher shows the logo instead of the project's initial (no reload: the save refreshes
  // the page, layout and all): the one for this mode, loaded.
  const switcher = owner.locator('[data-sidebar="header"]').getByRole("button", { name: /Acme/ });
  const mark = switcher.locator("img:visible");
  await expect(mark).toHaveCount(1);
  await expect.poll(() => mark.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const [lightMark, darkMark] = [await switcher.locator("img").nth(0).getAttribute("src"), await switcher.locator("img").nth(1).getAttribute("src")];
  expect(lightMark).not.toBe(darkMark);
  await expect(mark).toHaveAttribute("src", lightMark!);
  await checkpoint(owner, "sidebar-project-logo", { fullPage: false });
  await owner.emulateMedia({ colorScheme: "dark" });
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveAttribute("src", darkMark!);
  await expect.poll(() => mark.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await owner.emulateMedia({ colorScheme: "light" });

  // Settings → Navigation: the header's and footer's links.
  await rail.getByRole("link", { name: "Navigation" }).click();
  const links = owner.locator("form");
  // One card of three rows: each says how many of its 5 links it has, with "Add" on its right.
  await expect(links.getByRole("heading", { name: "Links" })).toBeVisible();
  const header = links.getByRole("group", { name: "Header links" });
  const addHeader = header.getByRole("button", { name: "Add header link" });
  await expect(header).toContainText("Header 0/5");
  await expect(links.getByRole("group", { name: "Docs sidebar links" })).toContainText("Docs sidebar 0/5");
  await expect(links.getByRole("group", { name: "Footer links" })).toContainText("Footer 0/5");
  await expect(addHeader).toHaveText("Add");
  // A new link's label takes the focus.
  await addHeader.click();
  await expect(header).toContainText("Header 1/5");
  await expect(links.getByLabel("Header link 1 label")).toBeFocused();
  // At 5 "Add" says so instead; taking a link away moves the focus to it (the link's own button is gone).
  for (let count = 2; count <= 5; count++) {
    await addHeader.click();
    await expect(links.getByLabel(`Header link ${count} label`)).toBeFocused();
  }
  await expect(header).toContainText("Header 5/5");
  await addHeader.click();
  await expect(owner.getByText("Up to 5 header links")).toBeVisible();
  await expect(links.getByLabel(/^Header link \d label$/)).toHaveCount(5);
  await links.getByRole("button", { name: "Remove header link 5" }).click();
  await expect(addHeader).toBeFocused();
  for (const count of [4, 3, 2]) {
    await links.getByRole("button", { name: `Remove header link ${count}` }).click();
    await expect(addHeader).toBeFocused();
  }
  await expect(header).toContainText("Header 1/5");
  await links.getByLabel("Header link 1 label").fill("Docs");
  await links.getByLabel("Header link 1 URL").fill("https://docs.example.com");
  await links.getByRole("button", { name: "Add footer link" }).click();
  await links.getByLabel("Footer link 1 label").fill("Privacy");
  await links.getByLabel("Footer link 1 URL").fill("https://example.com/privacy");
  await expect(preview.getByRole("navigation", { name: "Links" }).getByRole("link", { name: "Docs" })).toBeVisible();
  // Leaving with changes not saved (for another section, say) asks first.
  await rail.getByRole("link", { name: "Branding" }).click();
  const leave = owner.getByRole("alertdialog", { name: "Leave without saving?" });
  await expect(leave).toBeVisible();
  await checkpoint(owner, "customize-leave-unsaved", { fullPage: false });
  await leave.getByRole("button", { name: "Keep editing" }).click();
  await expect(leave).toBeHidden();
  // So does going elsewhere from ⌘K.
  await owner.keyboard.press("ControlOrMeta+k");
  const search = owner.getByRole("dialog", { name: "Go to or do" }).getByRole("combobox", { name: "Search the project" });
  await search.fill("inbox");
  await search.press("Enter");
  await expect(leave).toBeVisible();
  await leave.getByRole("button", { name: "Keep editing" }).click();
  await expect(leave).toBeHidden();
  // Its own link in the menu isn't leaving: nothing to ask, the changes stay.
  await rail.getByRole("link", { name: "Navigation" }).click();
  await expect(links.getByLabel("Header link 1 label")).toHaveValue("Docs");
  // Nor is picking it in ⌘K.
  await owner.keyboard.press("ControlOrMeta+k");
  await search.fill("navigation");
  await search.press("Enter");
  await expect(owner.getByRole("dialog", { name: "Go to or do" })).toBeHidden();
  await expect(leave).toHaveCount(0);
  await expect(links.getByLabel("Header link 1 label")).toHaveValue("Docs");
  // Saved through tRPC (branding.update), not a server action.
  const saved = owner.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/api/trpc/branding.update"));
  await owner.getByRole("button", { name: "Save changes" }).click();
  await saved;
  await expect(owner.getByText("Navigation saved")).toBeVisible();
  await expect(preview.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Privacy" })).toBeVisible();
  await owner.reload();
  await expect(owner.getByLabel("Header link 1 URL")).toHaveValue("https://docs.example.com");
  await expect(header).toContainText("Header 1/5");
  const viewport = owner.viewportSize()!;
  await owner.setViewportSize({ width: 1440, height: 900 });
  await expect(preview.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Privacy" })).toBeVisible();
  await checkpoint(owner, "settings-navigation", { fullPage: false });
  // On a phone a link keeps one line (label, URL, its button) and "Add" stays beside the row's label; nothing runs off the side.
  await owner.setViewportSize({ width: 390, height: 844 });
  const boxOf = async (target: ReturnType<Page["locator"]>) => (await target.boundingBox())!;
  const [label, url, remove] = [await boxOf(owner.getByLabel("Header link 1 label")), await boxOf(owner.getByLabel("Header link 1 URL")), await boxOf(owner.getByRole("button", { name: "Remove header link 1" }))];
  expect(url.y).toBe(label.y);
  expect(url.x).toBeGreaterThan(label.x + label.width);
  expect(url.width).toBeGreaterThanOrEqual(120);
  expect(remove.x).toBeGreaterThanOrEqual(url.x + url.width);
  const addBox = await boxOf(addHeader);
  expect(addBox.y).toBeLessThan(label.y);
  expect(addBox.x + addBox.width).toBeLessThanOrEqual(390);
  expect(await owner.locator('[data-slot="portal-settings"]').evaluate((pane) => pane.scrollWidth - pane.clientWidth)).toBeLessThanOrEqual(0);
  expect(await owner.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await checkpoint(owner, "settings-navigation-phone", { fullPage: false });
  await owner.setViewportSize(viewport);

  // "Powered by tuti" (in Branding now; its old address lands there): hiding the badge needs a licence for the
  // project; switching it off asks about one instead.
  await owner.goto(`/app/${slug}/customize/powered-by`);
  await owner.waitForURL(`**/app/${slug}/settings/branding#powered-by`);
  const badge = owner.locator("#powered-by");
  const poweredBy = badge.getByRole("switch", { name: '"Powered by tuti"' });
  // What hiding takes is behind the row's ⓘ.
  await badge.getByRole("button", { name: "More about this setting" }).click();
  await expect(owner.getByText("The badge at the foot of your portal. Hiding it needs a licence for this project.")).toBeVisible();
  await owner.keyboard.press("Escape");
  await expect(poweredBy).toHaveAccessibleDescription("Hiding it needs a licence for this project.");
  await poweredBy.click();
  const dialog = owner.getByRole("dialog", { name: 'Keep "Powered by tuti"?' });
  await expect(dialog).toBeVisible();
  // Bought on the licence server (tuti.so; this installation itself here) for this installation and project.
  const buy = new URL((await dialog.getByRole("link", { name: "Get a licence" }).getAttribute("href"))!);
  expect(`${buy.origin}${buy.pathname}`).toBe(`${APP_URL}/app/license`);
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
    // The logo for this mode with its text links to the team's site; the other logo is hidden.
    const home = visitor.getByRole("banner").getByRole("link", { name: "Acme Help" });
    await expect(home).toHaveAttribute("href", "https://acme.example");
    const logo = home.locator("img:visible");
    await expect(logo).toBeVisible();
    await expect(logo).toHaveCount(1);
    await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    const logos = visitor.getByRole("banner").locator("img");
    const [lightSrc, darkSrc] = [await logos.nth(0).getAttribute("src"), await logos.nth(1).getAttribute("src")];
    expect(lightSrc).not.toBe(darkSrc);
    await expect(logo).toHaveAttribute("src", colorScheme === "light" ? lightSrc! : darkSrc!);

    await expect(visitor.locator('link[rel="icon"]')).toHaveAttribute("href", /\/media\/.+\.webp\?s=/);
    // The accent: the blue reads on both backgrounds, with white text on it.
    await expect(visitor.getByRole("button", { name: "New post" })).toHaveCSS("background-color", "rgb(37, 99, 235)");
    await expect(visitor.getByRole("button", { name: "New post" })).toHaveCSS("color", "rgb(255, 255, 255)");
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
    await visitor.getByRole("button", { name: "New post" }).focus();
    await checkpoint(visitor, `branded-portal-${colorScheme}`);

    // The widget's panel: its header in the team's colour, with text that reads on it.
    await visitor.goto("/widget");
    const header = visitor.locator("main > header");
    await expect(header).toHaveCSS("background-image", /rgb\(37, 99, 235\)/);
    await expect(header).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(header).toContainText("How can we help?");
    // Its close button's focus ring is in the header's text colour, not the header's own blue.
    await header.getByRole("button", { name: "Close" }).focus();
    await expect(header.getByRole("button", { name: "Close" })).toHaveCSS("border-color", "rgb(255, 255, 255)");
    await checkpoint(visitor, `branded-widget-${colorScheme}`);

    // The docs are the same portal, branded the same way.
    await visitor.goto("/docs");
    await expect(visitor.getByRole("navigation", { name: "Footer" })).toBeVisible();
    await expect(visitor.getByRole("contentinfo").getByText("Powered by")).toBeVisible();
    await visitor.context().close();
  }
});
