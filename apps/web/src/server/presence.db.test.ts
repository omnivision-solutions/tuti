import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { isOnline, presenceKey, touchPresence } from "./presence";

test("someone is online for 2 minutes after they're last here, which is written at most once a minute", async () => {
  const project = await createProject(await signUp());
  const key = presenceKey({ userId: null, visitorHash: "abc" });
  expect(key).toBe("visitor:abc");
  const start = new Date("2026-10-27T12:00:00Z");
  const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
  const lastSeen = async () => (await prisma.widgetPresence.findUniqueOrThrow({ where: { projectId_who: { projectId: project.id, who: key } } })).lastSeenAt;

  expect(await isOnline(project.id, key, start)).toBe(false);
  await touchPresence(project.id, key, start);
  // Again within the minute: no write.
  await touchPresence(project.id, key, at(30));
  expect(await lastSeen()).toEqual(start);
  await touchPresence(project.id, key, at(61));
  expect(await lastSeen()).toEqual(at(61));

  expect(await isOnline(project.id, key, at(61 + 119))).toBe(true);
  expect(await isOnline(project.id, key, at(61 + 121))).toBe(false);
  // Per project.
  const other = await createProject(await signUp());
  expect(await isOnline(other.id, key, at(62))).toBe(false);
});
