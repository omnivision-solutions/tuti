import { prisma } from "@tuti/db";
import { emailedAbout, queueAutopilotNotices, readAutopilotButton, sendAutopilotDigests, sendAutopilotEmails, tellOwners } from "@tuti/jobs";
import { log } from "@tuti/shared";
import { FAKE_OPENAI_KEY, startModelFake, startOpenAIFake } from "@tuti/testkit";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { saveAutopilotRecipients, setAutopilotEmails } from "@/server/github";
import { createPost } from "@/server/operations/create";
import { call } from "@/server/operations/run";
import { actAs, createProject, signUp, type TestUser } from "@/test/helpers";
import { mailbox } from "@/test/mailbox";

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;
let number = 0;

// A database not on UTC (one set up on a machine elsewhere): times it writes itself come back as Prisma's, all the same.
// Before the first query, so every connection has it.
beforeAll(async () => {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`ALTER DATABASE "${new URL(process.env.DATABASE_URL!).pathname.slice(1)}" SET TimeZone TO 'Europe/Berlin'`);
  await admin.end();
});

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

const to = (user: TestUser) => mailbox.emails.filter((email) => email.to.includes(user.email) && email.from.startsWith('"Tuti Autopilot"'));
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
  expect(email!.from).toBe('"Tuti Autopilot" <test@example.com>');
  expect(email!.subject).toBe("1 needs you, 1 goes out in 24 hours · Add a dark theme");
  // Needs you first, each update with how sure and its kind, a comment it posts as an added line.
  expect(email!.text).toMatch(/✋ Needs your approval\s+Dark mode \d+\s+90% sure\s+Closes the request[\s\S]*⏳ Auto-updating\s+Dark mode \d+\s+97% sure\s+Progress update/);
  expect(email!.html).toMatch(/Needs you: Dark mode \d+ \(closes the request\)\. Goes out in 24 hours: Dark mode \d+ \(progress update\)\./);
  expect(email!.text).toContain("+ Out soon");
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
  expect(email!.subject).toBe("2 need you, 2 go out in 24 hours · 2 pull requests");
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
  expect(email!.subject).toBe("6 need you, 1 goes out in 24 hours · Big release");
  expect(email!.text).toContain("+2 more in Tuti");
});

test("what needs you takes its room in the five first: five going out by themselves don't push it out", async () => {
  const many = await change("Big release");
  const postId = (await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: many.id } })).postId!;
  await prisma.codeChangeAction.createMany({
    data: Array.from({ length: 4 }, () => ({ codeChangeId: many.id, kind: "LINKS" as const, postId, probability: 0.9, status: "SCHEDULED" as const, dueAt: new Date(Date.now() + 24 * 3_600_000) })),
  });
  await queueAutopilotNotices(many.id);
  await sendAutopilotEmails(later());
  const [email] = to(owner);
  expect(email!.subject).toBe("1 needs you, 5 go out in 24 hours · Big release");
  expect(email!.text).toMatch(/✋ Needs your approval\s+Dark mode \d+\s+90% sure\s+Closes the request/);
  expect(email!.text).toMatch(/Approve http\S+\/act\?token=/);
  expect(email!.text.match(/· goes out in 24 hours/g)).toHaveLength(4);
  expect(email!.text).toContain("+1 more in Tuti");
});

test("five needing you still leave a place for what goes out by itself, with its Stop", async () => {
  const many = await change("Big release");
  const postId = (await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: many.id } })).postId!;
  await prisma.codeChangeAction.createMany({
    data: Array.from({ length: 4 }, () => ({ codeChangeId: many.id, kind: "LINKS" as const, postId, probability: 0.7 })),
  });
  await queueAutopilotNotices(many.id);
  await sendAutopilotEmails(later());
  const [email] = to(owner);
  expect(email!.subject).toBe("5 need you, 1 goes out in 24 hours · Big release");
  expect(email!.text.match(/Edit http/g)).toHaveLength(4);
  expect(email!.text.match(/· goes out in 24 hours/g)).toHaveLength(1);
  expect(email!.text).toMatch(/Stop http\S+\/act\?token=/);
  expect(email!.text).toContain("+1 more in Tuti");
});

