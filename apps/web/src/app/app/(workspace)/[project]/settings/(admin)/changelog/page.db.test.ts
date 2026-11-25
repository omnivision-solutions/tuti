import { isValidElement, type ReactElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";

import { ChangelogStyleForm } from "@/components/changelog";
import { settingsGroups } from "@/lib/settings-pages";
import { actAs, createProject, signUp } from "@/test/helpers";

import ChangelogSettingsPage from "./page";

/** Settings → Changelog: its covers are there with AI or without; how AI drafts, only with it. */

let slug: string;
beforeEach(async () => {
  const owner = await signUp("Owner");
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
  vi.stubEnv("OPENAI_API_KEY", "sk-or-placeholder");
  expect((await form()).props.model).toBeTruthy();
  expect(portal()).toEqual(["Branding", "Navigation", "Docs home", "Content actions", "Changelog", "Widget", "SEO", "Custom code"]);
  expect(ai()).not.toContain("Changelog");
  vi.unstubAllEnvs();
});
