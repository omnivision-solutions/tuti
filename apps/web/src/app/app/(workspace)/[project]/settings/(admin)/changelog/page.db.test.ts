import { isValidElement, type ReactElement } from "react";
import { prisma } from "@tuti/db";
import { type ModelFake, startModelFake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { ChangelogStyleForm } from "@/components/changelog";
import { settingsGroups } from "@/lib/settings-pages";
import { actAs, callerAs, createProject, signUp, type TestUser } from "@/test/helpers";

import ChangelogSettingsPage from "./page";

/** Settings → Changelog: its covers are there with AI or without; how AI drafts, only with it. */

let slug: string;
let owner: TestUser;
let model: ModelFake;
beforeAll(async () => {
  model = await startModelFake();
});
afterAll(() => model.close());
beforeEach(async () => {
  owner = await signUp("Owner");
  slug = (await createProject(owner)).slug;
  actAs(owner);
});

/** The page's form, as the page sends it. */
async function form() {
  const pane = (await ChangelogSettingsPage({ params: Promise.resolve({ project: slug }) } as never)) as ReactElement<{ children: ReactElement[] }>;
  const found = [pane.props.children].flat().find((child) => isValidElement(child) && child.type === ChangelogStyleForm);
  return found as ReactElement<{ model: unknown }>;
}
const portal = () => settingsGroups(slug, true).find((group) => group.title === "Portal")!.pages.map((page) => page.title);
const ai = () => settingsGroups(slug, true).find((group) => group.title === "AI")!.pages.map((page) => page.title);

test("without AI, the page and its link are there with the cover only", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  expect((await form()).props.model).toBeNull();
  expect(portal()).toContain("Changelog");
  expect(ai()).not.toContain("Changelog");
  vi.unstubAllEnvs();
});

test("with AI, the page has its AI model too, and its link is still with the portal's pages", async () => {
  // The model fake answers the AI model's list of models: nothing leaves the machine.
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  expect((await form()).props.model).toBeTruthy();
  expect(portal()).toEqual(["Branding", "Navigation", "Docs home", "Content actions", "Changelog", "Widget", "SEO", "Languages", "Custom code"]);
  expect(ai()).not.toContain("Changelog");
  vi.unstubAllEnvs();
});

test("the examples picked are in the changelog's order, newest first, whatever order they were picked in", async () => {
  const { id: projectId } = await prisma.project.findUniqueOrThrow({ where: { slug }, select: { id: true } });
  const day = 24 * 60 * 60 * 1000;
  for (const [number, ago] of [
    [1, 3],
    [2, 2],
    [3, 1],
  ] as const) {
    await prisma.changelogEntry.create({ data: { projectId, number, title: `Release ${number}`, body: "", publishedAt: new Date(Date.now() - ago * day) } });
  }
  const caller = await callerAs(owner);
  await caller.changelogStyle.update({ project: slug, examples: [1, 3] });
  expect((await caller.changelogStyle.settings({ project: slug })).examples).toEqual([3, 1]);
});
