import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL, portalUrl } from "./env";
import { createProject, newPerson, signUp } from "./helpers";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

test("the team attaches a file to an article from the / menu, publishes it, and a visitor downloads it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);

  await team.goto(`/app/${slug}/docs/new`);
  await team.getByLabel("Title").fill("Price list");
  const editor = team.getByRole("textbox", { name: "Article" });
  await editor.click();
  await team.keyboard.type("Download this year's prices:");
  await team.keyboard.press("Enter");

  // A program isn't attached, however it's picked; the editor says what can be.
  let chooser = team.waitForEvent("filechooser");
  await team.keyboard.type("/file");
  await team.getByRole("listbox", { name: "Blocks" }).getByRole("option", { name: "File" }).click();
  await (await chooser).setFiles({ name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
  const refused = team.getByText("Only PDF, text (TXT, CSV, Markdown), JSON, ZIP, Office or OpenDocument files, and MP4, WebM or MOV videos can be attached");
  await expect(refused).toHaveRole("alert");

  // A PDF is: it shows with its type, name and size.
  chooser = team.waitForEvent("filechooser");
  await team.keyboard.type("/fil");
  await team.keyboard.press("Enter");
  await (await chooser).setFiles({ name: "Price list 2026.pdf", mimeType: "application/pdf", buffer: PDF });
  const attached = editor.locator(".rich-file");
  await expect(attached).toContainText("PDF");
  await expect(attached).toContainText("Price list 2026.pdf");
  await expect(attached).toContainText("1 KB");
  await expect(refused).toHaveCount(0);

  // Dropping files on the text attaches them too, several at once one after another.
  const dropped = await team.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["Plan,Price\nPro,10\n"], "prices.csv", { type: "text/csv" }));
    transfer.items.add(new File(["Prices are monthly."], "notes.txt", { type: "text/plain" }));
    return transfer;
  });
  // Where it lands: the editor places a drop by its coordinates.
  const line = (await editor.locator("p").first().boundingBox())!;
  await editor.locator("p").first().dispatchEvent("drop", { dataTransfer: dropped, clientX: line.x + 5, clientY: line.y + line.height / 2 });
  await expect(attached).toHaveCount(3);
  await expect(attached.filter({ hasText: "prices.csv" })).toContainText("CSV");
  const names = await attached.allTextContents();
  expect(names[names.findIndex((name) => name.includes("prices.csv")) + 1]).toContain("notes.txt");
  await checkpoint(team, "team-article-file-attached");

  // An image that can't be used says so, and stays said while a file dropped with it is attached.
  const svg = await team.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "logo.svg", { type: "image/svg+xml" }));
    transfer.items.add(new File(["Plans renew monthly."], "terms.txt", { type: "text/plain" }));
    return transfer;
  });
  await editor.locator("p").first().dispatchEvent("drop", { dataTransfer: svg, clientX: line.x + 5, clientY: line.y + line.height / 2 });
  await expect(attached.filter({ hasText: "terms.txt" })).toHaveCount(1);
  await expect(team.getByText("Only JPEG, PNG, WebP and GIF images can be uploaded")).toHaveRole("alert");

  // An image added right after a file goes after it, not in its place.
  await attached.filter({ hasText: "terms.txt" }).click();
  await expect
    .poll(() => editor.evaluate((element) => (element as unknown as { editor: { state: { selection: { node?: { type: { name: string } } } } } }).editor.state.selection.node?.type.name))
    .toBe("file");
  // A fixed 1×1 PNG, the same on every run.
  const picture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const image = await team.evaluateHandle((bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "result.png", { type: "image/png" }));
    return transfer;
  }, [...picture]);
  await editor.evaluate((element, transfer) => {
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer as DataTransfer, bubbles: true, cancelable: true }));
  }, image);
  await expect(editor.locator("figure img")).toHaveCount(1);
  await expect(attached.filter({ hasText: "terms.txt" })).toHaveCount(1);

  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/docs/price-list`);
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish" }).click();
  // Unpublish is behind "More actions", with Delete.
  await team.getByRole("button", { name: "More actions" }).click();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();
  await team.keyboard.press("Escape");

  // A visitor downloads it from the article, under its name, as it was uploaded.
  const visitor = await newPerson(browser, portalUrl(slug));
  await visitor.goto("/docs/price-list");
  const link = visitor.getByRole("article", { name: "Price list" }).getByRole("link", { name: "Price list 2026.pdf 1 KB" });
  await expect(link).toBeVisible();
  await checkpoint(visitor, "portal-article-file");
  const download = visitor.waitForEvent("download");
  await link.click();
  expect((await download).suggestedFilename()).toBe("Price list 2026.pdf");
  expect(await readFile((await (await download).path())!)).toEqual(PDF);

  // The article's Markdown links it too.
  const markdown = await (await visitor.request.get(`${portalUrl(slug)}/docs/price-list.md`)).text();
  expect(markdown).toMatch(/\[Price list 2026\.pdf\]\(http[^)]+\)/);
});
