import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { connectGithub, nextInstall } from "./github";
import { createProject, signUp } from "./helpers";

test("an admin connects two projects to one GitHub account, gives each its repositories, and disconnects", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const [web, mobile] = [`e2e-${randomUUID().slice(0, 8)}`, `e2e-${randomUUID().slice(0, 8)}`];
  const owner = await signUp(browser, APP_URL, "Olive Owner");
  await createProject(owner, "Acme", web);
  await createProject(owner, "Acme Mobile", mobile);
  const id = randomInt(1_000_000, 2_000_000_000);
  const account = { id, account: "acme-e2e", repositories: [{ id, fullName: "acme-e2e/app" }, { id: id + 1, fullName: "acme-e2e/ios" }] };

  // Before connecting, it says what leaves: merged pull requests' diffs, to the AI provider.
  await owner.goto(`/app/${web}/settings/integrations`);
  await expect(owner.getByText("Tuti also sends each one's diff, without secrets, to", { exact: false })).toBeVisible();
  // What's on the way is listed too, so a team sees it's coming.
  const soon = owner.getByRole("region", { name: "Coming soon" });
  await expect(soon.getByRole("heading", { level: 3 })).toHaveText(["GitLab", "Linear", "Jira", "Slack"]);
  await expect(soon.getByRole("listitem").getByText("Coming soon", { exact: true })).toHaveCount(4);
  await expect(soon.getByRole("link")).toHaveCount(0);
  await expect(soon.getByRole("button")).toHaveCount(0);
  await checkpoint(owner, "settings-integrations");
  // The GitHub fake's authorize page sends the browser straight back, like GitHub once the app is authorized.
  await connectGithub(owner, web, account);
  // Connected, it's on GitHub's own settings page.
  await expect(owner.getByText("GitHub is connected.", { exact: false })).toBeVisible();
  await expect(owner.getByRole("heading", { name: "GitHub · acme-e2e" })).toBeVisible();

  // The first project added both repositories; it lets the iOS app go.
  const ours = owner.getByRole("list", { name: "This project's repositories" });
  await expect(ours.getByRole("listitem")).toHaveText(["app", "ios"]);
  await owner.getByRole("button", { name: "Remove ios" }).click();
  await expect(owner.getByText("ios removed")).toBeVisible();
  await expect(ours.getByRole("listitem")).toHaveText(["app"]);
  // Which repositories the app can see is the account's to choose, on GitHub.
  await expect(owner.getByRole("link", { name: "Manage access on GitHub" })).toHaveAttribute(
    "href",
    new RegExp(`/organizations/acme-e2e/settings/installations/${id}$`),
  );
  await checkpoint(owner, "settings-github-connected");

  // Autopilot is on, and its owner can turn it off (and on again), in Settings → Autopilot (GitHub's page points there).
  await owner.getByRole("link", { name: "Settings → Autopilot" }).click();
  await owner.waitForURL("**/settings/autopilot");
  await expect(owner.getByText("Nothing has gone out yet.", { exact: false })).toBeVisible();
  const analysis = owner.getByRole("switch", { name: "Analyse merged pull requests" });
  await expect(analysis).toBeChecked();
  await analysis.click();
  await expect(owner.getByText("Autopilot off")).toBeVisible();
  await owner.reload();
  await expect(analysis).not.toBeChecked();
  await analysis.click();
  await expect(owner.getByText("Autopilot on")).toBeVisible();
  // Applying by itself is opt-in, and only for links.
  const autoLinks = owner.getByRole("switch", { name: "Link posts by itself" });
  await expect(autoLinks).not.toBeChecked();
  await autoLinks.click();
  await expect(owner.getByText("Autopilot links posts by itself")).toBeVisible();

  // The second project picks the same account: it starts with none, and adds the iOS app.
  await connectGithub(owner, mobile, { ...account, add: [] });
  await expect(owner.getByText("No repository yet", { exact: false })).toBeVisible();
  await owner.getByRole("button", { name: "Add repository" }).click();
  const toAdd = owner.getByRole("list", { name: "Repositories to add" });
  await expect(toAdd.getByRole("button", { name: /^app/ })).toBeDisabled();
  await expect(toAdd.getByText("In Acme", { exact: true })).toBeVisible();
  await owner.getByRole("textbox", { name: "Search repositories" }).fill("ios");
  await expect(toAdd.getByRole("button")).toHaveCount(1);
  await checkpoint(owner, "settings-github-add-repository", { fullPage: false });
  await toAdd.getByRole("button", { name: "ios" }).click();
  await expect(owner.getByText("ios added")).toBeVisible();
  await expect(owner.getByRole("list", { name: "This project's repositories" }).getByRole("listitem")).toHaveText(["ios"]);
  await checkpoint(owner, "settings-github-repositories");

  // Refresh list reads GitHub again, on the page.
  const url = owner.url();
  await owner.getByRole("button", { name: "Refresh list" }).click();
  await expect(owner.getByText("List refreshed: 2 repositories")).toBeVisible();
  expect(owner.url()).toBe(url);
  await expect(owner.getByRole("list", { name: "This project's repositories" }).getByRole("listitem")).toHaveText(["ios"]);

  // Integrations lists it as connected, with Manage.
  await owner.getByRole("link", { name: "Back to integrations" }).click();
  await expect(owner.getByRole("link", { name: /GitHub · acme-e2e.*Manage/ })).toBeVisible();
  await checkpoint(owner, "settings-integrations-connected");
  await owner.getByRole("link", { name: /GitHub · acme-e2e.*Manage/ }).click();
  await owner.waitForURL(`**/app/${mobile}/settings/integrations/github`);
  await expect(owner.getByRole("heading", { name: "GitHub · acme-e2e" })).toBeVisible();

  // Switch account: the mobile app moves to the team's other organization, and starts with none of its repositories.
  const labs = { id: id + 2, account: "acme-labs-e2e", repositories: [{ id: id + 2, fullName: "acme-labs-e2e/ios" }] };
  await nextInstall(owner, labs);
  await owner.getByRole("link", { name: "Switch account" }).click();
  await owner.waitForURL(`**/app/${mobile}/settings/integrations/github?github=choose`);
  await expect(owner.getByText("This project's repositories from @acme-e2e are removed", { exact: false })).toBeVisible();
  await checkpoint(owner, "settings-github-switch-account");
  await owner.getByRole("link", { name: "Connect @acme-labs-e2e" }).click();
  await owner.waitForURL(`**/app/${mobile}/settings/integrations/github?github=connected`);
  await expect(owner.getByRole("heading", { name: "GitHub · acme-labs-e2e" })).toBeVisible();
  await expect(owner.getByText("No repository yet", { exact: false })).toBeVisible();
  const history = await owner.evaluate(() => window.history.length);
  await owner.getByRole("button", { name: "Disconnect" }).click();
  const confirm = owner.getByRole("alertdialog", { name: "Disconnect GitHub?" });
  await checkpoint(owner, "settings-github-disconnect", { fullPage: false });
  await confirm.getByRole("button", { name: "Disconnect" }).click();
  await expect(owner.getByText("GitHub disconnected")).toBeVisible();
  // GitHub's page doesn't stay in the history: Back doesn't go to a page that's gone.
  expect(await owner.evaluate(() => window.history.length)).toBe(history);
  await expect(owner.getByRole("link", { name: "Connect GitHub" })).toBeVisible();
  await checkpoint(owner, "settings-integrations");
});