test("an earlier change's done updates don't take the place kept for what goes out by itself", async () => {
  // The earlier change: one changelog line Autopilot wrote by itself (done); its request, waiting when it was
  // queued, a teammate dismissed before the email went.
  const earlier = await change("Faster search", { scheduled: false });
  await prisma.codeChangeAction.create({
    data: { codeChangeId: earlier.id, kind: "CHANGELOG_LINE", probability: 1, status: "APPLIED", decidedAt: new Date(), payload: { line: "Faster search", auto: true, autoAt: new Date().toISOString() } },
  });
  await queueAutopilotNotices(earlier.id);
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: earlier.id, kind: "RESOLVES" }, data: { status: "DISMISSED" } });
  // The later one: four needing you and one going out by itself.
  const later_ = await change("Big release");
  const postId = (await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: later_.id } })).postId!;
  await prisma.codeChangeAction.createMany({
    data: Array.from({ length: 3 }, () => ({ codeChangeId: later_.id, kind: "LINKS" as const, postId, probability: 0.7 })),
  });
  await queueAutopilotNotices(later_.id);
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: earlier.id }, data: { createdAt: new Date(Date.now() - 12 * MINUTE) } });
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: later_.id }, data: { createdAt: new Date(Date.now() - 11 * MINUTE) } });
  expect(await sendAutopilotEmails()).toBe(1);
  const [email] = to(owner);
  expect(email!.subject).toBe("4 need you, 1 goes out in 24 hours · 2 pull requests");
  expect(email!.text.match(/· goes out in 24 hours/g)).toHaveLength(1);
  expect(email!.text).toMatch(/Stop acme\/app#\d+ http\S+\/act\?token=/);
  expect(email!.text).toContain("+1 more in Tuti");
});

test("each list's updates by kind: requests it closes first, then article edits, new articles and links; each with how sure, but a changelog line", async () => {
  const one = await change("Add a dark theme", { scheduled: false });
  const postId = (await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: one.id } })).postId!;
  // Surer than the request it closes, all of them: the kind still comes first.
  await prisma.codeChangeAction.createMany({
    data: [
      { codeChangeId: one.id, kind: "LINKS", postId, probability: 0.99 },
      { codeChangeId: one.id, kind: "NEW_ARTICLE", probability: 0.98, payload: { title: "Themes", body: "Pick one." } },
      { codeChangeId: one.id, kind: "ARTICLE_EDIT", probability: 0.95, payload: { problem: "wrong", title: "Settings", before: "Light only.", body: "Light or dark." } },
      { codeChangeId: one.id, kind: "CHANGELOG_LINE", probability: 1, payload: { line: "A dark theme" } },
    ],
  });
  await queueAutopilotNotices(one.id);
  await sendAutopilotEmails(later());
  const [email] = to(owner);
  expect(email!.text).toMatch(/90% sure\s+Closes the request[\s\S]*95% sure\s+Out of date[\s\S]*98% sure\s+New article[\s\S]*Changelog line[\s\S]*99% sure\s+Link/);
  expect(email!.text).not.toContain("100% sure");
});

test("a long edit shows its first lines and says how many more; a progress update with nothing to post has Edit, not Approve", async () => {
  const one = await change("Add a dark theme", { scheduled: false });
  const postId = (await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: one.id } })).postId!;
  const paragraphs = (word: string) => ["Intro.", ...Array.from({ length: 12 }, (_, i) => `${word} paragraph ${i + 1}.`)].join("\n");
  await prisma.codeChangeAction.createMany({
    data: [
      { codeChangeId: one.id, kind: "ARTICLE_EDIT", probability: 0.8, payload: { problem: "wrong", before: paragraphs("Old"), body: paragraphs("New") } },
      { codeChangeId: one.id, kind: "MOVES_FORWARD", postId, probability: 0.8, payload: { comment: " " } },
    ],
  });
  await queueAutopilotNotices(one.id);
  await sendAutopilotEmails(later());
  const [email] = to(owner);
  // Twelve paragraphs replaced after an unchanged one: each old one then its new one. Eight lines would end on
  // "− Old paragraph 4.", so its replacement comes too (nine), then a count of the rest.
  expect(email!.text).toMatch(/Intro\.\s+− Old paragraph 1\.\s+\+ New paragraph 1\.\s+− Old paragraph 2\./);
  expect(email!.text).toMatch(/− Old paragraph 4\.\s+\+ New paragraph 4\./);
  expect(email!.text).not.toContain("Old paragraph 5.");
  expect(email!.text).toContain("16 more lines in Tuti");
  expect(email!.text).toContain("Marks it in progress: write its comment first");

  // A long paragraph changed only at its end: both its versions whole, so what Approve publishes shows.
  const long = await change("Exports", { scheduled: false });
  const start = "Exports run every night. ".repeat(20);
  await prisma.codeChangeAction.create({
    data: { codeChangeId: long.id, kind: "ARTICLE_EDIT", probability: 0.8, payload: { problem: "wrong", before: `${start}They are kept a week.`, body: `${start}They are kept a month.` } },
  });
  await queueAutopilotNotices(long.id);
  await sendAutopilotEmails(new Date(Date.now() + 30 * MINUTE));
  expect(to(owner)[1]!.text).toContain("They are kept a week.");
  expect(to(owner)[1]!.text).toContain("They are kept a month.");
  // Approve for the request it closes and the edit; the progress update only gets Edit.
  expect(email!.text.match(/Approve http\S+\/act\?token=/g)).toHaveLength(2);
});

