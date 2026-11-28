import { prisma } from "@tuti/db";
import { handlers } from "@tuti/jobs";
import { TRPCError } from "@trpc/server";
import { expect, test } from "vitest";

import { actAs as signIn, callerAs, createProject, failTransaction, signUp, type TestUser } from "@/test/helpers";

import { loadConversationActivity } from "./inbox";
import { runWorkflows } from "./inbox-path";
import { getConversationActivity } from "./operations/conversation-activity";
import { OperationError } from "./operations/define";
import { addMessage, createConversation, replyToConversation, startConversation, updateConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { createWorkflow, deleteWorkflow } from "./operations/workflows";
import { deleteUser } from "./operations/users";
import { removeMember } from "./team";
import { upsertProjectUser } from "./project-users";
import { spamVerdict } from "./spam";

/** Who the app's calls below act as: `actAs` signs them in for server actions, and tRPC calls go as them too. */
let acting: TestUser | null = null;
const actAs = (user: TestUser | null) => {
  acting = user;
  signIn(user);
};

/** A call from the Inbox through tRPC, as an action's was: `{}`, the refusal's message, or what went wrong thrown. */
async function fromInbox(run: (caller: Awaited<ReturnType<typeof callerAs>>) => Promise<unknown>) {
  try {
    await run(await callerAs(acting));
    return {};
  } catch (error) {
    if (error instanceof TRPCError && error.cause instanceof OperationError) {
      return { error: error.message };
    }
    throw error instanceof TRPCError && error.cause ? error.cause : error;
  }
}
/** The Inbox's Status, Assign and Report spam (conversations.update through tRPC). */
const save = (slug: string, number: number, change: { status?: "closed"; assignee?: string; spam?: boolean }) => fromInbox((caller) => caller.conversations.update({ project: slug, number, ...change }));

/**
 * A conversation's Activity (docs/plan.md, Inbox automation, W16): one row per event, written with the change it
 * describes, as conversations.activity tells it.
 */

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const projectId = project.id;
  await prisma.project.update({ where: { id: projectId }, data: { supportInbox: true } });
  await prisma.readerGroup.create({ data: { projectId, key: "vip", name: "VIP", conditions: [{ property: "plan", op: "is", value: "vip" }] } });
  const admin = { actor: { kind: "user" as const, userId: owner.id }, projectId };
  const key = await prisma.apiKey.create({ data: { projectId, name: "Zapier", scope: "WRITE", keyHash: `hash-${projectId}`, prefix: "tuti_ab", createdById: owner.id } });
  const viaKey = { actor: { kind: "apiKey" as const, keyId: key.id, projectId, scope: "write" as const, createdById: owner.id }, projectId };
  /**
   * The Activity as the API tells it, newest first: "<who> <text>[ · <detail>]", and each workflow a run checked. Without
   * the handover every new conversation gets while nothing answers for the AI ("Handed to the team · the AI is off"):
   * handover.db.test.ts has those.
   */
  const activity = async (number: number, filter: "all" | "workflows" | "people" = "all") =>
    (await call(getConversationActivity, admin, { number, filter, limit: 100 })).events.filter((event) => event.kind !== "handed_over").map((event) =>
      [[event.who, event.text].filter(Boolean).join(" ") + (event.detail ? ` · ${event.detail}` : ""), ...event.workflows.map((w) => `  ${w.name} · ${w.what}`)].join("\n"),
    );
  return { owner, project, projectId, admin, key, viaKey, activity };
}

test("a trigger's run is one row with every workflow it checked, a run that matched nothing too; never two for one message", async () => {
  const { projectId, admin, activity } = await setup();
  const vips = await call(createWorkflow, admin, { name: "VIPs first", trigger: "conversation_started", conditions: [{ kind: "in_group", group: "vip" }], actions: [{ kind: "mark_priority" }] });
  await upsertProjectUser(projectId, "user-1", { name: "Sam", properties: { plan: "free" } });

  // Nothing matched: still recorded, with why.
  const { number } = await call(createConversation, admin, { user: { id: "user-1" }, body: "Hello" });
  expect(await activity(number)).toEqual(["A conversation starts ran · 1 workflow checked\n  VIPs first · didn't match (not in VIP)"]);

  // Run again for the same message (a retry): no second row.
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number } }, include: { messages: true } });
  await runWorkflows(projectId, conversation.id, conversation.messages[0]!.id, "conversation_started");
  await Promise.all([1, 2].map(() => runWorkflows(projectId, conversation.id, conversation.messages[0]!.id, "conversation_started")));
  expect(await activity(number)).toHaveLength(1);

  // A matching one, then the workflow deleted: the row still reads as it did, and nothing is in the thread.
  await upsertProjectUser(projectId, "user-1", { properties: { plan: "vip" } });
  await call(createWorkflow, admin, { name: "Everyone", trigger: "conversation_started", actions: [{ kind: "mark_priority" }] });
  const second = await call(createConversation, admin, { user: { id: "user-1" }, body: "Hello again" });
  const told = ["A conversation starts ran · 2 workflows checked\n  VIPs first · marked this priority\n  Everyone · matched, nothing to change"];
  expect(await activity(second.number)).toEqual(told);
  await call(deleteWorkflow, admin, { id: vips.id });
  expect(await activity(second.number)).toEqual(told);
  expect(await prisma.conversationMessage.count({ where: { conversation: { projectId }, author: "TUTI" } })).toBe(0);

  // A trigger with no workflow on writes nothing.
  const third = await call(replyToConversation, { ...admin, actor: { kind: "apiKey", keyId: "none", projectId, scope: "write", createdById: admin.actor.userId } }, { number: second.number, body: "More", author: { id: "user-1" } });
  expect(third).toMatchObject({ author: "user" });
  expect(await activity(second.number)).toEqual(told);
}, 20_000);

