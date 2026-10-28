import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { createProject, signUp } from "@/test/helpers";

import { onlineUntil, presenceKey, touchPresence } from "./presence";

test("someone is online for 2 minutes after they're last here, which is written at most once a minute", async () => {
  const project = await createProject(await signUp());
  const key = presenceKey({ userId: null, visitorHash: "abc" });
  expect(key).toBe("visitor:abc");
  const start = new Date("2026-10-27T12:00:00Z");
  const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
  const lastSeen = async () => (await prisma.widgetPresence.findUniqueOrThrow({ where: { projectId_who: { projectId: project.id, who: key } } })).lastSeenAt;

  expect(await onlineUntil(project.id, key, start)).toBeNull();
  // Coming online says so; being here again doesn't.
  expect(await touchPresence(project.id, key, start)).toBe(true);
  // Again within the minute: no write.
  expect(await touchPresence(project.id, key, at(30))).toBe(false);
  expect(await lastSeen()).toEqual(start);
  await touchPresence(project.id, key, at(61));
  expect(await lastSeen()).toEqual(at(61));

  expect(await onlineUntil(project.id, key, at(61 + 119))).toEqual(at(61 + 120));
  expect(await onlineUntil(project.id, key, at(61 + 121))).toBeNull();
  // Back after being away: online again.
  expect(await touchPresence(project.id, key, at(61 + 300))).toBe(true);
  // Per project.
  const other = await createProject(await signUp());
  expect(await onlineUntil(other.id, key, at(62))).toBeNull();
});
