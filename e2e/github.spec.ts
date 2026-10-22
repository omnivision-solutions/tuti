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

  // The GitHub fake's authorize page sends the browser straight back, like GitHub once the app is authorized.
  await connectGithub(owner, web, account);
  // Connected, it's on GitHub's own settings page.
  await expect(owner.getByText("GitHub is connected.", { exact: false })).toBeVisible();
  await expect(owner.getByRole("heading", { name: "GitHub · acme-e2e" })).toBeVisible();
  await owner.getByRole("combobox", { name: "When linked posts become Completed" }).click();
  await owner.getByRole("option", { name: "their pull request is merged" }).click();
  await expect(owner.getByText("Saved")).toBeVisible();
  await owner.getByRole("checkbox", { name: /Comment on pull requests/ }).check();
  await expect(owner.getByText("Saved")).toHaveCount(2);
  await owner.reload();
  await expect(owner.getByRole("checkbox", { name: /Comment on pull requests/ })).toBeChecked();

  // The first project added both repositories; it lets the iOS app go.
  const ours = owner.getByRole("list", { name: "This project's repositories" });
  await expect(ours.getByRole("listitem")).toHaveText(["acme-e2e/app", "acme-e2e/ios"]);
  await owner.getByRole("button", { name: "Remove acme-e2e/ios" }).click();
  await expect(owner.getByText("acme-e2e/ios removed")).toBeVisible();
  await expect(ours.getByRole("listitem")).toHaveText(["acme-e2e/app"]);
  // Which repositories the app can see is the account's to choose, on GitHub.
  await expect(owner.getByRole("link", { name: "Manage access on GitHub" })).toHaveAttribute(
    "href",
    new RegExp(`/organizations/acme-e2e/settings/installations/${id}$`),
  );
  await checkpoint(owner, "settings-github-connected");

  // The second project picks the same account: it starts with none, and adds the iOS app.
  await connectGithub(owner, mobile, { ...account, add: [] });
  await expect(owner.getByText("No repository yet", { exact: false })).toBeVisible();
  await owner.getByRole("button", { name: "Add repository" }).click();
  const toAdd = owner.getByRole("list", { name: "Repositories to add" });
  await expect(toAdd.getByRole("button", { name: /acme-e2e\/app/ })).toBeDisabled();
  await expect(toAdd.getByText("In Acme", { exact: true })).toBeVisible();
  await owner.getByRole("textbox", { name: "Search repositories" }).fill("ios");
  await expect(toAdd.getByRole("button")).toHaveCount(1);
  await checkpoint(owner, "settings-github-add-repository", { fullPage: false });
  await toAdd.getByRole("button", { name: "acme-e2e/ios" }).click();
  await expect(owner.getByText("acme-e2e/ios added")).toBeVisible();
  await expect(owner.getByRole("list", { name: "This project's repositories" }).getByRole("listitem")).toHaveText(["acme-e2e/ios"]);
  await checkpoint(owner, "settings-github-repositories");

  // Refresh list asks GitHub again and comes back.
  await owner.getByRole("link", { name: "Refresh list" }).click();
  await owner.waitForURL(`**/app/${mobile}/settings/integrations/github?github=refreshed`);
  await expect(owner.getByText("Repositories refreshed.")).toBeVisible();
  await expect(owner.getByRole("list", { name: "This project's repositories" }).getByRole("listitem")).toHaveText(["acme-e2e/ios"]);

  // Integrations lists it as connected, with Manage.
  await owner.getByRole("link", { name: "Back to integrations" }).click();
  await expect(owner.getByRole("link", { name: /GitHub · acme-e2e.*Manage/ })).toBeVisible();
  await checkpoint(owner, "settings-integrations-connected");
  await owner.getByRole("link", { name: /GitHub · acme-e2e.*Manage/ }).click();
  await owner.getByRole("button", { name: "Disconnect" }).click();
  await expect(owner.getByText("GitHub disconnected")).toBeVisible();
  await expect(owner.getByRole("link", { name: "Connect GitHub" })).toBeVisible();
  await checkpoint(owner, "settings-integrations");
});
