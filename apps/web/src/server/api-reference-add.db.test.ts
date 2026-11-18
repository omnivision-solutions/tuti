import { expect, test } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import { addApiReference } from "./docs";
import { createTab } from "./operations/docs";
import { call } from "./operations/run";

const SPEC = "openapi: 3.1.0\ninfo:\n  title: Acme\n  version: '1'\npaths:\n  /posts:\n    get:\n      summary: List posts\n";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
};

/** "Add API reference" says which of its dialog's fields a refusal is about, so the reason shows there. */
test("a refused add names the field it's about: the name, the tab, or the spec", async () => {
  const owner = await signUp("Owner");
  const project = await createProject(owner);
  await call(createTab, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { name: "Guides" });
  actAs(owner);

  expect(await addApiReference(project.slug, form({ name: "  ", spec: SPEC }))).toEqual({ error: "Name is required", field: "name" });
  expect(await addApiReference(project.slug, form({ name: "n".repeat(81), spec: SPEC }))).toMatchObject({ field: "name" });
  // A tab deleted since the dialog opened.
  expect(await addApiReference(project.slug, form({ name: "API", spec: SPEC, tab: "gone" }))).toEqual({ error: "There's no tab “gone”", field: "tab" });
  expect(await addApiReference(project.slug, form({ name: "API", spec: "hello there", tab: "guides" }))).toMatchObject({ field: "spec" });
  expect(await addApiReference(project.slug, form({ name: "API", spec: "openapi: 3.1.0\ninfo:\n  title: Acme\n  version: '1'\npaths: {}\n" }))).toEqual({
    error: "This spec has no operations to show.",
    field: "spec",
  });
  // A spec with nothing to show is refused before its tab is looked for: the reason is the spec's.
  expect(await addApiReference(project.slug, form({ name: "API", spec: "openapi: 3.1.0\ninfo:\n  title: Acme\n  version: '1'\npaths: {}\n", tab: "gone" }))).toEqual({
    error: "This spec has no operations to show.",
    field: "spec",
  });
  // The spec as a file, as the dialog sends it: added, in the tab named.
  const sent = form({ name: "API", tab: "guides" });
  sent.set("spec", new Blob([SPEC]));
  expect(await addApiReference(project.slug, sent)).toEqual({ slug: "api" });

  // Someone not on the team is told only that.
  actAs(await signUp("Stranger"));
  expect(await addApiReference(project.slug, form({ name: "API", spec: SPEC, tab: "gone" }))).toEqual({ error: "Only the project's team can edit the docs" });
});
