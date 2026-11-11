import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

test("the team uploads a video into an article from the / menu, publishes it, and a visitor plays it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  await team.goto(`/app/${slug}/docs/new`);
  await team.getByLabel("Title").fill("Product tour");
  const editor = team.getByRole("textbox", { name: "Article" });
  await editor.click();
  await team.keyboard.type("A quick look around:");
  await team.keyboard.press("Enter");

  // A real (tiny) WebM, recorded from a canvas in the browser, so it plays.
  const webm = await team.evaluate(async () => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 64, height: 36 });
    const context = canvas.getContext("2d")!;
    const recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start();
    for (let frame = 0; frame < 5; frame++) {
      context.fillStyle = `hsl(${frame * 60} 70% 50%)`;
      context.fillRect(0, 0, 64, 36);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    recorder.stop();
    await stopped;
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });

  const chooser = team.waitForEvent("filechooser");
  await team.keyboard.type("/upload v");
  await team.getByRole("listbox", { name: "Blocks" }).getByRole("option", { name: "Upload video" }).click();
  await (await chooser).setFiles({ name: "Tour.webm", mimeType: "video/webm", buffer: Buffer.from(webm) });
  // It plays in the editor as soon as it's uploaded.
  await expect(editor.locator(".rich-video video[controls]")).toHaveAttribute("src", /\/m\/\w+\/video/);
  await checkpoint(team, "team-article-video-added");

  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/docs/product-tour`);
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish" }).click();
  // Unpublish is behind "More actions", with Delete.
  await team.getByRole("button", { name: "More actions" }).click();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();
  await team.keyboard.press("Escape");

  // A visitor sees the browser's own player, which loads the video when asked to.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs/product-tour");
  const video = visitor.getByRole("article", { name: "Product tour" }).locator("video");
  await expect(video).toHaveAttribute("controls", "");
  await expect(video).toHaveAttribute("preload", "metadata");
  // A URL signed as the page was shown, on the storage's host, good for a day (the player asks for more as it's played).
  await expect(video).toHaveAttribute("src", /\/m\/\w+\/video\?.*X-Amz-Expires=90000/);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
  await checkpoint(visitor, "portal-article-video");

  // The article's Markdown links it.
  const markdown = await (await visitor.request.get(`${portalUrl(slug)}/docs/product-tour.md`)).text();
  expect(markdown).toMatch(/\[Video\]\(http[^)]+\)/);
});
