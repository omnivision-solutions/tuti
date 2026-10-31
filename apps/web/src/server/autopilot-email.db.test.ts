import { prisma } from "@tuti/db";
import { queueAutopilotNotices, sendAutopilotEmails } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { FAKE_OPENAI_KEY, startModelFake, startOpenAIFake } from "@tuti/testkit";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { saveAutopilotRecipients, setAutopilotEmails } from "@/server/github";
import { createPost } from "@/server/operations/create";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let number = 0;

// AI on (Autopilot needs it), with local fakes.
let fakes: { close: () => Promise<void> }[] = [];
beforeAll(async () => {
  const model = await startModelFake();
  const openai = await startOpenAIFake();
  fakes = [model, openai];
  for (const [name, value] of Object.entries(model.env)) {
    vi.stubEnv(name, value);
  }
  vi.stubEnv("OPENAI_BASE_URL", openai.url);
  vi.stubEnv("OPENAI_API_KEY", FAKE_OPENAI_KEY);
});
afterAll(async () => {
  await Promise.all(fakes.map((fake) => fake.close()));
});

beforeEach(async () => {
  await prisma.autopilotNotice.deleteMany({});
  owner = await signUp("Olive Owner");
  project = await createProject(owner);
  actAs(owner);
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const MINUTE = 60_000;

/** A ready change with a request it closes (waiting for the team) and, with `scheduled`, a progress update going out in 24 hours. */
async function change(title: string, { scheduled = true } = {}) {
  number++;
  const post = await call(createPost, team(), { board: "feature-requests", title: `Dark mode ${number}` });
  const postId = (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number } })).id;
  return prisma.codeChange.create({
    data: {
      projectId: project.id,
      repoId: 1,
      repo: "acme/app",
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      title,
      author: "octo",
      mergedAt: new Date(),
      state: "READY",
      summary: "You can now switch to a dark theme.",
      actions: {
        create: [
          { kind: "RESOLVES", postId, probability: 0.9 },
          ...(scheduled
            ? [{ kind: "MOVES_FORWARD" as const, postId, probability: 0.97, status: "SCHEDULED" as const, dueAt: new Date(Date.now() + 24 * 3_600_000), payload: { comment: "Out soon" } }]
            : []),
        ],
      },
    },
  });
}

const to = (user: TestUser) => mailbox.emails.filter((email) => email.to.includes(user.email) && email.subject.startsWith("Autopilot"));
const later = () => new Date(Date.now() + 11 * MINUTE);

test("who's told: owners, admins when the project says so, and the members it picks, each as they chose; owners always hear what goes out by itself", async () => {
  const admin = await signUp("Ada Admin");
  const member = await signUp("Max Member");
  const chosen = await signUp("Cy Chosen");
  for (const [user, role] of [[admin, "ADMIN"], [member, "MEMBER"], [chosen, "MEMBER"]] as const) {
    await prisma.teamMember.create({ data: { projectId: project.id, userId: user.id, role } });
  }
  const told = async (codeChangeId: string) =>
    (await prisma.autopilotNotice.findMany({ where: { codeChangeId }, select: { user: { select: { name: true } } } })).map((n) => n.user.name).sort();

  const first = await change("Add a dark theme");
  await queueAutopilotNotices(first.id);
  expect(await told(first.id)).toEqual(["Olive Owner"]);

  // The owner adds admins and picks Cy.
  const form = new FormData();
  form.set("admins", "on");
  form.append("told", chosen.id);
  expect(await saveAutopilotRecipients(project.slug, {}, form)).toEqual({});
  const second = await change("Faster search");
  await queueAutopilotNotices(second.id);
  expect(await told(second.id)).toEqual(["Ada Admin", "Cy Chosen", "Olive Owner"]);

  // Cy and the owner turn it off: Cy isn't told; the owner still is while something goes out by itself, not otherwise.
  for (const user of [chosen, owner]) {
    actAs(user);
    expect(await setAutopilotEmails("OFF")).toEqual({});
  }
  actAs(owner);
  const third = await change("Exports");
  await queueAutopilotNotices(third.id);
  expect(await told(third.id)).toEqual(["Ada Admin", "Olive Owner"]);
  const quiet = await change("Docs tweaks", { scheduled: false });
  await queueAutopilotNotices(quiet.id);
  expect(await told(quiet.id)).toEqual(["Ada Admin"]);
});

