import { prisma } from "@tuti/db";
import { creditsOn } from "@tuti/testkit";
import { afterEach, expect, test, vi } from "vitest";

import { callerAs, createProject, signUp } from "@/test/helpers";

afterEach(() => vi.unstubAllEnvs());

// A GET writes nothing (docs/plan.md, "One way in"): reading whether the AI is out of credits doesn't give a project its
// free credits, as aiPaused does (the workspace layout gives them).
test("inbox.conversation, with credits on, doesn't give a project its free credits", async () => {
  vi.stubEnv("TUTI_CONFIG", creditsOn({ free: 100 }));
  // AI on the server (nothing asks it here).
  vi.stubEnv("OPENAI_API_KEY", "sk-or-test-fake");
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  await prisma.conversation.create({ data: { projectId: project.id, number: 1, subject: "Exporting reports", email: "e2e-sam@example.com", origin: "API" } });
  const granted = async () => ({
    grants: await prisma.creditGrant.count({ where: { projectId: project.id } }),
    at: (await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { freeCreditsGrantedAt: true } })).freeCreditsGrantedAt,
  });
  expect(await granted()).toEqual({ grants: 0, at: null });

  const { conversation } = await (await callerAs(owner)).inbox.conversation({ project: project.slug, number: 1 });
  expect(await granted()).toEqual({ grants: 0, at: null });
  // Not given them yet, it reads as out of credits.
  expect(conversation?.aiPaused).toBe(true);
});
