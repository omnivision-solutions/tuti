-- Support inbox (docs/plan.md, Support inbox, item 7): emailing the team's unseen replies: their status, tries, the sending run's claim, and the Message-ID they went with.
-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('SENT', 'FAILED');

-- AlterTable
ALTER TABLE "conversation_message" ADD COLUMN     "emailAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "emailClaimedAt" TIMESTAMP(3),
ADD COLUMN     "emailError" TEXT,
ADD COLUMN     "emailStatus" "EmailStatus",
ADD COLUMN     "sentMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "conversation_message_sentMessageId_key" ON "conversation_message"("sentMessageId");