test("the email: what goes out by itself and when, what needs you, Review with the likely ones ticked; sent ten minutes on", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  // Not yet: something else may merge.
  expect(await sendAutopilotEmails()).toBe(0);
  expect(await sendAutopilotEmails(later())).toBe(1);
  const [email] = to(owner);
  expect(email!.subject).toBe("Autopilot: Add a dark theme · 1 update goes out in 24 hours, 1 needs you");
  expect(email!.text).toContain("Goes out by itself");
  expect(email!.text).toContain("Progress update · Dark mode");
  expect(email!.text).toContain("Needs you");
  expect(email!.text).toContain("Closes the request · Dark mode");
  expect(email!.html).toContain(`/app/${project.slug}/autopilot/${one.id}?select=likely`);
  // Once.
  expect(await sendAutopilotEmails(later())).toBe(0);
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: one.id, sentAt: { not: null } } })).toBe(1);
});

test("changes merged within ten minutes go in one email", async () => {
  const a = await change("Add a dark theme");
  const b = await change("Faster search");
  await queueAutopilotNotices(a.id);
  await queueAutopilotNotices(b.id);
  expect(await sendAutopilotEmails(later())).toBe(1);
  const [email] = to(owner);
  expect(email!.subject).toBe("Autopilot: 2 merged pull requests · 2 updates go out in 24 hours, 2 need you");
  expect(email!.text).toContain("Add a dark theme");
  expect(email!.text).toContain("Faster search");
});

test("analysed again, those told hear again; someone who left the team (or turned it off) before it went isn't sent it", async () => {
  const admin = await signUp("Ada Admin");
  await prisma.teamMember.create({ data: { projectId: project.id, userId: admin.id, role: "ADMIN" } });
  await prisma.project.update({ where: { id: project.id }, data: { autopilotTellAdmins: true } });
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  // The admin leaves before it goes: only the owner gets it.
  await prisma.teamMember.deleteMany({ where: { projectId: project.id, userId: admin.id } });
  expect(await sendAutopilotEmails(later())).toBe(1);
  expect(to(admin)).toHaveLength(0);
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: one.id, userId: admin.id } })).toBe(0);
  // Analysed again: the owner is told again.
  await queueAutopilotNotices(one.id);
  expect(await sendAutopilotEmails(new Date(Date.now() + 25 * MINUTE))).toBe(1);
  expect(to(owner)).toHaveLength(2);
});

test("the subject counts every update, the email shows five and says how many more", async () => {
  const many = await change("Big release");
  const postId = (await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: many.id } })).postId!;
  await prisma.codeChangeAction.createMany({
    data: Array.from({ length: 5 }, () => ({ codeChangeId: many.id, kind: "LINKS" as const, postId, probability: 0.7 })),
  });
  await queueAutopilotNotices(many.id);
  await sendAutopilotEmails(later());
  const [email] = to(owner);
  expect(email!.subject).toBe("Autopilot: Big release · 1 update goes out in 24 hours, 6 need you");
  expect(email!.text).toContain("+2 more in Tuti");
});

test("what went out by itself before the email did (a short hold) is still news: the owner hears of it, under Went out by itself", async () => {
  // The owner turned Autopilot's email off: they're told only about what customers see that goes out by itself.
  expect(await setAutopilotEmails("OFF")).toEqual({});
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  // The hold passes before the email goes: the progress update goes out by itself.
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, status: "SCHEDULED" }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(), payload: { comment: "Out soon", auto: true } } });
  expect(await sendAutopilotEmails(later())).toBe(1);
  const [email] = to(owner);
  expect(email!.subject).toBe("Autopilot: Add a dark theme · 1 update went out, 1 needs you");
  expect(email!.text).toContain("Went out by itself");
  expect(email!.text).not.toContain("Done (only your team sees it)");
});