test("what went out by itself before the email did (a short hold) is still news: the owner hears of it, under Published already", async () => {
  // The owner turned Autopilot's email off: they're told only about what customers see that goes out by itself.
  expect(await setAutopilotEmails("OFF")).toEqual({});
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  // The hold passes before the email goes: the progress update goes out by itself.
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, status: "SCHEDULED" }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(), payload: { comment: "Out soon", auto: true } } });
  expect(await sendAutopilotEmails(later())).toBe(1);
  const [email] = to(owner);
  expect(email!.subject).toBe("1 needs you, 1 went out · Add a dark theme");
  expect(email!.text).toContain("Published already");
  expect(email!.text).not.toContain("Only your team sees");
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
  expect(to(owner)[0]!.text).toContain("Published already");
  // Analysed again later: the request still waits; what went out then isn't listed again.
  await queueAutopilotNotices(one.id);
  expect(await sendAutopilotEmails(new Date(Date.now() + 25 * MINUTE))).toBe(1);
  const [, again] = to(owner);
  expect(again!.subject).toBe("1 needs you · Add a dark theme");
  expect(again!.text).not.toContain("Published already");
});

test("no hold, and the runner applies it before the notices are queued: owners still hear of it", async () => {
  expect(await setAutopilotEmails("OFF")).toEqual({});
  const one = await change("Add a dark theme");
  // Only what went out by itself is left (the request was decided already).
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, kind: "RESOLVES" }, data: { status: "DISMISSED" } });
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: one.id, status: "SCHEDULED" }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(), payload: { comment: "Out soon", auto: true } } });
  expect(await queueAutopilotNotices(one.id)).toBe(1);
  expect(await sendAutopilotEmails(later())).toBe(1);
  expect(to(owner)[0]!.subject).toBe("1 went out · Add a dark theme");
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
  expect(email!.subject).toBe("1 needs you · Add a dark theme");
  expect(email!.text).not.toContain("Published already");
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
  expect(again!.subject).toBe("1 needs you · Add a dark theme");
  expect(again!.text).not.toContain("Published already");
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
  expect(to(owner)[0]!.text).toContain("Published already");
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
  expect(email!.subject).toBe("1 went out · Add a dark theme");
  // Said as what it did, not what it will do.
  expect(email!.text).toMatch(/✅ Published already\s+Dark mode \d+ · in progress, with this comment · 97% sure\s+\+ Out soon/);
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
  expect(to(owner)[1]!.text).toMatch(/✅ Published already\s+Dark mode \d+ · in progress, with this comment · 97% sure\s+\+ Live now/);
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
  expect(email!.text).toContain("Published already");
  expect(email!.text).toMatch(/✅ Published already\s+Dark mode \d+ · in progress, with this comment · 97% sure\s+\+ Out soon/);
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
  expect(to(owner)[0]!.text).not.toContain("Published already");
  // The next email says it went.
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  expect(to(owner)[1]!.text).toContain("Published already");
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
  expect(to(owner)[0]!.text).not.toContain("Published already");
  // The next email says it went.
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  expect(to(owner)[1]!.text).toContain("Published already");
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
  expect(to(owner)[0]!.text).not.toContain("Published already");
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  expect(to(owner)[1]!.text).toContain("Published already");
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
  expect(to(owner)[0]!.text).not.toContain("Published already");
  await prisma.codeChangeAction.update({ where: { id: progress.id }, data: { payload: { comment: "Out soon", auto: true, autoAt: markedAt.toISOString() } } });
  expect(await tellOwners(one.id, progress.createdAt, { from: takenAt, to: new Date() })).toBe(1);
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  expect(to(owner)[1]!.text).toContain("Published already");
});

