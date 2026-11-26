import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { createChangelogEntry } from "@/server/operations/changelog";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";

import { GET } from "./route";

/** What the changelog editor asks while an entry's screenshots are being taken: only the project's team gets an answer. */

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp("Owner");
  project = await createProject(owner);
});

const ask = (number: number | string, slug = project.slug) =>
  GET(new Request(`http://tuti.localhost:3100/app/${slug}/changelog/${number}/screenshots`), { params: Promise.resolve({ project: slug, number: String(number) }) });

test("says whether the entry's latest run is running and when the entry was saved; nobody off the team gets an answer", async () => {
  const { number } = await call(createChangelogEntry, { actor: { kind: "user", userId: owner.id }, projectId: project.id }, { title: "November", body: "[Screenshot: The billing page]" });
  const entry = await prisma.changelogEntry.findFirstOrThrow({ where: { projectId: project.id, number }, select: { id: true, updatedAt: true } });
  await prisma.screenshotRun.create({ data: { projectId: project.id, startedById: owner.id, changelogEntryId: entry.id, startedAt: new Date() } });
  actAs(owner);
  const running = await ask(number);
  expect(running.headers.get("cache-control")).toBe("private, no-store");
  expect(await running.json()).toEqual({ running: true, savedAt: entry.updatedAt.toISOString() });
  await prisma.screenshotRun.updateMany({ where: { changelogEntryId: entry.id }, data: { state: "DONE" } });
  expect(await (await ask(number)).json()).toMatchObject({ running: false });
  expect((await ask("x")).status).toBe(404);
  actAs(await signUp("Outsider"));
  expect((await ask(number)).status).toBe(404);
});
