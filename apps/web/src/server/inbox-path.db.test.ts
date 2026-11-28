import { randomUUID } from "node:crypto";

import { prisma } from "@tuti/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { widgetToken } from "@/server/auth/widget-session";
import { actAs, createProject, failTransaction, signUp } from "@/test/helpers";
import { postEmail, rawEmail } from "@/test/inbound";
import { mailbox } from "@/test/mailbox";
import { request } from "@/test/next-headers";

import { escalateDocs } from "./docs-readers";
import { runWorkflows } from "./inbox-path";
import { mailSubdomain, supportAddress } from "./inbound";
import { createConversation, replyToConversation, startConversation, updateConversation } from "./operations/conversations";
import { call } from "./operations/run";
import { createWorkflow, moveWorkflow, updateWorkflow } from "./operations/workflows";
import { upsertProjectUser } from "./project-users";
import { widgetSendMessage, widgetStartConversation } from "./widget-inbox";

/**
 * The path a user's message takes (docs/plan.md, Inbox automation, W8): the team's workflows for "A conversation
 * starts" and "A user replies", run by every way a message arrives, then the team is told as before.
 */

const DOMAIN = "tuti.email";

beforeEach(() => {
  vi.stubEnv("SUPPORT_EMAIL_DOMAIN", DOMAIN);
  vi.stubEnv("INBOUND_SECRET", "test-inbound-secret");
});
afterEach(() => vi.unstubAllEnvs());

type Trigger = "conversation_started" | "user_replied";

