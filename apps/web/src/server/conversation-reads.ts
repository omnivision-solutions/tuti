import { prisma } from "@tuti/db";

/** Customer messages alone make a conversation unread. One extra query for the whole list, including its read times. */
export async function conversationReads(ids: string[], userId: string) {
  const rows = ids.length
    ? await prisma.$queryRaw<{ conversationId: string; latestCustomerAt: Date | null; unread: boolean }[]>`
        SELECT c.id AS "conversationId", m."createdAt" AS "latestCustomerAt",
          (r."readAt" IS NULL OR COALESCE(r."readAt" < m."createdAt", false)) AS unread
        FROM unnest(${ids}::text[]) AS c(id)
        LEFT JOIN LATERAL (
          SELECT "createdAt" FROM conversation_message
          WHERE "conversationId" = c.id AND author = 'USER' AND NOT note
          ORDER BY "createdAt" DESC LIMIT 1
        ) m ON true
        LEFT JOIN conversation_read r ON r."conversationId" = c.id AND r."userId" = ${userId}`
    : [];
  return new Map(rows.map(({ conversationId, ...state }) => [conversationId, state]));
}
