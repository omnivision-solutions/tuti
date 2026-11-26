import { randomUUID } from "node:crypto";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { expect, test } from "./fixtures";
import { apiFor, createProject, signUp } from "./helpers";

test("the team generates an entry's cover with AI from a prompt and a reference, refines it, picks a try and uses it; readers see it", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Gina Generate");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/changelog", { title: "Dark mode is here", body: "Pick a theme in your profile." });
  const saved = async () => (await api("/changelog/1", undefined, "GET")) as unknown as { cover: { id: string; width: number; height: number } | null };

  // From the cover's empty band: Generate, beside Make a cover.
  await team.goto(`/app/${slug}/changelog/1`);
  const featured = team.getByRole("group", { name: "Featured image" });
  await featured.getByRole("button", { name: "Generate" }).click();
  const dialog = team.getByRole("dialog", { name: /Generate image/ });
  await expect(dialog.getByRole("heading")).toContainText("Cover for “Dark mode is here”");
  await expect(dialog.getByRole("button", { name: "Cover" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByText("1200 × 630")).toBeVisible();
  await expect(dialog.getByText("Uses AI credits")).toBeVisible();
  await dialog.getByLabel("Describe it").fill("A parrot in a dark room, flat illustration");

  // A reference uploaded from the + tile's menu.
  await dialog.getByRole("button", { name: "Add a reference" }).click();
  await expect(team.getByRole("menuitem", { name: /Media library/ })).toHaveAttribute("aria-disabled", "true");
  const chooser = team.waitForEvent("filechooser");
  await team.getByRole("menuitem", { name: "Upload or paste" }).click();
  await (await chooser).setFiles({ name: "logo.png", mimeType: "image/png", buffer: await team.screenshot({ clip: { x: 0, y: 0, width: 200, height: 200 } }) });
  const references = dialog.getByRole("list", { name: "References" });
  await expect(references.getByRole("img")).toHaveCount(1);

  // Generate (the model fake answers with a picture): one try, shown.
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Try 1" })).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByRole("img", { name: "Try 1" })).toBeVisible();

  // Refine: the try is the first reference now, and the prompt has the focus; a second try.
  await dialog.getByRole("button", { name: "Refine this one" }).click();
  await expect(references.getByRole("img")).toHaveCount(2);
  await expect(dialog.getByLabel("Describe it")).toBeFocused();
  await dialog.getByLabel("Describe it").fill("The same, with a lamp");
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Try 2" })).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
  await checkpoint(team, "dialog-with-a-result", { fullPage: false });

  // The first try, used as the cover: the form's cover, focus on Replace; Save keeps it.
  await dialog.getByRole("button", { name: "Try 1" }).click();
  await dialog.getByRole("button", { name: "Use as cover" }).click();
  await expect(dialog).toBeHidden();
  await expect(featured.getByRole("button", { name: "Replace featured image" })).toBeFocused();
  await expect.poll(() => featured.getByRole("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1200);
  expect((await saved()).cover).toBeNull();
  await team.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("Saved")).toBeVisible();
  expect((await saved()).cover).toMatchObject({ width: 1200, height: 630 });
  await checkpoint(team, "editor-with-the-generated-cover");

  // On a phone the buttons over the cover wrap inside it, none past its edges.
  await team.setViewportSize({ width: 375, height: 800 });
  const picture = (await featured.getByRole("img").boundingBox())!;
  for (const name of ["Replace featured image", "Make a cover", "Generate", "Remove featured image"]) {
    const box = (await featured.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(picture.x);
    expect(box.x + box.width).toBeLessThanOrEqual(picture.x + picture.width);
    expect(box.y + box.height).toBeLessThanOrEqual(picture.y + picture.height);
  }
  await checkpoint(team, "editor-cover-buttons-on-a-phone");
  await team.setViewportSize({ width: 1280, height: 720 });

  // Published, readers see it.
  await team.getByRole("button", { name: "Publish", exact: true }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish", exact: true }).click();
  await expect(team.getByText("Published", { exact: true })).toBeVisible();
  const reader = await (await browser.newContext()).newPage();
  await reader.goto(`${portalUrl(slug)}/changelog/1`);
  const shown = reader.getByRole("img", { name: "Dark mode is here" });
  await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
});
