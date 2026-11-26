import type { Prisma } from "@tuti/db";

import { EVENTS, type NewEvent } from "@/lib/conversation-events";

import type { Actor } from "./operations/define";

/**
 * Writes a conversation's Activity rows (docs/plan.md, Inbox automation, W16), in the transaction of the change they
 * describe: never one without the other. Each kind's details are checked by its schema. A millisecond apart, so they
 * read in the order given.
 */
export async function logEvents(tx: Prisma.TransactionClient, conversationId: string, events: NewEvent[]) {
  if (events.length === 0) {
    return;
  }
  const at = Date.now();
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
