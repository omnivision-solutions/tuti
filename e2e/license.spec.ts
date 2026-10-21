import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";

test("someone buying a licence sees which installation and project it's for, and how to buy it", async ({ page }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  // Where "Get a licence" in Settings → Branding goes, on tuti.so.
  await page.goto(`${APP_URL}/license?installation=e2e-installation&project=e2e-project`);
  await expect(page.getByRole("heading", { name: 'Remove "Powered by tuti"' })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "e2e-installation" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "e2e-project" })).toBeVisible();
  const email = page.getByRole("link", { name: "Email hello@tuti.so" });
  const mailto = new URL((await email.getAttribute("href"))!);
  expect(mailto.protocol + mailto.pathname).toBe("mailto:hello@tuti.so");
  expect(mailto.searchParams.get("body")).toContain("Installation ID: e2e-installation\nProject ID: e2e-project");
  await checkpoint(page, "license-page");

  // Without the ids, it says where to start.
  await page.goto(`${APP_URL}/license?installation=e2e-installation`);
  await expect(page.getByText("Open this page from your Tuti")).toBeVisible();
});
