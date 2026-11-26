-- A conversation's Activity (docs/plan.md, Inbox automation, W16): what happened to it, one row per event. A new table:
-- the previous release reads none of it.
-- CreateTable
CREATE TABLE "conversation_event" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_event_conversationId_createdAt_id_idx" ON "conversation_event"("conversationId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "conversation_event_actorId_idx" ON "conversation_event"("actorId");

-- AddForeignKey
ALTER TABLE "conversation_event" ADD CONSTRAINT "conversation_event_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_event" ADD CONSTRAINT "conversation_event_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