test("the database's own time zone doesn't move a notice queued again (it's swept ten minutes on)", async () => {
  expect(await prisma.$queryRaw`SHOW TimeZone`).toEqual([{ TimeZone: "Europe/Berlin" }]);
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { createdAt: new Date(Date.now() - 11 * MINUTE) } });
  expect(await sendAutopilotEmails()).toBe(1);
  // Analysed again: queued again now, and sent once ten minutes have passed, not before.
  await queueAutopilotNotices(one.id);
  const notice = await prisma.autopilotNotice.findFirstOrThrow({ where: { codeChangeId: one.id } });
  expect(Math.abs(notice.createdAt.getTime() - Date.now())).toBeLessThan(MINUTE);
  expect(await sendAutopilotEmails(new Date(Date.now() + 5 * MINUTE))).toBe(0);
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
});

test("an email whose read missed an update the runner saved before it was stamped read, and sent before the owners were told, is followed by one that says it went", async () => {
  const one = await change("Add a dark theme");
  await queueAutopilotNotices(one.id);
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { createdAt: new Date(Date.now() - 11 * MINUTE) } });
  const takenAt = new Date(Date.now() - 31_000);
  const progress = await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: one.id, status: "SCHEDULED" } });
  await prisma.codeChangeAction.update({ where: { id: progress.id }, data: { status: "APPLIED", dueAt: null, decidedAt: new Date(Date.now() - 30_000), payload: { comment: "Out soon" } } });
  // Right after the sweep's read, the runner saves its mark (the window's end taken then); it tells the owners only once the email is sent.
  let savedAt = new Date();
  const findMany = prisma.autopilotNotice.findMany.bind(prisma.autopilotNotice) as (...args: unknown[]) => Promise<unknown>;
  let reads = 0;
  const spy = vi.spyOn(prisma.autopilotNotice, "findMany").mockImplementation((async (...args: unknown[]) => {
    const read = await findMany(...args);
    if (++reads === 2) {
      const markedAt = new Date();
      await prisma.codeChangeAction.update({ where: { id: progress.id }, data: { payload: { comment: "Out soon", auto: true, autoAt: markedAt.toISOString() } } });
      savedAt = new Date();
    }
    return read;
  }) as never);
  expect(await sendAutopilotEmails()).toBe(1);
  spy.mockRestore();
  expect(to(owner)[0]!.text).not.toContain("Published already");
  expect(await tellOwners(one.id, progress.createdAt, { from: takenAt, to: savedAt })).toBe(1);
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  expect(to(owner)[1]!.text).toContain("Published already");
});

test("Publish now and Stop name only the updates the email shows (five in all, what needs you first); a change it shows none of gets neither", async () => {
  const one = await change("Add a dark theme");
  // Six more going out by itself: seven. The two changes' requests needing you take two of the five, so it shows three.
  for (let i = 0; i < 6; i++) {
    const post = await call(createPost, team(), { board: "feature-requests", title: `More ${i}` });
    const postId = (await prisma.post.findFirstOrThrow({ where: { projectId: project.id, number: post.number } })).id;
    await prisma.codeChangeAction.create({
      data: { codeChangeId: one.id, kind: "MOVES_FORWARD", postId, probability: 0.97, status: "SCHEDULED", dueAt: new Date(Date.now() + 24 * 3_600_000), payload: { comment: "Out soon" } },
    });
  }
  const two = await change("Faster search");
  await queueAutopilotNotices(one.id);
  await queueAutopilotNotices(two.id);
  // The first change first in the email: its updates use up what's left of the five.
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { createdAt: new Date(Date.now() - 12 * MINUTE) } });
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: two.id }, data: { createdAt: new Date(Date.now() - 11 * MINUTE) } });
  expect(await sendAutopilotEmails()).toBe(1);
  // The three it shows, in its order.
  const shown = (
    await prisma.codeChangeAction.findMany({ where: { codeChangeId: one.id, status: "SCHEDULED" }, orderBy: [{ probability: "desc" }, { id: "asc" }], select: { id: true } })
  )
    .slice(0, 3)
    .map(({ id }) => id);
  const buttons = [...to(owner)[0]!.html.matchAll(/act\?token=([\w.-]+)/g)].map((match) => readAutopilotButton(match[1]!)!);
  for (const kind of ["publish", "stop"]) {
    const named = buttons.filter((button) => button.button.startsWith(`${kind}:`));
    expect(named.map((button) => button.codeChangeId)).toEqual([one.id]);
    expect(named[0]!.button.slice(kind.length + 1).split(",")).toEqual(shown);
  }
});

