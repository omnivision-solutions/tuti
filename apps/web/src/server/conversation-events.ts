import type { Prisma } from "@tuti/db";

import { EVENTS, type NewEvent } from "@/lib/conversation-events";

import type { Actor } from "./operations/define";

/**
 * Writes a conversation's Activity rows (docs/plan.md, Inbox automation, W16), in the transaction of the change they
 * describe, which holds the conversation: never one without the other. Each kind's details are checked by its schema.
 * After its latest row and a millisecond apart (as addMessage times messages), so they read in the order they were
 * written, whichever server's clock runs ahead.
 */
export async function logEvents(tx: Prisma.TransactionClient, conversationId: string, events: NewEvent[]) {
  if (events.length === 0) {
    return;
  }
  const [{ latest }] = await tx.$queryRaw<[{ latest: Date | null }]>`
    SELECT MAX("createdAt") AS latest FROM "conversation_event" WHERE "conversationId" = ${conversationId}`;
  const at = Math.max(Date.now(), latest ? latest.getTime() + 1 : 0);
  await tx.conversationEvent.createMany({
    data: events.map((event, i) => ({
      conversationId,
      kind: event.kind,
      actor: event.actor,
      actorId: event.actorId ?? null,
      actorName: event.actorName ?? null,
      details: EVENTS[event.kind].parse(event.details) as Prisma.InputJsonValue,
      createdAt: new Date(at + i),
    })),
  });
}

/** Who a change by the team is credited to: the teammate, or the API key (by its name now, kept as it was), never its creator. */
export async function teamActor(tx: Prisma.TransactionClient, actor: Actor): Promise<Pick<NewEvent, "actor" | "actorId" | "actorName">> {
  if (actor.kind === "user") {
    return { actor: "teammate", actorId: actor.userId };
  }
  const key = await tx.apiKey.findUnique({ where: { id: actor.keyId }, select: { name: true } });
  return { actor: "api_key", actorName: key?.name ?? null };
}
