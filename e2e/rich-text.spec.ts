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
  await ada.goto("/b/feature-requests");
  await ada.getByLabel("Title").fill("Dark mode");

  // Bold, a list and a video, from the toolbar.
  const details = ada.getByRole("textbox", { name: "Details" });
  await details.click();
  await ada.getByRole("button", { name: "Bold" }).click();
  await ada.keyboard.type("Dark mode");
  await ada.getByRole("button", { name: "Bold" }).click();
  await ada.keyboard.type(" would help at night.");
  await ada.keyboard.press("Enter");
  await ada.getByRole("button", { name: "Bulleted list" }).click();
  await ada.keyboard.type("Less glare");
  await ada.keyboard.press("Enter");
  await ada.keyboard.type("Saves battery");
  await ada.keyboard.press("Enter");
  await ada.keyboard.press("Enter");
  await ada.getByRole("button", { name: "Video" }).click();
  const videoDialog = ada.getByRole("dialog", { name: "Embed a video" });
  await videoDialog.getByLabel("Video link").fill("https://example.com/not-a-video");
  await videoDialog.getByRole("button", { name: "Embed video" }).click();
  await expect(videoDialog.getByText("Paste a YouTube, Vimeo or Loom link.")).toBeVisible();
  await videoDialog.getByLabel("Video link").fill("https://youtu.be/dQw4w9WgXcQ");
  await videoDialog.getByRole("button", { name: "Embed video" }).click();
  await expect(videoDialog).toHaveCount(0);
  await checkpoint(ada, "portal-rich-post-editor");
  await ada.getByRole("button", { name: "Submit feedback" }).click();

  // The post page shows it as written; the video plays from the provider's embed URL.
  await ada.getByRole("link", { name: "Dark mode" }).click();
  await ada.waitForURL(/\/p\/dark-mode-1$/);
  const article = ada.getByRole("main");
  await expect(article.locator("strong", { hasText: "Dark mode" })).toBeVisible();
  await expect(article.getByRole("listitem")).toHaveText(["Less glare", "Saves battery"]);
  await expect(article.locator("iframe")).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");

  // A comment with a link typed without https://.
  await ada.getByRole("textbox", { name: "Comment" }).click();
  await ada.keyboard.type("Like ");
  await ada.getByRole("button", { name: "Link" }).click();
  const linkDialog = ada.getByRole("dialog", { name: "Add a link" });
  await linkDialog.getByLabel("Link").fill("example.com/dark");
  await linkDialog.getByRole("button", { name: "Add link" }).click();
  await ada.getByRole("button", { name: "Comment", exact: true }).click();
  const link = ada.getByRole("listitem").getByRole("link", { name: "example.com/dark" });
  await expect(link).toHaveAttribute("href", "https://example.com/dark");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
  await checkpoint(ada, "portal-rich-post");
});