test("the spam filter's verdict is written where the conversation starts, and never without it", async () => {
  const { projectId, activity } = await setup();
  await prisma.spamRule.create({ data: { projectId, field: "sender_domain", matcher: "is", value: "spam.example" } });
  const start = (email: string) =>
    startConversation(projectId, {
      userId: null,
      email,
      body: "Hello",
      origin: "EMAIL",
      channel: "EMAIL",
      filter: (tx, first) => spamVerdict(tx, { projectId, address: email, userId: null, proven: true, email: { sender: email, dmarc: "pass" }, ...first }),
    });
  const filed = await start("e2e-kim@spam.example");
  expect(await activity(filed.conversation.number)).toEqual(["Spam filter filed it as spam · you blocked this address's domain"]);
  const through = await start("e2e-lee@example.com");
  expect(await activity(through.conversation.number)).toEqual(["Spam filter let it through · no check filed it"]);

  // The conversation's transaction failing writes neither.
  failTransaction(new Error("connection reset"));
  await expect(start("e2e-ann@example.com")).rejects.toThrow("connection reset");
  expect(await prisma.conversationEvent.count({ where: { conversation: { projectId } } })).toBe(2);
});

test("a teammate's changes, in the app and by the API, each with who did it; an API key is credited by its name", async () => {
  const { owner, project, projectId, admin, key, viaKey, activity } = await setup();
  const member = await signUp("Mo Member");
  await prisma.teamMember.create({ data: { projectId, userId: member.id, role: "MEMBER" } });
  const { number } = await call(createConversation, admin, { email: "e2e-sam@example.com", body: "Hello" });

  // In the app.
  actAs(owner);
  expect(await save(project.slug, number, { status: "closed" })).toEqual({});
  expect(await save(project.slug, number, { assignee: owner.email })).toEqual({});
  expect(await save(project.slug, number, { spam: true })).toEqual({});
  // Changing nothing writes nothing.
  expect(await save(project.slug, number, { status: "closed" })).toEqual({});
  // By the API: the key, never its creator.
  await call(updateConversation, viaKey, { number, spam: false, status: "open", assignee: member.email, priority: true, handledBy: "ai" });
  await call(updateConversation, viaKey, { number, handledBy: "team" });

  const all = [
    "The API key “Zapier” took it over from the AI · Take over",
    "The API key “Zapier” handed it back to the AI",
    "The API key “Zapier” marked it priority",
    "The API key “Zapier” assigned it to Mo Member",
    "The API key “Zapier” reopened it",
    "The API key “Zapier” marked it not spam",
    "Olive Owner marked it as spam",
    "Olive Owner assigned it to themselves",
    "Olive Owner closed it",
  ];
  expect(await activity(number)).toEqual(all);
  expect(await activity(number, "people")).toEqual(all);
  expect(await activity(number, "workflows")).toEqual([]);

  // The key deleted, the teammate gone: the rows still say who, as far as they can.
  await prisma.apiKey.delete({ where: { id: key.id } });
  await prisma.user.delete({ where: { id: member.id } });
  expect((await activity(number))[3]).toBe("The API key “Zapier” assigned it to a former teammate");
  await prisma.teamMember.deleteMany({ where: { projectId, userId: owner.id } });
  const other = await signUp("Other Owner");
  await prisma.teamMember.create({ data: { projectId, userId: other.id, role: "OWNER" } });
  await prisma.user.delete({ where: { id: owner.id } });
  const asOther = { actor: { kind: "user" as const, userId: other.id }, projectId };
  // The oldest but one: the oldest is the handover it got as it started.
  expect((await call(getConversationActivity, asOther, { number })).events.at(-2)).toMatchObject({ actor: "teammate", who: "A former teammate", text: "closed it" });
}, 20_000);

