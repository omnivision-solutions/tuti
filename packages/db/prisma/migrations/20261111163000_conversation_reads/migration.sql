-- Additive: the previous release keeps using conversations without recording teammate reads.
CREATE TABLE "conversation_read" (
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "conversation_read_pkey" PRIMARY KEY ("conversationId", "userId")
);

CREATE INDEX "conversation_read_userId_idx" ON "conversation_read"("userId");

ALTER TABLE "conversation_read" ADD CONSTRAINT "conversation_read_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_read" ADD CONSTRAINT "conversation_read_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
