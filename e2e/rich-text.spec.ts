import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, signUp } from "./helpers";

test("someone writes a formatted post with a video, and a comment with a link", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  const ada = await signUp(browser, portalUrl(slug), "Ada");
  // Journeys stay offline: the video player is a stand-in page.
  await ada.context().route("https://www.youtube-nocookie.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<body style='background:#222;color:#fff'>Video</body>" }),
  );
  await ada.goto("/feedback/feature-requests");
  await ada.getByRole("button", { name: "New idea" }).click();
  await ada.getByLabel("Title").fill("Dark mode");

  // Bold from the bar over selected text, a link with its shortcut, and a list and a video from the / menu.
  const details = ada.getByRole("textbox", { name: "Details" });
  await details.click();
  // The bar shows over selected text, and goes once the selection does.
  const formatting = ada.getByRole("toolbar", { name: "Formatting" });
  await ada.keyboard.type("Dark mode would help at night.");
  // Selected once the editor has caught up with the typing: on a loaded machine its render after the last key can land after
  // Shift+Home and put the caret back at the end, so the selection is made again until it holds (the bar shows over it).
  await expect(async () => {
    await ada.keyboard.press("Shift+Home");
    await expect(formatting.getByRole("button", { name: "Bold" })).toBeVisible({ timeout: 1000 });
  }).toPass();
  await formatting.getByRole("button", { name: "Bold" }).click();
  await ada.keyboard.press("End");
  await expect(formatting).toBeHidden();
  await ada.keyboard.press("Enter");
  await ada.keyboard.type("The guide");
  await ada.keyboard.press("Shift+Home");
  await expect(formatting).toBeVisible();
  await checkpoint(ada, "portal-post-selection-bar");
  await ada.keyboard.press("ControlOrMeta+k");
  const guideDialog = ada.getByRole("dialog", { name: "Add a link" });
  await guideDialog.getByLabel("Link").fill("example.com/guide");
  await guideDialog.getByRole("button", { name: "Add link" }).click();
  // Writing carries on where it was, the linked text still selected.
  await expect(details).toBeFocused();
  await expect(formatting.getByRole("button", { name: "Remove link" })).toBeVisible();
  await ada.keyboard.press("End");
  await expect(formatting).toBeHidden();
  await ada.keyboard.press("Enter");
  await ada.keyboard.type("/bul");
  await ada.keyboard.press("Enter");
  await ada.keyboard.type("Less glare");
  await ada.keyboard.press("Enter");
  await ada.keyboard.type("Saves battery");
  await ada.keyboard.press("Enter");
  await ada.keyboard.press("Enter");
  await ada.keyboard.type("/");
  await ada.getByRole("option", { name: "Video" }).click();
  const videoDialog = ada.getByRole("dialog", { name: "Embed a video" });
  await videoDialog.getByLabel("Video link").fill("https://example.com/not-a-video");
  await videoDialog.getByRole("button", { name: "Embed video" }).click();
  await expect(videoDialog.getByLabel("Video link")).toHaveAccessibleDescription("Paste a YouTube, Vimeo or Loom link.");
  await videoDialog.getByLabel("Video link").fill("https://youtu.be/dQw4w9WgXcQ");
  await videoDialog.getByRole("button", { name: "Embed video" }).click();
  await expect(videoDialog).toHaveCount(0);
  await expect(details).toBeFocused();
  await checkpoint(ada, "portal-rich-post-editor");
  await ada.getByRole("button", { name: "Submit post" }).click();

  // The post page shows it as written; the video plays from the provider's embed URL.
  await ada.getByRole("link", { name: "Dark mode" }).click();
  await ada.waitForURL(/\/feedback\/[a-z0-9-]+\/dark-mode-1$/);
  const article = ada.getByRole("main");
  await expect(article.locator("strong").first()).toHaveText("Dark mode would help at night.");
  await expect(article.getByRole("link", { name: "The guide" })).toHaveAttribute("href", "https://example.com/guide");
  await expect(article.getByRole("listitem")).toHaveText(["Less glare", "Saves battery"]);
  await expect(article.locator("iframe")).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");

  // An empty comment is refused, and the editor says why to screen readers too.
  const comment = ada.getByRole("textbox", { name: "Comment" });
  await ada.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(comment).toHaveAttribute("aria-invalid", "true");
  await expect(comment).toHaveAccessibleDescription("Write something first");

  // A comment with a link typed without https://.
  await comment.click();
  await ada.keyboard.type("Like ");
  await ada.getByRole("button", { name: "Link", exact: true }).click();
  const linkDialog = ada.getByRole("dialog", { name: "Add a link" });
  await linkDialog.getByLabel("Link").fill("example.com/dark");
  await linkDialog.getByRole("button", { name: "Add link" }).click();
  await ada.getByRole("button", { name: "Comment", exact: true }).click();
  const link = ada.getByRole("listitem").getByRole("link", { name: "example.com/dark" });
  await expect(link).toHaveAttribute("href", "https://example.com/dark");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
  await checkpoint(ada, "portal-rich-post");
});

