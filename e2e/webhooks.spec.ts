import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";

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
    await owner.goto(`/app/${slug}/settings`);
    await expect(owner.getByText("No webhooks yet")).toBeVisible();

    await owner.getByRole("textbox", { name: "Endpoint URL" }).fill(url);
    await owner.getByRole("checkbox", { name: /Status changed/ }).uncheck();
    await owner.getByRole("button", { name: "Add webhook" }).click();
    const secret = owner.getByRole("alert").filter({ hasText: "Copy the signing secret now" }).locator("code");
    await expect(secret).toHaveText(/^whsec_/);
    await expect(owner.getByText("New post, New comment, Changelog published · no deliveries yet")).toBeVisible();

    await owner.getByRole("button", { name: "Send test" }).click();
    await expect(owner.getByText("Test event sent")).toBeVisible();
    await expect(owner.getByText(/last delivered just now/)).toBeVisible();
    expect(events.map((e) => e.type)).toEqual(["ping"]);
    await checkpoint(owner, "settings-webhooks");

    await owner.getByRole("button", { name: "Delete", exact: true }).click();
    await owner.getByRole("alertdialog", { name: "Delete this webhook?" }).getByRole("button", { name: "Delete webhook" }).click();
    await expect(owner.getByText("Webhook deleted")).toBeVisible();
    await expect(owner.getByText("No webhooks yet")).toBeVisible();
  } finally {
    await new Promise((resolve) => receiver.close(resolve));
  }
});
