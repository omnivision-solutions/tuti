-- The spam filter's first checks (docs/plan.md, Inbox automation, W1): what the team decided about a sender, and why
-- a conversation was filed. A new table and two nullable columns: the previous release reads and writes none of them.
-- AlterTable
ALTER TABLE "conversation" ADD COLUMN "spamReason" TEXT,
ADD COLUMN "spamMarkedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "spam_sender" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "blocked" BOOLEAN NOT NULL,
    "conversationId" TEXT,
    "byAdmin" BOOLEAN NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spam_sender_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spam_sender_conversationId_key" ON "spam_sender"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "spam_sender_projectId_sender_key" ON "spam_sender"("projectId", "sender") WHERE ("conversationId" IS NULL);

-- CreateIndex
CREATE INDEX "spam_sender_projectId_sender_decidedAt_idx" ON "spam_sender"("projectId", "sender", "decidedAt" DESC);

-- AddForeignKey
ALTER TABLE "spam_sender" ADD CONSTRAINT "spam_sender_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spam_sender" ADD CONSTRAINT "spam_sender_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
