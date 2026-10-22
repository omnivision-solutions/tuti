import { beforeEach, expect, test } from "vitest";

import { getPortal, updatePortal } from "@/server/operations/portal";
import { call } from "@/server/operations/run";
import { createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";

import FeedbackHome from "./feedback/page";
import PortalHome from "./page";

/** The portal's home opens what the team picked (Customize → Home page): the first board unless they did. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const as = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const home = () => redirectTarget(PortalHome({ params: Promise.resolve({ project: project.slug }) } as never));

test("the first board, then the roadmap, the changelog or the docs once picked", async () => {
  expect(await call(getPortal, as(), {})).toEqual({ access: "public", home: "feedback" });
  expect(await home()).toBe("/feedback/feature-requests");
  for (const [pick, path] of [
    ["docs", "/docs"],
    ["roadmap", "/roadmap"],
    ["changelog", "/changelog"],
    ["feedback", "/feedback/feature-requests"],
  ] as const) {
    await call(updatePortal, as(), { home: pick });
    expect(await home()).toBe(path);
  }
});

test("/feedback opens the first board, whatever the home page", async () => {
  await call(updatePortal, as(), { home: "docs" });
  expect(await redirectTarget(FeedbackHome({ params: Promise.resolve({ project: project.slug }) } as never))).toBe("/feedback/feature-requests");
});

test("each setting changes on its own; bad values are refused", async () => {
  await call(updatePortal, as(), { access: "private" });
  expect(await call(updatePortal, as(), { home: "docs" })).toEqual({ access: "private", home: "docs" });
  expect(await call(updatePortal, as(), { access: "public" })).toEqual({ access: "public", home: "docs" });
  await expect(call(updatePortal, as(), { home: "blog" as never })).rejects.toMatchObject({ status: 400, message: "Pick feedback, roadmap, changelog or docs" });
});
