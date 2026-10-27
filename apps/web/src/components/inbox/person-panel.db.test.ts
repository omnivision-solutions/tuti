import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { upsertProjectUser } from "@/server/project-users";
import { createProject, signUp } from "@/test/helpers";

import { maybeUser } from "./person-panel";

test("the hint finds the project's user whatever the capitals in their saved address, and only in that project", async () => {
  const project = await createProject(await signUp());
  const userId = await upsertProjectUser(project.id, "kim-1", { name: "Kim Lee" });
  // As an older instance may have saved it.
  await prisma.ssoIdentity.update({ where: { userId }, data: { email: "E2E-Kim@Example.com" } });
  expect(await maybeUser(project.id, "e2e-kim@example.com")).toEqual({ name: "Kim Lee", id: "kim-1" });
  const other = await createProject(await signUp());
  expect(await maybeUser(other.id, "e2e-kim@example.com")).toBeNull();
});
