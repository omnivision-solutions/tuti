import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

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
  const refused = team.getByText("Only PDF, text (TXT, CSV, Markdown), JSON, ZIP, and Office or OpenDocument files can be attached");
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

  // An image dropped alone that can't be used says so (and stays said).
  const svg = await team.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "logo.svg", { type: "image/svg+xml" }));
    return transfer;
  });
  await editor.locator("p").first().dispatchEvent("drop", { dataTransfer: svg, clientX: line.x + 5, clientY: line.y + line.height / 2 });
  await expect(team.getByText("Only JPEG, PNG, WebP and GIF images can be uploaded")).toHaveRole("alert");

  await team.getByRole("button", { name: "Save draft" }).click();
  await team.waitForURL(`**/app/${slug}/docs/price-list`);
  await team.getByRole("button", { name: "Publish" }).click();
  await team.getByRole("alertdialog").getByRole("button", { name: "Publish" }).click();
  await expect(team.getByRole("button", { name: "Unpublish" })).toBeVisible();

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
