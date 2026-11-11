import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";
import pg from "pg";

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
  await expect(ours.getByRole("listitem")).toHaveText(["acme-e2e/app", "acme-e2e/ios"]);
  await owner.getByRole("button", { name: "Remove acme-e2e/ios" }).click();
  await expect(owner.getByText("acme-e2e/ios removed")).toBeVisible();
  await expect(ours.getByRole("listitem")).toHaveText(["acme-e2e/app"]);
  // Which repositories the app can see is the account's to choose, on GitHub.
  await expect(owner.getByRole("link", { name: "Manage access on GitHub" })).toHaveAttribute(
    "href",
    new RegExp(`/organizations/acme-e2e/settings/installations/${id}$`),
  );
  await expect(owner.getByText("and Autopilot reads them for the posts they complete", { exact: false })).toBeVisible();
  await checkpoint(owner, "settings-github-connected");
  // On a phone the header keeps its words whole: the buttons go under the name and when it connected, each on a line.
  await owner.setViewportSize({ width: 390, height: 844 });
  const uncut = (element: HTMLElement) => element.scrollWidth <= element.clientWidth;
  await expect.poll(() => owner.getByRole("heading", { name: "GitHub · acme-e2e" }).evaluate(uncut)).toBe(true);
  expect((await owner.getByText(/^Connected /).boundingBox())!.height).toBeLessThan(30);
  await checkpoint(owner, "settings-github-connected-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });

  // Autopilot is on, and its owner can turn it off (and on again), in Settings → Autopilot (GitHub's page points there).
  await owner.getByRole("link", { name: "Settings → Autopilot" }).click();
  await owner.waitForURL("**/settings/autopilot");
  await expect(owner.getByText("Nothing has gone out yet.", { exact: false })).toBeVisible();
  await checkpoint(owner, "settings-autopilot");
  const analysis = owner.getByRole("switch", { name: "Analyse merged pull requests" });
  await expect(analysis).toBeChecked();
  // What it sends: the docs agent reads the repository and the help center on every merged pull request.
  await expect(owner.getByText("the repository files Autopilot reads at its merge commit and your help center's articles and drafts", { exact: false })).toBeVisible();
  await analysis.click();
  await expect(owner.getByText("Autopilot off")).toBeVisible();
  await owner.reload();
  await expect(analysis).not.toBeChecked();
  // GitHub's Repositories say Autopilot reads them only while it does.
  await owner.goto(`/app/${web}/settings/integrations/github`);
  await expect(owner.getByText("gather in the changelog's Next release draft. Each repository", { exact: false })).toBeVisible();
  // Off, Autopilot's page says so, and takes its owner to the switch.
  await owner.goto(`/app/${web}/autopilot`);
  await expect(owner.getByText("Autopilot is off for this project. Turn it on in its settings.")).toBeVisible();
  await owner.getByRole("link", { name: "Autopilot settings" }).click();
  await owner.waitForURL("**/settings/autopilot");
  await analysis.click();
  await expect(owner.getByText("Autopilot on")).toBeVisible();
  // It doesn't promise that nothing changes until the team approves: some updates go out by themselves.
  await expect(owner.getByText(/until your team approves/)).toHaveCount(0);
  // Linking by itself is on for a new project; its owner can turn it off.
  const autoLinks = owner.getByRole("switch", { name: "Link posts by itself" });
  await expect(autoLinks).toBeChecked();
  await expect(owner.getByText("Off, Autopilot makes no links.", { exact: false })).toBeVisible();
  await autoLinks.click();
  await expect(owner.getByText("Autopilot doesn't link posts")).toBeVisible();
  // The page saves one way: switches and ticks as they change, the numbers (what always waits, and the hold) with its one Save.
  await expect(owner.getByRole("switch", { name: "Complete posts" })).not.toBeChecked();
  await owner.getByRole("switch", { name: "Complete posts" }).click();
  await expect(owner.getByText("Complete posts: on")).toBeVisible();
  await owner.getByLabel("The hold (hours)").fill("12");
  await owner.getByRole("button", { name: "Save", exact: true }).click();
  await expect(owner.getByText("Autopilot's settings saved")).toBeVisible();
  // Who's told: owners always; the owner adds admins.
  await owner.getByLabel("Admins too").check();
  await expect(owner.getByText("Who's told saved")).toBeVisible();
  await expect(owner.getByRole("button", { name: /^Save/ })).toHaveCount(1);
  await owner.reload();
  await expect(owner.getByRole("switch", { name: "Complete posts" })).toBeChecked();
  await expect(owner.getByLabel("The hold (hours)")).toHaveValue("12");
  await expect(owner.getByLabel("Admins too")).toBeChecked();
  await checkpoint(owner, "settings-autopilot");
  // A refused save shows what's saved: here the owner stops being one (their row only), and Complete posts comes back on.
  const db = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await db.connect();
  const { rows: demoted } = await db.query<{ id: string }>(
    `UPDATE team_member SET role = 'ADMIN' WHERE "projectId" = (SELECT id FROM project WHERE slug = $1) AND role = 'OWNER' RETURNING id`,
    [web],
  );
  expect(demoted).toHaveLength(1);
  const setRole = (role: string) => db.query(`UPDATE team_member SET role = $2 WHERE id = $1`, [demoted[0]!.id, role]);
  const complete = owner.getByRole("switch", { name: "Complete posts" });
  const sidebar = owner.locator('[data-slot="sidebar"][data-state]');
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await complete.click();
  await expect(owner.getByText("Only project owners can change Autopilot's settings")).toBeVisible();
  await expect(owner.getByText("Only project owners can change Autopilot's settings")).toBeInViewport();
  await expect(sidebar).toHaveAttribute("data-state", "collapsed");
  await expect(complete).toBeChecked();
  // The page they're on still lets them flip (it was loaded while they owned the project).
  await setRole("OWNER");
  await owner.reload();
  await expect(complete).toBeEnabled();
  await setRole("ADMIN");
  // A refusal that answers after the switch was flipped again leaves it be: flipped off (refused, its answer held until
  // the owner is one again), on and off (both saved), it ends off, as saved.
  let releaseSave!: () => void;
  const saveHeld = new Promise<void>((resolve) => (releaseSave = resolve));
  let sent = 0;
  let answered = 0;
  await owner.route("**/*", async (route) => {
    if (!route.request().headers()["next-action"]) {
      return route.fallback();
    }
    sent += 1;
    if (sent === 1) {
      await saveHeld;
    } else if (sent === 2) {
      await setRole("OWNER");
    }
    await route.fallback();
  });
  owner.on("response", (response) => {
    if (response.request().headers()["next-action"]) {
      answered += 1;
    }
  });
  for (let i = 0; i < 3; i++) {
    await complete.click();
  }
  releaseSave();
  await expect.poll(() => answered).toBe(3);
  await expect(complete).not.toBeChecked();
  await owner.unrouteAll({ behavior: "ignoreErrors" });
  await owner.reload();
  await expect(complete).not.toBeChecked();
  // Each person picks when they hear: a daily digest, in the morning where their browser says they are.
  await owner.goto("/app/account");
  await owner.getByLabel("A daily digest").check();
  await expect(owner.getByText("Saved", { exact: true })).toBeVisible();
  await owner.reload();
  await expect(owner.getByLabel("A daily digest")).toBeChecked();
  // Moved since: picking the digest again saves where their browser says they are now.
  const moved = await (
    await browser.newContext({ baseURL: APP_URL, storageState: await owner.context().storageState(), timezoneId: "Pacific/Chatham" })
  ).newPage();
  await moved.goto("/app/account");
  // The page says which time zone it's saved in, and that picking it again moves it.
  await expect(moved.getByText(/Pick it again to use Pacific\/Chatham\.$/)).toBeVisible();
  await moved.getByLabel("A daily digest").click();
  await expect(moved.getByText("Saved", { exact: true })).toBeVisible();
  await expect(moved.getByText(/One email at 8 am \(Pacific\/Chatham\)/)).toBeVisible();
  await expect(moved.getByText(/Pick it again/)).toHaveCount(0);
  // The first tab, still open: refreshed (saving the profile), it shows the zone saved elsewhere, and offers its own.
  await owner.getByRole("button", { name: "Save", exact: true }).click();
  await expect(owner.getByText("Profile updated")).toBeVisible();
  await expect(owner.getByText(/One email at 8 am \(Pacific\/Chatham\)/)).toBeVisible();
  await expect(owner.getByText(/Pick it again to use /)).toBeVisible();
  const { rows: zone } = await db.query<{ autopilotTimeZone: string }>(`SELECT "autopilotTimeZone" FROM "user" WHERE email = $1`, [owner.email]);
  expect(zone[0]!.autopilotTimeZone).toBe("Pacific/Chatham");
  await moved.context().close();
  await db.end();
  await owner.goto(`/app/${web}/settings/integrations/github`);

  // The second project picks the same account: it starts with none, and adds the iOS app.
  await connectGithub(owner, mobile, { ...account, add: [] });
  await expect(owner.getByText("No repository yet", { exact: false })).toBeVisible();
  await owner.getByRole("button", { name: "Add repository" }).click();
  const toAdd = owner.getByRole("list", { name: "Repositories to add" });
  await expect(toAdd.getByRole("button", { name: /^acme-e2e\/app/ })).toBeDisabled();
  await expect(toAdd.getByText("In Acme", { exact: true })).toBeVisible();
  await owner.getByRole("textbox", { name: "Search repositories" }).fill("ios");
  await expect(toAdd.getByRole("button")).toHaveCount(1);
  await checkpoint(owner, "settings-github-add-repository", { fullPage: false });
  await toAdd.getByRole("button", { name: "ios" }).click();
  await expect(owner.getByText("acme-e2e/ios added")).toBeVisible();
  await expect(owner.getByRole("list", { name: "This project's repositories" }).getByRole("listitem")).toHaveText(["acme-e2e/ios"]);
  await checkpoint(owner, "settings-github-repositories");

  // Refresh list reads GitHub again, on the page.
  const url = owner.url();
  await owner.getByRole("button", { name: "Refresh list" }).click();
  await expect(owner.getByText("List refreshed: 2 repositories")).toBeVisible();
  expect(owner.url()).toBe(url);
  await expect(owner.getByRole("list", { name: "This project's repositories" }).getByRole("listitem")).toHaveText(["acme-e2e/ios"]);
  // A repository given access since is listed once they reconnect (GitHub says they can access it).
  await nextInstall(owner, { ...account, repositories: [...account.repositories, { id: id + 3, fullName: "acme-e2e/docs" }] });
  await owner.getByRole("link", { name: "Reconnect" }).click();
  await owner.waitForURL(`**/app/${mobile}/settings/integrations/github?github=connected`);
  await expect(owner.getByRole("list", { name: "This project's repositories" }).getByRole("listitem")).toHaveText(["acme-e2e/ios"]);
  await owner.getByRole("button", { name: "Add repository" }).click();
  await expect(owner.getByRole("list", { name: "Repositories to add" }).getByRole("button", { name: "acme-e2e/docs", exact: true })).toBeEnabled();
  await owner.keyboard.press("Escape");

  // Integrations lists it as connected, with Manage.
  await owner.getByRole("link", { name: "Back to integrations" }).click();
  await expect(owner.getByRole("link", { name: /GitHub · acme-e2e.*Manage/ })).toBeVisible();
  await checkpoint(owner, "settings-integrations-connected");
  await owner.getByRole("link", { name: /GitHub · acme-e2e.*Manage/ }).click();
  await owner.waitForURL(`**/app/${mobile}/settings/integrations/github`);
  await expect(owner.getByRole("heading", { name: "GitHub · acme-e2e" })).toBeVisible();

  // Switch account: the mobile app moves to the team's other organization, and starts with none of its repositories.
  // Its login as long as GitHub allows (39 characters), letters and digits only: nowhere to break a line but anywhere.
  const labs = { id: id + 2, account: "acmelabse2eplatformandinfrastructure123", repositories: [{ id: id + 2, fullName: "acmelabse2eplatformandinfrastructure123/ios" }] };
  await nextInstall(owner, labs);
  await owner.getByRole("link", { name: "Switch account" }).click();
  await owner.waitForURL(`**/app/${mobile}/settings/integrations/github?github=choose`);
  await expect(owner.getByText("This project's repositories from @acme-e2e are removed", { exact: false })).toBeVisible();
  await checkpoint(owner, "settings-github-switch-account");
  await owner.getByRole("link", { name: `Connect @${labs.account}` }).click();
  await owner.waitForURL(`**/app/${mobile}/settings/integrations/github?github=connected`);
  await expect(owner.getByRole("heading", { name: `GitHub · ${labs.account}` })).toBeVisible();
  // On a phone the long name wraps, never cut.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => owner.getByRole("heading", { name: `GitHub · ${labs.account}` }).evaluate(uncut)).toBe(true);
  await checkpoint(owner, "settings-github-long-name-phone");
  await owner.setViewportSize({ width: 1280, height: 720 });
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
