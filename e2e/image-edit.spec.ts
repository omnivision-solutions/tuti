import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, newPerson, signUp } from "./helpers";

/** An image added to the text from the / menu, then picked (clicked) and edited with AI (the model fake answers), replacing it. Its media id before and after. */
async function editImageInText(team: Page, text: ReturnType<Page["getByRole"]>, bar: string, title: string, checkpoint: ReturnType<typeof checkpoints>) {
  await text.click();
  await team.keyboard.press("End");
  await team.keyboard.press("Enter");
  const chooser = team.waitForEvent("filechooser");
  await team.keyboard.type("/image");
  await team.getByRole("listbox", { name: "Blocks" }).getByRole("option", { name: "Image" }).click();
  await (await chooser).setFiles({ name: "screen.png", mimeType: "image/png", buffer: await team.screenshot({ clip: { x: 0, y: 0, width: 400, height: 300 } }) });
  const figure = text.locator("figure.rich-image");
  await expect.poll(() => figure.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  const original = (await figure.getAttribute("data-media-id"))!;

  // Picked, its bar has Edit with AI beside the image's other actions.
  await figure.locator("img").click();
  const tools = team.getByRole("toolbar", { name: bar });
  await expect(tools.getByRole("button", { name: "Alt text" })).toBeVisible();
  await checkpoint(team, "image-bar-with-edit-with-ai", { fullPage: false });
  await tools.getByRole("button", { name: "Edit with AI" }).click();

  const dialog = team.getByRole("dialog", { name: /Edit image/ });
  await expect(dialog.getByRole("heading")).toContainText(`In “${title}”`);
  await expect(dialog.getByRole("button", { name: "Same as original" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByText("400 × 300")).toBeVisible();
  await expect(dialog.getByRole("list", { name: "References" }).getByRole("listitem").first()).toContainText("Editing");
  await dialog.getByLabel("What to change").fill("Make the background dark blue");
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(dialog.getByText("Edited · 1 of 1")).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByRole("img", { name: "Original" })).toBeVisible();
  await checkpoint(team, "edit-image-dialog-with-a-result", { fullPage: false });

  // Replace image: the new one in its place, nothing saved yet.
  await dialog.getByRole("button", { name: "Replace image" }).click();
  await expect(dialog).toBeHidden();
  await expect(figure).toHaveCount(1);
  await expect(figure).not.toHaveAttribute("data-media-id", original);
  await expect.poll(() => figure.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  return { original, edited: (await figure.getAttribute("data-media-id"))! };
}

test("the team edits an image in an article's text with AI, replaces it and publishes; readers see the new one", async ({ browser }, testInfo) => {
  test.setTimeout(150_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Ines Image");
  await createProject(team, "Acme", slug);

  await team.goto(`/app/${slug}/docs/new`);
  await team.getByLabel("Title").fill("Exporting reports");
  const text = team.getByRole("textbox", { name: "Article" });
  await text.click();
  await team.keyboard.type("Open Reports, then Export.");
  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/docs/exporting-reports`);

  const { edited } = await editImageInText(team, text, "Text selection", "Exporting reports", checkpoint);
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByRole("button", { name: "Saved" })).toBeVisible();
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish" }).click();
  await expect(team.getByRole("button", { name: "More actions" })).toBeVisible();

  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs/exporting-reports");
  const shown = visitor.getByRole("article", { name: "Exporting reports" }).locator("figure.rich-image img");
  await expect(shown).toHaveAttribute("src", new RegExp(`/m/${edited}/`));
  await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
});

test("the team edits an image in a changelog entry's text with AI, replaces it and publishes; readers see the new one", async ({ browser }, testInfo) => {
  test.setTimeout(150_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Ivo Image");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/changelog", { title: "Faster exports", body: "Exports finish in seconds." });

  await team.goto(`/app/${slug}/changelog/1`);
  const text = team.getByRole("textbox", { name: "What changed" });
  const { edited } = await editImageInText(team, text, "Formatting", "Faster exports", checkpoint);
  // Undo brings the original back, and redo the edit: an editor change like any other.
  await team.keyboard.press("ControlOrMeta+z");
  await expect(text.locator("figure.rich-image")).not.toHaveAttribute("data-media-id", edited);
  await team.keyboard.press("ControlOrMeta+Shift+z");
  await expect(text.locator("figure.rich-image")).toHaveAttribute("data-media-id", edited);

  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved")).toBeVisible();
  await team.getByRole("button", { name: "Publish", exact: true }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();

  const reader = await newPerson(browser, portalUrl(slug));
  await reader.goto("/changelog/1");
  const shown = reader.locator("figure.rich-image img");
  await expect(shown).toHaveAttribute("src", new RegExp(`/m/${edited}/`));
  await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
});
