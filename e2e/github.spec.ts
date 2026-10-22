import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { connectGithub } from "./github";
import { createProject, signUp } from "./helpers";

test("an admin connects two projects to one GitHub account, gives each its repositories, and disconnects", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const [web, mobile] = [`e2e-${randomUUID().slice(0, 8)}`, `e2e-${randomUUID().slice(0, 8)}`];
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", web);
  await createProject(owner, "Acme Mobile", mobile);
  const id = randomInt(1_000_000, 2_000_000_000);
  const account = { id, account: "acme-e2e", repositories: [{ id, fullName: "acme-e2e/app" }, { id: id + 1, fullName: "acme-e2e/ios" }] };

  // The GitHub fake's install and authorize pages send the browser straight back, like GitHub.
  await connectGithub(owner, web, account);
  await expect(owner.getByText("GitHub is connected.")).toBeVisible();
  await expect(owner.getByText("Connected to @acme-e2e.")).toBeVisible();
  await owner.getByRole("combobox", { name: "When linked posts become Completed" }).click();
  await owner.getByRole("option", { name: "their pull request is merged" }).click();
  await expect(owner.getByText("Saved")).toBeVisible();
  await owner.getByRole("checkbox", { name: /Comment on pull requests/ }).check();
  await expect(owner.getByText("Saved")).toHaveCount(2);
  await owner.reload();
  await expect(owner.getByRole("checkbox", { name: /Comment on pull requests/ })).toBeChecked();

  // The first project on the account takes its repositories; this one lets the iOS app go.
  await expect(owner.getByText("2 of 2")).toBeVisible();
  await expect(owner.getByRole("switch", { name: "Include new repositories" })).toBeChecked();
  await owner.getByRole("switch", { name: "Include acme-e2e/ios" }).uncheck();
  await expect(owner.getByText("acme-e2e/ios left out")).toBeVisible();
  await expect(owner.getByText("1 of 2")).toBeVisible();
  await checkpoint(owner, "settings-github-connected");

  // The second project connects the same account: it starts with none, and takes the iOS app.
  await connectGithub(owner, mobile, account);
  await expect(owner.getByText("0 of 2")).toBeVisible();
  await expect(owner.getByText("No repository is included", { exact: false })).toBeVisible();
  await expect(owner.getByRole("switch", { name: "Include acme-e2e/app" })).toBeDisabled();
  await expect(owner.getByText("In Acme", { exact: true })).toBeVisible();
  await expect(owner.getByRole("switch", { name: "Include new repositories" })).toBeDisabled();
  await expect(owner.getByText("New repositories from @acme-e2e go to Acme.")).toBeVisible();
  await owner.getByRole("switch", { name: "Include acme-e2e/ios" }).check();
  await expect(owner.getByText("acme-e2e/ios included")).toBeVisible();
  await expect(owner.getByText("1 of 2")).toBeVisible();
  await checkpoint(owner, "settings-github-repositories");

  // Refresh asks GitHub again and comes back.
  await owner.getByRole("link", { name: "Refresh" }).click();
  await owner.waitForURL(`**/app/${mobile}/settings/integrations?github=refreshed`);
  await expect(owner.getByText("Repositories refreshed.")).toBeVisible();
  await expect(owner.getByRole("switch", { name: "Include acme-e2e/ios" })).toBeChecked();

  await owner.getByRole("button", { name: "Disconnect" }).click();
  await expect(owner.getByText("GitHub disconnected")).toBeVisible();
  await expect(owner.getByRole("link", { name: "Connect GitHub" })).toBeVisible();
});