test("someone adds a screenshot to a post, resized and aligned", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  // A real picture to upload: a screenshot of the landing page.
  await owner.goto("/");
  const screenshot = await owner.screenshot();

  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await ada.getByRole("button", { name: "New idea" }).click();
  await ada.getByLabel("Title").fill("Make the hero smaller");
  await ada.getByRole("textbox", { name: "Details" }).click();
  await ada.keyboard.type("It takes the whole screen:");
  // The upload is slowed down, so submitting while it runs is held back instead of posting without it.
  await ada.context().route("**/*", async (route) => {
    if (route.request().method() === "PUT") {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await route.continue();
  });
  await ada.locator('input[type="file"]').setInputFiles({ name: "hero.png", mimeType: "image/png", buffer: screenshot });
  await expect(ada.getByText("Uploading image…")).toBeVisible();
  await ada.getByRole("button", { name: "Submit post" }).click();
  await expect(ada.getByText("Wait for the image to finish uploading, then try again.")).toBeVisible();

  // Once processed, the image shows in the editor; selecting it shows its controls.
  const editorImage = ada.getByRole("textbox", { name: "Details" }).locator("img");
  await expect(editorImage).toHaveJSProperty("complete", true);
  await expect.poll(() => editorImage.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // Nothing was posted meanwhile, and the form still has what was typed.
  await expect(ada.getByText("Feedback posted")).toHaveCount(0);
  await expect(ada.getByLabel("Title")).toHaveValue("Make the hero smaller");
  await expect(ada.getByRole("link", { name: "Make the hero smaller" })).toHaveCount(0);
  await editorImage.click();
  const controls = ada.getByRole("group", { name: "Image" });
  // They're next in the tab order, for keyboard users.
  await expect(controls).toBeVisible();
  await ada.keyboard.press("Tab");
  await expect(controls.getByRole("button", { name: "Small" })).toBeFocused();
  await controls.getByRole("button", { name: "Medium" }).click();
  await controls.getByRole("button", { name: "Align right" }).click();
  await controls.getByRole("button", { name: "Alt text" }).click();
  const altDialog = ada.getByRole("dialog", { name: "Describe the image" });
  await altDialog.getByLabel("Alt text").fill("The landing page hero filling the screen");
  await altDialog.getByRole("button", { name: "Save" }).click();
  await checkpoint(ada, "portal-post-image-editor");
  await ada.getByRole("button", { name: "Submit post" }).click();

  await ada.getByRole("link", { name: "Make the hero smaller" }).click();
  const figure = ada.getByRole("main").locator("figure.rich-image");
  await expect(figure).toHaveAttribute("data-width", "50");
  await expect(figure).toHaveAttribute("data-align", "right");
  const image = figure.getByRole("img", { name: "The landing page hero filling the screen" });
  // Signed URLs: the bucket is private.
  await expect(image).toHaveAttribute("srcset", /480\.webp\?[^ ]*X-Amz-Signature=[^ ]+ 480w/);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await checkpoint(ada, "portal-post-with-image");
});

test("someone comments with a screenshot, and the team replies with one", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);
  await owner.goto("/");
  const screenshot = await owner.screenshot();

  const ada = await signUp(browser, portalUrl(slug), "Ada");
  await ada.goto("/feedback/feature-requests");
  await ada.getByRole("button", { name: "New idea" }).click();
  await ada.getByLabel("Title").fill("Export is broken");
  await ada.getByRole("button", { name: "Submit post" }).click();
  await ada.getByRole("link", { name: "Export is broken" }).click();

  // The comment box's Image button picks one, as a post's editor does.
  const comment = ada.getByRole("textbox", { name: "Comment" });
  await comment.click();
  await ada.keyboard.type("Here's what I see:");
  const picker = ada.waitForEvent("filechooser");
  await ada.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Image" }).click();
  await (await picker).setFiles({ name: "export.png", mimeType: "image/png", buffer: screenshot });
  await expect.poll(() => comment.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // The draft kept in the tab has the words only (a restored image would have no signed link to show it by).
  const draft = () => ada.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith("tuti:comment-draft:"))?.[1] ?? "");
  await expect.poll(draft).toContain("Here's what I see:");
  expect(await draft()).not.toContain('"image"');
  await ada.getByRole("button", { name: "Comment", exact: true }).click();
  const shown = ada.getByRole("region", { name: "Comments" }).getByRole("listitem").locator("figure.rich-image img");
  await expect(shown).toHaveAttribute("srcset", /X-Amz-Signature=/);
  await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await checkpoint(ada, "portal-comment-with-image");

  // The team's reply box takes one too; both show on the team's post page.
  await owner.goto(`/app/${slug}/p/1`);
  const reply = owner.getByRole("textbox", { name: "Comment" });
  await reply.click();
  await owner.keyboard.type("Fixed, it looks like this now:");
  const teamPicker = owner.waitForEvent("filechooser");
  await owner.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Image" }).click();
  await (await teamPicker).setFiles({ name: "fixed.png", mimeType: "image/png", buffer: screenshot });
  await expect.poll(() => reply.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await owner.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(owner.getByText("Fixed, it looks like this now:")).toBeVisible();
  const images = owner.locator("ol figure.rich-image img");
  await expect(images).toHaveCount(2);
  for (const image of await images.all()) {
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  }
  await checkpoint(owner, "team-reply-with-image");

  // The Feedback pane's reply box takes one as well.
  await owner.goto(`/app/${slug}/feedback?post=1`);
  const paneReply = owner.getByRole("textbox", { name: "Comment" });
  await paneReply.click();
  await owner.keyboard.type("One more from the list:");
  const panePicker = owner.waitForEvent("filechooser");
  await owner.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name: "Image" }).click();
  await (await panePicker).setFiles({ name: "pane.png", mimeType: "image/png", buffer: screenshot });
  await expect.poll(() => paneReply.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await owner.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(paneReply).not.toContainText("One more from the list:");
  await owner.goto(`/app/${slug}/p/1`);
  await expect(owner.getByText("One more from the list:")).toBeVisible();
  await expect(images).toHaveCount(3);
});
