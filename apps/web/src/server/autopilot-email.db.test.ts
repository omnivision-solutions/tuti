import { prisma } from "@tuti/db";
import { emailedAbout, queueAutopilotNotices, sendAutopilotEmails, tellOwners } from "@tuti/jobs";
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

test("one person's sweep failing (a database error) doesn't keep the others' email back, and theirs goes next minute", async () => {
  const admin = await signUp("Ada Admin");
  await prisma.teamMember.create({ data: { projectId: project.id, userId: admin.id, role: "ADMIN" } });
  await prisma.project.update({ where: { id: project.id }, data: { autopilotTellAdmins: true } });
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  const logged = vi.spyOn(log, "error").mockImplementation(() => {});
  // Reading the first person's membership fails.
  vi.spyOn(prisma.teamMember, "findUnique").mockRejectedValueOnce(new Error("database blip"));
  expect(await sendAutopilotEmails(later())).toBe(1);
  expect(logged).toHaveBeenCalledWith("Autopilot's email sweep failed for someone", expect.anything());
  logged.mockRestore();
  // Not held for the claim's quarter of an hour: the next sweep sends it.
  expect(await sendAutopilotEmails(later())).toBe(1);
  expect(to(owner)).toHaveLength(1);
  expect(to(admin)).toHaveLength(1);
});

test("analysed again while its email went: that email's news isn't repeated, and it's still on record if the next has nothing to say", async () => {
  expect(await setAutopilotEmails("OFF")).toEqual({});
  const one = await change("Add a dark theme");
  // No hold: the progress update went out by itself.
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, status: "SCHEDULED" }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(), payload: { comment: "Out soon", auto: true } } });
  await queueAutopilotNotices(one.id);
  // As the email goes (after the sweep read the notice), the change is analysed again.
  const findUnique = prisma.teamMember.findUnique.bind(prisma.teamMember) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(prisma.teamMember, "findUnique").mockImplementationOnce((async (...args: unknown[]) => {
    await queueAutopilotNotices(one.id);
    return findUnique(...args);
  }) as never);
  expect(await sendAutopilotEmails(later())).toBe(1);
  spy.mockRestore();
  expect(to(owner)[0]!.text).toContain("Went out by itself");
  // The team decides the request before the next email: nothing new to say, and the first email stays on record.
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, kind: "RESOLVES" }, data: { status: "DISMISSED" } });
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(0);
  expect((await prisma.autopilotNotice.findFirstOrThrow({ where: { codeChangeId: one.id } })).sentAt).not.toBeNull();
});

test("a new project publishes article edits and posts progress updates by itself (its owners hear of each before it goes)", async () => {
  expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { autopilotArticleEdits: true, autopilotProgress: true } })).toEqual({
    autopilotArticleEdits: true,
    autopilotProgress: true,
  });
});

test("analysed again, those emailed still show as emailed on the page until the next email goes", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  expect(await emailedAbout(one.id)).toEqual([]);
  expect(await sendAutopilotEmails(later())).toBe(1);
  expect(await emailedAbout(one.id)).toEqual(["Olive Owner"]);
  await queueAutopilotNotices(one.id);
  expect(await emailedAbout(one.id)).toEqual(["Olive Owner"]);
});

test("with the mail server not taking it (down, or 4xx: try later), an email is tried again a while after each failure for as long as that lasts, and goes once it's back", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  const logged = vi.spyOn(log, "error").mockImplementation(() => {});
  let at = Date.now() + 11 * MINUTE;
  try {
    for (let attempt = 1; attempt <= 7; attempt++) {
      // The server's fault, not the address's: try later.
      mailbox.refuseNext(owner.email, { code: 421 });
      expect(await sendAutopilotEmails(new Date(at))).toBe(0);
      at += 16 * MINUTE;
    }
  } finally {
    logged.mockRestore();
  }
  // Still there, not given up: it goes once the server takes it.
  expect(await prisma.autopilotNotice.findFirstOrThrow({ where: { codeChangeId: one.id } })).toMatchObject({ attempts: 0, sentAt: null });
  expect(await sendAutopilotEmails(new Date(at))).toBe(1);
});

