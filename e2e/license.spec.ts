import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";

test("someone buying a licence sees which installation and project it's for, and buys it with Stripe", async ({ page }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const installation = `e2e-installation-${randomUUID().slice(0, 8)}`;
  const project = `e2e-project-${randomUUID().slice(0, 8)}`;
  // Where "Get a licence" in Customize → Powered by goes, on tuti.so.
  await page.goto(`${APP_URL}/license?installation=${installation}&project=${project}`);
  await expect(page.getByRole("heading", { name: 'Remove "Powered by tuti"' })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: installation })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: project })).toBeVisible();
  await checkpoint(page, "license-page");

  // Stripe's page (the fake), then back, licensed: the installation's next check gets its key.
  await page.getByRole("button", { name: "Buy for $49 a month" }).click();
  await page.getByRole("button", { name: "Subscribe" }).click();
  await page.waitForURL(/\/license\?.*paid=1/);
  await expect(page.getByRole("status")).toContainText("This project is licensed.");
  await expect(page.getByRole("status")).toContainText("To cancel it, change the card or get invoices, email hello@tuti.so.");
  await expect(page.getByRole("button", { name: "Buy for $49 a month" })).toBeHidden();
  await checkpoint(page, "license-page-licensed");

  // Without the ids, it says where to start.
  await page.goto(`${APP_URL}/license?installation=${installation}`);
  await expect(page.getByText("Open this page from your Tuti")).toBeVisible();
});
