import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
import { APP_URL, CLOUD_URL, cloudPortalUrl } from "./env";
import { expect, test } from "./fixtures";
import { createProject, signUp } from "./helpers";

test("an owner adds German in Settings → Languages, writes its instructions, makes it live, takes it offline and removes it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  // Under Portal, after SEO.
  await owner.goto(`/app/${slug}/settings/seo`);
  await owner.getByRole("link", { name: "Languages" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/languages`);
  const pane = owner.getByRole("region", { name: "Languages" });
  const defaultLanguage = pane.getByRole("combobox", { name: "Default language" });
  await expect(defaultLanguage).toContainText("English");
  await expect(defaultLanguage).toBeEnabled();
  await expect(pane.getByText("Only English so far.", { exact: false })).toBeVisible();

  // Adding asks first: which language, the pages it takes on, offline until it's made live.
  await pane.getByRole("button", { name: "Add language" }).click();
  const add = owner.getByRole("dialog", { name: "Add a language" });
  await expect(add).toContainText("only your team sees it until you make it live");
  await expect(add).toContainText(/\d+ published pages?, shown in English until they're translated/);
  await expect(add.getByRole("button", { name: "Add language" })).toBeDisabled();
  await add.getByRole("combobox", { name: "Language" }).click();
  await owner.getByRole("option", { name: "Deutsch (German)" }).click();
  await checkpoint(owner, "settings-languages-add", { fullPage: false });
  await add.getByRole("button", { name: "Add Deutsch" }).click();
  await expect(owner.getByText("Added Deutsch")).toBeVisible();
  await expect(add).toBeHidden();

  const languages = pane.getByRole("list", { name: "Other languages" });
  const german = languages.getByRole("listitem").filter({ hasText: "Deutsch" });
  await expect(german).toContainText("German · Automatic");
  await expect(german).toContainText("Offline");
  // With another language the default is locked.
  await expect(defaultLanguage).toBeDisabled();
  await expect(pane.getByText("Remove the other languages first to change it.", { exact: false })).toBeVisible();

  // Instructions, and "Our product is available in Deutsch".
  const menu = german.getByRole("button", { name: "Actions for German" });
  await menu.click();
  await owner.getByRole("menuitem", { name: "Instructions…" }).click();
  const instructions = owner.getByRole("dialog", { name: "Translating into Deutsch" });
  await instructions.getByRole("textbox", { name: "Instructions" }).fill("Use du, not Sie.");
  const product = instructions.getByRole("switch", { name: "Our product is available in Deutsch" });
  await expect(product).toHaveAccessibleDescription("Off: names of buttons and screens stay as written. On: they're translated.");
  await product.check();
  await instructions.getByRole("button", { name: "Save" }).click();
  await expect(owner.getByText("Saved Deutsch's instructions")).toBeVisible();
  await expect(instructions).toBeHidden();

  // New pages: Manual.
  await menu.click();
  await owner.getByRole("menuitemradio", { name: "Manual" }).click();
  await expect(german).toContainText("German · Manual");

  // Go live, then offline again.
  await menu.click();
  await owner.getByRole("menuitem", { name: "Go live" }).click();
  await expect(owner.getByText("Deutsch is live")).toBeVisible();
  await expect(german).toContainText("Live");
  // Its toast gone, so the screenshots show the page.
  await expect(owner.getByText("Deutsch is live")).toBeHidden({ timeout: 10_000 });
  await checkpoint(owner, "settings-languages");
  await owner.setViewportSize({ width: 390, height: 844 });
  expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await checkpoint(owner, "settings-languages-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
  await menu.click();
  await owner.getByRole("menuitem", { name: "Take offline" }).click();
  await expect(owner.getByText("Deutsch is offline")).toBeVisible();

  // Saved as set, after a reload.
  await owner.reload();
  await menu.click();
  await owner.getByRole("menuitem", { name: "Instructions…" }).click();
  await expect(instructions.getByRole("textbox", { name: "Instructions" })).toHaveValue("Use du, not Sie.");
  await expect(product).toBeChecked();
  await instructions.getByRole("button", { name: "Cancel" }).click();
  await expect(instructions).toBeHidden();

  // Removing asks first; then the default can change again.
  await menu.click();
  await owner.getByRole("menuitem", { name: "Remove" }).click();
  const remove = owner.getByRole("alertdialog", { name: "Remove Deutsch?" });
  await remove.getByRole("button", { name: "Remove Deutsch" }).click();
  await expect(owner.getByText("Removed Deutsch")).toBeVisible();
  await expect(remove).toBeHidden();
  await expect(languages).toBeHidden();
  await expect(defaultLanguage).toBeEnabled();
});

// On Tuti's cloud, which sells plans: Free has the default language alone.
test("on a plan with no room for another language, Add language offers the upgrade", async ({ browser }) => {
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, CLOUD_URL, "Olive Owner");
  await createProject(owner, "Acme", slug, cloudPortalUrl);
  await owner.goto(`/app/${slug}/settings/languages`);
  const add = owner.getByRole("button", { name: "Add language" });
  await expect(add).toHaveAccessibleDescription(/^Projects on the Free plan have 1 language, the default included\. Upgrade to /);
  await add.click();
  const prompt = owner.getByRole("dialog", { name: /^Projects on the Free plan have 1 language/ });
  await expect(prompt.getByRole("link", { name: "See plans" })).toHaveAttribute("href", `/app/${slug}/settings/billing`);
  await prompt.getByRole("button", { name: "Not now" }).click();
  await expect(prompt).toBeHidden();
});