test("an update a teammate stopped is in the email with Edit only, not a one-click Approve", async () => {
  const one = await change("Add a dark theme");
  const progress = await prisma.codeChangeAction.findFirstOrThrow({ where: { codeChangeId: one.id, status: "SCHEDULED" } });
  await prisma.codeChangeAction.update({ where: { id: progress.id }, data: { status: "PENDING", dueAt: null, decidedById: owner.id, waitReason: "Stopped by Olive Owner" } });
  await queueAutopilotNotices(one.id);
  await prisma.autopilotNotice.updateMany({ where: { codeChangeId: one.id }, data: { createdAt: new Date(Date.now() - 11 * MINUTE) } });
  expect(await sendAutopilotEmails()).toBe(1);
  const buttons = [...to(owner)[0]!.html.matchAll(/act\?token=([\w.-]+)/g)].map((match) => readAutopilotButton(match[1]!)!.button);
  expect(buttons).not.toContain(`approve:${progress.id}`);
  // The request it closes (not stopped) keeps its Approve.
  expect(buttons.filter((button) => button.startsWith("approve:"))).toHaveLength(1);
  expect(to(owner)[0]!.html).toContain(`select=${progress.id}`);
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
  expect(to(owner)[0]!.text).not.toContain("Published already");
  // The email is marked sent; then the runner finishes, marks it its own and tells the owners: this one's told again.
  const markedAt = new Date();
  await prisma.codeChangeAction.update({ where: { id: progress.id }, data: { status: "APPLIED", decidedById: null, decidedAt: takenAt, payload: { comment: "Out soon", auto: true, autoAt: markedAt.toISOString() } } });
  expect(await tellOwners(one.id, progress.createdAt, { from: takenAt, to: markedAt })).toBe(1);
  expect(await sendAutopilotEmails(new Date(Date.now() + 11 * MINUTE))).toBe(1);
  expect(to(owner)[1]!.text).toContain("Published already");
});

test("the daily digest: in their morning (their browser's time zone), once a day, with what still waits; none on a day with nothing", async () => {
  // Chosen with a time zone the server doesn't know: refused.
  expect(await setAutopilotEmails("DIGEST", "Mars/Olympus")).toEqual({ error: "Your browser didn't say which time zone you're in" });
  expect(await setAutopilotEmails("DIGEST", "Europe/Berlin")).toEqual({});
  // As they happen: nothing for a digest reader (nothing goes out by itself here).
  const waiting = await change("Add a dark theme", { scheduled: false });
  await queueAutopilotNotices(waiting.id);
  expect(await prisma.autopilotNotice.count({ where: { codeChangeId: waiting.id } })).toBe(0);
  // 7:00 in Berlin: not yet. 8:30: the digest. Again at 8:45: not twice.
  expect(await sendAutopilotDigests(new Date("2026-11-02T06:00:00Z"))).toBe(0);
  expect(await sendAutopilotDigests(new Date("2026-11-02T07:30:00Z"))).toBe(1);
  expect(await sendAutopilotDigests(new Date("2026-11-02T07:45:00Z"))).toBe(0);
  const [digest] = to(owner);
  expect(digest!.subject).toBe("1 still needs you · Add a dark theme");
  expect(digest!.text).toMatch(/✋ 1 Still needs your approval[\s\S]*Dark mode \d+\s+90% sure\s+Closes the request/);
  // A day the sweep ran late (11:00 in Berlin): still that day's, once.
  expect(await sendAutopilotDigests(new Date("2026-11-03T10:00:00Z"))).toBe(1);
  expect(await sendAutopilotDigests(new Date("2026-11-03T10:01:00Z"))).toBe(0);
  // Autopilot turned off on the project: what's left waiting there isn't news.
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: false } });
  expect(await sendAutopilotDigests(new Date("2026-11-04T07:30:00Z"))).toBe(0);
  await prisma.project.update({ where: { id: project.id }, data: { analyseCodeChanges: true } });
  // A morning with nothing waiting any more: none.
  await prisma.codeChangeAction.updateMany({ where: { codeChangeId: waiting.id }, data: { status: "DISMISSED" } });
  expect(await sendAutopilotDigests(new Date("2026-11-05T07:10:00Z"))).toBe(0);
  expect(to(owner)).toHaveLength(2);
});