async function setup() {
  const owner = await signUp("Olive Owner");
  const project = await createProject(owner);
  const projectId = project.id;
  await prisma.project.update({ where: { id: projectId }, data: { supportInbox: true } });
  // Whoever's plan is "vip", by what the project's app says of its users.
  await prisma.readerGroup.create({ data: { projectId, key: "vip", name: "VIP", conditions: [{ property: "plan", op: "is", value: "vip" }] } });
  await prisma.webhook.create({
    data: { projectId, url: "https://hooks.example.com/tuti", secret: "secret", events: ["conversation.created", "conversation.message_created"], createdById: owner.id },
  });
  const admin = { actor: { kind: "user" as const, userId: owner.id }, projectId };
  const to = supportAddress(await mailSubdomain(projectId), DOMAIN);
  actAs(null);
  const conversation = (number: number) => prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number } } });
  return {
    owner,
    project,
    projectId,
    admin,
    /** A workflow that marks priority, for everyone unless it's for a group. */
    workflow: (name: string, trigger: Trigger, group?: string) =>
      call(createWorkflow, admin, { name, trigger, conditions: group ? [{ kind: "in_group", group }] : [], actions: [{ kind: "mark_priority" }] }),
    /** A conversation someone from the project's app starts over the API; its number. */
    start: async (user: string) => (await call(createConversation, admin, { user: { id: user }, body: "Hello" })).number,
    /** Their next message in it, over the API. */
    reply: (number: number, user: string) => call(replyToConversation, { ...admin, actor: apiKey(owner.id, projectId) }, { number, body: "And another thing", author: { id: user } }),
    /** An email to the project's address, or to a conversation's reply address. */
    mail: async (from: string, recipient = to) => {
      expect(await postEmail(rawEmail({ from, to: recipient }), { recipient })).toEqual({ status: 200, body: { outcome: "added" } });
    },
    replyAddress: async (number: number) => supportAddress(await mailSubdomain(projectId), DOMAIN, (await conversation(number)).replyToken),
    priority: async (number: number) => (await conversation(number)).priority,
    /** Set back by hand, as a teammate would: what the next workflow does then shows. */
    unmark: (number: number) => call(updateConversation, admin, { number, priority: false }),
    /**
     * What the workflows did in a conversation, oldest first, by its Activity (W16): "<workflow> <what it did>" for each
     * one that changed something. The thread keeps no note of it (W8 wrote one, till W16).
     */
    notes: async (number: number) => {
      expect(await prisma.conversationMessage.count({ where: { conversation: { projectId, number }, author: "TUTI" } })).toBe(0);
      const runs = await prisma.conversationEvent.findMany({
        where: { conversation: { projectId, number }, kind: "workflows_ran" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { actor: true, details: true },
      });
      return runs.flatMap((run) => {
        expect(run.actor).toBe("workflow");
        const { workflows } = run.details as { workflows: { name: string; did: string[] }[] };
        return workflows.filter((w) => w.did.length > 0).map((w) => `${w.name} ${w.did.map((kind) => (kind === "mark_priority" ? "marked this priority" : kind)).join(", ")}`);
      });
    },
    /** What the project's webhooks were told, oldest first: each event and whether the conversation was priority. */
    told: async () =>
      (await prisma.webhookDelivery.findMany({ where: { webhook: { projectId } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { event: true, payload: true } })).map(
        (delivery) => `${delivery.event}${(delivery.payload as { data?: { priority?: boolean } }).data?.priority ? " priority" : ""}`,
      ),
  };
}

/** A read and write API key of the project's, which may write as one of its users. */
const apiKey = (createdById: string, projectId: string) => ({ kind: "apiKey" as const, keyId: "key", projectId, scope: "write" as const, createdById });

/** The team's emails about new conversations. */
const emailed = (address: string) => mailbox.emails.filter((email) => email.to.includes(address) && /^New conversation/.test(email.subject)).length;

test("a trigger's list runs once, top to bottom: the workflows that are on, each one that acted in its Activity, and the team is told as before", async () => {
  const { admin, owner, workflow, start, priority, notes, told } = await setup();
  const first = await workflow("Everyone first", "conversation_started");
  const second = await workflow("Second look", "conversation_started");
  expect([first.position, second.position]).toEqual([0, 1]);

  // The first marks it; the second runs too (a marking action never ends the list) and finds nothing to do: no note.
  expect(await start("user-1")).toBe(1);
  expect([await priority(1), await notes(1)]).toEqual([true, ["Everyone first marked this priority"]]);
  // The team's email and the webhook go out once, as the workflows left it.
  expect([await told(), emailed(owner.email)]).toEqual([["conversation.created priority"], 1]);

  // Moved up, the other is first.
  await call(moveWorkflow, admin, { id: second.id, position: 0 });
  expect(await notes(await start("user-2"))).toEqual(["Second look marked this priority"]);

  // Off, it doesn't run: the next one does.
  await call(updateWorkflow, admin, { id: second.id, enabled: false });
  expect(await notes(await start("user-3"))).toEqual(["Everyone first marked this priority"]);

  // None on: nothing is marked, and nothing is noted.
  await call(updateWorkflow, admin, { id: first.id, enabled: false });
  const number = await start("user-4");
  expect([await priority(number), await notes(number)]).toEqual([false, []]);
});

test("the two triggers never fire for the same message, and nothing a workflow or a teammate changed starts one", async () => {
  const { admin, workflow, start, reply, priority, unmark, notes } = await setup();
  await workflow("New ones", "conversation_started");
  await workflow("Replies", "user_replied");

  // The first message runs "A conversation starts" alone: its note and its mark start nothing more.
  const number = await start("user-1");
  expect(await notes(number)).toEqual(["New ones marked this priority"]);
  // Nor does a teammate's change, a reply or a note of theirs.
  await unmark(number);
  await call(replyToConversation, admin, { number, body: "On it" });
  await call(replyToConversation, admin, { number, body: "Ask billing", note: true });
  expect([await priority(number), await notes(number)]).toEqual([false, ["New ones marked this priority"]]);

  // A later message from the user runs "A user replies" alone, one that reopens a closed conversation included.
  await call(updateConversation, admin, { number, status: "closed" });
  await reply(number, "user-1");
  expect([await priority(number), await notes(number)]).toEqual([true, ["New ones marked this priority", "Replies marked this priority"]]);
  // Each of their messages runs it again: marked already, there's nothing to do or note.
  await reply(number, "user-1");
  expect(await notes(number)).toHaveLength(2);
  await unmark(number);
  await reply(number, "user-1");
  expect(await notes(number)).toEqual(["New ones marked this priority", "Replies marked this priority", "Replies marked this priority"]);
});

test("a workflow for a group goes by the groups the person is in when it runs, not when the conversation began", async () => {
  const { projectId, workflow, start, reply, priority, notes } = await setup();
  await workflow("VIPs first", "conversation_started", "vip");
  await workflow("VIPs' replies", "user_replied", "vip");

  await upsertProjectUser(projectId, "user-1", { name: "Sam", properties: { plan: "free" } });
  const number = await start("user-1");
  await reply(number, "user-1");
  expect([await priority(number), await notes(number)]).toEqual([false, []]);

  // In the group since: their next message is marked.
  await upsertProjectUser(projectId, "user-1", { properties: { plan: "vip" } });
  await reply(number, "user-1");
  expect([await priority(number), await notes(number)]).toEqual([true, ["VIPs' replies marked this priority"]]);
  // And a conversation they start now.
  expect(await notes(await start("user-1"))).toEqual(["VIPs first marked this priority"]);
});

test("someone Tuti doesn't know is in no group: a signed-out visitor, an address that isn't a user's, a portal account", async () => {
  const { project, projectId, admin, workflow, start, mail, priority, notes } = await setup();
  // A group whose condition a user without the property matches: only one of the project's users can be in it.
  await prisma.readerGroup.create({ data: { projectId, key: "no-plan", name: "No plan", conditions: [{ property: "plan", op: "is_not_set" }] } });
  await workflow("No plan yet", "conversation_started", "no-plan");

  // A signed-out visitor, who typed an address.
  expect(await widgetStartConversation(project.slug, {}, "Hello", "e2e-visitor@example.com")).toMatchObject({ number: 1 });
  // An address that isn't a user's, by email and over the API.
  await mail("e2e-stranger@example.com"); // #2
  await call(createConversation, admin, { email: "e2e-other@example.com", body: "Hello" }); // #3
  // Someone with a portal account: known, but the project's app says nothing of them.
  const reader = await signUp("Reader");
  await startConversation(projectId, { userId: reader.id, email: null, body: "Hello", origin: "WIDGET", channel: "WIDGET" }); // #4
  const fourth = await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number: 4 } }, include: { messages: true } });
  expect(await runWorkflows(projectId, fourth.id, fourth.messages[0]!.id, "conversation_started")).toEqual({ priority: false });
  for (const number of [1, 2, 3, 4]) {
    expect([number, await priority(number), await notes(number)]).toEqual([number, false, []]);
  }

  // One of the project's users without a plan is in it.
  expect(await notes(await start("user-1"))).toEqual(["No plan yet marked this priority"]);
});