test("a teammate's reply takes it over and sets it waiting in its Activity, with the reply; a note doesn't, and a failed change writes nothing", async () => {
  const { admin, viaKey, activity } = await setup();
  const { number } = await call(createConversation, admin, { email: "e2e-sam@example.com", body: "Hello" });
  await call(updateConversation, admin, { number, handledBy: "ai" });
  await call(replyToConversation, admin, { number, body: "A note", note: true });
  await call(replyToConversation, admin, { number, body: "On it" });
  // Already the team's: the next reply takes nothing over.
  await call(replyToConversation, admin, { number, body: "Still on it" });
  await call(updateConversation, admin, { number, handledBy: "ai" });
  await call(replyToConversation, viaKey, { number, body: "From the key" });
  expect(await activity(number)).toEqual([
    "The API key “Zapier” took it over from the AI · by replying",
    "Olive Owner handed it back to the AI",
    "Olive Owner set it waiting on the user · by replying",
    "Olive Owner took it over from the AI · by replying",
    "Olive Owner handed it back to the AI",
  ]);

  failTransaction(new Error("connection reset"));
  await expect(call(updateConversation, admin, { number, status: "closed" })).rejects.toThrow("connection reset");
  failTransaction(new Error("connection reset"));
  await expect(call(replyToConversation, admin, { number, body: "Done", close: true })).rejects.toThrow("connection reset");
  expect(await activity(number)).toHaveLength(5);
});

test("what a message changes on the way: a reply setting it waiting or closing it, the person's message reopening it or ending its snooze, a Cc'd colleague's said as theirs, and a snooze ending by itself", async () => {
  const { projectId, admin, viaKey, activity } = await setup();
  await upsertProjectUser(projectId, "user-1", { name: "Sam Smith", email: "e2e-sam-smith@example.com", properties: { company: "Acme" } });
  const { number } = await call(createConversation, admin, { user: { id: "user-1" }, body: "Hello" });
  const write = () => call(replyToConversation, viaKey, { number, body: "And another thing", author: { id: "user-1" } });

  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });

  // Waiting on them, then open again as they write.
  await call(replyToConversation, admin, { number, body: "Looking into it" });
  await write();
  await call(replyToConversation, admin, { number, body: "Fixed", close: true });
  // Someone else on the email thread opens it again: said so, without who.
  await addMessage(conversation.id, projectId, { author: "USER", authorId: null, channel: "EMAIL", body: "Me too", fromAddress: "e2e-bob@example.com" });
  await call(updateConversation, admin, { number, snoozedUntil: new Date(Date.now() + 86_400_000).toISOString() });
  await write();
  await call(updateConversation, admin, { number, snoozedUntil: new Date(Date.now() + 86_400_000).toISOString() });
  // A row timed ahead of the wake job's clock (another server's, running ahead): the snooze's end still comes after it.
  await prisma.conversationEvent.create({ data: { conversationId: conversation.id, kind: "priority", actor: "teammate", actorId: admin.actor.userId, details: { priority: true }, createdAt: new Date(Date.now() + 60_000) } });
  // Its time passes: the wake job ends it.
  await prisma.conversation.update({ where: { id: conversation.id }, data: { snoozedUntil: new Date(Date.now() - 1000) } });
  expect(await handlers.wakeConversations({}, { info: () => {}, warn: () => {} })).toMatchObject({ woken: 1 });

  const rows = await activity(number);
  expect(rows.map((row) => row.replace(/ · until .*/, " · until …"))).toEqual([
    "Its snooze ended",
    "Olive Owner marked it priority",
    "Olive Owner snoozed it · until …",
    "Sam Smith ended its snooze · by writing",
    "Olive Owner snoozed it · until …",
    "Someone else on the email thread reopened it · by writing",
    "Olive Owner closed it · by replying",
    "Sam Smith reopened it · by writing",
    "Olive Owner set it waiting on the user · by replying",
  ]);
  expect(await prisma.conversationEvent.count({ where: { conversationId: conversation.id, details: { string_contains: "e2e-bob" } } })).toBe(0);
  // The person's rows are under People; the wake job's under Workflows, with the built-in steps.
  expect(await activity(number, "people")).toHaveLength(8);
  expect(await activity(number, "workflows")).toEqual(["Its snooze ended"]);
  // Nothing of theirs is in a row: erased by users.delete, their rows say so, as the conversation does.
  const stored = async () => JSON.stringify(await prisma.conversationEvent.findMany({ where: { conversation: { projectId, number } } }));
  for (const theirs of ["Sam", "e2e-sam-smith@example.com", "Acme"]) {
    expect(await stored()).not.toContain(theirs);
  }
  await call(deleteUser, admin, { user: "user-1" });
  expect(await stored()).not.toContain("e2e-sam-smith@example.com");
  expect((await activity(number)).filter((row) => row.startsWith("Deleted user "))).toEqual(["Deleted user ended its snooze · by writing", "Deleted user reopened it · by writing"]);
});

