import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { getPortal, updatePortal } from "@/server/operations/portal";
import { call } from "@/server/operations/run";
import { createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";

import FeedbackHome from "./feedback/page";
import PortalHome from "./page";

/** The portal's home opens what the team picked (Customize → Navigation → Home page): Feedback (its one board, or its overview) unless they did. */

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

test("/feedback opens the only board, whatever the home page", async () => {
  await call(updatePortal, as(), { home: "docs" });
  expect(await redirectTarget(FeedbackHome({ params: Promise.resolve({ project: project.slug }) } as never))).toBe("/feedback/feature-requests");
});

test("with two boards on the portal, the home opens Feedback's overview (a Team only board doesn't count)", async () => {
  await prisma.board.create({ data: { projectId: project.id, slug: "team", name: "Team", postVisibility: "TEAM" } });
  expect(await home()).toBe("/feedback/feature-requests");
  await prisma.board.create({ data: { projectId: project.id, slug: "bugs", name: "Bugs" } });
  expect(await home()).toBe("/feedback");
});

test("each setting changes on its own; bad values are refused", async () => {
  await call(updatePortal, as(), { access: "private" });
  expect(await call(updatePortal, as(), { home: "docs" })).toEqual({ access: "private", home: "docs" });
  expect(await call(updatePortal, as(), { access: "public" })).toEqual({ access: "public", home: "docs" });
  await expect(call(updatePortal, as(), { home: "blog" as never })).rejects.toMatchObject({ status: 400, message: "Pick feedback, roadmap, changelog or docs" });
});