test("the same message run twice writes one Activity row and changes nothing twice, whatever the team changed in its workflows in between", async () => {
  const { projectId, admin, workflow, start, priority, unmark, notes } = await setup();
  const first = await workflow("Everyone first", "conversation_started");
  const number = await start("user-1");
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { projectId_number: { projectId, number } }, include: { messages: { where: { author: "USER" } } } });
  const message = conversation.messages[0]!;
  expect(await notes(number)).toEqual(["Everyone first marked this priority"]);

  // A teammate unmarks it, and the team changes its workflows: another one first, the old one renamed.
  await unmark(number);
  const other = await workflow("Another", "conversation_started");
  await call(moveWorkflow, admin, { id: other.id, position: 0 });
  await call(updateWorkflow, admin, { id: first.id, name: "Renamed" });
  // The message's list has run: again, it changes nothing and writes nothing.
  expect(await runWorkflows(projectId, conversation.id, message.id, "conversation_started")).toEqual({ priority: false });
  expect(await runWorkflows(projectId, conversation.id, message.id, "user_replied")).toEqual({ priority: false });
  // What it says is the conversation as it is now, not what this run changed: marked meanwhile, it says so.
  await prisma.conversation.update({ where: { id: conversation.id }, data: { priority: true } });
  expect(await runWorkflows(projectId, conversation.id, message.id, "conversation_started")).toEqual({ priority: true });
  await unmark(number);
  expect([await priority(number), await notes(number)]).toEqual([false, ["Everyone first marked this priority"]]);

  // Run twice at once for a message that hasn't run: one of them runs it.
  const started = await startConversation(projectId, { userId: null, email: "e2e-twice@example.com", body: "Hello", origin: "API", channel: "API" });
  const runs = await Promise.all([1, 2, 3].map(() => runWorkflows(projectId, started.conversation.id, started.message.id, "conversation_started")));
  // Each says the conversation as it is once its turn commits: marked, by the one that ran it.
  expect(runs).toEqual([{ priority: true }, { priority: true }, { priority: true }]);
  expect(await notes(started.conversation.number)).toEqual(["Another marked this priority"]);
  // Only a user's message runs a list: never a teammate's note.
  const note = await call(replyToConversation, admin, { number: started.conversation.number, body: "Ask billing", note: true });
  await unmark(started.conversation.number);
  expect(await runWorkflows(projectId, started.conversation.id, note.id, "user_replied")).toEqual({ priority: false });
  expect(await priority(started.conversation.number)).toBe(false);
});

