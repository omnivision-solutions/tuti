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

// The panel beside it links their other conversations into the Inbox's list when they're in it: the view it shows, or a
// search's results (`q`), for the teammate looking.
test("inbox.conversation's panel says which of their other conversations are in the list beside it: the view, or a search's results", async () => {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const email = "e2e-sam@example.com";
  for (const [number, subject, status] of [
    [1, "Exporting reports", "OPEN"],
    [2, "Refund please", "CLOSED"],
    [3, "Inviting a teammate", "OPEN"],
  ] as const) {
    await prisma.conversation.create({ data: { projectId: project.id, number, subject, status, email, origin: "API" } });
  }
  const caller = await callerAs(owner);
  const inView = async (input: { view?: "open" | "closed"; q?: string }) =>
    Object.fromEntries((await caller.inbox.conversation({ project: project.slug, number: 1, ...input })).conversation!.panel.conversations.map((c) => [c.number, c.inView]));

  expect(await inView({})).toEqual({ 2: false, 3: true });
  expect(await inView({ view: "closed" })).toEqual({ 2: true, 3: false });
  // A search's results, whatever the view: closed ones too.
  expect(await inView({ q: "refund" })).toEqual({ 2: true, 3: false });
});