test("the digest of each project goes on its own: one that fails is tried again a while later, without the other going twice", async () => {
  expect(await setAutopilotEmails("DIGEST", "Europe/Berlin")).toEqual({});
  await change("Add a dark theme", { scheduled: false });
  const first = project;
  project = await createProject(owner);
  await change("Faster search", { scheduled: false });
  const second = project;
  project = first;
  vi.spyOn(log, "error").mockImplementation(() => {});
  // The first one the sweep sends is refused for now.
  mailbox.refuseNext(owner.email, { code: 421 });
  expect(await sendAutopilotDigests(new Date("2026-11-02T07:30:00Z"))).toBe(1);
  // Within the wait: nothing again.
  expect(await sendAutopilotDigests(new Date("2026-11-02T07:31:00Z"))).toBe(0);
  // Its claim lapsed: that one goes, the other not again.
  await prisma.autopilotDigest.updateMany({ where: { userId: owner.id, sentAt: null }, data: { claimedAt: new Date(Date.now() - 16 * MINUTE) } });
  expect(await sendAutopilotDigests(new Date("2026-11-02T07:47:00Z"))).toBe(1);
  const digests = to(owner);
  expect(digests).toHaveLength(2);
  for (const named of [first.name, second.name]) {
    expect(digests.filter((email) => email.text.includes(named))).toHaveLength(1);
  }
});

test("the digest shows the newest five updates and counts the rest, and goes to those told, not a member who isn't", async () => {
  expect(await setAutopilotEmails("DIGEST", "Europe/Berlin")).toEqual({});
  const member = await signUp("Max Member");
  await prisma.teamMember.create({ data: { projectId: project.id, userId: member.id, role: "MEMBER" } });
  await prisma.user.update({ where: { id: member.id }, data: { autopilotEmails: "DIGEST", autopilotTimeZone: "Europe/Berlin" } });
  const titles: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const c = await change(`Change ${i}`, { scheduled: false });
    await prisma.codeChange.update({ where: { id: c.id }, data: { mergedAt: new Date(Date.now() - (8 - i) * 3_600_000) } });
    titles.push(`Change ${i}`);
  }
  expect(await sendAutopilotDigests(new Date("2026-11-02T07:30:00Z"))).toBe(1);
  expect(to(member)).toHaveLength(0);
  const [digest] = to(owner);
  expect(digest!.subject).toBe("7 still need you · 7 pull requests");
  // The five newest, each with its update; the two oldest only counted.
  for (const title of titles.slice(2)) {
    expect(digest!.text).toContain(title);
  }
  for (const title of titles.slice(0, 2)) {
    expect(digest!.text).not.toContain(`${title}\n`);
  }
  expect(digest!.text).toContain("+2 more in Tuti");
});

test("chosen again from a time zone further west, the digest still comes that morning", async () => {
  expect(await setAutopilotEmails("DIGEST", "Asia/Tokyo")).toEqual({});
  await change("Add a dark theme", { scheduled: false });
  // 8:30 on the 3rd in Tokyo.
  await sendAutopilotDigests(new Date("2026-11-02T23:30:00Z"));
  expect(to(owner)).toHaveLength(1);
  // Now in Los Angeles: 8:30 on the 3rd there, a day already sent from Tokyo, so not again; the 4th's comes.
  expect(await setAutopilotEmails("DIGEST", "America/Los_Angeles")).toEqual({});
  await sendAutopilotDigests(new Date("2026-11-03T16:30:00Z"));
  expect(to(owner)).toHaveLength(1);
  await sendAutopilotDigests(new Date("2026-11-04T16:30:00Z"));
  expect(to(owner)).toHaveLength(2);
});