test("a list that fails holds nothing up: the message is in, the team is told of it, and it isn't marked as run", async () => {
  const { projectId, workflow, start, reply, priority, notes, told } = await setup();
  await workflow("Replies", "user_replied");
  const number = await start("user-1");
  // The reply's own transaction goes through; the list's, right after it, fails.
  failTransaction(new Error("connection reset"), { skip: 1 });
  expect(await reply(number, "user-1")).toMatchObject({ author: "user", body: "And another thing" });
  expect([await priority(number), await notes(number), await told()]).toEqual([false, [], ["conversation.created", "conversation.message_created"]]);

  // Nothing says it ran, so running it again does what the first run couldn't.
  const message = await prisma.conversationMessage.findFirstOrThrow({ where: { conversation: { projectId, number }, body: "And another thing" } });
  expect(message.workflowsRanAt).toBeNull();
  expect(await runWorkflows(projectId, message.conversationId, message.id, "user_replied")).toEqual({ priority: true });
  expect(await notes(number)).toEqual(["Replies marked this priority"]);
});

test("a workflow this release can't read doesn't run, and the next one still does", async () => {
  const { projectId, workflow, start, notes } = await setup();
  // As a later release would store one, while a deploy overlaps the two: an action, and a condition, from after this one.
  await prisma.workflow.createMany({
    data: [
      { projectId, name: "Later's action", trigger: "conversation_started", position: 0, actions: [{ kind: "mark_priority" }, { kind: "close" }] },
      { projectId, name: "Later's condition", trigger: "conversation_started", position: 1, conditions: [{ kind: "channel", channel: "email" }], actions: [{ kind: "mark_priority" }] },
    ],
  });
  await workflow("Everyone first", "conversation_started");
  expect(await notes(await start("user-1"))).toEqual(["Everyone first marked this priority"]);
});

