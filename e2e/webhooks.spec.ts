import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { createProject, signUp } from "./helpers";

test("an admin adds a webhook, sends a test event to it and deletes it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const events: { type: string }[] = [];
  const receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      events.push(JSON.parse(body));
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/tuti`;

  try {
    const slug = `e2e-${randomUUID().slice(0, 8)}`;
    const owner = await signUp(browser, APP_URL, "Olive Owner");
    await createProject(owner, "Acme", slug);
    await owner.goto(`/app/${slug}/settings/developers`);
    await expect(owner.getByText("No webhooks yet. Tuti POSTs to your endpoint as things happen.")).toBeVisible();

    // The endpoint and its events are asked in a dialog, which stays open on the signing secret (shown once).
    await owner.getByRole("button", { name: "Add webhook" }).click();
    const dialog = owner.getByRole("dialog", { name: "Add a webhook" });
    await expect(dialog).toContainText("retries for about a day until it answers with a 2xx");
    const endpoint = dialog.getByRole("textbox", { name: "Endpoint URL" });
    await expect(endpoint).toBeFocused();
    await endpoint.fill(url);
    await expect(dialog.getByRole("checkbox")).toHaveCount(7);
    await dialog.getByRole("checkbox", { name: /Status changed/ }).uncheck();
    await dialog.getByRole("button", { name: "Add webhook" }).click();
    const secret = dialog.getByRole("alert").filter({ hasText: "Copy the signing secret now" }).locator("code");
    await expect(secret).toHaveText(/^whsec_/);
    await checkpoint(owner, "settings-webhook-added", { fullPage: false });
    // A tap beside the dialog doesn't close it: the secret isn't shown again.
    await owner.mouse.click(5, 5);
    await expect(secret).toBeVisible();
    // On a phone the dialog fits the window, each event on a line of its own.
    await owner.setViewportSize({ width: 390, height: 844 });
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    const tops = await dialog.getByRole("checkbox").evaluateAll((boxes) => boxes.map((el) => el.getBoundingClientRect().top));
    expect(new Set(tops).size).toBe(7);
    await checkpoint(owner, "settings-webhook-added-phone", { fullPage: false });
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    expect(await owner.locator('[data-slot="pane-body"]').last().evaluate((body) => body.scrollWidth - body.clientWidth)).toBeLessThanOrEqual(0);
    expect(await owner.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await checkpoint(owner, "settings-webhooks-phone");
    await owner.setViewportSize({ width: 1280, height: 720 });
    await expect(owner.getByText("New post, New comment, Changelog published, Autopilot found updates, New conversation, New message from a user · no deliveries yet")).toBeVisible();
    await expect(owner.getByRole("heading", { name: "Webhooks 1" })).toBeVisible();
    // Opened again, the dialog is empty.
    await owner.getByRole("button", { name: "Add webhook" }).click();
    await expect(endpoint).toHaveValue("");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await owner.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // A row's actions are under its ⋯.
    await owner.getByRole("button", { name: `Actions for ${url}` }).click();
    await owner.getByRole("menuitem", { name: "Send test" }).click();
    await expect(owner.getByText("Test event sent")).toBeVisible();
    await expect(owner.getByText(/last delivered just now/)).toBeVisible();
    expect(events.map((e) => e.type)).toEqual(["ping"]);
    await checkpoint(owner, "settings-webhooks");

    await owner.getByRole("button", { name: `Actions for ${url}` }).click();
    await owner.getByRole("menuitem", { name: "Delete" }).click();
    await owner.getByRole("alertdialog", { name: "Delete this webhook?" }).getByRole("button", { name: "Delete webhook" }).click();
    await expect(owner.getByText("Webhook deleted")).toBeVisible();
    await expect(owner.getByText("No webhooks yet")).toBeVisible();
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});