test("an email the mail server refuses for its address is tried again a while after each refusal, a few times, then given up", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  const logged = vi.spyOn(log, "error").mockImplementation(() => {});
  let at = Date.now() + 11 * MINUTE;
  try {
    for (let attempt = 1; attempt <= 5; attempt++) {
      mailbox.refuseNext(owner.email, { permanently: true });
      expect(await sendAutopilotEmails(new Date(at))).toBe(0);
      // Not again the next minute: after the claim lapses.
      expect(await sendAutopilotEmails(new Date(at + MINUTE))).toBe(0);
      if (attempt < 5) {
        expect(await prisma.autopilotNotice.findFirstOrThrow({ where: { codeChangeId: one.id } })).toMatchObject({ attempts: attempt, sentAt: null });
      }
      at += 16 * MINUTE;
    }
  } finally {
    logged.mockRestore();
  }
  // Given up: no notice left (it was never sent).
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: one.id } })).toBe(0);
});

test("what the runner puts out by itself reaches the owners even if the analysis's notices were queued while it was being applied", async () => {
  expect(await setAutopilotEmails("OFF")).toEqual({});
  const one = await change("Add a dark theme");
  // The request was decided; the analysis queued its notices while the progress update was mid-apply (claimed, not yet marked Autopilot's).
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, kind: "RESOLVES" }, data: { status: "DISMISSED" } });
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, status: "SCHEDULED" }, data: { status: "PENDING", dueAt: null, decidedById: owner.id } });
  expect(await queueAutopilotNotices(one.id)).toBe(0);
  // The runner finishes and marks it Autopilot's, then tells the owners.
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, kind: "MOVES_FORWARD" }, data: { status: "APPLIED", decidedById: null, decidedAt: new Date(), payload: { comment: "Out soon", auto: true } } });
  expect(await tellOwners(one.id, new Date(Date.now() - MINUTE))).toBe(1);
  expect(await sendAutopilotEmails(later())).toBe(1);
  const [email] = to(owner);
  expect(email!.subject).toBe("Autopilot: Add a dark theme · 1 update went out");
  // Said as what it did, not what it will do.
  expect(email!.text).toContain("In progress, posted: “Out soon”");
});

test("given up on one notice, another queued lately in the same email keeps its own tries", async () => {
  const old = await change("Add a dark theme");
  const fresh = await change("Faster search");
  await queueAutopilotNotices(old.id);
  await queueAutopilotNotices(fresh.id);
  // The first refused four times already.
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: old.id }, data: { attempts: 4 } });
  const logged = vi.spyOn(log, "error").mockImplementation(() => {});
  mailbox.refuseNext(owner.email, { permanently: true });
  expect(await sendAutopilotEmails(later())).toBe(0);
  logged.mockRestore();
  // That one's given up; the one queued lately is still to be sent, with one try spent.
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: old.id } })).toBe(0);
  expect(await prisma.autopilotNotice.findFirstOrThrow({ where: { codeChangeId: fresh.id } })).toMatchObject({ attempts: 1, sentAt: null });
  expect(await sendAutopilotEmails(new Date(Date.now() + 27 * MINUTE))).toBe(1);
});

test("analysed again and its new update applied mid-queue: an owner emailed about an earlier analysis hears of it; one emailed since doesn't again", async () => {
  expect(await setAutopilotEmails("OFF")).toEqual({});
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  expect(await sendAutopilotEmails(later())).toBe(1);
  // Analysed again days later: a new update, applied by the runner as the notices were queued (nobody re-queued).
  const DAY = 86_400_000;
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { sentAt: new Date(Date.now() - 3 * DAY) } });
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id }, data: { status: "DISMISSED", createdAt: new Date(Date.now() - 4 * DAY) } });
  const proposed = new Date();
  await prisma.codeChangeAction.create({
    data: { codeChangeId: one.id, kind: "MOVES_FORWARD", postId: (await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: one.id, kind: "RESOLVES" } })).postId, probability: 0.97, status: "APPLIED", decidedAt: new Date(), payload: { comment: "Live now", auto: true } },
  });
  // Emailed before that update existed: told now.
  expect(await tellOwners(one.id, proposed)).toBe(1);
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  expect(to(owner)[1]!.text).toContain("In progress, posted: “Live now”");
  // Emailed since (about it): not again.
  expect(await tellOwners(one.id, proposed)).toBe(0);
});