test("every way a user's message arrives runs the path: email, the widget, “Ask a person” and the API", async () => {
  const { project, projectId, workflow, start, reply, mail, replyAddress, priority, notes } = await setup();
  await workflow("New ones", "conversation_started");
  await workflow("Replies", "user_replied");
  const sam = await upsertProjectUser(projectId, "user-1", { name: "Sam", email: "e2e-sam@example.com" });
  const widget = { token: widgetToken(projectId, sam) };
  /** After its first message it's marked by "New ones"; unmarked by hand, the reply `send` writes marks it again. */
  const check = async (number: number, send: () => Promise<unknown>) => {
    expect([number, await notes(number)]).toEqual([number, ["New ones marked this priority"]]);
    await prisma.conversation.update({ where: { projectId_number: { projectId, number } }, data: { priority: false } });
    await send();
    expect([number, await priority(number), await notes(number)]).toEqual([number, true, ["New ones marked this priority", "Replies marked this priority"]]);
  };

  // Email, and a reply to the conversation's address.
  await mail("e2e-kim@example.com");
  await check(1, async () => mail("e2e-kim@example.com", await replyAddress(1)));
  // The widget, signed in.
  expect(await widgetStartConversation(project.slug, widget, "Hello")).toEqual({ number: 2 });
  await check(2, async () => expect(await widgetSendMessage(project.slug, widget, 2, "And another thing")).toEqual({}));
  // The API.
  expect(await start("user-1")).toBe(3);
  await check(3, () => reply(3, "user-1"));
  // "Ask a person", about a question the AI couldn't answer: its first message is the user's.
  const reader = randomUUID();
  request.cookie = `tuti_reader=${reader}`;
  const question = await prisma.docsQuestion.create({ data: { projectId, askerId: reader, question: "Can I pay with crypto?", source: "PORTAL", status: "NO_ANSWER" } });
  expect(await escalateDocs(project.slug, question.id, "e2e-asker@example.com", "")).not.toHaveProperty("error");
  expect([await priority(4), await notes(4)]).toEqual([true, ["New ones marked this priority"]]);
});

test("a conversation in Spam runs nothing; Not spam on what the filter filed runs “A conversation starts”, once", async () => {
  const { projectId, admin, owner, workflow, mail, replyAddress, start, reply, priority, notes, told } = await setup();
  await workflow("New ones", "conversation_started");
  await workflow("Replies", "user_replied");
  await prisma.spamRule.create({ data: { projectId, field: "sender_domain", matcher: "is", value: "spam.example" } });

  // Filed by the filter: no workflow runs, and nobody is told.
  await mail("e2e-kim@spam.example"); // #1
  expect([await priority(1), await notes(1), await told(), emailed(owner.email)]).toEqual([false, [], [], 0]);

  // Not spam: it takes the rest of the path as a new conversation, marked on the way and told so.
  expect(await call(updateConversation, admin, { number: 1, spam: false })).toMatchObject({ spam: false, priority: true });
  expect([await priority(1), await notes(1), await told(), emailed(owner.email)]).toEqual([true, ["New ones marked this priority"], ["conversation.created priority"], 1]);
  // Marked and unmarked again, it has no reason now: nothing runs a second time.
  await prisma.conversation.update({ where: { projectId_number: { projectId, number: 1 } }, data: { priority: false } });
  await call(updateConversation, admin, { number: 1, spam: true });
  expect(await call(updateConversation, admin, { number: 1, spam: false })).toMatchObject({ spam: false, priority: false });
  expect(await notes(1)).toHaveLength(1);

  // One a teammate marked: what its user writes there runs nothing, then or once it's unmarked.
  const number = await start("user-1");
  await prisma.conversation.update({ where: { projectId_number: { projectId, number } }, data: { priority: false } });
  await call(updateConversation, admin, { number, spam: true });
  await reply(number, "user-1");
  await call(updateConversation, admin, { number, spam: false });
  expect([await priority(number), await notes(number)]).toEqual([false, ["New ones marked this priority"]]);
  // Their next message, out of Spam, does.
  await reply(number, "user-1");
  expect(await notes(number)).toEqual(["New ones marked this priority", "Replies marked this priority"]);
  // The filter's own are held to the same: a reply to one it filed runs nothing while it's there.
  await mail("e2e-lee@spam.example"); // #3
  await prisma.conversation.update({ where: { projectId_number: { projectId, number: 3 } }, data: { emailVerified: true } });
  await mail("e2e-lee@spam.example", await replyAddress(3));
  expect([await prisma.conversationMessage.count({ where: { conversation: { projectId, number: 3 } } }), await notes(3)]).toEqual([2, []]);
});
