import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { setAnalysis } from "./autopilot";
import { checkpoints } from "./checkpoint";
import { query } from "./db";
import { APP_URL } from "./env";
import { connectGithub, mergePullRequest, repositoryFiles } from "./github";
import { apiFor, createProject, signUp } from "./helpers";

/** An OpenAPI spec: each operation as "GET /posts" with its tag and summary. */
function spec(operations: Record<string, [tag: string, summary: string]>) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, [tag, summary]] of Object.entries(operations)) {
    const [method, path] = key.split(" ") as [string, string];
    (paths[path] ??= {})[method.toLowerCase()] = { tags: [tag], summary, responses: { 200: { description: "OK" } } };
  }
  return JSON.stringify({ openapi: "3.1.0", info: { title: "Acme API", version: "1" }, paths });
}

const POSTS = spec({ "GET /posts": ["Posts", "List posts"], "POST /posts": ["Posts", "Create a post"] });
const WITH_USERS = spec({ "GET /posts": ["Posts", "List posts"], "POST /posts": ["Posts", "Create a post"], "GET /users": ["Users", "List users"] });

test("An API reference read from GitHub: added from a repository's file, synced when a pull request changing it merges, and a broken file says so", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  // A repository of this journey's own on GitHub (the fake), added to the project as Autopilot's journeys add theirs.
  const id = randomInt(1_000_000, 2_000_000_000);
  const repo = `acme/${slug}`;
  await repositoryFiles(repo, { "api/openapi.json": POSTS, "src/app.ts": "" });
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/tabs", { name: "Developers" });
  await team.setViewportSize({ width: 1280, height: 900 });
  const dialog = team.getByRole("dialog", { name: "Add API reference" });
  /** The add dialog's GitHub panel, from the docs, its repositories read. */
  const openGithubPanel = async () => {
    await team.goto(`/app/${slug}/docs`);
    await team.getByRole("navigation", { name: "Docs", exact: true }).getByRole("button", { name: "Add to your docs" }).click();
    await team.getByRole("menuitem", { name: "API reference" }).click();
    await dialog.getByText("From GitHub", { exact: true }).click();
    await expect(dialog.locator("form")).not.toHaveAttribute("data-reading");
  };

  // No repository yet: an admin is linked to where they're added; a member, who can't open that page, is told to ask.
  await openGithubPanel();
  await expect(dialog.getByRole("link", { name: "Add a repository" })).toHaveAttribute("href", `/app/${slug}/settings/integrations/github`);
  const setRole = (role: string) => query(`UPDATE team_member SET role = $2 WHERE "projectId" = (SELECT id FROM project WHERE slug = $1)`, [slug, role]);
  await setRole("MEMBER");
  await openGithubPanel();
  await expect(dialog.getByText("This project has no GitHub repositories yet. Ask an admin to connect a GitHub repository.")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Add a repository" })).toHaveCount(0);
  await checkpoint(team, "the GitHub panel for a member, with no repository yet", { fullPage: false });
  await setRole("OWNER");

  await connectGithub(team, slug, { id, repositories: [{ id, fullName: repo }] });
  // Merges here are about the reference: Autopilot, which would read them too, is off.
  await setAnalysis(slug, false);
  await openGithubPanel();
  await expect(dialog.getByRole("radio", { name: /From GitHub/ })).toBeChecked();
  // The project's repositories, listed once read (the form says while they're on their way).
  await expect(dialog.locator("form")).not.toHaveAttribute("data-reading");
  await expect(dialog.getByRole("combobox", { name: "Repository" })).toContainText(repo);
  const file = dialog.getByLabel("File in the repository");
  const branch = dialog.getByLabel("Branch");
  const add = dialog.getByRole("button", { name: "Add reference" });

  // A file that isn't there is refused at Fetch, under its field, naming the default branch it looked on.
  await file.fill("api/missing.json");
  await dialog.getByRole("button", { name: "Fetch" }).click();
  await expect(dialog.getByText(`There's no file at api/missing.json on main in ${repo}.`)).toBeVisible();
  await expect(add).toBeDisabled();
  // The right one: read, named, and the branch it read filled in.
  await file.fill("api/openapi.json");
  await file.press("Enter");
  await expect(dialog.getByLabel("Name")).toHaveValue("Acme API");
  await expect(branch).toHaveValue("main");
  await expect(dialog.getByText("Read. It’s read again when a pull request into this branch merges.")).toBeVisible();
  await checkpoint(team, "the dialog's GitHub panel, fetched", { fullPage: false });
  await add.click();

  await expect(team).toHaveURL(new RegExp(`/app/${slug}/docs/references/acme-api$`));
  await expect(team.getByRole("heading", { name: "Acme API", level: 1 })).toBeVisible();
  await expect(team.getByText("2 of 2 on the help center", { exact: true })).toBeVisible();
  await expect(team.getByRole("button", { name: "Sync now" })).toBeVisible();

  // A pull request changing other files merges: nothing to read. One changing the spec merges: its new operation is New.
  await mergePullRequest(id, { repo, number: 1, title: "Tidy the app", files: [{ filename: "src/app.ts" }] });
  await repositoryFiles(repo, { "api/openapi.json": WITH_USERS, "src/app.ts": "" });
  await mergePullRequest(id, { repo, number: 2, title: "List users", files: [{ filename: "api/openapi.json" }] });
  await team.reload();
  await expect(team.getByText("3 of 3 on the help center", { exact: true })).toBeVisible();
  const users = team.getByRole("region", { name: "Users", exact: true });
  await expect(users.getByRole("listitem").filter({ hasText: "List users" })).toContainText("New");

  // A pull request moves the spec away: the sync fails, and the page says why and keeps the reference as it was.
  await repositoryFiles(repo, { "api/v2/openapi.json": WITH_USERS, "src/app.ts": "" });
  await mergePullRequest(id, { repo, number: 3, title: "Move the spec", files: [{ filename: "api/v2/openapi.json" }, { filename: "api/openapi.json" }] });
  await team.reload();
  const missing = `There's no file at api/openapi.json on main in ${repo}.`;
  const banner = team.getByRole("status").filter({ hasText: "Sync failed." });
  await expect(banner).toContainText(missing);
  await expect(team.getByText("3 of 3 on the help center", { exact: true })).toBeVisible();
  await checkpoint(team, "a GitHub reference's failed sync");

  // Settings' Source: the repository, file and branch, how its syncs went, and the file changed there.
  await team.getByRole("navigation", { name: "API reference" }).getByRole("link", { name: "Settings" }).click();
  await team.waitForURL(`**/docs/references/acme-api/settings`);
  const source = team.getByRole("region", { name: "Source" });
  await expect(source).toContainText("GitHub");
  await expect(source).toContainText(repo);
  await expect(source).toContainText("Last tried");
  await expect(source).toContainText(missing);
  const path = source.getByLabel("File in the repository");
  await expect(path).toHaveValue("api/openapi.json");
  await expect(source.getByLabel("Branch")).toHaveValue("main");
  // A branch that isn't there is refused under the fields, and the reference stays where it was.
  await path.fill("api/v2/openapi.json");
  await source.getByLabel("Branch").fill("release");
  await source.getByRole("button", { name: "Change" }).click();
  await expect(source.getByText(`${repo} has no branch “release”.`)).toBeVisible();
  await expect(path).toBeFocused();
  // The file where it moved, on main: read in, and the banner's error is gone.
  await source.getByLabel("Branch").fill("main");
  await source.getByRole("button", { name: "Change" }).click();
  await expect(team.getByText("File changed", { exact: true })).toBeVisible();
  await expect(source).not.toContainText(missing);
  await expect(source.getByRole("button", { name: "Change" })).toBeDisabled();
  await checkpoint(team, "Settings' Source for GitHub");

  // A teammate moves the file (through the API) while this page is open, showing the path it had. Change on the branch
  // alone sends the branch alone: the teammate's path stays, never this page's old copy of it. (The new branch has only
  // their file, so this page's path wouldn't read there.)
  await repositoryFiles(repo, { "api/v3/openapi.json": WITH_USERS });
  await api("/api-references/acme-api/sync", { github: { path: "api/v3/openapi.json" } });
  await repositoryFiles(repo, { "api/v3/openapi.json": WITH_USERS }, "release");
  await expect(path).toHaveValue("api/v2/openapi.json");
  await source.getByLabel("Branch").fill("release");
  await source.getByRole("button", { name: "Change" }).click();
  await expect(source.getByLabel("Branch")).toHaveValue("release");
  await expect(source.getByRole("button", { name: "Change" })).toBeDisabled();
  await expect(path).toHaveValue("api/v3/openapi.json");
  await expect(source).not.toContainText("There's no file");
});