test("the mail server refusing the message itself (its limits, the sender: 554 at DATA) is the server's: tried again past five, not given up", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  const logged = vi.spyOn(log, "error").mockImplementation(() => {});
  let at = Date.now() + 11 * MINUTE;
  try {
    for (let attempt = 1; attempt <= 6; attempt++) {
      mailbox.refuseNext(owner.email, { code: 554 });
      expect(await sendAutopilotEmails(new Date(at))).toBe(0);
      at += 16 * MINUTE;
    }
  } finally {
    logged.mockRestore();
  }
  expect(await prisma.autopilotNotice.findFirstOrThrow({ where: { codeChangeId: one.id } })).toMatchObject({ attempts: 0, sentAt: null });
  expect(await sendAutopilotEmails(new Date(at))).toBe(1);
});

test("what went out by itself during a mail outage stays news when the change is analysed again before the server's back", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  const logged = vi.spyOn(log, "error").mockImplementation(() => {});
  // The server's down: the send fails, the notice waits (claimed).
  mailbox.refuseNext(owner.email, { code: 421 });
  expect(await sendAutopilotEmails(later())).toBe(0);
  logged.mockRestore();
  // Meanwhile the progress update goes out by itself, and twenty minutes on the change is analysed again.
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, status: "SCHEDULED" }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(), payload: { comment: "Out soon", auto: true } } });
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { createdAt: new Date(Date.now() - 20 * MINUTE) } });
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, status: "APPLIED" }, data: { decidedAt: new Date(Date.now() - 15 * MINUTE) } });
  await queueAutopilotNotices(one.id);
  // The server's back: the email still says it went out.
  expect(await sendAutopilotEmails(new Date(Date.now() + 27 * MINUTE))).toBe(1);
  const [email] = to(owner);
  expect(email!.text).toContain("Went out by itself");
  expect(email!.text).toContain("In progress, posted: “Out soon”");
});

test("what goes out by itself while an email is being sent (read before it) is in the next one", async () => {
  expect(await setAutopilotEmails("OFF")).toEqual({});
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  // Its ten minutes are up: this minute's sweep sends it.
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { createdAt: new Date(Date.now() - 11 * MINUTE) } });
  // After the sweep read the change, before the send ends: the progress update goes out by itself and its owner is told.
  const findUnique = prisma.teamMember.findUnique.bind(prisma.teamMember) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(prisma.teamMember, "findUnique").mockImplementationOnce((async (...args: unknown[]) => {
    const action = await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: one.id, status: "SCHEDULED" } });
    await prisma.codeChangeAction.update({ where: { id: action.id }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(), payload: { comment: "Out soon", auto: true } } });
    await tellOwners(one.id, action.createdAt);
    return findUnique(...args);
  }) as never);
  expect(await sendAutopilotEmails()).toBe(1);
  spy.mockRestore();
  expect(to(owner)[0]!.text).not.toContain("Went out by itself");
  // The next email says it went.
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  expect(to(owner)[1]!.text).toContain("Went out by itself");
});

test("an update the runner was still applying when an email read the change (applied, not yet marked Autopilot's) is in the next one", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { createdAt: new Date(Date.now() - 11 * MINUTE) } });
  // The runner took the progress update a moment ago and applied it (a request would be emailing its voters): not yet marked its own.
  const takenAt = new Date(Date.now() - 31_000);
  const progress = await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: one.id, status: "SCHEDULED" } });
  await prisma.codeChangeAction.update({ where: { id: progress.id }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(Date.now() - 30_000), payload: { comment: "Out soon" } } });
  // After the sweep read the change, the runner marks it and tells the owners.
  const findUnique = prisma.teamMember.findUnique.bind(prisma.teamMember) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(prisma.teamMember, "findUnique").mockImplementationOnce((async (...args: unknown[]) => {
    const markedAt = new Date();
    await prisma.codeChangeAction.update({ where: { id: progress.id }, data: { payload: { comment: "Out soon", auto: true, autoAt: markedAt.toISOString() } } });
    await tellOwners(one.id, progress.createdAt, { from: takenAt, to: markedAt });
    return findUnique(...args);
  }) as never);
  expect(await sendAutopilotEmails()).toBe(1);
  spy.mockRestore();
  expect(to(owner)[0]!.text).not.toContain("Went out by itself");
  // The next email says it went.
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  expect(to(owner)[1]!.text).toContain("Went out by itself");
});

