import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

test("a reader picks dark mode in the portal's footer and keeps it; with the switch turned off, every reader gets the team's default", async ({ browser }, testInfo) => {
  test.setTimeout(90_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // A reader on a light device switches the portal to dark: it stays after a reload.
  const reader = await (await browser.newContext({ baseURL: portalUrl(slug), colorScheme: "light" })).newPage();
  await reader.goto("/feedback/feature-requests");
  const html = reader.locator("html");
  const theme = reader.getByRole("contentinfo").getByRole("radiogroup", { name: "Theme" });
  await expect(theme.getByRole("radio", { name: "System" })).toBeChecked();
  await expect(html).not.toHaveClass(/\bdark\b/);
  // Its icon, as a reader clicks it.
  await theme.getByRole("radio", { name: "Dark" }).locator("..").click();
  await expect(html).toHaveClass(/\bdark\b/);
  await checkpoint(reader, "portal-theme-switch-dark", { fullPage: false });
  await reader.reload();
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(theme.getByRole("radio", { name: "Dark" })).toBeChecked();
  // From the keyboard: arrows move along the switch.
  await theme.getByRole("radio", { name: "Dark" }).press("ArrowLeft");
  await expect(html).not.toHaveClass(/\bdark\b/);
  await expect(theme.getByRole("radio", { name: "Light" })).toBeChecked();
  await theme.getByRole("radio", { name: "Light" }).press("ArrowRight");
  await expect(html).toHaveClass(/\bdark\b/);

  // The team turns the switch off, with light mode for everyone: the preview's footer loses it before it's saved.
  await owner.goto(`/app/${slug}/settings/branding`);
  const preview = owner.frameLocator('iframe[title="Portal preview"]');
  const switcher = preview.getByRole("radiogroup", { name: "Theme" });
  // Once its page has run (until then none is picked).
  await expect(switcher.getByRole("radio", { name: "System" })).toBeChecked();
  // In the preview the switch only changes the page: nothing kept where the portal remembers the team member's own pick.
  await switcher.getByRole("radio", { name: "Dark" }).locator("..").click();
  await expect(preview.locator("html")).toHaveClass(/\bdark\b/);
  await expect(switcher.getByRole("radio", { name: "Dark" })).toBeChecked();
  expect(await owner.frame({ name: "tuti-preview" })!.evaluate(() => localStorage.getItem("theme"))).toBeNull();
  // Another page's footer, mounted since, says the same.
  const docsLink = preview.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: /^Doc/ });
  await docsLink.click();
  await expect(docsLink).toHaveAttribute("aria-current", "page");
  await expect(preview.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(preview.locator("html")).toHaveClass(/\bdark\b/);
  const card = owner.locator("form").first();
  const defaultTheme = card.getByRole("radiogroup", { name: "Default theme" });
  await expect(defaultTheme).toHaveAccessibleDescription("What readers see first.");
  await defaultTheme.getByText("Light", { exact: true }).click();
  // Trying a default shows it on the page, and the switch says so (not the Dark tried before).
  await expect(preview.locator("html")).toHaveClass(/\blight\b/);
  await expect(switcher.getByRole("radio", { name: "Light" })).toBeChecked();
  await card.getByRole("switch", { name: "Let readers switch theme" }).uncheck();
  await expect(switcher).toBeHidden();
  await checkpoint(owner, "branding-theme-switch-off");
  await owner.getByRole("button", { name: "Save changes" }).click();
  await expect(owner.getByText("Branding saved")).toBeVisible();

  // The reader's dark pick no longer wins: the portal is in the team's light mode, with no switch.
  await reader.reload();
  await expect(reader.getByRole("contentinfo")).toBeVisible();
  await expect(reader.getByRole("radiogroup", { name: "Theme" })).toHaveCount(0);
  await expect(html).toHaveClass(/\blight\b/);
  await expect(html).not.toHaveClass(/\bdark\b/);
});

test("with storage blocked by the browser, the footer switch still changes the theme on the page", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const reader = await (await browser.newContext({ baseURL: portalUrl(slug), colorScheme: "light" })).newPage();
  // As privacy settings do: writing to the page's storage throws.
  await reader.addInitScript(() => {
    const blocked = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    Storage.prototype.setItem = blocked;
    Storage.prototype.removeItem = blocked;
  });
  await reader.goto("/feedback/feature-requests");
  const theme = reader.getByRole("contentinfo").getByRole("radiogroup", { name: "Theme" });
  await theme.getByRole("radio", { name: "Dark" }).locator("..").click();
  await expect(reader.locator("html")).toHaveClass(/\bdark\b/);
});

test("a reader's own pick, even the team's default, survives the team changing its default", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  const api = await apiFor(owner, slug);
  await api("/branding", { colorScheme: "light" }, "PATCH");
  const reader = await (await browser.newContext({ baseURL: portalUrl(slug), colorScheme: "light" })).newPage();
  await reader.goto("/feedback/feature-requests");
  const html = reader.locator("html");
  const theme = reader.getByRole("contentinfo").getByRole("radiogroup", { name: "Theme" });
  // Dark, then back to Light: now Light is theirs, not the default they were shown.
  await theme.getByRole("radio", { name: "Dark" }).locator("..").click();
  await expect(html).toHaveClass(/\bdark\b/);
  await theme.getByRole("radio", { name: "Light" }).locator("..").click();
  await expect(html).toHaveClass(/\blight\b/);
  await api("/branding", { colorScheme: "dark" }, "PATCH");
  await reader.reload();
  await expect(theme.getByRole("radio", { name: "Light" })).toBeChecked();
  await expect(html).toHaveClass(/\blight\b/);

  // The portal's widget follows the page, not the team's default: light like the reader's pick, though the default is dark.
  await reader.locator('body > button[aria-controls="tuti-widget"]').click();
  const panel = reader.frameLocator("#tuti-widget iframe");
  await expect(panel.getByRole("navigation", { name: "Widget" })).toBeVisible();
  await expect(panel.locator("html")).toHaveClass(/\blight\b/);
});