test("a digest claimed late in a long sweep is claimed as of then: a sweep starting meanwhile doesn't take it again", async () => {
  expect(await setAutopilotEmails("DIGEST", "Europe/Berlin")).toEqual({});
  await change("Add a dark theme", { scheduled: false });
  // The sweep reaches this reader 20 minutes after it started (lots of readers before, a slow mail server).
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-02T07:30:00Z") });
  try {
    const findMany = prisma.teamMember.findMany.bind(prisma.teamMember) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(prisma.teamMember, "findMany").mockImplementationOnce((async (...args: unknown[]) => {
      vi.setSystemTime(new Date("2026-11-02T07:50:00Z"));
      return findMany(...args);
    }) as never);
    expect(await sendAutopilotDigests(new Date("2026-11-02T07:30:00Z"))).toBeGreaterThanOrEqual(1);
    const claim = await prisma.autopilotDigest.findFirstOrThrow({ where: { userId: owner.id } });
    expect(claim.claimedAt!.getTime()).toBeGreaterThanOrEqual(new Date("2026-11-02T07:50:00Z").getTime());
  } finally {
    vi.useRealTimers();
  }
});

test("a mail server down for a while (not refusing the address) doesn't use up the digest's tries", async () => {
  expect(await setAutopilotEmails("DIGEST", "Europe/Berlin")).toEqual({});
  await change("Add a dark theme", { scheduled: false });
  vi.spyOn(log, "error").mockImplementation(() => {});
  // Six sweeps in a row the server answers "try later" (421), each after the claim lapsed.
  for (let i = 0; i < 6; i++) {
    mailbox.refuseNext(owner.email, { code: 421 });
    await prisma.autopilotDigest.updateMany({ where: { userId: owner.id, sentAt: null }, data: { claimedAt: new Date(Date.now() - 16 * MINUTE) } });
    await sendAutopilotDigests(new Date("2026-11-02T07:30:00Z"));
  }
  expect(to(owner)).toHaveLength(0);
  // Back up: it goes.
  await prisma.autopilotDigest.updateMany({ where: { userId: owner.id, sentAt: null }, data: { claimedAt: new Date(Date.now() - 16 * MINUTE) } });
  await sendAutopilotDigests(new Date("2026-11-02T09:00:00Z"));
  expect(to(owner)).toHaveLength(1);
});

test("once a reader's digests for the day are sent, later sweeps that day don't claim them again (nor read their teams one by one)", async () => {
  expect(await setAutopilotEmails("DIGEST", "Europe/Berlin")).toEqual({});
  await change("Add a dark theme", { scheduled: false });
  await sendAutopilotDigests(new Date("2026-11-02T07:30:00Z"));
  expect(to(owner)).toHaveLength(1);
  // (Counted from here: an earlier test's spy may be the one returned.)
  const claims = vi.spyOn(prisma.autopilotDigest, "createMany");
  const teams = vi.spyOn(prisma.teamMember, "findMany");
  claims.mockClear();
  teams.mockClear();
  await sendAutopilotDigests(new Date("2026-11-02T09:00:00Z"));
  expect(claims.mock.calls.filter(([args]) => JSON.stringify(args).includes(owner.id))).toHaveLength(0);
  expect(teams).toHaveBeenCalledTimes(1);
  expect(to(owner)).toHaveLength(1);
});

test("the digest chosen in the afternoon doesn't come straight away: the next morning", async () => {
  expect(await setAutopilotEmails("DIGEST", "Europe/Berlin")).toEqual({});
  await change("Add a dark theme", { scheduled: false });
  // 14:00 and 21:30 in Berlin: not a morning.
  await sendAutopilotDigests(new Date("2026-11-02T13:00:00Z"));
  await sendAutopilotDigests(new Date("2026-11-02T20:30:00Z"));
  expect(to(owner)).toHaveLength(0);
  // 8:15 the next day.
  await sendAutopilotDigests(new Date("2026-11-03T07:15:00Z"));
  expect(to(owner)).toHaveLength(1);
});
