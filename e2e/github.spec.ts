import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { createProject, signUp } from "./helpers";

test("an admin connects the project to GitHub and disconnects it", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", slug);

  await owner.goto(`/app/${slug}/settings/integrations`);
  // The GitHub fake's install page sends the browser straight back, like GitHub after "Install".
  await owner.getByRole("link", { name: "Connect GitHub" }).click();
  await owner.waitForURL(`**/app/${slug}/settings/integrations?github=connected`);
  await expect(owner.getByText("GitHub is connected.")).toBeVisible();
  await expect(owner.getByText("Connected to @acme-e2e.")).toBeVisible();
  await owner.getByRole("combobox", { name: "When linked posts become Completed" }).click();
  await owner.getByRole("option", { name: "their pull request is merged" }).click();
  await expect(owner.getByText("Saved")).toBeVisible();
  await owner.getByRole("checkbox", { name: /Comment on pull requests/ }).check();
  await expect(owner.getByText("Saved")).toHaveCount(2);
  await checkpoint(owner, "settings-github-connected", { fullPage: false });
  await owner.reload();
  await expect(owner.getByRole("checkbox", { name: /Comment on pull requests/ })).toBeChecked();

  await owner.getByRole("button", { name: "Disconnect" }).click();
  await expect(owner.getByText("GitHub disconnected")).toBeVisible();
  await expect(owner.getByRole("link", { name: "Connect GitHub" })).toBeVisible();
});
