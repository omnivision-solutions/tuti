import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { apiFor, createProject, signUp } from "./helpers";

const file = (name: string, text: string) => ({ name, mimeType: "application/yaml", buffer: Buffer.from(text) });
const SPEC = `openapi: 3.1.0
info:
  title: Acme API
  version: "1"
paths:
  /posts:
    get:
      summary: List posts
    post:
      summary: Create a post
`;

// A spec of about 2 MB: more than a server action takes by default.
const LARGE_SPEC = `${SPEC}      description: ${"Every post. ".repeat(170_000)}\n`;

test("the team adds an API reference from a spec file: its name from the spec, a file that isn't one refused, its row in its tab's tree and on its tab's page", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const slug = `e2e-${randomUUID().slice(0, 8)}`;
  const team = await signUp(browser, APP_URL, "Tess Team");
  await createProject(team, "Acme", slug);
  const api = await apiFor(team, slug);
  await api("/tabs", { name: "Guides" });
  await api("/tabs", { name: "Developers" });
  await api("/tabs", { name: "Scratch" });
  await team.setViewportSize({ width: 1280, height: 900 });
  // Without live updates: a tab is deleted below while the dialog is open, and the page mustn't hear of it before Add does.
  await team.route("**/api/live*", (route) => route.abort());
  // On the second tab's page: the tree shows that tab.
  await team.goto(`/app/${slug}/docs/tabs/developers`);
  const tree = team.getByRole("navigation", { name: "Docs", exact: true });
  const content = team.getByRole("region", { name: "Content" });
  await expect(content.getByText("Nothing in this tab yet")).toBeVisible();

  // From the tree's "+", beside a new collection.
  await tree.getByRole("button", { name: "Add to your docs" }).click();
  await team.getByRole("menuitem", { name: "API reference" }).click();
  const dialog = team.getByRole("dialog", { name: "Add API reference" });
  const add = dialog.getByRole("button", { name: "Add reference" });
  await expect(dialog.getByText("OpenAPI 3.0 or 3.1 (JSON or YAML), or a GraphQL schema")).toBeVisible();
  // Nothing to add until there's a spec.
  await expect(add).toBeDisabled();

  // A file that isn't a spec is refused as it's chosen, in the reader's words.
  await dialog.getByLabel("Spec file").setInputFiles(file("package.json", JSON.stringify({ name: "package" })));
  await expect(dialog.getByText(/^This isn't an OpenAPI spec: it has no `openapi` version\./)).toBeVisible();
  await expect(add).toBeDisabled();
  await expect(dialog.getByLabel("Name")).toHaveValue("");
  await checkpoint(team, "api-reference-dialog-not-a-spec", { fullPage: false });
  // Typing a name doesn't hide why.
  await dialog.getByLabel("Name").fill("Public API");
  await expect(dialog.getByText(/^This isn't an OpenAPI spec/)).toBeVisible();
  await expect(add).toBeDisabled();
  await dialog.getByLabel("Name").fill("");

  // So is one over 5 MB, in the words the API uses.
  await dialog.getByLabel("Spec file").setInputFiles(file("huge.yaml", "#".repeat(5 * 1024 * 1024 + 1)));
  await expect(dialog.getByText("This file is over 5 MB, the most an API reference reads.")).toBeVisible();
  await expect(add).toBeDisabled();

  // A spec with nothing to show is refused by the server: the dialog stays, with the reason.
  await dialog.getByLabel("Spec file").setInputFiles(file("empty.yaml", 'openapi: 3.1.0\ninfo:\n  title: Nothing yet\n  version: "1"\npaths: {}\n'));
  await expect(dialog.getByLabel("Name")).toHaveValue("Nothing yet");
  // While it adds (held here until released), focus stays on the button, which can't be pressed again.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await team.route("**/*", async (route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      await held;
    }
    await route.continue();
  });
  // A name of only spaces adds nothing, from Enter in Name either.
  await dialog.getByLabel("Name").fill("   ");
  await expect(add).toBeDisabled();
  await dialog.getByLabel("Name").press("Enter");
  await dialog.getByLabel("Name").fill("Nothing yet");
  await add.click();
  const adding = dialog.getByRole("button", { name: "Adding…" });
  await expect(adding).toBeFocused();
  await expect(adding).toBeDisabled();
  await expect(dialog.getByText("This spec has no operations to show.")).toHaveCount(0);
  release();
  await expect(dialog.getByText("This spec has no operations to show.")).toBeVisible();
  await expect(dialog.getByText("Name is required")).toHaveCount(0);
  await team.unroute("**/*");
  // Focus goes to the file, which the reason is about.
  await expect(dialog.getByRole("button", { name: /empty\.yaml/ })).toBeFocused();
  await expect(dialog.getByRole("button", { name: /empty\.yaml/ })).toHaveAccessibleDescription("This spec has no operations to show.");

  // A name the server refuses (longer than the field lets one be typed) is said under Name, and focus goes there;
  // what's wrong with the file isn't said any more, and another name clears it.
  await dialog.getByLabel("Spec file").setInputFiles(file("openapi.yaml", SPEC));
  await expect(dialog.getByText("openapi.yaml")).toBeVisible();
  // A tab deleted since the dialog opened is said under Tab, and focus goes there, until Add is pressed again.
  const tab = dialog.getByRole("combobox", { name: "Tab" });
  await tab.click();
  await team.getByRole("option", { name: "Scratch" }).click();
  await api("/tabs/scratch", undefined, "DELETE");
  await add.click();
  await expect(tab).toBeFocused();
  await expect(tab).toHaveAttribute("aria-invalid", "true");
  await expect(tab).toHaveAccessibleDescription("There's no tab “scratch”");
  // The page refreshes after a refusal, so the tab that's gone has left the list.
  await tab.click();
  await expect(team.getByRole("option", { name: "Scratch" })).toHaveCount(0);
  await team.getByRole("option", { name: "Developers" }).click();

  const name = dialog.getByLabel("Name");
  await name.evaluate((input) => input.removeAttribute("maxlength"));
  await name.fill("N".repeat(81));
  await add.click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAccessibleDescription(/80/);
  await expect(dialog.getByText("There's no tab “scratch”")).toHaveCount(0);
  await expect(tab).not.toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByRole("button", { name: /openapi\.yaml/ })).toHaveAccessibleDescription("OpenAPI 3.0 or 3.1 (JSON or YAML), or a GraphQL schema");
  await checkpoint(team, "api-reference-dialog-name-refused", { fullPage: false });
  // The name typed is cleared: the next spec names it again.
  await name.fill("");
  await expect(name).not.toHaveAttribute("aria-invalid", "true");

  // A spec: the reference takes its title as its name, in the tab the tree shows.
  await dialog.getByLabel("Spec file").setInputFiles(file("openapi.yaml", SPEC));
  await expect(dialog.getByText("openapi.yaml")).toBeVisible();
  await expect(dialog.getByText("This spec has no operations to show.")).toBeHidden();
  await expect(dialog.getByLabel("Name")).toHaveValue("Acme API");
  await expect(dialog.getByRole("combobox", { name: "Tab" })).toContainText("Developers");
  // A name the team typed stays when another file is chosen.
  await dialog.getByLabel("Name").fill("Public API");
  await dialog.getByLabel("Spec file").setInputFiles(file("openapi.yml", LARGE_SPEC));
  await expect(dialog.getByText("openapi.yml")).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveValue("Public API");
  await checkpoint(team, "api-reference-dialog", { fullPage: false });
  await add.click();
  // On to its page. Until that page is built (the plan's next step) this address is a full load of "not found", which
  // takes the "API reference added" toast with it: the address is what's checked.
  await team.waitForURL(`**/app/${slug}/docs/references/public-api`);

  // The spec is kept as it was written, line breaks and all.
  const added = (await api("/api-references/public-api?spec=true", undefined, "GET")) as { slug: string; spec?: string };
  expect(added).toMatchObject({ name: "Public API", tab: "developers" });
  expect(added.spec === LARGE_SPEC).toBe(true);

  // Its row in its tab's tree, after the collections: its name, how many operations are on the help center, and its page.
  await team.goto(`/app/${slug}/docs/tabs/developers`);
  const row = tree.getByRole("list", { name: "API references" }).getByRole("listitem");
  await expect(row).toHaveText("Public API2");
  // It has no buttons to make room for: its count stays as it's pointed at.
  await row.hover();
  await expect(row.getByText("2", { exact: true })).toBeVisible();
  await expect(row.getByRole("link", { name: "Public API" })).toHaveAttribute("href", `/app/${slug}/docs/references/public-api`);
  // And on the tab's page, after its collections: its name, how many endpoints, and its page.
  const listed = content.getByRole("list", { name: "API references" }).getByRole("listitem");
  await expect(listed).toHaveText("Public API2 endpoints");
  await expect(listed.getByRole("link", { name: "Public API" })).toHaveAttribute("href", `/app/${slug}/docs/references/public-api`);
  await expect(content.getByText("Nothing in this tab yet")).toHaveCount(0);
  await checkpoint(team, "api-reference-in-the-tree", { fullPage: false });
  // Unpublished, it's a draft there.
  await api("/api-references/public-api", { published: false }, "PATCH");
  await team.reload();
  await expect(row).toHaveText("Public APIDraft2");
  await expect(listed).toHaveText("Public API2 endpointsDraft");

  // Not in the first tab's.
  await team.goto(`/app/${slug}/docs`);
  await expect(tree.getByRole("button", { name: "Add to your docs" })).toBeVisible();
  await expect(tree.getByRole("link", { name: "Public API" })).toHaveCount(0);
});