test("an email that read the change while the runner was marking an update its own (begun, not saved) is followed by one that says it went", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { createdAt: new Date(Date.now() - 11 * MINUTE) } });
  const takenAt = new Date(Date.now() - 31_000);
  const progress = await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: one.id, status: "SCHEDULED" } });
  await prisma.codeChangeAction.update({ where: { id: progress.id }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(Date.now() - 30_000), payload: { comment: "Out soon" } } });
  // The runner stamps the mark's time, then the sweep claims and reads before the mark is saved.
  const markedAt = new Date(Date.now() - 1000);
  const findUnique = prisma.teamMember.findUnique.bind(prisma.teamMember) as (...args: unknown[]) => Promise<unknown>;
  const spy = vi.spyOn(prisma.teamMember, "findUnique").mockImplementationOnce((async (...args: unknown[]) => {
    await prisma.codeChangeAction.update({ where: { id: progress.id }, data: { payload: { comment: "Out soon", auto: true, autoAt: markedAt.toISOString() } } });
    await tellOwners(one.id, progress.createdAt, { from: takenAt, to: new Date() });
    return findUnique(...args);
  }) as never);
  expect(await sendAutopilotEmails()).toBe(1);
  spy.mockRestore();
  expect(to(owner)[0]!.text).not.toContain("Went out by itself");
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  expect(to(owner)[1]!.text).toContain("Went out by itself");
});

test("an email sent while the runner was marking an update its own (begun, not saved) is followed by one that says it went", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { createdAt: new Date(Date.now() - 11 * MINUTE) } });
  const takenAt = new Date(Date.now() - 31_000);
  const progress = await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: one.id, status: "SCHEDULED" } });
  await prisma.codeChangeAction.update({ where: { id: progress.id }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(Date.now() - 30_000), payload: { comment: "Out soon" } } });
  // The runner stamps the mark's time; the whole email goes before the mark is saved.
  const markedAt = new Date(Date.now() - 1000);
  expect(await sendAutopilotEmails()).toBe(1);
  expect(to(owner)[0]!.text).not.toContain("Went out by itself");
  await prisma.codeChangeAction.update({ where: { id: progress.id }, data: { payload: { comment: "Out soon", auto: true, autoAt: markedAt.toISOString() } } });
  expect(await tellOwners(one.id, progress.createdAt, { from: takenAt, to: new Date() })).toBe(1);
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  expect(to(owner)[1]!.text).toContain("Went out by itself");
});

test("an email claimed just before the runner took an update, but read once it had, doesn't count as having told it", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { createdAt: new Date(Date.now() - 11 * MINUTE) } });
  const progress = await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: one.id, status: "SCHEDULED" } });
  // Between the sweep's claim and its read, the runner takes the update (off the schedule, in hand).
  let takenAt = new Date();
  const findMany = prisma.autopilotNotice.findMany.bind(prisma.autopilotNotice) as (...args: unknown[]) => Promise<unknown>;
  let reads = 0;
  const spy = vi.spyOn(prisma.autopilotNotice, "findMany").mockImplementation((async (...args: unknown[]) => {
    if (++reads === 2) {
      takenAt = new Date();
      await prisma.codeChangeAction.update({ where: { id: progress.id }, data: { status: "PENDING", dueAt: null, decidedById: owner.id } });
    }
    return findMany(...args);
  }) as never);
  expect(await sendAutopilotEmails()).toBe(1);
  spy.mockRestore();
  expect(to(owner)[0]!.text).not.toContain("Went out by itself");
  // The email is marked sent; then the runner finishes, marks it its own and tells the owners: this one's told again.
  const markedAt = new Date();
  await prisma.codeChangeAction.update({ where: { id: progress.id }, data: { status: "APPLIED", decidedById: null, decidedAt: takenAt, payload: { comment: "Out soon", auto: true, autoAt: markedAt.toISOString() } } });
  expect(await tellOwners(one.id, progress.createdAt, { from: takenAt, to: markedAt })).toBe(1);
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  expect(to(owner)[1]!.text).toContain("Went out by itself");
});