test("queuing the email failing doesn't fail what called it (a saved analysis): it's logged", async () => {
  const one = await change("Add a dark theme");
  const logged = vi.spyOn(log, "error").mockImplementation(() => {});
  vi.spyOn(prisma.autopilotNotice, "createMany").mockRejectedValueOnce(new Error("database blip"));
  expect(await queueAutopilotNotices(one.id)).toBe(0);
  expect(logged).toHaveBeenCalledWith("Queuing Autopilot's email failed", expect.objectContaining({ codeChangeId: one.id }));
  logged.mockRestore();
});

test("a sweep that stopped after taking someone's notices (a deploy) doesn't lose them: after a while the next one sends them, and only then are they sent", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  // Taken by a sweep that stopped before sending.
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { claimedAt: new Date() } });
  expect(await sendAutopilotEmails(later())).toBe(0);
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: one.id, sentAt: { not: null } } })).toBe(0);
  expect(await sendAutopilotEmails(new Date(Date.now() + 16 * MINUTE))).toBe(1);
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: one.id, sentAt: { not: null } } })).toBe(1);
});

test("analysed again, what Autopilot did by itself before the last email isn't news again", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  // The hold passes before the email: the progress update goes out by itself, and the email says so.
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, status: "SCHEDULED" }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(), payload: { comment: "Out soon", auto: true } } });
  expect(await sendAutopilotEmails(later())).toBe(1);
  expect(to(owner)[0]!.text).toContain("Went out by itself");
  // Analysed again later: the request still waits; what went out then isn't listed again.
  await queueAutopilotNotices(one.id);
  expect(await sendAutopilotEmails(new Date(Date.now() + 25 * MINUTE))).toBe(1);
  const [, again] = to(owner);
  expect(again!.subject).toBe("Autopilot: Add a dark theme · 1 needs you");
  expect(again!.text).not.toContain("Went out by itself");
});

test("no hold, and the runner applies it before the notices are queued: owners still hear of it", async () => {
  expect(await setAutopilotEmails("OFF")).toEqual({});
  const one = await change("Add a dark theme");
  // Only what went out by itself is left (the request was decided already).
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, kind: "RESOLVES" }, data: { status: "DISMISSED" } });
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, status: "SCHEDULED" }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(), payload: { comment: "Out soon", auto: true } } });
  expect(await queueAutopilotNotices(one.id)).toBe(1);
  expect(await sendAutopilotEmails(later())).toBe(1);
  expect(to(owner)[0]!.subject).toBe("Autopilot: Add a dark theme · 1 update went out");
});

test("everything decided before the email went (the team approved it all): no email, and the page doesn't say anyone was emailed", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(), decidedById: owner.id } });
  expect(await sendAutopilotEmails(later())).toBe(0);
  expect(to(owner)).toHaveLength(0);
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: one.id } })).toBe(0);
});

test("without a mail server, nothing's marked sent: the notices wait for one", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  const host = process.env.SMTP_HOST ?? "";
  vi.stubEnv("SMTP_HOST", "");
  expect(await sendAutopilotEmails(later())).toBe(0);
  vi.stubEnv("SMTP_HOST", host);
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: one.id, sentAt: null } })).toBe(1);
  expect(await sendAutopilotEmails(later())).toBe(1);
});

test("someone told for the first time on a later analysis hears only what that analysis did, not what went out days before", async () => {
  const admin = await signUp("Ada Admin");
  await prisma.teamMember.create({ data: { projectId: project.id, userId: admin.id, role: "ADMIN" } });
  const one = await change("Add a dark theme");
  // Its progress update went out by itself two days ago.
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, status: "SCHEDULED" }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(Date.now() - 2 * 86_400_000), payload: { comment: "Out soon", auto: true } } });
  // Admins are told now; analysed again, the request still waits.
  await prisma.project.update({ where: { id: project.id }, data: { autopilotTellAdmins: true } });
  await queueAutopilotNotices(one.id);
  expect(await sendAutopilotEmails(later())).toBe(2);
  const [email] = to(admin);
  expect(email!.subject).toBe("Autopilot: Add a dark theme · 1 needs you");
  expect(email!.text).not.toContain("Went out by itself");
});

