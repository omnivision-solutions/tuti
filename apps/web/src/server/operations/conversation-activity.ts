import { type Prisma, prisma } from "@tuti/db";
import { z } from "zod";

import { ACTORS, eventPeople, PEOPLE, tellEvent } from "@/lib/conversation-events";

import { conversationNumber, conversationPerson, findConversation } from "./conversations";
import { defineOperation } from "./define";

export const ACTIVITY_FILTERS = ["all", "workflows", "people"] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];
const PER_PAGE = 20;

const eventOutput = z
  .object({
    id: z.string().describe("The event's id: `before` for the page after it").meta({ examples: ["cm3k9x2ab0005qz8h1a2b3c4d"] }),
    kind: z
      .string()
      .describe("What happened: workflows_ran, spam_filter, status, snooze, assignee, priority, spam or handled_by; more kinds come")
      .meta({ examples: ["workflows_ran"] }),
    actor: z.enum(ACTORS).describe("Who did it: a teammate, an API key, the conversation's person (user), the workflows, the spam filter, the AI or Tuti").meta({ examples: ["workflow"] }),
    who: z
      .string()
      .nullable()
      .describe("The teammate (\"A former teammate\" once their account is gone), the API key, the conversation's person, the trigger that ran, or the built-in step; the start of the sentence")
      .meta({ examples: ["A conversation starts"] }),
    text: z.string().describe("What they did, after `who`").meta({ examples: ["ran"] }),
    detail: z.string().nullable().describe("A short detail: why, or how").meta({ examples: ["2 workflows checked"] }),
    workflows: z
      .array(
        z.object({
          name: z.string().describe("The workflow's name then").meta({ examples: ["Priority for paying plans"] }),
          what: z.string().describe("What it did, or why it didn't match").meta({ examples: ["marked this priority"] }),
        }),
      )
      .describe("For a trigger's run: each workflow it checked, in order; empty otherwise"),
    createdAt: z.string().describe("When it happened (ISO 8601)").meta({ examples: ["2026-11-26T10:02:00.000Z"] }),
  })
  .meta({ id: "ConversationEvent", description: "Something that happened to a conversation, as its Activity says it" });

export const activityOutput = z
  .object({
    events: z.array(eventOutput).describe("Newest first"),
    next: z.string().nullable().describe("`before` for the earlier ones; null when there are none").meta({ examples: [null] }),
  })
  .describe("The conversation's Activity");

export type Activity = z.output<typeof activityOutput>;

/**
 * A conversation's Activity (docs/plan.md, Inbox automation, W16), newest first, a page at a time: what the workflows and
 * the built-in steps did (`workflows`), and what people did (`people`: teammates, API keys, the conversation's person).
 */
export async function conversationActivity(conversationId: string, { filter = "all", before, limit = PER_PAGE }: { filter?: ActivityFilter; before?: string; limit?: number } = {}): Promise<Activity> {
  const where: Prisma.ConversationEventWhereInput = {
    conversationId,
    ...(filter === "people" && { actor: { in: PEOPLE } }),
    ...(filter === "workflows" && { actor: { notIn: PEOPLE } }),
  };
  // `before` is one of this conversation's events, or nothing: a stranger's id finds nothing to start from.
  const cursor = before ? await prisma.conversationEvent.findFirst({ where: { id: before, conversationId }, select: { id: true } }) : null;
  const rows = await prisma.conversationEvent.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor.id }, skip: 1 }),
    select: { id: true, kind: true, actor: true, actorId: true, actorName: true, details: true, createdAt: true },
  });
  const page = rows.slice(0, limit);
  const ids = [...new Set(page.flatMap(eventPeople))];
  // Gone meanwhile (deleted while a page renders): its rows are gone with it.
  const person = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { email: true, name: true, emailVerified: true, user: { select: { name: true, email: true, deletedAt: true, ssoIdentity: { select: { externalId: true, email: true } } } } },
  });
  const { name, email } = person ? conversationPerson(person) : { name: null, email: null };
  const names = new Map(
    (ids.length > 0 ? await prisma.user.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, name: true } }) : []).map((user) => [user.id, user.name]),
  );
  return {
    // A kind this release can't read (a later release's) is left out.
    events: page.flatMap((row) => {
      const told = tellEvent(row, names, name ?? email ?? "The user");
      return told
        ? [{ id: row.id, kind: row.kind, actor: row.actor as (typeof ACTORS)[number], who: told.who, text: told.text, detail: told.detail, workflows: told.lines, createdAt: row.createdAt.toISOString() }]
        : [];
    }),
    next: rows.length > limit ? page.at(-1)!.id : null,
  };
}

export const getConversationActivity = defineOperation({
  name: "conversations.activity",
  title: "List a conversation's activity",
  summary: "What happened to a conversation, newest first: each workflow run with every workflow checked, the spam filter's verdict, and each change a teammate, an API key or a message made",
  method: "GET",
  path: "/conversations/{number}/activity",
  scope: "read",
  access: "team",
  input: z.object({
    number: conversationNumber,
    filter: z
      .enum(ACTIVITY_FILTERS)
      .default("all")
      .describe("all; workflows: what the workflows, the spam filter, the AI and Tuti did; people: what teammates, API keys and the conversation's person did")
      .meta({ examples: ["all"] }),
    before: z.string().max(100).optional().describe("The `next` of the page before: the events earlier than it").meta({ examples: ["cm3k9x2ab0005qz8h1a2b3c4d"] }),
    limit: z.coerce.number().int().min(1).max(100).default(PER_PAGE).describe("How many, up to 100").meta({ examples: [20] }),
  }),
  output: activityOutput,
  run: async ({ projectId }, { number, filter, before, limit }) => {
    const conversation = await findConversation(projectId, number);
    return conversationActivity(conversation.id, { filter, before, limit });
  },
});