test("a reply that leaves it open (the person wrote after what the teammate saw) writes no status row; it still takes it over", async () => {
  const { projectId, admin, viaKey, activity } = await setup();
  await upsertProjectUser(projectId, "user-1", { name: "Sam Smith" });
  const { number } = await call(createConversation, admin, { user: { id: "user-1" }, body: "Hello" });
  await call(updateConversation, admin, { number, handledBy: "ai" });
  // Kept with the AI as the person writes, rather than handed over (nothing answers for the AI yet).
  await call(createWorkflow, admin, { name: "Keep", trigger: "about_to_hand_over", actions: [{ kind: "dont_hand_over" }] });
  // The teammate's page shows the conversation as it is; then the person writes again.
  const { lastMessageAt: seen } = await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
  await call(replyToConversation, viaKey, { number, body: "Hello?", author: { id: "user-1" } });
  expect(await call(replyToConversation, admin, { number, body: "On it", seen: seen.toISOString() })).toMatchObject({ keptOpen: true });
  expect(await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } })).toMatchObject({ status: "OPEN", handledBy: "TEAM" });
  expect(await activity(number)).toEqual([
    "Olive Owner took it over from the AI · by replying",
    "A conversation is about to go to a person ran · 1 workflow checked · the AI is off\n  Keep · kept it with the AI",
    "Olive Owner handed it back to the AI",
  ]);
});

test("newest first, a page at a time, the team's only; deleted with its conversation", async () => {
  const { project, projectId, admin, activity } = await setup();
  const { number } = await call(createConversation, admin, { email: "e2e-sam@example.com", body: "Hello" });
  for (const priority of [true, false, true, false, true]) {
    await call(updateConversation, admin, { number, priority });
  }
  const first = await call(getConversationActivity, admin, { number, limit: 2 });
  expect(first.events.map((e) => e.text)).toEqual(["marked it priority", "took its priority off"]);
  const second = await call(getConversationActivity, admin, { number, limit: 2, before: first.next! });
  const third = await call(getConversationActivity, admin, { number, limit: 2, before: second.next! });
  // The fifth and sixth: the first change, and the handover it got as it started.
  expect([second.events.length, third.events.length, third.next]).toEqual([2, 2, null]);
  expect(new Set([...first.events, ...second.events, ...third.events].map((e) => e.id)).size).toBe(6);

  // Someone outside the team gets nothing.
  actAs(await signUp("Stranger"));
  expect(await loadConversationActivity(project.slug, number, "all")).toHaveProperty("error");

  // A row of a kind this release can't read (a later one's) is left out.
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
  await prisma.conversationEvent.create({ data: { conversationId: conversation.id, kind: "later_kind", actor: "ai", details: {} } });
  expect(await activity(number)).toHaveLength(5);

  await prisma.conversation.delete({ where: { id: conversation.id } });
  expect(await prisma.conversationEvent.count({ where: { conversationId: conversation.id } })).toBe(0);
});

test("a teammate taken off the team: each conversation they had unassigned in its Activity, by whoever removed them, with why", async () => {
  const { owner, project, projectId, admin, activity } = await setup();
  const member = await signUp("Mo Member");
  const membership = await prisma.teamMember.create({ data: { projectId, userId: member.id, role: "MEMBER" } });
  const numbers = [];
  for (const body of ["One", "Two"]) {
    const { number } = await call(createConversation, admin, { email: "e2e-sam@example.com", body });
    await call(updateConversation, admin, { number, assignee: member.email });
    numbers.push(number);
  }
  const other = (await call(createConversation, admin, { email: "e2e-sam@example.com", body: "Three" })).number;

  actAs(owner);
  expect(await removeMember(project.slug, membership.id)).toEqual({});
  for (const number of numbers) {
    expect(await activity(number)).toEqual(["Olive Owner unassigned it · Mo Member left the team", "Olive Owner assigned it to Mo Member"]);
  }
  expect(await activity(other)).toEqual([]);
});

test("a snooze a teammate ends by hand is a row of theirs; ending one that isn't set writes nothing", async () => {
  const { admin, activity } = await setup();
  const { number } = await call(createConversation, admin, { email: "e2e-sam@example.com", body: "Hello" });
  await call(updateConversation, admin, { number, snoozedUntil: new Date(Date.now() + 86_400_000).toISOString() });
  await call(updateConversation, admin, { number, snoozedUntil: null });
  expect((await activity(number))[0]).toBe("Olive Owner ended its snooze");
  const rows = (await activity(number)).length;
  await call(updateConversation, admin, { number, snoozedUntil: null });
  expect(await activity(number)).toHaveLength(rows);
});