test("analysed again while its email is being sent: that email goes, and the new analysis's in the next one", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  // As the sweep sends (after claiming), the change is analysed again.
  const findUnique = prisma.teamMember.findUnique.bind(prisma.teamMember) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(prisma.teamMember, "findUnique").mockImplementationOnce((async (...args: unknown[]) => {
    await queueAutopilotNotices(one.id);
    return findUnique(...args);
  }) as never);
  expect(await sendAutopilotEmails(later())).toBe(1);
  spy.mockRestore();
  // Not marked sent: it goes again, ten minutes after the analysis.
  expect(await prisma.autopilotNotice.findFirstOrThrow({ where: { codeChangeId: one.id } })).toMatchObject({ sentAt: null, claimedAt: null });
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  expect(to(owner)).toHaveLength(2);
});

test("what went out by itself between the last email and the next analysis isn't that analysis's news", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  expect(await sendAutopilotEmails(later())).toBe(1);
  // That email went three days ago; a day after it, its hold passed and the progress update went out by itself.
  const DAY = 86_400_000;
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { sentAt: new Date(Date.now() - 3 * DAY) } });
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, status: "SCHEDULED" }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(Date.now() - 2 * DAY), payload: { comment: "Out soon", auto: true } } });
  // Analysed again now.
  await queueAutopilotNotices(one.id);
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  const [, again] = to(owner);
  expect(again!.subject).toBe("Autopilot: Add a dark theme · 1 needs you");
  expect(again!.text).not.toContain("Went out by itself");
});

test("analysed again right after the sweep reads someone's notices: the new analysis isn't lost", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  // The analysis is saved just after the sweep reads the notices (with the analysis before's updates).
  const findMany = prisma.autopilotNotice.findMany.bind(prisma.autopilotNotice) as (...args: unknown[]) => Promise<unknown>;
  let reads = 0;
  const spy = vi.spyOn(prisma.autopilotNotice, "findMany").mockImplementation((async (...args: unknown[]) => {
    const read = await findMany(...args);
    // The second read is the person's notices.
    if (++reads === 2) {
      await queueAutopilotNotices(one.id);
    }
    return read;
  }) as never);
  await sendAutopilotEmails(later());
  spy.mockRestore();
  expect(await prisma.autopilotNotice.findFirstOrThrow({ where: { codeChangeId: one.id } })).toMatchObject({ sentAt: null, claimedAt: null });
});

test("not sent after all, a notice sent before goes back to that: the page still says they were emailed then", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  expect(await sendAutopilotEmails(later())).toBe(1);
  const first = (await prisma.autopilotNotice.findFirstOrThrow({ where: { codeChangeId: one.id } })).sentAt;
  // Analysed again; the team decides it all before the email goes.
  await queueAutopilotNotices(one.id);
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(), decidedById: owner.id } });
  expect(await sendAutopilotEmails(new Date(Date.now() + 25 * MINUTE))).toBe(0);
  expect(await prisma.autopilotNotice.findFirstOrThrow({ where: { codeChangeId: one.id } })).toMatchObject({ sentAt: first, claimedAt: null });
});

test("a sweep that finishes sending in the middle of queuing the next analysis doesn't swallow it", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  // A sweep has it claimed, and is sending the analysis before's updates.
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { claimedAt: new Date() } });
  const [{ createdAt, claimedAt }] = await prisma.autopilotNotice.findMany({ where: { codeChangeId: one.id } });
  // Analysed again: the sweep marks it sent (as it read it) between queuing's first and second steps.
  const executeRaw = prisma.$executeRaw.bind(prisma) as (...args: unknown[]) => Promise<number>;
  let steps = 0;
  const spy = vi.spyOn(prisma, "$executeRaw").mockImplementation((async (...args: unknown[]) => {
    if (++steps === 2) {
      await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id, claimedAt, createdAt }, data: { sentAt: new Date() } });
    }
    return executeRaw(...args);
  }) as never);
  await queueAutopilotNotices(one.id);
  spy.mockRestore();
  // Still to be sent, with what the new analysis found.
  expect(await prisma.autopilotNotice.findFirstOrThrow({ where: { codeChangeId: one.id } })).toMatchObject({ sentAt: null });
});
