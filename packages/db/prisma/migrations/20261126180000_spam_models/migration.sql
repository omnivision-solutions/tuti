-- The spam filter's model checks, watching only (docs/plan.md, Inbox automation, W3): when a conversation's checks are
-- due, the team's guidance for the models, and an email's Reply-To. A defaulted column and nullable ones: the previous
-- release reads and writes none of them, and what it writes leaves them empty, so nothing it starts is picked up.
-- AlterTable
ALTER TABLE "conversation" ADD COLUMN "pathDueAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "project" ADD COLUMN "spamGuidance" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "inbound_email" ADD COLUMN "replyTo" TEXT;

-- CreateIndex
CREATE INDEX "conversation_pathDueAt_idx" ON "conversation"("pathDueAt");
